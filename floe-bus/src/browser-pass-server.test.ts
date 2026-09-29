import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "./config.js";
import { createBusServer } from "./server.js";
import { admitPerson, invokeAs, pairBrowser } from "./test-support/browser-pass.js";

const HOST_TOKEN = `test-browser-pass-${"p".repeat(48)}`;
const WORKSPACE = "workspace:one";
// A loopback port nobody listed: Star Map or any other local page.
const ORIGIN = "http://127.0.0.1:43127";
const host = { authorization: ["Bearer", HOST_TOKEN].join(" ") };
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start(directory: string) {
  const config = defaultConfig(directory);
  const path = join(directory, "config.yaml");
  writeFileSync(path, YAML.stringify(config));
  const handle = await createBusServer(path, config, { host_control_token: HOST_TOKEN });
  await handle.app.ready();
  return handle;
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "floe-browser-pass-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const handle = await start(directory);
  cleanups.push(() => handle.app.close());
  const now = new Date().toISOString();
  for (const id of [WORKSPACE, "workspace:two"]) handle.store.workspaceIdentityStore.restoreWorkspace({
    snapshot: { workspace_id: id, name: id, creation_kind: "created", source_workspace_id: null, created_at: now, updated_at: now },
    binding: { host_id: handle.store.localHostId, platform: "windows", locator: join(directory, id.replace(":", "-")), init_authorized: true },
  });
  return { handle, directory };
}

const completed = (response: { json(): any; body: string }) => response.json().receipt?.state === "completed";

async function openSocket(address: string, headers: Record<string, string>, frame: object) {
  const { WebSocket } = await import("ws" as string);
  const ws = new WebSocket(address.replace(/^http/, "ws") + "/v1/events/stream", { headers });
  cleanups.push(() => ws.terminate());
  const messages: Array<{ type: string; payload?: any }> = [];
  const waiting = new Map<string, () => void>();
  const closed = new Promise<number>((resolve) => ws.once("close", (code: number) => resolve(code)));
  ws.on("message", (data: unknown) => {
    const message = JSON.parse(String(data));
    messages.push(message);
    waiting.get(message.type)?.();
  });
  const next = (type: string) => messages.some((message) => message.type === type) ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`No ${type} from the Bus`)), 2_000);
      waiting.set(type, () => { clearTimeout(timeout); waiting.delete(type); resolve(); });
    });
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.send(JSON.stringify(frame));
  await next("caught_up");
  return { messages, closed, next };
}

