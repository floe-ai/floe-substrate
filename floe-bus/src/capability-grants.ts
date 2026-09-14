import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  createOperationAuthorityContext,
  type OperationAuthorityBoundary,
  type OperationAuthorityContext,
  type OperationInteractionMode,
  type OperationResourceIdentity,
} from "./operations.js";

/**
 * A null target ID grants the listed operations for every resource of that
 * kind. An empty target list grants them across the authenticated boundary.
 */
export type CapabilityGrantTarget = Readonly<{
  kind: string;
  id: string | null;
}>;

export type CapabilityGrantEvidence = Readonly<{
  kind: string;
  ref: string;
}>;

export type CapabilityGrantRecord = Readonly<{
  grant_id: string;
  principal_id: string;
  boundary: OperationAuthorityBoundary;
  operation_ids: readonly string[];
  targets: readonly CapabilityGrantTarget[];
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  issuer_id: string;
  evidence: readonly CapabilityGrantEvidence[];
}>;

export type IssueCapabilityGrant = Readonly<{
  /** Used by trusted deterministic policy issuers. Omit for ordinary grants. */
  grant_id?: string;
  principal_id: string;
  boundary: OperationAuthorityBoundary;
  operation_ids: readonly string[];
  targets?: readonly CapabilityGrantTarget[];
  expires_at: string;
  issuer_id: string;
  evidence: readonly CapabilityGrantEvidence[];
}>;

export type CapabilityGrantSessionBinding = Readonly<{
  principal_id: string;
  boundary: OperationAuthorityBoundary;
  grant_ids: readonly string[];
  interaction: Readonly<{
    mode: OperationInteractionMode;
    session_id: string;
    broker_id?: string | null;
    confirmed_prompts: Iterable<string>;
    approval_refs: Iterable<string>;
  }>;
}>;

export type HostCapabilityPolicyRevision = Readonly<{
  host_policy_id: string;
  policy_revision: string;
  purpose: string;
  host_id: string;
  principal_id: string;
  grant_id: string;
  supersedes_grant_id: string | null;
  superseded_by_grant_id: string | null;
  activated_at: string;
  superseded_at: string | null;
}>;

export type ActivateHostCapabilityPolicy = Readonly<{
  host_id: string;
  principal_id: string;
  purpose: string;
  policy_revision: string;
  operation_ids: readonly string[];
  targets?: readonly CapabilityGrantTarget[];
  expires_at: string;
  issuer_id: string;
  evidence: readonly CapabilityGrantEvidence[];
}>;

export type CapabilityGrantReferenceFailureCode =
  | "grant_not_found"
  | "grant_principal_mismatch"
  | "grant_boundary_mismatch"
  | "grant_not_yet_active"
  | "grant_expired"
  | "grant_revoked"
  | "grant_dependency_unavailable";

export type CapabilityGrantReferenceFailure = Readonly<{
  grant_id: string;
  code: CapabilityGrantReferenceFailureCode;
}>;

export type CapabilityGrantReferenceInspection = Readonly<{
  active_grants: readonly CapabilityGrantRecord[];
  unavailable_grants: readonly CapabilityGrantReferenceFailure[];
}>;

export type ResolvedCapabilityGrantAuthority = Readonly<{
  authority: OperationAuthorityContext;
  active_grant_ids: readonly string[];
  applicable_grant_ids: readonly string[];
  unavailable_grants: readonly CapabilityGrantReferenceFailure[];
}>;

export type CapabilityGrantStoreDependencies = Readonly<{
  now?: () => string;
  grant_id_factory?: () => string;
}>;

type CapabilityGrantRow = Readonly<{
  grant_id: string;
  principal_id: string;
  boundary_kind: string;
  boundary_id: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  issuer_id: string;
  evidence_json: string;
}>;

type HostCapabilityPolicyRow = Readonly<{
  host_policy_id: string;
  policy_revision: string;
  purpose: string;
  host_id: string;
  principal_id: string;
  grant_id: string;
  supersedes_grant_id: string | null;
  superseded_by_grant_id: string | null;
  activated_at: string;
  superseded_at: string | null;
}>;

type CapabilityGrantTargetRow = Readonly<{
  target_kind: string;
  target_id: string | null;
}>;

