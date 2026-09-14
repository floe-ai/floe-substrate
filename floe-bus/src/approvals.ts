import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { OperationResourceRef } from "./operations.js";
import type { PolicyRuleEffect } from "./policies.js";

export type ApprovalExpectedEffect = Readonly<{
  summary: string;
  external: boolean;
  reversibility: "none" | "reversible" | "irreversible";
  resource_refs: readonly OperationResourceRef[];
}>;

/** Exact semantic action considered by the approver. */
export type ApprovalAction = Readonly<{
  operation_id: string;
  authorized_principal_id: string;
  target: OperationResourceRef | null;
  input_digest: string;
  artefact_version_ids: readonly string[];
  composition_revision_id: string | null;
  node_placement_id: string | null;
  scope_execution_id: string | null;
  node_execution_id: string | null;
  connector_binding_revision_id: string | null;
  extension_package_version_id: string | null;
  approval_policy_ref: OperationResourceRef | null;
  capability_grant_ids: readonly string[];
  expected_effect: ApprovalExpectedEffect;
}>;

export type ApprovalRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled"
  | "invalidated";

export type ApprovalDecision = "approved" | "rejected" | "changes_requested";

/** Exact requirement selected from one retained canonical Policy evaluation. */
export type ApprovalDecisionPolicyReference = Readonly<{
  policy_evaluation_id: string;
  policy_revision_id: string;
  rule_id: string;
}>;

export type ApprovalApproverSelector = Extract<
  PolicyRuleEffect,
  { kind: "require_approval" }
>["approvers"];

/** Immutable policy evidence copied from one canonical Policy evaluation. */
export type ApprovalDecisionPolicySnapshot = Readonly<{
  source:
    | Readonly<{
        kind: "policy_evaluation";
        policy_evaluation_id: string;
        policy_revision_id: string;
        rule_id: string;
        facts_digest: string;
      }>
    | Readonly<{ kind: "legacy_any_one" }>
    | Readonly<{ kind: "local_operator"; principal_id: string }>;
  approvers: ApprovalApproverSelector;
}>;

export type ApprovalRoleEvidence = Readonly<{
  role: string;
  authority_ref: string;
}>;

/** One append-only decision. A later decision may explicitly supersede it. */
export type ApprovalIndividualDecisionRecord = Readonly<{
  approval_decision_id: string;
  approval_request_id: string;
  workspace_id: string;
  principal_id: string;
  decision: ApprovalDecision;
  reason: string;
  decision_event_id: string;
  authority_grant_ids: readonly string[];
  role_evidence: readonly ApprovalRoleEvidence[];
  supersedes_decision_id: string | null;
  idempotency_key: string;
  decided_at: string;
  decision_set_digest: string;
  resolution_after: ApprovalDecision | null;
}>;

export type ApprovalProgress = Readonly<{
  approvals_received: number;
  approvals_required: number;
  active_decision_count: number;
  remaining_named_principal_ids: readonly string[];
  resolution: ApprovalDecision | null;
}>;

/**
 * Exact continuation of a waiting NodeExecution after one approval decision.
 * This is optional because Connector and Extension approvals can authorise an
 * action without advancing a ScopeExecution.
 */
export type ApprovalDecisionBinding = Readonly<{
  scope_execution_id: string;
  composition_revision_id: string;
  node_execution_id: string;
  node_placement_id: string;
  node_execution_state_revision: number;
  outcome_port_ids: Readonly<Record<ApprovalDecision, string>>;
}>;

export type ApprovalRequestRecord = Readonly<{
  approval_request_id: string;
  workspace_id: string;
  action: ApprovalAction;
  action_digest: string;
  /** Null only for a standalone attention item. */
  context_id: string | null;
  decision_binding: ApprovalDecisionBinding | null;
  /** Optional delivery of the resolved decision in this request's Context. */
  response_participant_id: string | null;
  decision_policy: ApprovalDecisionPolicySnapshot;
  decision_policy_digest: string;
  decision_set_digest: string;
  decisions: readonly ApprovalIndividualDecisionRecord[];
  progress: ApprovalProgress;
  requested_by_principal_id: string;
  reason: string;
  requested_at: string;
  expires_at: string;
  maximum_uses: number;
  idempotency_key: string;
  status: ApprovalRequestStatus;
  /** Exact decision; changes_requested leaves the proposed action rejected. */
  decision: ApprovalDecision | null;
  state_revision: number;
  decided_by_principal_id: string | null;
  decision_event_id: string | null;
  decision_reason: string | null;
  decided_at: string | null;
}>;

export type ApprovalReceiptRecord = Readonly<{
  approval_receipt_id: string;
  approval_request_id: string;
  workspace_id: string;
  action: ApprovalAction;
  action_digest: string;
  decision_set_digest: string;
  context_id: string | null;
  requested_by_principal_id: string;
  approved_by_principal_id: string;
  decision_event_id: string;
  issued_at: string;
  expires_at: string;
  maximum_uses: number;
  use_count: number;
  revoked_at: string | null;
  revoked_by_principal_id: string | null;
  revocation_reason: string | null;
}>;

export type ApprovalReceiptUseRecord = Readonly<{
  approval_receipt_id: string;
  use_id: string;
  workspace_id: string;
  principal_id: string;
  operation_id: string;
  action_digest: string;
  used_at: string;
}>;

export type ApprovalReceiptVerification = Readonly<{
  valid: true;
  receipt: ApprovalReceiptRecord;
  prior_use: ApprovalReceiptUseRecord | null;
}>;

export type ApprovalStoreDependencies = Readonly<{
  now?: () => string;
  request_id_factory?: () => string;
  receipt_id_factory?: () => string;
  decision_id_factory?: () => string;
  /** Resolved from canonical grants and role assignments, never decision input. */
  resolve_decision_authority?: (input: Readonly<{
    workspace_id: string;
    principal_id: string;
    approval_request_id: string;
    context_id: string | null;
    decision_binding: ApprovalDecisionBinding | null;
  }>) => Readonly<{
    authority_grant_ids: readonly string[];
    role_evidence: readonly ApprovalRoleEvidence[];
  }>;
  /** Rechecks exact action evidence and grants before decision or use. */
  action_is_current?: (input: Readonly<{
    workspace_id: string;
    approval_request_id: string;
    action: ApprovalAction;
    decision_policy: ApprovalDecisionPolicySnapshot;
    context_id: string | null;
    decision_binding: ApprovalDecisionBinding | null;
  }>) => boolean;
}>;

export class ApprovalValidationError extends Error {
  readonly code = "E_APPROVAL_INVALID" as const;
  constructor(readonly reason: string) {
    super(`Invalid approval: ${reason}`);
    this.name = "ApprovalValidationError";
  }
}

export class ApprovalNotFoundError extends Error {
  readonly code = "E_APPROVAL_NOT_FOUND" as const;
  constructor(readonly resource_kind: "request" | "receipt", readonly resource_id: string) {
    super(`Approval ${resource_kind} not found: ${resource_id}`);
    this.name = "ApprovalNotFoundError";
  }
}

export class ApprovalConflictError extends Error {
  readonly code = "E_APPROVAL_CONFLICT" as const;
  constructor(readonly approval_request_id: string, readonly reason: string) {
    super(`Approval request '${approval_request_id}' cannot change: ${reason}`);
    this.name = "ApprovalConflictError";
  }
}

export type ApprovalDenialCode =
  | "approval_receipt_not_found"
  | "approval_workspace_mismatch"
  | "approval_principal_mismatch"
  | "approval_operation_mismatch"
  | "approval_action_changed"
  | "approval_approver_ineligible"
  | "approval_approver_authority_changed"
  | "approval_not_yet_active"
  | "approval_expired"
  | "approval_revoked"
  | "approval_uses_exhausted";

export class ApprovalDeniedError extends Error {
  readonly code = "E_APPROVAL_DENIED" as const;
  constructor(readonly denial_code: ApprovalDenialCode) {
    super(approvalDenialMessage(denial_code));
    this.name = "ApprovalDeniedError";
  }
}

type ApprovalRequestRow = Readonly<{
  approval_request_id: string;
  workspace_id: string;
  action_json: string;
  action_digest: string;
  context_id: string | null;
  decision_binding_json: string;
  response_participant_id: string | null;
  decision_policy_json: string;
  decision_policy_digest: string;
  decision_set_digest: string;
  requested_by_principal_id: string;
  reason: string;
  requested_at: string;
  expires_at: string;
  maximum_uses: number;
  idempotency_key: string;
  status: ApprovalRequestStatus;
  decision_outcome: ApprovalDecision | null;
  state_revision: number;
  decided_by_principal_id: string | null;
  decision_event_id: string | null;
  decision_reason: string | null;
  decided_at: string | null;
}>;

type ApprovalReceiptRow = Readonly<{
  approval_receipt_id: string;
  approval_request_id: string;
  workspace_id: string;
  action_json: string;
  action_digest: string;
  decision_set_digest: string;
  context_id: string | null;
  requested_by_principal_id: string;
  approved_by_principal_id: string;
  decision_event_id: string;
  issued_at: string;
  expires_at: string;
  maximum_uses: number;
  revoked_at: string | null;
  revoked_by_principal_id: string | null;
  revocation_reason: string | null;
  use_count: number;
}>;

