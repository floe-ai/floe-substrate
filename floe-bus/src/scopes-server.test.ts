import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import { defaultConfig, type LocalConfig } from "./config.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

function localHeaders(handle: ServerHandle) {
  return { authorization: `Bearer ${handle.localControlToken}` };
}

async function makeServer(): Promise<{
  handle: ServerHandle;
  tmp: string;
  cfgPath: string;
  cfg: LocalConfig;
}> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-scopes-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg: LocalConfig = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const handle = await createBusServer(cfgPath, cfg, { unsafe_in_process_test_auth_bypass: true });
  await handle.app.ready();
  return {
    handle,
    tmp,
    cfgPath,
    cfg
  };
}

describe("Scope HTTP routes", () => {
  let handle: ServerHandle;
  let tmp: string;
  let cfgPath: string;
  let cfg: LocalConfig;

  beforeEach(async () => {
    const made = await makeServer();
    handle = made.handle;
    tmp = made.tmp;
    cfgPath = made.cfgPath;
    cfg = made.cfg;
  });

  afterEach(async () => {
    try { await handle.app.close(); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  });

  it("registering a workspace does not create a Default Scope", async () => {
    const wsLocator = join(tmp, "ws");
    mkdirSync(wsLocator, { recursive: true });
    const registered = await handle.app.inject({
      method: "POST",
      url: "/v1/workspaces/register",
      headers: localHeaders(handle),
      payload: { locator: wsLocator, name: "scope-test" }
    });
    expect(registered.statusCode).toBe(201);
    const workspaceId = registered.json().workspace.workspace_id;

    const scopes = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`
    });

    expect(scopes.statusCode).toBe(200);
    expect(scopes.json()).toEqual({ scopes: [] });
  });

  it("creates a named Scope without inventing a Default Scope", async () => {
    const wsLocator = join(tmp, "ws");
    mkdirSync(wsLocator, { recursive: true });
    const registered = await handle.app.inject({
      method: "POST",
      url: "/v1/workspaces/register",
      headers: localHeaders(handle),
      payload: { locator: wsLocator, name: "scope-test" }
    });
    expect(registered.statusCode).toBe(201);
    const workspaceId = registered.json().workspace.workspace_id;

    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`,
      payload: {
        scope_id: "research",
        title: "Research",
        description: "Discovery work"
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().scope).toMatchObject({
      scope_id: "research",
      workspace_id: workspaceId,
      title: "Research",
      description: "Discovery work"
    });

    const scopes = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`
    });
    expect(scopes.statusCode).toBe(200);
    expect(scopes.json().scopes.map((scope: { scope_id: string }) => scope.scope_id)).toEqual([
      "research"
    ]);
  });

  it("rejects user-created Scope id 'default' because it is reserved for stale cleanup", async () => {
    const wsLocator = join(tmp, "ws");
    mkdirSync(wsLocator, { recursive: true });
    const registered = await handle.app.inject({
      method: "POST",
      url: "/v1/workspaces/register",
      headers: localHeaders(handle),
      payload: { locator: wsLocator, name: "scope-test" }
    });
    const workspaceId = registered.json().workspace.workspace_id;

    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`,
      payload: {
        scope_id: "default",
        title: "Default"
      }
    });

    expect(created.statusCode).toBe(400);
    expect(created.json()).toMatchObject({
      error: "scope_id_reserved",
      receipt_id: expect.any(String),
    });
  });

  it("updates Scope metadata through the workspace API", async () => {
    const wsLocator = join(tmp, "ws");
    mkdirSync(wsLocator, { recursive: true });
    const registered = await handle.app.inject({
      method: "POST",
      url: "/v1/workspaces/register",
      headers: localHeaders(handle),
      payload: { locator: wsLocator, name: "scope-test" }
    });
    const workspaceId = registered.json().workspace.workspace_id;
    await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`,
      payload: {
        scope_id: "research",
        title: "Research",
        description: "Discovery work"
      }
    });

    const updated = await handle.app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/research`,
      payload: {
        title: "Validated Research",
        description: null
      }
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json().scope).toMatchObject({
      scope_id: "research",
      workspace_id: workspaceId,
      title: "Validated Research",
      description: null
    });
  });

  it("preserves existing Scope description when PATCH updates only the title", async () => {
    const wsLocator = join(tmp, "ws");
    mkdirSync(wsLocator, { recursive: true });
    const registered = await handle.app.inject({
      method: "POST",
      url: "/v1/workspaces/register",
      headers: localHeaders(handle),
      payload: { locator: wsLocator, name: "scope-test" }
    });
    const workspaceId = registered.json().workspace.workspace_id;
    await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`,
      payload: {
        scope_id: "research",
        title: "Research",
        description: "Discovery work"
      }
    });

    const updated = await handle.app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/research`,
      payload: { title: "Validated Research" }
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json().scope).toMatchObject({
      scope_id: "research",
      title: "Validated Research",
      description: "Discovery work"
    });
  });

  it("does not create a Default Scope across register, select, and server restart", async () => {
    const wsLocator = join(tmp, "ws");
    mkdirSync(wsLocator, { recursive: true });
    const firstRegistration = await handle.app.inject({
      method: "POST",
      url: "/v1/workspaces/register",
      headers: localHeaders(handle),
      payload: { locator: wsLocator, name: "scope-test" }
    });
    const workspaceId = firstRegistration.json().workspace.workspace_id;
    await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/select`,
      headers: localHeaders(handle),
    });
    await handle.app.inject({
      method: "POST",
      url: "/v1/workspaces/register",
      headers: localHeaders(handle),
      payload: { locator: wsLocator, name: "scope-test-renamed" }
    });

    await handle.app.close();
    handle = await createBusServer(cfgPath, cfg, { unsafe_in_process_test_auth_bypass: true });
    await handle.app.ready();

    const scopes = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`
    });
    expect(scopes.statusCode).toBe(200);
    expect(scopes.json().scopes.filter((scope: { scope_id: string }) => scope.scope_id === "default")).toHaveLength(0);
  });

  describe("Scope deletion safety", () => {
    async function registerScopedWorkspace(): Promise<string> {
      const wsLocator = join(tmp, "ws");
      mkdirSync(wsLocator, { recursive: true });
      const registered = await handle.app.inject({
        method: "POST",
        url: "/v1/workspaces/register",
        headers: localHeaders(handle),
        payload: { locator: wsLocator, name: "scope-test" }
      });
      expect(registered.statusCode).toBe(201);
      return registered.json().workspace.workspace_id;
    }

    async function createScope(workspaceId: string, scopeId: string): Promise<void> {
      const created = await handle.app.inject({
        method: "POST",
        url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`,
        payload: { scope_id: scopeId, title: scopeId }
      });
      expect(created.statusCode).toBe(201);
    }

    function registerEndpoint(workspaceId: string, endpointId: string): void {
      handle.store.registerEndpoint({
        endpoint_id: endpointId,
        workspace_id: workspaceId,
        name: endpointId,
        bridge_id: "bridge:test",
        status: "idle"
      }, () => {});
    }

    it("deletes an empty Scope (204) and removes it from the Scope list", async () => {
      const workspaceId = await registerScopedWorkspace();
      await createScope(workspaceId, "research");

      const deleted = await handle.app.inject({
        method: "DELETE",
        url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/research`
      });
      expect(deleted.statusCode).toBe(204);

      const scopes = await handle.app.inject({
        method: "GET",
        url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`
      });
      expect(scopes.json()).toEqual({ scopes: [] });
    });

    it("returns 404 scope_not_found for a Scope that does not exist", async () => {
      const workspaceId = await registerScopedWorkspace();

      const deleted = await handle.app.inject({
        method: "DELETE",
        url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/missing`
      });

      expect(deleted.statusCode).toBe(404);
      expect(deleted.json()).toMatchObject({
        error: "scope_not_found",
        workspace_id: workspaceId,
        scope_id: "missing"
      });
    });

    it("returns 404 for the reserved scope id 'default' (it never exists as a real Scope)", async () => {
      const workspaceId = await registerScopedWorkspace();

      const deleted = await handle.app.inject({
        method: "DELETE",
        url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/default`
      });

      expect(deleted.statusCode).toBe(404);
      expect(deleted.json()).toMatchObject({
        error: "scope_not_found",
        scope_id: "default"
      });
    });

    it("rejects deletion of a stale reserved 'default' Scope row with 400 scope_id_reserved", async () => {
      const workspaceId = await registerScopedWorkspace();
      // Simulate a stale legacy row that predates the reserved-id rule.
      const timestamp = new Date().toISOString();
      handle.store.db.prepare(`
        INSERT INTO scopes (workspace_id, scope_id, title, description, created_at, updated_at)
        VALUES (?, 'default', 'Stale Default', NULL, ?, ?)
      `).run(workspaceId, timestamp, timestamp);

      const deleted = await handle.app.inject({
        method: "DELETE",
        url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/default`
      });

      expect(deleted.statusCode).toBe(400);
      expect(deleted.json()).toMatchObject({
        error: "scope_id_reserved",
        workspace_id: workspaceId,
        scope_id: "default"
      });
    });

    it("returns 409 scope_not_empty when Contexts still reference the Scope", async () => {
      const workspaceId = await registerScopedWorkspace();
      await createScope(workspaceId, "research");
      const operator = `actor:${workspaceId}:operator`;
      const floe = `actor:${workspaceId}:floe`;
      registerEndpoint(workspaceId, operator);
      registerEndpoint(workspaceId, floe);

      const emitted = await handle.app.inject({
        method: "POST",
        url: "/v1/events/emit",
        payload: {
          type: "message",
          workspace_id: workspaceId,
          source_endpoint_id: operator,
          destination: { kind: "endpoint", endpoint_id: floe },
          scope_id: "research",
          content: { text: "scoped work" },
          response: { expected: false }
        }
      });
      expect(emitted.statusCode).toBe(202);

      const deleted = await handle.app.inject({
        method: "DELETE",
        url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/research`
      });

      expect(deleted.statusCode).toBe(409);
      expect(deleted.json()).toMatchObject({
        error: "scope_not_empty",
        workspace_id: workspaceId,
        scope_id: "research",
        context_count: 1,
        pulse_count: 0
      });
    });

    it("returns 409 scope_not_empty when Pulses still reference the Scope", async () => {
      const workspaceId = await registerScopedWorkspace();
      await createScope(workspaceId, "research");
      const floe = `actor:${workspaceId}:floe`;
      registerEndpoint(workspaceId, floe);

      const created = await handle.app.inject({
        method: "POST",
        url: "/v1/pulses",
        payload: {
          pulse_id: "research-reminder",
          workspace_id: workspaceId,
          persistence: "workspace",
          scope_id: "research",
          trigger: { type: "once", at: new Date(Date.now() + 60_000).toISOString() },
          event: { type: "pulse.fired", content: { text: "reminder" } },
          subscribers: [{ kind: "endpoint", endpoint_ref: floe }],
          created_by: "test"
        }
      });
      expect(created.statusCode).toBe(201);

      const deleted = await handle.app.inject({
        method: "DELETE",
        url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/research`
      });

      expect(deleted.statusCode).toBe(409);
      expect(deleted.json()).toMatchObject({
        error: "scope_not_empty",
        workspace_id: workspaceId,
        scope_id: "research",
        pulse_count: 1
      });
    });

    it("returns 404 workspace_not_found for an unknown workspace", async () => {
      const deleted = await handle.app.inject({
        method: "DELETE",
        url: "/v1/workspaces/workspace%3Amissing/scopes/research"
      });

      expect(deleted.statusCode).toBe(404);
      expect(deleted.json()).toMatchObject({ error: "workspace_not_found" });
    });
  });
});
