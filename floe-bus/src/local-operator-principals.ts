import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type LocalOperatorPrincipalRecord = Readonly<{
  principal_id: string;
  purpose: "local_interactive_operator";
  created_at: string;
}>;

export type LocalOperatorPrincipalStoreDependencies = Readonly<{
  now?: () => string;
  principal_id_factory?: () => string;
}>;

/**
 * The local desktop's operator principal is user identity, not host identity.
 * It is stored once and survives host credential rotation and Bus restarts.
 */
export function applyLocalOperatorPrincipalSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_operator_principals (
      purpose TEXT PRIMARY KEY CHECK (purpose = 'local_interactive_operator'),
      principal_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
  `);
}

export class SqliteLocalOperatorPrincipalStore {
  private readonly now: () => string;
  private readonly principalIdFactory: () => string;

  constructor(
    readonly db: DatabaseSync,
    dependencies: LocalOperatorPrincipalStoreDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.principalIdFactory = dependencies.principal_id_factory
      ?? (() => `principal_local_operator_${randomUUID()}`);
    applyLocalOperatorPrincipalSchema(db);
  }

  getCurrent(): LocalOperatorPrincipalRecord | null {
    const row = this.db.prepare(`
      SELECT principal_id, purpose, created_at
      FROM local_operator_principals
      WHERE purpose = 'local_interactive_operator'
    `).get() as LocalOperatorPrincipalRecord | undefined;
    return row ?? null;
  }

  getOrCreate(): LocalOperatorPrincipalRecord {
    const current = this.getCurrent();
    if (current) return current;
    const principalId = requireIdentifier(this.principalIdFactory(), "principal_id");
    const createdAt = requireTimestamp(this.now(), "created_at");
    this.db.prepare(`
      INSERT OR IGNORE INTO local_operator_principals (purpose, principal_id, created_at)
      VALUES ('local_interactive_operator', ?, ?)
    `).run(principalId, createdAt);
    const created = this.getCurrent();
    if (!created) throw new Error("The local operator principal could not be created.");
    return created;
  }
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > 512
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Local operator ${label} must be non-empty text without control characters.`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  const text = requireIdentifier(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`Local operator ${label} must be an ISO timestamp.`);
  return text;
}
