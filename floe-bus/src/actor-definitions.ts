/**
 * @invariant This store is the sole write authority for Actor identities and
 * definition revisions. Lifecycle pushes are retained in its transactional
 * outbox before any transport projection may announce them.
 */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  ActorDefinitionValidationError,
  canonicalActorScopePath,
  validateActorDefinition,
  type ActorDefinitionContent,
} from "./actor-definition-contract.js";

export {
  ActorDefinitionValidationError,
  EXTENSION_NAME_PATTERN,
  canonicalActorScopePath,
  validateActorDefinition,
  type ActorDefinitionContent,
  type ActorEscalationRule,
  type ActorResponsibility,
  type ActorScope,
  type VersionedResourceRef,
} from "./actor-definition-contract.js";

export type ActorRecord = Readonly<{
  actor_id: string;
  workspace_id: string;
  created_in_context_id: string | null;
  created_in_scope_execution_id: string | null;
  status: "active" | "retired";
  current_definition_revision_id: string | null;
  created_at: string;
  updated_at: string;
  retired_at: string | null;
}>;

export type ActorDefinitionRevision = Readonly<{
  actor_definition_revision_id: string;
  actor_id: string;
  workspace_id: string;
  revision_number: number;
  based_on_revision_id: string | null;
  semantic_digest: string;
  content: ActorDefinitionContent;
  created_by_principal_id: string;
  created_at: string;
  published_at: string | null;
  withdrawn_at: string | null;
}>;

export type ActorDefinitionHeadChange = Readonly<{
  head_change_id: string;
  actor_id: string;
  workspace_id: string;
  from_revision_id: string | null;
  to_revision_id: string;
  reason: "publish" | "rollback";
  changed_by_principal_id: string;
  changed_at: string;
}>;

export class ActorNotFoundError extends Error {
  readonly code = "E_ACTOR_NOT_FOUND" as const;
  constructor(readonly actor_id: string) {
    super(`Actor not found: ${actor_id}`);
    this.name = "ActorNotFoundError";
  }
}

export class ActorDefinitionRevisionNotFoundError extends Error {
  readonly code = "E_ACTOR_DEFINITION_REVISION_NOT_FOUND" as const;
  constructor(readonly actor_definition_revision_id: string) {
    super(`Actor definition revision not found: ${actor_definition_revision_id}`);
    this.name = "ActorDefinitionRevisionNotFoundError";
  }
}

export class ActorDefinitionImmutableError extends Error {
  readonly code = "E_ACTOR_DEFINITION_IMMUTABLE" as const;
  constructor(readonly actor_definition_revision_id: string) {
    super(`Published Actor definition cannot be changed: ${actor_definition_revision_id}`);
    this.name = "ActorDefinitionImmutableError";
  }
}

export class ActorDefinitionConflictError extends Error {
  readonly code = "E_ACTOR_DEFINITION_CONFLICT" as const;
  constructor(
    readonly actor_id: string,
    readonly expected_revision_id: string | null,
    readonly actual_revision_id: string | null,
  ) {
    super(`Actor '${actor_id}' changed: expected definition '${expected_revision_id ?? "none"}', found '${actual_revision_id ?? "none"}'.`);
    this.name = "ActorDefinitionConflictError";
  }
}

export class ActorDefinitionDraftConflictError extends Error {
  readonly code = "E_ACTOR_DEFINITION_DRAFT_CONFLICT" as const;
  constructor(
    readonly actor_definition_revision_id: string,
    readonly expected_digest: string,
    readonly actual_digest: string,
  ) {
    super(`Actor definition draft '${actor_definition_revision_id}' changed before this edit was applied.`);
    this.name = "ActorDefinitionDraftConflictError";
  }
}

/**
 * An Actor's ID is Workspace-qualified: `actor:<workspace_id>:<name>`. It is
 * also where the Actor receives work, and routing resolves a bare name to it.
 */
export function workspaceActorId(workspaceId: string, name: string): string {
  nonEmpty("workspace_id", workspaceId);
  nonEmpty("name", name);
  return `actor:${workspaceId}:${name}`;
}

/** The name part of a Workspace-qualified Actor ID, accepting either form. */
export function workspaceActorName(workspaceId: string, nameOrId: string): string {
  const prefix = `actor:${workspaceId}:`;
  const name = nameOrId.startsWith(prefix) ? nameOrId.slice(prefix.length) : nameOrId;
  if (!name || name.includes(":")) {
    throw new ActorDefinitionValidationError(
      `Actor name '${nameOrId}' must be a short name without ':' (or an ID in this Workspace, ${prefix}<name>)`);
  }
  return name;
}

