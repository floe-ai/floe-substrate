import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { defaultConfig } from "./config.js";
import { createBusServer } from "./server.js";
import { EndpointRetirementBlockedError, type BusStore, type EventCommand } from "./store.js";
import { emitViaRoute } from "./test-support/emit-via-route.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

const WS = "workspace:retirement";
const ACTOR = "actor:workspace:retirement:controller";
const OPERATOR = "actor:workspace:retirement:operator";
const noop = () => {};

describe("Endpoint retirement", () => {
  let root: string;
  let handle: ServerHandle;
  let store: BusStore;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "floe-endpoint-retirement-"));
    const configPath = join(root, "config.yaml");
    const config = defaultConfig(root);
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    handle = await createBusServer(configPath, config, { unsafe_in_process_test_auth_bypass: true });
    await handle.app.ready();
    store = handle.store;
    store.registerEndpoint({
      endpoint_id: ACTOR,
      workspace_id: WS,
      name: "Controller",
      agent_id: "controller",
      bridge_id: "bridge:test",
      status: "idle",
    }, noop);
    store.registerEndpoint({
      endpoint_id: OPERATOR,
      workspace_id: WS,
      name: "Operator",
      bridge_id: null,
      status: "idle",
    }, noop);
  });

  afterEach(async () => {
    try { await handle.app.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  it("makes an idle Endpoint inert while preserving its historical identity and participation", async () => {
    const contextId = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: OPERATOR,
      participants: [OPERATOR, ACTOR],
    });
    store.contextStore.subscribeToContext(contextId, ACTOR, ["work.requested"]);

    expect(store.retireEndpoint(ACTOR, noop)).toEqual({
      ok: true,
      endpoint_id: ACTOR,
      status: "retired",
    });

    expect(store.getEndpoint(ACTOR)).toMatchObject({
      endpoint_id: ACTOR,
      status: "retired",
      bridge_id: null,
    });
    expect(store.contextStore.getContextParticipants(contextId)).toContain(ACTOR);
    expect(store.contextStore.getContextSubscriptions(contextId)).toEqual([]);

    const command: EventCommand = {
      type: "message",
      workspace_id: WS,
      source_endpoint_id: OPERATOR,
      destination: { kind: "endpoint", endpoint_id: ACTOR },
      content: { text: "Are you still there?" },
      response: { expected: false },
    };
    const submitted = await emitViaRoute(handle, command);
    expect(submitted.body.deliveries_created).toBe(0);
    expect(store.getEndpoint(ACTOR)).toMatchObject({ status: "retired" });
  });

  it("refuses retirement while an Endpoint is active", () => {
    store.updateEndpointStatus(ACTOR, "active", noop);

    expect(() => store.retireEndpoint(ACTOR, noop)).toThrow(EndpointRetirementBlockedError);
    expect(store.getEndpoint(ACTOR)).toMatchObject({ status: "active" });
  });
});
