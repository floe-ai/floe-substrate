import type { DatabaseSync } from "node:sqlite";

import type {
  OperationInvocationLedger,
  OperationInvocationReceipt,
} from "./operations.js";

type PersistedOperationInvocation = Readonly<{
  request_digest: string;
  receipt: OperationInvocationReceipt;
}>;

type OperationInvocationRow = Readonly<{
  request_digest: string;
  receipt_json: string;
}>;

/**
 * Installs the durable receipt ledger owned by the Bus.
 *
 * The ledger intentionally stores the validated operation receipt, not the
 * invocation input. Credential values must remain behind their broker rather
 * than becoming replay data in this table.
 */
export function applyOperationInvocationLedgerSchema(db: DatabaseSync): void {
  const existingColumns = db.prepare("PRAGMA table_info(operation_invocation_ledger)")
    .all() as Array<{ name: string }>;
  const names = new Set(existingColumns.map((column) => column.name));
  const existingSql = (db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operation_invocation_ledger'
  `).get() as { sql: string } | undefined)?.sql ?? "";
  const migrate = existingColumns.length > 0
    && (
      !names.has("boundary_kind")
      || names.has("workspace_id")
      || !existingSql.includes("'awaiting_approval'")
      || !existingSql.includes("'outcome_unknown'")
    );
  if (migrate) {
    db.exec(`
      ALTER TABLE operation_invocation_ledger RENAME TO operation_invocation_ledger_previous;
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS operation_invocation_ledger (
      ledger_key TEXT PRIMARY KEY,
      request_digest TEXT NOT NULL,
      receipt_id TEXT NOT NULL UNIQUE,
      invocation_id TEXT NOT NULL UNIQUE,
      boundary_kind TEXT NOT NULL CHECK (boundary_kind IN ('workspace', 'host')),
      boundary_id TEXT NOT NULL CHECK (length(trim(boundary_id)) > 0),
      principal_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      operation_version TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('running', 'awaiting_approval', 'accepted', 'completed', 'refused', 'outcome_unknown')),
      receipt_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
  `);
  if (migrate) {
    db.exec(`
      INSERT INTO operation_invocation_ledger (
        ledger_key, request_digest, receipt_id, invocation_id,
        boundary_kind, boundary_id, principal_id,
        operation_id, operation_version, idempotency_key, state,
        receipt_json, started_at, updated_at, completed_at
      )
      SELECT ledger_key, request_digest, receipt_id, invocation_id,
             ${names.has("boundary_kind") ? "boundary_kind, boundary_id" : "'workspace', workspace_id"}, principal_id,
             operation_id, operation_version, idempotency_key, state,
             receipt_json, started_at, updated_at, completed_at
      FROM operation_invocation_ledger_previous;
      DROP TABLE operation_invocation_ledger_previous;
    `);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_operation_invocation_boundary_updated
      ON operation_invocation_ledger(boundary_kind, boundary_id, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_operation_invocation_principal
      ON operation_invocation_ledger(boundary_kind, boundary_id, principal_id, updated_at DESC);
  `);
}

/**
 * SQLite implementation of the atomic reservation boundary used by
 * SemanticOperationRegistry. The primary key makes the first begin win even
 * when independent Bus connections receive the same invocation concurrently.
 */
export class SqliteOperationInvocationLedger implements OperationInvocationLedger {
  constructor(readonly db: DatabaseSync) {}

  begin(
    key: string,
    requestDigest: string,
    receipt: OperationInvocationReceipt,
  ): PersistedOperationInvocation | null {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO operation_invocation_ledger (
        ledger_key, request_digest, receipt_id, invocation_id,
        boundary_kind, boundary_id,
        principal_id, operation_id, operation_version, idempotency_key, state,
        receipt_json, started_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      key,
      requestDigest,
      receipt.receipt_id,
      receipt.invocation_id,
      receipt.authority_boundary.kind,
      receipt.authority_boundary.kind === "workspace"
        ? receipt.authority_boundary.workspace_id
        : receipt.authority_boundary.host_id,
      receipt.principal_id,
      receipt.operation_id,
      receipt.operation_version,
      receipt.idempotency_key,
      receipt.state,
      JSON.stringify(receipt),
      receipt.started_at,
      receipt.updated_at,
      receipt.completed_at,
    );

    if (Number(result.changes) === 1) return null;

    const existing = this.getByLedgerKey(key);
    if (!existing) {
      throw new Error("The operation invocation could not be reserved or recovered.");
    }
    return existing;
  }

  update(key: string, receipt: OperationInvocationReceipt): void {
    const result = this.db.prepare(`
      UPDATE operation_invocation_ledger
      SET state = ?, receipt_json = ?, updated_at = ?, completed_at = ?
      WHERE ledger_key = ? AND invocation_id = ?
    `).run(
      receipt.state,
      JSON.stringify(receipt),
      receipt.updated_at,
      receipt.completed_at,
      key,
      receipt.invocation_id,
    );

    if (Number(result.changes) !== 1) {
      throw new Error(`Operation invocation '${key}' was not reserved by '${receipt.invocation_id}'.`);
    }
  }

  getByReceiptId(receiptId: string): OperationInvocationReceipt | null {
    const row = this.db.prepare(`
      SELECT receipt_json
      FROM operation_invocation_ledger
      WHERE receipt_id = ?
    `).get(receiptId) as Pick<OperationInvocationRow, "receipt_json"> | undefined;
    return row ? parseReceipt(row.receipt_json) : null;
  }

  getByInvocationId(invocationId: string): OperationInvocationReceipt | null {
    const row = this.db.prepare(`
      SELECT receipt_json
      FROM operation_invocation_ledger
      WHERE invocation_id = ?
    `).get(invocationId) as Pick<OperationInvocationRow, "receipt_json"> | undefined;
    return row ? parseReceipt(row.receipt_json) : null;
  }

  private getByLedgerKey(key: string): PersistedOperationInvocation | null {
    const row = this.db.prepare(`
      SELECT request_digest, receipt_json
      FROM operation_invocation_ledger
      WHERE ledger_key = ?
    `).get(key) as OperationInvocationRow | undefined;
    return row
      ? { request_digest: row.request_digest, receipt: parseReceipt(row.receipt_json) }
      : null;
  }
}

function parseReceipt(value: string): OperationInvocationReceipt {
  const parsed = JSON.parse(value) as Partial<OperationInvocationReceipt> & { workspace_id?: unknown };
  const { workspace_id: previousWorkspaceId, ...canonical } = parsed;
  const governance = canonical.governance ?? {
    policy_evaluation_id: null,
    approval_request_ids: [],
    approval_receipt_ids: [],
    budget_reservation_id: null,
  };
  const executionOwnerId = canonical.execution_owner_id ?? null;
  if (!canonical.authority_boundary && typeof previousWorkspaceId === "string") {
    return {
      ...canonical,
      authority_boundary: { kind: "workspace", workspace_id: previousWorkspaceId },
      governance,
      execution_owner_id: executionOwnerId,
    } as OperationInvocationReceipt;
  }
  return {
    ...canonical,
    governance,
    execution_owner_id: executionOwnerId,
  } as OperationInvocationReceipt;
}