type ApprovalReceiptUseRow = Readonly<{
  approval_receipt_id: string;
  use_id: string;
  workspace_id: string;
  principal_id: string;
  operation_id: string;
  action_digest: string;
  used_at: string;
}>;

type ApprovalDecisionRow = Readonly<{
  approval_decision_id: string;
  approval_request_id: string;
  workspace_id: string;
  principal_id: string;
  decision: ApprovalDecision;
  reason: string;
  decision_event_id: string;
  authority_grant_ids_json: string;
  role_evidence_json: string;
  supersedes_decision_id: string | null;
  idempotency_key: string;
  decided_at: string;
  decision_set_digest: string;
  resolution_after: ApprovalDecision | null;
}>;

export function applyApprovalSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_requests (
      approval_request_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      action_json TEXT NOT NULL,
      action_digest TEXT NOT NULL,
      context_id TEXT REFERENCES contexts(context_id),
      decision_binding_json TEXT NOT NULL DEFAULT 'null',
      response_participant_id TEXT,
      decision_policy_json TEXT NOT NULL,
      decision_policy_digest TEXT NOT NULL,
      decision_set_digest TEXT NOT NULL,
      requested_by_principal_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      maximum_uses INTEGER NOT NULL CHECK (maximum_uses > 0),
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'invalidated')),
      decision_outcome TEXT CHECK (decision_outcome IS NULL OR decision_outcome IN ('approved', 'rejected', 'changes_requested')),
      state_revision INTEGER NOT NULL DEFAULT 1 CHECK (state_revision > 0),
      decided_by_principal_id TEXT,
      decision_event_id TEXT,
      decision_reason TEXT,
      decided_at TEXT,
      UNIQUE(workspace_id, requested_by_principal_id, idempotency_key),
      CHECK (
        (status = 'pending' AND decided_at IS NULL AND decided_by_principal_id IS NULL AND decision_event_id IS NULL)
        OR (
          status IN ('approved', 'rejected')
          AND decided_at IS NOT NULL
          AND decided_by_principal_id IS NOT NULL
          AND decision_event_id IS NOT NULL
          AND decision_reason IS NOT NULL
        )
        OR (
          status IN ('cancelled', 'invalidated')
          AND decided_at IS NOT NULL
          AND decided_by_principal_id IS NOT NULL
          AND decision_event_id IS NULL
          AND decision_reason IS NOT NULL
        )
      )
    );

  `);

  upgradeApprovalRequestSchema(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_receipts (
      approval_receipt_id TEXT PRIMARY KEY,
      approval_request_id TEXT NOT NULL UNIQUE REFERENCES approval_requests(approval_request_id),
      workspace_id TEXT NOT NULL,
      action_json TEXT NOT NULL,
      action_digest TEXT NOT NULL,
      decision_set_digest TEXT NOT NULL,
      context_id TEXT REFERENCES contexts(context_id),
      requested_by_principal_id TEXT NOT NULL,
      approved_by_principal_id TEXT NOT NULL,
      decision_event_id TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      maximum_uses INTEGER NOT NULL CHECK (maximum_uses > 0)
    );

    CREATE TABLE IF NOT EXISTS approval_individual_decisions (
      approval_decision_id TEXT PRIMARY KEY,
      approval_request_id TEXT NOT NULL REFERENCES approval_requests(approval_request_id),
      workspace_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'changes_requested')),
      reason TEXT NOT NULL,
      decision_event_id TEXT NOT NULL UNIQUE,
      authority_grant_ids_json TEXT NOT NULL,
      role_evidence_json TEXT NOT NULL,
      supersedes_decision_id TEXT REFERENCES approval_individual_decisions(approval_decision_id),
      idempotency_key TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      decision_set_digest TEXT NOT NULL,
      resolution_after TEXT CHECK (resolution_after IS NULL OR resolution_after IN ('approved', 'rejected', 'changes_requested')),
      UNIQUE(approval_request_id, principal_id, idempotency_key),
      UNIQUE(approval_request_id, supersedes_decision_id)
    );

    CREATE INDEX IF NOT EXISTS idx_approval_decisions_request
      ON approval_individual_decisions(approval_request_id, decided_at, approval_decision_id);

    CREATE TABLE IF NOT EXISTS approval_receipt_revocations (
      approval_receipt_id TEXT PRIMARY KEY REFERENCES approval_receipts(approval_receipt_id),
      workspace_id TEXT NOT NULL,
      revoked_at TEXT NOT NULL,
      revoked_by_principal_id TEXT NOT NULL,
      revocation_reason TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_approval_receipt_revocations_workspace
      ON approval_receipt_revocations(workspace_id, revoked_at DESC);

    CREATE TABLE IF NOT EXISTS approval_receipt_uses (
      approval_receipt_id TEXT NOT NULL REFERENCES approval_receipts(approval_receipt_id),
      use_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      action_digest TEXT NOT NULL,
      used_at TEXT NOT NULL,
      PRIMARY KEY (approval_receipt_id, use_id)
    );

    CREATE INDEX IF NOT EXISTS idx_approval_receipt_uses_workspace
      ON approval_receipt_uses(workspace_id, used_at DESC);

    CREATE TRIGGER IF NOT EXISTS trg_approval_receipt_use_limit
    BEFORE INSERT ON approval_receipt_uses
    WHEN (
      SELECT COUNT(*) FROM approval_receipt_uses
      WHERE approval_receipt_id = NEW.approval_receipt_id
    ) >= (
      SELECT maximum_uses FROM approval_receipts
      WHERE approval_receipt_id = NEW.approval_receipt_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'approval_uses_exhausted');
    END;
  `);
  upgradeApprovalReceiptSchema(db);
  migrateLegacyApprovalState(db);
  relaxLegacyApprovalContextColumns(db);
  // Rebuilding a legacy parent table drops its attached indexes. Keep these
  // declarations here as the single canonical post-upgrade repair.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_approval_requests_attention
      ON approval_requests(workspace_id, status, requested_at DESC);

    CREATE INDEX IF NOT EXISTS idx_approval_requests_context
      ON approval_requests(workspace_id, context_id, requested_at DESC);

    CREATE INDEX IF NOT EXISTS idx_approval_receipts_workspace_expiry
      ON approval_receipts(workspace_id, expires_at);
  `);
}

/** Preserve retained approvals while adding the canonical decision continuation. */
function upgradeApprovalRequestSchema(db: DatabaseSync): void {
  const columns = new Set((db.prepare("PRAGMA table_info(approval_requests)").all() as Array<{ name: string }>)
    .map((column) => column.name));
  if (!columns.has("decision_binding_json")) {
    db.exec("ALTER TABLE approval_requests ADD COLUMN decision_binding_json TEXT NOT NULL DEFAULT 'null'");
  }
  if (!columns.has("response_participant_id")) {
    db.exec("ALTER TABLE approval_requests ADD COLUMN response_participant_id TEXT");
  }
  if (!columns.has("decision_outcome")) {
    db.exec(`
      ALTER TABLE approval_requests ADD COLUMN decision_outcome TEXT
        CHECK (decision_outcome IS NULL OR decision_outcome IN ('approved', 'rejected', 'changes_requested'))
    `);
    db.exec(`
      UPDATE approval_requests
      SET decision_outcome = status
      WHERE status IN ('approved', 'rejected') AND decision_outcome IS NULL
    `);
  }
  if (!columns.has("decision_policy_json")) {
    db.exec("ALTER TABLE approval_requests ADD COLUMN decision_policy_json TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has("decision_policy_digest")) {
    db.exec("ALTER TABLE approval_requests ADD COLUMN decision_policy_digest TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has("decision_set_digest")) {
    db.exec("ALTER TABLE approval_requests ADD COLUMN decision_set_digest TEXT NOT NULL DEFAULT ''");
  }
}

function upgradeApprovalReceiptSchema(db: DatabaseSync): void {
  const columns = new Set((db.prepare("PRAGMA table_info(approval_receipts)").all() as Array<{ name: string }>)
    .map((column) => column.name));
  if (!columns.has("decision_set_digest")) {
    db.exec("ALTER TABLE approval_receipts ADD COLUMN decision_set_digest TEXT NOT NULL DEFAULT ''");
  }
}

/**
 * Early approval schemas required every request and receipt to name a Context.
 * Canonical standalone attention items intentionally do not. Rebuild only the
 * two affected parent tables while retaining every row and all external
 * foreign-key relationships by their stable table names.
 */
function relaxLegacyApprovalContextColumns(db: DatabaseSync): void {
  const requestContextRequired = contextColumnIsRequired(db, "approval_requests");
  const receiptContextRequired = contextColumnIsRequired(db, "approval_receipts");
  if (!requestContextRequired && !receiptContextRequired) return;

  const priorDeferred = Number((db.prepare("PRAGMA defer_foreign_keys").get() as {
    defer_foreign_keys: number;
  }).defer_foreign_keys) === 1;
  if (priorDeferred) {
    throw new Error("Approval schema cannot be rebuilt while unrelated foreign keys are already deferred.");
  }

  const suffix = randomUUID().replaceAll("-", "");
  const savepoint = `approval_context_nullable_${suffix}`;
  const requestReplacement = `approval_requests_nullable_${suffix}`;
  const receiptReplacement = `approval_receipts_nullable_${suffix}`;
  const requestSql = nullableContextReplacementSql(
    db,
    "approval_requests",
    requestReplacement,
    requestContextRequired,
  );
  const receiptSql = nullableContextReplacementSql(
    db,
    "approval_receipts",
    receiptReplacement,
    receiptContextRequired,
  );
  const receiptUseLimitTrigger = db.prepare(`
    SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'trg_approval_receipt_use_limit'
  `).get() as { sql: string | null } | undefined;
  if (!receiptUseLimitTrigger?.sql) {
    throw new Error("Approval receipt use-limit trigger is unavailable during schema rebuild.");
  }
  const requestColumns = tableColumns(db, "approval_requests");
  const receiptColumns = tableColumns(db, "approval_receipts");

  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    // DROP TABLE records a transient parent-key violation even though the same
    // stable name is restored below. Defer it, verify the final graph, then
    // clear only that transient record before releasing the savepoint.
    db.exec("PRAGMA defer_foreign_keys = ON");
    // SQLite validates trigger bodies during ALTER TABLE. Remove this trigger
    // only for the interval in which its referenced parent name is absent.
    db.exec("DROP TRIGGER trg_approval_receipt_use_limit");
    db.exec(requestSql);
    db.exec(receiptSql);
    db.exec(`
      INSERT INTO ${requestReplacement} (${requestColumns})
      SELECT ${requestColumns} FROM approval_requests;
      INSERT INTO ${receiptReplacement} (${receiptColumns})
      SELECT ${receiptColumns} FROM approval_receipts;
      DROP TABLE approval_receipts;
      DROP TABLE approval_requests;
      ALTER TABLE ${requestReplacement} RENAME TO approval_requests;
      ALTER TABLE ${receiptReplacement} RENAME TO approval_receipts;
    `);
    db.exec(receiptUseLimitTrigger.sql);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error("Approval schema rebuild would leave invalid foreign-key references.");
    }
    db.exec("PRAGMA defer_foreign_keys = OFF");
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    db.exec("PRAGMA defer_foreign_keys = OFF");
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}

function contextColumnIsRequired(db: DatabaseSync, table: string): boolean {
  const row = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    notnull: number;
  }>).find((column) => column.name === "context_id");
  if (!row) throw new Error(`Approval table '${table}' has no context_id column.`);
  return Number(row.notnull) === 1;
}

function nullableContextReplacementSql(
  db: DatabaseSync,
  table: "approval_requests" | "approval_receipts",
  replacement: string,
  contextRequired: boolean,
): string {
  const row = db.prepare(`
    SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?
  `).get(table) as { sql: string | null } | undefined;
  if (!row?.sql) throw new Error(`Approval table '${table}' has no retained schema.`);
  const declaration = new RegExp(`^CREATE TABLE(?: IF NOT EXISTS)?\\s+(?:"${table}"|${table})`, "i");
  if (!declaration.test(row.sql)) {
    throw new Error(`Approval table '${table}' has an unsupported declaration.`);
  }
  let sql = row.sql.replace(declaration, `CREATE TABLE ${replacement}`);
  if (contextRequired) {
    const relaxed = sql.replace(
      /(\bcontext_id\s+TEXT)\s+NOT\s+NULL(\s+REFERENCES\s+contexts\s*\(\s*context_id\s*\))/i,
      "$1$2",
    );
    if (relaxed === sql) {
      throw new Error(`Approval table '${table}' context constraint could not be relaxed safely.`);
    }
    sql = relaxed;
  }
  return sql;
}

function tableColumns(db: DatabaseSync, table: string): string {
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((column) => `"${column.name.replaceAll('"', '""')}"`);
  if (columns.length === 0) throw new Error(`Approval table '${table}' has no columns.`);
  return columns.join(", ");
}

