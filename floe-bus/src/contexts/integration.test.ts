import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { type EventCommand } from "../store.js";
import { defaultConfig, type LocalConfig } from "../config.js";
import { createBusServer } from "../server.js";
import { emitViaRoute } from "../test-support/emit-via-route.js";

const noop = () => {};

const WS = "workspace:test-int";
const E1 = "actor:test:e1";
const E2 = "actor:test:e2";
const E3 = "actor:test:e3";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

function restoreWorkspace(handle: ServerHandle) {
  const timestamp = new Date().toISOString();
  handle.store.workspaceIdentityStore.restoreWorkspace({
    snapshot: {
      workspace_id: WS,
      name: "Test WS",
      creation_kind: "created",
      source_workspace_id: null,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
}

async function makeServer(): Promise<{ handle: ServerHandle; cleanup: () => Promise<void> }> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-ctx-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg: LocalConfig = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const handle = await createBusServer(cfgPath, cfg, { unsafe_in_process_test_auth_bypass: true });
  await handle.app.ready();
  restoreWorkspace(handle);
  // Register endpoints so destination resolution / delivery works
  for (const id of [E1, E2, E3]) {
    handle.store.registerEndpoint({
      endpoint_id: id,
      workspace_id: WS,
      name: id,
      bridge_id: null,
      status: "idle"
    }, noop);
  }
  return {
    handle,
    cleanup: async () => {
      try { await handle.app.close(); } catch {}
      rmSync(tmp, { recursive: true, force: true });
    }
  };
}

async function makeServerWithLegacyEventScopeSchema(): Promise<{ handle: ServerHandle; cleanup: () => Promise<void> }> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-ctx-legacy-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg: LocalConfig = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const dataDir = join(tmp, "bus");
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "floe-bus.sqlite"));
  db.exec(`
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      source_endpoint_id TEXT,
      thread_id TEXT NOT NULL,
      scope_id TEXT NOT NULL DEFAULT 'default',
      correlation_id TEXT,
      content_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      idempotency_key TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.close();
  const handle = await createBusServer(cfgPath, cfg, { unsafe_in_process_test_auth_bypass: true });
  await handle.app.ready();
  restoreWorkspace(handle);
  for (const id of [E1, E2, E3]) {
    handle.store.registerEndpoint({
      endpoint_id: id,
      workspace_id: WS,
      name: id,
      bridge_id: null,
      status: "idle"
    }, noop);
  }
  return {
    handle,
    cleanup: async () => {
      try { await handle.app.close(); } catch {}
      rmSync(tmp, { recursive: true, force: true });
    }
  };
}

function emitCommand(overrides: Partial<EventCommand> & { source_endpoint_id: string; destination: EventCommand["destination"] }): EventCommand {
  return {
    type: overrides.type ?? "message",
    workspace_id: overrides.workspace_id ?? WS,
    source_endpoint_id: overrides.source_endpoint_id,
    destination: overrides.destination,
    thread_id: overrides.thread_id ?? "",
    correlation_id: overrides.correlation_id ?? null,
    content: overrides.content ?? { text: "hi" },
    response: overrides.response,
    metadata: overrides.metadata ?? {},
    idempotency_key: overrides.idempotency_key ?? null,
    context_id: overrides.context_id,
    current_delivery_context_id: overrides.current_delivery_context_id
  };
}

describe("submitEvent context wiring", () => {
  let handle: ServerHandle;
  let store: ServerHandle["store"];
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const made = await makeServer();
    handle = made.handle;
    store = handle.store;
    cleanup = made.cleanup;
  });
  afterEach(async () => await cleanup());

  it("T2: emit without context_id and no current delivery context opens a new context with {source, destination}", async () => {
    const result = await emitViaRoute(handle,
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
    );
    expect(result.event.context_id).toMatch(/^ctx_/);
    const parts = store.contextStore.getContextParticipants(result.event.context_id!).sort();
    expect(parts).toEqual([E1, E2].sort());
  });

  it("actor emit without scope creates a Workspace-level unscoped Context and Event", async () => {
    const result = await emitViaRoute(handle,
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
    );

    const context = store.contextStore.getContext(result.event.context_id!);
    const [event] = store.listEvents({ workspace_id: WS, context_id: result.event.context_id! });

    expect(context?.scope_id).toBeNull();
    expect(result.event.scope_id).toBeNull();
    expect(event.scope_id).toBeNull();
  });

  it("upgrades legacy Event scope columns before persisting unscoped actor Events", async () => {
    await cleanup();
    const made = await makeServerWithLegacyEventScopeSchema();
    handle = made.handle;
    store = handle.store;
    cleanup = made.cleanup;

    const result = await emitViaRoute(handle,
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
    );

    expect(result.event.scope_id).toBeNull();
    expect(store.listEvents({ workspace_id: WS })[0].scope_id).toBeNull();
  });

  it("T3: emit where destination ∈ current delivery context's participants → continues current context", async () => {
    const r1 = await emitViaRoute(handle,
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
    );
    const ctxA = r1.event.context_id!;
    const r2 = await emitViaRoute(handle,
      emitCommand({
        source_endpoint_id: E2,
        destination: { kind: "endpoint", endpoint_id: E1 },
        current_delivery_context_id: ctxA
      }),
    );
    expect(r2.event.context_id).toBe(ctxA);
  });

  it("T4: emit where destination ∉ current delivery context → creates side thread in same context (Rule 3)", async () => {
    const r1 = await emitViaRoute(handle,
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
    );
    const ctxA = r1.event.context_id!;
    const r2 = await emitViaRoute(handle,
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E3 },
        current_delivery_context_id: ctxA
      }),
    );
    expect(r2.event.context_id).not.toBe(ctxA);
    expect(r2.event.thread_id).toBe(r2.event.context_id);
    expect(store.contextStore.getContext(r2.event.context_id!)?.parent_context_id).toBe(ctxA);
    expect(store.contextStore.getContextParticipants(r2.event.context_id!).sort()).toEqual([E1, E3].sort());
    expect(store.contextStore.getContextParticipants(ctxA).sort()).toEqual([E1, E2].sort());
  });

  it("T5/T13: emit with context_id where source ∉ A's participants → rejected with E_NOT_CONTEXT_PARTICIPANT, no event persisted", async () => {
    const r1 = await emitViaRoute(handle,
      emitCommand({ source_endpoint_id: E2, destination: { kind: "endpoint", endpoint_id: E3 } }),
    );
    const ctxA = r1.event.context_id!;
    const eventCountBefore = store.listEvents({ workspace_id: WS }).length;
    const rejected = await emitViaRoute(handle,
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E2 },
        context_id: ctxA
      }),
    );
    expect(rejected.status).toBe(409);
    expect(rejected.body).toMatchObject({
      ok: false,
      error: {
        code: "E_NOT_CONTEXT_PARTICIPANT",
        context_id: ctxA,
        source_endpoint_id: E1,
      },
    });
    const eventCountAfter = store.listEvents({ workspace_id: WS }).length;
    expect(eventCountAfter).toBe(eventCountBefore);
  });

  it("T13: rejection error carries bounded available_contexts payload", async () => {
    const r1 = await emitViaRoute(handle,
      emitCommand({ source_endpoint_id: E2, destination: { kind: "endpoint", endpoint_id: E3 } }),
    );
    const ctxA = r1.event.context_id!;
    // Give E1 some contexts
    await emitViaRoute(handle,
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
    );
    const rejected = await emitViaRoute(handle,
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E2 },
        context_id: ctxA
      }),
    );
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe("E_NOT_CONTEXT_PARTICIPANT");
    expect(rejected.body.error.context_id).toBe(ctxA);
    expect(rejected.body.error.source_endpoint_id).toBe(E1);
    expect(Array.isArray(rejected.body.error.available_contexts)).toBe(true);
    expect(rejected.body.error.available_contexts.length).toBeGreaterThan(0);
    expect(rejected.body.error.available_contexts.length).toBeLessThanOrEqual(10);
    expect(Array.isArray(rejected.body.error.recovery)).toBe(true);
  });

  it("T7: events filtered by context_id return only events for that context", async () => {
    const r1 = await emitViaRoute(handle,
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
    );
    const r2 = await emitViaRoute(handle,
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E3 } }),
    );
    const ctxA = r1.event.context_id!;
    const ctxB = r2.event.context_id!;
    expect(ctxA).not.toBe(ctxB);
    const aEvents = store.listEvents({ workspace_id: WS, context_id: ctxA });
    const bEvents = store.listEvents({ workspace_id: WS, context_id: ctxB });
    expect(aEvents.every((e) => e.context_id === ctxA)).toBe(true);
    expect(bEvents.every((e) => e.context_id === ctxB)).toBe(true);
    expect(aEvents.map((e) => e.event_id)).toContain(r1.event.event_id);
    expect(bEvents.map((e) => e.event_id)).toContain(r2.event.event_id);
  });

  it("T10: participants are stable across the emit cycle (implicit routing does not mutate membership)", async () => {
    const r1 = await emitViaRoute(handle,
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
    );
    const ctxA = r1.event.context_id!;
    const before = store.contextStore.getContextParticipants(ctxA).sort();
    // E1 → E2 reply continuing
    await emitViaRoute(handle,
      emitCommand({
        source_endpoint_id: E2,
        destination: { kind: "endpoint", endpoint_id: E1 },
        context_id: ctxA
      }),
    );
    // E1 → E3 (opens new context — should NOT mutate A)
    await emitViaRoute(handle,
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E3 },
        current_delivery_context_id: ctxA
      }),
    );
    const after = store.contextStore.getContextParticipants(ctxA).sort();
    expect(after).toEqual(before);
    // Dynamic participant API now exists on contextStore (Slice 1)
    expect(typeof store.contextStore.addParticipant).toBe("function");
    expect(typeof store.contextStore.removeParticipant).toBe("function");
  });

  it("T12: emit with context_id where source ∈ A → succeeds", async () => {
    const r1 = await emitViaRoute(handle,
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
    );
    const ctxA = r1.event.context_id!;
    const r2 = await emitViaRoute(handle,
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E2 },
        context_id: ctxA
      }),
    );
    expect(r2.event.context_id).toBe(ctxA);
  });

  it("T14: self-emit (source == destination) into a context source participates in succeeds", async () => {
    const r1 = await emitViaRoute(handle,
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E1 } }),
    );
    const ctxA = r1.event.context_id!;
    const r2 = await emitViaRoute(handle,
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E1 },
        context_id: ctxA
      }),
    );
    expect(r2.event.context_id).toBe(ctxA);
    expect(store.contextStore.getContextParticipants(ctxA)).toEqual([E1]);
  });

  it("T18: UI-originated emit with context_id null and no delivery context → opens new context, ignores any 'previous selection'", async () => {
    // Even with prior emits, an emit without context_id and without current_delivery_context_id opens fresh.
    await emitViaRoute(handle,
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
    );
    const r2 = await emitViaRoute(handle,
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E2 },
        context_id: null,
        current_delivery_context_id: null
      }),
    );
    expect(r2.event.context_id).toMatch(/^ctx_/);
    // Two distinct contexts now exist for E1↔E2
    const all = store.contextStore.listContextsForParticipant(E1);
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("T19: UI-originated emit with explicit context_id continues that context", async () => {
    const r1 = await emitViaRoute(handle,
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
    );
    const ctxA = r1.event.context_id!;
    const r2 = await emitViaRoute(handle,
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E2 },
        context_id: ctxA,
        current_delivery_context_id: null
      }),
    );
    expect(r2.event.context_id).toBe(ctxA);
  });

  it("Persisted event row carries context_id column", async () => {
    const r = await emitViaRoute(handle,
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
    );
    const row = store.db.prepare("SELECT context_id FROM events WHERE event_id = ?").get(r.event.event_id) as any;
    expect(row.context_id).toBe(r.event.context_id);
  });

  it("Rejected emit creates no delivery rows", async () => {
    const r1 = await emitViaRoute(handle,
      emitCommand({ source_endpoint_id: E2, destination: { kind: "endpoint", endpoint_id: E3 } }),
    );
    const ctxA = r1.event.context_id!;
    const queueBefore = store.db.prepare("SELECT COUNT(*) AS c FROM event_queue").get() as any;
    const rejected = await emitViaRoute(handle,
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E2 },
        context_id: ctxA
      }),
    );
    expect(rejected.status).toBe(409);
    const queueAfter = store.db.prepare("SELECT COUNT(*) AS c FROM event_queue").get() as any;
    expect(queueAfter.c).toBe(queueBefore.c);
  });

  it("T-CR1: a peer-context participant reply continues that peer context", async () => {
    const origin = (await emitViaRoute(handle, emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }))).event.context_id!;
    const peer = (await emitViaRoute(handle, emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E3 }, current_delivery_context_id: origin }))).event.context_id!;
    const reply = await emitViaRoute(handle, emitCommand({ source_endpoint_id: E3, destination: { kind: "endpoint", endpoint_id: E1 }, current_delivery_context_id: peer }));
    expect(reply.event.context_id).toBe(peer);
  });

  it("T-CR2: a nonparticipant target opens another peer context linked to its origin", async () => {
    const origin = (await emitViaRoute(handle, emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }))).event.context_id!;
    const peer = (await emitViaRoute(handle, emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E3 }, current_delivery_context_id: origin }))).event.context_id!;
    const next = await emitViaRoute(handle, emitCommand({ source_endpoint_id: E3, destination: { kind: "endpoint", endpoint_id: E2 }, current_delivery_context_id: peer }));
    expect(store.contextStore.getContext(next.event.context_id!)?.parent_context_id).toBe(peer);
  });

  it("T-CR3: an explicit context continues it while preserving supplied thread storage", async () => {
    const ctx = (await emitViaRoute(handle, emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }))).event.context_id!;
    const result = await emitViaRoute(handle, emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 }, context_id: ctx, thread_id: "legacy-thread" }));
    expect(result.event.context_id).toBe(ctx);
    expect(result.event.thread_id).toBe("legacy-thread");
  });

});
