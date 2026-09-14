import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { defaultConfig, type LocalConfig } from "./config.js";
import { CURRENT_BUS_SCHEMA_VERSION } from "./database-upgrade.js";
import { createBusServer } from "./server.js";
import {
  INSPECT_WORKSPACE_OPERATION_ID,
  REGISTER_WORKSPACE_OPERATION_ID,
  RESTORE_WORKSPACE_OPERATION_ID,
} from "./workspace-operations.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;
const HOST_CONTROL_TOKEN = `workspace-identity-host-${"h".repeat(40)}`;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(): Promise<{
  handle: ServerHandle;
  root: string;
  configPath: string;
  config: LocalConfig;
}> {
  const root = mkdtempSync(join(tmpdir(), "floe-workspace-identity-server-"));
  roots.push(root);
  const configPath = join(root, "config.yaml");
  const config: LocalConfig = defaultConfig(root);
  writeFileSync(configPath, YAML.stringify(config), "utf8");
  const handle = await createBusServer(configPath, config, { host_control_token: HOST_CONTROL_TOKEN });
  await handle.app.ready();
  return { handle, root, configPath, config };
}

function localHeaders(handle: ServerHandle) {
  return { authorization: `Bearer ${handle.localControlToken}` };
}

describe("Workspace identity HTTP boundaries", () => {
  it("upgrades a retained schema 12 installation before reading delegation authority", async () => {
    const { handle, configPath, config } = await fixture();
    const grant = handle.store.capabilityGrantStore.issueGrant({
      principal_id: "principal:retained", boundary: { kind: "workspace", workspace_id: "workspace:retained" },
      operation_ids: ["context.inspect"], expires_at: "2099-01-01T00:00:00.000Z",
      issuer_id: "policy:test", evidence: [{ kind: "policy", ref: "test:retained" }],
    });
    // The installed schema 12 predates delegation. Preserve its existing grants.
    handle.store.db.exec("DROP TABLE capability_grant_delegations; PRAGMA user_version = 12;");
    await handle.app.close();

    const reopened = await createBusServer(configPath, config, { host_control_token: HOST_CONTROL_TOKEN });
    try {
      await reopened.app.ready();
      expect(reopened.store.capabilityGrantStore.listActiveGrantsForPrincipalBoundary(
        grant.principal_id, grant.boundary,
      )).toEqual([grant]);
      expect(reopened.store.capabilityGrantStore.getDelegation(grant.grant_id)).toBeNull();
      const migration = reopened.store.db.prepare(
        "SELECT previous_version, backup_path FROM schema_migrations WHERE schema_version = ?",
      ).get(CURRENT_BUS_SCHEMA_VERSION) as { previous_version: number; backup_path: string };
      expect(migration.previous_version).toBe(12);
      const backup = new DatabaseSync(migration.backup_path, { readOnly: true });
      try {
        expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(backup.prepare("SELECT grant_id FROM capability_grants WHERE grant_id = ?").get(grant.grant_id))
          .toEqual({ grant_id: grant.grant_id });
        expect(backup.prepare("SELECT name FROM sqlite_schema WHERE name = 'capability_grant_delegations'").get())
          .toBeUndefined();
      } finally { backup.close(); }
      expect(reopened.store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { await reopened.app.close(); }
  });

  it("keeps host paths behind local authentication and excludes bootstrap from Workspace authority", async () => {
    const { handle, root } = await fixture();
    const locator = join(root, "private-workspace");
    mkdirSync(locator, { recursive: true });
    try {
      const unauthorised = await handle.app.inject({
        method: "POST",
        url: "/v1/workspaces/register",
        payload: { locator, name: "Private" },
      });
      expect(unauthorised.statusCode).toBe(401);
      expect(unauthorised.json().error).toBe("transport_auth_required");

      const registered = await handle.app.inject({
        method: "POST",
        url: "/v1/workspaces/register",
        headers: localHeaders(handle),
        payload: { locator, name: "Private" },
      });
      expect(registered.statusCode).toBe(201);
      const localWorkspace = registered.json().workspace;
      const workspaceId = localWorkspace.workspace_id as string;
      expect(workspaceId).toMatch(/^workspace_/);
      expect(workspaceId).not.toContain("private-workspace");
      expect(localWorkspace).toMatchObject({ locator, binding_id: expect.any(String) });

      const remote = await handle.app.inject({
        method: "GET",
        url: "/v1/workspaces",
        headers: localHeaders(handle),
      });
      expect(remote.statusCode).toBe(200);
      expect(remote.json().workspaces[0]).toMatchObject({
        workspace_id: workspaceId,
        availability: { bound_on_serving_host: true, status: "registered" },
      });
      expect(JSON.stringify(remote.json())).not.toContain(locator);
      expect(remote.json().workspaces[0]).not.toHaveProperty("locator");
      expect(remote.json().workspaces[0]).not.toHaveProperty("binding_id");
      expect(remote.json().workspaces[0]).not.toHaveProperty("host_id");

      const localDenied = await handle.app.inject({ method: "GET", url: "/v1/local/workspaces" });
      expect(localDenied.statusCode).toBe(401);
      const local = await handle.app.inject({
        method: "GET",
        url: "/v1/local/workspaces",
        headers: localHeaders(handle),
      });
      expect(local.statusCode).toBe(200);
      expect(local.json().workspaces[0]).toMatchObject({ locator, binding_id: expect.any(String) });

      const principalId = "principal:desktop";
      const expiresAt = "2099-01-01T00:00:00.000Z";
      const bootstrapGrant = handle.store.capabilityGrantStore.issueGrant({
        principal_id: principalId,
        boundary: { kind: "workspace", workspace_id: workspaceId },
        operation_ids: ["workspace.create", "workspace.restore"],
        expires_at: expiresAt,
        issuer_id: "principal:local-owner",
        evidence: [{ kind: "local_control", ref: "test:workspace-bootstrap-boundary" }],
      });
      const workspaceGrant = handle.store.capabilityGrantStore.issueGrant({
        principal_id: principalId,
        boundary: { kind: "workspace", workspace_id: workspaceId },
        operation_ids: [
          "workspace.inspect",
          "workspace.rebind",
          "workspace.copy",
          "workspace.fork",
        ],
        targets: [{ kind: "workspace", id: workspaceId }],
        expires_at: expiresAt,
        issuer_id: "principal:local-owner",
        evidence: [{ kind: "local_control", ref: "test:workspace-actions" }],
      });
      const authorityToken = handle.store.operationAuthoritySessions.issueSession({
        principal_id: principalId,
        workspace_id: workspaceId,
        grant_ids: [bootstrapGrant.grant_id, workspaceGrant.grant_id],
        interaction: { mode: "interactive", session_id: "window:workspace" },
        provenance: {
          cause_event_id: null,
          delivery_ids: [],
          execution_attempt_id: null,
          node_execution_id: null,
          scope_execution_id: null,
        },
        expires_at: expiresAt,
      }).bearer_token;
      const bootstrapOperations = await handle.app.inject({
        method: "GET",
        url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations`,
        headers: { authorization: `Bearer ${authorityToken}` },
      });
      expect(bootstrapOperations.statusCode).toBe(200);
      const bootstrapOperationIds = bootstrapOperations.json().operations
        .map((item: { operation_id: string }) => item.operation_id);
      expect(bootstrapOperationIds).not.toContain(REGISTER_WORKSPACE_OPERATION_ID);
      expect(bootstrapOperationIds).not.toContain(RESTORE_WORKSPACE_OPERATION_ID);
      const operations = await handle.app.inject({
        method: "GET",
        url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations?target_kind=workspace&target_id=${encodeURIComponent(workspaceId)}`,
        headers: { authorization: `Bearer ${authorityToken}` },
      });
      expect(operations.statusCode).toBe(200);
      const operationIds = operations.json().operations.map((item: { operation_id: string }) => item.operation_id);
      expect(operationIds).toContain(INSPECT_WORKSPACE_OPERATION_ID);
      expect(operationIds).not.toContain(REGISTER_WORKSPACE_OPERATION_ID);
      expect(operationIds).not.toContain(RESTORE_WORKSPACE_OPERATION_ID);

      const bootstrapAttempt = await handle.app.inject({
        method: "POST",
        url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations/invoke`,
        headers: { authorization: `Bearer ${authorityToken}` },
        payload: {
          operation_id: REGISTER_WORKSPACE_OPERATION_ID,
          operation_version: "1",
          input_schema_version: "1",
          idempotency_key: "workspace-session-must-not-bootstrap",
          input: { locator: join(root, "must-not-exist") },
        },
      });
      expect(bootstrapAttempt.statusCode).toBe(200);
      expect(bootstrapAttempt.json()).toMatchObject({
        kind: "receipt",
        receipt: { refusal: { code: "operation_authority_boundary_not_supported" } },
      });

      const inspected = await handle.app.inject({
        method: "POST",
        url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations/invoke`,
        headers: { authorization: `Bearer ${authorityToken}` },
        payload: {
          operation_id: INSPECT_WORKSPACE_OPERATION_ID,
          operation_version: "1",
          input_schema_version: "1",
          target: { kind: "workspace", id: workspaceId },
          idempotency_key: "inspect-without-path",
          input: {},
        },
      });
      expect(inspected.statusCode).toBe(200);
      expect(inspected.json()).toMatchObject({
        kind: "receipt",
        receipt: { state: "completed", result: { workspace: { workspace_id: workspaceId } } },
      });
      expect(JSON.stringify(inspected.json())).not.toContain(locator);
    } finally {
      await handle.app.close();
    }
  });

  it("rebinding preserves identity, rejects stale callbacks, and distinguishes restore, copy, and fork", async () => {
    const { handle, root } = await fixture();
    const bridgeCredential = handle.issueBridgeServiceCredential("bridge:test");
    const bridgeHeaders = { authorization: `Bearer ${bridgeCredential.bearer_token}` };
    const bridgeRegistration = await handle.app.inject({
      method: "POST",
      url: "/v1/bridges/register",
      headers: bridgeHeaders,
      payload: { capabilities: {} },
    });
    expect(bridgeRegistration.statusCode).toBe(201);
    const firstPath = join(root, "first");
    const movedPath = join(root, "moved");
    for (const path of [firstPath, movedPath]) mkdirSync(path, { recursive: true });
    try {
      const registered = await handle.app.inject({
        method: "POST",
        url: "/v1/workspaces/register",
        headers: localHeaders(handle),
        payload: { locator: firstPath, name: "Movable" },
      });
      const original = registered.json().workspace;
      const rebound = await handle.app.inject({
        method: "POST",
        url: `/v1/local/workspaces/${encodeURIComponent(original.workspace_id)}/rebind`,
        headers: localHeaders(handle),
        payload: { locator: movedPath, expected_binding_id: original.binding_id },
      });
      expect(rebound.statusCode).toBe(200);
      expect(rebound.json().workspace).toMatchObject({
        workspace_id: original.workspace_id,
        locator: movedPath,
        binding_id: expect.not.stringMatching(original.binding_id),
      });
      const newBindingId = rebound.json().workspace.binding_id as string;

      const staleCallback = await handle.app.inject({
        method: "POST",
        url: `/v1/workspaces/${encodeURIComponent(original.workspace_id)}/attachment-result`,
        headers: bridgeHeaders,
        payload: {
          bridge_id: "bridge:test",
          binding_id: original.binding_id,
          status: "attached",
          config_hash: "stale",
        },
      });
      expect(staleCallback.statusCode).toBe(409);
      expect(staleCallback.json()).toMatchObject({ error: "workspace_binding_changed", retryable: true });

      const currentCallback = await handle.app.inject({
        method: "POST",
        url: `/v1/workspaces/${encodeURIComponent(original.workspace_id)}/attachment-result`,
        headers: bridgeHeaders,
        payload: {
          bridge_id: "bridge:test",
          binding_id: newBindingId,
          status: "attached",
          config_hash: "current",
        },
      });
      expect(currentCallback.statusCode).toBe(200);
      expect(currentCallback.json().workspace).toMatchObject({
        workspace_id: original.workspace_id,
        locator: movedPath,
        active_config_hash: null,
      });

      const restoredPath = join(root, "restored");
      const copiedPath = join(root, "copied");
      const forkedPath = join(root, "forked");
      for (const path of [restoredPath, copiedPath, forkedPath]) mkdirSync(path, { recursive: true });
      const restoredIdentity = {
        workspace_id: "workspace_retained_elsewhere",
        name: "Restored",
        creation_kind: "legacy_retained",
        source_workspace_id: null,
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
      };
      const restored = await handle.app.inject({
        method: "POST",
        url: "/v1/local/workspaces/restore",
        headers: localHeaders(handle),
        payload: { snapshot: restoredIdentity, locator: restoredPath },
      });
      expect(restored.statusCode).toBe(201);
      expect(restored.json().workspace).toMatchObject({
        workspace_id: restoredIdentity.workspace_id,
        locator: restoredPath,
      });

      const copy = await handle.app.inject({
        method: "POST",
        url: `/v1/local/workspaces/${encodeURIComponent(original.workspace_id)}/copy-identity`,
        headers: localHeaders(handle),
        payload: { name: "Copy", locator: copiedPath },
      });
      const fork = await handle.app.inject({
        method: "POST",
        url: `/v1/local/workspaces/${encodeURIComponent(original.workspace_id)}/fork-identity`,
        headers: localHeaders(handle),
        payload: { name: "Fork", locator: forkedPath },
      });
      expect(copy.statusCode).toBe(201);
      expect(fork.statusCode).toBe(201);
      expect(copy.json().workspace).toMatchObject({
        creation_kind: "copied",
        source_workspace_id: original.workspace_id,
        locator: copiedPath,
      });
      expect(fork.json().workspace).toMatchObject({
        creation_kind: "forked",
        source_workspace_id: original.workspace_id,
        locator: forkedPath,
      });
      expect(new Set([
        original.workspace_id,
        restored.json().workspace.workspace_id,
        copy.json().workspace.workspace_id,
        fork.json().workspace.workspace_id,
      ]).size).toBe(4);

      const remote = await handle.app.inject({
        method: "GET",
        url: "/v1/workspaces",
        headers: localHeaders(handle),
      });
      const serialized = JSON.stringify(remote.json());
      for (const path of [firstPath, movedPath, restoredPath, copiedPath, forkedPath]) {
        expect(serialized).not.toContain(path);
      }
    } finally {
      await handle.app.close();
    }
  });
});

describe("Workspace identity database upgrade", () => {
  it("backs up legacy rows, retains every identity and state field, and does not duplicate migration", async () => {
    const root = mkdtempSync(join(tmpdir(), "floe-workspace-identity-upgrade-"));
    roots.push(root);
    const configPath = join(root, "config.yaml");
    const config: LocalConfig = defaultConfig(root);
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    const dataDir = join(root, "bus");
    mkdirSync(dataDir, { recursive: true });
    const databasePath = join(dataDir, "floe-bus.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE workspaces (
        workspace_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        locator TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        init_authorized INTEGER NOT NULL DEFAULT 0,
        active_config_hash TEXT,
        selected_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE retained_evidence (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO retained_evidence VALUES ('evidence:1', 'preserve me');
      PRAGMA user_version = 2;
    `);
    const insert = legacy.prepare(`
      INSERT INTO workspaces (
        workspace_id, name, locator, status, init_authorized, active_config_hash,
        selected_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      "workspace:legacy-one", "Legacy One", join(root, "legacy-one"), "attached", 1,
      "hash-one", "2026-09-03T01:00:00.000Z", "2026-08-01T00:00:00.000Z", "2026-09-03T01:00:00.000Z",
    );
    insert.run(
      "workspace:legacy-two", "Legacy Two", join(root, "legacy-two"), "registered", 0,
      null, null, "2026-08-02T00:00:00.000Z", "2026-09-03T02:00:00.000Z",
    );
    legacy.close();

    const first = await createBusServer(configPath, config, { host_control_token: HOST_CONTROL_TOKEN });
    await first.app.ready();
    try {
      expect(first.store.listWorkspaces()).toHaveLength(2);
      expect(first.store.getWorkspace("workspace:legacy-one")).toMatchObject({
        workspace_id: "workspace:legacy-one",
        creation_kind: "legacy_retained",
        status: "attached",
        init_authorized: true,
        active_config_hash: "hash-one",
        selected_at: "2026-09-03T01:00:00.000Z",
      });
      expect(first.store.getWorkspace("workspace:legacy-two")).toMatchObject({
        workspace_id: "workspace:legacy-two",
        creation_kind: "legacy_retained",
        status: "registered",
        init_authorized: false,
      });
      expect(first.store.db.prepare("SELECT * FROM retained_evidence").get()).toEqual({
        id: "evidence:1",
        value: "preserve me",
      });
      const columns = (first.store.db.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>)
        .map((item) => item.name);
      expect(columns).not.toContain("locator");
      expect(Number((first.store.db.prepare("SELECT COUNT(*) AS count FROM workspace_locator_bindings").get() as { count: number }).count)).toBe(2);

      const migration = first.store.db.prepare(`
        SELECT backup_path FROM schema_migrations WHERE schema_version = ?
      `).get(CURRENT_BUS_SCHEMA_VERSION) as { backup_path: string };
      expect(existsSync(migration.backup_path)).toBe(true);
      const backup = new DatabaseSync(migration.backup_path, { readOnly: true });
      expect(Number((backup.prepare("SELECT COUNT(*) AS count FROM workspaces").get() as { count: number }).count)).toBe(2);
      expect((backup.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).map((item) => item.name))
        .toContain("locator");
      expect(backup.prepare("SELECT value FROM retained_evidence WHERE id = 'evidence:1'").get())
        .toEqual({ value: "preserve me" });
      backup.close();
    } finally {
      await first.app.close();
    }

    const second = await createBusServer(configPath, config, { host_control_token: HOST_CONTROL_TOKEN });
    await second.app.ready();
    try {
      expect(second.store.listWorkspaces()).toHaveLength(2);
      expect(Number((second.store.db.prepare("SELECT COUNT(*) AS count FROM workspace_locator_bindings").get() as { count: number }).count)).toBe(2);
      expect(Number((second.store.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE schema_version = ?").get(CURRENT_BUS_SCHEMA_VERSION) as { count: number }).count)).toBe(1);
    } finally {
      await second.app.close();
    }
  });
});
