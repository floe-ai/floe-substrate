import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import type { BusStore, EventCommand } from "./store.js";
import { defaultConfig } from "./config.js";
import { encodeEventCursor, InvalidEventCursorError } from "./event-cursor.js";
import { emitViaRoute } from "./test-support/emit-via-route.js";

const noop = () => {};
const WS = "workspace:test-wm";
const E1 = "actor:test:e1";
const E2 = "actor:test:e2";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

async function makeServer(): Promise<{ handle: ServerHandle; store: BusStore; tmp: string; cleanup: () => Promise<void> }> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-wm-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const handle = await createBusServer(cfgPath, cfg, { unsafe_in_process_test_auth_bypass: true });
  await handle.app.ready();
  const store = handle.store;
  for (const id of [E1, E2]) {
    store.registerEndpoint({ endpoint_id: id, workspace_id: WS, name: id, bridge_id: null, status: "idle" }, noop);
  }
  return {
    handle,
    store,
    tmp,
    cleanup: async () => { try { await handle.app.close(); } catch {} rmSync(tmp, { recursive: true, force: true }); }
  };
}

function emit(handle: ServerHandle) {
  const command: EventCommand = {
    type: "message",
    workspace_id: WS,
    source_endpoint_id: E1,
    destination: { kind: "endpoint", endpoint_id: E2 },
    thread_id: "",
    correlation_id: null,
    content: { text: "hi" },
    response: undefined,
    metadata: {},
    idempotency_key: null,
    context_id: undefined,
    current_delivery_context_id: undefined
  };
  return emitViaRoute(handle, command);
}

describe("listEvents since (Event Cursor)", () => {
  let handle: ServerHandle;
  let store: BusStore;
  let cleanup: () => Promise<void>;

  beforeEach(async () => { const m = await makeServer(); handle = m.handle; store = m.store; cleanup = m.cleanup; });
  afterEach(async () => { await cleanup(); });

  it("returns only events after the since cursor, in ascending order", async () => {
    const a = (await emit(handle)).event;
    const b = (await emit(handle)).event;
    const c = (await emit(handle)).event;
    const cursor = encodeEventCursor({ created_at: a.created_at, event_id: a.event_id });
    const since = store.listEvents({ workspace_id: WS, since: cursor });
    expect(since.map((e) => e.event_id)).toEqual([b.event_id, c.event_id]);
  });

  it("returns no events when the cursor is at the latest event", async () => {
    await emit(handle);
    const last = (await emit(handle)).event;
    const cursor = encodeEventCursor({ created_at: last.created_at, event_id: last.event_id });
    expect(store.listEvents({ workspace_id: WS, since: cursor })).toEqual([]);
  });

  it("throws InvalidEventCursorError for a malformed since cursor", () => {
    expect(() => store.listEvents({ workspace_id: WS, since: "garbage" })).toThrow(InvalidEventCursorError);
  });
});

describe("listEvents since — same-instant tie-break", () => {
  let store: BusStore;
  let tmp: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => { const m = await makeServer(); store = m.store; tmp = m.tmp; cleanup = m.cleanup; });
  afterEach(async () => { await cleanup(); });

  it("does not skip or repeat events that share a created_at", () => {
    // Two events with an identical created_at, inserted via a sidecar connection
    // so the timestamp collision is deterministic. event_id orders them.
    const sameTs = "2026-06-14T00:00:00.000Z";
    const sidecar = new DatabaseSync(join(tmp, "bus", "floe-bus.sqlite"));
    const insert = (eventId: string) => sidecar.prepare(
      `INSERT INTO events (event_id, type, workspace_id, destination_endpoint_id, thread_id,
         destination_json, content_json, response_json, metadata_json, created_at)
       VALUES (?, 'message', ?, '', '', '{}', '{}', '{}', '{}', ?)`
    ).run(eventId, WS, sameTs);
    insert("evt_aaa");
    insert("evt_bbb");
    sidecar.close();

    // Cursor at the first of the pair must still return the second.
    const afterFirst = store.listEvents({
      workspace_id: WS,
      since: encodeEventCursor({ created_at: sameTs, event_id: "evt_aaa" })
    });
    expect(afterFirst.map((e) => e.event_id)).toEqual(["evt_bbb"]);

    // Cursor at the second returns neither (no repeat).
    const afterSecond = store.listEvents({
      workspace_id: WS,
      since: encodeEventCursor({ created_at: sameTs, event_id: "evt_bbb" })
    });
    expect(afterSecond).toEqual([]);

    const latest = store.listEvents({
      workspace_id: WS,
      direction: "backward",
      limit: 1
    });
    expect(latest.map((e) => e.event_id)).toEqual(["evt_bbb"]);

    const beforeSecond = store.listEvents({
      workspace_id: WS,
      direction: "backward",
      before: encodeEventCursor({ created_at: sameTs, event_id: "evt_bbb" }),
      limit: 1
    });
    expect(beforeSecond.map((e) => e.event_id)).toEqual(["evt_aaa"]);
  });
});

describe("Endpoint Watermark", () => {
  let handle: ServerHandle;
  let store: BusStore;
  let cleanup: () => Promise<void>;

  beforeEach(async () => { const m = await makeServer(); handle = m.handle; store = m.store; cleanup = m.cleanup; });
  afterEach(async () => { await cleanup(); });

  it("is null before it is ever set", () => {
    expect(store.getEndpointWatermark(WS, E1)).toBeNull();
  });

  it("round-trips the cursor through set then get", async () => {
    const ev = (await emit(handle)).event;
    const cursor = encodeEventCursor({ created_at: ev.created_at, event_id: ev.event_id });
    const set = store.setEndpointWatermark(WS, E1, cursor);
    expect(set.cursor).toBe(cursor);
    expect(store.getEndpointWatermark(WS, E1)?.cursor).toBe(cursor);
  });

  it("advances on a second set", async () => {
    const a = (await emit(handle)).event;
    const b = (await emit(handle)).event;
    store.setEndpointWatermark(WS, E1, encodeEventCursor({ created_at: a.created_at, event_id: a.event_id }));
    const bCursor = encodeEventCursor({ created_at: b.created_at, event_id: b.event_id });
    store.setEndpointWatermark(WS, E1, bCursor);
    expect(store.getEndpointWatermark(WS, E1)?.cursor).toBe(bCursor);
    // Events since the advanced watermark is empty; before it would have returned b.
    expect(store.listEvents({ workspace_id: WS, since: bCursor })).toEqual([]);
  });

  it("is isolated per endpoint", async () => {
    const ev = (await emit(handle)).event;
    const cursor = encodeEventCursor({ created_at: ev.created_at, event_id: ev.event_id });
    store.setEndpointWatermark(WS, E1, cursor);
    expect(store.getEndpointWatermark(WS, E2)).toBeNull();
  });

  it("rejects a malformed cursor", () => {
    expect(() => store.setEndpointWatermark(WS, E1, "garbage")).toThrow(InvalidEventCursorError);
  });
});
