import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type VersionedResourceRef = Readonly<{
  kind: string;
  id: string;
  revision: string | null;
}>;

export type ActorResponsibility = Readonly<{
  responsibility_id: string;
  title: string;
  description: string;
}>;

export type ActorEscalationRule = Readonly<{
  rule_id: string;
  when: string;
  action: "decline" | "delegate" | "escalate" | "signal_unowned";
  target_actor_id?: string | null;
}>;

/**
 * The durable, provider-neutral meaning of an Actor. Runtime availability and
 * model/service selection are deliberately absent and live in a replaceable
 * runtime binding.
 */
export type ActorDefinitionContent = Readonly<{
  label: string;
  charter: string;
  responsibilities: readonly ActorResponsibility[];
  instructions: string;
  knowledge_refs: readonly VersionedResourceRef[];
  capability_grant_ids: readonly string[];
  policy_refs: Readonly<{
    budget: VersionedResourceRef | null;
    trust: VersionedResourceRef | null;
    approval: VersionedResourceRef | null;
  }>;
  escalation_rules: readonly ActorEscalationRule[];
}>;

export type ActorRecord = Readonly<{
  actor_id: string;
  workspace_id: string;
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

export class ActorDefinitionValidationError extends Error {
  readonly code = "E_ACTOR_DEFINITION_INVALID" as const;
  constructor(readonly reason: string) {
    super(`Invalid Actor definition: ${reason}`);
    this.name = "ActorDefinitionValidationError";
  }
}

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

export function actorDefinitionDigest(content: ActorDefinitionContent): string {
  validateActorDefinition(content);
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

export function validateActorDefinition(content: ActorDefinitionContent): void {
  nonEmpty("label", content.label);
  nonEmpty("charter", content.charter);
  nonEmpty("instructions", content.instructions);
  unique(content.responsibilities.map((item) => item.responsibility_id), "responsibility id");
  for (const responsibility of content.responsibilities) {
    nonEmpty("responsibility title", responsibility.title);
    nonEmpty("responsibility description", responsibility.description);
  }
  unique(content.capability_grant_ids, "CapabilityGrant id");
  unique(content.escalation_rules.map((item) => item.rule_id), "escalation rule id");
  for (const ref of content.knowledge_refs) validateRef(ref, "knowledge reference");
  for (const [name, ref] of Object.entries(content.policy_refs)) {
    if (ref) validateRef(ref, `${name} policy reference`);
  }
  for (const rule of content.escalation_rules) {
    nonEmpty("escalation condition", rule.when);
    if (rule.action === "delegate" && !rule.target_actor_id?.trim()) {
      throw new ActorDefinitionValidationError(`delegation rule '${rule.rule_id}' must name a target Actor`);
    }
    if (rule.action !== "delegate" && rule.target_actor_id != null) {
      throw new ActorDefinitionValidationError(`only delegation rule '${rule.rule_id}' may name a target Actor`);
    }
  }
}

export function applyActorDefinitionSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS actors (
      actor_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
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
  `);
}

export class ActorDefinitionStore {
  constructor(
    readonly db: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly validateGrantReferences?: (actorId: string, workspaceId: string, grantIds: readonly string[]) => void,
  ) {
    applyActorDefinitionSchema(db);
  }

  createActor(input: Readonly<{
    workspace_id: string;
    actor_id?: string;
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
          actor_id, workspace_id, status, current_definition_revision_id,
          created_at, updated_at, retired_at
        ) VALUES (?, ?, 'active', NULL, ?, ?, NULL)
      `).run(actorId, input.workspace_id, at, at);
      draft = this.insertDraft({
        actor_id: actorId,
        workspace_id: input.workspace_id,
        based_on_revision_id: null,
        created_by_principal_id: input.created_by_principal_id,
        definition: input.definition,
      });
    });
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
    transaction(this.db, () => this.moveHead({
      revision,
      expected_current_revision_id: input.expected_current_revision_id,
      changed_by_principal_id: input.changed_by_principal_id,
      reason: "publish",
      publish_at: this.now(),
    }));
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
    this.db.prepare(`
      UPDATE actors SET status = ?, retired_at = ?, updated_at = ? WHERE actor_id = ?
    `).run(input.status, input.status === "retired" ? at : null, at, actor.actor_id);
    return this.requireActor(actor.actor_id);
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

  listActors(workspaceId: string, options: Readonly<{ include_retired?: boolean }> = {}): ActorRecord[] {
    const rows = options.include_retired
      ? this.db.prepare(`SELECT * FROM actors WHERE workspace_id = ? ORDER BY created_at, actor_id`).all(workspaceId)
      : this.db.prepare(`SELECT * FROM actors WHERE workspace_id = ? AND status = 'active' ORDER BY created_at, actor_id`).all(workspaceId);
    return (rows as any[]).map(rowToActor);
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
    this.validateGrantReferences?.(actor.actor_id, actor.workspace_id, input.revision.content.capability_grant_ids);
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
}

function rowToActor(row: any): ActorRecord {
  return {
    actor_id: String(row.actor_id),
    workspace_id: String(row.workspace_id),
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

function validateRef(ref: VersionedResourceRef, label: string): void {
  nonEmpty(`${label} kind`, ref.kind);
  nonEmpty(`${label} id`, ref.id);
  if (ref.revision !== null) nonEmpty(`${label} revision`, ref.revision);
}

function unique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    nonEmpty(label, value);
    if (seen.has(value)) throw new ActorDefinitionValidationError(`duplicate ${label} '${value}'`);
    seen.add(value);
  }
}

function nonEmpty(label: string, value: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new ActorDefinitionValidationError(`${label} must not be empty`);
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
