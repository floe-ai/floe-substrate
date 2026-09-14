import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import { defaultConfig, type LocalConfig } from "./config.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

async function makeServer(): Promise<{ handle: ServerHandle; tmp: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-scope-prop-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg: LocalConfig = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const handle = await createBusServer(cfgPath, cfg, { unsafe_in_process_test_auth_bypass: true });
  await handle.app.ready();
  return { handle, tmp };
}

async function registerWorkspace(handle: ServerHandle, tmp: string): Promise<string> {
  const locator = join(tmp, "ws");
  mkdirSync(locator, { recursive: true });
  const res = await handle.app.inject({
    method: "POST",
    url: "/v1/workspaces/register",
    headers: { authorization: `Bearer ${handle.localControlToken}` },
    payload: { locator, name: "scope-propagation" }
  });
  expect(res.statusCode).toBe(201);
  return res.json().workspace.workspace_id;
}

function registerEndpoint(handle: ServerHandle, workspaceId: string, endpointId: string): void {
  handle.store.registerEndpoint({
    endpoint_id: endpointId,
    workspace_id: workspaceId,
    name: endpointId,
    bridge_id: null,
    status: "idle"
  }, () => {});
}

describe("Context/Event Scope propagation", () => {
  let handle: ServerHandle;
  let tmp: string;

  beforeEach(async () => {
    const made = await makeServer();
    handle = made.handle;
    tmp = made.tmp;
  });

  afterEach(async () => {
    try { await handle.app.close(); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates a new Context in the explicit Scope and indexes its Events by that Scope", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const source = `actor:${workspaceId}:operator`;
    const target = `actor:${workspaceId}:floe`;
    registerEndpoint(handle, workspaceId, source);
    registerEndpoint(handle, workspaceId, target);
    const createdScope = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`,
      payload: { scope_id: "research", title: "Research" }
    });
    expect(createdScope.statusCode).toBe(201);

    const emitted = await handle.app.inject({
      method: "POST",
      url: "/v1/events/emit",
      payload: {
        type: "message",
        workspace_id: workspaceId,
        source_endpoint_id: source,
        destination: { kind: "endpoint", endpoint_id: target },
        scope_id: "research",
        content: { text: "scoped hello" },
        response: { expected: false }
      }
    });
    expect(emitted.statusCode).toBe(202);
    const event = emitted.json().event;
    expect(event.scope_id).toBe("research");

    const context = await handle.app.inject({
      method: "GET",
      url: `/v1/contexts/${encodeURIComponent(event.context_id)}`
    });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({
      context_id: event.context_id,
      scope_id: "research"
    });

    const scopedEvents = await handle.app.inject({
      method: "GET",
      url: `/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&scope_id=research`
    });
    expect(scopedEvents.statusCode).toBe(200);
    expect((scopedEvents.json().events as any[]).map((item) => item.event_id)).toEqual([event.event_id]);

    const defaultEvents = await handle.app.inject({
      method: "GET",
      url: `/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&scope_id=default`
    });
    expect(defaultEvents.statusCode).toBe(200);
    expect(defaultEvents.json().events).toEqual([]);
  });

  it("creates an unscoped Workspace-level actor Context when no Scope is supplied", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const source = `actor:${workspaceId}:operator`;
    const target = `actor:${workspaceId}:floe`;
    registerEndpoint(handle, workspaceId, source);
    registerEndpoint(handle, workspaceId, target);

    const emitted = await handle.app.inject({
      method: "POST",
      url: "/v1/events/emit",
      payload: {
        type: "message",
        workspace_id: workspaceId,
        source_endpoint_id: source,
        destination: { kind: "endpoint", endpoint_id: target },
        content: { text: "workspace-level hello" },
        response: { expected: false }
      }
    });

    expect(emitted.statusCode).toBe(202);
    const event = emitted.json().event;
    expect(event.scope_id).toBeNull();

    const context = await handle.app.inject({
      method: "GET",
      url: `/v1/contexts/${encodeURIComponent(event.context_id)}`
    });
    expect(context.statusCode).toBe(200);
    expect(context.json().scope_id).toBeNull();

    const defaultEvents = await handle.app.inject({
      method: "GET",
      url: `/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&scope_id=default`
    });
    expect(defaultEvents.statusCode).toBe(200);
    expect(defaultEvents.json().events).toEqual([]);
  });

  it("keeps Context Scope authoritative for later Events in the same Context", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const source = `actor:${workspaceId}:operator`;
    const target = `actor:${workspaceId}:floe`;
    registerEndpoint(handle, workspaceId, source);
    registerEndpoint(handle, workspaceId, target);
    for (const scope_id of ["research", "ops"]) {
      const created = await handle.app.inject({
        method: "POST",
        url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`,
        payload: { scope_id, title: scope_id }
      });
      expect(created.statusCode).toBe(201);
    }

    const first = await handle.app.inject({
      method: "POST",
      url: "/v1/events/emit",
      payload: {
        type: "message",
        workspace_id: workspaceId,
        source_endpoint_id: source,
        destination: { kind: "endpoint", endpoint_id: target },
        scope_id: "research",
        content: { text: "first" },
        response: { expected: false }
      }
    });
    expect(first.statusCode).toBe(202);
    const contextId = first.json().event.context_id;

    const second = await handle.app.inject({
      method: "POST",
      url: "/v1/events/emit",
      payload: {
        type: "message",
        workspace_id: workspaceId,
        source_endpoint_id: source,
        destination: { kind: "endpoint", endpoint_id: target },
        context_id: contextId,
        scope_id: "ops",
        content: { text: "second" },
        response: { expected: false }
      }
    });

    expect(second.statusCode).toBe(202);
    expect(second.json().event.scope_id).toBe("research");

    const researchEvents = await handle.app.inject({
      method: "GET",
      url: `/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&scope_id=research`
    });
    expect((researchEvents.json().events as any[]).map((event) => event.content.text)).toEqual(["first", "second"]);

    const opsEvents = await handle.app.inject({
      method: "GET",
      url: `/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&scope_id=ops`
    });
    expect(opsEvents.json().events).toEqual([]);
  });

  it("keeps an unscoped Context authoritative when a later emit supplies Scope", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const source = `actor:${workspaceId}:operator`;
    const target = `actor:${workspaceId}:floe`;
    registerEndpoint(handle, workspaceId, source);
    registerEndpoint(handle, workspaceId, target);
    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`,
      payload: { scope_id: "ops", title: "Ops" }
    });
    expect(created.statusCode).toBe(201);

    const first = await handle.app.inject({
      method: "POST",
      url: "/v1/events/emit",
      payload: {
        type: "message",
        workspace_id: workspaceId,
        source_endpoint_id: source,
        destination: { kind: "endpoint", endpoint_id: target },
        content: { text: "first" },
        response: { expected: false }
      }
    });
    expect(first.statusCode).toBe(202);
    const contextId = first.json().event.context_id;

    const second = await handle.app.inject({
      method: "POST",
      url: "/v1/events/emit",
      payload: {
        type: "message",
        workspace_id: workspaceId,
        source_endpoint_id: source,
        destination: { kind: "endpoint", endpoint_id: target },
        context_id: contextId,
        scope_id: "ops",
        content: { text: "second" },
        response: { expected: false }
      }
    });

    expect(second.statusCode).toBe(202);
    expect(second.json().event.scope_id).toBeNull();

    const opsEvents = await handle.app.inject({
      method: "GET",
      url: `/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&scope_id=ops`
    });
    expect(opsEvents.json().events).toEqual([]);
  });

  it("filters Context lists by Scope", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const source = `actor:${workspaceId}:operator`;
    const target = `actor:${workspaceId}:floe`;
    registerEndpoint(handle, workspaceId, source);
    registerEndpoint(handle, workspaceId, target);
    for (const scope_id of ["research", "ops"]) {
      const created = await handle.app.inject({
        method: "POST",
        url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`,
        payload: { scope_id, title: scope_id }
      });
      expect(created.statusCode).toBe(201);
      const emitted = await handle.app.inject({
        method: "POST",
        url: "/v1/events/emit",
        payload: {
          type: "message",
          workspace_id: workspaceId,
          source_endpoint_id: source,
          destination: { kind: "endpoint", endpoint_id: target },
          scope_id,
          content: { text: `${scope_id} hello` },
          response: { expected: false }
        }
      });
      expect(emitted.statusCode).toBe(202);
    }

    const researchContexts = await handle.app.inject({
      method: "GET",
      url: `/v1/contexts?participant=${encodeURIComponent(source)}&workspace_id=${encodeURIComponent(workspaceId)}&scope_id=research`
    });
    expect(researchContexts.statusCode).toBe(200);
    expect((researchContexts.json().contexts as any[]).map((context) => context.scope_id)).toEqual(["research"]);

    const opsContexts = await handle.app.inject({
      method: "GET",
      url: `/v1/contexts?participant=${encodeURIComponent(source)}&workspace_id=${encodeURIComponent(workspaceId)}&scope_id=ops`
    });
    expect(opsContexts.statusCode).toBe(200);
    expect((opsContexts.json().contexts as any[]).map((context) => context.scope_id)).toEqual(["ops"]);
  });

  it("rejects an unknown explicit Scope without creating Contexts or Events", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const source = `actor:${workspaceId}:operator`;
    const target = `actor:${workspaceId}:floe`;
    registerEndpoint(handle, workspaceId, source);
    registerEndpoint(handle, workspaceId, target);

    const rejected = await handle.app.inject({
      method: "POST",
      url: "/v1/events/emit",
      payload: {
        type: "message",
        workspace_id: workspaceId,
        source_endpoint_id: source,
        destination: { kind: "endpoint", endpoint_id: target },
        scope_id: "missing",
        content: { text: "should not persist" },
        response: { expected: false }
      }
    });

    expect(rejected.statusCode).toBe(404);
    expect(rejected.json()).toMatchObject({
      ok: false,
      error: "scope_not_found",
      workspace_id: workspaceId,
      scope_id: "missing"
    });

    const contexts = await handle.app.inject({
      method: "GET",
      url: `/v1/contexts?participant=${encodeURIComponent(source)}&workspace_id=${encodeURIComponent(workspaceId)}`
    });
    expect(contexts.statusCode).toBe(200);
    expect(contexts.json().contexts).toEqual([]);

    const events = await handle.app.inject({
      method: "GET",
      url: `/v1/events?workspace_id=${encodeURIComponent(workspaceId)}`
    });
    expect(events.statusCode).toBe(200);
    expect(events.json().events).toEqual([]);
  });

  it("honors scope_id-only Event queries", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const source = `actor:${workspaceId}:operator`;
    const target = `actor:${workspaceId}:floe`;
    registerEndpoint(handle, workspaceId, source);
    registerEndpoint(handle, workspaceId, target);
    for (const scope_id of ["research", "ops"]) {
      const created = await handle.app.inject({
        method: "POST",
        url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`,
        payload: { scope_id, title: scope_id }
      });
      expect(created.statusCode).toBe(201);
      const emitted = await handle.app.inject({
        method: "POST",
        url: "/v1/events/emit",
        payload: {
          type: "message",
          workspace_id: workspaceId,
          source_endpoint_id: source,
          destination: { kind: "endpoint", endpoint_id: target },
          scope_id,
          content: { text: `${scope_id} event` },
          response: { expected: false }
        }
      });
      expect(emitted.statusCode).toBe(202);
    }

    const filtered = await handle.app.inject({
      method: "GET",
      url: "/v1/events?scope_id=research"
    });

    expect(filtered.statusCode).toBe(200);
    expect((filtered.json().events as any[]).map((event) => event.content.text)).toEqual(["research event"]);
  });

  it("rejects an unknown explicit Scope even when the existing Context Scope would otherwise win", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const source = `actor:${workspaceId}:operator`;
    const target = `actor:${workspaceId}:floe`;
    registerEndpoint(handle, workspaceId, source);
    registerEndpoint(handle, workspaceId, target);
    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`,
      payload: { scope_id: "research", title: "Research" }
    });
    expect(created.statusCode).toBe(201);
    const first = await handle.app.inject({
      method: "POST",
      url: "/v1/events/emit",
      payload: {
        type: "message",
        workspace_id: workspaceId,
        source_endpoint_id: source,
        destination: { kind: "endpoint", endpoint_id: target },
        scope_id: "research",
        content: { text: "first" },
        response: { expected: false }
      }
    });
    expect(first.statusCode).toBe(202);
    const contextId = first.json().event.context_id;

    const rejected = await handle.app.inject({
      method: "POST",
      url: "/v1/events/emit",
      payload: {
        type: "message",
        workspace_id: workspaceId,
        source_endpoint_id: source,
        destination: { kind: "endpoint", endpoint_id: target },
        context_id: contextId,
        scope_id: "missing",
        content: { text: "should not persist" },
        response: { expected: false }
      }
    });

    expect(rejected.statusCode).toBe(404);
    expect(rejected.json()).toMatchObject({
      ok: false,
      error: "scope_not_found",
      workspace_id: workspaceId,
      scope_id: "missing"
    });

    const events = await handle.app.inject({
      method: "GET",
      url: `/v1/contexts/${encodeURIComponent(contextId)}/events`
    });
    expect((events.json().events as any[]).map((event) => event.content.text)).toEqual(["first"]);
  });
});