/** Preserve the old one-decision model as an explicit any-one snapshot. */
function migrateLegacyApprovalState(db: DatabaseSync): void {
  const rows = db.prepare(`
    SELECT * FROM approval_requests
    WHERE decision_policy_json = '' OR decision_policy_digest = '' OR decision_set_digest = ''
  `).all() as ApprovalRequestRow[];
  for (const row of rows) {
    const named = row.decided_by_principal_id ? [row.decided_by_principal_id] : [];
    const policy: ApprovalDecisionPolicySnapshot = {
      source: { kind: "legacy_any_one" },
      approvers: {
        mode: "any",
        principal_ids: named,
        roles: named.length > 0 ? [] : ["legacy:approval_decider"],
      },
    };
    const policyJson = canonicalJson(policy);
    const policyDigest = digest("floe-approval-decision-policy:v1", policy);
    let decisions: ApprovalIndividualDecisionRecord[] = [];
    if (
      row.decision_outcome
      && row.decided_by_principal_id
      && row.decision_event_id
      && row.decision_reason
      && row.decided_at
    ) {
      const decisionId = `approval_decision_legacy_${createHash("sha256")
        .update(`${row.approval_request_id}\0${row.decision_event_id}`)
        .digest("hex")
        .slice(0, 32)}`;
      const provisional: ApprovalIndividualDecisionRecord = {
        approval_decision_id: decisionId,
        approval_request_id: row.approval_request_id,
        workspace_id: row.workspace_id,
        principal_id: row.decided_by_principal_id,
        decision: row.decision_outcome,
        reason: row.decision_reason,
        decision_event_id: row.decision_event_id,
        authority_grant_ids: [],
        role_evidence: [{ role: "legacy:retained", authority_ref: "schema-migration" }],
        supersedes_decision_id: null,
        idempotency_key: `legacy:${row.decision_event_id}`,
        decided_at: row.decided_at,
        decision_set_digest: "",
        resolution_after: row.decision_outcome,
      };
      const setDigest = approvalDecisionSetDigest([provisional]);
      const migrated = { ...provisional, decision_set_digest: setDigest };
      db.prepare(`
        INSERT OR IGNORE INTO approval_individual_decisions (
          approval_decision_id, approval_request_id, workspace_id, principal_id,
          decision, reason, decision_event_id, authority_grant_ids_json,
          role_evidence_json, supersedes_decision_id, idempotency_key, decided_at,
          decision_set_digest, resolution_after
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
      `).run(
        migrated.approval_decision_id,
        migrated.approval_request_id,
        migrated.workspace_id,
        migrated.principal_id,
        migrated.decision,
        migrated.reason,
        migrated.decision_event_id,
        canonicalJson(migrated.authority_grant_ids),
        canonicalJson(migrated.role_evidence),
        migrated.idempotency_key,
        migrated.decided_at,
        migrated.decision_set_digest,
        migrated.resolution_after,
      );
      decisions = [migrated];
    }
    const decisionSetDigest = approvalDecisionSetDigest(decisions);
    db.prepare(`
      UPDATE approval_requests
      SET decision_policy_json = ?, decision_policy_digest = ?, decision_set_digest = ?
      WHERE approval_request_id = ?
    `).run(policyJson, policyDigest, decisionSetDigest, row.approval_request_id);
    db.prepare(`
      UPDATE approval_receipts SET decision_set_digest = ?
      WHERE approval_request_id = ? AND decision_set_digest = ''
    `).run(decisionSetDigest, row.approval_request_id);
  }
}

export class ApprovalStore {
  private readonly now: () => string;
  private readonly requestId: () => string;
  private readonly receiptId: () => string;
  private readonly decisionId: () => string;
  private readonly resolveDecisionAuthority: NonNullable<ApprovalStoreDependencies["resolve_decision_authority"]>;
  private readonly actionIsCurrent: NonNullable<ApprovalStoreDependencies["action_is_current"]>;

  constructor(
    private readonly db: DatabaseSync,
    dependencies: ApprovalStoreDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.requestId = dependencies.request_id_factory ?? (() => `approval_request_${randomUUID()}`);
    this.receiptId = dependencies.receipt_id_factory ?? (() => `approval_receipt_${randomUUID()}`);
    this.decisionId = dependencies.decision_id_factory ?? (() => `approval_decision_${randomUUID()}`);
    this.resolveDecisionAuthority = dependencies.resolve_decision_authority
      ?? (() => ({ authority_grant_ids: [], role_evidence: [] }));
    this.actionIsCurrent = dependencies.action_is_current ?? (() => true);
  }

