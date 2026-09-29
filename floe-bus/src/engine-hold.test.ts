import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { defaultConfig } from "./config.js";
import { createBusServer } from "./server.js";
import { emitViaRoute } from "./test-support/emit-via-route.js";

/**
 * Work held because the Actor's engine is not ready (the Bridge reports it
 * deferred before the turn starts) waits durably, never spends a retry, and is
 * delivered once the engine is ready — including after the Bus restarts.
 */
const noop = () => {};
const WS = "workspace:engine-hold";
const ACTOR = "actor:engine-hold:worker";
const OPERATOR = "actor:engine-hold:operator";
const BRIDGE = "bridge:local";
const REASON = "engine_not_ready: Sign in to GitHub Copilot to run this work.";

describe("work held for an engine that is not ready", () => {
  it("survives any number of holds and a Bus restart, and is delivered when the Actor is released", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "floe-bus-engine-hold-"));
    const cfgPath = join(tmp, "config.yaml");
    const cfg = defaultConfig(tmp);
    writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
    const open = async () => {
      const handle = await createBusServer(cfgPath, cfg, { unsafe_in_process_test_auth_bypass: true });
      await handle.app.ready();
      return handle;
    };
    const register = (store: any, status: string) => store.registerEndpoint({
      endpoint_id: ACTOR, workspace_id: WS, name: "Worker", bridge_id: BRIDGE, status,
    }, noop);
    const queued = (store: any) => store.db.prepare(
      "SELECT state, attempt_count FROM event_queue WHERE destination_endpoint_id = ?",
    ).all(ACTOR) as Array<{ state: string; attempt_count: number }>;

    let handle = await open();
    try {
      register(handle.store, "idle");
      await emitViaRoute(handle, {
        type: "message", workspace_id: WS, source_endpoint_id: OPERATOR,
        destination: { kind: "endpoint", endpoint_id: ACTOR },
        content: { body: "first" }, response: { expected: false },
      });

      // More holds than the dead-letter threshold (3).
      for (let hold = 0; hold < 5; hold++) {
        const [delivery] = handle.store.claimDeliveries(BRIDGE, 10, noop) as any[];
        expect(delivery, `delivery on hold ${hold}`).toBeTruthy();
        handle.store.reportDeliveryStatus({ bridge_id: BRIDGE, delivery_id: delivery.delivery_id, state: "deferred", error: REASON }, noop);
        expect(queued(handle.store)).toEqual([{ state: "queued", attempt_count: 0 }]);
        expect((handle.store.getEndpoint(ACTOR) as any).status).toBe("runtime_unconfigured");
        register(handle.store, "idle");
      }
      const [held] = handle.store.claimDeliveries(BRIDGE, 10, noop) as any[];
      handle.store.reportDeliveryStatus({ bridge_id: BRIDGE, delivery_id: held.delivery_id, state: "deferred", error: REASON }, noop);

      // A message sent meanwhile is told why it waits, not about auth profiles.
      await emitViaRoute(handle, {
        type: "message", workspace_id: WS, source_endpoint_id: OPERATOR,
        destination: { kind: "endpoint", endpoint_id: ACTOR },
        content: { body: "second" }, response: { expected: false },
      });
      const signal = (handle.store.listRuntimeTelemetry({ workspace_id: WS }) as any[])
        .filter((row) => row.kind === "runtime_unconfigured").at(-1);
      const payload = typeof signal.payload_json === "string" ? JSON.parse(signal.payload_json) : signal.payload;
      expect(payload.message).toContain("waiting");
      expect(payload.message).toContain(REASON);
      expect(handle.store.claimDeliveries(BRIDGE, 10, noop)).toEqual([]);
    } finally {
      await handle.app.close();
    }

    handle = await open();
    try {
      expect(queued(handle.store).map((row) => row.state)).toEqual(["queued", "queued"]);
      // The Bridge re-registers the Actor once its engine is ready.
      register(handle.store, "idle");
      const delivered: string[] = [];
      for (let turn = 0; turn < 2; turn++) {
        const [delivery] = handle.store.claimDeliveries(BRIDGE, 10, noop) as any[];
        delivered.push(...delivery.events.map((event: any) => event.content.body));
        handle.store.reportDeliveryStatus({ bridge_id: BRIDGE, delivery_id: delivery.delivery_id, state: "acknowledged" }, noop);
        handle.store.reportTurnEnd(ACTOR, noop);
      }
      expect(delivered).toEqual(["first", "second"]);
    } finally {
      await handle.app.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
