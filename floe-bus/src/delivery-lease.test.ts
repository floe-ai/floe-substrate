/**
 * D5 — Lease-expiry requeue must NOT poll.
 *
 * Validates that the bus-internal lease-expiry timer fires on schedule (a
 * single-shot timer at the next lease-expiry deadline, not a recurring scan)
 * and correctly requeues expired deliveries without any explicit poll trigger.
 *
 * Events are created through the real emit route (submitEvent is capability-
 * gated). The initial delivery bundle is observed through delivery STATE
 * (listDeliveries); the lease timer's own broadcasts are observed through the
 * store broadcast the test injects with setBroadcast, which is the exact
 * channel the timer callback uses.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import type { BusStore, EventCommand } from "./store.js";
import { defaultConfig } from "./config.js";
import { createBusServer } from "./server.js";
import { emitViaRoute } from "./test-support/emit-via-route.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

const WS = "workspace:lease-test";
const EP = "actor:lease:agent";
const BRIDGE = "bridge:lease:b1";

async function makeServer(): Promise<{ handle: ServerHandle; store: BusStore; cleanup: () => Promise<void> }> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-lease-test-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const handle = await createBusServer(cfgPath, cfg, { unsafe_in_process_test_auth_bypass: true });
  await handle.app.ready();
  const timestamp = new Date().toISOString();
  handle.store.workspaceIdentityStore.restoreWorkspace({
    snapshot: {
      workspace_id: WS,
      name: "Lease test",
      creation_kind: "created",
      source_workspace_id: null,
      created_at: timestamp,
      updated_at: timestamp,
    },
    binding: {
      host_id: handle.store.localHostId,
      platform: handle.store.localWorkspacePlatform,
      locator: join(tmp, "workspace"),
      init_authorized: true,
    },
  });
  return {
    handle,
    store: handle.store,
    cleanup: async () => {
      vi.useRealTimers();
      try { await handle.app.close(); } catch {}
      rmSync(tmp, { recursive: true, force: true });
    }
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("D5 — lease-expiry requeue via scheduled single-shot timer (no recurring poll)", () => {
  it("renews an active runtime lease from pushed telemetry and never replays it after ownership is lost", async () => {
    const { handle, store, cleanup } = await makeServer();
    const broadcasts: Array<{ type: string; payload: any }> = [];
    const broadcast = (type: string, payload: any = {}) => broadcasts.push({ type, payload });

    try {
      // Setup runs under REAL timers so the real emit route (an HTTP round trip)
      // resolves. The lease timer is then armed on the fake clock via
      // setBroadcast, which is the exact call the store uses to (re)schedule.
      store.registerEndpoint({ endpoint_id: EP, workspace_id: WS, name: "Agent", bridge_id: BRIDGE, status: "idle" }, broadcast);
      await emitViaRoute(handle, {
        type: "message",
        workspace_id: WS,
        source_endpoint_id: "actor:lease:operator",
        thread_id: "thread:lease:runtime",
        destination: { kind: "endpoint", endpoint_id: EP },
        content: { text: "take the time you need" },
        response: { expected: true }
      });

      const delivery = store.claimDeliveries(BRIDGE, 1, broadcast)[0]!;
      store.reportDeliveryStatus({
        bridge_id: BRIDGE,
        delivery_id: delivery.delivery_id,
        state: "injected_to_runtime"
      }, broadcast);

      vi.useFakeTimers();
      store.setBroadcast(broadcast);

      vi.advanceTimersByTime(14 * 60_000);
      store.appendRuntimeTelemetry({
        workspace_id: WS,
        endpoint_id: EP,
        delivery_id: delivery.delivery_id,
        kind: "turn_progress",
        payload: { text: "still working" }
      }, broadcast);

      broadcasts.length = 0;
      vi.advanceTimersByTime(2 * 60_000);
      expect(broadcasts.find(b => b.type === "delivery_dead_lettered")).toBeUndefined();
      expect((store.listDeliveries({ workspace_id: WS }) as any[])[0]?.state).toBe("injected_to_runtime");

      vi.advanceTimersByTime(14 * 60_000);
      expect(broadcasts.find(b => b.type === "delivery_dead_lettered")?.payload.delivery_id).toBe(delivery.delivery_id);
      expect((store.listDeliveries({ workspace_id: WS }) as any[])[0]?.state).toBe("dead_lettered");
      expect(broadcasts.find(b => b.type === "delivery_bundle_available")).toBeUndefined();
      const events = store.listEvents({ context_id: delivery.events[0]!.context_id ?? undefined, limit: 20 });
      expect(events.some(event =>
        event.metadata.origin === "runtime_turn_result" &&
        event.metadata.outcome_unknown === true &&
        event.metadata.safe_to_retry_automatically === false
      )).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("settles an injected turn on bridge restart and ignores a late acknowledgement", async () => {
    const { handle, store, cleanup } = await makeServer();
    const broadcasts: Array<{ type: string; payload: any }> = [];
    const broadcast = (type: string, payload: any = {}) => broadcasts.push({ type, payload });

    try {
      store.setBroadcast(broadcast);
      store.registerEndpoint({ endpoint_id: EP, workspace_id: WS, name: "Agent", bridge_id: BRIDGE, status: "idle" }, broadcast);
      await emitViaRoute(handle, {
        type: "message",
        workspace_id: WS,
        source_endpoint_id: "actor:lease:operator",
        thread_id: "thread:lease:restart",
        destination: { kind: "endpoint", endpoint_id: EP },
        content: { text: "make an effect" },
        response: { expected: true }
      });
      const delivery = store.claimDeliveries(BRIDGE, 1, broadcast)[0]!;
      store.reportDeliveryStatus({
        bridge_id: BRIDGE,
        delivery_id: delivery.delivery_id,
        state: "injected_to_runtime"
      }, broadcast);

      // From here on, only a REPLAY (a new bundle) should be observable. Reset
      // so the late-acknowledgement assertion measures replays, not the setup.
      broadcasts.length = 0;
      store.registerBridge({ bridge_id: BRIDGE }, broadcast);
      expect((store.listDeliveries({ workspace_id: WS }) as any[])[0]?.state).toBe("dead_lettered");
      expect(store.getEndpoint(EP)?.status).toBe("error");

      store.reportDeliveryStatus({
        bridge_id: BRIDGE,
        delivery_id: delivery.delivery_id,
        state: "acknowledged"
      }, broadcast);
      expect((store.listDeliveries({ workspace_id: WS }) as any[])[0]?.state).toBe("dead_lettered");
      expect(broadcasts.filter(item => item.type === "delivery_bundle_available")).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("requeues an expired delivery via the scheduled timer without any claimDeliveries call", async () => {
    const { handle, store, cleanup } = await makeServer();
    const broadcasts: Array<{ type: string; payload: any }> = [];
    const broadcast = (type: string, payload: any = {}) => broadcasts.push({ type, payload });

    try {
      store.registerEndpoint({ endpoint_id: EP, workspace_id: WS, name: "Agent", bridge_id: BRIDGE, status: "idle" }, broadcast);

      const eventCmd: EventCommand = {
        type: "message",
        workspace_id: WS,
        source_endpoint_id: "actor:lease:operator",
        thread_id: "thread:lease:1",
        destination: { kind: "endpoint", endpoint_id: EP },
        content: { text: "hello" },
        response: { expected: false }
      };

      // Emit under REAL timers (the route is a real HTTP round trip); this
      // creates a delivery bundle with a 30 s lease.
      await emitViaRoute(handle, eventCmd);

      // Observe the created bundle through delivery STATE, not the initial
      // broadcast (that synchronous broadcast belongs to the route, not the
      // store timer channel this test injects).
      const created = (store.listDeliveries({ workspace_id: WS }) as any[])[0];
      expect(created).toBeDefined();
      expect(created.endpoint_id).toBe(EP);
      const bundle = { delivery_id: created.delivery_id };

      // Arm the lease timer on the fake clock via setBroadcast, then advance
      // past the 30 s lease without calling claimDeliveries. The single-shot
      // timer should fire and requeue.
      vi.useFakeTimers();
      store.setBroadcast(broadcast);
      broadcasts.length = 0; // reset for clean assertion
      vi.advanceTimersByTime(31_000);

      // The timer callback should have run requeueExpiredDeliveryLeases.
      // It broadcasts "delivery_failed" (attempt 1 < 3) and then
      // tryCreateDeliveryForEndpoint → "delivery_bundle_available" again.
      const failedBroadcast = broadcasts.find(b => b.type === "delivery_failed");
      expect(failedBroadcast).toBeDefined();
      expect(failedBroadcast?.payload.delivery_id).toBe(bundle.delivery_id);

      // The endpoint should get a new delivery after requeue.
      const newBundle = broadcasts.find(b => b.type === "delivery_bundle_available");
      expect(newBundle).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it("does not schedule a recurring setInterval — the timer is a one-shot per deadline", async () => {
    const { handle, store, cleanup } = await makeServer();
    const broadcast = (type: string, payload: any = {}) => {};

    try {
      store.registerEndpoint({ endpoint_id: EP, workspace_id: WS, name: "Agent", bridge_id: BRIDGE, status: "idle" }, broadcast);

      await emitViaRoute(handle, {
        type: "message",
        workspace_id: WS,
        source_endpoint_id: "actor:lease:operator",
        thread_id: "thread:lease:2",
        destination: { kind: "endpoint", endpoint_id: EP },
        content: { text: "hello" },
        response: { expected: false }
      });

      // Arm the lease timer under fake timers with spies active so we can prove
      // the scheduling used setTimeout (one-shot) and never setInterval.
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      store.setBroadcast(broadcast);

      // setInterval must NOT have been called for lease tracking.
      const intervalCallsForLeases = setIntervalSpy.mock.calls.filter(
        ([, ms]) => ms === 30_000 || ms === 31_000
      );
      expect(intervalCallsForLeases).toHaveLength(0);

      // setTimeout SHOULD have been called (for the lease timer).
      expect(setTimeoutSpy).toHaveBeenCalled();
      setTimeoutSpy.mockRestore();
      setIntervalSpy.mockRestore();
    } finally {
      await cleanup();
    }
  });

  it("schedules a NEW one-shot timer after processing expired leases", async () => {
    const { handle, store, cleanup } = await makeServer();
    const broadcasts: Array<{ type: string; payload: any }> = [];
    const broadcast = (type: string, payload: any = {}) => broadcasts.push({ type, payload });

    try {
      store.registerEndpoint({ endpoint_id: EP, workspace_id: WS, name: "Agent", bridge_id: BRIDGE, status: "idle" }, broadcast);

      // Create first bundle under real timers (real emit route).
      await emitViaRoute(handle, {
        type: "message",
        workspace_id: WS,
        source_endpoint_id: "actor:lease:operator",
        thread_id: "thread:lease:3",
        destination: { kind: "endpoint", endpoint_id: EP },
        content: { text: "first" },
        response: { expected: false }
      });

      // Arm the lease timer on the fake clock, then advance past the first lease
      // expiry → timer fires, requeues, creates a new bundle, and schedules a
      // NEW one-shot timer for the new bundle's lease.
      vi.useFakeTimers();
      store.setBroadcast(broadcast);
      broadcasts.length = 0;
      vi.advanceTimersByTime(31_000);

      // First bundle expired and was requeued → new bundle created
      expect(broadcasts.find(b => b.type === "delivery_bundle_available")).toBeDefined();

      // Advance past the second lease — the rescheduled timer should fire too
      broadcasts.length = 0;
      vi.advanceTimersByTime(31_000);

      expect(broadcasts.find(b => b.type === "delivery_failed")).toBeDefined();
    } finally {
      await cleanup();
    }
  });
});
