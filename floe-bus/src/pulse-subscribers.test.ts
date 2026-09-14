import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import { defaultConfig, type LocalConfig } from "./config.js";

const WS = "workspace:pulse-subscribers";
const OPERATOR = `actor:${WS}:operator`;
const FLOE = `actor:${WS}:floe`;
const REVIEWER = `actor:${WS}:reviewer`;
const BRIDGE = "bridge:pulse-test";
const OPS_SCOPE = "ops";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

async function makeServer(): Promise<{ handle: ServerHandle; cleanup: () => Promise<void> }> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-pulse-subs-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg: LocalConfig = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const handle = await createBusServer(cfgPath, cfg, { allow_unauthenticated_test_requests: true });
  await handle.app.ready();
  for (const endpoint_id of [OPERATOR, FLOE]) {
    handle.store.registerEndpoint({
      endpoint_id,
      workspace_id: WS,
      name: endpoint_id,
      bridge_id: BRIDGE,
      status: "idle"
    }, () => {});
  }
  handle.store.createScope({ workspace_id: WS, scope_id: OPS_SCOPE, title: "Ops" }, () => {});
  return {
    handle,
    cleanup: async () => {
      try { await handle.app.close(); } catch {}
      rmSync(tmp, { recursive: true, force: true });
    }
  };
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

