import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import { defaultConfig, type LocalConfig } from "./config.js";
import { encodeEventCursor } from "./event-cursor.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

async function makeServer() {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-wm-srv-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg: LocalConfig = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const handle = await createBusServer(cfgPath, cfg, { unsafe_in_process_test_auth_bypass: true });
  await handle.app.ready();
  return { handle, tmp };
}

async function registerWorkspace(handle: ServerHandle, tmp: string): Promise<string> {
  const wsLocator = join(tmp, "ws");
  mkdirSync(wsLocator, { recursive: true });
  const registered = await handle.app.inject({
    method: "POST",
    url: "/v1/workspaces/register",
    headers: { authorization: `Bearer ${handle.localControlToken}` },
    payload: { locator: wsLocator, name: "wm-test" }
  });
  expect(registered.statusCode).toBe(201);
  return registered.json().workspace.workspace_id;
}

describe("Endpoint Watermark HTTP routes", () => {
  let handle: ServerHandle;
  let tmp: string;

  beforeEach(async () => { const m = await makeServer(); handle = m.handle; tmp = m.tmp; });
  afterEach(async () => { try { await handle.app.close(); } catch {} rmSync(tmp, { recursive: true, force: true }); });

  it("GET /v1/events returns next_cursor: null when there are no events", async () => {
    const ws = await registerWorkspace(handle, tmp);
    const res = await handle.app.inject({ method: "GET", url: `/v1/events?workspace_id=${encodeURIComponent(ws)}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ events: [], next_cursor: null });
  });

  it("GET /v1/events rejects a malformed since cursor with 400", async () => {
    const ws = await registerWorkspace(handle, tmp);
    const res = await handle.app.inject({
      method: "GET",
      url: `/v1/events?workspace_id=${encodeURIComponent(ws)}&since=garbage`
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_event_cursor");
  });

  it("returns the watermark as null before it is set", async () => {
    const ws = await registerWorkspace(handle, tmp);
    const res = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(ws)}/endpoints/${encodeURIComponent("actor:test:op")}/watermark`
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ watermark: null });
  });

  it("PUT then GET round-trips an endpoint watermark", async () => {
    const ws = await registerWorkspace(handle, tmp);
    const cursor = encodeEventCursor({ created_at: "2026-06-14T00:00:00.000Z", event_id: "evt_x" });
    const put = await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${encodeURIComponent(ws)}/endpoints/${encodeURIComponent("actor:test:op")}/watermark`,
      payload: { cursor }
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().watermark).toMatchObject({ workspace_id: ws, endpoint_id: "actor:test:op", cursor });

    const get = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(ws)}/endpoints/${encodeURIComponent("actor:test:op")}/watermark`
    });
    expect(get.json().watermark.cursor).toBe(cursor);
  });

  it("PUT rejects a malformed cursor with 400", async () => {
    const ws = await registerWorkspace(handle, tmp);
    const res = await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${encodeURIComponent(ws)}/endpoints/${encodeURIComponent("actor:test:op")}/watermark`,
      payload: { cursor: "garbage" }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_event_cursor");
  });

  it("returns 404 for an unknown workspace on GET and PUT", async () => {
    const cursor = encodeEventCursor({ created_at: "2026-06-14T00:00:00.000Z", event_id: "evt_x" });
    const get = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent("workspace:nope")}/endpoints/${encodeURIComponent("actor:test:op")}/watermark`
    });
    expect(get.statusCode).toBe(404);
    const put = await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${encodeURIComponent("workspace:nope")}/endpoints/${encodeURIComponent("actor:test:op")}/watermark`,
      payload: { cursor }
    });
    expect(put.statusCode).toBe(404);
  });
});
