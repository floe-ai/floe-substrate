import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ActorRoleAuthorityStore } from "../actor-role-authority.js";

export type ContextRecord = {
  context_id: string;
  workspace_id: string;
  scope_id: string | null;
  parent_context_id: string | null;
  created_by_endpoint_id: string | null;
  created_at: string;
  title: string | null;
} & Partial<ContextLifecycleMetadata>;

export type ContextLifecycleMetadata = {
  created_by_principal_id: string | null;
  updated_at: string;
  state_revision: number;
  lifecycle_state: ContextLifecycleState;
  archived_at: string | null;
  archived_by_principal_id: string | null;
  archive_reason: string | null;
  restored_at: string | null;
  restored_by_principal_id: string | null;
  content_state: ContextContentState;
  redacted_at: string | null;
  redacted_by_principal_id: string | null;
  redaction_reason: string | null;
  tombstoned_at: string | null;
  tombstoned_by_principal_id: string | null;
  tombstone_reason: string | null;
};

export type CanonicalContextRecord = Omit<ContextRecord, keyof ContextLifecycleMetadata>
  & ContextLifecycleMetadata;

export type ContextLifecycleState = "active" | "archived" | "tombstoned";
export type ContextContentState = "available" | "redacted" | "destroyed";
export type ContextParticipantAccess = "read" | "contribute" | "manage";

export type ContextParticipantRecord = {
  participant_id: string;
  role: string;
  access: ContextParticipantAccess;
  actor_role_assignment_id: string | null;
  joined_at: string;
  updated_at: string;
};

export type ContextParticipantInput = {
  participant_id: string;
  role?: string;
  access?: ContextParticipantAccess;
};

export class ContextNotFoundError extends Error {
  constructor(readonly context_id: string) {
    super(`Context '${context_id}' was not found.`);
    this.name = "ContextNotFoundError";
  }
}

export class ContextRevisionConflictError extends Error {
  constructor(
    readonly context_id: string,
    readonly expected_revision: number,
    readonly current_revision: number,
  ) {
    super(`Context '${context_id}' changed from revision ${expected_revision} to ${current_revision}.`);
    this.name = "ContextRevisionConflictError";
  }
}

export class ContextLifecycleConflictError extends Error {
  constructor(readonly context_id: string, readonly lifecycle_state: ContextLifecycleState) {
    super(`Context '${context_id}' is '${lifecycle_state}'.`);
    this.name = "ContextLifecycleConflictError";
  }
}

export class ContextParticipantRequiredError extends Error {
  constructor(readonly context_id: string) {
    super(`Context '${context_id}' requires at least one participant while it has no Scope reference.`);
    this.name = "ContextParticipantRequiredError";
  }
}

export type ContextListRow = ContextRecord & {
  participants: string[];
  last_event_at: string | null;
  activity_at: string;
  topic: string | null;
};

export type ContextPageCursor = {
  activity_at: string;
  context_id: string;
};

export type ContextScopeFilter = "all" | "scoped" | "unscoped";

const CONTEXT_ACCESS_LEVELS = new Set<ContextParticipantAccess>(["read", "contribute", "manage"]);

function normalizeParticipants(
  participants: readonly (string | ContextParticipantInput)[],
): Array<Required<ContextParticipantInput>> {
  const unique = new Map<string, Required<ContextParticipantInput>>();
  for (const value of participants) {
    const participant = typeof value === "string"
      ? { participant_id: value, role: "participant", access: "contribute" as const }
      : {
          participant_id: value.participant_id,
          role: value.role ?? "participant",
          access: value.access ?? "contribute",
        };
    if (!participant.participant_id.trim()) throw new Error("Context participant identity must not be empty");
    if (!participant.role.trim()) throw new Error("Context participant role must not be empty");
    if (!CONTEXT_ACCESS_LEVELS.has(participant.access)) {
      throw new Error(`Context participant access '${participant.access}' is invalid`);
    }
    unique.set(participant.participant_id, participant);
  }
  return [...unique.values()];
}

/**
 * Read-only surface used by the context resolver. Keeps the resolver decoupled
 * from the BusStore so it can be unit-tested in isolation.
 */
