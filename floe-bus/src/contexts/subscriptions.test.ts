/**
 * Slice 2 — Per-actor, per-context, per-event-type subscriptions +
 *            context-addressed delivery routing (single path).
 *
 * Tests ContextStore subscription CRUD methods and the unified
 * context-delivery routing path through BusStore.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { ContextStore, applyContextSchema } from "./store.js";
import { type EventCommand } from "../store.js";
import { defaultConfig, type LocalConfig } from "../config.js";
import { createBusServer } from "../server.js";
import { emitViaRoute } from "../test-support/emit-via-route.js";

const WS = "workspace:test-subs";
const E1 = "actor:subs:e1";
const E2 = "actor:subs:e2";
const E3 = "actor:subs:e3";

// ---------------------------------------------------------------------------
// Minimal DB for ContextStore unit tests
// ---------------------------------------------------------------------------

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      source_endpoint_id TEXT,
      context_id TEXT,
      thread_id TEXT NOT NULL DEFAULT '',
      scope_id TEXT,
      correlation_id TEXT,
      destination_json TEXT NOT NULL DEFAULT '{"kind":"context","context_id":""}',
      content_json TEXT NOT NULL DEFAULT '{}',
      response_json TEXT NOT NULL DEFAULT '{"expected":false}',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      idempotency_key TEXT,
      created_at TEXT NOT NULL
    );
  `);
  applyContextSchema(db);
  return db;
}

describe("ContextStore — subscribeToContext / unsubscribeFromContext (Slice 2)", () => {
  let db: DatabaseSync;
  let store: ContextStore;

  beforeEach(() => {
    db = freshDb();
    store = new ContextStore(db);
  });

  it("subscribeToContext inserts a subscription row with default event_types=['*']", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E2] });
    store.subscribeToContext(ctx, E2);
    const subs = store.getContextSubscriptions(ctx);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ endpoint_id: E2, event_types: ["*"] });
  });

  it("subscribeToContext with specific event_types persists them", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E2] });
    store.subscribeToContext(ctx, E2, ["message", "task.done"]);
    const subs = store.getContextSubscriptions(ctx);
    expect(subs[0]).toMatchObject({ endpoint_id: E2, event_types: ["message", "task.done"] });
  });

  it("subscribeToContext is idempotent — replaces existing subscription", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E2] });
    store.subscribeToContext(ctx, E2, ["message"]);
    store.subscribeToContext(ctx, E2, ["task.done"]);
    const subs = store.getContextSubscriptions(ctx);
    expect(subs).toHaveLength(1);
    expect(subs[0]?.event_types).toEqual(["task.done"]);
  });

  it("subscribeToContext with empty event_types stores []", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    store.subscribeToContext(ctx, E1, []);
    const subs = store.getContextSubscriptions(ctx);
    expect(subs[0]?.event_types).toEqual([]);
  });

  it("unsubscribeFromContext removes the subscription row", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E2] });
    store.subscribeToContext(ctx, E2);
    store.unsubscribeFromContext(ctx, E2);
    expect(store.getContextSubscriptions(ctx)).toHaveLength(0);
  });

  it("unsubscribeFromContext is idempotent — no error when not subscribed", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    expect(() => store.unsubscribeFromContext(ctx, E3)).not.toThrow();
  });

  it("getContextSubscriptions returns all subscriptions for a context", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E2, E3] });
    store.subscribeToContext(ctx, E1, ["*"]);
    store.subscribeToContext(ctx, E2, ["message"]);
    store.subscribeToContext(ctx, E3, []);
    const subs = store.getContextSubscriptions(ctx);
    expect(subs).toHaveLength(3);
    const ids = subs.map((s) => s.endpoint_id).sort();
    expect(ids).toEqual([E1, E2, E3].sort());
  });

  it("subscriptions are scoped to their context — another context's subs not returned", () => {
    const ctxA = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    const ctxB = store.createContext({ workspace_id: WS, created_by_endpoint_id: E2, participants: [E2] });
    store.subscribeToContext(ctxA, E1);
    store.subscribeToContext(ctxB, E2);
    expect(store.getContextSubscriptions(ctxA).map((s) => s.endpoint_id)).toEqual([E1]);
    expect(store.getContextSubscriptions(ctxB).map((s) => s.endpoint_id)).toEqual([E2]);
  });
});

describe("ContextStore — isSubscribed (Slice 2)", () => {
  let db: DatabaseSync;
  let store: ContextStore;

  beforeEach(() => {
    db = freshDb();
    store = new ContextStore(db);
  });

  it("returns false when no subscription exists", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    expect(store.isSubscribed(ctx, E1, "message")).toBe(false);
  });

  it("returns true when subscribed to '*'", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    store.subscribeToContext(ctx, E1, ["*"]);
    expect(store.isSubscribed(ctx, E1, "message")).toBe(true);
    expect(store.isSubscribed(ctx, E1, "task.done")).toBe(true);
    expect(store.isSubscribed(ctx, E1, "anything.at.all")).toBe(true);
  });

  it("returns true when subscribed to the exact event type", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    store.subscribeToContext(ctx, E1, ["message"]);
    expect(store.isSubscribed(ctx, E1, "message")).toBe(true);
  });

  it("returns false when subscribed to different types", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    store.subscribeToContext(ctx, E1, ["task.done"]);
    expect(store.isSubscribed(ctx, E1, "message")).toBe(false);
  });

  it("returns false when subscribed to empty event_types []", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    store.subscribeToContext(ctx, E1, []);
    expect(store.isSubscribed(ctx, E1, "message")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BusStore integration — context-addressed delivery routing (single path)
// ---------------------------------------------------------------------------

const noop = () => {};

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

async function makeServer(): Promise<{ handle: ServerHandle; cleanup: () => Promise<void> }> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-ctx-routing-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg: LocalConfig = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const handle = await createBusServer(cfgPath, cfg, { unsafe_in_process_test_auth_bypass: true });
  await handle.app.ready();
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
  for (const id of [E1, E2, E3]) {
    handle.store.registerEndpoint(
      { endpoint_id: id, workspace_id: WS, name: id, bridge_id: null, status: "idle" },
      noop
    );
  }
  return {
    handle,
    cleanup: async () => {
      try { await handle.app.close(); } catch {}
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function emitCommand(
  overrides: Partial<EventCommand> & {
    source_endpoint_id: string;
    destination: EventCommand["destination"];
  }
): EventCommand {
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
    current_delivery_context_id: overrides.current_delivery_context_id,
  };
}

describe("BusStore — context-addressed delivery routing (Slice 2)", () => {
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

  it("delivers to all actors subscribed to '*' when emitting into a context", async () => {
    const ctx = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: E1,
      participants: [E1, E2, E3],
    });
    store.contextStore.subscribeToContext(ctx, E1, ["*"]);
    store.contextStore.subscribeToContext(ctx, E2, ["*"]);
    store.contextStore.subscribeToContext(ctx, E3, ["*"]);

    const result = await emitViaRoute(handle,
      emitCommand({
        type: "message",
        source_endpoint_id: E1,
        destination: { kind: "context", context_id: ctx },
        context_id: ctx,
      }),
    );

    const queued = store.db
      .prepare("SELECT destination_endpoint_id FROM event_queue WHERE event_id = ?")
      .all(result.event.event_id) as Array<{ destination_endpoint_id: string }>;
    const destinations = queued.map((r) => r.destination_endpoint_id).sort();
    expect(destinations).toEqual([E1, E2, E3].sort());
  });

  it("delivers only to actors subscribed to the specific event type", async () => {
    const ctx = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: E1,
      participants: [E1, E2, E3],
    });
    store.contextStore.subscribeToContext(ctx, E1, ["message"]);
    store.contextStore.subscribeToContext(ctx, E2, ["task.done"]); // different type
    store.contextStore.subscribeToContext(ctx, E3, ["message"]);

    const result = await emitViaRoute(handle,
      emitCommand({
        type: "message",
        source_endpoint_id: E1,
        destination: { kind: "context", context_id: ctx },
        context_id: ctx,
      }),
    );

    const queued = store.db
      .prepare("SELECT destination_endpoint_id FROM event_queue WHERE event_id = ?")
      .all(result.event.event_id) as Array<{ destination_endpoint_id: string }>;
    const destinations = queued.map((r) => r.destination_endpoint_id).sort();
    // E2 subscribed to task.done, not message — not woken
    expect(destinations).toEqual([E1, E3].sort());
    expect(destinations).not.toContain(E2);
  });

  it("delivers to zero actors when all subscriptions have empty event_types (silent watchers)", async () => {
    const ctx = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: E1,
      participants: [E1, E2],
    });
    store.contextStore.subscribeToContext(ctx, E1, []);
    store.contextStore.subscribeToContext(ctx, E2, []);

    const result = await emitViaRoute(handle,
      emitCommand({
        type: "message",
        source_endpoint_id: E1,
        destination: { kind: "context", context_id: ctx },
        context_id: ctx,
      }),
    );

    const queued = store.db
      .prepare("SELECT destination_endpoint_id FROM event_queue WHERE event_id = ?")
      .all(result.event.event_id) as Array<{ destination_endpoint_id: string }>;
    expect(queued).toHaveLength(0);
  });

  it("records the event with zero deliveries when no subscriptions exist in the context", async () => {
    const ctx = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: E1,
      participants: [E1, E2],
    });
    // No subscriptions — participants present but none subscribed

    const result = await emitViaRoute(handle,
      emitCommand({
        type: "message",
        source_endpoint_id: E1,
        destination: { kind: "context", context_id: ctx },
        context_id: ctx,
      }),
    );

    const queued = store.db
      .prepare("SELECT destination_endpoint_id FROM event_queue WHERE event_id = ?")
      .all(result.event.event_id) as Array<{ destination_endpoint_id: string }>;
    expect(queued).toHaveLength(0);
    // But the event IS in the context history
    const events = store.db
      .prepare("SELECT event_id FROM events WHERE context_id = ? AND event_id = ?")
      .get(ctx, result.event.event_id);
    expect(events).not.toBeUndefined();
  });

  it("appendContextEvent (internal history writes) is always record-only — never queues deliveries regardless of subscriptions", () => {
    const ctx = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: E1,
      participants: [E1, E2],
    });
    // Even with "*" subscriptions, appendContextEvent bypasses resolveDestinations
    // entirely: it writes directly to the events table and does NOT call queueEvent.
    // This is by construction, not by subscription state.
    store.contextStore.subscribeToContext(ctx, E1, ["*"]);
    store.contextStore.subscribeToContext(ctx, E2, ["*"]);

    const event = store.appendContextEvent(
      {
        type: "pulse.fired",
        workspace_id: WS,
        context_id: ctx,
        content: { text: "tick" },
        metadata: {},
      },
      noop
    );

    // Zero deliveries — appendContextEvent never routes, even with active subscriptions.
    // The event IS in the history (events table), but nobody is queued.
    const queued = store.db
      .prepare("SELECT destination_endpoint_id FROM event_queue WHERE event_id = ?")
      .all(event.event_id) as Array<{ destination_endpoint_id: string }>;
    expect(queued).toHaveLength(0);
    // Confirm the event IS in history
    const row = store.db
      .prepare("SELECT event_id FROM events WHERE event_id = ?")
      .get(event.event_id);
    expect(row).not.toBeUndefined();
  });

  it("appendContextEvent in a context with NO subscriptions also creates zero deliveries", () => {
    const ctx = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: E1,
      participants: [E1, E2],
    });
    const event = store.appendContextEvent(
      {
        type: "pulse.fired",
        workspace_id: WS,
        context_id: ctx,
        content: { text: "tick" },
        metadata: {},
      },
      noop
    );
    const queued = store.db
      .prepare("SELECT destination_endpoint_id FROM event_queue WHERE event_id = ?")
      .all(event.event_id) as Array<{ destination_endpoint_id: string }>;
    expect(queued).toHaveLength(0);
  });

  it("an actor subscribed to nothing is a silent watcher — emitting into the context does not wake it", async () => {
    const ctx = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: E1,
      participants: [E1, E2, E3],
    });
    // Only E1 subscribed; E2 and E3 are silent participants
    store.contextStore.subscribeToContext(ctx, E1, ["*"]);

    const result = await emitViaRoute(handle,
      emitCommand({
        type: "message",
        source_endpoint_id: E1,
        destination: { kind: "context", context_id: ctx },
        context_id: ctx,
      }),
    );

    const queued = store.db
      .prepare("SELECT destination_endpoint_id FROM event_queue WHERE event_id = ?")
      .all(result.event.event_id) as Array<{ destination_endpoint_id: string }>;
    expect(queued.map((r) => r.destination_endpoint_id)).toEqual([E1]);
  });
});
