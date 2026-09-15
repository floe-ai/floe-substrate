import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusStore } from "./store.js";
import { defaultConfig } from "./config.js";
import { CLIENT_ADAPTER_ID } from "./runtime-profiles.js";
import { operatorActorId, OPERATOR_ACTOR_SLUG } from "./local-operator-actor.js";

/**
 * Registration provisions the operator as an ordinary Actor: created through
 * the same definition → runtime-profile → binding path any Actor is, addressable
 * by `request` (present in the endpoint listing), and declared on the `client`
 * adapter no Bridge provides. Nothing marks it as person-backed; only its
 * adapter distinguishes it, and that names what executes the turn (a client).
 */
function makeStore(): { store: BusStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "operator-actor-"));
  const store = new BusStore(join(dir, "bus.sqlite"), defaultConfig());
  return { store, dir };
}

describe("registration provisions the operator Actor", () => {
  it("creates an addressable operator Actor on the client adapter", () => {
    const { store } = makeStore();
    const workspace = store.registerWorkspace({ locator: "/tmp/ws-a" }, () => {});
    const workspaceId = workspace.workspace_id;
    const endpointId = operatorActorId(workspaceId);

    // Addressable by request: it appears in the endpoint listing that
    // list_endpoints / fromNeutralRef resolve against.
    const endpoints = store.listEndpoints(workspaceId) as Array<{ endpoint_id: string; agent_id: string | null }>;
    const endpoint = endpoints.find((e) => e.endpoint_id === endpointId);
    expect(endpoint, "operator endpoint must be listed").toBeTruthy();
    expect(endpoint!.agent_id).toBe(OPERATOR_ACTOR_SLUG);

    // A real Actor with a published client-adapter runtime, so the model
    // Bridge's existing adapter-match filter skips it.
    const runtimes = store.listRuntimeEndpoints(workspaceId) as Array<{ endpoint_id: string; adapter_id: string }>;
    const runtime = runtimes.find((r) => r.endpoint_id === endpointId);
    expect(runtime, "operator Actor must project as a runtime endpoint").toBeTruthy();
    expect(runtime!.adapter_id).toBe(CLIENT_ADAPTER_ID);
  });

  it("is idempotent across repeated registration", () => {
    const { store } = makeStore();
    const first = store.registerWorkspace({ locator: "/tmp/ws-b" }, () => {});
    const again = store.registerWorkspace({ locator: "/tmp/ws-b" }, () => {});
    expect(again.workspace_id).toBe(first.workspace_id);

    const runtimes = store.listRuntimeEndpoints(first.workspace_id) as Array<{ endpoint_id: string }>;
    const operatorRuntimes = runtimes.filter((r) => r.endpoint_id === operatorActorId(first.workspace_id));
    expect(operatorRuntimes).toHaveLength(1);
  });
});