export interface ContextStoreReader {
  getContext(context_id: string): ContextRecord | null;
  getContextParticipants(context_id: string): string[];
  isParticipant(context_id: string, endpoint_id: string): boolean;
  listContextsForParticipant(endpoint_id: string, options?: {
    workspace_id?: string;
    scope_id?: string;
    limit?: number;
    before?: ContextPageCursor;
    include_archived?: boolean;
    include_tombstoned?: boolean;
  }): ContextListRow[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function relaxContextAnchorColumns(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(contexts)").all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
  const scope = columns.find((item) => item.name === "scope_id");
  const createdBy = columns.find((item) => item.name === "created_by_endpoint_id");
  const needsRebuild =
    scope?.notnull === 1 ||
    scope?.dflt_value != null ||
    createdBy?.notnull === 1;
  if (!needsRebuild) return;

  // The pre-lifecycle Context schema already carried the operator-visible
  // title. Rebuilding the anchor columns must retain it; schema relaxation is
  // not permission to discard Context content.
  const hasTitle = columns.some((item) => item.name === "title");
  const titleDefinition = hasTitle ? ",\n      title TEXT" : "";
  const titleColumns = hasTitle ? ", title" : "";

  db.exec(`
    CREATE TABLE contexts_next (
      context_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      scope_id TEXT,
      parent_context_id TEXT,
      created_by_endpoint_id TEXT,
      created_at TEXT NOT NULL${titleDefinition}
    );

    INSERT INTO contexts_next (
      context_id, workspace_id, scope_id, parent_context_id, created_by_endpoint_id, created_at${titleColumns}
    )
    SELECT
      context_id,
      workspace_id,
      NULLIF(scope_id, 'default'),
      parent_context_id,
      created_by_endpoint_id,
      created_at${titleColumns}
    FROM contexts;

    DROP TABLE contexts;
    ALTER TABLE contexts_next RENAME TO contexts;
  `);
}

export function applyContextSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contexts (
      context_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      scope_id TEXT,
      parent_context_id TEXT,
      created_by_endpoint_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_contexts_workspace
      ON contexts(workspace_id, created_at);

    CREATE TABLE IF NOT EXISTS context_participants (
      context_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (context_id, endpoint_id)
    );

    CREATE INDEX IF NOT EXISTS idx_context_participants_endpoint
      ON context_participants(endpoint_id, context_id);
  `);
  addColumnIfMissing(db, "contexts", "scope_id", "TEXT");
  relaxContextAnchorColumns(db);
  addColumnIfMissing(db, "contexts", "title", "TEXT");
  addColumnIfMissing(db, "contexts", "created_by_principal_id", "TEXT");
  addColumnIfMissing(db, "contexts", "updated_at", "TEXT");
  addColumnIfMissing(db, "contexts", "state_revision", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "contexts", "lifecycle_state", "TEXT NOT NULL DEFAULT 'active'");
  addColumnIfMissing(db, "contexts", "archived_at", "TEXT");
  addColumnIfMissing(db, "contexts", "archived_by_principal_id", "TEXT");
  addColumnIfMissing(db, "contexts", "archive_reason", "TEXT");
  addColumnIfMissing(db, "contexts", "restored_at", "TEXT");
  addColumnIfMissing(db, "contexts", "restored_by_principal_id", "TEXT");
  addColumnIfMissing(db, "contexts", "content_state", "TEXT NOT NULL DEFAULT 'available'");
  addColumnIfMissing(db, "contexts", "redacted_at", "TEXT");
  addColumnIfMissing(db, "contexts", "redacted_by_principal_id", "TEXT");
  addColumnIfMissing(db, "contexts", "redaction_reason", "TEXT");
  addColumnIfMissing(db, "contexts", "tombstoned_at", "TEXT");
  addColumnIfMissing(db, "contexts", "tombstoned_by_principal_id", "TEXT");
  addColumnIfMissing(db, "contexts", "tombstone_reason", "TEXT");
  addColumnIfMissing(db, "context_participants", "role", "TEXT NOT NULL DEFAULT 'participant'");
  addColumnIfMissing(db, "context_participants", "access", "TEXT NOT NULL DEFAULT 'contribute'");
  addColumnIfMissing(db, "context_participants", "updated_at", "TEXT");
  addColumnIfMissing(db, "context_participants", "actor_role_assignment_id", "TEXT");
  db.exec(`
    UPDATE contexts SET updated_at = created_at WHERE updated_at IS NULL;
    UPDATE context_participants SET updated_at = joined_at WHERE updated_at IS NULL;
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_contexts_workspace_scope
      ON contexts(workspace_id, scope_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_contexts_workspace_lifecycle
      ON contexts(workspace_id, lifecycle_state, updated_at, context_id);

    -- Slice 1 Track B: index for parent↔child context linking
    CREATE INDEX IF NOT EXISTS idx_contexts_parent
      ON contexts(parent_context_id, created_at);

    -- Slice 2: per-actor, per-context, per-event-type subscriptions
    CREATE TABLE IF NOT EXISTS context_subscriptions (
      context_id   TEXT NOT NULL,
      endpoint_id  TEXT NOT NULL,
      event_types  TEXT NOT NULL DEFAULT '["*"]',
      subscribed_at TEXT NOT NULL,
      PRIMARY KEY (context_id, endpoint_id)
    );

    CREATE INDEX IF NOT EXISTS idx_context_subscriptions_endpoint
      ON context_subscriptions(endpoint_id, context_id);
  `);
}

export class ContextStore implements ContextStoreReader {
  private actorRoleAuthority: ActorRoleAuthorityStore | null = null;

  constructor(readonly db: DatabaseSync, private readonly now: () => string = nowIso) {}

  createContext(input: {
    workspace_id: string;
    scope_id?: string | null;
    created_by_endpoint_id: string | null;
    created_by_principal_id?: string | null;
    participants: readonly (string | ContextParticipantInput)[];
    parent_context_id?: string | null;
    context_id?: string;
    title?: string | null;
  }): string {
    const id = input.context_id ?? `ctx_${randomUUID()}`;
    const ts = this.now();
    const participants = normalizeParticipants(input.participants);
    if (!input.scope_id && participants.length === 0) {
      throw new Error("Context requires at least one actor participant or Scope");
    }
    const insertContext = this.db.prepare(`
      INSERT INTO contexts (
        context_id, workspace_id, scope_id, parent_context_id,
        created_by_endpoint_id, created_by_principal_id,
        created_at, updated_at, title
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertParticipant = this.db.prepare(`
      INSERT OR IGNORE INTO context_participants (
        context_id, endpoint_id, role, access, actor_role_assignment_id, joined_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      insertContext.run(
        id,
        input.workspace_id,
        input.scope_id ?? null,
        input.parent_context_id ?? null,
        input.created_by_endpoint_id,
        input.created_by_principal_id ?? null,
        ts,
        ts,
        input.title ?? null,
      );
      for (const participant of participants) {
        const roleAssignmentId = this.ensureContextRoleAssignment({
          workspace_id: input.workspace_id,
          context_id: id,
          actor_id: participant.participant_id,
          role: participant.role,
          assigned_by_principal_id: input.created_by_principal_id
            ?? input.created_by_endpoint_id
            ?? "system:context-participant",
          previous_actor_role_assignment_id: null,
        });
        insertParticipant.run(
          id,
          participant.participant_id,
          participant.role,
          participant.access,
          roleAssignmentId,
          ts,
          ts,
        );
      }
      if (ownsTransaction) this.db.exec("COMMIT");
      return id;
    } catch (error) {
      if (ownsTransaction && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getContext(context_id: string): CanonicalContextRecord | null {
    const row = this.db.prepare("SELECT * FROM contexts WHERE context_id = ?").get(context_id) as any;
    if (!row) return null;
    return this.mapContextRecord(row);
  }

  private mapContextRecord(row: any): CanonicalContextRecord {
    return {
      context_id: row.context_id,
      workspace_id: row.workspace_id,
      scope_id: row.scope_id ?? null,
      parent_context_id: row.parent_context_id ?? null,
      created_by_endpoint_id: row.created_by_endpoint_id ?? null,
      created_by_principal_id: row.created_by_principal_id ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at ?? row.created_at,
      title: (row.title as string | null) ?? null,
      state_revision: Number(row.state_revision ?? 1),
      lifecycle_state: (row.lifecycle_state ?? "active") as ContextLifecycleState,
      archived_at: row.archived_at ?? null,
      archived_by_principal_id: row.archived_by_principal_id ?? null,
      archive_reason: row.archive_reason ?? null,
      restored_at: row.restored_at ?? null,
      restored_by_principal_id: row.restored_by_principal_id ?? null,
      content_state: (row.content_state ?? "available") as ContextContentState,
      redacted_at: row.redacted_at ?? null,
      redacted_by_principal_id: row.redacted_by_principal_id ?? null,
      redaction_reason: row.redaction_reason ?? null,
      tombstoned_at: row.tombstoned_at ?? null,
      tombstoned_by_principal_id: row.tombstoned_by_principal_id ?? null,
      tombstone_reason: row.tombstone_reason ?? null,
    };
  }

  requireContext(context_id: string): CanonicalContextRecord {
    const context = this.getContext(context_id);
    if (!context) throw new ContextNotFoundError(context_id);
    return context;
  }

  getContextParticipants(context_id: string): string[] {
    return this.getContextParticipantRecords(context_id).map((participant) => participant.participant_id);
  }

  getContextParticipantRecords(context_id: string): ContextParticipantRecord[] {
    const rows = this.db
      .prepare(`
        SELECT endpoint_id, role, access, actor_role_assignment_id, joined_at, updated_at
        FROM context_participants
        WHERE context_id = ?
        ORDER BY joined_at ASC, endpoint_id ASC
      `)
      .all(context_id) as Array<{
        endpoint_id: string;
        role: string;
        access: ContextParticipantAccess;
        actor_role_assignment_id: string | null;
        joined_at: string;
        updated_at: string | null;
      }>;
    return rows.map((row) => ({
      participant_id: row.endpoint_id,
      role: row.role,
      access: row.access,
      actor_role_assignment_id: row.actor_role_assignment_id ?? null,
      joined_at: row.joined_at,
      updated_at: row.updated_at ?? row.joined_at,
    }));
  }

  isParticipant(context_id: string, endpoint_id: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS x FROM context_participants WHERE context_id = ? AND endpoint_id = ?")
      .get(context_id, endpoint_id);
    return !!row;
  }

  // ---------------------------------------------------------------------------
  // Slice 1 Track A — Dynamic participants
  // ---------------------------------------------------------------------------

  /**
   * Add an endpoint as a participant in a context (idempotent — INSERT OR IGNORE).
   * Returns true when the endpoint was newly added, false when it was already present.
   */
  addParticipant(
    context_id: string,
    endpoint_id: string,
    changed_by_principal_id = "system:context-participant",
  ): boolean {
    const context = this.requireActiveContext(context_id);
    const ts = this.now();
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(`
          INSERT OR IGNORE INTO context_participants (
            context_id, endpoint_id, role, access, actor_role_assignment_id, joined_at, updated_at
          ) VALUES (?, ?, 'participant', 'contribute', NULL, ?, ?)
        `)
        .run(context_id, endpoint_id, ts, ts);
      const changed = Number(result.changes ?? 0) > 0;
      if (changed) {
        const roleAssignmentId = this.ensureContextRoleAssignment({
          workspace_id: context.workspace_id,
          context_id,
          actor_id: endpoint_id,
          role: "participant",
          assigned_by_principal_id: changed_by_principal_id,
          previous_actor_role_assignment_id: null,
        });
        if (roleAssignmentId) {
          this.db.prepare(`
            UPDATE context_participants SET actor_role_assignment_id = ?
            WHERE context_id = ? AND endpoint_id = ?
          `).run(roleAssignmentId, context_id, endpoint_id);
        }
        this.bumpContextRevision(context.context_id, context.state_revision, ts);
      }
      if (ownsTransaction) this.db.exec("COMMIT");
      return changed;
    } catch (error) {
      if (ownsTransaction && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Remove an endpoint from a context's participant list (idempotent).
   * Returns true when the endpoint was removed, false when it was not present.
   * Does NOT affect the endpoint's subscription record — that is managed
   * separately via unsubscribeFromContext.
   */
  removeParticipant(
    context_id: string,
    endpoint_id: string,
    changed_by_principal_id = "system:context-participant",
  ): boolean {
    const context = this.requireActiveContext(context_id);
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getContextParticipantRecords(context_id)
        .find((participant) => participant.participant_id === endpoint_id);
      const result = this.db
        .prepare("DELETE FROM context_participants WHERE context_id = ? AND endpoint_id = ?")
        .run(context_id, endpoint_id);
      const changed = Number(result.changes ?? 0) > 0;
      if (changed) {
        this.revokeContextRoleAssignment(
          context.workspace_id,
          current?.actor_role_assignment_id ?? null,
          changed_by_principal_id,
          "Context participant removed",
        );
        this.bumpContextRevision(context.context_id, context.state_revision, this.now());
      }
      if (ownsTransaction) this.db.exec("COMMIT");
      return changed;
    } catch (error) {
      if (ownsTransaction && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setParticipantAccess(input: {
    context_id: string;
    participant_id: string;
    role: string;
    access: ContextParticipantAccess;
    expected_revision: number;
    changed_by_principal_id?: string;
  }): { context: CanonicalContextRecord; participant: ContextParticipantRecord; changed: boolean } {
    if (!input.participant_id.trim()) throw new Error("Context participant identity must not be empty");
    if (!input.role.trim()) throw new Error("Context participant role must not be empty");
    if (!CONTEXT_ACCESS_LEVELS.has(input.access)) {
      throw new Error(`Context participant access '${input.access}' is invalid`);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const context = this.requireExpectedActiveContext(input.context_id, input.expected_revision);
      const current = this.getContextParticipantRecords(input.context_id)
        .find((participant) => participant.participant_id === input.participant_id);
      if (current?.role === input.role && current.access === input.access) {
        this.db.exec("COMMIT");
        return { context, participant: current, changed: false };
      }

      const ts = this.now();
      const roleAssignmentId = this.ensureContextRoleAssignment({
        workspace_id: context.workspace_id,
        context_id: input.context_id,
        actor_id: input.participant_id,
        role: input.role,
        assigned_by_principal_id: input.changed_by_principal_id ?? "system:context-participant",
        previous_actor_role_assignment_id: current?.actor_role_assignment_id ?? null,
      });
      this.db.prepare(`
        INSERT INTO context_participants (
          context_id, endpoint_id, role, access, actor_role_assignment_id, joined_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(context_id, endpoint_id) DO UPDATE SET
          role = excluded.role,
          access = excluded.access,
          actor_role_assignment_id = excluded.actor_role_assignment_id,
          updated_at = excluded.updated_at
      `).run(input.context_id, input.participant_id, input.role, input.access, roleAssignmentId, ts, ts);
      const changedContext = this.bumpContextRevision(input.context_id, input.expected_revision, ts);
      const participant = this.getContextParticipantRecords(input.context_id)
        .find((item) => item.participant_id === input.participant_id);
      if (!participant) throw new Error("Context participant update did not persist");
      this.db.exec("COMMIT");
      return { context: changedContext, participant, changed: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  removeParticipantAccess(input: {
    context_id: string;
    participant_id: string;
    expected_revision: number;
    changed_by_principal_id?: string;
  }): { context: CanonicalContextRecord; participant_id: string; removed: boolean } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const context = this.requireExpectedActiveContext(input.context_id, input.expected_revision);
      const existingParticipants = this.getContextParticipantRecords(input.context_id);
      if (
        !context.scope_id
        && existingParticipants.length === 1
        && existingParticipants[0]?.participant_id === input.participant_id
      ) {
        throw new ContextParticipantRequiredError(input.context_id);
      }
      const result = this.db.prepare(
        "DELETE FROM context_participants WHERE context_id = ? AND endpoint_id = ?",
      ).run(input.context_id, input.participant_id);
      const removed = Number(result.changes ?? 0) > 0;
      if (removed) {
        const removedParticipant = existingParticipants.find(
          (participant) => participant.participant_id === input.participant_id,
        );
        this.revokeContextRoleAssignment(
          context.workspace_id,
          removedParticipant?.actor_role_assignment_id ?? null,
          input.changed_by_principal_id ?? "system:context-participant",
          "Context participant removed",
        );
      }
      const changedContext = removed
        ? this.bumpContextRevision(input.context_id, input.expected_revision, this.now())
        : context;
      this.db.exec("COMMIT");
      return { context: changedContext, participant_id: input.participant_id, removed };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  archiveContext(input: {
    context_id: string;
    expected_revision: number;
    archived_by_principal_id: string;
    reason?: string | null;
  }): CanonicalContextRecord {
    this.requireExpectedLifecycle(input.context_id, input.expected_revision, "active");
    const ts = this.now();
    const result = this.db.prepare(`
      UPDATE contexts
      SET lifecycle_state = 'archived',
          archived_at = ?,
          archived_by_principal_id = ?,
          archive_reason = ?,
          updated_at = ?,
          state_revision = state_revision + 1
      WHERE context_id = ? AND state_revision = ? AND lifecycle_state = 'active'
    `).run(
      ts,
      input.archived_by_principal_id,
      input.reason ?? null,
      ts,
      input.context_id,
      input.expected_revision,
    );
    if (Number(result.changes ?? 0) !== 1) {
      throw new ContextRevisionConflictError(
        input.context_id,
        input.expected_revision,
        this.requireContext(input.context_id).state_revision,
      );
    }
    return this.requireContext(input.context_id);
  }

  restoreContext(input: {
    context_id: string;
    expected_revision: number;
    restored_by_principal_id: string;
  }): CanonicalContextRecord {
    this.requireExpectedLifecycle(input.context_id, input.expected_revision, "archived");
    const ts = this.now();
    const result = this.db.prepare(`
      UPDATE contexts
      SET lifecycle_state = 'active',
          restored_at = ?,
          restored_by_principal_id = ?,
          updated_at = ?,
          state_revision = state_revision + 1
      WHERE context_id = ? AND state_revision = ? AND lifecycle_state = 'archived'
    `).run(ts, input.restored_by_principal_id, ts, input.context_id, input.expected_revision);
    if (Number(result.changes ?? 0) !== 1) {
      throw new ContextRevisionConflictError(
        input.context_id,
        input.expected_revision,
        this.requireContext(input.context_id).state_revision,
      );
    }
    return this.requireContext(input.context_id);
  }

  /**
   * Low-level final destruction after an integration backend has atomically
   * proved that no retained canonical record references this Context.
   * Identity remains as a redacted tombstone so old audit references do not
   * silently resolve to a different Context.
   */
  tombstoneContext(input: {
    context_id: string;
    expected_revision: number;
    tombstoned_by_principal_id: string;
    reason: string;
    /**
     * Must query every canonical retained-reference table and throw when any
     * reference remains. The guard runs under the same write transaction as
     * content removal, closing the check/delete race across SQLite writers.
     */
    assert_no_retained_references: () => void;
  }): { context: CanonicalContextRecord; events_deleted: number } {
    const context = this.requireExpectedContext(input.context_id, input.expected_revision);
    const ts = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      input.assert_no_retained_references();
      const cleared = this.clearContextHistory(input.context_id);
      for (const participant of this.getContextParticipantRecords(input.context_id)) {
        this.revokeContextRoleAssignment(
          context.workspace_id,
          participant.actor_role_assignment_id,
          input.tombstoned_by_principal_id,
          "Context permanently removed",
        );
      }
      this.db.prepare("DELETE FROM context_participants WHERE context_id = ?").run(input.context_id);
      this.db.prepare("DELETE FROM context_subscriptions WHERE context_id = ?").run(input.context_id);
      if (this.tableExists("pulse_subscribers")) {
        this.db.prepare(`
          DELETE FROM pulse_subscribers
          WHERE json_extract(subscriber_json, '$.kind') = 'context'
            AND json_extract(subscriber_json, '$.context_id') = ?
        `).run(input.context_id);
      }
      const update = this.db.prepare(`
        UPDATE contexts
        SET scope_id = NULL,
            parent_context_id = NULL,
            created_by_endpoint_id = NULL,
            created_by_principal_id = NULL,
            title = NULL,
            lifecycle_state = 'tombstoned',
            content_state = 'destroyed',
            redacted_at = ?,
            redacted_by_principal_id = ?,
            redaction_reason = ?,
            tombstoned_at = ?,
            tombstoned_by_principal_id = ?,
            tombstone_reason = ?,
            updated_at = ?,
            state_revision = state_revision + 1
        WHERE context_id = ? AND state_revision = ? AND lifecycle_state <> 'tombstoned'
      `).run(
        ts,
        input.tombstoned_by_principal_id,
        input.reason,
        ts,
        input.tombstoned_by_principal_id,
        input.reason,
        ts,
        input.context_id,
        input.expected_revision,
      );
      if (Number(update.changes ?? 0) !== 1) {
        throw new ContextRevisionConflictError(
          input.context_id,
          input.expected_revision,
          this.requireContext(input.context_id).state_revision,
        );
      }
      this.db.exec("COMMIT");
      return { context: this.requireContext(input.context_id), events_deleted: cleared.events_deleted };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Slice 1 Track B — Context linking
  // ---------------------------------------------------------------------------

  /**
   * Walk the parent chain starting from `startId` and return true if `candidateId`
   * appears anywhere in that chain (which would create a cycle).
   * Bounded to 100 hops — any legitimate hierarchy is far shallower.
   */
  wouldCreateCycle(startId: string, candidateId: string): boolean {
    const stmt = this.db.prepare("SELECT parent_context_id FROM contexts WHERE context_id = ?");
    let current: string | null = startId;
    let hops = 0;
    while (current !== null && hops < 100) {
      if (current === candidateId) return true;
      const row = stmt.get(current) as { parent_context_id: string | null } | undefined;
      if (!row) break;
      current = row.parent_context_id;
      hops++;
    }
    return false;
  }

  /**
   * List direct children of a parent context (contexts whose parent_context_id
   * equals the given parentId).  Ordered by created_at ascending.
   */
  listContextsForParent(
    parentId: string,
    options: { include_archived?: boolean; include_tombstoned?: boolean } = {},
  ): ContextListRow[] {
    const visibility = this.contextVisibilitySql("c", options);
    const rows = this.db
      .prepare(
        `
        SELECT c.*, MAX(e.created_at) AS last_event_at
        FROM contexts c
        LEFT JOIN events e ON e.context_id = c.context_id
        WHERE c.parent_context_id = ? ${visibility}
        GROUP BY c.context_id
        ORDER BY c.created_at ASC
      `
      )
      .all(parentId) as any[];
    return rows.map((row) => this.mapContextListRow(row));
  }

  setContextScope(context_id: string, scope_id: string): ContextRecord | null {
    this.db.prepare("UPDATE contexts SET scope_id = ? WHERE context_id = ?").run(scope_id, context_id);
    return this.getContext(context_id);
  }

  getLastEventAt(context_id: string): string | null {
    const row = this.db
      .prepare("SELECT MAX(created_at) AS last FROM events WHERE context_id = ?")
      .get(context_id) as any;
    return (row?.last as string | null) ?? null;
  }

  getFirstMessagePreview(context_id: string, maxChars = 80): string | null {
    const row = this.db
      .prepare(
        "SELECT content_json FROM events WHERE context_id = ? AND type = 'message' ORDER BY created_at ASC LIMIT 1"
      )
      .get(context_id) as { content_json: string | null } | undefined;
    if (!row || !row.content_json) return null;
    let parsed: any;
    try {
      parsed = JSON.parse(row.content_json);
    } catch {
      return null;
    }
    const text = parsed && typeof parsed.text === "string" ? parsed.text : null;
    if (!text) return null;
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + "…";
  }

  getLatestMessagePreview(context_id: string, maxChars = 160): string | null {
    const row = this.db
      .prepare(
        "SELECT content_json FROM events WHERE context_id = ? AND type = 'message' ORDER BY created_at DESC LIMIT 1"
      )
      .get(context_id) as { content_json: string | null } | undefined;
    if (!row?.content_json) return null;
    try {
      const parsed = JSON.parse(row.content_json) as { text?: unknown };
      const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
      if (!text) return null;
      return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
    } catch {
      return null;
    }
  }

  private mapContextListRow(row: any): ContextListRow {
    return {
      ...this.mapContextRecord(row),
      last_event_at: (row.last_event_at as string | null) ?? null,
      activity_at: (row.activity_at as string | null) ?? (row.last_event_at as string | null) ?? row.created_at,
      topic: null,
      participants: this.getContextParticipants(row.context_id)
    };
  }

  listContextsForParticipant(endpoint_id: string, options: {
    workspace_id?: string;
    scope_id?: string;
    limit?: number;
    before?: ContextPageCursor;
    include_archived?: boolean;
    include_tombstoned?: boolean;
  } = {}): ContextListRow[] {
    const conditions = ["cp.endpoint_id = ?"];
    const params: Array<string | number> = [endpoint_id];
    if (options.workspace_id) {
      conditions.push("c.workspace_id = ?");
      params.push(options.workspace_id);
    }
    if (options.scope_id) {
      conditions.push("c.scope_id = ?");
      params.push(options.scope_id);
    }
    conditions.push(this.contextVisibilityCondition("c", options));
    if (options.before) {
      params.push(options.before.activity_at, options.before.activity_at, options.before.context_id);
    }
    params.push(options.limit ?? 50);
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT c.*, MAX(e.created_at) AS last_event_at,
          COALESCE(MAX(e.created_at), c.created_at) AS activity_at
        FROM context_participants cp
        JOIN contexts c ON c.context_id = cp.context_id
        LEFT JOIN events e ON e.context_id = c.context_id
        WHERE ${conditions.join(" AND ")}
        GROUP BY c.context_id
      ) AS ranked
      ${options.before ? "WHERE (ranked.activity_at < ? OR (ranked.activity_at = ? AND ranked.context_id < ?))" : ""}
      ORDER BY ranked.activity_at DESC, ranked.context_id DESC
      LIMIT ?
    `).all(...params) as any[];
    return rows.map((row) => this.mapContextListRow(row));
  }

  listContextsForWorkspace(
    workspace_id: string,
    options: {
      scope?: ContextScopeFilter;
      scope_id?: string;
      limit?: number;
      before?: ContextPageCursor;
      include_archived?: boolean;
      include_tombstoned?: boolean;
    } = {}
  ): ContextListRow[] {
    const params: Array<string | number> = [workspace_id];
    let scopeClause = "";
    if (options.scope === "scoped") {
      scopeClause = "AND c.scope_id IS NOT NULL";
    } else if (options.scope === "unscoped") {
      scopeClause = "AND c.scope_id IS NULL";
    }
    if (options.scope_id) {
      scopeClause += " AND c.scope_id = ?";
      params.push(options.scope_id);
    }
    const visibility = this.contextVisibilitySql("c", options);
    if (options.before) {
      params.push(options.before.activity_at, options.before.activity_at, options.before.context_id);
    }
    const limit = options.limit ?? 50;
    params.push(limit);
    const rows = this.db
      .prepare(
        `
        SELECT * FROM (
          SELECT c.*, MAX(e.created_at) AS last_event_at,
            COALESCE(MAX(e.created_at), c.created_at) AS activity_at
          FROM contexts c
          LEFT JOIN events e ON e.context_id = c.context_id
          WHERE c.workspace_id = ? ${scopeClause} ${visibility}
          GROUP BY c.context_id
        ) AS ranked
        ${options.before ? "WHERE (ranked.activity_at < ? OR (ranked.activity_at = ? AND ranked.context_id < ?))" : ""}
        ORDER BY ranked.activity_at DESC, ranked.context_id DESC
        LIMIT ?
      `
      )
      .all(...params) as any[];
    return rows.map((row) => this.mapContextListRow(row));
  }

  /** One bounded Context lineage for the operator Work projection. */
  listContextTree(
    rootContextId: string,
    limit = 200,
    options: { include_archived?: boolean; include_tombstoned?: boolean } = {},
  ): ContextListRow[] {
    const visibility = this.contextVisibilitySql("c", options);
    const rows = this.db.prepare(`
      WITH RECURSIVE tree(context_id, depth) AS (
        SELECT context_id, 0 FROM contexts WHERE context_id = ?
        UNION ALL
        SELECT child.context_id, tree.depth + 1
        FROM contexts child
        JOIN tree ON child.parent_context_id = tree.context_id
      )
      SELECT c.*, MAX(e.created_at) AS last_event_at,
        COALESCE(MAX(e.created_at), c.created_at) AS activity_at,
        tree.depth AS tree_depth
      FROM tree
      JOIN contexts c ON c.context_id = tree.context_id
      LEFT JOIN events e ON e.context_id = c.context_id
      WHERE 1 = 1 ${visibility}
      GROUP BY c.context_id, tree.depth
      ORDER BY tree.depth ASC, c.created_at ASC, c.context_id ASC
      LIMIT ?
    `).all(rootContextId, limit) as any[];
    return rows.map((row) => this.mapContextListRow(row));
  }

  // ---------------------------------------------------------------------------
  // Slice 0 — Context compaction + clear-history
  // ---------------------------------------------------------------------------

  /**
   * Delete all events for a context without deleting the context itself.
   *
   * Replicates the delivery-bundle cleanup from deleteContext so in-flight
   * bundles are kept consistent.  Must NOT be called while a delivery is
   * `active` — callers should check first.
   *
   * Keeps: contexts row, context_participants rows, pulse_subscribers rows.
   * Deletes: events, queued event_queue rows, pending_responses, and
   *          delivery_bundles whose events are all from this context.
   */
  clearContextHistory(contextId: string): { events_deleted: number } {
    const eventIds = (this.db
      .prepare("SELECT event_id FROM events WHERE context_id = ?")
      .all(contextId) as Array<{ event_id: string }>).map((r) => r.event_id);

    if (eventIds.length === 0) return { events_deleted: 0 };

    // Patch/delete delivery bundles that reference this context's events.
    const bundles = this.db
      .prepare("SELECT delivery_id, events_json FROM delivery_bundles")
      .all() as Array<{ delivery_id: string; events_json: string }>;

    const eventSet = new Set(eventIds);
    const bundlesToDelete = new Set<string>();
    const bundlesPatched = new Set<string>();

    for (const bundle of bundles) {
      const events = JSON.parse(bundle.events_json) as Array<{ event_id: string }>;
      const remaining = events.filter((e) => !eventSet.has(e.event_id));
      if (remaining.length === events.length) continue;
      bundlesPatched.add(bundle.delivery_id);
      if (remaining.length === 0) {
        bundlesToDelete.add(bundle.delivery_id);
        this.db.prepare("DELETE FROM delivery_bundles WHERE delivery_id = ?").run(bundle.delivery_id);
      } else {
        this.db.prepare(`
          UPDATE delivery_bundles
          SET trigger_event_id = ?, events_json = ?
          WHERE delivery_id = ?
        `).run(remaining[0].event_id, JSON.stringify(remaining), bundle.delivery_id);
      }
    }

    for (const eventId of eventIds) {
      this.db.prepare("DELETE FROM event_queue WHERE event_id = ?").run(eventId);
      this.db.prepare("DELETE FROM pending_responses WHERE source_event_id = ?").run(eventId);
      this.db.prepare("DELETE FROM events WHERE event_id = ?").run(eventId);
    }

    for (const deliveryId of bundlesPatched) {
      this.db.prepare("DELETE FROM runtime_telemetry WHERE delivery_id = ?").run(deliveryId);
    }
    for (const deliveryId of bundlesToDelete) {
      this.db.prepare("DELETE FROM event_queue WHERE delivery_id = ?").run(deliveryId);
    }

    return { events_deleted: eventIds.length };
  }

  /**
   * Compact a context's history: delete events older than `before_event_id`
   * (or all events when omitted), then insert one synthetic
   * `context.compacted` event carrying `summary` as the record.
   *
   * Returns the summary event's id.
   */
  compactContext(contextId: string, summary: string, beforeEventId?: string): string {
    const watermark = beforeEventId
      ? (this.db
          .prepare("SELECT created_at FROM events WHERE event_id = ? AND context_id = ?")
          .get(beforeEventId, contextId) as { created_at: string } | undefined)
        ?.created_at
      : undefined;

    // Determine events to delete.
    const eventIds = ((
      watermark
        ? this.db
            .prepare("SELECT event_id FROM events WHERE context_id = ? AND created_at < ?")
            .all(contextId, watermark)
        : this.db
            .prepare("SELECT event_id FROM events WHERE context_id = ?")
            .all(contextId)
    ) as Array<{ event_id: string }>).map((r) => r.event_id);

    // Patch/delete delivery bundles referencing removed events.
    const bundles = this.db
      .prepare("SELECT delivery_id, events_json FROM delivery_bundles")
      .all() as Array<{ delivery_id: string; events_json: string }>;

    const eventSet = new Set(eventIds);
    const bundlesToDelete = new Set<string>();
    const bundlesPatched = new Set<string>();

    for (const bundle of bundles) {
      const events = JSON.parse(bundle.events_json) as Array<{ event_id: string }>;
      const remaining = events.filter((e) => !eventSet.has(e.event_id));
      if (remaining.length === events.length) continue;
      bundlesPatched.add(bundle.delivery_id);
      if (remaining.length === 0) {
        bundlesToDelete.add(bundle.delivery_id);
        this.db.prepare("DELETE FROM delivery_bundles WHERE delivery_id = ?").run(bundle.delivery_id);
      } else {
        this.db.prepare(`
          UPDATE delivery_bundles
          SET trigger_event_id = ?, events_json = ?
          WHERE delivery_id = ?
        `).run(remaining[0].event_id, JSON.stringify(remaining), bundle.delivery_id);
      }
    }

    for (const eventId of eventIds) {
      this.db.prepare("DELETE FROM event_queue WHERE event_id = ?").run(eventId);
      this.db.prepare("DELETE FROM pending_responses WHERE source_event_id = ?").run(eventId);
      this.db.prepare("DELETE FROM events WHERE event_id = ?").run(eventId);
    }

    for (const deliveryId of bundlesPatched) {
      this.db.prepare("DELETE FROM runtime_telemetry WHERE delivery_id = ?").run(deliveryId);
    }
    for (const deliveryId of bundlesToDelete) {
      this.db.prepare("DELETE FROM event_queue WHERE delivery_id = ?").run(deliveryId);
    }

    // Insert the synthetic summary event.
    const summaryEventId = `evt_${randomUUID()}`;
    const ts = this.now();
    this.db.prepare(`
      INSERT INTO events (
        event_id, type, workspace_id, source_endpoint_id, context_id, thread_id, scope_id,
        correlation_id, destination_json, content_json, response_json,
        metadata_json, idempotency_key, created_at
      )
      SELECT
        ?, 'context.compacted', c.workspace_id, NULL, ?, '', c.scope_id,
        NULL,
        json_object('kind','context','context_id',?),
        json_object('summary',?),
        json_object('expected', json('false')),
        json_object('compacted_event_count',?),
        NULL, ?
      FROM contexts c
      WHERE c.context_id = ?
    `).run(summaryEventId, contextId, contextId, summary, eventIds.length, ts, contextId);

    return summaryEventId;
  }

  listContextsForScope(
    workspace_id: string,
    scope_id: string,
    options: { include_archived?: boolean; include_tombstoned?: boolean } = {},
  ): ContextListRow[] {
    const visibility = this.contextVisibilitySql("c", options);
    const rows = this.db
      .prepare(
        `
        SELECT c.*, MAX(e.created_at) AS last_event_at
        FROM contexts c
        LEFT JOIN events e ON e.context_id = c.context_id
        WHERE c.workspace_id = ? AND c.scope_id = ? ${visibility}
        GROUP BY c.context_id
        ORDER BY (last_event_at IS NULL) ASC, last_event_at DESC, c.created_at DESC
      `
      )
      .all(workspace_id, scope_id) as any[];
    return rows.map((row) => this.mapContextListRow(row));
  }

  // ---------------------------------------------------------------------------
  // Slice 2 — Per-actor, per-context, per-event-type subscriptions
  // ---------------------------------------------------------------------------

  /**
   * Subscribe an endpoint to events in a context.
   *
   * `eventTypes` is a JSON-serialisable array of event type strings.  The
   * special value `["*"]` (the default) means "all event types".
   *
   * Idempotent: if a subscription already exists it is replaced (UPSERT).
   */
  subscribeToContext(
    contextId: string,
    endpointId: string,
    eventTypes: string[] = ["*"]
  ): void {
    this.requireActiveContext(contextId);
    const ts = this.now();
    this.db.prepare(`
      INSERT INTO context_subscriptions (context_id, endpoint_id, event_types, subscribed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(context_id, endpoint_id) DO UPDATE SET
        event_types  = excluded.event_types,
        subscribed_at = excluded.subscribed_at
    `).run(contextId, endpointId, JSON.stringify(eventTypes), ts);
  }

  /**
   * Remove a subscription for an endpoint from a context (idempotent).
   */
  unsubscribeFromContext(contextId: string, endpointId: string): void {
    this.db.prepare(
      "DELETE FROM context_subscriptions WHERE context_id = ? AND endpoint_id = ?"
    ).run(contextId, endpointId);
  }

  /**
   * Return all active subscriptions for a context.
   */
  getContextSubscriptions(
    contextId: string,
    options: { include_inactive?: boolean } = {},
  ): Array<{
    endpoint_id: string;
    event_types: string[];
    subscribed_at: string;
  }> {
    const context = this.getContext(contextId);
    if (!context || (!options.include_inactive && context.lifecycle_state !== "active")) return [];
    const rows = this.db
      .prepare(
        "SELECT endpoint_id, event_types, subscribed_at FROM context_subscriptions WHERE context_id = ? ORDER BY subscribed_at ASC"
      )
      .all(contextId) as Array<{ endpoint_id: string; event_types: string; subscribed_at: string }>;
    return rows.map((r) => ({
      endpoint_id: r.endpoint_id,
      event_types: JSON.parse(r.event_types) as string[],
      subscribed_at: r.subscribed_at,
    }));
  }

  // ---------------------------------------------------------------------------
  // Batch apply — participants + subscriptions in one atomic transaction
  // ---------------------------------------------------------------------------

  /**
   * Atomically apply a set of participant + subscription changes to a context.
   *
   * - `entries`: each entry idempotently adds `endpoint_id` as a participant
   *   AND upserts its subscription with the given `event_types`.
   *   `event_types: []` means "participant but never woken" (silent watcher).
   * - `participantsOnly`: endpoints added as participants with NO subscription
   *   change — useful for acting actors who must be able to emit but are not
   *   subscribed to any event type.
   *
   * All changes are applied in a single SQLite transaction.
   */
  applyContextSubscriptions(
    contextId: string,
    entries: Array<{ endpoint_id: string; event_types: string[] }>,
    participantsOnly: string[] = []
  ): void {
    const context = this.requireActiveContext(contextId);
    const ts = this.now();
    const insertParticipant = this.db.prepare(
      `INSERT OR IGNORE INTO context_participants (
        context_id, endpoint_id, role, access, actor_role_assignment_id, joined_at, updated_at
      ) VALUES (?, ?, 'participant', 'contribute', NULL, ?, ?)`
    );
    const upsertSubscription = this.db.prepare(`
      INSERT INTO context_subscriptions (context_id, endpoint_id, event_types, subscribed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(context_id, endpoint_id) DO UPDATE SET
        event_types   = excluded.event_types,
        subscribed_at = excluded.subscribed_at
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let participantChanged = false;
      for (const ep of participantsOnly) {
        const inserted = Number(insertParticipant.run(contextId, ep, ts, ts).changes ?? 0) > 0;
        if (inserted) this.attachDefaultContextRole(context, ep);
        participantChanged = inserted || participantChanged;
      }
      for (const entry of entries) {
        const inserted = Number(insertParticipant.run(contextId, entry.endpoint_id, ts, ts).changes ?? 0) > 0;
        if (inserted) this.attachDefaultContextRole(context, entry.endpoint_id);
        participantChanged = inserted || participantChanged;
        upsertSubscription.run(contextId, entry.endpoint_id, JSON.stringify(entry.event_types), ts);
      }
      if (participantChanged) this.bumpContextRevision(contextId, context.state_revision, ts);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Check whether an endpoint's subscription matches a given event type.
   *
   * Returns false when no subscription row exists.
   * Returns true when the subscription covers `"*"` or the exact eventType.
   */
  isSubscribed(contextId: string, endpointId: string, eventType: string): boolean {
    const context = this.getContext(contextId);
    if (!context || context.lifecycle_state !== "active") return false;
    const row = this.db
      .prepare(
        "SELECT event_types FROM context_subscriptions WHERE context_id = ? AND endpoint_id = ?"
      )
      .get(contextId, endpointId) as { event_types: string } | undefined;
    if (!row) return false;
    const types = JSON.parse(row.event_types) as string[];
    return types.includes("*") || types.includes(eventType);
  }

  private attachDefaultContextRole(context: CanonicalContextRecord, actorId: string): void {
    const roleAssignmentId = this.ensureContextRoleAssignment({
      workspace_id: context.workspace_id,
      context_id: context.context_id,
      actor_id: actorId,
      role: "participant",
      assigned_by_principal_id: "system:context-subscription",
      previous_actor_role_assignment_id: null,
    });
    if (roleAssignmentId) {
      this.db.prepare(`
        UPDATE context_participants SET actor_role_assignment_id = ?
        WHERE context_id = ? AND endpoint_id = ?
      `).run(roleAssignmentId, context.context_id, actorId);
    }
  }

  private ensureContextRoleAssignment(input: {
    workspace_id: string;
    context_id: string;
    actor_id: string;
    role: string;
    assigned_by_principal_id: string;
    previous_actor_role_assignment_id: string | null;
  }): string | null {
    if (!this.tableExists("actors") || !this.tableExists("actor_role_assignments")) return null;
    const actor = this.db.prepare(`
      SELECT status FROM actors WHERE workspace_id = ? AND actor_id = ?
    `).get(input.workspace_id, input.actor_id) as { status: string } | undefined;
    if (!actor || actor.status !== "active") return null;
    const authority = this.actorRoleAuthority
      ??= new ActorRoleAuthorityStore(this.db, { now: this.now });
    return authority.replaceContextParticipantRole(input).actor_role_assignment_id;
  }

  private revokeContextRoleAssignment(
    workspaceId: string,
    assignmentId: string | null,
    changedByPrincipalId: string,
    reason: string,
  ): void {
    if (!assignmentId || !this.tableExists("actor_role_assignments")) return;
    const authority = this.actorRoleAuthority
      ??= new ActorRoleAuthorityStore(this.db, { now: this.now });
    authority.revokeRoleAssignment({
      workspace_id: workspaceId,
      actor_role_assignment_id: assignmentId,
      revoked_by_principal_id: changedByPrincipalId,
      reason,
    });
  }

  private requireActiveContext(contextId: string): CanonicalContextRecord {
    const context = this.requireContext(contextId);
    if (context.lifecycle_state !== "active") {
      throw new ContextLifecycleConflictError(contextId, context.lifecycle_state);
    }
    return context;
  }

  private requireExpectedContext(contextId: string, expectedRevision: number): CanonicalContextRecord {
    const context = this.requireContext(contextId);
    if (context.state_revision !== expectedRevision) {
      throw new ContextRevisionConflictError(contextId, expectedRevision, context.state_revision);
    }
    return context;
  }

  private requireExpectedActiveContext(contextId: string, expectedRevision: number): CanonicalContextRecord {
    const context = this.requireExpectedContext(contextId, expectedRevision);
    if (context.lifecycle_state !== "active") {
      throw new ContextLifecycleConflictError(contextId, context.lifecycle_state);
    }
    return context;
  }

  private requireExpectedLifecycle(
    contextId: string,
    expectedRevision: number,
    lifecycleState: ContextLifecycleState,
  ): CanonicalContextRecord {
    const context = this.requireExpectedContext(contextId, expectedRevision);
    if (context.lifecycle_state !== lifecycleState) {
      throw new ContextLifecycleConflictError(contextId, context.lifecycle_state);
    }
    return context;
  }

  private bumpContextRevision(contextId: string, expectedRevision: number, updatedAt: string): CanonicalContextRecord {
    const result = this.db.prepare(`
      UPDATE contexts
      SET state_revision = state_revision + 1, updated_at = ?
      WHERE context_id = ? AND state_revision = ?
    `).run(updatedAt, contextId, expectedRevision);
    if (Number(result.changes ?? 0) !== 1) {
      throw new ContextRevisionConflictError(
        contextId,
        expectedRevision,
        this.requireContext(contextId).state_revision,
      );
    }
    return this.requireContext(contextId);
  }

  private contextVisibilityCondition(
    alias: string,
    options: { include_archived?: boolean; include_tombstoned?: boolean },
  ): string {
    if (options.include_tombstoned) return "1 = 1";
    if (options.include_archived) return `${alias}.lifecycle_state <> 'tombstoned'`;
    return `${alias}.lifecycle_state = 'active'`;
  }

  private contextVisibilitySql(
    alias: string,
    options: { include_archived?: boolean; include_tombstoned?: boolean },
  ): string {
    return `AND ${this.contextVisibilityCondition(alias, options)}`;
  }

  private tableExists(name: string): boolean {
    return !!this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name);
  }
}
