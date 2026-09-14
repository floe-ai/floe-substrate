import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import { scopeProjectionLayoutSchemaId } from "./scope-projection-layout-store.js";
import { defaultConfig, type LocalConfig } from "./config.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;
const SCOPE_ID = "research";

function localHeaders(handle: ServerHandle) {
  return { authorization: `Bearer ${handle.localControlToken}` };
}

async function makeServer(): Promise<{
  handle: ServerHandle;
  cleanup: () => Promise<void>;
  tmp: string;
  wsId: string;
  wsLocator: string;
}> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-projection-layout-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg: LocalConfig = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const handle = await createBusServer(cfgPath, cfg, { unsafe_in_process_test_auth_bypass: true });
  await handle.app.ready();

  const wsLocator = join(tmp, "ws");
  mkdirSync(wsLocator, { recursive: true });
  const workspace = handle.store.registerWorkspace(
    { locator: wsLocator, name: "projection-layout-test" },
    () => {}
  ) as { workspace_id: string };
  handle.store.createScope({ workspace_id: workspace.workspace_id, scope_id: SCOPE_ID, title: "Research" }, () => {});
  return {
    handle,
    tmp,
    wsId: workspace.workspace_id,
    wsLocator,
    cleanup: async () => {
      try { await handle.app.close(); } catch {}
      rmSync(tmp, { recursive: true, force: true });
    }
  };
}

function makeLayout(scopeId: string, renderer = "floe-app"): Record<string, unknown> {
  return {
    schema: scopeProjectionLayoutSchemaId(renderer),
    scope_id: scopeId,
    viewport: { x: 0, y: 0, zoom: 1 },
    items: {
      "context:ctx_research": { x: 120, y: 220 },
      "pulse:pulse_daily": { x: 360, y: 220 }
    }
  };
}