  createRequest(input: Readonly<{
    workspace_id: string;
    action: ApprovalAction;
    context_id: string | null;
    decision_binding?: ApprovalDecisionBinding | null;
    decision_policy?: ApprovalDecisionPolicySnapshot;
    requested_by_principal_id: string;
    reason: string;
    expires_at: string;
    maximum_uses?: number;
    idempotency_key: string;
  }>): ApprovalRequestRecord {
    const workspaceId = requireText(input.workspace_id, "workspace_id");
    const contextId = input.context_id == null ? null : requireText(input.context_id, "context_id");
    const requestedBy = requireText(input.requested_by_principal_id, "requested_by_principal_id");
    const reason = requireText(input.reason, "reason", 16_384);
    const expiresAt = requireFutureTimestamp(input.expires_at, this.now(), "expires_at");
    const maximumUses = requirePositiveInteger(input.maximum_uses ?? 1, "maximum_uses");
    const idempotencyKey = requireText(input.idempotency_key, "idempotency_key", 512);
    const action = normalizeApprovalAction(input.action);
    const decisionBinding = normalizeApprovalDecisionBinding(input.decision_binding ?? null);
    if (
      contextId === null
      && (decisionBinding || action.scope_execution_id !== null || action.node_execution_id !== null)
    ) {
      throw new ApprovalValidationError("a Scope- or NodeExecution-bound approval requires its exact active Context");
    }
    const decisionPolicy = normalizeApprovalDecisionPolicy(input.decision_policy ?? legacyDecisionPolicy());
    const decisionBindingJson = canonicalJson(decisionBinding);
    const decisionPolicyJson = canonicalJson(decisionPolicy);
    const decisionPolicyDigest = digest("floe-approval-decision-policy:v1", decisionPolicy);
    const decisionSetDigest = approvalDecisionSetDigest([]);
    const actionJson = canonicalJson(action);
    const actionDigest = approvalActionDigest(action);
    const existing = this.db.prepare(`
      SELECT * FROM approval_requests
      WHERE workspace_id = ? AND requested_by_principal_id = ? AND idempotency_key = ?
    `).get(workspaceId, requestedBy, idempotencyKey) as ApprovalRequestRow | undefined;
    if (existing) {
      const record = mapRequest(existing, this.listDecisions(existing.approval_request_id));
      if (
        record.action_digest !== actionDigest
        || record.context_id !== contextId
        || canonicalJson(record.decision_binding) !== decisionBindingJson
        || record.decision_policy_digest !== decisionPolicyDigest
        || record.reason !== reason
        || record.expires_at !== expiresAt
        || record.maximum_uses !== maximumUses
      ) {
        throw new ApprovalConflictError(record.approval_request_id, "the idempotency key was already used for different approval details");
      }
      return record;
    }
    const requestedAt = this.now();
    if (Date.parse(expiresAt) <= Date.parse(requestedAt)) {
      throw new ApprovalValidationError("expires_at must be later than requested_at");
    }
    const requestId = this.requestId();
    this.db.prepare(`
      INSERT INTO approval_requests (
        approval_request_id, workspace_id, action_json, action_digest,
        context_id, decision_binding_json, decision_policy_json, decision_policy_digest,
        decision_set_digest, requested_by_principal_id, reason, requested_at, expires_at,
        maximum_uses, idempotency_key, status, state_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1)
    `).run(
      requestId, workspaceId, actionJson, actionDigest, contextId, decisionBindingJson,
      decisionPolicyJson, decisionPolicyDigest, decisionSetDigest, requestedBy, reason,
      requestedAt, expiresAt, maximumUses, idempotencyKey,
    );
    return this.requireRequest(requestId);
  }

  decideRequest(input: Readonly<{
    workspace_id: string;
    approval_request_id: string;
    expected_state_revision: number;
    decision: ApprovalDecision;
    decided_by_principal_id: string;
    decision_event_id: string;
    decision_reason: string;
    receipt_expires_at?: string;
    supersedes_decision_id?: string | null;
    idempotency_key?: string;
  }>): Readonly<{
    request: ApprovalRequestRecord;
    receipt: ApprovalReceiptRecord | null;
    individual_decision: ApprovalIndividualDecisionRecord;
  }> {
    const workspaceId = requireText(input.workspace_id, "workspace_id");
    const request = this.requireRequestForWorkspace(input.approval_request_id, workspaceId);
    const decidedBy = requireText(input.decided_by_principal_id, "decided_by_principal_id");
    const decisionEventId = requireText(input.decision_event_id, "decision_event_id");
    const decisionReason = requireText(input.decision_reason, "decision_reason", 16_384);
    const idempotencyKey = requireText(
      input.idempotency_key ?? decisionEventId,
      "idempotency_key",
      512,
    );
    const retainedBeforeValidation = this.listDecisions(request.approval_request_id);
    const idempotentBeforeValidation = retainedBeforeValidation.find((item) =>
      item.principal_id === decidedBy && item.idempotency_key === idempotencyKey
    );
    if (idempotentBeforeValidation) {
      if (
        idempotentBeforeValidation.decision !== input.decision
        || idempotentBeforeValidation.reason !== decisionReason
        || idempotentBeforeValidation.supersedes_decision_id !== (input.supersedes_decision_id ?? null)
      ) {
        throw new ApprovalConflictError(request.approval_request_id, "the decision idempotency key was reused for different vote details");
      }
      return {
        request,
        receipt: this.getReceiptForRequest(request.approval_request_id),
        individual_decision: idempotentBeforeValidation,
      };
    }
    if (request.status !== "pending") {
      throw new ApprovalConflictError(request.approval_request_id, `it is already ${request.status}`);
    }
    const decidedAt = this.now();
    if (Date.parse(decidedAt) >= Date.parse(request.expires_at)) {
      throw new ApprovalConflictError(request.approval_request_id, "it expired before the decision was recorded");
    }
    if (!this.actionIsCurrent({
      workspace_id: request.workspace_id,
      approval_request_id: request.approval_request_id,
      action: request.action,
      decision_policy: request.decision_policy,
      context_id: request.context_id,
      decision_binding: request.decision_binding,
    })) {
      throw new ApprovalConflictError(request.approval_request_id, "its exact action, evidence, authority, or Policy is no longer current");
    }
    const authority = this.resolveDecisionAuthority({
      workspace_id: workspaceId,
      principal_id: decidedBy,
      approval_request_id: request.approval_request_id,
      context_id: request.context_id,
      decision_binding: request.decision_binding,
    });
    const eligible = eligibleDecisionAuthority(request.decision_policy, decidedBy, authority);
    if (!eligible.eligible) {
      throw new ApprovalDeniedError("approval_approver_ineligible");
    }
    let receiptExpiresAt: string | null = null;
    if (input.decision === "approved") {
      receiptExpiresAt = input.receipt_expires_at
        ? requireFutureTimestamp(input.receipt_expires_at, decidedAt, "receipt_expires_at")
        : request.expires_at;
      if (Date.parse(receiptExpiresAt) > Date.parse(request.expires_at)) {
        throw new ApprovalValidationError("receipt_expires_at cannot exceed the approval request expiry");
      }
    }

    return inSavepoint(this.db, "decide_approval", () => {
      const retained = this.listDecisions(request.approval_request_id);
      const idempotent = retained.find((item) =>
        item.principal_id === decidedBy && item.idempotency_key === idempotencyKey
      );
      if (idempotent) {
        if (
          idempotent.decision !== input.decision
          || idempotent.reason !== decisionReason
          || idempotent.supersedes_decision_id !== (input.supersedes_decision_id ?? null)
        ) {
          throw new ApprovalConflictError(request.approval_request_id, "the decision idempotency key was reused for different vote details");
        }
        return {
          request: this.requireRequest(request.approval_request_id),
          receipt: this.getReceiptForRequest(request.approval_request_id),
          individual_decision: idempotent,
        };
      }
      const active = activeApprovalDecisions(retained);
      for (const prior of active) {
        if (!this.decisionAuthorityIsCurrent(request, prior)) {
          throw new ApprovalConflictError(request.approval_request_id, `approver authority for '${prior.principal_id}' is no longer current`);
        }
      }
      const prior = active.find((item) => item.principal_id === decidedBy) ?? null;
      if (prior) {
        if (!input.supersedes_decision_id) {
          if (prior.decision === input.decision && prior.reason === decisionReason) {
            return {
              request: this.requireRequest(request.approval_request_id),
              receipt: this.getReceiptForRequest(request.approval_request_id),
              individual_decision: prior,
            };
          }
          throw new ApprovalConflictError(request.approval_request_id, "a changed decision must explicitly supersede the principal's active decision");
        }
        if (input.supersedes_decision_id !== prior.approval_decision_id) {
          throw new ApprovalConflictError(request.approval_request_id, "supersedes_decision_id is not the principal's active decision");
        }
      } else if (input.supersedes_decision_id) {
        throw new ApprovalConflictError(request.approval_request_id, "there is no active decision by this principal to supersede");
      }

      const decisionId = this.decisionId();
      const provisional: ApprovalIndividualDecisionRecord = {
        approval_decision_id: decisionId,
        approval_request_id: request.approval_request_id,
        workspace_id: workspaceId,
        principal_id: decidedBy,
        decision: input.decision,
        reason: decisionReason,
        decision_event_id: decisionEventId,
        authority_grant_ids: uniqueSorted(authority.authority_grant_ids, "authority_grant_id"),
        role_evidence: eligible.role_evidence,
        supersedes_decision_id: input.supersedes_decision_id ?? null,
        idempotency_key: idempotencyKey,
        decided_at: decidedAt,
        decision_set_digest: "",
        resolution_after: null,
      };
      const allDecisions = [...retained, provisional];
      const activeAfter = activeApprovalDecisions(allDecisions);
      const resolution = resolveApprovalDecisionPolicy(request.decision_policy, activeAfter);
      const decisionSetDigest = approvalDecisionSetDigest(allDecisions);
      const individualDecision: ApprovalIndividualDecisionRecord = {
        ...provisional,
        decision_set_digest: decisionSetDigest,
        resolution_after: resolution,
      };
      this.db.prepare(`
        INSERT INTO approval_individual_decisions (
          approval_decision_id, approval_request_id, workspace_id, principal_id,
          decision, reason, decision_event_id, authority_grant_ids_json,
          role_evidence_json, supersedes_decision_id, idempotency_key, decided_at,
          decision_set_digest, resolution_after
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        individualDecision.approval_decision_id,
        individualDecision.approval_request_id,
        individualDecision.workspace_id,
        individualDecision.principal_id,
        individualDecision.decision,
        individualDecision.reason,
        individualDecision.decision_event_id,
        canonicalJson(individualDecision.authority_grant_ids),
        canonicalJson(individualDecision.role_evidence),
        individualDecision.supersedes_decision_id,
        individualDecision.idempotency_key,
        individualDecision.decided_at,
        individualDecision.decision_set_digest,
        individualDecision.resolution_after,
      );
      const changed = this.db.prepare(`
        UPDATE approval_requests
        SET status = ?, decision_outcome = ?, decision_set_digest = ?,
            state_revision = state_revision + 1,
            decided_by_principal_id = ?, decision_event_id = ?,
            decision_reason = ?, decided_at = ?
        WHERE approval_request_id = ? AND workspace_id = ? AND status = 'pending'
      `).run(
        resolution === null ? "pending" : resolution === "approved" ? "approved" : "rejected",
        resolution,
        decisionSetDigest,
        resolution === null ? null : decidedBy,
        resolution === null ? null : decisionEventId,
        resolution === null ? null : decisionReason,
        resolution === null ? null : decidedAt,
        request.approval_request_id,
        workspaceId,
      );
      if (Number(changed.changes) !== 1) {
        throw new ApprovalConflictError(request.approval_request_id, "the request resolved while this decision was being recorded");
      }
      let receipt: ApprovalReceiptRecord | null = null;
      if (resolution === "approved") {
        const receiptId = this.receiptId();
        this.db.prepare(`
          INSERT INTO approval_receipts (
            approval_receipt_id, approval_request_id, workspace_id,
            action_json, action_digest, decision_set_digest, context_id,
            requested_by_principal_id, approved_by_principal_id,
            decision_event_id, issued_at, expires_at, maximum_uses
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          receiptId, request.approval_request_id, workspaceId,
          canonicalJson(request.action), request.action_digest, decisionSetDigest,
          request.context_id, request.requested_by_principal_id, decidedBy,
          decisionEventId, decidedAt, receiptExpiresAt!, request.maximum_uses,
        );
        receipt = this.requireReceipt(receiptId);
      }
      return {
        request: this.requireRequest(request.approval_request_id),
        receipt,
        individual_decision: individualDecision,
      };
    });
  }