export function actorDefinitionDigest(content: ActorDefinitionContent): string {
  validateActorDefinition(content);
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

export function applyActorDefinitionSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS actors (
      actor_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      created_in_context_id TEXT,
      created_in_scope_execution_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
      current_definition_revision_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      retired_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_actors_workspace_status
      ON actors(workspace_id, status, created_at);

    CREATE TABLE IF NOT EXISTS actor_definition_revisions (
      actor_definition_revision_id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL REFERENCES actors(actor_id),
      workspace_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL,
      based_on_revision_id TEXT REFERENCES actor_definition_revisions(actor_definition_revision_id),
      semantic_digest TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_by_principal_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      published_at TEXT,
      withdrawn_at TEXT,
      UNIQUE(actor_id, revision_number)
    );

    CREATE INDEX IF NOT EXISTS idx_actor_definition_revisions_actor
      ON actor_definition_revisions(actor_id, revision_number DESC);

    CREATE TABLE IF NOT EXISTS actor_definition_head_changes (
      head_change_id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL REFERENCES actors(actor_id),
      workspace_id TEXT NOT NULL,
      from_revision_id TEXT,
      to_revision_id TEXT NOT NULL REFERENCES actor_definition_revisions(actor_definition_revision_id),
      reason TEXT NOT NULL CHECK (reason IN ('publish', 'rollback')),
      changed_by_principal_id TEXT NOT NULL,
      changed_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_actor_definition_head_changes_actor
      ON actor_definition_head_changes(actor_id, changed_at, head_change_id);

    CREATE TABLE IF NOT EXISTS actor_lifecycle_push_outbox (
      outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      push_sequence INTEGER
    );
  `);
  addColumnIfMissing(db, "actors", "created_in_context_id", "TEXT");
  addColumnIfMissing(db, "actors", "created_in_scope_execution_id", "TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_actors_creation_context
      ON actors(workspace_id, created_in_context_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_actors_creation_scope_execution
      ON actors(workspace_id, created_in_scope_execution_id, created_at);
  `);
}

export class ActorDefinitionStore {
  private lifecyclePushReady: (() => void) | null = null;

  constructor(
    readonly db: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly validateHead?: (actorId: string, workspaceId: string, content: ActorDefinitionContent) => void,
    private readonly statusChanged?: (actor: ActorRecord) => void,
  ) {
    applyActorDefinitionSchema(db);
  }

  createActor(input: Readonly<{
    workspace_id: string;
    actor_id?: string;
    created_in_context_id?: string | null;
    created_in_scope_execution_id?: string | null;
    created_by_principal_id: string;
    definition: ActorDefinitionContent;
  }>): { actor: ActorRecord; draft: ActorDefinitionRevision } {
    nonEmpty("workspace_id", input.workspace_id);
    nonEmpty("created_by_principal_id", input.created_by_principal_id);
    validateActorDefinition(input.definition);
    const actorId = input.actor_id ?? `actor_${randomUUID()}`;
    nonEmpty("actor_id", actorId);
    const at = this.now();
    let draft!: ActorDefinitionRevision;
    transaction(this.db, () => {
      this.db.prepare(`
        INSERT INTO actors (
          actor_id, workspace_id, created_in_context_id, created_in_scope_execution_id,
          status, current_definition_revision_id,
          created_at, updated_at, retired_at
        ) VALUES (?, ?, ?, ?, 'active', NULL, ?, ?, NULL)
      `).run(
        actorId,
        input.workspace_id,
        input.created_in_context_id ?? null,
        input.created_in_scope_execution_id ?? null,
        at,
        at,
      );
      draft = this.insertDraft({
        actor_id: actorId,
        workspace_id: input.workspace_id,
        based_on_revision_id: null,
        created_by_principal_id: input.created_by_principal_id,
        definition: input.definition,
      });
      const actor = this.requireActor(actorId);
      this.queueLifecyclePush("actor_created", {
        workspace_id: actor.workspace_id,
        actor,
      }, at);
    });
    this.notifyLifecyclePushReady();
    return { actor: this.requireActor(actorId), draft };
  }

  createDraft(input: Readonly<{
    actor_id: string;
    based_on_revision_id?: string | null;
    created_by_principal_id: string;
    definition: ActorDefinitionContent;
  }>): ActorDefinitionRevision {
    const actor = this.requireActor(input.actor_id);
    if (actor.status === "retired") {
      throw new ActorDefinitionValidationError(`retired Actor '${actor.actor_id}' cannot receive a new definition draft`);
    }
    const basedOn = input.based_on_revision_id === undefined
      ? actor.current_definition_revision_id
      : input.based_on_revision_id;
    if (basedOn !== null) this.requireRevisionForActor(basedOn, actor.actor_id);
    return this.insertDraft({
      actor_id: actor.actor_id,
      workspace_id: actor.workspace_id,
      based_on_revision_id: basedOn,
      created_by_principal_id: input.created_by_principal_id,
      definition: input.definition,
    });
  }

  replaceDraft(input: Readonly<{
    actor_definition_revision_id: string;
    expected_digest: string;
    definition: ActorDefinitionContent;
  }>): ActorDefinitionRevision {
    validateActorDefinition(input.definition);
    const revision = this.requireRevision(input.actor_definition_revision_id);
    if (revision.published_at || revision.withdrawn_at) {
      throw new ActorDefinitionImmutableError(revision.actor_definition_revision_id);
    }
    if (revision.semantic_digest !== input.expected_digest) {
      throw new ActorDefinitionDraftConflictError(
        revision.actor_definition_revision_id,
        input.expected_digest,
        revision.semantic_digest,
      );
    }
    this.db.prepare(`
      UPDATE actor_definition_revisions
      SET semantic_digest = ?, content_json = ?
      WHERE actor_definition_revision_id = ? AND published_at IS NULL AND withdrawn_at IS NULL
    `).run(
      actorDefinitionDigest(input.definition),
      JSON.stringify(input.definition),
      revision.actor_definition_revision_id,
    );
    return this.requireRevision(revision.actor_definition_revision_id);
  }

  publishDraft(input: Readonly<{
    actor_definition_revision_id: string;
    expected_current_revision_id: string | null;
    changed_by_principal_id: string;
  }>): ActorDefinitionRevision {
    const revision = this.requireRevision(input.actor_definition_revision_id);
    if (revision.withdrawn_at) throw new ActorDefinitionImmutableError(revision.actor_definition_revision_id);
    if (revision.published_at) {
      if (this.requireActor(revision.actor_id).current_definition_revision_id === revision.actor_definition_revision_id) {
        return revision;
      }
      throw new ActorDefinitionImmutableError(revision.actor_definition_revision_id);
    }
    transaction(this.db, () => {
      this.moveHead({
        revision,
        expected_current_revision_id: input.expected_current_revision_id,
        changed_by_principal_id: input.changed_by_principal_id,
        reason: "publish",
        publish_at: this.now(),
      });
      const actor = this.requireActor(revision.actor_id);
      this.queueLifecyclePush("actor_definition_published", {
        workspace_id: actor.workspace_id,
        actor,
        revision: this.requireRevision(revision.actor_definition_revision_id),
      }, actor.updated_at);
    });
    this.notifyLifecyclePushReady();
    return this.requireRevision(revision.actor_definition_revision_id);
  }

  rollback(input: Readonly<{
    actor_id: string;
    to_published_revision_id: string;
    expected_current_revision_id: string;
    changed_by_principal_id: string;
  }>): ActorDefinitionRevision {
    const actor = this.requireActor(input.actor_id);
    const revision = this.requireRevisionForActor(input.to_published_revision_id, actor.actor_id);
    if (!revision.published_at || revision.withdrawn_at) {
      throw new ActorDefinitionValidationError("rollback target must be a retained published definition");
    }
    transaction(this.db, () => this.moveHead({
      revision,
      expected_current_revision_id: input.expected_current_revision_id,
      changed_by_principal_id: input.changed_by_principal_id,
      reason: "rollback",
      publish_at: null,
    }));
    return revision;
  }

  withdrawDraft(actorDefinitionRevisionId: string): ActorDefinitionRevision {
    const revision = this.requireRevision(actorDefinitionRevisionId);
    if (revision.published_at) throw new ActorDefinitionImmutableError(actorDefinitionRevisionId);
    if (!revision.withdrawn_at) {
      this.db.prepare(`
        UPDATE actor_definition_revisions SET withdrawn_at = ?
        WHERE actor_definition_revision_id = ? AND published_at IS NULL
      `).run(this.now(), actorDefinitionRevisionId);
    }
    return this.requireRevision(actorDefinitionRevisionId);
  }

  setActorStatus(input: Readonly<{
    actor_id: string;
    status: "active" | "retired";
    expected_current_definition_revision_id: string | null;
  }>): ActorRecord {
    const actor = this.requireActor(input.actor_id);
    if (actor.current_definition_revision_id !== input.expected_current_definition_revision_id) {
      throw new ActorDefinitionConflictError(
        actor.actor_id,
        input.expected_current_definition_revision_id,
        actor.current_definition_revision_id,
      );
    }
    const at = this.now();
    transaction(this.db, () => {
      this.db.prepare(`
        UPDATE actors SET status = ?, retired_at = ?, updated_at = ? WHERE actor_id = ?
      `).run(input.status, input.status === "retired" ? at : null, at, actor.actor_id);
      if (input.status === "retired") {
        const retired = this.requireActor(actor.actor_id);
        this.queueLifecyclePush("actor_retired", {
          workspace_id: retired.workspace_id,
          actor: retired,
        }, at);
      }
    });
    if (input.status === "retired") this.notifyLifecyclePushReady();
    const changed = this.requireActor(actor.actor_id);
    if (actor.status !== changed.status) this.statusChanged?.(changed);
    return changed;
  }

  getActor(actorId: string): ActorRecord | null {
    const row = this.db.prepare(`SELECT * FROM actors WHERE actor_id = ?`).get(actorId) as any;
    return row ? rowToActor(row) : null;
  }

  requireActor(actorId: string): ActorRecord {
    const actor = this.getActor(actorId);
    if (!actor) throw new ActorNotFoundError(actorId);
    return actor;
  }

  listActors(workspaceId: string, options: Readonly<{
    include_retired?: boolean;
    created_in_context_id?: string;
    created_in_scope_execution_id?: string;
  }> = {}): ActorRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM actors
      WHERE workspace_id = ?
        AND (? = 1 OR status = 'active')
        AND (? IS NULL OR created_in_context_id = ?)
        AND (? IS NULL OR created_in_scope_execution_id = ?)
      ORDER BY created_at, actor_id
    `).all(
      workspaceId,
      options.include_retired ? 1 : 0,
      options.created_in_context_id ?? null,
      options.created_in_context_id ?? null,
      options.created_in_scope_execution_id ?? null,
      options.created_in_scope_execution_id ?? null,
    );
    return (rows as any[]).map(rowToActor);
  }

  setLifecyclePushReady(notify: () => void): void {
    this.lifecyclePushReady = notify;
  }

  getRevision(revisionId: string): ActorDefinitionRevision | null {
    const row = this.db.prepare(`
      SELECT * FROM actor_definition_revisions WHERE actor_definition_revision_id = ?
    `).get(revisionId) as any;
    return row ? rowToRevision(row) : null;
  }

  requireRevision(revisionId: string): ActorDefinitionRevision {
    const revision = this.getRevision(revisionId);
    if (!revision) throw new ActorDefinitionRevisionNotFoundError(revisionId);
    return revision;
  }

  getCurrentDefinition(actorId: string): ActorDefinitionRevision | null {
    const actor = this.requireActor(actorId);
    return actor.current_definition_revision_id
      ? this.requireRevision(actor.current_definition_revision_id)
      : null;
  }

  listRevisions(actorId: string): ActorDefinitionRevision[] {
    this.requireActor(actorId);
    return (this.db.prepare(`
      SELECT * FROM actor_definition_revisions
      WHERE actor_id = ? ORDER BY revision_number DESC
    `).all(actorId) as any[]).map(rowToRevision);
  }

  listHeadChanges(actorId: string): ActorDefinitionHeadChange[] {
    this.requireActor(actorId);
    return this.db.prepare(`
      SELECT * FROM actor_definition_head_changes
      WHERE actor_id = ? ORDER BY changed_at, head_change_id
    `).all(actorId) as ActorDefinitionHeadChange[];
  }

  private insertDraft(input: Readonly<{
    actor_id: string;
    workspace_id: string;
    based_on_revision_id: string | null;
    created_by_principal_id: string;
    definition: ActorDefinitionContent;
  }>): ActorDefinitionRevision {
    nonEmpty("created_by_principal_id", input.created_by_principal_id);
    validateActorDefinition(input.definition);
    const revisionId = `actor_definition_${randomUUID()}`;
    const revisionNumber = Number((this.db.prepare(`
      SELECT COALESCE(MAX(revision_number), 0) + 1 AS next
      FROM actor_definition_revisions WHERE actor_id = ?
    `).get(input.actor_id) as { next: number }).next);
    this.db.prepare(`
      INSERT INTO actor_definition_revisions (
        actor_definition_revision_id, actor_id, workspace_id, revision_number,
        based_on_revision_id, semantic_digest, content_json,
        created_by_principal_id, created_at, published_at, withdrawn_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
      revisionId,
      input.actor_id,
      input.workspace_id,
      revisionNumber,
      input.based_on_revision_id,
      actorDefinitionDigest(input.definition),
      JSON.stringify(input.definition),
      input.created_by_principal_id,
      this.now(),
    );
    return this.requireRevision(revisionId);
  }

  private requireRevisionForActor(revisionId: string, actorId: string): ActorDefinitionRevision {
    const revision = this.requireRevision(revisionId);
    if (revision.actor_id !== actorId) {
      throw new ActorDefinitionValidationError(`definition '${revisionId}' belongs to another Actor`);
    }
    return revision;
  }

  private moveHead(input: Readonly<{
    revision: ActorDefinitionRevision;
    expected_current_revision_id: string | null;
    changed_by_principal_id: string;
    reason: "publish" | "rollback";
    publish_at: string | null;
  }>): void {
    nonEmpty("changed_by_principal_id", input.changed_by_principal_id);
    const actor = this.requireActor(input.revision.actor_id);
    this.validateHead?.(actor.actor_id, actor.workspace_id, input.revision.content);
    if (actor.status === "retired") {
      throw new ActorDefinitionValidationError(`retired Actor '${actor.actor_id}' cannot change its current definition`);
    }
    if (actor.current_definition_revision_id !== input.expected_current_revision_id) {
      throw new ActorDefinitionConflictError(
        actor.actor_id,
        input.expected_current_revision_id,
        actor.current_definition_revision_id,
      );
    }
    const at = input.publish_at ?? this.now();
    if (input.publish_at) {
      this.db.prepare(`
        UPDATE actor_definition_revisions SET published_at = ?
        WHERE actor_definition_revision_id = ? AND published_at IS NULL AND withdrawn_at IS NULL
      `).run(input.publish_at, input.revision.actor_definition_revision_id);
    }
    this.db.prepare(`
      UPDATE actors SET current_definition_revision_id = ?, updated_at = ? WHERE actor_id = ?
    `).run(input.revision.actor_definition_revision_id, at, actor.actor_id);
    this.db.prepare(`
      INSERT INTO actor_definition_head_changes (
        head_change_id, actor_id, workspace_id, from_revision_id, to_revision_id,
        reason, changed_by_principal_id, changed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `actor_head_change_${randomUUID()}`,
      actor.actor_id,
      actor.workspace_id,
      actor.current_definition_revision_id,
      input.revision.actor_definition_revision_id,
      input.reason,
      input.changed_by_principal_id,
      at,
    );
  }

  private queueLifecyclePush(
    type: "actor_created" | "actor_definition_published" | "actor_retired",
    payload: Record<string, unknown>,
    at: string,
  ): void {
    this.db.prepare(`
      INSERT INTO actor_lifecycle_push_outbox (
        workspace_id, event_type, payload_json, changed_at, push_sequence
      ) VALUES (?, ?, ?, ?, NULL)
    `).run(String(payload.workspace_id), type, JSON.stringify(payload), at);
  }

  private notifyLifecyclePushReady(): void {
    queueMicrotask(() => this.lifecyclePushReady?.());
  }
}

function rowToActor(row: any): ActorRecord {
  return {
    actor_id: String(row.actor_id),
    workspace_id: String(row.workspace_id),
    created_in_context_id: row.created_in_context_id == null ? null : String(row.created_in_context_id),
    created_in_scope_execution_id: row.created_in_scope_execution_id == null
      ? null
      : String(row.created_in_scope_execution_id),
    status: String(row.status) as ActorRecord["status"],
    current_definition_revision_id: row.current_definition_revision_id == null ? null : String(row.current_definition_revision_id),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    retired_at: row.retired_at == null ? null : String(row.retired_at),
  };
}

function rowToRevision(row: any): ActorDefinitionRevision {
  const content = JSON.parse(String(row.content_json)) as ActorDefinitionContent;
  validateActorDefinition(content);
  return {
    actor_definition_revision_id: String(row.actor_definition_revision_id),
    actor_id: String(row.actor_id),
    workspace_id: String(row.workspace_id),
    revision_number: Number(row.revision_number),
    based_on_revision_id: row.based_on_revision_id == null ? null : String(row.based_on_revision_id),
    semantic_digest: String(row.semantic_digest),
    content,
    created_by_principal_id: String(row.created_by_principal_id),
    created_at: String(row.created_at),
    published_at: row.published_at == null ? null : String(row.published_at),
    withdrawn_at: row.withdrawn_at == null ? null : String(row.withdrawn_at),
  };
}

function nonEmpty(label: string, value: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new ActorDefinitionValidationError(`${label} must not be empty`);
  }
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
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

function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("SAVEPOINT actor_definition_change");
  try {
    const result = action();
    db.exec("RELEASE actor_definition_change");
    return result;
  } catch (error) {
    db.exec("ROLLBACK TO actor_definition_change");
    db.exec("RELEASE actor_definition_change");
    throw error;
  }
}