describe("durable browser pass (A2 live proof)", () => {
  it("pairs an unlisted loopback origin for approved operations only and survives a Bus restart", async () => {
    const { handle, directory } = await fixture();
    const person = await admitPerson(handle, HOST_TOKEN, WORKSPACE);
    const { headers } = await pairBrowser(handle, person.token, WORKSPACE, ORIGIN, ["actor.list"]);
    expect(headers.cookie).toMatch(/^floe_browser_pass=/);

    const allowed = await invokeAs(handle, null, WORKSPACE, "actor.list", {}, headers);
    expect(completed(allowed), allowed.body).toBe(true);
    const refused = await invokeAs(handle, null, WORKSPACE, "browser.pass.list", {}, headers);
    expect(completed(refused), refused.body).toBe(false);
    expect(refused.body).toMatch(/grant/i);

    await handle.app.close();
    const restarted = await start(directory);
    cleanups.push(() => restarted.app.close());
    const again = await invokeAs(restarted, null, WORKSPACE, "actor.list", {}, headers);
    expect(completed(again), again.body).toBe(true);
  });

  it("renews past the short session without a new approval, and refuses other origins and Workspaces", async () => {
    const { handle } = await fixture();
    const person = await admitPerson(handle, HOST_TOKEN, WORKSPACE);
    const { headers } = await pairBrowser(handle, person.token, WORKSPACE, ORIGIN);
    expect(completed(await invokeAs(handle, null, WORKSPACE, "actor.list", {}, headers))).toBe(true);
    const sessionsBefore = handle.store.db.prepare("SELECT COUNT(*) AS n FROM operation_authority_sessions").get() as { n: number };

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 16 * 60_000 });
    const renewed = await invokeAs(handle, null, WORKSPACE, "actor.list", {}, headers);
    expect(completed(renewed), renewed.body).toBe(true);
    const sessionsAfter = handle.store.db.prepare("SELECT COUNT(*) AS n FROM operation_authority_sessions").get() as { n: number };
    expect(sessionsAfter.n).toBe(sessionsBefore.n + 1);
    vi.useRealTimers();

    const foreign = await invokeAs(handle, null, WORKSPACE, "actor.list", {}, { ...headers, origin: "http://127.0.0.1:43128" });
    expect([401, 403]).toContain(foreign.statusCode);
    const otherWorkspace = await invokeAs(handle, null, "workspace:two", "actor.list", {}, headers);
    expect([401, 403]).toContain(otherWorkspace.statusCode);
  });

  it("saves a Scope's layout from a person's session and an allowed browser pass, without host control", async () => {
    const { handle } = await fixture();
    handle.store.createScope({ workspace_id: WORKSPACE, scope_id: "map", title: "Map" }, () => {});
    const person = await admitPerson(handle, HOST_TOKEN, WORKSPACE);
    const layout = (x: number) => ({ schema: "floe.scope-projection.layout.star-map.v1", scope_id: "map",
      viewport: { x, y: 0, zoom: 1 }, items: { "node:a": { x, y: 10 } } });
    const url = `/v1/workspaces/${encodeURIComponent(WORKSPACE)}/scopes/map/projection/layout/star-map`;

    const saved = await handle.app.inject({ method: "PUT", url, payload: layout(1),
      headers: { authorization: ["Bearer", person.token].join(" ") } });
    expect(saved.statusCode, saved.body).toBe(200);

    const { headers } = await pairBrowser(handle, person.token, WORKSPACE, ORIGIN,
      ["scope.projection.layout.get", "scope.projection.layout.save"]);
    const fromBrowser = await handle.app.inject({ method: "PUT", url, payload: layout(2), headers });
    expect(fromBrowser.statusCode, fromBrowser.body).toBe(200);
    const read = await handle.app.inject({ url, headers });
    expect(read.json().layout.viewport.x).toBe(2);

    const { headers: listOnly } = await pairBrowser(handle, person.token, WORKSPACE, "http://127.0.0.1:43129");
    const refused = await handle.app.inject({ method: "PUT", url, payload: layout(3), headers: listOnly });
    expect(refused.statusCode, refused.body).toBe(403);
  });

  it("tells a signed-in person about the waiting browser", async () => {
    const { handle } = await fixture();
    const person = await admitPerson(handle, HOST_TOKEN, WORKSPACE);
    const address = await handle.app.listen({ host: "127.0.0.1", port: 0 });
    const socket = await openSocket(address, {}, { type: "authenticate", bearer_token: person.token, workspace_id: WORKSPACE });
    const started = await handle.app.inject({ method: "POST", url: "/v1/browser/connections", headers: { origin: ORIGIN } });
    await socket.next("browser_connection_requested");
    const pushed = socket.messages.find((message) => message.type === "browser_connection_requested")!;
    expect(pushed.payload).toMatchObject({ workspace_id: WORKSPACE, origin: ORIGIN, code: started.json().code });
  });

  it.each(["pass", "identity", "membership"] as const)("ends HTTP and live WebSocket authority when the %s is revoked", async (revoked) => {
    const { handle } = await fixture();
    const person = await admitPerson(handle, HOST_TOKEN, WORKSPACE);
    const { headers, pass_id } = await pairBrowser(handle, person.token, WORKSPACE, ORIGIN);
    const address = await handle.app.listen({ host: "127.0.0.1", port: 0 });
    const socket = await openSocket(address, headers, { type: "authenticate", browser_session: true, workspace_id: WORKSPACE });
    expect(socket.messages[0]?.type).toBe("authenticated");

    if (revoked === "pass") {
      const response = await invokeAs(handle, person.token, WORKSPACE, "browser.pass.revoke", { pass_id });
      expect(completed(response), response.body).toBe(true);
    } else {
      const url = revoked === "identity"
        ? `/v1/clients/${encodeURIComponent(person.identity_id)}`
        : `/v1/clients/${encodeURIComponent(person.identity_id)}/workspaces/${encodeURIComponent(WORKSPACE)}`;
      const response = await handle.app.inject({ method: "DELETE", url, headers: host });
      expect(response.statusCode, response.body).toBe(200);
    }

    expect(await socket.closed).toBe(4401);
    const after = await invokeAs(handle, null, WORKSPACE, "actor.list", {}, headers);
    expect([401, 403]).toContain(after.statusCode);
    expect(handle.store.browserPassStore!.get(pass_id)?.status).toBe("revoked");
  });
});