  cancelRequest(input: Readonly<{
    workspace_id: string;
    approval_request_id: string;
    expected_state_revision: number;
    cancelled_by_principal_id: string;
    reason: string;
  }>): ApprovalRequestRecord {
    return this.finishPendingRequest({ ...input, status: "cancelled" });
  }

  invalidateRequest(input: Readonly<{
    workspace_id: string;
    approval_request_id: string;
    expected_state_revision: number;
    invalidated_by_principal_id: string;
    reason: string;
  }>): ApprovalRequestRecord {
    return this.finishPendingRequest({
      workspace_id: input.workspace_id,
      approval_request_id: input.approval_request_id,
      expected_state_revision: input.expected_state_revision,
      cancelled_by_principal_id: input.invalidated_by_principal_id,
      reason: input.reason,
      status: "invalidated",
    });
  }

  /**
   * Materialises a stale pending request instead of leaving it in the operator
   * attention queue. The immutable action and decision history remain intact.
   */
  refreshRequestValidity(input: Readonly<{
    workspace_id: string;
    approval_request_id: string;
    invalidated_by_principal_id: string;
  }>): Readonly<{ request: ApprovalRequestRecord; invalidated: boolean }> {
    const request = this.requireRequestForWorkspace(input.approval_request_id, input.workspace_id);
    if (request.status !== "pending") return { request, invalidated: false };
    let reason: string | null = null;
    if (!this.actionIsCurrent({
      workspace_id: request.workspace_id,
      approval_request_id: request.approval_request_id,
      action: request.action,
      decision_policy: request.decision_policy,
      context_id: request.context_id,
      decision_binding: request.decision_binding,
    })) {
      reason = "The exact action, evidence, authority, or Policy is no longer current.";
    } else {
      const invalidDecision = activeApprovalDecisions(request.decisions)
        .find((decision) => !this.decisionAuthorityIsCurrent(request, decision));
      if (invalidDecision) {
        reason = `Approver authority for '${invalidDecision.principal_id}' is no longer current.`;
      }
    }
    if (!reason) return { request, invalidated: false };
    return {
      request: this.invalidateRequest({
        workspace_id: request.workspace_id,
        approval_request_id: request.approval_request_id,
        expected_state_revision: request.state_revision,
        invalidated_by_principal_id: input.invalidated_by_principal_id,
        reason,
      }),
      invalidated: true,
    };
  }

  verifyReceipt(input: Readonly<{
    approval_receipt_id: string;
    workspace_id: string;
    principal_id: string;
    action: ApprovalAction;
    at?: string;
  }>): ApprovalReceiptVerification {
    const receipt = this.getReceipt(input.approval_receipt_id);
    if (!receipt) throw new ApprovalDeniedError("approval_receipt_not_found");
    const at = requireTimestamp(input.at ?? this.now(), "at");
    if (receipt.workspace_id !== input.workspace_id) throw new ApprovalDeniedError("approval_workspace_mismatch");
    if (receipt.action.authorized_principal_id !== input.principal_id) throw new ApprovalDeniedError("approval_principal_mismatch");
    if (receipt.action.operation_id !== input.action.operation_id) throw new ApprovalDeniedError("approval_operation_mismatch");
    if (receipt.action_digest !== approvalActionDigest(input.action)) throw new ApprovalDeniedError("approval_action_changed");
    if (receipt.revoked_at) throw new ApprovalDeniedError("approval_revoked");
    const request = this.getRequest(receipt.approval_request_id);
    if (
      !request
      || request.status !== "approved"
      || request.decision !== "approved"
      || request.action_digest !== receipt.action_digest
      || request.decision_set_digest !== receipt.decision_set_digest
      || approvalDecisionSetDigest(request.decisions) !== receipt.decision_set_digest
      || !this.actionIsCurrent({
        workspace_id: request.workspace_id,
        approval_request_id: request.approval_request_id,
        action: request.action,
        decision_policy: request.decision_policy,
        context_id: request.context_id,
        decision_binding: request.decision_binding,
      })
    ) {
      this.revokeReceipt({
        workspace_id: receipt.workspace_id,
        approval_receipt_id: receipt.approval_receipt_id,
        revoked_by_principal_id: "system:approval-validity",
        reason: "The exact approved action, evidence, or Policy is no longer current.",
      });
      throw new ApprovalDeniedError("approval_action_changed");
    }
    for (const decision of activeApprovalDecisions(request.decisions)) {
      if (decision.decision === "approved" && !this.decisionAuthorityIsCurrent(request, decision)) {
        this.revokeReceipt({
          workspace_id: receipt.workspace_id,
          approval_receipt_id: receipt.approval_receipt_id,
          revoked_by_principal_id: "system:approval-validity",
          reason: `Approver authority for '${decision.principal_id}' is no longer current.`,
        });
        throw new ApprovalDeniedError("approval_approver_authority_changed");
      }
    }
    if (Date.parse(at) < Date.parse(receipt.issued_at)) throw new ApprovalDeniedError("approval_not_yet_active");
    if (Date.parse(at) >= Date.parse(receipt.expires_at)) throw new ApprovalDeniedError("approval_expired");
    if (receipt.use_count >= receipt.maximum_uses) throw new ApprovalDeniedError("approval_uses_exhausted");
    return { valid: true, receipt, prior_use: null };
  }