describe("Pulse subscribers", () => {
  let handle: ServerHandle;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const made = await makeServer();
    handle = made.handle;
    cleanup = made.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  it("context subscriber can anchor a Pulse to an unscoped actor Context", async () => {
    const contextId = handle.store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: OPERATOR,
      participants: [OPERATOR, FLOE]
    });
    const pulseId = `pulse-unscoped-context-${Date.now()}`;

    const createRes = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: pulseId,
        workspace_id: WS,
        persistence: "local",
        trigger: { type: "once", at: new Date(Date.now() + 30).toISOString() },
        event: {
          type: "pulse.fired",
          content: { text: "Append without Scope." }
        },
        subscribers: [{ kind: "context", context_id: contextId }]
      }
    });
    expect(createRes.statusCode).toBe(201);
    expect(createRes.json().pulse.scope_id).toBeNull();

    const pulseEvent = await waitFor(async () => {
      const res = await handle.app.inject({ method: "GET", url: `/v1/contexts/${encodeURIComponent(contextId)}/events` });
      const events = res.json().events as any[];
      return events.find((event) => event.type === "pulse.fired" && event.metadata?.pulse_id === pulseId) ?? null;
    });

    expect(pulseEvent.scope_id).toBeNull();
    expect(pulseEvent.context_id).toBe(contextId);
    expect(pulseEvent.source_endpoint_id).toBeNull();
    expect(pulseEvent.destination_json).toEqual({ kind: "context", context_id: contextId });

    const deliveriesRes = await handle.app.inject({
      method: "GET",
      url: `/v1/delivery/claim?bridge_id=${encodeURIComponent(BRIDGE)}&limit=10`
    });
    expect(deliveriesRes.json().deliveries).toEqual([]);
  });

  it("endpoint subscriber can deliver into an unscoped actor Context when the target participates", async () => {
    const contextId = handle.store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: OPERATOR,
      participants: [OPERATOR, FLOE]
    });
    const pulseId = `pulse-unscoped-endpoint-${Date.now()}`;

    const createRes = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: pulseId,
        workspace_id: WS,
        persistence: "local",
        trigger: { type: "once", at: new Date(Date.now() + 30).toISOString() },
        event: {
          type: "pulse.fired",
          content: { instructions: "Deliver without Scope." }
        },
        subscribers: [{ kind: "endpoint", endpoint_ref: "floe", context_id: contextId }]
      }
    });
    expect(createRes.statusCode).toBe(201);
    expect(createRes.json().pulse.scope_id).toBeNull();

    const delivery = await waitFor(async () => {
      const res = await handle.app.inject({
        method: "GET",
        url: `/v1/delivery/claim?bridge_id=${encodeURIComponent(BRIDGE)}&limit=10`
      });
      const deliveries = res.json().deliveries as any[];
      return deliveries.find((candidate) =>
        candidate.endpoint_id === FLOE &&
        candidate.events.some((event: any) => event.type === "pulse.fired" && event.metadata?.pulse_id === pulseId)
      ) ?? null;
    });

    const pulseEvent = delivery.events.find((event: any) => event.metadata?.pulse_id === pulseId);
    expect(pulseEvent.scope_id).toBeNull();
    expect(pulseEvent.context_id).toBe(contextId);
    expect(pulseEvent.destination_json).toEqual({ kind: "endpoint", endpoint_id: FLOE });
  });

  it("rejects endpoint delivery into an unscoped actor Context when the target does not participate", async () => {
    const contextId = handle.store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: OPERATOR,
      participants: [OPERATOR]
    });
    const pulseId = `pulse-invalid-unscoped-endpoint-${Date.now()}`;

    const createRes = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: pulseId,
        workspace_id: WS,
        persistence: "local",
        trigger: { type: "once", at: new Date(Date.now() + 30).toISOString() },
        event: {
          type: "pulse.fired",
          content: { instructions: "Do not deliver." }
        },
        subscribers: [{ kind: "endpoint", endpoint_ref: "floe", context_id: contextId }]
      }
    });

    expect(createRes.statusCode).toBe(400);
    expect(createRes.json()).toMatchObject({
      ok: false,
      error: "context_anchor_invalid",
      workspace_id: WS,
      context_id: contextId
    });
    const pulses = await handle.app.inject({ method: "GET", url: `/v1/pulses?workspace_id=${encodeURIComponent(WS)}` });
    expect((pulses.json().pulses as any[]).some((pulse) => pulse.pulse_id === pulseId)).toBe(false);
  });

  it("rejects subscribe mutations that would add generated delivery to an unscoped Pulse", async () => {
    const contextId = handle.store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: OPERATOR,
      participants: [OPERATOR, FLOE]
    });
    const pulseId = `pulse-subscribe-generated-${Date.now()}`;
    const createRes = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: pulseId,
        workspace_id: WS,
        persistence: "local",
        trigger: { type: "once", at: new Date(Date.now() + 60_000).toISOString() },
        event: { type: "pulse.fired", content: { text: "Append only." } },
        subscribers: [{ kind: "context", context_id: contextId }]
      }
    });
    expect(createRes.statusCode).toBe(201);
    expect(createRes.json().pulse.scope_id).toBeNull();

    const subscribed = await handle.app.inject({
      method: "POST",
      url: `/v1/pulses/${encodeURIComponent(pulseId)}/subscribe`,
      payload: { kind: "endpoint", endpoint_ref: "floe" }
    });

    expect(subscribed.statusCode).toBe(400);
    expect(subscribed.json()).toMatchObject({
      ok: false,
      error: "scope_required",
      workspace_id: WS
    });
    const pulse = await handle.app.inject({ method: "GET", url: `/v1/pulses?workspace_id=${encodeURIComponent(WS)}` });
    const stored = (pulse.json().pulses as any[]).find((item) => item.pulse_id === pulseId);
    expect(stored.subscribers).toEqual([{ kind: "context", context_id: contextId }]);
  });

  it("rejects subscribe mutations that add endpoint delivery to an unrelated unscoped Context", async () => {
    const contextId = handle.store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: OPERATOR,
      participants: [OPERATOR, FLOE]
    });
    const unrelatedContextId = handle.store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: OPERATOR,
      participants: [OPERATOR]
    });
    const pulseId = `pulse-subscribe-invalid-anchor-${Date.now()}`;
    const createRes = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: pulseId,
        workspace_id: WS,
        persistence: "local",
        trigger: { type: "once", at: new Date(Date.now() + 60_000).toISOString() },
        event: { type: "pulse.fired", content: { text: "Append only." } },
        subscribers: [{ kind: "context", context_id: contextId }]
      }
    });
    expect(createRes.statusCode).toBe(201);

    const subscribed = await handle.app.inject({
      method: "POST",
      url: `/v1/pulses/${encodeURIComponent(pulseId)}/subscribe`,
      payload: { kind: "endpoint", endpoint_ref: "floe", context_id: unrelatedContextId }
    });

    expect(subscribed.statusCode).toBe(400);
    expect(subscribed.json()).toMatchObject({
      ok: false,
      error: "context_anchor_invalid",
      workspace_id: WS,
      context_id: unrelatedContextId
    });
    const pulse = await handle.app.inject({ method: "GET", url: `/v1/pulses?workspace_id=${encodeURIComponent(WS)}` });
    const stored = (pulse.json().pulses as any[]).find((item) => item.pulse_id === pulseId);
    expect(stored.subscribers).toEqual([{ kind: "context", context_id: contextId }]);
  });

  it("rejects Pulse upserts that would retain generated delivery after nulling scope", async () => {
    const contextId = handle.store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: OPERATOR,
      participants: [OPERATOR, FLOE]
    });
    const pulseId = `pulse-upsert-retained-generated-${Date.now()}`;
    const createRes = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: pulseId,
        workspace_id: WS,
        persistence: "local",
        scope_id: OPS_SCOPE,
        trigger: { type: "once", at: new Date(Date.now() + 60_000).toISOString() },
        event: { type: "pulse.fired", content: { text: "Deliver in scoped generated context." } },
        subscribers: [{ kind: "endpoint", endpoint_ref: "floe" }]
      }
    });
    expect(createRes.statusCode).toBe(201);

    const upsertRes = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: pulseId,
        workspace_id: WS,
        persistence: "local",
        trigger: { type: "once", at: new Date(Date.now() + 120_000).toISOString() },
        event: { type: "pulse.fired", content: { text: "Append only." } },
        subscribers: [{ kind: "context", context_id: contextId }]
      }
    });

    expect(upsertRes.statusCode).toBe(400);
    expect(upsertRes.json()).toMatchObject({
      ok: false,
      error: "scope_required",
      workspace_id: WS
    });
    const storedRes = await handle.app.inject({ method: "GET", url: `/v1/pulses?workspace_id=${encodeURIComponent(WS)}` });
    const stored = (storedRes.json().pulses as any[]).find((item) => item.pulse_id === pulseId);
    expect(stored.scope_id).toBe(OPS_SCOPE);
    expect(stored.subscribers).toEqual([{ kind: "endpoint", endpoint_ref: "floe" }]);
  });

  it("context subscriber appends pulse.fired to the supplied context without endpoint delivery", async () => {
    const contextId = handle.store.contextStore.createContext({
      workspace_id: WS,
      scope_id: OPS_SCOPE,
      created_by_endpoint_id: OPERATOR,
      participants: [OPERATOR, FLOE]
    });
    const unrelatedContextId = handle.store.contextStore.createContext({
      workspace_id: WS,
      scope_id: OPS_SCOPE,
      created_by_endpoint_id: OPERATOR,
      participants: [OPERATOR, FLOE]
    });
    const pulseId = `pulse-${Date.now()}`;

    const createRes = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: pulseId,
        workspace_id: WS,
        persistence: "local",
        scope_id: OPS_SCOPE,
        trigger: { type: "once", at: new Date(Date.now() + 30).toISOString() },
        event: {
          type: "pulse.fired",
          content: { text: "Check email." }
        },
        subscribers: [{ kind: "context", context_id: contextId }]
      }
    });
    expect(createRes.statusCode).toBe(201);

    const pulseEvent = await waitFor(async () => {
      const res = await handle.app.inject({ method: "GET", url: `/v1/contexts/${encodeURIComponent(contextId)}/events` });
      const events = res.json().events as any[];
      return events.find((event) => event.type === "pulse.fired" && event.metadata?.pulse_id === pulseId) ?? null;
    });

    expect(pulseEvent.context_id).toBe(contextId);
    expect(pulseEvent.source_endpoint_id).toBeNull();
    expect(pulseEvent.content).toMatchObject({ text: "Check email.", pulse_id: pulseId });
    expect(pulseEvent.destination_json).toEqual({ kind: "context", context_id: contextId });

    const unrelatedRes = await handle.app.inject({ method: "GET", url: `/v1/contexts/${encodeURIComponent(unrelatedContextId)}/events` });
    expect((unrelatedRes.json().events as any[]).some((event) => event.metadata?.pulse_id === pulseId)).toBe(false);

    const contextRes = await handle.app.inject({ method: "GET", url: `/v1/contexts/${encodeURIComponent(contextId)}` });
    expect(contextRes.json().participants.sort()).toEqual([OPERATOR, FLOE].sort());

    const endpointsRes = await handle.app.inject({ method: "GET", url: `/v1/workspaces/${encodeURIComponent(WS)}/endpoints` });
    const endpointStatuses = new Map((endpointsRes.json().endpoints as any[]).map((endpoint) => [endpoint.endpoint_id, endpoint.status]));
    expect(endpointStatuses.get(OPERATOR)).toBe("idle");
    expect(endpointStatuses.get(FLOE)).toBe("idle");
  });

  it("endpoint subscriber delivers pulse.fired to the endpoint in the supplied context", async () => {
    const contextId = handle.store.contextStore.createContext({
      workspace_id: WS,
      scope_id: OPS_SCOPE,
      created_by_endpoint_id: OPERATOR,
      participants: [OPERATOR, FLOE]
    });
    const pulseId = `pulse-${Date.now()}`;

    const createRes = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: pulseId,
        workspace_id: WS,
        persistence: "local",
        scope_id: OPS_SCOPE,
        trigger: { type: "once", at: new Date(Date.now() + 30).toISOString() },
        event: {
          type: "pulse.fired",
          content: { instructions: "Check status and report back." }
        },
        subscribers: [{ kind: "endpoint", endpoint_ref: "floe", context_id: contextId }]
      }
    });
    expect(createRes.statusCode).toBe(201);

    const delivery = await waitFor(async () => {
      const res = await handle.app.inject({
        method: "GET",
        url: `/v1/delivery/claim?bridge_id=${encodeURIComponent(BRIDGE)}&limit=10`
      });
      const deliveries = res.json().deliveries as any[];
      return deliveries.find((candidate) =>
        candidate.endpoint_id === FLOE &&
        candidate.events.some((event: any) => event.type === "pulse.fired" && event.metadata?.pulse_id === pulseId)
      ) ?? null;
    });

    const pulseEvent = delivery.events.find((event: any) => event.metadata?.pulse_id === pulseId);
    expect(pulseEvent.context_id).toBe(contextId);
    expect(pulseEvent.source_endpoint_id).toBeNull();
    expect(pulseEvent.destination_json).toEqual({ kind: "endpoint", endpoint_id: FLOE });
    expect(pulseEvent.content).toMatchObject({ instructions: "Check status and report back.", pulse_id: pulseId });

    const contextEventsRes = await handle.app.inject({ method: "GET", url: `/v1/contexts/${encodeURIComponent(contextId)}/events` });
    expect((contextEventsRes.json().events as any[]).some((event) => event.metadata?.pulse_id === pulseId)).toBe(true);
  });

  it("endpoint subscriber without context_id reuses one generated delivery Context across fires", async () => {
    const pulseId = `pulse-stable-${Date.now()}`;

    const createRes = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: pulseId,
        workspace_id: WS,
        persistence: "local",
        scope_id: OPS_SCOPE,
        trigger: { type: "cron", schedule: "*/1 * * * * *" },
        event: {
          type: "pulse.fired",
          content: { instructions: "Check status and report back." }
        },
        subscribers: [{ kind: "endpoint", endpoint_ref: "floe" }]
      }
    });
    expect(createRes.statusCode).toBe(201);

    const pulseEvents = await waitFor(async () => {
      const res = await handle.app.inject({ method: "GET", url: `/v1/events?workspace_id=${encodeURIComponent(WS)}` });
      const events = (res.json().events as any[])
        .filter((event) => event.type === "pulse.fired" && event.metadata?.pulse_id === pulseId);
      return events.length >= 2 ? events : null;
    }, 3_500);

    const contexts = new Set(pulseEvents.map((event) => event.context_id));
    expect(contexts.size).toBe(1);
    const [contextId] = contexts;
    expect(contextId).toMatch(/^ctx_/);
    expect(pulseEvents.every((event) => event.source_endpoint_id === null)).toBe(true);
    expect(pulseEvents.every((event) =>
      event.destination_json.kind === "endpoint" &&
      event.destination_json.endpoint_id === FLOE
    )).toBe(true);

    const contextRes = await handle.app.inject({ method: "GET", url: `/v1/contexts/${encodeURIComponent(contextId)}` });
    expect(contextRes.statusCode).toBe(200);
    expect(contextRes.json().participants).toEqual([FLOE]);
  });

  it("endpoint subscribers without context_id each get an independent generated delivery Context", async () => {
    handle.store.registerEndpoint({
      endpoint_id: REVIEWER,
      workspace_id: WS,
      name: REVIEWER,
      bridge_id: BRIDGE,
      status: "idle"
    }, () => {});
    const pulseId = `pulse-multi-stable-${Date.now()}`;

    const createRes = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: pulseId,
        workspace_id: WS,
        persistence: "local",
        scope_id: OPS_SCOPE,
        trigger: { type: "cron", schedule: "*/1 * * * * *" },
        event: {
          type: "pulse.fired",
          content: { instructions: "Run scheduled work." }
        },
        subscribers: [
          { kind: "endpoint", endpoint_ref: "floe" },
          { kind: "endpoint", endpoint_ref: "reviewer" }
        ]
      }
    });
    expect(createRes.statusCode).toBe(201);

    const pulseEvents = await waitFor(async () => {
      const res = await handle.app.inject({ method: "GET", url: `/v1/events?workspace_id=${encodeURIComponent(WS)}` });
      const events = (res.json().events as any[])
        .filter((event) => event.type === "pulse.fired" && event.metadata?.pulse_id === pulseId);
      const floeEvents = events.filter((event) => event.destination_json.endpoint_id === FLOE);
      const reviewerEvents = events.filter((event) => event.destination_json.endpoint_id === REVIEWER);
      return floeEvents.length >= 2 && reviewerEvents.length >= 2 ? events : null;
    }, 3_500);

    const contextsByEndpoint = new Map<string, Set<string>>();
    for (const event of pulseEvents) {
      const endpointId = event.destination_json.endpoint_id as string;
      const contexts = contextsByEndpoint.get(endpointId) ?? new Set<string>();
      contexts.add(event.context_id);
      contextsByEndpoint.set(endpointId, contexts);
    }
    expect(contextsByEndpoint.get(FLOE)?.size).toBe(1);
    expect(contextsByEndpoint.get(REVIEWER)?.size).toBe(1);
    const floeContext = [...contextsByEndpoint.get(FLOE)!][0];
    const reviewerContext = [...contextsByEndpoint.get(REVIEWER)!][0];
    expect(floeContext).not.toBe(reviewerContext);

    const floeContextRes = await handle.app.inject({ method: "GET", url: `/v1/contexts/${encodeURIComponent(floeContext)}` });
    const reviewerContextRes = await handle.app.inject({ method: "GET", url: `/v1/contexts/${encodeURIComponent(reviewerContext)}` });
    expect(floeContextRes.json().participants).toEqual([FLOE]);
    expect(reviewerContextRes.json().participants).toEqual([REVIEWER]);
  });

  it("recreates a generated endpoint delivery Context after deletion without cancelling the Pulse", async () => {
    const pulseId = `pulse-recreate-${Date.now()}`;
    const createRes = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: pulseId,
        workspace_id: WS,
        persistence: "local",
        scope_id: OPS_SCOPE,
        trigger: { type: "cron", schedule: "*/1 * * * * *" },
        event: {
          type: "pulse.fired",
          content: { instructions: "Continue scheduled work." }
        },
        subscribers: [{ kind: "endpoint", endpoint_ref: "floe" }]
      }
    });
    expect(createRes.statusCode).toBe(201);

    const firstDelivery = await waitFor(async () => {
      const res = await handle.app.inject({
        method: "GET",
        url: `/v1/delivery/claim?bridge_id=${encodeURIComponent(BRIDGE)}&limit=10`
      });
      const deliveries = res.json().deliveries as any[];
      return deliveries.find((delivery) =>
        delivery.events.some((event: any) => event.metadata?.pulse_id === pulseId)
      ) ?? null;
    }, 3_500);
    const firstEvent = firstDelivery.events.find((event: any) => event.metadata?.pulse_id === pulseId);
    const generatedContextId = firstEvent.context_id;

    const deleteRes = await handle.app.inject({
      method: "DELETE",
      url: `/v1/contexts/${encodeURIComponent(generatedContextId)}`
    });
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.json()).toMatchObject({
      context_id: generatedContextId,
      pulse_subscribers_deleted: 0
    });

    const pulseAfterDelete = await handle.app.inject({
      method: "GET",
      url: `/v1/pulses?workspace_id=${encodeURIComponent(WS)}`
    });
    const pulse = (pulseAfterDelete.json().pulses as any[]).find((item) => item.pulse_id === pulseId);
    expect(pulse).toMatchObject({
      pulse_id: pulseId,
      status: "active",
      subscribers: [{ kind: "endpoint", endpoint_ref: "floe" }]
    });

    await handle.app.inject({
      method: "POST",
      url: `/v1/endpoints/${encodeURIComponent(FLOE)}/status`,
      payload: { status: "idle" }
    });

    const secondDelivery = await waitFor(async () => {
      const res = await handle.app.inject({
        method: "GET",
        url: `/v1/delivery/claim?bridge_id=${encodeURIComponent(BRIDGE)}&limit=10`
      });
      const deliveries = res.json().deliveries as any[];
      return deliveries.find((delivery) =>
        delivery.events.some((event: any) => event.metadata?.pulse_id === pulseId)
      ) ?? null;
    }, 3_500);
    const secondEvent = secondDelivery.events.find((event: any) => event.metadata?.pulse_id === pulseId);
    expect(secondEvent.context_id).toBe(generatedContextId);
    expect(secondEvent.destination_json).toEqual({ kind: "endpoint", endpoint_id: FLOE });

    const recreatedContext = await handle.app.inject({
      method: "GET",
      url: `/v1/contexts/${encodeURIComponent(generatedContextId)}`
    });
    expect(recreatedContext.statusCode).toBe(200);
    expect(recreatedContext.json().participants).toEqual([FLOE]);
  });

  it("mixed subscribers keep pulse.fired canonical and do not add synthetic participants or pollute other contexts", async () => {
    const renderContextId = handle.store.contextStore.createContext({
      workspace_id: WS,
      scope_id: OPS_SCOPE,
      created_by_endpoint_id: OPERATOR,
      participants: [OPERATOR, FLOE]
    });
    const endpointContextId = handle.store.contextStore.createContext({
      workspace_id: WS,
      scope_id: OPS_SCOPE,
      created_by_endpoint_id: OPERATOR,
      participants: [OPERATOR, FLOE]
    });
    const unrelatedContextId = handle.store.contextStore.createContext({
      workspace_id: WS,
      scope_id: OPS_SCOPE,
      created_by_endpoint_id: OPERATOR,
      participants: [OPERATOR, FLOE]
    });
    const pulseId = `pulse-${Date.now()}`;

    const createRes = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: pulseId,
        workspace_id: WS,
        persistence: "local",
        scope_id: OPS_SCOPE,
        trigger: { type: "once", at: new Date(Date.now() + 30).toISOString() },
        event: {
          type: "pulse.fired",
          content: { text: "Render here.", instructions: "Process there." }
        },
        subscribers: [
          { kind: "context", context_id: renderContextId },
          { kind: "endpoint", endpoint_ref: "floe", context_id: endpointContextId }
        ]
      }
    });
    expect(createRes.statusCode).toBe(201);

    const delivery = await waitFor(async () => {
      const renderRes = await handle.app.inject({ method: "GET", url: `/v1/contexts/${encodeURIComponent(renderContextId)}/events` });
      const renderEvents = renderRes.json().events as any[];
      const hasRenderEvent = renderEvents.some((event) => event.type === "pulse.fired" && event.metadata?.pulse_id === pulseId);
      const claimRes = await handle.app.inject({
        method: "GET",
        url: `/v1/delivery/claim?bridge_id=${encodeURIComponent(BRIDGE)}&limit=10`
      });
      const deliveries = claimRes.json().deliveries as any[];
      const endpointDelivery = deliveries.find((candidate) =>
        candidate.endpoint_id === FLOE &&
        candidate.events.some((event: any) => event.type === "pulse.fired" && event.metadata?.pulse_id === pulseId)
      );
      return hasRenderEvent && endpointDelivery ? endpointDelivery : null;
    });

    const renderEventsRes = await handle.app.inject({ method: "GET", url: `/v1/contexts/${encodeURIComponent(renderContextId)}/events` });
    const renderEvents = renderEventsRes.json().events as any[];
    const renderEvent = renderEvents.find((event) => event.metadata?.pulse_id === pulseId);
    expect(renderEvent.type).toBe("pulse.fired");
    expect(renderEvent.context_id).toBe(renderContextId);
    expect(renderEvent.source_endpoint_id).toBeNull();
    expect(renderEvent.destination_json).toEqual({ kind: "context", context_id: renderContextId });

    const endpointEvent = delivery.events.find((event: any) => event.metadata?.pulse_id === pulseId);
    expect(endpointEvent.type).toBe("pulse.fired");
    expect(endpointEvent.context_id).toBe(endpointContextId);
    expect(endpointEvent.source_endpoint_id).toBeNull();
    expect(endpointEvent.destination_json).toEqual({ kind: "endpoint", endpoint_id: FLOE });

    const unrelatedRes = await handle.app.inject({ method: "GET", url: `/v1/contexts/${encodeURIComponent(unrelatedContextId)}/events` });
    expect((unrelatedRes.json().events as any[]).some((event) => event.metadata?.pulse_id === pulseId)).toBe(false);

    for (const contextId of [renderContextId, endpointContextId]) {
      const contextRes = await handle.app.inject({ method: "GET", url: `/v1/contexts/${encodeURIComponent(contextId)}` });
      const participants = contextRes.json().participants as string[];
      expect(participants.sort()).toEqual([OPERATOR, FLOE].sort());
      expect(participants.some((participant) => participant.includes("system:") || participant.includes(":pulse:"))).toBe(false);
    }
  });

  it("surfaces malformed stored endpoint subscribers without preventing valid subscribers", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const contextId = handle.store.contextStore.createContext({
        workspace_id: WS,
        scope_id: OPS_SCOPE,
        created_by_endpoint_id: OPERATOR,
        participants: [OPERATOR, FLOE]
      });
      const pulseId = `pulse-${Date.now()}`;

      const createRes = await handle.app.inject({
        method: "POST",
        url: "/v1/pulses",
        payload: {
          pulse_id: pulseId,
          workspace_id: WS,
          persistence: "local",
          scope_id: OPS_SCOPE,
          trigger: { type: "once", at: new Date(Date.now() + 75).toISOString() },
          event: {
            type: "pulse.fired",
            content: { text: "Still render despite malformed subscriber." }
          },
          subscribers: [{ kind: "context", context_id: contextId }]
        }
      });
      expect(createRes.statusCode).toBe(201);
      handle.store.addPulseSubscriber(pulseId, { kind: "endpoint" } as any);

      const pulseEvent = await waitFor(async () => {
        const res = await handle.app.inject({ method: "GET", url: `/v1/contexts/${encodeURIComponent(contextId)}/events` });
        const events = res.json().events as any[];
        return events.find((event) => event.type === "pulse.fired" && event.metadata?.pulse_id === pulseId) ?? null;
      });

      expect(pulseEvent.destination_json).toEqual({ kind: "context", context_id: contextId });
      const deliveriesRes = await handle.app.inject({
        method: "GET",
        url: `/v1/delivery/claim?bridge_id=${encodeURIComponent(BRIDGE)}&limit=10`
      });
      expect((deliveriesRes.json().deliveries as any[]).some((delivery) =>
        delivery.events.some((event: any) => event.metadata?.pulse_id === pulseId)
      )).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        "[bus] pulse endpoint subscriber missing endpoint_ref",
        expect.objectContaining({ pulse_id: pulseId })
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