/** Installs the durable records used to derive current operation authority. */
export function applyCapabilityGrantSchema(db: DatabaseSync): void {
  const existingColumns = db.prepare("PRAGMA table_info(capability_grants)")
    .all() as Array<{ name: string }>;
  if (existingColumns.length > 0) {
    const names = new Set(existingColumns.map((column) => column.name));
    if (!names.has("boundary_kind") || names.has("workspace_id")) {
      migrateCapabilityGrantsToCanonical(db, names.has("boundary_kind"));
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS capability_grants (
      grant_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      boundary_kind TEXT NOT NULL CHECK (boundary_kind IN ('workspace', 'host')),
      boundary_id TEXT NOT NULL CHECK (length(trim(boundary_id)) > 0),
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      issuer_id TEXT NOT NULL,
      evidence_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS capability_grant_operations (
      grant_id TEXT NOT NULL REFERENCES capability_grants(grant_id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL,
      PRIMARY KEY (grant_id, operation_id)
    );

    CREATE TABLE IF NOT EXISTS capability_grant_targets (
      grant_id TEXT NOT NULL REFERENCES capability_grants(grant_id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL,
      target_id TEXT,
      CHECK (target_id IS NULL OR length(trim(target_id)) > 0)
    );

    CREATE TABLE IF NOT EXISTS capability_grant_delegations (
      grant_id TEXT PRIMARY KEY REFERENCES capability_grants(grant_id) ON DELETE CASCADE,
      source_grant_id TEXT NOT NULL REFERENCES capability_grants(grant_id),
      authority_grant_id TEXT NOT NULL REFERENCES capability_grants(grant_id),
      CHECK (grant_id != source_grant_id AND grant_id != authority_grant_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_grant_target_identity
      ON capability_grant_targets(grant_id, target_kind, COALESCE(target_id, ''));

    CREATE INDEX IF NOT EXISTS idx_capability_grant_principal_boundary
      ON capability_grants(principal_id, boundary_kind, boundary_id, expires_at DESC);

    CREATE INDEX IF NOT EXISTS idx_capability_grant_active_expiry
      ON capability_grants(expires_at)
      WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS host_capability_policy_revisions (
      host_policy_id TEXT NOT NULL,
      policy_revision TEXT NOT NULL,
      purpose TEXT NOT NULL,
      host_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      grant_id TEXT PRIMARY KEY REFERENCES capability_grants(grant_id),
      supersedes_grant_id TEXT REFERENCES host_capability_policy_revisions(grant_id),
      superseded_by_grant_id TEXT REFERENCES host_capability_policy_revisions(grant_id),
      activated_at TEXT NOT NULL,
      superseded_at TEXT,
      UNIQUE(host_policy_id, policy_revision),
      CHECK (superseded_by_grant_id IS NULL OR superseded_at IS NOT NULL)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_host_capability_policy_active
      ON host_capability_policy_revisions(host_policy_id)
      WHERE superseded_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_host_capability_policy_history
      ON host_capability_policy_revisions(host_policy_id, activated_at DESC);
  `);
}

/**
 * Rewrites the two unreleased grant layouts to one boundary-only shape. This is
 * a one-way, data-preserving migration rather than a parallel compatibility
 * model. Child rows and credential constraints retain their original IDs.
 */
function migrateCapabilityGrantsToCanonical(db: DatabaseSync, hasBoundaryKind: boolean): void {
  inSavepoint(db, () => {
  const hasSecretConstraints = tableExists(db, "secret_grant_constraints");
  const hasSecretPurposes = tableExists(db, "secret_grant_constraint_purposes");
  if (hasSecretConstraints) {
    db.exec(`
      CREATE TEMP TABLE floe_capability_secret_constraints AS
      SELECT grant_id, secret_ref_id, workspace_id FROM secret_grant_constraints;
    `);
  }
  if (hasSecretPurposes) {
    db.exec(`
      CREATE TEMP TABLE floe_capability_secret_purposes AS
      SELECT grant_id, purpose FROM secret_grant_constraint_purposes;
    `);
  }
  if (hasSecretPurposes) db.exec("DROP TABLE secret_grant_constraint_purposes;");
  if (hasSecretConstraints) db.exec("DROP TABLE secret_grant_constraints;");

  db.exec(`
    CREATE TABLE capability_grants_next (
      grant_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      boundary_kind TEXT NOT NULL CHECK (boundary_kind IN ('workspace', 'host')),
      boundary_id TEXT NOT NULL CHECK (length(trim(boundary_id)) > 0),
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      issuer_id TEXT NOT NULL,
      evidence_json TEXT NOT NULL
    );
    CREATE TABLE capability_grant_operations_next (
      grant_id TEXT NOT NULL REFERENCES capability_grants_next(grant_id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL,
      PRIMARY KEY (grant_id, operation_id)
    );
    CREATE TABLE capability_grant_targets_next (
      grant_id TEXT NOT NULL REFERENCES capability_grants_next(grant_id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL,
      target_id TEXT,
      CHECK (target_id IS NULL OR length(trim(target_id)) > 0)
    );
    INSERT INTO capability_grants_next (
      grant_id, principal_id, boundary_kind, boundary_id,
      issued_at, expires_at, revoked_at, issuer_id, evidence_json
    )
    SELECT grant_id, principal_id,
           ${hasBoundaryKind ? "boundary_kind, boundary_id" : "'workspace', workspace_id"},
           issued_at, expires_at, revoked_at, issuer_id, evidence_json
    FROM capability_grants;
    INSERT INTO capability_grant_operations_next
      SELECT grant_id, operation_id FROM capability_grant_operations;
    INSERT INTO capability_grant_targets_next
      SELECT grant_id, target_kind, target_id FROM capability_grant_targets;
    DROP TABLE capability_grant_targets;
    DROP TABLE capability_grant_operations;
    DROP TABLE capability_grants;
    ALTER TABLE capability_grants_next RENAME TO capability_grants;
    ALTER TABLE capability_grant_operations_next RENAME TO capability_grant_operations;
    ALTER TABLE capability_grant_targets_next RENAME TO capability_grant_targets;
  `);

  if (hasSecretConstraints) {
    db.exec(`
      CREATE TABLE secret_grant_constraints (
        grant_id TEXT PRIMARY KEY REFERENCES capability_grants(grant_id) ON DELETE CASCADE,
        secret_ref_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        FOREIGN KEY (workspace_id, secret_ref_id)
          REFERENCES secret_refs(workspace_id, secret_ref_id)
      );
      CREATE INDEX IF NOT EXISTS idx_secret_grant_constraints_ref
        ON secret_grant_constraints(workspace_id, secret_ref_id);
      INSERT INTO secret_grant_constraints (grant_id, secret_ref_id, workspace_id)
      SELECT grant_id, secret_ref_id, workspace_id FROM floe_capability_secret_constraints;
      DROP TABLE floe_capability_secret_constraints;
    `);
  }
  if (hasSecretPurposes) {
    db.exec(`
      CREATE TABLE secret_grant_constraint_purposes (
        grant_id TEXT NOT NULL REFERENCES secret_grant_constraints(grant_id) ON DELETE CASCADE,
        purpose TEXT NOT NULL,
        PRIMARY KEY (grant_id, purpose)
      );
      INSERT INTO secret_grant_constraint_purposes (grant_id, purpose)
      SELECT grant_id, purpose FROM floe_capability_secret_purposes;
      DROP TABLE floe_capability_secret_purposes;
    `);
  }
  });
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?
  `).get(name));
}

/**
 * Owns CapabilityGrant lifecycle and derives operation authority from current
 * records. Session contents are references only and never become authority by
 * themselves.
 */
export class SqliteCapabilityGrantStore {
  private readonly now: () => string;
  private readonly grantIdFactory: () => string;

  constructor(
    readonly db: DatabaseSync,
    dependencies: CapabilityGrantStoreDependencies = {},
  ) {
    this.now = dependencies.now ?? isoNow;
    this.grantIdFactory = dependencies.grant_id_factory ?? (() => `capgrant_${randomUUID()}`);
  }

  issueGrant(input: IssueCapabilityGrant): CapabilityGrantRecord {
    assertNonEmpty("principal_id", input.principal_id);
    const boundary = normalizeBoundary(input.boundary);
    assertNonEmpty("issuer_id", input.issuer_id);
    const operationIds = normalizeNonEmptySet(input.operation_ids, "operation_id", true);
    const targets = normalizeTargets(input.targets ?? []);
    const evidence = normalizeEvidence(input.evidence);
    const issuedAt = this.now();
    const issuedAtMs = parseTimestamp("issued_at", issuedAt);
    const expiresAtMs = parseTimestamp("expires_at", input.expires_at);
    if (expiresAtMs <= issuedAtMs) {
      throw new Error("CapabilityGrant expiry must be after its issue time.");
    }

    const grantId = input.grant_id ?? this.grantIdFactory();
    assertNonEmpty("grant_id", grantId);

    inSavepoint(this.db, () => {
      this.db.prepare(`
        INSERT INTO capability_grants (
          grant_id, principal_id, boundary_kind, boundary_id, issued_at, expires_at,
          revoked_at, issuer_id, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(
        grantId,
        input.principal_id,
        boundary.kind,
        boundaryId(boundary),
        issuedAt,
        input.expires_at,
        input.issuer_id,
        JSON.stringify(evidence),
      );

      const insertOperation = this.db.prepare(`
        INSERT INTO capability_grant_operations (grant_id, operation_id)
        VALUES (?, ?)
      `);
      for (const operationId of operationIds) insertOperation.run(grantId, operationId);

      const insertTarget = this.db.prepare(`
        INSERT INTO capability_grant_targets (grant_id, target_kind, target_id)
        VALUES (?, ?, ?)
      `);
      for (const target of targets) insertTarget.run(grantId, target.kind, target.id);
    });

    return this.requireGrant(grantId);
  }

  /** Delegate only pinned, current authority. Parent revocation also removes child authority. */
  delegateGrant(input: Readonly<{
    authority: OperationAuthorityContext;
    source_grant_id: string;
    principal_id: string;
    recipient: OperationResourceIdentity;
    operation_ids: readonly string[];
    targets?: readonly CapabilityGrantTarget[];
    expires_at?: string;
    invocation_id: string;
  }>): CapabilityGrantRecord {
    const authority = input.authority;
    const source = this.requireActiveSessionGrantIds({
      principal_id: authority.principal_id, boundary: authority.boundary,
      grant_ids: [input.source_grant_id],
    })[0]!;
    if (!(authority.session_capability_grant_ids ?? []).includes(source)) {
      throw new Error("The source grant is not part of this authenticated session.");
    }
    const parent = this.requireGrant(source);
    const permission = this.inspectSessionGrantIds({ principal_id: authority.principal_id,
      boundary: authority.boundary, grant_ids: authority.capability_grant_ids ?? [],
    }).active_grants.filter(grant => grant.operation_ids.includes("capability.grant.delegate")
      && grantAppliesToTarget(grant, input.recipient))
      .sort((a, b) => b.expires_at.localeCompare(a.expires_at) || a.grant_id.localeCompare(b.grant_id))[0];
    if (!permission || !authority.grants.has("capability.grant.delegate")) {
      throw new Error("Delegating access requires a current delegation grant for this recipient.");
    }
    const operations = normalizeNonEmptySet(input.operation_ids, "operation_id", true);
    const targets = normalizeTargets(input.targets ?? parent.targets);
    if (operations.some(id => !parent.operation_ids.includes(id))) {
      throw new Error("Delegated operations must be a subset of the source grant.");
    }
    if (parent.targets.length > 0 && (targets.length === 0 || targets.some(target =>
      !parent.targets.some(allowed => allowed.kind === target.kind && (allowed.id === null || allowed.id === target.id))))) {
      throw new Error("Delegated targets must be contained in the source grant.");
    }
    const limit = Math.min(Date.parse(parent.expires_at), Date.parse(permission.expires_at));
    const expiry = input.expires_at ?? new Date(limit).toISOString();
    if (parseTimestamp("expires_at", expiry) > limit) {
      throw new Error("Delegated access cannot outlive its source or delegation permission.");
    }
    return inSavepoint(this.db, () => {
      const grant = this.issueGrant({ principal_id: input.principal_id, boundary: authority.boundary,
        operation_ids: operations, targets, expires_at: expiry, issuer_id: authority.principal_id,
        evidence: [{ kind: "operation_invocation", ref: input.invocation_id }],
      });
      this.db.prepare(`INSERT INTO capability_grant_delegations (grant_id, source_grant_id, authority_grant_id)
        VALUES (?, ?, ?)`).run(grant.grant_id, parent.grant_id, permission.grant_id);
      return grant;
    });
  }

  getDelegation(grantId: string): Readonly<{ source_grant_id: string; authority_grant_id: string }> | null {
    return this.db.prepare(`SELECT source_grant_id, authority_grant_id FROM capability_grant_delegations WHERE grant_id = ?`)
      .get(grantId) as { source_grant_id: string; authority_grant_id: string } | undefined ?? null;
  }

  private delegationIsActive(grantId: string, nowMs: number, path = new Set<string>(), memo = new Map<string, boolean>()): boolean {
    if (memo.has(grantId)) return memo.get(grantId)!;
    if (path.has(grantId)) return false;
    path.add(grantId);
    const delegation = this.getDelegation(grantId);
    if (!delegation) { memo.set(grantId, true); return true; }
    const child = this.requireGrant(grantId);
    const active = [...new Set([delegation.source_grant_id, delegation.authority_grant_id])].every(id => {
      const parent = this.getGrant(id);
      return parent !== null
        && grantReferenceFailure(parent, { principal_id: child.issuer_id, boundary: child.boundary }, nowMs) === null
        && this.delegationIsActive(id, nowMs, new Set(path), memo);
    });
    memo.set(grantId, active);
    return active;
  }

  /**
   * Activates one immutable host-policy revision. Repeating the exact revision
   * is idempotent. Any semantic change requires a new revision and atomically
   * revokes/supersedes the previous grant; revoked history is never revived.
   */
  activateHostPolicyGrant(input: ActivateHostCapabilityPolicy): Readonly<{
    replayed: boolean;
    policy: HostCapabilityPolicyRevision;
    grant: CapabilityGrantRecord;
  }> {
    const hostId = assertNonEmpty("host_id", input.host_id);
    const principalId = assertNonEmpty("principal_id", input.principal_id);
    const purpose = assertNonEmpty("policy purpose", input.purpose);
    const policyRevision = assertNonEmpty("policy_revision", input.policy_revision);
    const issuerId = assertNonEmpty("issuer_id", input.issuer_id);
    const operationIds = normalizeNonEmptySet(input.operation_ids, "operation_id", true);
    const targets = normalizeTargets(input.targets ?? []);
    const evidence = normalizeEvidence(input.evidence);
    const policyId = hostCapabilityPolicyId(hostId, purpose);
    const grantId = hostCapabilityPolicyGrantId(policyId, policyRevision);
    const existingPolicy = this.getHostPolicyRevision(policyId, policyRevision);
    if (existingPolicy) {
      const existingGrant = this.requireGrant(existingPolicy.grant_id);
      const exact = existingPolicy.host_id === hostId
        && existingPolicy.principal_id === principalId
        && existingPolicy.purpose === purpose
        && existingGrant.issuer_id === issuerId
        && existingGrant.expires_at === input.expires_at
        && JSON.stringify(existingGrant.operation_ids) === JSON.stringify(operationIds)
        && JSON.stringify(existingGrant.targets) === JSON.stringify(targets)
        && JSON.stringify(existingGrant.evidence) === JSON.stringify(evidence);
      if (!exact) {
        throw new Error(`Host capability policy '${policyId}@${policyRevision}' already identifies different authority.`);
      }
      if (existingGrant.revoked_at !== null || existingPolicy.superseded_at !== null) {
        throw new Error(`Host capability policy '${policyId}@${policyRevision}' has been superseded and cannot be reactivated.`);
      }
      if (parseTimestamp("expires_at", existingGrant.expires_at) <= parseTimestamp("now", this.now())) {
        throw new Error(`Host capability policy '${policyId}@${policyRevision}' has expired and cannot be reactivated.`);
      }
      return { replayed: true, policy: existingPolicy, grant: existingGrant };
    }

    const activePolicy = this.getActiveHostPolicyRevision(policyId);
    const activatedAt = this.now();
    let grant!: CapabilityGrantRecord;
    inSavepoint(this.db, () => {
      if (activePolicy) {
        this.db.prepare(`
          UPDATE host_capability_policy_revisions
          SET superseded_at = ?
          WHERE grant_id = ? AND superseded_at IS NULL
        `).run(activatedAt, activePolicy.grant_id);
      }
      grant = this.issueGrant({
        grant_id: grantId,
        principal_id: principalId,
        boundary: { kind: "host", host_id: hostId },
        operation_ids: operationIds,
        targets,
        expires_at: input.expires_at,
        issuer_id: issuerId,
        evidence,
      });
      this.db.prepare(`
        INSERT INTO host_capability_policy_revisions (
          host_policy_id, policy_revision, purpose, host_id, principal_id,
          grant_id, supersedes_grant_id, superseded_by_grant_id,
          activated_at, superseded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)
      `).run(
        policyId,
        policyRevision,
        purpose,
        hostId,
        principalId,
        grant.grant_id,
        activePolicy?.grant_id ?? null,
        activatedAt,
      );
      if (activePolicy) {
        this.db.prepare(`
          UPDATE host_capability_policy_revisions
          SET superseded_by_grant_id = ?
          WHERE grant_id = ?
        `).run(grant.grant_id, activePolicy.grant_id);
        this.db.prepare(`
          UPDATE capability_grants
          SET revoked_at = ?
          WHERE grant_id = ? AND revoked_at IS NULL
        `).run(activatedAt, activePolicy.grant_id);
      }
    });
    return {
      replayed: false,
      policy: this.requireHostPolicyRevision(policyId, policyRevision),
      grant,
    };
  }

  getHostPolicyRevision(policyId: string, policyRevision: string): HostCapabilityPolicyRevision | null {
    const row = this.db.prepare(`
      SELECT * FROM host_capability_policy_revisions
      WHERE host_policy_id = ? AND policy_revision = ?
    `).get(policyId, policyRevision) as HostCapabilityPolicyRow | undefined;
    return row ? rowToHostCapabilityPolicy(row) : null;
  }

  getActiveHostPolicyRevision(policyId: string): HostCapabilityPolicyRevision | null {
    const row = this.db.prepare(`
      SELECT * FROM host_capability_policy_revisions
      WHERE host_policy_id = ? AND superseded_at IS NULL
    `).get(policyId) as HostCapabilityPolicyRow | undefined;
    return row ? rowToHostCapabilityPolicy(row) : null;
  }

  listHostPolicyHistory(hostId: string, purpose: string): HostCapabilityPolicyRevision[] {
    const policyId = hostCapabilityPolicyId(hostId, purpose);
    return (this.db.prepare(`
      SELECT * FROM host_capability_policy_revisions
      WHERE host_policy_id = ?
      ORDER BY activated_at DESC, policy_revision DESC
    `).all(policyId) as HostCapabilityPolicyRow[]).map(rowToHostCapabilityPolicy);
  }

  getGrant(grantId: string): CapabilityGrantRecord | null {
    const row = this.db.prepare(`
      SELECT grant_id, principal_id, boundary_kind, boundary_id, issued_at, expires_at,
             revoked_at, issuer_id, evidence_json
      FROM capability_grants
      WHERE grant_id = ?
    `).get(grantId) as CapabilityGrantRow | undefined;
    if (!row) return null;

    const operationIds = (this.db.prepare(`
      SELECT operation_id
      FROM capability_grant_operations
      WHERE grant_id = ?
      ORDER BY operation_id
    `).all(grantId) as Array<{ operation_id: string }>).map((item) => item.operation_id);
    if (operationIds.length === 0) {
      throw new Error(`Stored CapabilityGrant '${grantId}' has no semantic operations.`);
    }

    const targets = (this.db.prepare(`
      SELECT target_kind, target_id
      FROM capability_grant_targets
      WHERE grant_id = ?
      ORDER BY target_kind, target_id
    `).all(grantId) as CapabilityGrantTargetRow[]).map((target) => ({
      kind: target.target_kind,
      id: target.target_id,
    }));

    return {
      grant_id: row.grant_id,
      principal_id: row.principal_id,
      boundary: boundaryFromRow(row.boundary_kind, row.boundary_id),
      operation_ids: operationIds,
      targets,
      issued_at: row.issued_at,
      expires_at: row.expires_at,
      revoked_at: row.revoked_at,
      issuer_id: row.issuer_id,
      evidence: parseEvidence(row.evidence_json),
    };
  }

  revokeGrant(grantId: string, revokedAt = this.now()): boolean {
    assertNonEmpty("grant_id", grantId);
    const revokedAtMs = parseTimestamp("revoked_at", revokedAt);
    const grant = this.getGrant(grantId);
    if (!grant || grant.revoked_at !== null) return false;
    if (revokedAtMs < parseTimestamp("issued_at", grant.issued_at)) {
      throw new Error("CapabilityGrant revocation cannot predate its issue time.");
    }
    const result = this.db.prepare(`
      UPDATE capability_grants
      SET revoked_at = ?
      WHERE grant_id = ? AND revoked_at IS NULL
    `).run(revokedAt, grantId);
    return Number(result.changes) === 1;
  }

  listActiveGrantsForPrincipalBoundary(
    principalId: string,
    boundaryValue: OperationAuthorityBoundary,
  ): CapabilityGrantRecord[] {
    assertNonEmpty("principal_id", principalId);
    const boundary = normalizeBoundary(boundaryValue);
    const now = new Date(parseTimestamp("now", this.now())).toISOString();
    const ids = this.db.prepare(`
      SELECT grant_id
      FROM capability_grants
      WHERE principal_id = ?
        AND boundary_kind = ?
        AND boundary_id = ?
        AND revoked_at IS NULL
        AND issued_at <= ?
        AND expires_at > ?
      ORDER BY issued_at DESC, grant_id
    `).all(
      principalId,
      boundary.kind,
      boundaryId(boundary),
      now,
      now,
    ) as Array<{ grant_id: string }>;
    return ids.filter(({ grant_id }) => this.delegationIsActive(grant_id, Date.parse(now)))
      .map(({ grant_id }) => this.requireGrant(grant_id));
  }

  /**
   * Checks that every ID is a current grant for the exact session principal and
   * authority boundary. Session issuance should refuse any unavailable reference.
   */
  inspectSessionGrantIds(
    session: Pick<CapabilityGrantSessionBinding, "principal_id" | "boundary" | "grant_ids">,
  ): CapabilityGrantReferenceInspection {
    assertNonEmpty("session principal_id", session.principal_id);
    normalizeBoundary(session.boundary);
    const grantIds = normalizeNonEmptySet(session.grant_ids, "session grant_id", false);
    const nowMs = parseTimestamp("now", this.now());
    const activeGrants: CapabilityGrantRecord[] = [];
    const unavailableGrants: CapabilityGrantReferenceFailure[] = [];

    for (const grantId of grantIds) {
      const grant = this.getGrant(grantId);
      const code = grantReferenceFailure(grant, session, nowMs)
        ?? (this.delegationIsActive(grantId, nowMs) ? null : "grant_dependency_unavailable");
      if (code === null && grant) activeGrants.push(grant);
      else unavailableGrants.push({ grant_id: grantId, code: code ?? "grant_not_found" });
    }

    return { active_grants: activeGrants, unavailable_grants: unavailableGrants };
  }

  /**
   * Assertion helper for trusted session issuance. Stored sessions should keep
   * the returned opaque IDs, never a copied list of operation strings.
   */
  requireActiveSessionGrantIds(
    session: Pick<CapabilityGrantSessionBinding, "principal_id" | "boundary" | "grant_ids">,
  ): readonly string[] {
    const inspection = this.inspectSessionGrantIds(session);
    if (inspection.active_grants.length === 0 || inspection.unavailable_grants.length > 0) {
      throw new CapabilityGrantReferenceError(inspection.unavailable_grants);
    }
    return inspection.active_grants.map((grant) => grant.grant_id);
  }

  /**
   * Resolves an existing session at request time. Revoked, expired, missing, or
   * mismatched grants contribute no operations. Resource-bound grants only
   * contribute for their exact target.
   */
  resolveSessionAuthority(
    session: CapabilityGrantSessionBinding,
    target: OperationResourceIdentity | null,
  ): ResolvedCapabilityGrantAuthority {
    assertNonEmpty("interaction session_id", session.interaction.session_id);
    const inspection = this.inspectSessionGrantIds(session);
    const applicableGrants = inspection.active_grants.filter((grant) => grantAppliesToTarget(grant, target));
    const operationIds = new Set<string>();
    for (const grant of applicableGrants) {
      for (const operationId of grant.operation_ids) operationIds.add(operationId);
    }

    return {
      authority: createOperationAuthorityContext({
        principal_id: session.principal_id,
        boundary: session.boundary,
        capability_grant_ids: applicableGrants.map((grant) => grant.grant_id),
        session_capability_grant_ids: inspection.active_grants.map((grant) => grant.grant_id),
        grants: operationIds,
        interaction: {
          mode: session.interaction.mode,
          session_id: session.interaction.session_id,
          broker_id: session.interaction.broker_id ?? null,
          confirmed_prompts: new Set(session.interaction.confirmed_prompts),
          approval_refs: new Set(session.interaction.approval_refs),
        },
      }),
      active_grant_ids: inspection.active_grants.map((grant) => grant.grant_id),
      applicable_grant_ids: applicableGrants.map((grant) => grant.grant_id),
      unavailable_grants: inspection.unavailable_grants,
    };
  }

  private requireGrant(grantId: string): CapabilityGrantRecord {
    const grant = this.getGrant(grantId);
    if (!grant) throw new Error(`CapabilityGrant '${grantId}' was not persisted.`);
    return grant;
  }

  private requireHostPolicyRevision(
    policyId: string,
    policyRevision: string,
  ): HostCapabilityPolicyRevision {
    const policy = this.getHostPolicyRevision(policyId, policyRevision);
    if (!policy) {
      throw new Error(`Host capability policy '${policyId}@${policyRevision}' was not persisted.`);
    }
    return policy;
  }
}

export class CapabilityGrantReferenceError extends Error {
  constructor(readonly failures: readonly CapabilityGrantReferenceFailure[]) {
    super(failures.length === 0
      ? "An authority session must reference at least one active CapabilityGrant."
      : failures.map(failure => `CapabilityGrant '${failure.grant_id}': ${failure.code}.`).join(" "));
    this.name = "CapabilityGrantReferenceError";
  }
}

function grantReferenceFailure(
  grant: CapabilityGrantRecord | null,
  session: Pick<CapabilityGrantSessionBinding, "principal_id" | "boundary">,
  nowMs: number,
): CapabilityGrantReferenceFailureCode | null {
  if (!grant) return "grant_not_found";
  if (grant.principal_id !== session.principal_id) return "grant_principal_mismatch";
  if (!sameBoundary(grant.boundary, session.boundary)) return "grant_boundary_mismatch";
  if (grant.revoked_at !== null) return "grant_revoked";
  if (parseTimestamp("issued_at", grant.issued_at) > nowMs) return "grant_not_yet_active";
  if (parseTimestamp("expires_at", grant.expires_at) <= nowMs) return "grant_expired";
  return null;
}

function grantAppliesToTarget(
  grant: CapabilityGrantRecord,
  target: OperationResourceIdentity | null,
): boolean {
  if (grant.targets.length === 0) return true;
  if (target === null) return false;
  return grant.targets.some((candidate) =>
    candidate.kind === target.kind && (candidate.id === null || candidate.id === target.id));
}

function normalizeTargets(targets: readonly CapabilityGrantTarget[]): CapabilityGrantTarget[] {
  const normalized = new Map<string, CapabilityGrantTarget>();
  for (const target of targets) {
    assertNonEmpty("target kind", target.kind);
    if (target.id !== null) assertNonEmpty("target id", target.id);
    const value = { kind: target.kind, id: target.id };
    normalized.set(JSON.stringify([value.kind, value.id]), value);
  }
  return [...normalized.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind) || (left.id ?? "").localeCompare(right.id ?? ""));
}

function normalizeBoundary(boundary: OperationAuthorityBoundary): OperationAuthorityBoundary {
  if (boundary.kind === "workspace") {
    assertNonEmpty("boundary workspace_id", boundary.workspace_id);
    return { kind: "workspace", workspace_id: boundary.workspace_id };
  }
  if (boundary.kind === "host") {
    assertNonEmpty("boundary host_id", boundary.host_id);
    return { kind: "host", host_id: boundary.host_id };
  }
  throw new Error("CapabilityGrant boundary kind is invalid.");
}

function boundaryId(boundary: OperationAuthorityBoundary): string {
  return boundary.kind === "workspace" ? boundary.workspace_id : boundary.host_id;
}

function sameBoundary(
  left: OperationAuthorityBoundary,
  right: OperationAuthorityBoundary,
): boolean {
  return left.kind === right.kind && boundaryId(left) === boundaryId(right);
}

function boundaryFromRow(
  kind: string,
  id: string,
): OperationAuthorityBoundary {
  if (kind === "workspace") return { kind: "workspace", workspace_id: id };
  if (kind === "host") return { kind: "host", host_id: id };
  throw new Error("Stored CapabilityGrant authority boundary is invalid.");
}

export function hostCapabilityPolicyId(hostId: string, purpose: string): string {
  assertNonEmpty("host_id", hostId);
  assertNonEmpty("policy purpose", purpose);
  return `host_policy_${digest(`${hostId}\0${purpose}`).slice(0, 32)}`;
}

export function hostCapabilityPolicyGrantId(policyId: string, policyRevision: string): string {
  assertNonEmpty("host_policy_id", policyId);
  assertNonEmpty("policy_revision", policyRevision);
  return `capgrant_host_policy_${digest(`${policyId}\0${policyRevision}`).slice(0, 32)}`;
}

function rowToHostCapabilityPolicy(row: HostCapabilityPolicyRow): HostCapabilityPolicyRevision {
  return {
    host_policy_id: row.host_policy_id,
    policy_revision: row.policy_revision,
    purpose: row.purpose,
    host_id: row.host_id,
    principal_id: row.principal_id,
    grant_id: row.grant_id,
    supersedes_grant_id: row.supersedes_grant_id,
    superseded_by_grant_id: row.superseded_by_grant_id,
    activated_at: row.activated_at,
    superseded_at: row.superseded_at,
  };
}

function normalizeEvidence(evidence: readonly CapabilityGrantEvidence[]): CapabilityGrantEvidence[] {
  if (evidence.length === 0) throw new Error("CapabilityGrant evidence must not be empty.");
  const normalized = new Map<string, CapabilityGrantEvidence>();
  for (const item of evidence) {
    assertNonEmpty("evidence kind", item.kind);
    assertNonEmpty("evidence ref", item.ref);
    const value = { kind: item.kind, ref: item.ref };
    normalized.set(JSON.stringify([value.kind, value.ref]), value);
  }
  return [...normalized.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.ref.localeCompare(right.ref));
}

function parseEvidence(value: string): CapabilityGrantEvidence[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Stored CapabilityGrant evidence is invalid.");
  return normalizeEvidence(parsed.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Stored CapabilityGrant evidence is invalid.");
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.kind !== "string" || typeof candidate.ref !== "string") {
      throw new Error("Stored CapabilityGrant evidence is invalid.");
    }
    return { kind: candidate.kind, ref: candidate.ref };
  }));
}

function normalizeNonEmptySet(
  values: readonly string[],
  label: string,
  requireValue: boolean,
): string[] {
  if (requireValue && values.length === 0) throw new Error(`CapabilityGrant ${label} list must not be empty.`);
  for (const value of values) assertNonEmpty(label, value);
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function assertNonEmpty(label: string, value: string): string {
  if (!value.trim()) throw new Error(`CapabilityGrant ${label} must not be empty.`);
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseTimestamp(label: string, value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`CapabilityGrant ${label} must be an ISO timestamp.`);
  return timestamp;
}

let savepointSequence = 0;

function inSavepoint<T>(db: DatabaseSync, action: () => T): T {
  savepointSequence += 1;
  const name = `capability_grant_${savepointSequence}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = action();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}

function isoNow(): string {
  return new Date().toISOString();
}