  consumeReceipt(input: Readonly<{
    approval_receipt_id: string;
    use_id: string;
    workspace_id: string;
    principal_id: string;
    action: ApprovalAction;
    at?: string;
  }>): ApprovalReceiptVerification {
    const useId = requireText(input.use_id, "use_id", 512);
    const prior = this.getUse(input.approval_receipt_id, useId);
    if (prior) {
      if (
        prior.workspace_id !== input.workspace_id
        || prior.principal_id !== input.principal_id
        || prior.operation_id !== input.action.operation_id
        || prior.action_digest !== approvalActionDigest(input.action)
      ) {
        throw new ApprovalDeniedError("approval_action_changed");
      }
      const receipt = this.requireReceipt(input.approval_receipt_id);
      return { valid: true, receipt, prior_use: prior };
    }
    const verification = this.verifyReceipt(input);
    return inSavepoint(this.db, "consume_approval", () => {
      const usedAt = requireTimestamp(input.at ?? this.now(), "at");
      this.db.prepare(`
        INSERT INTO approval_receipt_uses (
          approval_receipt_id, use_id, workspace_id, principal_id,
          operation_id, action_digest, used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        verification.receipt.approval_receipt_id, useId, input.workspace_id,
        input.principal_id, input.action.operation_id,
        verification.receipt.action_digest, usedAt,
      );
      return {
        valid: true as const,
        receipt: this.requireReceipt(input.approval_receipt_id),
        prior_use: null,
      };
    });
  }

  revokeReceipt(input: Readonly<{
    workspace_id: string;
    approval_receipt_id: string;
    revoked_by_principal_id: string;
    reason: string;
  }>): ApprovalReceiptRecord {
    const receipt = this.requireReceiptForWorkspace(input.approval_receipt_id, input.workspace_id);
    if (receipt.revoked_at) return receipt;
    const revokedAt = this.now();
    this.db.prepare(`
      INSERT INTO approval_receipt_revocations (
        approval_receipt_id, workspace_id, revoked_at,
        revoked_by_principal_id, revocation_reason
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      receipt.approval_receipt_id,
      receipt.workspace_id,
      revokedAt,
      requireText(input.revoked_by_principal_id, "revoked_by_principal_id"),
      requireText(input.reason, "reason", 16_384),
    );
    return this.requireReceipt(receipt.approval_receipt_id);
  }

  getRequest(id: string): ApprovalRequestRecord | null {
    const row = this.db.prepare("SELECT * FROM approval_requests WHERE approval_request_id = ?")
      .get(id) as ApprovalRequestRow | undefined;
    return row ? mapRequest(row, this.listDecisions(row.approval_request_id)) : null;
  }

  requireRequest(id: string): ApprovalRequestRecord {
    const request = this.getRequest(id);
    if (!request) throw new ApprovalNotFoundError("request", id);
    return request;
  }

  requireRequestForWorkspace(id: string, workspaceId: string): ApprovalRequestRecord {
    const request = this.requireRequest(id);
    if (request.workspace_id !== workspaceId) throw new ApprovalNotFoundError("request", id);
    return request;
  }

  listRequests(workspaceId: string, options: Readonly<{
    status?: ApprovalRequestStatus;
    include_expired?: boolean;
    limit?: number;
  }> = {}): ApprovalRequestRecord[] {
    const limit = Math.min(500, requirePositiveInteger(options.limit ?? 100, "limit"));
    const rows = options.status
      ? this.db.prepare(`
          SELECT * FROM approval_requests
          WHERE workspace_id = ? AND status = ?
          ORDER BY requested_at DESC, approval_request_id DESC LIMIT ?
        `).all(workspaceId, options.status, limit)
      : this.db.prepare(`
          SELECT * FROM approval_requests
          WHERE workspace_id = ?
          ORDER BY requested_at DESC, approval_request_id DESC LIMIT ?
        `).all(workspaceId, limit);
    const now = Date.parse(this.now());
    return (rows as ApprovalRequestRow[])
      .map((row) => mapRequest(row, this.listDecisions(row.approval_request_id)))
      .filter((request) => options.include_expired || request.status !== "pending" || Date.parse(request.expires_at) > now);
  }

  listAttention(workspaceId: string, limit = 100): ApprovalRequestRecord[] {
    const now = this.now();
    return (this.db.prepare(`
      SELECT * FROM approval_requests
      WHERE workspace_id = ? AND status = 'pending' AND expires_at > ?
      ORDER BY requested_at ASC, approval_request_id ASC LIMIT ?
    `).all(workspaceId, now, Math.min(500, requirePositiveInteger(limit, "limit"))) as ApprovalRequestRow[])
      .map((row) => mapRequest(row, this.listDecisions(row.approval_request_id)));
  }

  getReceipt(id: string): ApprovalReceiptRecord | null {
    const row = this.db.prepare(`
      SELECT r.*, rev.revoked_at, rev.revoked_by_principal_id,
             rev.revocation_reason, COUNT(u.use_id) AS use_count
      FROM approval_receipts r
      LEFT JOIN approval_receipt_uses u ON u.approval_receipt_id = r.approval_receipt_id
      LEFT JOIN approval_receipt_revocations rev ON rev.approval_receipt_id = r.approval_receipt_id
      WHERE r.approval_receipt_id = ?
      GROUP BY r.approval_receipt_id
    `).get(id) as ApprovalReceiptRow | undefined;
    return row ? mapReceipt(row) : null;
  }

  getReceiptForRequest(requestId: string): ApprovalReceiptRecord | null {
    const row = this.db.prepare(`
      SELECT r.*, rev.revoked_at, rev.revoked_by_principal_id,
             rev.revocation_reason, COUNT(u.use_id) AS use_count
      FROM approval_receipts r
      LEFT JOIN approval_receipt_uses u ON u.approval_receipt_id = r.approval_receipt_id
      LEFT JOIN approval_receipt_revocations rev ON rev.approval_receipt_id = r.approval_receipt_id
      WHERE r.approval_request_id = ?
      GROUP BY r.approval_receipt_id
    `).get(requestId) as ApprovalReceiptRow | undefined;
    return row ? mapReceipt(row) : null;
  }

  requireReceipt(id: string): ApprovalReceiptRecord {
    const receipt = this.getReceipt(id);
    if (!receipt) throw new ApprovalNotFoundError("receipt", id);
    return receipt;
  }

  requireReceiptForWorkspace(id: string, workspaceId: string): ApprovalReceiptRecord {
    const receipt = this.requireReceipt(id);
    if (receipt.workspace_id !== workspaceId) throw new ApprovalNotFoundError("receipt", id);
    return receipt;
  }

  listUses(receiptId: string, workspaceId: string): ApprovalReceiptUseRecord[] {
    this.requireReceiptForWorkspace(receiptId, workspaceId);
    return (this.db.prepare(`
      SELECT * FROM approval_receipt_uses
      WHERE approval_receipt_id = ? AND workspace_id = ?
      ORDER BY used_at ASC, use_id ASC
    `).all(receiptId, workspaceId) as ApprovalReceiptUseRow[]).map(mapUse);
  }

  listDecisions(requestId: string): ApprovalIndividualDecisionRecord[] {
    return (this.db.prepare(`
      SELECT * FROM approval_individual_decisions
      WHERE approval_request_id = ? ORDER BY decided_at ASC, approval_decision_id ASC
    `).all(requestId) as ApprovalDecisionRow[]).map(mapIndividualDecision);
  }

  getDecision(decisionId: string): ApprovalIndividualDecisionRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM approval_individual_decisions WHERE approval_decision_id = ?
    `).get(decisionId) as ApprovalDecisionRow | undefined;
    return row ? mapIndividualDecision(row) : null;
  }

  private getUse(receiptId: string, useId: string): ApprovalReceiptUseRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM approval_receipt_uses
      WHERE approval_receipt_id = ? AND use_id = ?
    `).get(receiptId, useId) as ApprovalReceiptUseRow | undefined;
    return row ? mapUse(row) : null;
  }

  private decisionAuthorityIsCurrent(
    request: ApprovalRequestRecord,
    decision: ApprovalIndividualDecisionRecord,
  ): boolean {
    if (request.decision_policy.source.kind === "legacy_any_one") return true;
    const current = this.resolveDecisionAuthority({
      workspace_id: request.workspace_id,
      principal_id: decision.principal_id,
      approval_request_id: request.approval_request_id,
      context_id: request.context_id,
      decision_binding: request.decision_binding,
    });
    if (decision.authority_grant_ids.length === 0) return false;
    const currentGrantIds = new Set(current.authority_grant_ids);
    if (!decision.authority_grant_ids.every((grantId) => currentGrantIds.has(grantId))) return false;
    const currentRoleEvidence = new Set(current.role_evidence.map((item) => `${item.role}\0${item.authority_ref}`));
    return decision.role_evidence.every((item) => currentRoleEvidence.has(`${item.role}\0${item.authority_ref}`));
  }

  configureResponse(input: Readonly<{
    workspace_id: string;
    approval_request_id: string;
    expected_state_revision: number;
    response_participant_id: string | null;
  }>): ApprovalRequestRecord {
    const request = this.requireRequestForWorkspace(input.approval_request_id, input.workspace_id);
    if (request.status !== "pending" || request.state_revision !== input.expected_state_revision
      || request.expires_at <= this.now()) {
      throw new ApprovalConflictError(request.approval_request_id, "inspect the current pending request before changing its response recipient");
    }
    const recipient = input.response_participant_id === null
      ? null : requireText(input.response_participant_id, "response_participant_id");
    if (recipient === request.response_participant_id) return request;
    const changed = this.db.prepare(`UPDATE approval_requests
      SET response_participant_id = ?, state_revision = state_revision + 1
      WHERE approval_request_id = ? AND workspace_id = ? AND status = 'pending' AND state_revision = ?`
    ).run(recipient, request.approval_request_id, request.workspace_id, input.expected_state_revision);
    if (Number(changed.changes) !== 1) {
      throw new ApprovalConflictError(request.approval_request_id, "the request changed while its response recipient was being configured");
    }
    return this.requireRequest(request.approval_request_id);
  }

  private finishPendingRequest(input: Readonly<{
    workspace_id: string;
    approval_request_id: string;
    expected_state_revision: number;
    cancelled_by_principal_id: string;
    reason: string;
    status: "cancelled" | "invalidated";
  }>): ApprovalRequestRecord {
    const request = this.requireRequestForWorkspace(input.approval_request_id, input.workspace_id);
    if (request.status !== "pending" || request.state_revision !== input.expected_state_revision) {
      throw new ApprovalConflictError(request.approval_request_id, "the pending request changed after it was inspected");
    }
    const changed = this.db.prepare(`
      UPDATE approval_requests
      SET status = ?, state_revision = state_revision + 1,
          decided_by_principal_id = ?, decision_reason = ?, decided_at = ?
      WHERE approval_request_id = ? AND workspace_id = ?
        AND status = 'pending' AND state_revision = ?
    `).run(
      input.status,
      requireText(input.cancelled_by_principal_id, "principal_id"),
      requireText(input.reason, "reason", 16_384),
      this.now(), request.approval_request_id, request.workspace_id,
      input.expected_state_revision,
    );
    if (Number(changed.changes) !== 1) {
      throw new ApprovalConflictError(request.approval_request_id, "the request changed while it was being updated");
    }
    return this.requireRequest(request.approval_request_id);
  }
}

export function approvalActionDigest(action: ApprovalAction): string {
  return createHash("sha256")
    .update("floe-approval-action:v1\0", "utf8")
    .update(canonicalJson(normalizeApprovalAction(action)), "utf8")
    .digest("hex");
}

export function approvalReceiptStateRevision(receipt: ApprovalReceiptRecord): string {
  return createHash("sha256")
    .update("floe-approval-receipt-state:v1\0", "utf8")
    .update(canonicalJson({
      approval_receipt_id: receipt.approval_receipt_id,
      action_digest: receipt.action_digest,
      decision_set_digest: receipt.decision_set_digest,
      maximum_uses: receipt.maximum_uses,
      use_count: receipt.use_count,
      expires_at: receipt.expires_at,
      revoked_at: receipt.revoked_at,
      revoked_by_principal_id: receipt.revoked_by_principal_id,
    }), "utf8")
    .digest("hex");
}

function normalizeApprovalAction(action: ApprovalAction): ApprovalAction {
  const target = action.target ? normalizeResourceRef(action.target, "target") : null;
  const artefactVersionIds = uniqueSorted(action.artefact_version_ids, "artefact_version_id");
  const effectRefs = action.expected_effect.resource_refs
    .map((item, index) => normalizeResourceRef(item, `expected_effect.resource_refs[${index}]`))
    .sort(compareResourceRefs);
  return {
    operation_id: requireText(action.operation_id, "operation_id"),
    authorized_principal_id: requireText(action.authorized_principal_id, "authorized_principal_id"),
    target,
    input_digest: requireSha256(action.input_digest, "input_digest"),
    artefact_version_ids: artefactVersionIds,
    composition_revision_id: optionalText(action.composition_revision_id, "composition_revision_id"),
    node_placement_id: optionalText(action.node_placement_id, "node_placement_id"),
    scope_execution_id: optionalText(action.scope_execution_id, "scope_execution_id"),
    node_execution_id: optionalText(action.node_execution_id, "node_execution_id"),
    connector_binding_revision_id: optionalText(action.connector_binding_revision_id, "connector_binding_revision_id"),
    extension_package_version_id: optionalText(action.extension_package_version_id, "extension_package_version_id"),
    approval_policy_ref: action.approval_policy_ref
      ? normalizeResourceRef(action.approval_policy_ref, "approval_policy_ref")
      : null,
    capability_grant_ids: uniqueSorted(action.capability_grant_ids, "capability_grant_id"),
    expected_effect: {
      summary: requireText(action.expected_effect.summary, "expected_effect.summary", 16_384),
      external: Boolean(action.expected_effect.external),
      reversibility: requireReversibility(action.expected_effect.reversibility),
      resource_refs: effectRefs,
    },
  };
}

function normalizeApprovalDecisionBinding(
  binding: ApprovalDecisionBinding | null | undefined,
): ApprovalDecisionBinding | null {
  if (binding == null) return null;
  return {
    scope_execution_id: requireText(binding.scope_execution_id, "decision_binding.scope_execution_id"),
    composition_revision_id: requireText(binding.composition_revision_id, "decision_binding.composition_revision_id"),
    node_execution_id: requireText(binding.node_execution_id, "decision_binding.node_execution_id"),
    node_placement_id: requireText(binding.node_placement_id, "decision_binding.node_placement_id"),
    node_execution_state_revision: requirePositiveInteger(
      binding.node_execution_state_revision,
      "decision_binding.node_execution_state_revision",
    ),
    outcome_port_ids: {
      approved: requireText(binding.outcome_port_ids.approved, "decision_binding.outcome_port_ids.approved"),
      rejected: requireText(binding.outcome_port_ids.rejected, "decision_binding.outcome_port_ids.rejected"),
      changes_requested: requireText(
        binding.outcome_port_ids.changes_requested,
        "decision_binding.outcome_port_ids.changes_requested",
      ),
    },
  };
}

function legacyDecisionPolicy(): ApprovalDecisionPolicySnapshot {
  return {
    source: { kind: "legacy_any_one" },
    approvers: { mode: "any", principal_ids: [], roles: ["legacy:approval_decider"] },
  };
}

function normalizeApprovalDecisionPolicy(
  policy: ApprovalDecisionPolicySnapshot,
): ApprovalDecisionPolicySnapshot {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new ApprovalValidationError("decision_policy must be an object");
  }
  let source: ApprovalDecisionPolicySnapshot["source"];
  if (policy.source.kind === "policy_evaluation") {
    source = {
      kind: "policy_evaluation",
      policy_evaluation_id: requireText(policy.source.policy_evaluation_id, "decision_policy.source.policy_evaluation_id"),
      policy_revision_id: requireText(policy.source.policy_revision_id, "decision_policy.source.policy_revision_id"),
      rule_id: requireText(policy.source.rule_id, "decision_policy.source.rule_id"),
      facts_digest: requireSha256(policy.source.facts_digest, "decision_policy.source.facts_digest"),
    };
  } else if (policy.source.kind === "local_operator") {
    source = {
      kind: "local_operator",
      principal_id: requireText(policy.source.principal_id, "decision_policy.source.principal_id"),
    };
  } else if (policy.source.kind === "legacy_any_one") {
    source = { kind: "legacy_any_one" };
  } else {
    throw new ApprovalValidationError("decision_policy.source kind is invalid");
  }
  const value = policy.approvers;
  const principalIds = uniqueSorted(value.principal_ids, "decision_policy.approvers.principal_id");
  if (value.mode === "all_named") {
    if (principalIds.length === 0) {
      throw new ApprovalValidationError("an all_named decision policy requires at least one principal");
    }
    return { source, approvers: { mode: "all_named", principal_ids: principalIds } };
  }
  const roles = uniqueSorted(value.roles, "decision_policy.approvers.role");
  if (principalIds.length === 0 && roles.length === 0) {
    throw new ApprovalValidationError("an approval decision policy must name a principal or role");
  }
  if (value.mode === "any") {
    return { source, approvers: { mode: "any", principal_ids: principalIds, roles } };
  }
  if (value.mode === "quorum") {
    const quorum = requirePositiveInteger(value.quorum, "decision_policy.approvers.quorum");
    if (roles.length === 0 && quorum > principalIds.length) {
      throw new ApprovalValidationError("approval quorum exceeds the named eligible principals");
    }
    return { source, approvers: { mode: "quorum", principal_ids: principalIds, roles, quorum } };
  }
  throw new ApprovalValidationError("decision_policy.approvers mode is invalid");
}

