/**
 * D5 — Lease-expiry requeue must NOT poll.
 *
 * Validates that the bus-internal lease-expiry timer fires on schedule (a
 * single-shot timer at the next lease-expiry deadline, not a recurring scan)
 * and correctly requeues expired deliveries without any explicit poll trigger.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { BusStore, type EventCommand } from "./store.js";
import { defaultConfig } from "./config.js";

const WS = "workspace:lease-test";
const EP = "actor:lease:agent";
const BRIDGE = "bridge:lease:b1";

function makeStore(): { store: BusStore; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-lease-test-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const store = new BusStore(cfgPath, cfg);
  const timestamp = new Date().toISOString();
  store.workspaceIdentityStore.restoreWorkspace({
    snapshot: {
      workspace_id: WS,
      name: "Lease test",
      creation_kind: "created",
      source_workspace_id: null,
      created_at: timestamp,
      updated_at: timestamp,
    },
    binding: {
      host_id: store.localHostId,
      platform: store.localWorkspacePlatform,
      locator: join(tmp, "workspace"),
      init_authorized: true,
    },
  });
  return {
    store,
    cleanup: () => {
      try { store.close(); } catch {}
      rmSync(tmp, { recursive: true, force: true });
    }
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("D5 — lease-expiry requeue via scheduled single-shot timer (no recurring poll)", () => {
  it("renews an active runtime lease from pushed telemetry and never replays it after ownership is lost", () => {
    vi.useFakeTimers();

    const { store, cleanup } = makeStore();
    const broadcasts: Array<{ type: string; payload: any }> = [];
    const broadcast = (type: string, payload: any = {}) => broadcasts.push({ type, payload });

    try {
      store.setBroadcast(broadcast);
      store.registerEndpoint({ endpoint_id: EP, workspace_id: WS, name: "Agent", bridge_id: BRIDGE, status: "idle" }, broadcast);
      store.submitEvent({
        type: "message",
        workspace_id: WS,
        source_endpoint_id: "actor:lease:operator",
        thread_id: "thread:lease:runtime",
        destination: { kind: "endpoint", endpoint_id: EP },
        content: { text: "take the time you need" },
        response: { expected: true }
      }, broadcast);

      const delivery = store.claimDeliveries(BRIDGE, 1, broadcast)[0]!;
      store.reportDeliveryStatus({
        bridge_id: BRIDGE,
        delivery_id: delivery.delivery_id,
        state: "injected_to_runtime"
      }, broadcast);

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
      cleanup();
    }
  });

  it("settles an injected turn on bridge restart and ignores a late acknowledgement", () => {
    const { store, cleanup } = makeStore();
    const broadcasts: Array<{ type: string; payload: any }> = [];
    const broadcast = (type: string, payload: any = {}) => broadcasts.push({ type, payload });

    try {
      store.setBroadcast(broadcast);
      store.registerEndpoint({ endpoint_id: EP, workspace_id: WS, name: "Agent", bridge_id: BRIDGE, status: "idle" }, broadcast);
      store.submitEvent({
        type: "message",
        workspace_id: WS,
        source_endpoint_id: "actor:lease:operator",
        thread_id: "thread:lease:restart",
        destination: { kind: "endpoint", endpoint_id: EP },
        content: { text: "make an effect" },
        response: { expected: true }
      }, broadcast);
      const delivery = store.claimDeliveries(BRIDGE, 1, broadcast)[0]!;
      store.reportDeliveryStatus({
        bridge_id: BRIDGE,
        delivery_id: delivery.delivery_id,
        state: "injected_to_runtime"
      }, broadcast);

      store.registerBridge({ bridge_id: BRIDGE }, broadcast);
      expect((store.listDeliveries({ workspace_id: WS }) as any[])[0]?.state).toBe("dead_lettered");
      expect(store.getEndpoint(EP)?.status).toBe("error");

      store.reportDeliveryStatus({
        bridge_id: BRIDGE,
        delivery_id: delivery.delivery_id,
        state: "acknowledged"
      }, broadcast);
      expect((store.listDeliveries({ workspace_id: WS }) as any[])[0]?.state).toBe("dead_lettered");
      expect(broadcasts.filter(item => item.type === "delivery_bundle_available")).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("requeues an expired delivery via the scheduled timer without any claimDeliveries call", async () => {
    vi.useFakeTimers();

    const { store, cleanup } = makeStore();
    const broadcasts: Array<{ type: string; payload: any }> = [];
    const broadcast = (type: string, payload: any = {}) => broadcasts.push({ type, payload });

    try {
      // Inject broadcast so the store can self-schedule (D5).
      store.setBroadcast(broadcast);

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

      // Submitting an event creates a delivery bundle; the store schedules a
      // single-shot timer at the bundle's lease_expires_at (30 s from now).
      store.submitEvent(eventCmd, broadcast);

      // Verify a bundle was created (delivery_bundle_available broadcast).
      const bundleAvailable = broadcasts.find(b => b.type === "delivery_bundle_available");
      expect(bundleAvailable).toBeDefined();
      const bundle = bundleAvailable!.payload.delivery;
      expect(bundle.endpoint_id).toBe(EP);

      // Advance time past the lease expiry (30 000ms + a little) without
      // calling claimDeliveries. The scheduled timer should fire and requeue.
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
      cleanup();
    }
  });

  it("does not schedule a recurring setInterval — the timer is a one-shot per deadline", async () => {
    vi.useFakeTimers();

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    const { store, cleanup } = makeStore();
    const broadcast = (type: string, payload: any = {}) => {};

    try {
      store.setBroadcast(broadcast);

      store.registerEndpoint({ endpoint_id: EP, workspace_id: WS, name: "Agent", bridge_id: BRIDGE, status: "idle" }, broadcast);

      const eventCmd: EventCommand = {
        type: "message",
        workspace_id: WS,
        source_endpoint_id: "actor:lease:operator",
        thread_id: "thread:lease:2",
        destination: { kind: "endpoint", endpoint_id: EP },
        content: { text: "hello" },
        response: { expected: false }
      };

      store.submitEvent(eventCmd, broadcast);

      // setInterval must NOT have been called for lease tracking.
      // (There may be setTimeouts from other things, but NO setInterval for leases.)
      const intervalCallsForLeases = setIntervalSpy.mock.calls.filter(
        ([, ms]) => ms === 30_000 || ms === 31_000
      );
      expect(intervalCallsForLeases).toHaveLength(0);

      // setTimeout SHOULD have been called at least once (for the lease timer).
      expect(setTimeoutSpy).toHaveBeenCalled();
    } finally {
      cleanup();
      setTimeoutSpy.mockRestore();
      setIntervalSpy.mockRestore();
    }
  });

  it("schedules a NEW one-shot timer after processing expired leases", async () => {
    vi.useFakeTimers();

    const { store, cleanup } = makeStore();
    const broadcasts: Array<{ type: string; payload: any }> = [];
    const broadcast = (type: string, payload: any = {}) => broadcasts.push({ type, payload });

    try {
      store.setBroadcast(broadcast);

      store.registerEndpoint({ endpoint_id: EP, workspace_id: WS, name: "Agent", bridge_id: BRIDGE, status: "idle" }, broadcast);

      // Create first bundle
      store.submitEvent({
        type: "message",
        workspace_id: WS,
        source_endpoint_id: "actor:lease:operator",
        thread_id: "thread:lease:3",
        destination: { kind: "endpoint", endpoint_id: EP },
        content: { text: "first" },
        response: { expected: false }
      }, broadcast);

      // Advance past first lease expiry → timer fires, requeues, creates new bundle,
      // and schedules a NEW one-shot timer for the new bundle's lease.
      broadcasts.length = 0;
      vi.advanceTimersByTime(31_000);

      // First bundle expired and was requeued → new bundle created
      expect(broadcasts.find(b => b.type === "delivery_bundle_available")).toBeDefined();

      // Advance past the second lease — the rescheduled timer should fire too
      broadcasts.length = 0;
      vi.advanceTimersByTime(31_000);

      expect(broadcasts.find(b => b.type === "delivery_failed")).toBeDefined();
    } finally {
      cleanup();
    }
  });
});
