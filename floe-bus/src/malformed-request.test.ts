import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { defaultConfig } from "./config.js";
import { createBusServer } from "./server.js";

/**
 * A malformed request is the caller's mistake: it gets a 4xx that says so,
 * never a 500. This sweeps every registered route with the authority it needs,
 * so a new route cannot quietly reintroduce the fault.
 */
const HOST_TOKEN = "m".repeat(48);
const bearer = (token: string) => ({ authorization: ["Be", "arer ", token].join("") });
type Handle = Awaited<ReturnType<typeof createBusServer>>;

// Routes that act on the host process itself; a sweep must not stop the Bus under test.
const PROCESS_ROUTES = new Set(["POST /v1/shutdown"]);

describe("malformed requests never become server errors", () => {
  let handle: Handle;
  let dir: string;
  let workspaceId: string;
  let personToken: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "floe-malformed-"));
    const configPath = join(dir, "config.yaml");
    const config = defaultConfig(dir);
    writeFileSync(configPath, YAML.stringify(config));
    handle = await createBusServer(configPath, config, { host_control_token: HOST_TOKEN });
    await handle.app.ready();
    const locator = join(dir, "workspace"); mkdirSync(locator);
    workspaceId = (handle.store.registerWorkspace({ locator, name: "Malformed" }, handle.broadcast) as { workspace_id: string }).workspace_id;
    const secret = generateSecretKey();
    await handle.app.inject({ method: "POST", url: "/v1/identities", headers: bearer(HOST_TOKEN),
      payload: { display_name: "Caller", pubkey: getPublicKey(secret), workspace_id: workspaceId, until_revoked: true } });
    const { challenge, relay } = (await handle.app.inject({ method: "GET", url: "/v1/identity/challenge" })).json();
    const event = finalizeEvent({ kind: 22242, created_at: Math.floor(Date.now() / 1000),
      tags: [["relay", relay], ["challenge", challenge]], content: "" }, secret);
    personToken = (await handle.app.inject({ method: "POST", url: "/v1/identity/authenticate",
      payload: { workspace_id: workspaceId, auth_event: event } })).json().bearer_token;
  });

  afterAll(async () => {
    await handle.app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const invoke = (payload: unknown, token = personToken) => handle.app.inject({ method: "POST",
    url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations/invoke`, headers: bearer(token), payload: payload as object });

  it("answers a read without an idempotency key", async () => {
    const read = await invoke({ operation_id: "workspace.access.inspect", operation_version: "1",
      input_schema_version: "1", input: {} });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().receipt.state, read.body).toBe("completed");
    // Two keyless reads are two reads, never a replay of the first.
    const again = await invoke({ operation_id: "workspace.access.inspect", operation_version: "1",
      input_schema_version: "1", input: {} });
    expect(again.json().replayed ?? false).toBe(false);
    expect(again.json().receipt.receipt_id).not.toBe(read.json().receipt.receipt_id);
  });

  it("answers a write without an idempotency key with a plain 400", async () => {
    const write = await invoke({ operation_id: "identity.workspace-authority.revoke", operation_version: "1",
      input_schema_version: "1", target: null, input: {} });
    expect(write.statusCode, write.body).toBe(400);
    expect(write.json().refusal.code).toBe("idempotency_key_required");
  });

  it("answers a malformed invocation body with a plain 400", async () => {
    for (const payload of [{}, { operation_id: 7 }, [], { operation_id: "x", operation_version: "1", input_schema_version: "1", target: "nope" }]) {
      const response = await invoke(payload);
      expect(response.statusCode, `${JSON.stringify(payload)} -> ${response.body}`).toBe(400);
      expect(response.json().error).toBe("request_invalid");
    }
  });

  it("never answers a malformed request to any route with a 500", async () => {
    const failures: string[] = [];
    const routes = handle.routes.filter(route => route.method !== "HEAD" && route.method !== "OPTIONS");
    for (const route of routes) {
      const key = `${route.method} ${route.url}`;
      if (PROCESS_ROUTES.has(key)) continue;
      const url = route.url.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => name === "workspace_id" ? workspaceId : "missing");
      const token = route.url.includes(":workspace_id") ? personToken : HOST_TOKEN;
      const malformed: Array<{ query?: string; payload?: unknown }> = route.method === "GET" || route.method === "DELETE"
        ? [{ query: "limit=not-a-number&workspace_id=&cursor=%00" }]
        : [{ payload: [] }, { payload: { unexpected: { deeply: ["wrong"] } } }];
      for (const probe of malformed) {
        const response = await handle.app.inject({ method: route.method as "GET",
          url: probe.query ? `${url}?${probe.query}` : url, headers: bearer(token),
          ...(probe.payload === undefined ? {} : { payload: probe.payload as object }) });
        if (response.statusCode >= 500) failures.push(`${key} -> ${response.statusCode} ${response.body.slice(0, 160)}`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