function eligibleDecisionAuthority(
  policy: ApprovalDecisionPolicySnapshot,
  principalId: string,
  authority: Readonly<{
    authority_grant_ids: readonly string[];
    role_evidence: readonly ApprovalRoleEvidence[];
  }>,
): Readonly<{ eligible: boolean; role_evidence: readonly ApprovalRoleEvidence[] }> {
  const selector = policy.approvers;
  const named = selector.principal_ids.includes(principalId);
  const permittedRoles = selector.mode === "all_named" ? [] : selector.roles;
  const roleEvidence = authority.role_evidence
    .filter((item) => permittedRoles.includes(item.role))
    .map((item) => ({
      role: requireText(item.role, "role_evidence.role"),
      authority_ref: requireText(item.authority_ref, "role_evidence.authority_ref"),
    }))
    .sort((left, right) => `${left.role}\0${left.authority_ref}`.localeCompare(`${right.role}\0${right.authority_ref}`));
  const legacy = policy.source.kind === "legacy_any_one";
  return {
    eligible: (legacy || authority.authority_grant_ids.length > 0) && (named || roleEvidence.length > 0 || legacy),
    role_evidence: roleEvidence,
  };
}

function activeApprovalDecisions(
  decisions: readonly ApprovalIndividualDecisionRecord[],
): ApprovalIndividualDecisionRecord[] {
  const superseded = new Set(decisions
    .map((item) => item.supersedes_decision_id)
    .filter((item): item is string => Boolean(item)));
  return decisions.filter((item) => !superseded.has(item.approval_decision_id));
}

function resolveApprovalDecisionPolicy(
  policy: ApprovalDecisionPolicySnapshot,
  active: readonly ApprovalIndividualDecisionRecord[],
): ApprovalDecision | null {
  // Negative outcomes are fail-fast. Since decisions are appended serially,
  // the first retained active negative decision deterministically resolves.
  const negative = active.find((item) => item.decision !== "approved");
  if (negative) return negative.decision;
  const approvals = new Set(active
    .filter((item) => item.decision === "approved")
    .map((item) => item.principal_id));
  const selector = policy.approvers;
  if (selector.mode === "any") return approvals.size >= 1 ? "approved" : null;
  if (selector.mode === "quorum") return approvals.size >= selector.quorum ? "approved" : null;
  return selector.principal_ids.every((principalId) => approvals.has(principalId)) ? "approved" : null;
}

