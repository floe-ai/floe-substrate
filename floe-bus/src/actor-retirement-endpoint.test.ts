import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusStore } from "./store.js";
import { defaultConfig } from "./config.js";
import { registerExecutableActorFixture } from "./executable-actor-test-fixture.js";

const WS = "workspace:retirement";
const ACTOR = `actor:${WS}:animator`;
const BRIDGE = "bridge:retirement";

describe("a retired Actor's Endpoint", () => {
  let tmp: string;
  let store: BusStore;
  const pushes: Array<{ type: string; payload: any }> = [];

  const open = () => new BusStore(join(tmp, "config.yaml"), defaultConfig(tmp));
  const status = () => String(store.getEndpoint(ACTOR).status);
  const head = () => store.actorDefinitionStore.getActor(ACTOR)!.current_definition_revision_id;
  const setStatus = (value: "active" | "retired") => store.actorDefinitionStore.setActorStatus({
    actor_id: ACTOR, status: value, expected_current_definition_revision_id: head(),
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "floe-actor-retirement-"));
    store = open();
    store.setBroadcast((type, payload) => pushes.push({ type, payload }));
    store.registerEndpoint({ endpoint_id: ACTOR, workspace_id: WS, name: "HTML5 Animator", bridge_id: BRIDGE, status: "idle" }, () => {});
    registerExecutableActorFixture(store, WS, ACTOR);
    pushes.length = 0;
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("is listed as retired, pushed, and stays retired when its Bridge or a turn reports it idle", () => {
    expect(status()).toBe("idle");
    setStatus("retired");
    expect(status()).toBe("retired");
    expect(pushes).toContainEqual({ type: "status_changed", payload: { endpoint: expect.objectContaining({ endpoint_id: ACTOR, status: "retired" }) } });

    store.registerEndpoint({ endpoint_id: ACTOR, workspace_id: WS, name: "HTML5 Animator", bridge_id: BRIDGE, status: "idle" }, () => {});
    expect(status()).toBe("retired");
    store.updateEndpointStatus(ACTOR, "idle", () => {});
    expect(status()).toBe("retired");
    expect((store.listEndpoints(WS) as Array<{ endpoint_id: string; status: string }>)
      .find((endpoint) => endpoint.endpoint_id === ACTOR)!.status).toBe("retired");
  });

  it("returns to its real readiness when the Actor is reactivated", () => {
    setStatus("retired");
    setStatus("active");
    expect(status()).toBe("idle");
  });

  it("is corrected when the Bus opens if it was left listed as available", () => {
    setStatus("retired");
    store.db.prepare("UPDATE endpoints SET status = 'idle' WHERE endpoint_id = ?").run(ACTOR);
    store.close();
    store = open();
    expect(status()).toBe("retired");
  });
});
