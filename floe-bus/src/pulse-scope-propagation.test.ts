import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import { defaultConfig, type LocalConfig } from "./config.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;
const BRIDGE = "bridge:pulse-scope";

async function makeServer(): Promise<{ handle: ServerHandle; tmp: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-pulse-scope-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg: LocalConfig = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const handle = await createBusServer(cfgPath, cfg, { unsafe_in_process_test_auth_bypass: true });
  await handle.app.ready();
  return { handle, tmp };
}

async function makeServerWithLegacyPulseScopeSchema(): Promise<{ handle: ServerHandle; tmp: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-pulse-scope-legacy-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg: LocalConfig = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const dataDir = join(tmp, "bus");
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "floe-bus.sqlite"));
  db.exec(`
    CREATE TABLE pulses (
      pulse_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      persistence TEXT NOT NULL DEFAULT 'local',
      scope_id TEXT NOT NULL DEFAULT 'default',
      trigger_json TEXT NOT NULL,
      content_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      next_fire_at TEXT,
      last_fired_at TEXT,
      fire_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.close();
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
    payload: { locator, name: "pulse-scope" }
  });
  expect(res.statusCode).toBe(201);
  return res.json().workspace.workspace_id;
}

async function createScope(handle: ServerHandle, workspaceId: string, scopeId: string): Promise<void> {
  const res = await handle.app.inject({
    method: "POST",
    url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`,
    payload: { scope_id: scopeId, title: scopeId }
  });
  expect(res.statusCode).toBe(201);
}

