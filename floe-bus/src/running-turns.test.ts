import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "./config.js";
import { createBusServer } from "./server.js";
import { emitViaRoute } from "./test-support/emit-via-route.js";

/**
 * A turn is running only while its processor has started it. Work that is
 * reserved, claimed, or waiting on an answer executes nothing, so it never
 * blocks a version switch. The set is pushed host-wide whenever it changes.
 */
const HOST_TOKEN = `test-running-turns-${"r".repeat(48)}`;
const WS = "workspace:running-turns";
const EP = "actor:running-turns:agent";
const BRIDGE = "bridge:running-turns";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "floe-running-turns-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const config = defaultConfig(directory);
  const path = join(directory, "config.yaml");
  writeFileSync(path, YAML.stringify(config));
  const handle = await createBusServer(path, config, { host_control_token: HOST_TOKEN, unsafe_in_process_test_auth_bypass: true });
  cleanups.push(() => handle.app.close());
  const now = new Date().toISOString();
  handle.store.workspaceIdentityStore.restoreWorkspace({
    snapshot: { workspace_id: WS, name: "Running turns", creation_kind: "created", source_workspace_id: null, created_at: now, updated_at: now },
    binding: { host_id: handle.store.localHostId, platform: handle.store.localWorkspacePlatform, locator: join(directory, "ws"), init_authorized: true },
  });
  await handle.app.listen({ host: "127.0.0.1", port: 0 });
  const address = handle.app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { handle, url: `http://127.0.0.1:${port}` };
}

async function hostStream(url: string) {
  const { WebSocket } = await import("ws" as string);
  const ws = new WebSocket(url.replace(/^http/, "ws") + "/v1/events/stream");
  cleanups.push(() => ws.terminate());
  const changes: Array<Array<{ endpoint_id: string }>> = [];
  let arrived = () => {};
  let caughtUp = false;
  ws.on("message", (data: unknown) => {
    const message = JSON.parse(String(data));
    if (message.type === "caught_up") caughtUp = true;
    if (message.type === "running_turns_changed") changes.push(message.payload.running);
    arrived();
  });
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.send(JSON.stringify({ type: "authenticate", bearer_token: HOST_TOKEN, start_at: "current" }));
  const until = (check: () => boolean, label: string) => check() ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${label}`)), 2_000);
      arrived = () => { if (check()) { clearTimeout(timer); resolve(); } };
    });
  await until(() => caughtUp, "caught_up");
  return { changes, until };
}

describe("running turns", () => {
  it("lists only started turns and pushes each change host-wide", async () => {
    const { handle, url } = await fixture();
    const store = handle.store;
    const listed = async () => (await handle.app.inject({ method: "GET", url: "/v1/local/running-turns",
      headers: { authorization: ["Bearer", HOST_TOKEN].join(" ") } })).json().running;
    store.registerEndpoint({ endpoint_id: EP, workspace_id: WS, name: "Agent", bridge_id: BRIDGE, status: "idle" }, handle.broadcast);
    const stream = await hostStream(url);

    await emitViaRoute(handle, {
      type: "message", workspace_id: WS, source_endpoint_id: "actor:running-turns:asker",
      destination: { kind: "endpoint", endpoint_id: EP }, content: { text: "an unanswered question" },
      response: { expected: true },
    });
    // Delivered and waiting, even marked active: nothing executes yet.
    expect((store.getEndpoint(EP) as { status: string }).status).toBe("active");
    expect(await listed()).toEqual([]);
    const [delivery] = store.claimDeliveries(BRIDGE, 1, handle.broadcast);
    expect(await listed()).toEqual([]);
    expect(stream.changes).toEqual([]);

    store.reportDeliveryStatus({ bridge_id: BRIDGE, delivery_id: delivery!.delivery_id, state: "injected_to_runtime" }, handle.broadcast);
    const running = [{ workspace_id: WS, endpoint_id: EP, name: "Agent" }];
    expect(await listed()).toEqual(running);
    await stream.until(() => stream.changes.length === 1, "push when the turn started");
    expect(stream.changes[0]).toEqual(running);

    store.reportDeliveryStatus({ bridge_id: BRIDGE, delivery_id: delivery!.delivery_id, state: "acknowledged" }, handle.broadcast);
    expect(await listed()).toEqual([]);
    await stream.until(() => stream.changes.length === 2, "push when the turn ended");
    expect(stream.changes[1]).toEqual([]);
  });
});