describe("Scope Projection layout HTTP routes", () => {
  let handle: ServerHandle;
  let cleanup: () => Promise<void>;
  let wsId: string;
  let wsLocator: string;

  beforeEach(async () => {
    const made = await makeServer();
    handle = made.handle;
    cleanup = made.cleanup;
    wsId = made.wsId;
    wsLocator = made.wsLocator;
  });
  afterEach(async () => { await cleanup(); });

  it("does not expose legacy retired semantic list/get/put/delete routes", async () => {
    for (const request of [
      { method: "GET", url: `/v1/workspaces/${wsId}/fields` },
      { method: "GET", url: `/v1/workspaces/${wsId}/fields/alpha` },
      { method: "PUT", url: `/v1/workspaces/${wsId}/fields/alpha`, payload: {} },
      { method: "DELETE", url: `/v1/workspaces/${wsId}/fields/alpha` },
      { method: "PUT", url: `/v1/workspaces/${wsId}/fields/default/layout/floe-app`, payload: makeLayout("default") }
    ] as const) {
      const res = await handle.app.inject(request);
      expect(res.statusCode).toBe(404);
    }
    expect(existsSync(join(wsLocator, ".floe", "fields", "alpha.yaml"))).toBe(false);
    expect(existsSync(join(wsLocator, ".floe", "fields", "default.layout.floe-app.yaml"))).toBe(false);
  });

  it("persists Scope Projection layout without creating separate semantic state", async () => {
    const layout = makeLayout(SCOPE_ID);
    const put = await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/scopes/${SCOPE_ID}/projection/layout/floe-app`,
      headers: localHeaders(handle),
      payload: layout
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ layout });
    expect(existsSync(join(wsLocator, ".floe", "fields", `${SCOPE_ID}.yaml`))).toBe(false);
    expect(existsSync(join(wsLocator, ".floe", "blocks"))).toBe(false);

    const get = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${wsId}/scopes/${SCOPE_ID}/projection/layout/floe-app`,
      headers: localHeaders(handle),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ layout });

    const projection = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${wsId}/scopes/${SCOPE_ID}/projection`
    });
    expect(projection.statusCode).toBe(200);
    expect(projection.json().projection.refs.contexts).toEqual([]);
    expect(projection.json().projection.refs.pulses).toEqual([]);
  });

  it("lets a client that is not floe-app round-trip its own projection layout", async () => {
    const layout = makeLayout(SCOPE_ID, "react-flow");
    const put = await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/scopes/${SCOPE_ID}/projection/layout/react-flow`,
      headers: localHeaders(handle),
      payload: layout
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ layout });
    expect(existsSync(join(wsLocator, ".floe", "scope-projection-layouts", `${SCOPE_ID}.layout.react-flow.yaml`))).toBe(true);

    const get = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${wsId}/scopes/${SCOPE_ID}/projection/layout/react-flow`,
      headers: localHeaders(handle),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ layout });
  });

  it("still serves a pre-existing floe-app layout stored under the legacy schema name", async () => {
    const dir = join(wsLocator, ".floe", "scope-projection-layouts");
    mkdirSync(dir, { recursive: true });
    const legacy = {
      schema: "floe.scope-projection.layout.floe-app.v1",
      scope_id: SCOPE_ID,
      viewport: { x: 9, y: 9, zoom: 1 },
      items: { "context:ctx_legacy": { x: 3, y: 4 } }
    };
    writeFileSync(join(dir, `${SCOPE_ID}.layout.floe-app.yaml`), YAML.stringify(legacy), "utf8");

    const get = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${wsId}/scopes/${SCOPE_ID}/projection/layout/floe-app`,
      headers: localHeaders(handle),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ layout: legacy });
  });

  it("returns explicit layout errors for missing sidecars, missing Scopes, invalid renderers, and mismatched ids", async () => {
    const missing = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${wsId}/scopes/${SCOPE_ID}/projection/layout/floe-app`,
      headers: localHeaders(handle),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "scope_projection_layout_not_found" });

    const missingScope = await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/scopes/unknown/projection/layout/floe-app`,
      headers: localHeaders(handle),
      payload: makeLayout("unknown")
    });
    expect(missingScope.statusCode).toBe(404);
    expect(missingScope.json().error).toBe("scope_not_found");

    const badRenderer = await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/scopes/${SCOPE_ID}/projection/layout/React-Flow`,
      headers: localHeaders(handle),
      payload: makeLayout(SCOPE_ID)
    });
    expect(badRenderer.statusCode).toBe(400);
    expect(badRenderer.json().error).toBe("scope_projection_layout_renderer_invalid");

    const mismatch = await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/scopes/${SCOPE_ID}/projection/layout/floe-app`,
      headers: localHeaders(handle),
      payload: makeLayout("other")
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error).toBe("scope_projection_layout_id_mismatch");
  });

  it("broadcasts Scope Projection layout updates to event stream subscribers", async () => {
    const address = await handle.app.listen({ port: 0, host: "127.0.0.1" });
    const url = address.replace(/^http/, "ws") + "/v1/events/stream";
    const wsMod = await import("ws" as any);
    const WS = (wsMod as any).WebSocket ?? (wsMod as any).default;
    const ws = new WS(url);
    const messages: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => ws.send(JSON.stringify({
        type: "authenticate",
        bearer_token: handle.localControlToken,
      })));
      ws.on("message", (data: any) => {
        const message = JSON.parse(data.toString());
        messages.push(message);
        if (message.type === "authenticated") resolve();
      });
      ws.on("error", (error: any) => reject(error));
    });

    await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/scopes/${SCOPE_ID}/projection/layout/floe-app`,
      headers: localHeaders(handle),
      payload: makeLayout(SCOPE_ID)
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    ws.close();
    const updated = messages.find((message) => message.type === "scope_projection.layout.upserted");
    expect(updated).toBeDefined();
    expect(updated.payload).toEqual({
      workspace_id: wsId,
      scope_id: SCOPE_ID,
      source: "api",
      renderer: "floe-app"
    });
  });
});
