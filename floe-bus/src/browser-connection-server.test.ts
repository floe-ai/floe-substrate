import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "./config.js";
import { createBusServer } from "./server.js";

const HOST_TOKEN = `test-browser-host-${"h".repeat(48)}`;
const ORIGIN = "http://localhost:5379";
const hostHeaders = { authorization: `Bearer ${HOST_TOKEN}` };
const cookieHeader = (value: string | string[] | undefined) => String(Array.isArray(value) ? value[0] : value).split(";", 1)[0]!;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(local = false, existingWorkspaces = true) {
  const directory = mkdtempSync(join(tmpdir(), "floe-browser-session-"));
  const config = defaultConfig(directory);
  const path = join(directory, "config.yaml");
  writeFileSync(path, YAML.stringify(config));
  const handle = await createBusServer(path, config, { host_control_token: HOST_TOKEN, local_browser_access: local });
  await handle.app.ready();
  const now = new Date().toISOString();
  for (const id of existingWorkspaces ? ["workspace:one", "workspace:two"] : []) handle.store.workspaceIdentityStore.restoreWorkspace({
    snapshot: { workspace_id: id, name: id, creation_kind: "created", source_workspace_id: null, created_at: now, updated_at: now },
    binding: { host_id: handle.store.localHostId, platform: "windows", locator: join(directory, id.replace(":", "-")), init_authorized: true },
  });
  cleanups.push(async () => { await handle.app.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...handle, directory };
}

async function connect(handle: Awaited<ReturnType<typeof fixture>>) {
  const start = await handle.app.inject({ method: "POST", url: "/v1/browser/connections", headers: { origin: ORIGIN } });
  expect(start.statusCode, start.body).toBe(201);
  const pending = cookieHeader(start.headers["set-cookie"]);
  const approve = await handle.app.inject({ method: "POST", url: `/v1/local/browser-connections/${start.json().code}/approve`, headers: hostHeaders, payload: { workspace_id: "workspace:one" } });
  expect(approve.statusCode, approve.body).toBe(200);
  expect(approve.body).not.toMatch(/bearer|token/);
  const claim = await handle.app.inject({ method: "POST", url: "/v1/browser/connections/claim", headers: { origin: ORIGIN, cookie: pending } });
  expect(claim.statusCode, claim.body).toBe(200);
  return { origin: ORIGIN, cookie: `${pending}; ${cookieHeader(claim.headers["set-cookie"])}` };
}

describe("browser authority through the canonical contract", () => {
  it.each([false, true])("registers a Workspace from the local browser (existing Workspaces: %s)", async (existingWorkspaces) => {
    const handle = await fixture(true, existingWorkspaces);
    const originHeaders = { origin: ORIGIN, host: "localhost:5379", "sec-fetch-site": "same-origin" };
    const local = await handle.app.inject({ method: "POST", url: "/v1/browser/session/local", headers: originHeaders });
    expect(local.statusCode, local.body).toBe(200);
    const headers = { ...originHeaders, cookie: cookieHeader(local.headers["set-cookie"]) };
    const discovery = await handle.app.inject({ url: "/v1/browser/host/operations?query=register%20workspace", headers });
    expect(discovery.statusCode, discovery.body).toBe(200);
    const operation = discovery.json().operations.find((item: { operation_id: string }) => item.operation_id === "workspace.register");
    expect(operation.availability.available).toBe(true);
    const native = await handle.app.inject({ url: "/v1/local/operations?query=register%20workspace", headers: hostHeaders });
    expect(operation).toEqual(native.json().operations.find((item: { operation_id: string }) => item.operation_id === "workspace.register"));
    const locator = join(handle.directory, "new-workspace");
    const payload = {
      operation_id: operation.operation_id, operation_version: operation.operation_version,
      input_schema_version: operation.input.version, idempotency_key: "browser-register",
      input: { locator, name: "Browser workspace", init_authorized: true, create_directory: true },
      principal_id: "forged-principal", grants: ["*"], confirmed_prompts: ["*"],
    };
    const created = await handle.app.inject({ method: "POST", url: "/v1/browser/host/operations/invoke", headers, payload });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({ kind: "receipt", replayed: false, receipt: {
      state: "completed", principal_id: handle.store.localOperatorPrincipalId,
      authority_boundary: { kind: "host", host_id: handle.store.localHostId },
    } });
    expect(existsSync(locator)).toBe(true);
    const receipt = created.json().receipt;
    const replay = await handle.app.inject({ method: "POST", url: "/v1/browser/host/operations/invoke", headers, payload });
    expect(replay.json()).toMatchObject({ replayed: true, receipt: { receipt_id: receipt.receipt_id } });
    const read = await handle.app.inject({ url: `/v1/browser/host/operation-receipts/${receipt.receipt_id}`, headers });
    expect(read.json().receipt).toEqual(receipt);
    const bootstrap = await handle.app.inject({ url: "/v1/browser/session", headers });
    expect(bootstrap.json().workspaces).toHaveLength(existingWorkspaces ? 3 : 1);
    expect(bootstrap.json().workspaces).toContainEqual(expect.objectContaining({ workspace_id: receipt.result.workspace.workspace_id }));
    expect(bootstrap.body).not.toMatch(/bearer_token|authority_session_id|locator|principal_id/);
    const workspace = await handle.app.inject({ url: `/v1/workspaces/${encodeURIComponent(receipt.result.workspace.workspace_id)}/operations`, headers });
    expect(workspace.statusCode, workspace.body).toBe(200);
    expect((await handle.app.inject({ url: "/v1/local/operations", headers })).statusCode).toBe(401);
  });

  it("refuses browser host operations for remote, disconnected, forwarded and foreign-origin sessions", async () => {
    const handle = await fixture(true);
    const originHeaders = { origin: ORIGIN, host: "localhost:5379", "sec-fetch-site": "same-origin" };
    const local = await handle.app.inject({ method: "POST", url: "/v1/browser/session/local", headers: originHeaders });
    const headers = { ...originHeaders, cookie: cookieHeader(local.headers["set-cookie"]) };
    const remote = await connect(handle);
    const locator = join(handle.directory, "refused-workspace");
    const payload = { operation_id: "workspace.register", operation_version: "1", input_schema_version: "1", idempotency_key: "refused", input: { locator, create_directory: true } };
    const requests = [
      { headers: originHeaders },
      { headers: { ...originHeaders, ...remote } },
      { headers, remoteAddress: "192.168.1.20" },
      { headers: { ...headers, "x-forwarded-for": "192.168.1.20" } },
      { headers: { ...headers, host: "attacker.example" } },
      { headers: { ...headers, origin: "https://attacker.example" } },
      { headers: { ...headers, "sec-fetch-site": "cross-site" } },
    ];
    for (const request of requests) {
      for (const route of [
        { url: "/v1/browser/host/operations", method: "GET" as const },
        { url: "/v1/browser/host/operations/invoke", method: "POST" as const, payload },
        { url: "/v1/browser/host/operation-receipts/any", method: "GET" as const },
      ]) expect((await handle.app.inject({ ...route, ...request })).statusCode).toBe(403);
    }
    const disconnected = await handle.app.inject({ method: "DELETE", url: "/v1/browser/session", headers });
    expect(disconnected.statusCode).toBe(200);
    expect((await handle.app.inject({ method: "POST", url: "/v1/browser/host/operations/invoke", headers, payload })).statusCode).toBe(403);
    expect(existsSync(locator)).toBe(false);
    expect(handle.store.listWorkspaces()).toHaveLength(2);
  });

  it("opens the local workspace without pairing and supports independent workspace requests", async () => {
    const handle = await fixture(true);
    for (const workspace of ["one", "two"]) handle.store.upsertRuntimeBinding({
      scope: "workspace_default", workspace_id: `workspace:${workspace}`,
      auth_profile: `profile:${workspace}`, provider: "test-provider", model: `model:${workspace}`,
    }, () => {});
    const headers = { origin: ORIGIN, host: "localhost:5379", "sec-fetch-site": "same-origin" };
    const local = await handle.app.inject({ method: "POST", url: "/v1/browser/session/local", headers });
    expect(local.statusCode, local.body).toBe(200);
    expect(local.body).not.toMatch(/bearer|token|principal/);
    const connected = { ...headers, cookie: cookieHeader(local.headers["set-cookie"]) };
    const bootstrap = await handle.app.inject({ url: "/v1/browser/session", headers: connected });
    expect(bootstrap.statusCode, bootstrap.body).toBe(200);
    expect(bootstrap.json().mode).toBe("local");
    expect(bootstrap.json().workspaces).toHaveLength(2);
    expect(bootstrap.json().bindings.map((binding: { model: string }) => binding.model).sort()).toEqual(["model:one", "model:two"]);
    expect(bootstrap.body).not.toMatch(/bearer_token|authority_session_id|locator|principal_id/);
    for (const workspace of ["one", "two", "one"]) {
      const result = await handle.app.inject({ url: `/v1/workspaces/workspace%3A${workspace}/operations`, headers: connected });
      expect(result.statusCode, result.body).toBe(200);
    }
    expect((await handle.app.inject({ url: "/v1/local/workspaces", headers: connected })).statusCode).toBe(401);
    expect((await handle.app.inject({ url: "/v1/local/browser-connections", headers: hostHeaders })).json().connections).toEqual([]);
    const reload = await handle.app.inject({ method: "POST", url: "/v1/browser/session/local", headers: connected });
    expect(cookieHeader(reload.headers["set-cookie"])).toBe(connected.cookie);
  });

  it("keeps remote, forwarded and other-origin connections on the pairing path", async () => {
    const handle = await fixture(true);
    const headers = { origin: ORIGIN, host: "localhost:5379" };
    for (const request of [
      { headers, remoteAddress: "192.168.1.20" },
      { headers: { ...headers, "x-forwarded-for": "192.168.1.20" } },
      { headers: { ...headers, host: "attacker.example" } },
      { headers: { ...headers, origin: "https://attacker.example" } },
      { headers: { ...headers, "sec-fetch-site": "cross-site" } },
    ]) {
      const result = await handle.app.inject({ method: "POST", url: "/v1/browser/session/local", ...request });
      expect(result.statusCode, result.body).toBe(403);
      expect(result.headers["set-cookie"]).toBeUndefined();
    }
    const spoof = await handle.app.inject({ method: "POST", url: "/v1/browser/session/local", headers, payload: { principal_id: "other", grants: ["*"] } });
    expect(spoof.statusCode).toBe(400);
    const disabled = await fixture();
    expect((await disabled.app.inject({ method: "POST", url: "/v1/browser/session/local", headers })).statusCode).toBe(403);
    const remote = await connect(handle);
    expect((await handle.app.inject({ url: "/v1/browser/session", headers: remote })).json().mode).toBe("remote");
    expect((await handle.app.inject({ url: "/v1/workspaces/workspace%3Atwo/operations", headers: remote })).statusCode).toBe(401);
  });

  it("opens only the approved workspace, keeps host control private, and applies revocation immediately", async () => {
    const handle = await fixture();
    const unauth = await handle.app.inject({ url: "/v1/browser/session" });
    expect(unauth.statusCode).toBe(401);
    const spoof = await handle.app.inject({ method: "POST", url: "/v1/browser/connections", headers: { origin: ORIGIN }, payload: { workspace_id: "workspace:two", grants: ["*"] } });
    expect(spoof.statusCode).toBe(400);
    const headers = await connect(handle);
    const bootstrap = await handle.app.inject({ url: "/v1/browser/session", headers });
    expect(bootstrap.statusCode, bootstrap.body).toBe(200);
    expect(bootstrap.json().workspaces.map((item: { workspace_id: string }) => item.workspace_id)).toEqual(["workspace:one"]);
    expect(bootstrap.body).not.toMatch(/bearer_token|authority_session_id|locator|principal_id/);
    const own = await handle.app.inject({ url: "/v1/workspaces/workspace%3Aone/operations", headers });
    expect(own.statusCode, own.body).toBe(200);
    const other = await handle.app.inject({ url: "/v1/workspaces/workspace%3Atwo/operations", headers });
    expect(other.statusCode).toBe(401);
    for (const url of ["/v1/local/workspaces", "/v1/local/browser-connections", "/v1/auth/profiles"]) {
      expect((await handle.app.inject({ url, headers })).statusCode).toBe(401);
    }
    const crossOrigin = await handle.app.inject({ url: "/v1/workspaces/workspace%3Aone/operations", headers: { ...headers, origin: "https://attacker.example" } });
    expect(crossOrigin.statusCode).toBe(403);
    const sessions = handle.store.db.prepare("SELECT authority_session_id FROM operation_authority_sessions WHERE interaction_session_id LIKE 'browser:%'").all() as { authority_session_id: string }[];
    expect(sessions).toHaveLength(1);
    handle.store.operationAuthoritySessions.revokeSession(sessions[0]!.authority_session_id);
    expect((await handle.app.inject({ url: "/v1/browser/session", headers })).statusCode).toBe(401);
    expect((await handle.app.inject({ url: "/v1/workspaces/workspace%3Aone/operations", headers })).statusCode).toBe(401);
  });

  it("authenticates the first WebSocket frame and filters workspace updates", async () => {
    const handle = await fixture();
    const headers = await connect(handle);
    const address = await handle.app.listen({ host: "127.0.0.1", port: 0 });
    const { WebSocket } = await import("ws" as string);
    const ws = new WebSocket(address.replace(/^http/, "ws") + "/v1/events/stream", { headers });
    cleanups.push(async () => { ws.terminate(); });
    const messages: Array<{ type: string; payload?: { workspace_id?: string } }> = [];
    ws.on("message", (data: unknown) => messages.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    expect(messages).toEqual([]);
    ws.send(JSON.stringify({ type: "authenticate", browser_session: true, workspace_id: "workspace:one" }));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("No authenticated stream")), 2_000);
      ws.on("message", (data: unknown) => { if (JSON.parse(String(data)).type === "caught_up") { clearTimeout(timeout); resolve(); } });
    });
    expect(messages[0]?.type).toBe("authenticated");
    handle.broadcast("browser-proof", { workspace_id: "workspace:two" });
    handle.broadcast("browser-proof", { workspace_id: "workspace:one" });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("No workspace update")), 2_000);
      ws.on("message", (data: unknown) => { if (JSON.parse(String(data)).type === "browser-proof") { clearTimeout(timeout); resolve(); } });
    });
    expect(messages.filter(item => item.type === "browser-proof").map(item => item.payload?.workspace_id)).toEqual(["workspace:one"]);
  });
});
