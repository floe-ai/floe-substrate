import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import { defaultConfig, type LocalConfig } from "./config.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;
const substrateTables = [
  "scopes",
  "contexts",
  "context_participants",
  "events",
  "event_queue",
  "pulses",
  "pulse_subscribers",
  "runtime_telemetry",
  "delivery_bundles"
] as const;

async function makeServer(): Promise<{ handle: ServerHandle; tmp: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-scope-projection-"));
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
    payload: { locator, name: "scope-projection" }
  });
  expect(res.statusCode).toBe(201);
  return res.json().workspace.workspace_id;
}

function registerEndpoint(handle: ServerHandle, workspaceId: string, endpointId: string): void {
  handle.store.registerEndpoint({
    endpoint_id: endpointId,
    workspace_id: workspaceId,
    name: endpointId,
    bridge_id: "bridge:test",
    status: "idle"
  }, () => {});
}

async function createScope(handle: ServerHandle, workspaceId: string, scopeId: string): Promise<void> {
  const created = await handle.app.inject({
    method: "POST",
    url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`,
    payload: { scope_id: scopeId, title: scopeId }
  });
  expect(created.statusCode).toBe(201);
}

async function emitMessage(handle: ServerHandle, input: {
  workspaceId: string;
  source: string;
  target: string;
  scopeId?: string | null;
  text: string;
  contextId?: string;
}): Promise<any> {
  const emitted = await handle.app.inject({
    method: "POST",
    url: "/v1/events/emit",
    payload: {
      type: "message",
      workspace_id: input.workspaceId,
      source_endpoint_id: input.source,
      destination: { kind: "endpoint", endpoint_id: input.target },
      ...(input.contextId ? { context_id: input.contextId } : {}),
      ...(input.scopeId !== undefined ? { scope_id: input.scopeId } : {}),
      content: { text: input.text },
      response: { expected: false }
    }
  });
  expect(emitted.statusCode).toBe(202);
  return emitted.json().event;
}

async function createPulse(handle: ServerHandle, input: {
  workspaceId: string;
  pulseId: string;
  scopeId: string;
  subscribers: Array<Record<string, unknown>>;
}): Promise<any> {
  const created = await handle.app.inject({
    method: "POST",
    url: "/v1/pulses",
    payload: {
      pulse_id: input.pulseId,
      workspace_id: input.workspaceId,
      persistence: "workspace",
      scope_id: input.scopeId,
      trigger: { type: "once", at: new Date(Date.now() + 60_000).toISOString() },
      event: { type: "pulse.fired", content: { text: input.pulseId } },
      subscribers: input.subscribers,
      created_by: "test"
    }
  });
  expect(created.statusCode).toBe(201);
  return created.json().pulse;
}

function tableCounts(handle: ServerHandle): Record<string, number> {
  return Object.fromEntries(substrateTables.map((table) => {
    const row = handle.store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return [table, row.count];
  }));
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for condition; last=${JSON.stringify(last)}`);
}

describe("Scope Projection API", () => {
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

  it("projects a scoped Context as one scope-projection ref even with multiple Events", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const operator = `actor:${workspaceId}:operator`;
    const floe = `actor:${workspaceId}:floe`;
    registerEndpoint(handle, workspaceId, operator);
    registerEndpoint(handle, workspaceId, floe);
    await createScope(handle, workspaceId, "research");
    await createScope(handle, workspaceId, "ops");

    const researchEvent = await emitMessage(handle, { workspaceId, source: operator, target: floe, scopeId: "research", text: "research hello" });
    const followUpEvent = await emitMessage(handle, {
      workspaceId,
      source: floe,
      target: operator,
      scopeId: "research",
      contextId: researchEvent.context_id,
      text: "research follow-up"
    });
    const opsEvent = await emitMessage(handle, { workspaceId, source: operator, target: floe, scopeId: "ops", text: "ops hello" });

    const res = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/research/projection`
    });

    expect(res.statusCode).toBe(200);
    const projection = res.json().projection;
    expect(projection).toMatchObject({
      workspace_id: workspaceId,
      scope_id: "research"
    });
    expect(projection.refs.contexts).toEqual([
      expect.objectContaining({
        context_id: researchEvent.context_id,
        scope_id: "research",
        created_by_endpoint_id: operator,
        first_message_preview: "research hello"
      })
    ]);
    expect(projection.refs.events).toEqual([
      expect.objectContaining({
        event_id: researchEvent.event_id,
        type: "message",
        workspace_id: workspaceId,
        scope_id: "research",
        context_id: researchEvent.context_id,
        source_endpoint_id: operator
      }),
      expect.objectContaining({
        event_id: followUpEvent.event_id,
        scope_id: "research",
        context_id: researchEvent.context_id,
        source_endpoint_id: floe
      })
    ]);
    expect(projection.refs.events.map((event: { event_id: string }) => event.event_id)).not.toContain(opsEvent.event_id);
    expect(projection.refs.activity).toEqual([]);
    expect(projection.relationships.context_participants).toEqual(expect.arrayContaining([
      { context_id: researchEvent.context_id, endpoint_id: operator },
      { context_id: researchEvent.context_id, endpoint_id: floe }
    ]));
    expect(projection.relationships.context_participants).toHaveLength(2);
    expect(projection.relationships.event_context_ownership).toEqual([]);
  });

  it("projects only Pulses from the requested Scope with their stored subscriber relationships", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const operator = `actor:${workspaceId}:operator`;
    const floe = `actor:${workspaceId}:floe`;
    registerEndpoint(handle, workspaceId, operator);
    registerEndpoint(handle, workspaceId, floe);
    await createScope(handle, workspaceId, "research");
    await createScope(handle, workspaceId, "ops");
    const researchEvent = await emitMessage(handle, { workspaceId, source: operator, target: floe, scopeId: "research", text: "research hello" });

    const researchPulse = await createPulse(handle, {
      workspaceId,
      pulseId: "research-reminder",
      scopeId: "research",
      subscribers: [
        { kind: "context", context_id: researchEvent.context_id },
        { kind: "endpoint", endpoint_ref: floe, context_id: researchEvent.context_id }
      ]
    });
    await createPulse(handle, {
      workspaceId,
      pulseId: "ops-reminder",
      scopeId: "ops",
      subscribers: [{ kind: "endpoint", endpoint_ref: floe }]
    });

    const res = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/research/projection`
    });

    expect(res.statusCode).toBe(200);
    const projection = res.json().projection;
    expect(projection.refs.pulses).toEqual([
      expect.objectContaining({
        pulse_id: "research-reminder",
        workspace_id: workspaceId,
        scope_id: "research",
        persistence: "workspace",
        status: researchPulse.status,
        trigger: researchPulse.trigger,
        next_fire_at: researchPulse.next_fire_at
      })
    ]);
    expect(projection.relationships.pulse_subscribers).toEqual([
      { pulse_id: "research-reminder", subscriber: { kind: "context", context_id: researchEvent.context_id } },
      { pulse_id: "research-reminder", subscriber: { kind: "endpoint", endpoint_ref: floe, context_id: researchEvent.context_id } }
    ]);
  });

  it("adds and removes a Pulse to Context subscriber relationship without changing Scope membership", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const operator = `actor:${workspaceId}:operator`;
    const floe = `actor:${workspaceId}:floe`;
    registerEndpoint(handle, workspaceId, operator);
    registerEndpoint(handle, workspaceId, floe);
    await createScope(handle, workspaceId, "research");
    const researchEvent = await emitMessage(handle, { workspaceId, source: operator, target: floe, scopeId: "research", text: "research hello" });
    await createPulse(handle, {
      workspaceId,
      pulseId: "research-reminder",
      scopeId: "research",
      subscribers: []
    });
    const beforeCounts = tableCounts(handle);

    const subscribed = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses/research-reminder/subscribe",
      payload: { kind: "context", context_id: researchEvent.context_id }
    });
    expect(subscribed.statusCode).toBe(200);

    const withEdge = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/research/projection`
    });
    expect(withEdge.statusCode).toBe(200);
    expect(withEdge.json().projection.relationships.pulse_subscribers).toEqual([
      { pulse_id: "research-reminder", subscriber: { kind: "context", context_id: researchEvent.context_id } }
    ]);
    expect(tableCounts(handle)).toMatchObject({
      ...beforeCounts,
      pulse_subscribers: beforeCounts.pulse_subscribers + 1
    });

    const unsubscribed = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses/research-reminder/unsubscribe",
      payload: { kind: "context", context_id: researchEvent.context_id }
    });
    expect(unsubscribed.statusCode).toBe(200);

    const withoutEdge = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/research/projection`
    });
    expect(withoutEdge.json().projection.relationships.pulse_subscribers).toEqual([]);
    expect(tableCounts(handle)).toEqual(beforeCounts);
  });

  it("projects one generated delivery Context for repeated endpoint Pulse fires", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const floe = `actor:${workspaceId}:floe`;
    registerEndpoint(handle, workspaceId, floe);
    await createScope(handle, workspaceId, "research");
    const pulseId = "research-generated-delivery";

    const created = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: pulseId,
        workspace_id: workspaceId,
        persistence: "local",
        scope_id: "research",
        trigger: { type: "cron", schedule: "*/1 * * * * *" },
        event: { type: "pulse.fired", content: { text: "scheduled research work" } },
        subscribers: [{ kind: "endpoint", endpoint_ref: floe }]
      }
    });
    expect(created.statusCode).toBe(201);

    const firedEvents = await waitFor(async () => {
      const events = await handle.app.inject({
        method: "GET",
        url: `/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&scope_id=research`
      });
      const matches = (events.json().events as any[]).filter((event) => event.metadata?.pulse_id === pulseId);
      return matches.length >= 2 ? matches : null;
    }, 4_000);
    const generatedContextIds = new Set(firedEvents.map((event: any) => event.context_id));
    expect(generatedContextIds.size).toBe(1);

    const res = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/research/projection`
    });

    expect(res.statusCode).toBe(200);
    const projection = res.json().projection;
    expect(projection.refs.pulses).toEqual([
      expect.objectContaining({
        pulse_id: pulseId,
        scope_id: "research"
      })
    ]);
    expect(projection.refs.contexts).toEqual([
      expect.objectContaining({
        context_id: [...generatedContextIds][0],
        scope_id: "research",
        created_by_endpoint_id: floe
      })
    ]);
    expect(projection.refs.events.length).toBeGreaterThanOrEqual(2);
    for (const event of projection.refs.events) {
      expect(event).toMatchObject({
        scope_id: "research",
        context_id: [...generatedContextIds][0]
      });
    }
    expect(projection.refs.activity).toEqual([]);
  });

  it("keeps Context inclusion owned by the Context even when denormalized Event Scope is stale", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const operator = `actor:${workspaceId}:operator`;
    const floe = `actor:${workspaceId}:floe`;
    registerEndpoint(handle, workspaceId, operator);
    registerEndpoint(handle, workspaceId, floe);
    await createScope(handle, workspaceId, "research");
    await createScope(handle, workspaceId, "ops");
    const researchEvent = await emitMessage(handle, { workspaceId, source: operator, target: floe, scopeId: "research", text: "research hello" });
    handle.store.db.prepare("UPDATE events SET scope_id = ? WHERE event_id = ?").run("ops", researchEvent.event_id);

    const res = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/research/projection`
    });

    expect(res.statusCode).toBe(200);
    const projection = res.json().projection;
    expect(projection.refs.contexts).toEqual([
      expect.objectContaining({
        context_id: researchEvent.context_id,
        scope_id: "research"
      })
    ]);
    expect(projection.refs.events).toEqual([]);
    expect(projection.relationships.event_context_ownership).toEqual([]);
  });

  it("keeps Workspace-level actor Contexts discoverable without projecting them into a Scope", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const operator = `actor:${workspaceId}:operator`;
    const floe = `actor:${workspaceId}:floe`;
    registerEndpoint(handle, workspaceId, operator);
    registerEndpoint(handle, workspaceId, floe);
    await createScope(handle, workspaceId, "research");

    const unscopedEvent = await emitMessage(handle, {
      workspaceId,
      source: operator,
      target: floe,
      text: "workspace-level conversation"
    });
    const scopedEvent = await emitMessage(handle, {
      workspaceId,
      source: operator,
      target: floe,
      scopeId: "research",
      text: "scoped work"
    });

    const contextsRes = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/contexts?scope=unscoped`
    });
    const projectionRes = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/research/projection`
    });

    expect(contextsRes.statusCode).toBe(200);
    expect(contextsRes.json().contexts).toEqual([
      expect.objectContaining({
        context_id: unscopedEvent.context_id,
        scope_id: null,
        first_message_preview: "workspace-level conversation"
      })
    ]);
    expect(projectionRes.statusCode).toBe(200);
    expect(projectionRes.json().projection.refs.contexts).toEqual([
      expect.objectContaining({
        context_id: scopedEvent.context_id,
        scope_id: "research",
        first_message_preview: "scoped work"
      })
    ]);
    expect(projectionRes.body).not.toContain(unscopedEvent.context_id);
    expect(projectionRes.body).not.toContain("Default Scope");
    expect(projectionRes.body).not.toContain("Default Scope");
  });

  it("does not project Context-owned runtime telemetry as projection activity", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const operator = `actor:${workspaceId}:operator`;
    const floe = `actor:${workspaceId}:floe`;
    registerEndpoint(handle, workspaceId, operator);
    registerEndpoint(handle, workspaceId, floe);
    await createScope(handle, workspaceId, "research");
    await emitMessage(handle, { workspaceId, source: operator, target: floe, scopeId: "research", text: "research hello" });
    const deliveries = await handle.app.inject({
      method: "GET",
      url: `/v1/delivery?workspace_id=${encodeURIComponent(workspaceId)}`
    });
    expect(deliveries.statusCode).toBe(200);
    const [delivery] = deliveries.json().deliveries;
    expect(delivery.delivery_id).toMatch(/^del_/);
    const [deliveredEvent] = JSON.parse(delivery.events_json);
    const unrelated = await handle.app.inject({
      method: "POST",
      url: "/v1/runtime/telemetry",
      payload: {
        workspace_id: workspaceId,
        endpoint_id: floe,
        delivery_id: null,
        kind: "tool_use",
        payload: { name: "unresolved" }
      }
    });
    expect(unrelated.statusCode).toBe(202);
    const scoped = await handle.app.inject({
      method: "POST",
      url: "/v1/runtime/telemetry",
      payload: {
        workspace_id: workspaceId,
        endpoint_id: floe,
        delivery_id: delivery.delivery_id,
        kind: "tool_use",
        payload: { name: "resolved" }
      }
    });
    expect(scoped.statusCode).toBe(202);

    const res = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/research/projection`
    });

    expect(res.statusCode).toBe(200);
    const projection = res.json().projection;
    expect(scoped.json().telemetry.telemetry_id).toMatch(/^tel_/);
    expect(deliveredEvent.context_id).toBeTruthy();
    expect(projection.refs.activity).toEqual([]);
  });

  it("returns existing Scope error shapes and an empty projection for a valid empty Scope", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    await createScope(handle, workspaceId, "research");

    const unknownWorkspace = await handle.app.inject({
      method: "GET",
      url: "/v1/workspaces/workspace%3Amissing/scopes/research/projection"
    });
    expect(unknownWorkspace.statusCode).toBe(404);
    expect(unknownWorkspace.json()).toEqual({ error: "workspace_not_found", workspace_id: "workspace:missing" });

    const unknownScope = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/missing/projection`
    });
    expect(unknownScope.statusCode).toBe(404);
    expect(unknownScope.json()).toEqual({ error: "scope_not_found", workspace_id: workspaceId, scope_id: "missing" });

    const empty = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/research/projection`
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().projection).toMatchObject({
      workspace_id: workspaceId,
      scope_id: "research",
      refs: {
        contexts: [],
        pulses: [],
        events: [],
        activity: []
      },
      relationships: {
        context_participants: [],
        pulse_subscribers: [],
        event_context_ownership: []
      },
      unsupported: []
    });
  });

  it("keeps the projection contract read-only and free of renderer or separate membership vocabulary", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const operator = `actor:${workspaceId}:operator`;
    const floe = `actor:${workspaceId}:floe`;
    registerEndpoint(handle, workspaceId, operator);
    registerEndpoint(handle, workspaceId, floe);
    await createScope(handle, workspaceId, "research");
    const event = await emitMessage(handle, { workspaceId, source: operator, target: floe, scopeId: "research", text: "research hello" });
    await createPulse(handle, {
      workspaceId,
      pulseId: "research-reminder",
      scopeId: "research",
      subscribers: [{ kind: "context", context_id: event.context_id }]
    });
    const beforeCounts = tableCounts(handle);

    const res = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/research/projection`
    });

    expect(res.statusCode).toBe(200);
    expect(tableCounts(handle)).toEqual(beforeCounts);
    const body = res.body;
    for (const forbidden of ["nodes", "edges", "position", "handle", "field_item_id"]) {
      expect(body).not.toContain(`"${forbidden}"`);
    }
    expect(body).not.toContain(".floe/blocks");
    expect(body).not.toContain(".floe\\blocks");
  });
});