function approvalProgress(
  policy: ApprovalDecisionPolicySnapshot,
  decisions: readonly ApprovalIndividualDecisionRecord[],
  resolution: ApprovalDecision | null,
): ApprovalProgress {
  const active = activeApprovalDecisions(decisions);
  const approvedPrincipals = new Set(active
    .filter((item) => item.decision === "approved")
    .map((item) => item.principal_id));
  const selector = policy.approvers;
  const required = selector.mode === "quorum"
    ? selector.quorum
    : selector.mode === "all_named"
      ? selector.principal_ids.length
      : 1;
  return {
    approvals_received: approvedPrincipals.size,
    approvals_required: required,
    active_decision_count: active.length,
    remaining_named_principal_ids: selector.principal_ids.filter((id) => !approvedPrincipals.has(id)),
    resolution,
  };
}

export function approvalDecisionSetDigest(
  decisions: readonly ApprovalIndividualDecisionRecord[],
): string {
  return digest("floe-approval-decision-set:v1", decisions.map((item) => ({
    approval_decision_id: item.approval_decision_id,
    approval_request_id: item.approval_request_id,
    workspace_id: item.workspace_id,
    principal_id: item.principal_id,
    decision: item.decision,
    reason: item.reason,
    decision_event_id: item.decision_event_id,
    authority_grant_ids: [...item.authority_grant_ids].sort(),
    role_evidence: [...item.role_evidence]
      .sort((left, right) => `${left.role}\0${left.authority_ref}`.localeCompare(`${right.role}\0${right.authority_ref}`)),
    supersedes_decision_id: item.supersedes_decision_id,
    idempotency_key: item.idempotency_key,
    decided_at: item.decided_at,
  })));
}

function mapRequest(
  row: ApprovalRequestRow,
  decisions: readonly ApprovalIndividualDecisionRecord[] = [],
): ApprovalRequestRecord {
  const decisionPolicy = parseDecisionPolicy(row.decision_policy_json);
  return {
    approval_request_id: row.approval_request_id,
    workspace_id: row.workspace_id,
    action: parseAction(row.action_json),
    action_digest: row.action_digest,
    context_id: row.context_id,
    decision_binding: parseDecisionBinding(row.decision_binding_json),
    response_participant_id: row.response_participant_id ?? null,
    decision_policy: decisionPolicy,
    decision_policy_digest: row.decision_policy_digest,
    decision_set_digest: row.decision_set_digest,
    decisions,
    progress: approvalProgress(decisionPolicy, decisions, row.decision_outcome),
    requested_by_principal_id: row.requested_by_principal_id,
    reason: row.reason,
    requested_at: row.requested_at,
    expires_at: row.expires_at,
    maximum_uses: Number(row.maximum_uses),
    idempotency_key: row.idempotency_key,
    status: row.status,
    decision: row.decision_outcome,
    state_revision: Number(row.state_revision),
    decided_by_principal_id: row.decided_by_principal_id,
    decision_event_id: row.decision_event_id,
    decision_reason: row.decision_reason,
    decided_at: row.decided_at,
  };
}

function mapReceipt(row: ApprovalReceiptRow): ApprovalReceiptRecord {
  return {
    approval_receipt_id: row.approval_receipt_id,
    approval_request_id: row.approval_request_id,
    workspace_id: row.workspace_id,
    action: parseAction(row.action_json),
    action_digest: row.action_digest,
    decision_set_digest: row.decision_set_digest,
    context_id: row.context_id,
    requested_by_principal_id: row.requested_by_principal_id,
    approved_by_principal_id: row.approved_by_principal_id,
    decision_event_id: row.decision_event_id,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    maximum_uses: Number(row.maximum_uses),
    use_count: Number(row.use_count),
    revoked_at: row.revoked_at,
    revoked_by_principal_id: row.revoked_by_principal_id,
    revocation_reason: row.revocation_reason,
  };
}

function mapUse(row: ApprovalReceiptUseRow): ApprovalReceiptUseRecord {
  return {
    approval_receipt_id: row.approval_receipt_id,
    use_id: row.use_id,
    workspace_id: row.workspace_id,
    principal_id: row.principal_id,
    operation_id: row.operation_id,
    action_digest: row.action_digest,
    used_at: row.used_at,
  };
}

function mapIndividualDecision(row: ApprovalDecisionRow): ApprovalIndividualDecisionRecord {
  return {
    approval_decision_id: row.approval_decision_id,
    approval_request_id: row.approval_request_id,
    workspace_id: row.workspace_id,
    principal_id: row.principal_id,
    decision: row.decision,
    reason: row.reason,
    decision_event_id: row.decision_event_id,
    authority_grant_ids: parseTextArray(row.authority_grant_ids_json, "authority_grant_ids_json"),
    role_evidence: JSON.parse(row.role_evidence_json) as ApprovalRoleEvidence[],
    supersedes_decision_id: row.supersedes_decision_id,
    idempotency_key: row.idempotency_key,
    decided_at: row.decided_at,
    decision_set_digest: row.decision_set_digest,
    resolution_after: row.resolution_after,
  };
}

function parseAction(value: string): ApprovalAction {
  try {
    return normalizeApprovalAction(JSON.parse(value) as ApprovalAction);
  } catch (error) {
    throw new ApprovalValidationError(`stored action is invalid: ${(error as Error).message}`);
  }
}

function parseDecisionBinding(value: string): ApprovalDecisionBinding | null {
  try {
    return normalizeApprovalDecisionBinding(JSON.parse(value) as ApprovalDecisionBinding | null);
  } catch (error) {
    throw new ApprovalValidationError(`stored decision binding is invalid: ${(error as Error).message}`);
  }
}

function parseDecisionPolicy(value: string): ApprovalDecisionPolicySnapshot {
  try {
    return normalizeApprovalDecisionPolicy(JSON.parse(value) as ApprovalDecisionPolicySnapshot);
  } catch (error) {
    if (error instanceof ApprovalValidationError) throw error;
    throw new ApprovalValidationError("stored decision policy is not valid JSON");
  }
}

function normalizeResourceRef(value: OperationResourceRef, label: string): OperationResourceRef {
  return {
    kind: requireText(value.kind, `${label}.kind`),
    id: requireText(value.id, `${label}.id`),
    ...(value.revision === undefined ? {} : { revision: optionalText(value.revision, `${label}.revision`) }),
  };
}

function compareResourceRefs(left: OperationResourceRef, right: OperationResourceRef): number {
  return `${left.kind}\0${left.id}\0${left.revision ?? ""}`.localeCompare(
    `${right.kind}\0${right.id}\0${right.revision ?? ""}`,
  );
}

function uniqueSorted(values: readonly string[], label: string): string[] {
  return [...new Set(values.map((value) => requireText(value, label)))].sort();
}

function requireText(value: string, label: string, maximum = 1024): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new ApprovalValidationError(`${label} must be non-empty text no longer than ${maximum} characters`);
  }
  return value;
}

function optionalText(value: string | null | undefined, label: string): string | null {
  return value == null ? null : requireText(value, label);
}

function requireSha256(value: string, label: string): string {
  const normalized = requireText(value, label, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new ApprovalValidationError(`${label} must be a SHA-256 digest`);
  return normalized;
}

function requireTimestamp(value: string, label: string): string {
  const normalized = requireText(value, label);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) {
    throw new ApprovalValidationError(`${label} must be a canonical UTC ISO timestamp`);
  }
  return normalized;
}

function requireFutureTimestamp(value: string, after: string, label: string): string {
  const normalized = requireTimestamp(value, label);
  if (Date.parse(normalized) <= Date.parse(after)) throw new ApprovalValidationError(`${label} must be in the future`);
  return normalized;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new ApprovalValidationError(`${label} must be a positive integer`);
  return value;
}

function requireReversibility(value: ApprovalExpectedEffect["reversibility"]): ApprovalExpectedEffect["reversibility"] {
  if (!(["none", "reversible", "irreversible"] as const).includes(value)) {
    throw new ApprovalValidationError("expected_effect.reversibility is invalid");
  }
  return value;
}

function approvalDenialMessage(code: ApprovalDenialCode): string {
  switch (code) {
    case "approval_receipt_not_found": return "The required ApprovalReceipt does not exist.";
    case "approval_workspace_mismatch": return "The ApprovalReceipt belongs to another Workspace.";
    case "approval_principal_mismatch": return "The ApprovalReceipt does not authorise this principal.";
    case "approval_operation_mismatch": return "The ApprovalReceipt does not authorise this operation.";
    case "approval_action_changed": return "The approved action or exact evidence has changed.";
    case "approval_approver_ineligible": return "This principal is not eligible to decide this ApprovalRequest.";
    case "approval_approver_authority_changed": return "Authority used by an approver is no longer current.";
    case "approval_not_yet_active": return "The ApprovalReceipt is not active yet.";
    case "approval_expired": return "The ApprovalReceipt has expired.";
    case "approval_revoked": return "The ApprovalReceipt has been revoked.";
    case "approval_uses_exhausted": return "The ApprovalReceipt has no permitted uses remaining.";
  }
}

function parseTextArray(value: string, label: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || item.length === 0)) {
      throw new Error("invalid");
    }
    return [...parsed];
  } catch {
    throw new ApprovalValidationError(`stored ${label} is invalid`);
  }
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`${domain}\0`, "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ApprovalValidationError("approval data must contain finite JSON values");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new ApprovalValidationError("approval data must contain JSON values only");
}

function inSavepoint<T>(db: DatabaseSync, label: string, action: () => T): T {
  const savepoint = label.replace(/[^a-z0-9_]/gi, "_");
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = action();
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}
