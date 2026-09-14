import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const RESERVED_DEFAULT_SCOPE_ID = "default";

export type ScopeRecord = {
  scope_id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  status: "active" | "retired";
  published_revision_id: string | null;
  created_at: string;
  updated_at: string;
};

export class ScopeAlreadyExistsError extends Error {
  constructor(readonly workspace_id: string, readonly scope_id: string) {
    super(`Scope '${scope_id}' already exists in workspace '${workspace_id}'.`);
    this.name = "ScopeAlreadyExistsError";
  }
}

export class ScopeNotFoundError extends Error {
  constructor(readonly workspace_id: string, readonly scope_id: string) {
    super(`Scope '${scope_id}' was not found in workspace '${workspace_id}'.`);
    this.name = "ScopeNotFoundError";
  }
}

export class ScopeReservedIdError extends Error {
  constructor(readonly workspace_id: string, readonly scope_id: string) {
    super(`Scope id '${scope_id}' is reserved.`);
    this.name = "ScopeReservedIdError";
  }
}

export class ScopeNotEmptyError extends Error {
  constructor(
    readonly workspace_id: string,
    readonly scope_id: string,
    readonly context_count: number,
    readonly pulse_count: number
  ) {
    super(
      `Scope '${scope_id}' in workspace '${workspace_id}' is not empty: ` +
      `${context_count} Context(s) and ${pulse_count} Pulse(s) still reference it.`
    );
    this.name = "ScopeNotEmptyError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function applyScopeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scopes (
      workspace_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, scope_id)
    );

    DROP INDEX IF EXISTS idx_scopes_one_default_per_workspace;
    DROP INDEX IF EXISTS idx_scopes_workspace;

    CREATE INDEX IF NOT EXISTS idx_scopes_workspace
      ON scopes(workspace_id, created_at ASC);
  `);
  const columns = db.prepare("PRAGMA table_info(scopes)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "status")) {
    db.exec("ALTER TABLE scopes ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }
  if (!columns.some((column) => column.name === "published_revision_id")) {
    db.exec("ALTER TABLE scopes ADD COLUMN published_revision_id TEXT");
  }
}

export class ScopeStore {
  constructor(readonly db: DatabaseSync) {}

  listScopes(workspaceId: string): ScopeRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM scopes
      WHERE workspace_id = ?
      ORDER BY created_at ASC, title ASC
    `).all(workspaceId) as any[];
    return rows.map((row) => this.rowToScope(row));
  }

  getScope(workspaceId: string, scopeId: string): ScopeRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM scopes WHERE workspace_id = ? AND scope_id = ?
    `).get(workspaceId, scopeId) as any;
    return row ? this.rowToScope(row) : null;
  }

  createScope(input: {
    workspace_id: string;
    scope_id?: string;
    title: string;
    description?: string | null;
  }): ScopeRecord {
    const scopeId = input.scope_id ?? `scope_${randomUUID()}`;
    if (scopeId === RESERVED_DEFAULT_SCOPE_ID) {
      throw new ScopeReservedIdError(input.workspace_id, scopeId);
    }
    if (this.getScope(input.workspace_id, scopeId)) {
      throw new ScopeAlreadyExistsError(input.workspace_id, scopeId);
    }
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO scopes (
        workspace_id, scope_id, title, description, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.workspace_id,
      scopeId,
      input.title,
      input.description ?? null,
      timestamp,
      timestamp
    );
    return this.getScope(input.workspace_id, scopeId) as ScopeRecord;
  }

  updateScope(input: {
    workspace_id: string;
    scope_id: string;
    title?: string;
    description?: string | null;
  }): ScopeRecord | null {
    const existing = this.getScope(input.workspace_id, input.scope_id);
    if (!existing) return null;
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE scopes
      SET title = ?, description = ?, updated_at = ?
      WHERE workspace_id = ? AND scope_id = ?
    `).run(
      input.title ?? existing.title,
      input.description === undefined ? existing.description : input.description,
      timestamp,
      input.workspace_id,
      input.scope_id
    );
    return this.getScope(input.workspace_id, input.scope_id);
  }

  setScopeStatus(workspaceId: string, scopeId: string, status: "active" | "retired"): ScopeRecord | null {
    if (!this.getScope(workspaceId, scopeId)) return null;
    this.db.prepare(`
      UPDATE scopes SET status = ?, updated_at = ?
      WHERE workspace_id = ? AND scope_id = ?
    `).run(status, nowIso(), workspaceId, scopeId);
    return this.getScope(workspaceId, scopeId);
  }

  /**
   * Deletes the Scope row only. Emptiness and safety checks are the
   * caller's responsibility (BusStore.deleteScope orchestrates them).
   */
  deleteScope(workspaceId: string, scopeId: string): void {
    this.db.prepare(`
      DELETE FROM scopes WHERE workspace_id = ? AND scope_id = ?
    `).run(workspaceId, scopeId);
  }

  private rowToScope(row: any): ScopeRecord {
    return {
      scope_id: String(row.scope_id),
      workspace_id: String(row.workspace_id),
      title: String(row.title),
      description: row.description ?? null,
      status: row.status === "retired" ? "retired" : "active",
      published_revision_id: row.published_revision_id ?? null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    };
  }
}
