import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  ApprovalDeniedError,
  ApprovalStore,
  approvalActionDigest,
  type ApprovalAction,
} from "./approvals.js";
import type {
  ExtensionIsolationHostClaim,
  ExtensionPackageVersion,
  ExtensionPermissionApprovalClaim,
  ExtensionResourceRef,
} from "./extensions.js";

export type ExtensionActivationOperationId =
  | "extension.install"
  | "extension.enable"
  | "extension.upgrade"
  | "extension.rollback";

export type ExtensionActivationAttemptState = "reserved" | "running" | "completed" | "failed";

export type ExtensionActivationAttemptRecord = Readonly<{
  extension_activation_attempt_id: string;
  invocation_id: string;
  workspace_id: string;
  extension_installation_id: string;
  extension_package_version_id: string;
  operation_id: ExtensionActivationOperationId;
  authorized_principal_id: string;
  requested_lifecycle: "installed" | "enabled";
  installation_locator: string;
  permission_digest: string;
  approval_receipt_ref: string;
  approval_action_digest: string;
  capability_grant_ids: readonly string[];
  state: ExtensionActivationAttemptState;
  host_claim: ExtensionIsolationHostClaim | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
}>;

type AttemptRow = Readonly<{
  extension_activation_attempt_id: string;
  invocation_id: string;
  workspace_id: string;
  extension_installation_id: string;
  extension_package_version_id: string;
  operation_id: ExtensionActivationOperationId;
  authorized_principal_id: string;
  requested_lifecycle: "installed" | "enabled";
  installation_locator: string;
  permission_digest: string;
  approval_receipt_ref: string;
  approval_action_digest: string;
  capability_grant_ids_json: string;
  state: ExtensionActivationAttemptState;
  host_claim_json: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
}>;

export type ExtensionActivationReservationInput = Readonly<{
  invocation_id: string;
  workspace_id: string;
  extension_installation_id: string;
  package_version: ExtensionPackageVersion;
  operation_id: ExtensionActivationOperationId;
  authorized_principal_id: string;
  requested_lifecycle: "installed" | "enabled";
  installation_locator: string;
  approval_receipt_refs: readonly string[];
  approval_policy_ref: ExtensionResourceRef | null;
  capability_grant_ids: readonly string[];
}>;

export type ExtensionActivationReservation = Readonly<{
  attempt: ExtensionActivationAttemptRecord;
  approval: ExtensionPermissionApprovalClaim;
  replay: boolean;
}>;

export interface ExtensionActivationAuthority {
  reserve(input: ExtensionActivationReservationInput): ExtensionActivationReservation;
  markRunning(attemptId: string): ExtensionActivationAttemptRecord;
  complete(attemptId: string, hostClaim: ExtensionIsolationHostClaim): ExtensionActivationAttemptRecord;
  fail(attemptId: string, code: string, message: string): ExtensionActivationAttemptRecord;
}

export class ExtensionActivationAttemptConflictError extends Error {
  readonly code = "E_EXTENSION_ACTIVATION_ATTEMPT_CONFLICT" as const;
  constructor(readonly invocation_id: string) {
    super(`Extension activation invocation '${invocation_id}' was already bound to a different exact action.`);
    this.name = "ExtensionActivationAttemptConflictError";
  }
}

export class ExtensionActivationAttemptStateError extends Error {
  readonly code = "E_EXTENSION_ACTIVATION_ATTEMPT_STATE" as const;
  constructor(readonly attempt_id: string, readonly state: ExtensionActivationAttemptState) {
    super(`Extension activation attempt '${attempt_id}' cannot continue from '${state}'.`);
    this.name = "ExtensionActivationAttemptStateError";
  }
}

export function applyExtensionActivationAttemptSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS extension_activation_attempts (
      extension_activation_attempt_id TEXT PRIMARY KEY,
      invocation_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      extension_installation_id TEXT NOT NULL,
      extension_package_version_id TEXT NOT NULL REFERENCES extension_package_versions(extension_package_version_id),
      operation_id TEXT NOT NULL CHECK (operation_id IN ('extension.install', 'extension.enable', 'extension.upgrade', 'extension.rollback')),
      authorized_principal_id TEXT NOT NULL,
      requested_lifecycle TEXT NOT NULL CHECK (requested_lifecycle IN ('installed', 'enabled')),
      installation_locator TEXT NOT NULL,
      permission_digest TEXT NOT NULL,
      approval_receipt_ref TEXT NOT NULL REFERENCES approval_receipts(approval_receipt_id),
      approval_action_digest TEXT NOT NULL,
      capability_grant_ids_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'running', 'completed', 'failed')),
      host_claim_json TEXT,
      failure_code TEXT,
      failure_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_extension_activation_attempts_installation
      ON extension_activation_attempts(extension_installation_id, created_at, extension_activation_attempt_id);
  `);
}

/**
 * Joins one exact ApprovalReceipt use to one durable Extension activation
 * attempt before package code can run. The shared SQLite transaction prevents
 * spending authority without recording what it authorised.
 */
export class CanonicalExtensionActivationAuthority implements ExtensionActivationAuthority {
  constructor(
    private readonly db: DatabaseSync,
    private readonly approvals: ApprovalStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    applyExtensionActivationAttemptSchema(db);
  }

  reserve(input: ExtensionActivationReservationInput): ExtensionActivationReservation {
    const action = extensionActivationApprovalAction(input);
    const actionDigest = approvalActionDigest(action);
    const existing = this.getByInvocation(input.invocation_id);
    if (existing) {
      if (!matchesReservation(existing, input, actionDigest)) {
        throw new ExtensionActivationAttemptConflictError(input.invocation_id);
      }
      return {
        attempt: existing,
        approval: approvalClaim(existing, input.package_version.extension_id),
        replay: true,
      };
    }

    const receiptRefs = [...new Set(input.approval_receipt_refs)].sort();
    if (receiptRefs.length === 0) throw new ApprovalDeniedError("approval_receipt_not_found");
    return inSavepoint(this.db, "reserve_extension_activation", () => {
      let selected: string | null = null;
      let lastDenial: unknown = null;
      for (const approvalReceiptId of receiptRefs) {
        try {
          this.approvals.verifyReceipt({
            approval_receipt_id: approvalReceiptId,
            workspace_id: input.workspace_id,
            principal_id: input.authorized_principal_id,
            action,
          });
          selected = approvalReceiptId;
          break;
        } catch (error) {
          lastDenial = error;
        }
      }
      if (!selected) throw lastDenial ?? new ApprovalDeniedError("approval_receipt_not_found");

      this.approvals.consumeReceipt({
        approval_receipt_id: selected,
        use_id: input.invocation_id,
        workspace_id: input.workspace_id,
        principal_id: input.authorized_principal_id,
        action,
      });
      const at = this.now();
      const attemptId = `extactivation_${hash(input.invocation_id).slice(0, 32)}`;
      this.db.prepare(`
        INSERT INTO extension_activation_attempts (
          extension_activation_attempt_id, invocation_id, workspace_id,
          extension_installation_id, extension_package_version_id, operation_id,
          authorized_principal_id, requested_lifecycle, installation_locator,
          permission_digest, approval_receipt_ref, approval_action_digest,
          capability_grant_ids_json, state, host_claim_json,
          failure_code, failure_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', NULL, NULL, NULL, ?, ?)
      `).run(
        attemptId,
        input.invocation_id,
        input.workspace_id,
        input.extension_installation_id,
        input.package_version.extension_package_version_id,
        input.operation_id,
        input.authorized_principal_id,
        input.requested_lifecycle,
        input.installation_locator,
        input.package_version.permission_digest,
        selected,
        actionDigest,
        JSON.stringify([...new Set(input.capability_grant_ids)].sort()),
        at,
        at,
      );
      const attempt = this.requireByInvocation(input.invocation_id);
      return {
        attempt,
        approval: approvalClaim(attempt, input.package_version.extension_id),
        replay: false,
      };
    });
  }

  markRunning(attemptId: string): ExtensionActivationAttemptRecord {
    const current = this.require(attemptId);
    if (current.state !== "reserved") throw new ExtensionActivationAttemptStateError(attemptId, current.state);
    this.db.prepare(`
      UPDATE extension_activation_attempts SET state = 'running', updated_at = ?
      WHERE extension_activation_attempt_id = ? AND state = 'reserved'
    `).run(this.now(), attemptId);
    return this.require(attemptId);
  }

  complete(attemptId: string, hostClaim: ExtensionIsolationHostClaim): ExtensionActivationAttemptRecord {
    const current = this.require(attemptId);
    if (current.state === "completed") {
      if (JSON.stringify(current.host_claim) !== JSON.stringify(hostClaim)) {
        throw new ExtensionActivationAttemptStateError(attemptId, current.state);
      }
      return current;
    }
    if (current.state !== "running") throw new ExtensionActivationAttemptStateError(attemptId, current.state);
    this.db.prepare(`
      UPDATE extension_activation_attempts
      SET state = 'completed', host_claim_json = ?, failure_code = NULL,
          failure_message = NULL, updated_at = ?
      WHERE extension_activation_attempt_id = ? AND state = 'running'
    `).run(JSON.stringify(hostClaim), this.now(), attemptId);
    return this.require(attemptId);
  }

  fail(attemptId: string, code: string, message: string): ExtensionActivationAttemptRecord {
    const current = this.require(attemptId);
    if (current.state === "completed") throw new ExtensionActivationAttemptStateError(attemptId, current.state);
    if (current.state === "failed") return current;
    this.db.prepare(`
      UPDATE extension_activation_attempts
      SET state = 'failed', failure_code = ?, failure_message = ?, updated_at = ?
      WHERE extension_activation_attempt_id = ? AND state IN ('reserved', 'running')
    `).run(code, message, this.now(), attemptId);
    return this.require(attemptId);
  }

  getByInvocation(invocationId: string): ExtensionActivationAttemptRecord | null {
    const row = this.db.prepare(`SELECT * FROM extension_activation_attempts WHERE invocation_id = ?`)
      .get(invocationId) as AttemptRow | undefined;
    return row ? mapAttempt(row) : null;
  }

  require(attemptId: string): ExtensionActivationAttemptRecord {
    const row = this.db.prepare(`SELECT * FROM extension_activation_attempts WHERE extension_activation_attempt_id = ?`)
      .get(attemptId) as AttemptRow | undefined;
    if (!row) throw new Error(`Extension activation attempt not found: ${attemptId}`);
    return mapAttempt(row);
  }

  private requireByInvocation(invocationId: string): ExtensionActivationAttemptRecord {
    const attempt = this.getByInvocation(invocationId);
    if (!attempt) throw new Error(`Extension activation attempt not found for invocation: ${invocationId}`);
    return attempt;
  }
}

export function extensionActivationApprovalAction(input: ExtensionActivationReservationInput): ApprovalAction {
  const capabilityGrantIds = [...new Set(input.capability_grant_ids)].sort();
  return {
    operation_id: input.operation_id,
    authorized_principal_id: input.authorized_principal_id,
    target: {
      kind: "extension_package_version",
      id: input.package_version.extension_package_version_id,
      revision: input.package_version.record_digest,
    },
    input_digest: hash(canonicalJson({
      extension_installation_id: input.extension_installation_id,
      installation_locator: input.installation_locator,
      permission_digest: input.package_version.permission_digest,
      requested_lifecycle: input.requested_lifecycle,
    })),
    artefact_version_ids: [],
    composition_revision_id: null,
    node_placement_id: null,
    scope_execution_id: null,
    node_execution_id: null,
    connector_binding_revision_id: null,
    extension_package_version_id: input.package_version.extension_package_version_id,
    approval_policy_ref: input.approval_policy_ref,
    capability_grant_ids: capabilityGrantIds,
    expected_effect: {
      summary: input.requested_lifecycle === "enabled"
        ? `Activate Extension package ${input.package_version.extension_package_version_id} in its isolated host.`
        : `Install Extension package ${input.package_version.extension_package_version_id} without activating code.`,
      external: input.requested_lifecycle === "enabled",
      reversibility: "reversible",
      resource_refs: [
        { kind: "extension_package_version", id: input.package_version.extension_package_version_id, revision: input.package_version.record_digest },
        { kind: "extension_installation", id: input.extension_installation_id, revision: null },
      ],
    },
  };
}

function matchesReservation(
  attempt: ExtensionActivationAttemptRecord,
  input: ExtensionActivationReservationInput,
  actionDigest: string,
): boolean {
  return attempt.workspace_id === input.workspace_id
    && attempt.extension_installation_id === input.extension_installation_id
    && attempt.extension_package_version_id === input.package_version.extension_package_version_id
    && attempt.operation_id === input.operation_id
    && attempt.authorized_principal_id === input.authorized_principal_id
    && attempt.requested_lifecycle === input.requested_lifecycle
    && attempt.installation_locator === input.installation_locator
    && attempt.permission_digest === input.package_version.permission_digest
    && attempt.approval_action_digest === actionDigest
    && JSON.stringify(attempt.capability_grant_ids) === JSON.stringify([...new Set(input.capability_grant_ids)].sort());
}

function approvalClaim(attempt: ExtensionActivationAttemptRecord, extensionId: string): ExtensionPermissionApprovalClaim {
  return {
    receipt_ref: attempt.approval_receipt_ref,
    workspace_id: attempt.workspace_id,
    extension_id: extensionId,
    permission_digest: attempt.permission_digest,
    decision: "approved",
  };
}

function mapAttempt(row: AttemptRow): ExtensionActivationAttemptRecord {
  return {
    extension_activation_attempt_id: row.extension_activation_attempt_id,
    invocation_id: row.invocation_id,
    workspace_id: row.workspace_id,
    extension_installation_id: row.extension_installation_id,
    extension_package_version_id: row.extension_package_version_id,
    operation_id: row.operation_id,
    authorized_principal_id: row.authorized_principal_id,
    requested_lifecycle: row.requested_lifecycle,
    installation_locator: row.installation_locator,
    permission_digest: row.permission_digest,
    approval_receipt_ref: row.approval_receipt_ref,
    approval_action_digest: row.approval_action_digest,
    capability_grant_ids: JSON.parse(row.capability_grant_ids_json) as string[],
    state: row.state,
    host_claim: row.host_claim_json ? JSON.parse(row.host_claim_json) as ExtensionIsolationHostClaim : null,
    failure_code: row.failure_code,
    failure_message: row.failure_message,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function inSavepoint<T>(db: DatabaseSync, label: string, action: () => T): T {
  db.exec(`SAVEPOINT ${label}`);
  try {
    const result = action();
    db.exec(`RELEASE SAVEPOINT ${label}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${label}`);
    db.exec(`RELEASE SAVEPOINT ${label}`);
    throw error;
  }
}
