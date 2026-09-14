import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyCapabilityGrantSchema,
  CapabilityGrantReferenceError,
  SqliteCapabilityGrantStore,
  hostCapabilityPolicyGrantId,
  hostCapabilityPolicyId,
} from "./capability-grants.js";

const issuedAt = "2026-09-03T12:00:00.000Z";
const expiresAt = "2026-09-03T13:00:00.000Z";

describe("CapabilityGrant persistence and authority", () => {
  const openDatabases: DatabaseSync[] = [];
  const cleanupDirectories: string[] = [];

  afterEach(() => {
    for (const db of openDatabases.splice(0)) db.close();
    for (const directory of cleanupDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function memoryStore(now = issuedAt): SqliteCapabilityGrantStore {
    const db = new DatabaseSync(":memory:");
    openDatabases.push(db);
    applyCapabilityGrantSchema(db);
    return new SqliteCapabilityGrantStore(db, { now: () => now });
  }

  function issue(
    store: SqliteCapabilityGrantStore,
    overrides: Partial<Parameters<SqliteCapabilityGrantStore["issueGrant"]>[0]> = {},
  ) {
    return store.issueGrant({
      principal_id: "principal:acme-operator",
      boundary: { kind: "workspace", workspace_id: "workspace:acme" },
      operation_ids: ["scope.inspect"],
      expires_at: expiresAt,
      issuer_id: "principal:acme-owner",
      evidence: [{ kind: "approval", ref: "approval:acme-access" }],
      ...overrides,
    });
  }

  it("persists an opaque grant with normalized operations, targets, issuer, and evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "floe-capability-grant-"));
    cleanupDirectories.push(directory);
    const path = join(directory, "bus.sqlite");
    const db = new DatabaseSync(path);
    applyCapabilityGrantSchema(db);
    const store = new SqliteCapabilityGrantStore(db, {
      now: () => issuedAt,
      grant_id_factory: () => "capgrant_6fe4b82f-30c6-442f-b6c6-c9a4148ff332",
    });
    const grant = issue(store, {
      operation_ids: ["scope.retire", "scope.inspect", "scope.retire"],
      targets: [
        { kind: "scope", id: "scope:planning" },
        { kind: "scope", id: null },
        { kind: "scope", id: "scope:planning" },
      ],
      evidence: [
        { kind: "policy", ref: "policy:workspace-owner" },
        { kind: "approval", ref: "approval:acme-access" },
      ],
    });

    expect(grant).toEqual({
      grant_id: "capgrant_6fe4b82f-30c6-442f-b6c6-c9a4148ff332",
      principal_id: "principal:acme-operator",
      boundary: { kind: "workspace", workspace_id: "workspace:acme" },
      operation_ids: ["scope.inspect", "scope.retire"],
      targets: [
        { kind: "scope", id: null },
        { kind: "scope", id: "scope:planning" },
      ],
      issued_at: issuedAt,
      expires_at: expiresAt,
      revoked_at: null,
      issuer_id: "principal:acme-owner",
      evidence: [
        { kind: "approval", ref: "approval:acme-access" },
        { kind: "policy", ref: "policy:workspace-owner" },
      ],
    });
    expect(grant.grant_id).not.toContain(grant.principal_id);
    expect(grant.grant_id).not.toContain("workspace:acme");
    db.close();

    const reopened = new DatabaseSync(path);
    openDatabases.push(reopened);
    const reopenedStore = new SqliteCapabilityGrantStore(reopened, { now: () => issuedAt });
    expect(reopenedStore.getGrant(grant.grant_id)).toEqual(grant);
  });

  it("refuses grants without bounded operations, evidence, or a future expiry", () => {
    const store = memoryStore();
    expect(() => issue(store, { operation_ids: [] })).toThrow("operation_id list must not be empty");
    expect(() => issue(store, { evidence: [] })).toThrow("evidence must not be empty");
    expect(() => issue(store, { expires_at: issuedAt })).toThrow("expiry must be after its issue time");
    expect(() => issue(store, { targets: [{ kind: "scope", id: "" }] })).toThrow("target id must not be empty");
  });

  it("persists host authority without manufacturing a Workspace and refuses cross-boundary reuse", () => {
    const store = memoryStore("2026-09-03T12:10:00.000Z");
    const grant = issue(store, {
      boundary: { kind: "host", host_id: "host:desktop" },
      operation_ids: ["workspace.register"],
    });
    expect(grant).toMatchObject({
      boundary: { kind: "host", host_id: "host:desktop" },
    });
    expect(store.listActiveGrantsForPrincipalBoundary(
      grant.principal_id,
      { kind: "host", host_id: "host:desktop" },
    )).toEqual([grant]);

    const hostSession = {
      principal_id: grant.principal_id,
      boundary: { kind: "host" as const, host_id: "host:desktop" },
      grant_ids: [grant.grant_id],
      interaction: {
        mode: "interactive" as const,
        session_id: "host-window",
        confirmed_prompts: [],
        approval_refs: [],
      },
    };
    expect(store.resolveSessionAuthority(hostSession, null).authority).toMatchObject({
      boundary: { kind: "host", host_id: "host:desktop" },
      grants: new Set(["workspace.register"]),
    });
    expect(store.inspectSessionGrantIds({
      principal_id: grant.principal_id,
      boundary: { kind: "workspace", workspace_id: "workspace:acme" },
      grant_ids: [grant.grant_id],
    }).unavailable_grants).toEqual([
      { grant_id: grant.grant_id, code: "grant_boundary_mismatch" },
    ]);
  });

  it("allows a trusted session to store only active grant IDs for its exact principal and Workspace", () => {
    const store = memoryStore("2026-09-03T12:10:00.000Z");
    const valid = issue(store);
    const otherPrincipal = issue(store, { principal_id: "principal:acme-reviewer" });
    const otherWorkspace = issue(store, {
      boundary: { kind: "workspace", workspace_id: "workspace:other" },
    });

    expect(store.requireActiveSessionGrantIds({
      principal_id: valid.principal_id,
      boundary: { kind: "workspace", workspace_id: "workspace:acme" },
      grant_ids: [valid.grant_id, valid.grant_id],
    })).toEqual([valid.grant_id]);

    for (const grantId of ["scope.inspect", otherPrincipal.grant_id, otherWorkspace.grant_id]) {
      try {
        store.requireActiveSessionGrantIds({
          principal_id: valid.principal_id,
          boundary: { kind: "workspace", workspace_id: "workspace:acme" },
          grant_ids: [grantId],
        });
        throw new Error("Expected the grant reference to be refused");
      } catch (error) {
        expect(error).toBeInstanceOf(CapabilityGrantReferenceError);
      }
    }
  });

  it("derives operations from current grants and applies resource targets without widening them", () => {
    const store = memoryStore("2026-09-03T12:10:00.000Z");
    const workspaceGrant = issue(store, { operation_ids: ["workspace.inspect"] });
    const kindGrant = issue(store, {
      operation_ids: ["scope.inspect"],
      targets: [{ kind: "scope", id: null }],
    });
    const exactGrant = issue(store, {
      operation_ids: ["scope.retire"],
      targets: [{ kind: "scope", id: "scope:planning" }],
    });
    const session = {
      principal_id: "principal:acme-operator",
      boundary: { kind: "workspace" as const, workspace_id: "workspace:acme" },
      grant_ids: [workspaceGrant.grant_id, kindGrant.grant_id, exactGrant.grant_id, "scope.compose"],
      interaction: {
        mode: "brokered" as const,
        session_id: "interaction:acme-desktop",
        broker_id: "broker:trusted-native",
        confirmed_prompts: ["confirm:retire"],
        approval_refs: new Set(["approval:retire"]),
      },
    };

    const planning = store.resolveSessionAuthority(session, { kind: "scope", id: "scope:planning" });
    expect(planning.authority.grants).toEqual(new Set([
      "workspace.inspect",
      "scope.inspect",
      "scope.retire",
    ]));
    expect(planning.unavailable_grants).toEqual([
      { grant_id: "scope.compose", code: "grant_not_found" },
    ]);
    expect(planning.authority.interaction).toEqual({
      mode: "brokered",
      session_id: "interaction:acme-desktop",
      broker_id: "broker:trusted-native",
      confirmed_prompts: new Set(["confirm:retire"]),
      approval_refs: new Set(["approval:retire"]),
    });

    const otherScope = store.resolveSessionAuthority(session, { kind: "scope", id: "scope:delivery" });
    expect(otherScope.authority.grants).toEqual(new Set(["workspace.inspect", "scope.inspect"]));

    const noTarget = store.resolveSessionAuthority(session, null);
    expect(noTarget.authority.grants).toEqual(new Set(["workspace.inspect"]));
    expect(noTarget.applicable_grant_ids).toEqual([workspaceGrant.grant_id]);
  });

  it("removes a revoked grant from an existing session immediately without changing interaction state", () => {
    const store = memoryStore("2026-09-03T12:10:00.000Z");
    const inspectGrant = issue(store, { operation_ids: ["scope.inspect"] });
    const retireGrant = issue(store, { operation_ids: ["scope.retire"] });
    const session = {
      principal_id: inspectGrant.principal_id,
      boundary: { kind: "workspace" as const, workspace_id: "workspace:acme" },
      grant_ids: [inspectGrant.grant_id, retireGrant.grant_id],
      interaction: {
        mode: "interactive" as const,
        session_id: "interaction:acme-desktop",
        confirmed_prompts: ["confirm:retire"],
        approval_refs: ["approval:retire"],
      },
    };

    expect(store.resolveSessionAuthority(session, null).authority.grants)
      .toEqual(new Set(["scope.inspect", "scope.retire"]));
    expect(store.revokeGrant(retireGrant.grant_id, "2026-09-03T12:11:00.000Z")).toBe(true);

    const resolved = store.resolveSessionAuthority(session, null);
    expect(resolved.authority.grants).toEqual(new Set(["scope.inspect"]));
    expect(resolved.active_grant_ids).toEqual([inspectGrant.grant_id]);
    expect(resolved.unavailable_grants).toEqual([
      { grant_id: retireGrant.grant_id, code: "grant_revoked" },
    ]);
    expect(resolved.authority.interaction.confirmed_prompts).toEqual(new Set(["confirm:retire"]));
    expect(resolved.authority.interaction.approval_refs).toEqual(new Set(["approval:retire"]));
  });

  it("treats expiry as inactive when an existing session is verified again", () => {
    const db = new DatabaseSync(":memory:");
    openDatabases.push(db);
    applyCapabilityGrantSchema(db);
    let now = issuedAt;
    const store = new SqliteCapabilityGrantStore(db, { now: () => now });
    const grant = issue(store, { expires_at: "2026-09-03T12:15:00.000Z" });
    const session = {
      principal_id: grant.principal_id,
      boundary: { kind: "workspace" as const, workspace_id: "workspace:acme" },
      grant_ids: [grant.grant_id],
      interaction: {
        mode: "unattended" as const,
        session_id: "delivery:acme-42",
        confirmed_prompts: [],
        approval_refs: [],
      },
    };

    expect(store.resolveSessionAuthority(session, null).authority.grants).toEqual(new Set(["scope.inspect"]));
    now = "2026-09-03T12:15:00.000Z";
    const expired = store.resolveSessionAuthority(session, null);
    expect(expired.authority.grants).toEqual(new Set());
    expect(expired.unavailable_grants).toEqual([{ grant_id: grant.grant_id, code: "grant_expired" }]);
    expect(() => store.requireActiveSessionGrantIds(session)).toThrow(CapabilityGrantReferenceError);
  });

  it("migrates Workspace-only grants and preserves targets and secret constraints", () => {
    const db = new DatabaseSync(":memory:");
    openDatabases.push(db);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`
      CREATE TABLE capability_grants (
        grant_id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        issuer_id TEXT NOT NULL,
        evidence_json TEXT NOT NULL
      );
      CREATE TABLE capability_grant_operations (
        grant_id TEXT NOT NULL REFERENCES capability_grants(grant_id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL,
        PRIMARY KEY (grant_id, operation_id)
      );
      CREATE TABLE capability_grant_targets (
        grant_id TEXT NOT NULL REFERENCES capability_grants(grant_id) ON DELETE CASCADE,
        target_kind TEXT NOT NULL,
        target_id TEXT
      );
      CREATE TABLE secret_refs (
        secret_ref_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        PRIMARY KEY (workspace_id, secret_ref_id)
      );
      CREATE TABLE secret_grant_constraints (
        grant_id TEXT PRIMARY KEY REFERENCES capability_grants(grant_id) ON DELETE CASCADE,
        secret_ref_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        FOREIGN KEY (workspace_id, secret_ref_id) REFERENCES secret_refs(workspace_id, secret_ref_id)
      );
      CREATE TABLE secret_grant_constraint_purposes (
        grant_id TEXT NOT NULL REFERENCES secret_grant_constraints(grant_id) ON DELETE CASCADE,
        purpose TEXT NOT NULL,
        PRIMARY KEY (grant_id, purpose)
      );
      INSERT INTO capability_grants VALUES (
        'grant:legacy', 'principal:legacy', 'workspace:legacy',
        '${issuedAt}', '${expiresAt}', NULL, 'principal:owner',
        '[{"kind":"approval","ref":"approval:legacy"}]'
      );
      INSERT INTO capability_grant_operations VALUES ('grant:legacy', 'scope.inspect');
      INSERT INTO capability_grant_targets VALUES ('grant:legacy', 'scope', 'scope:legacy');
      INSERT INTO secret_refs VALUES ('secret:legacy', 'workspace:legacy');
      INSERT INTO secret_grant_constraints VALUES ('grant:legacy', 'secret:legacy', 'workspace:legacy');
      INSERT INTO secret_grant_constraint_purposes VALUES ('grant:legacy', 'outcome-delivery');
    `);

    applyCapabilityGrantSchema(db);
    const migrated = new SqliteCapabilityGrantStore(db, { now: () => issuedAt }).getGrant("grant:legacy");
    expect(migrated).toMatchObject({
      boundary: { kind: "workspace", workspace_id: "workspace:legacy" },
      operation_ids: ["scope.inspect"],
      targets: [{ kind: "scope", id: "scope:legacy" }],
    });
    expect(db.prepare("SELECT * FROM secret_grant_constraints").get()).toMatchObject({
      grant_id: "grant:legacy",
      secret_ref_id: "secret:legacy",
      workspace_id: "workspace:legacy",
    });
    expect(db.prepare("SELECT * FROM secret_grant_constraint_purposes").get()).toMatchObject({
      grant_id: "grant:legacy",
      purpose: "outcome-delivery",
    });
  });

  it("activates one deterministic host policy revision and explicitly supersedes the previous grant", () => {
    const store = memoryStore("2026-09-03T12:10:00.000Z");
    const base = {
      host_id: "host:desktop",
      principal_id: "principal:local-operator:opaque",
      purpose: "desktop-workspace-lifecycle",
      operation_ids: ["workspace.register", "workspace.restore"],
      expires_at: expiresAt,
      issuer_id: "policy:floe-host-operator",
      evidence: [{ kind: "policy", ref: "host-operator-policy:v1" }],
    } as const;
    const first = store.activateHostPolicyGrant({ ...base, policy_revision: "1" });
    const replay = store.activateHostPolicyGrant({ ...base, policy_revision: "1" });

    expect(replay).toEqual({ ...first, replayed: true });
    expect(first).toMatchObject({
      replayed: false,
      policy: {
        host_policy_id: hostCapabilityPolicyId(base.host_id, base.purpose),
        policy_revision: "1",
        host_id: base.host_id,
        principal_id: base.principal_id,
        supersedes_grant_id: null,
      },
      grant: {
        grant_id: hostCapabilityPolicyGrantId(
          hostCapabilityPolicyId(base.host_id, base.purpose),
          "1",
        ),
        boundary: { kind: "host", host_id: base.host_id },
      },
    });

    expect(() => store.activateHostPolicyGrant({
      ...base,
      policy_revision: "1",
      operation_ids: ["workspace.register"],
    })).toThrow("already identifies different authority");

    const second = store.activateHostPolicyGrant({
      ...base,
      policy_revision: "2",
      operation_ids: ["workspace.register", "workspace.restore", "workspace.copy"],
      evidence: [{ kind: "policy", ref: "host-operator-policy:v2" }],
    });
    expect(second.policy.supersedes_grant_id).toBe(first.grant.grant_id);
    expect(store.getGrant(first.grant.grant_id)?.revoked_at).toBe("2026-09-03T12:10:00.000Z");
    expect(store.listHostPolicyHistory(base.host_id, base.purpose)).toMatchObject([
      { policy_revision: "2", superseded_at: null },
      {
        policy_revision: "1",
        superseded_by_grant_id: second.grant.grant_id,
        superseded_at: "2026-09-03T12:10:00.000Z",
      },
    ]);
    expect(store.listActiveGrantsForPrincipalBoundary(
      base.principal_id,
      { kind: "host", host_id: base.host_id },
    )).toEqual([second.grant]);
    expect(() => store.activateHostPolicyGrant({ ...base, policy_revision: "1" }))
      .toThrow("has been superseded and cannot be reactivated");
  });

  it("persists the active host policy across restart and never revives an expired or revoked revision", () => {
    const directory = mkdtempSync(join(tmpdir(), "floe-host-policy-"));
    cleanupDirectories.push(directory);
    const path = join(directory, "bus.sqlite");
    let now = issuedAt;
    const firstDb = new DatabaseSync(path);
    openDatabases.push(firstDb);
    applyCapabilityGrantSchema(firstDb);
    const firstStore = new SqliteCapabilityGrantStore(firstDb, { now: () => now });
    const input = {
      host_id: "host:desktop",
      principal_id: "principal:local-operator:opaque",
      purpose: "desktop-workspace-lifecycle",
      policy_revision: "2026-09-04",
      operation_ids: ["workspace.register"],
      expires_at: "2026-09-03T12:15:00.000Z",
      issuer_id: "policy:floe-host-operator",
      evidence: [{ kind: "policy", ref: "host-operator-policy:2026-09-04" }],
    } as const;
    const issued = firstStore.activateHostPolicyGrant(input);
    firstDb.close();
    openDatabases.splice(openDatabases.indexOf(firstDb), 1);

    const reopenedDb = new DatabaseSync(path);
    openDatabases.push(reopenedDb);
    const reopenedStore = new SqliteCapabilityGrantStore(reopenedDb, { now: () => now });
    expect(reopenedStore.getActiveHostPolicyRevision(issued.policy.host_policy_id))
      .toEqual(issued.policy);
    expect(reopenedStore.activateHostPolicyGrant(input)).toEqual({ ...issued, replayed: true });

    now = "2026-09-03T12:15:00.000Z";
    expect(() => reopenedStore.activateHostPolicyGrant(input))
      .toThrow("has expired and cannot be reactivated");

    now = "2026-09-03T12:14:00.000Z";
    expect(reopenedStore.revokeGrant(issued.grant.grant_id, now)).toBe(true);
    expect(() => reopenedStore.activateHostPolicyGrant(input)).toThrow("cannot be reactivated");
  });

  it("removes the redundant Workspace projection from the boundary-aware grant schema without losing rows", () => {
    const db = new DatabaseSync(":memory:");
    openDatabases.push(db);
    db.exec(`
      CREATE TABLE capability_grants (
        grant_id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        boundary_kind TEXT NOT NULL,
        boundary_id TEXT NOT NULL,
        workspace_id TEXT,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        issuer_id TEXT NOT NULL,
        evidence_json TEXT NOT NULL
      );
      CREATE TABLE capability_grant_operations (
        grant_id TEXT NOT NULL REFERENCES capability_grants(grant_id),
        operation_id TEXT NOT NULL,
        PRIMARY KEY (grant_id, operation_id)
      );
      CREATE TABLE capability_grant_targets (
        grant_id TEXT NOT NULL REFERENCES capability_grants(grant_id),
        target_kind TEXT NOT NULL,
        target_id TEXT
      );
      INSERT INTO capability_grants VALUES (
        'grant:host', 'principal:operator', 'host', 'host:desktop', NULL,
        '${issuedAt}', '${expiresAt}', NULL, 'policy:host',
        '[{"kind":"policy","ref":"policy:host-v1"}]'
      );
      INSERT INTO capability_grant_operations VALUES ('grant:host', 'workspace.register');
    `);

    applyCapabilityGrantSchema(db);
    expect((db.prepare("PRAGMA table_info(capability_grants)").all() as Array<{ name: string }>)
      .map((column) => column.name)).not.toContain("workspace_id");
    expect(new SqliteCapabilityGrantStore(db, { now: () => issuedAt }).getGrant("grant:host"))
      .toMatchObject({
        boundary: { kind: "host", host_id: "host:desktop" },
        operation_ids: ["workspace.register"],
      });
  });
});
