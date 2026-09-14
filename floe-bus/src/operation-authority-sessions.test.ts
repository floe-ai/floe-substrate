import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyCapabilityGrantSchema,
  SqliteCapabilityGrantStore,
} from "./capability-grants.js";
import {
  applyOperationAuthoritySessionSchema,
  hashBearerToken,
  OperationAuthorityVerifier,
  SqliteOperationAuthoritySessionStore,
} from "./operation-authority-sessions.js";

const issuedAt = "2026-09-03T12:00:00.000Z";
const expiresAt = "2026-09-03T13:00:00.000Z";
const noProvenance = {
  cause_event_id: null,
  delivery_ids: [],
  execution_attempt_id: null,
  node_execution_id: null,
  scope_execution_id: null,
} as const;

describe("operation authority sessions", () => {
  const openDatabases: DatabaseSync[] = [];
  const cleanupDirectories: string[] = [];

  afterEach(() => {
    for (const db of openDatabases.splice(0)) db.close();
    for (const directory of cleanupDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function stores(now = issuedAt, db = new DatabaseSync(":memory:")) {
    openDatabases.push(db);
    applyCapabilityGrantSchema(db);
    applyOperationAuthoritySessionSchema(db);
    const grants = new SqliteCapabilityGrantStore(db, { now: () => now });
    const sessions = new SqliteOperationAuthoritySessionStore(db, grants, { now: () => now });
    return { db, grants, sessions };
  }

  function issueGrant(
    grants: SqliteCapabilityGrantStore,
    input: {
      principal_id: string;
      workspace_id: string;
      operation_ids: string[];
      targets?: Array<{ kind: string; id: string | null }>;
    },
  ) {
    return grants.issueGrant({
      principal_id: input.principal_id,
      boundary: { kind: "workspace", workspace_id: input.workspace_id },
      operation_ids: input.operation_ids,
      ...(input.targets ? { targets: input.targets } : {}),
      expires_at: expiresAt,
      issuer_id: "principal:acme-owner",
      evidence: [{ kind: "policy", ref: "policy:workspace-owner" }],
    });
  }

  it("derives authority only from current CapabilityGrant records", () => {
    const { grants, sessions } = stores();
    const grant = issueGrant(grants, {
      principal_id: "endpoint:floe",
      workspace_id: "workspace:acme",
      operation_ids: ["scope.plan.inspect", "scope.composition.draft.create"],
      targets: [{ kind: "scope", id: "delivery" }],
    });
    const issued = sessions.issueSession({
      principal_id: "endpoint:floe",
      workspace_id: "workspace:acme",
      grant_ids: [grant.grant_id],
      interaction: {
        mode: "brokered",
        session_id: "delivery:42",
        broker_id: "os-credential-broker",
        confirmed_prompts: ["confirm:compose"],
        approval_refs: ["approval:release"],
      },
      provenance: {
        cause_event_id: "event:source",
        delivery_ids: ["delivery:42", "delivery:upstream"],
        execution_attempt_id: "attempt:42",
        node_execution_id: "node-execution:42",
        scope_execution_id: "scope-execution:42",
      },
      expires_at: expiresAt,
    });
    const verifier = new OperationAuthorityVerifier(sessions, grants, () => "2026-09-03T12:30:00.000Z");

    const verified = verifier.verifyBearerToken(issued.bearer_token, {
      boundary: { kind: "workspace", workspace_id: "workspace:acme" },
      target: { kind: "scope", id: "delivery" },
    });
    expect(verified.verified).toBe(true);
    if (!verified.verified) throw new Error("Expected verified authority");
    expect(verified.authority).toEqual({
      principal_id: "endpoint:floe",
      boundary: { kind: "workspace", workspace_id: "workspace:acme" },
      capability_grant_ids: [grant.grant_id],
      session_capability_grant_ids: [grant.grant_id],
      grants: new Set(["scope.composition.draft.create", "scope.plan.inspect"]),
      interaction: {
        mode: "brokered",
        session_id: "delivery:42",
        broker_id: "os-credential-broker",
        confirmed_prompts: new Set(["confirm:compose"]),
        approval_refs: new Set(["approval:release"]),
      },
    });
    expect(verified.active_grant_ids).toEqual([grant.grant_id]);
    expect(verified.provenance).toEqual({
      cause_event_id: "event:source",
      delivery_ids: ["delivery:42", "delivery:upstream"],
      execution_attempt_id: "attempt:42",
      node_execution_id: "node-execution:42",
      scope_execution_id: "scope-execution:42",
    });
    expect(Object.isFrozen(verified.provenance)).toBe(true);
    expect(Object.isFrozen(verified.provenance.delivery_ids)).toBe(true);

    const otherTarget = verifier.verifyBearerToken(issued.bearer_token, {
      boundary: { kind: "workspace", workspace_id: "workspace:acme" },
      target: { kind: "scope", id: "other" },
    });
    expect(otherTarget.verified && otherTarget.authority.grants).toEqual(new Set());

    const spoofed = verifier.verifyBearerToken(
      "floe_operation_endpoint:floe_workspace:acme_scope.compose",
      { boundary: { kind: "workspace", workspace_id: "workspace:acme" } },
    );
    expect(spoofed).toMatchObject({ verified: false, code: "authority_token_invalid" });
  });

  it("refuses session issuance from operation strings or another principal's grant", () => {
    const { grants, sessions } = stores();
    const grant = issueGrant(grants, {
      principal_id: "principal:other",
      workspace_id: "workspace:one",
      operation_ids: ["workspace.inspect"],
    });
    expect(() => sessions.issueSession({
      principal_id: "principal:desktop",
      workspace_id: "workspace:one",
      grant_ids: ["workspace.inspect"],
      interaction: { mode: "interactive", session_id: "window:1" },
      provenance: noProvenance,
      expires_at: expiresAt,
    })).toThrow();
    expect(() => sessions.issueSession({
      principal_id: "principal:desktop",
      workspace_id: "workspace:one",
      grant_ids: [grant.grant_id],
      interaction: { mode: "interactive", session_id: "window:1" },
      provenance: noProvenance,
      expires_at: expiresAt,
    })).toThrow();
  });

  it("refuses a valid token outside its bound Workspace", () => {
    const { grants, sessions } = stores();
    const grant = issueGrant(grants, {
      principal_id: "principal:desktop",
      workspace_id: "workspace:one",
      operation_ids: ["workspace.inspect"],
    });
    const issued = sessions.issueSession({
      principal_id: "principal:desktop",
      workspace_id: "workspace:one",
      grant_ids: [grant.grant_id],
      interaction: { mode: "interactive", session_id: "window:1" },
      provenance: noProvenance,
      expires_at: expiresAt,
    });
    const verifier = new OperationAuthorityVerifier(sessions, grants, () => "2026-09-03T12:10:00.000Z");
    expect(verifier.verifyBearerToken(issued.bearer_token, {
      boundary: { kind: "workspace", workspace_id: "workspace:two" },
    })).toMatchObject({ verified: false, code: "authority_boundary_mismatch" });
  });

  it("refuses expired and revoked sessions", () => {
    const { grants, sessions } = stores();
    const grant = issueGrant(grants, {
      principal_id: "principal:remote",
      workspace_id: "workspace:test",
      operation_ids: ["workspace.inspect"],
    });
    const expired = sessions.issueSession({
      principal_id: "principal:remote",
      workspace_id: "workspace:test",
      grant_ids: [grant.grant_id],
      interaction: { mode: "interactive", session_id: "remote:1" },
      provenance: noProvenance,
      expires_at: "2026-09-03T12:15:00.000Z",
    });
    const expiredVerifier = new OperationAuthorityVerifier(sessions, grants, () => "2026-09-03T12:15:00.000Z");
    expect(expiredVerifier.verifyBearerToken(expired.bearer_token, {
      boundary: { kind: "workspace", workspace_id: "workspace:test" },
    }))
      .toMatchObject({ verified: false, code: "authority_session_expired" });

    const runtimeGrant = issueGrant(grants, {
      principal_id: "principal:runtime",
      workspace_id: "workspace:test",
      operation_ids: ["event.emit"],
    });
    const revoked = sessions.issueSession({
      principal_id: "principal:runtime",
      workspace_id: "workspace:test",
      grant_ids: [runtimeGrant.grant_id],
      interaction: { mode: "unattended", session_id: "delivery:9" },
      provenance: noProvenance,
      expires_at: expiresAt,
    });
    expect(sessions.revokeSession(revoked.session.authority_session_id, "2026-09-03T12:05:00.000Z"))
      .toBe(true);
    const revokedVerifier = new OperationAuthorityVerifier(sessions, grants, () => "2026-09-03T12:10:00.000Z");
    expect(revokedVerifier.verifyBearerToken(revoked.bearer_token, {
      boundary: { kind: "workspace", workspace_id: "workspace:test" },
    }))
      .toMatchObject({ verified: false, code: "authority_session_revoked" });
  });

  it("applies CapabilityGrant revocation to an already-issued session", () => {
    const { grants, sessions } = stores("2026-09-03T12:10:00.000Z");
    const grant = issueGrant(grants, {
      principal_id: "principal:runtime",
      workspace_id: "workspace:test",
      operation_ids: ["scope.execution.stop"],
    });
    const issued = sessions.issueSession({
      principal_id: grant.principal_id,
      workspace_id: "workspace:test",
      grant_ids: [grant.grant_id],
      interaction: { mode: "unattended", session_id: "delivery:9" },
      provenance: noProvenance,
      expires_at: expiresAt,
    });
    const verifier = new OperationAuthorityVerifier(sessions, grants, () => "2026-09-03T12:10:00.000Z");
    expect(verifier.verifyBearerToken(issued.bearer_token, {
      boundary: { kind: "workspace", workspace_id: "workspace:test" },
    }))
      .toMatchObject({ verified: true });
    grants.revokeGrant(grant.grant_id, "2026-09-03T12:11:00.000Z");
    const after = new OperationAuthorityVerifier(sessions, grants, () => "2026-09-03T12:12:00.000Z")
      .verifyBearerToken(issued.bearer_token, {
        boundary: { kind: "workspace", workspace_id: "workspace:test" },
      });
    expect(after.verified && after.authority.grants).toEqual(new Set());
    expect(after).toMatchObject({
      verified: true,
      unavailable_grants: [{ grant_id: grant.grant_id, code: "grant_revoked" }],
    });
  });

  it("persists only the token hash and can verify after reopening", () => {
    const directory = mkdtempSync(join(tmpdir(), "floe-operation-authority-"));
    cleanupDirectories.push(directory);
    const path = join(directory, "bus.sqlite");
    const rawToken = `floe_operation_${"private-token-material-".repeat(2)}`;
    const { db, grants } = stores(issuedAt, new DatabaseSync(path));
    const grant = issueGrant(grants, {
      principal_id: "principal:desktop",
      workspace_id: "workspace:test",
      operation_ids: ["provider.connect"],
    });
    const sessions = new SqliteOperationAuthoritySessionStore(db, grants, {
      now: () => issuedAt,
      token_factory: () => rawToken,
      session_id_factory: () => "authsession:persisted",
    });
    sessions.issueSession({
      principal_id: "principal:desktop",
      workspace_id: "workspace:test",
      grant_ids: [grant.grant_id],
      interaction: {
        mode: "brokered",
        session_id: "window:provider-setup",
        broker_id: "os-credential-broker",
      },
      provenance: noProvenance,
      expires_at: expiresAt,
    });

    const columns = db.prepare("PRAGMA table_info(operation_authority_sessions)").all() as Array<{ name: string }>;
    const persisted = db.prepare("SELECT * FROM operation_authority_sessions").get() as Record<string, unknown>;
    expect(columns.map((column) => column.name)).toContain("token_hash");
    expect(columns.map((column) => column.name)).toContain("grant_ids_json");
    expect(columns.map((column) => column.name)).not.toContain("bearer_token");
    expect(columns.map((column) => column.name)).not.toContain("grants_json");
    expect(persisted.token_hash).toBe(hashBearerToken(rawToken));
    expect(JSON.stringify(persisted)).not.toContain(rawToken);
    db.close();
    openDatabases.splice(openDatabases.indexOf(db), 1);

    const reopenedDb = new DatabaseSync(path);
    openDatabases.push(reopenedDb);
    const reopenedGrants = new SqliteCapabilityGrantStore(reopenedDb);
    const reopenedSessions = new SqliteOperationAuthoritySessionStore(reopenedDb, reopenedGrants);
    const verifier = new OperationAuthorityVerifier(reopenedSessions, reopenedGrants, () => "2026-09-03T12:30:00.000Z");
    expect(verifier.verifyBearerToken(rawToken, {
      boundary: { kind: "workspace", workspace_id: "workspace:test" },
    }))
      .toMatchObject({ verified: true, authority_session_id: "authsession:persisted" });

    expect(readFileSync(path).includes(Buffer.from(rawToken, "utf8"))).toBe(false);
  });

  it("adds explicit empty provenance to existing current-schema sessions", () => {
    const db = new DatabaseSync(":memory:");
    openDatabases.push(db);
    db.exec(`
      CREATE TABLE operation_authority_sessions (
        authority_session_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        principal_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        grant_ids_json TEXT NOT NULL,
        interaction_mode TEXT NOT NULL,
        interaction_session_id TEXT NOT NULL,
        broker_id TEXT,
        confirmed_prompts_json TEXT NOT NULL,
        approval_refs_json TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );
      INSERT INTO operation_authority_sessions VALUES (
        'authsession:existing', 'hash:existing', 'principal:existing',
        'workspace:existing', '["grant:existing"]', 'interactive',
        'window:existing', NULL, '[]', '[]',
        '${issuedAt}', '${expiresAt}', NULL
      );
    `);

    applyOperationAuthoritySessionSchema(db);
    const stored = db.prepare(`
      SELECT provenance_json FROM operation_authority_sessions
      WHERE authority_session_id = 'authsession:existing'
    `).get() as { provenance_json: string };
    expect(JSON.parse(stored.provenance_json)).toEqual(noProvenance);
    expect((db.prepare("PRAGMA table_info(operation_authority_sessions)").all() as Array<{ name: string }>)
      .map((column) => column.name)).toContain("provenance_json");
  });
});