function registerEndpoint(handle: ServerHandle, workspaceId: string, name: string): string {
  const endpointId = `actor:${workspaceId}:${name}`;
  handle.store.registerEndpoint({
    endpoint_id: endpointId,
    workspace_id: workspaceId,
    name,
    bridge_id: BRIDGE,
    status: "idle"
  }, () => {});
  return endpointId;
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 2_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

describe("Pulse Persistence and Scope propagation", () => {
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

  it("creates queryable pulses with persistence and organising scope_id only", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    await createScope(handle, workspaceId, "ops");
    const subscriber = { kind: "endpoint", endpoint_ref: "floe" };

    const created = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: "ops-reminder",
        workspace_id: workspaceId,
        persistence: "workspace",
        scope_id: "ops",
        trigger: { type: "once", at: new Date(Date.now() + 60_000).toISOString() },
        event: { type: "pulse.fired", content: { text: "Check ops." } },
        subscribers: [subscriber]
      }
    });

    expect(created.statusCode).toBe(201);
    const pulse = created.json().pulse;
    expect(pulse).toMatchObject({
      pulse_id: "ops-reminder",
      workspace_id: workspaceId,
      persistence: "workspace",
      scope_id: "ops",
      subscribers: [subscriber]
    });
    expect(pulse).not.toHaveProperty("scope");

    const ops = await handle.app.inject({
      method: "GET",
      url: `/v1/pulses?workspace_id=${encodeURIComponent(workspaceId)}&scope_id=ops`
    });
    expect(ops.statusCode).toBe(200);
    expect((ops.json().pulses as any[]).map((item) => item.pulse_id)).toEqual(["ops-reminder"]);

    const defaults = await handle.app.inject({
      method: "GET",
      url: `/v1/pulses?workspace_id=${encodeURIComponent(workspaceId)}&scope_id=default`
    });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json().pulses).toEqual([]);
  });

  it("relaxes legacy Pulse scope columns so explicit unscoped Context anchors can persist", async () => {
    await handle.app.close();
    rmSync(tmp, { recursive: true, force: true });
    const made = await makeServerWithLegacyPulseScopeSchema();
    handle = made.handle;
    tmp = made.tmp;
    const workspaceId = await registerWorkspace(handle, tmp);
    const operator = registerEndpoint(handle, workspaceId, "operator");
    const contextId = handle.store.contextStore.createContext({
      workspace_id: workspaceId,
      created_by_endpoint_id: operator,
      participants: [operator]
    });

    const created = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: "unscoped-context-anchor",
        workspace_id: workspaceId,
        persistence: "local",
        trigger: { type: "once", at: new Date(Date.now() + 60_000).toISOString() },
        event: { type: "pulse.fired", content: { text: "Append only." } },
        subscribers: [{ kind: "context", context_id: contextId }]
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().pulse.scope_id).toBeNull();
  });

  it("rejects stale public scope payloads without creating a pulse", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);

    const rejected = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: "old-scope-pulse",
        workspace_id: workspaceId,
        scope: "workspace",
        trigger: { type: "once", at: new Date(Date.now() + 60_000).toISOString() },
        event: { type: "pulse.fired", content: { text: "old scope" } },
        subscribers: [{ kind: "endpoint", endpoint_ref: "floe" }]
      }
    });

    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({
      ok: false,
      error: { code: "invalid_pulse_command" }
    });

    const pulses = await handle.app.inject({
      method: "GET",
      url: `/v1/pulses?workspace_id=${encodeURIComponent(workspaceId)}`
    });
    expect(pulses.statusCode).toBe(200);
    expect(pulses.json().pulses).toEqual([]);
  });

  it("derives Pulse scope_id from explicit Scope or scoped active Context and rejects missing Scope", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    await createScope(handle, workspaceId, "research");
    await createScope(handle, workspaceId, "ops");
    const activeContextId = handle.store.contextStore.createContext({
      workspace_id: workspaceId,
      scope_id: "research",
      created_by_endpoint_id: `actor:${workspaceId}:operator`,
      participants: [`actor:${workspaceId}:operator`]
    });

    const inherited = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: "inherits-context",
        workspace_id: workspaceId,
        persistence: "local",
        current_context_id: activeContextId,
        trigger: { type: "once", at: new Date(Date.now() + 60_000).toISOString() },
        subscribers: [{ kind: "endpoint", endpoint_ref: "floe" }]
      }
    });
    expect(inherited.statusCode).toBe(201);
    expect(inherited.json().pulse.scope_id).toBe("research");

    const explicit = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: "explicit-wins",
        workspace_id: workspaceId,
        persistence: "local",
        current_context_id: activeContextId,
        scope_id: "ops",
        trigger: { type: "once", at: new Date(Date.now() + 60_000).toISOString() },
        subscribers: [{ kind: "endpoint", endpoint_ref: "floe" }]
      }
    });
    expect(explicit.statusCode).toBe(201);
    expect(explicit.json().pulse.scope_id).toBe("ops");

    const missingScope = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: "missing-scope",
        workspace_id: workspaceId,
        persistence: "local",
        trigger: { type: "once", at: new Date(Date.now() + 60_000).toISOString() },
        subscribers: [{ kind: "endpoint", endpoint_ref: "floe" }]
      }
    });
    expect(missingScope.statusCode).toBe(400);
    expect(missingScope.json()).toMatchObject({
      ok: false,
      error: "scope_required",
      workspace_id: workspaceId,
      reason: "pulse must be configured with a Scope or scoped current Context"
    });

    const unscopedContextId = handle.store.contextStore.createContext({
      workspace_id: workspaceId,
      created_by_endpoint_id: `actor:${workspaceId}:operator`,
      participants: [`actor:${workspaceId}:operator`]
    });
    const unscopedContext = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: "unscoped-context",
        workspace_id: workspaceId,
        persistence: "local",
        current_context_id: unscopedContextId,
        trigger: { type: "once", at: new Date(Date.now() + 60_000).toISOString() },
        subscribers: [{ kind: "endpoint", endpoint_ref: "floe" }]
      }
    });
    expect(unscopedContext.statusCode).toBe(400);
    expect(unscopedContext.json().error).toBe("scope_required");

    const unknown = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: "unknown-scope",
        workspace_id: workspaceId,
        persistence: "local",
        scope_id: "missing",
        trigger: { type: "once", at: new Date(Date.now() + 60_000).toISOString() },
        subscribers: [{ kind: "endpoint", endpoint_ref: "floe" }]
      }
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({
      ok: false,
      error: "scope_not_found",
      workspace_id: workspaceId,
      scope_id: "missing"
    });

    const pulses = await handle.app.inject({
      method: "GET",
      url: `/v1/pulses?workspace_id=${encodeURIComponent(workspaceId)}`
    });
    expect((pulses.json().pulses as any[]).some((pulse) => pulse.pulse_id === "unknown-scope")).toBe(false);
    expect((pulses.json().pulses as any[]).some((pulse) => pulse.pulse_id === "missing-scope")).toBe(false);
    expect((pulses.json().pulses as any[]).some((pulse) => pulse.pulse_id === "unscoped-context")).toBe(false);
  });

  it("rejects an unknown active Context instead of silently defaulting Pulse scope_id", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);

    const rejected = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: "missing-active-context",
        workspace_id: workspaceId,
        persistence: "local",
        current_context_id: "ctx_missing",
        trigger: { type: "once", at: new Date(Date.now() + 60_000).toISOString() },
        subscribers: [{ kind: "endpoint", endpoint_ref: "floe" }]
      }
    });

    expect(rejected.statusCode).toBe(404);
    expect(rejected.json()).toMatchObject({
      ok: false,
      error: "context_not_found",
      context_id: "ctx_missing"
    });
  });

  it("fires pulse events in subscriber Context Scope or Pulse Scope when no Context exists", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    await createScope(handle, workspaceId, "research");
    await createScope(handle, workspaceId, "ops");
    const floeEndpointId = registerEndpoint(handle, workspaceId, "floe");
    const operator = registerEndpoint(handle, workspaceId, "operator");
    const renderContextId = handle.store.contextStore.createContext({
      workspace_id: workspaceId,
      scope_id: "research",
      created_by_endpoint_id: operator,
      participants: [operator]
    });
    const endpointContextId = handle.store.contextStore.createContext({
      workspace_id: workspaceId,
      scope_id: "ops",
      created_by_endpoint_id: operator,
      participants: [operator]
    });
    const triggerAt = () => new Date(Date.now() + 30).toISOString();

    const contextSubscriber = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: "context-subscriber-scope",
        workspace_id: workspaceId,
        persistence: "local",
        scope_id: "ops",
        trigger: { type: "once", at: triggerAt() },
        event: { type: "pulse.fired", content: { text: "Render in research." } },
        subscribers: [{ kind: "context", context_id: renderContextId }]
      }
    });
    expect(contextSubscriber.statusCode).toBe(201);

    const endpointWithContext = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: "endpoint-context-scope",
        workspace_id: workspaceId,
        persistence: "local",
        scope_id: "research",
        trigger: { type: "once", at: triggerAt() },
        event: { type: "pulse.fired", content: { instructions: "Use existing context." } },
        subscribers: [{ kind: "endpoint", endpoint_ref: "floe", context_id: endpointContextId }]
      }
    });
    expect(endpointWithContext.statusCode).toBe(201);

    const endpointWithoutContext = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: "endpoint-pulse-scope",
        workspace_id: workspaceId,
        persistence: "local",
        scope_id: "research",
        trigger: { type: "once", at: triggerAt() },
        event: { type: "pulse.fired", content: { instructions: "Create scoped trigger context." } },
        subscribers: [{ kind: "endpoint", endpoint_ref: "floe" }]
      }
    });
    expect(endpointWithoutContext.statusCode).toBe(201);

    const researchEvents = await waitFor(async () => {
      const res = await handle.app.inject({
        method: "GET",
        url: `/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&scope_id=research`
      });
      const events = res.json().events as any[];
      const matches = events.filter((event) => event.type === "pulse.fired" && [
        "context-subscriber-scope",
        "endpoint-pulse-scope"
      ].includes(event.metadata?.pulse_id));
      return matches.length === 2 ? matches : null;
    });
    expect(researchEvents.map((event) => event.metadata.pulse_id).sort()).toEqual([
      "context-subscriber-scope",
      "endpoint-pulse-scope"
    ]);
    expect(researchEvents.every((event) => event.scope_id === "research")).toBe(true);
    expect(researchEvents.find((event) => event.metadata.pulse_id === "context-subscriber-scope")?.context_id).toBe(renderContextId);
    expect(researchEvents.find((event) => event.metadata.pulse_id === "endpoint-pulse-scope")?.destination_json).toEqual({
      kind: "endpoint",
      endpoint_id: floeEndpointId
    });

    const opsEvents = await waitFor(async () => {
      const res = await handle.app.inject({
        method: "GET",
        url: `/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&scope_id=ops`
      });
      const events = res.json().events as any[];
      const endpointEvent = events.find((event) => event.metadata?.pulse_id === "endpoint-context-scope");
      return endpointEvent ? [endpointEvent] : null;
    });
    expect(opsEvents[0]).toMatchObject({
      scope_id: "ops",
      context_id: endpointContextId,
      source_endpoint_id: null
    });

    const claimed = await handle.app.inject({
      method: "GET",
      url: `/v1/delivery/claim?bridge_id=${encodeURIComponent(BRIDGE)}&limit=10`
    });
    expect(claimed.statusCode).toBe(200);
    const deliveryEvents = (claimed.json().deliveries as any[]).flatMap((delivery) => delivery.events);
    expect(deliveryEvents.find((event) => event.metadata?.pulse_id === "endpoint-context-scope")?.scope_id).toBe("ops");
  });
});
