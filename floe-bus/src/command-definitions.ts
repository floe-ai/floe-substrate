import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { JsonSchema, OperationResourceRef, VersionedOperationSchema } from "./operations.js";

export type CommandOwner = Readonly<{
  kind: "workspace" | "host" | "extension_package_version";
  id: string;
}>;

export type CommandPermission = Readonly<{
  /** Stable name used by the implementation when requesting this permission. */
  permission_id: string;
  /** Canonical semantic operation which the permission may invoke. */
  operation_id: string;
  purpose: string;
}>;

export type CommandSideEffect = Readonly<{
  effect_id: string;
  title: string;
  external: boolean;
  reversibility: "none" | "reversible" | "irreversible";
  resource_kinds: readonly string[];
}>;

export type CommandIdempotencyContract = Readonly<{
  mode: "pure" | "content_addressed" | "caller_key" | "effect_receipt";
  key_schema_ref: string | null;
}>;

/**
 * Immutable executable meaning of a Command. The implementation reference is
 * exact; a mutable path, package name, or runtime discovery result is not a
 * reproducible Command implementation.
 */
export type CommandDefinitionContent = Readonly<{
  label: string;
  description: string;
  input: VersionedOperationSchema;
  output: VersionedOperationSchema;
  side_effects: readonly CommandSideEffect[];
  permissions: readonly CommandPermission[];
  timeout_ms: number;
  cancellation: "supported" | "best_effort" | "not_supported";
  idempotency: CommandIdempotencyContract;
  implementation_ref: OperationResourceRef;
  entry_point: string;
}>;

export type CommandRecord = Readonly<{
  command_id: string;
  owner: CommandOwner;
  status: "active" | "retired";
  current_revision_id: string | null;
  created_at: string;
  updated_at: string;
  retired_at: string | null;
}>;

export type CommandDefinitionRevision = Readonly<{
  command_definition_revision_id: string;
  command_id: string;
  owner: CommandOwner;
  revision_number: number;
  based_on_revision_id: string | null;
  semantic_digest: string;
  content: CommandDefinitionContent;
  created_by_principal_id: string;
  created_at: string;
  published_at: string | null;
  withdrawn_at: string | null;
}>;

export type CommandDefinitionHeadChange = Readonly<{
  head_change_id: string;
  command_id: string;
  owner: CommandOwner;
  from_revision_id: string | null;
  to_revision_id: string;
  reason: "publish" | "rollback";
  changed_by_principal_id: string;
  changed_at: string;
}>;

export class CommandDefinitionValidationError extends Error {
  readonly code = "E_COMMAND_DEFINITION_INVALID" as const;
  constructor(readonly reason: string) {
    super(`Invalid Command definition: ${reason}`);
    this.name = "CommandDefinitionValidationError";
  }
}

export class CommandNotFoundError extends Error {
  readonly code = "E_COMMAND_NOT_FOUND" as const;
  constructor(readonly command_id: string) {
    super(`Command not found: ${command_id}`);
    this.name = "CommandNotFoundError";
  }
}

export class CommandDefinitionRevisionNotFoundError extends Error {
  readonly code = "E_COMMAND_DEFINITION_REVISION_NOT_FOUND" as const;
  constructor(readonly command_definition_revision_id: string) {
    super(`Command definition revision not found: ${command_definition_revision_id}`);
    this.name = "CommandDefinitionRevisionNotFoundError";
  }
}

export class CommandDefinitionImmutableError extends Error {
  readonly code = "E_COMMAND_DEFINITION_IMMUTABLE" as const;
  constructor(readonly command_definition_revision_id: string) {
    super(`Published Command definition cannot be changed: ${command_definition_revision_id}`);
    this.name = "CommandDefinitionImmutableError";
  }
}

export class CommandDefinitionConflictError extends Error {
  readonly code = "E_COMMAND_DEFINITION_CONFLICT" as const;
  constructor(
    readonly command_id: string,
    readonly expected_revision_id: string | null,
    readonly actual_revision_id: string | null,
  ) {
    super(`Command '${command_id}' changed: expected definition '${expected_revision_id ?? "none"}', found '${actual_revision_id ?? "none"}'.`);
    this.name = "CommandDefinitionConflictError";
  }
}

export class CommandDefinitionDraftConflictError extends Error {
  readonly code = "E_COMMAND_DEFINITION_DRAFT_CONFLICT" as const;
  constructor(
    readonly command_definition_revision_id: string,
    readonly expected_digest: string,
    readonly actual_digest: string,
  ) {
    super(`Command definition draft '${command_definition_revision_id}' changed before this edit was applied.`);
    this.name = "CommandDefinitionDraftConflictError";
  }
}

export function commandDefinitionDigest(content: CommandDefinitionContent): string {
  validateCommandDefinition(content);
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

export function validateCommandDefinition(content: CommandDefinitionContent): void {
  nonEmpty("label", content.label);
  nonEmpty("description", content.description);
  validateVersionedSchema(content.input, "input");
  validateVersionedSchema(content.output, "output");
  unique(content.side_effects.map((effect) => effect.effect_id), "side-effect id");
  for (const effect of content.side_effects) {
    nonEmpty("side-effect title", effect.title);
    unique(effect.resource_kinds, `side-effect '${effect.effect_id}' resource kind`);
  }
  unique(content.permissions.map((permission) => permission.permission_id), "permission id");
  for (const permission of content.permissions) {
    nonEmpty("permission operation_id", permission.operation_id);
    nonEmpty("permission purpose", permission.purpose);
  }
  if (!Number.isSafeInteger(content.timeout_ms) || content.timeout_ms < 1 || content.timeout_ms > 86_400_000) {
    throw invalid("timeout_ms must be an integer between 1 and 86400000");
  }
  if (content.idempotency.mode === "pure" && content.side_effects.length > 0) {
    throw invalid("a pure Command cannot declare side effects");
  }
  if (content.idempotency.mode === "effect_receipt"
    && !content.side_effects.some((effect) => effect.external)) {
    throw invalid("effect_receipt idempotency requires an external side effect");
  }
  if (content.side_effects.some((effect) => effect.external)
    && content.idempotency.mode !== "effect_receipt"
    && content.idempotency.mode !== "caller_key") {
    throw invalid("an external side effect requires caller_key or effect_receipt idempotency");
  }
  if (content.idempotency.key_schema_ref !== null) {
    nonEmpty("idempotency key schema reference", content.idempotency.key_schema_ref);
  }
  if (content.idempotency.mode === "pure" && content.idempotency.key_schema_ref !== null) {
    throw invalid("a pure Command cannot require an idempotency key schema");
  }
  validateExactRef(content.implementation_ref, "implementation reference");
  nonEmpty("entry_point", content.entry_point);
}

export function applyCommandDefinitionSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS commands (
      command_id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL CHECK (owner_kind IN ('workspace', 'host', 'extension_package_version')),
      owner_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
      current_revision_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      retired_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_commands_owner_status
      ON commands(owner_kind, owner_id, status, created_at, command_id);

    CREATE TABLE IF NOT EXISTS command_definition_revisions (
      command_definition_revision_id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL REFERENCES commands(command_id),
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL,
      based_on_revision_id TEXT REFERENCES command_definition_revisions(command_definition_revision_id),
      semantic_digest TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_by_principal_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      published_at TEXT,
      withdrawn_at TEXT,
      UNIQUE(command_id, revision_number)
    );

    CREATE INDEX IF NOT EXISTS idx_command_definition_revisions_command
      ON command_definition_revisions(command_id, revision_number DESC);

    CREATE TABLE IF NOT EXISTS command_definition_head_changes (
      head_change_id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL REFERENCES commands(command_id),
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      from_revision_id TEXT,
      to_revision_id TEXT NOT NULL REFERENCES command_definition_revisions(command_definition_revision_id),
      reason TEXT NOT NULL CHECK (reason IN ('publish', 'rollback')),
      changed_by_principal_id TEXT NOT NULL,
      changed_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_command_definition_head_changes_command
      ON command_definition_head_changes(command_id, changed_at, head_change_id);
  `);
}

export class CommandDefinitionStore {
  constructor(
    readonly db: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    applyCommandDefinitionSchema(db);
  }

  createCommand(input: Readonly<{
    owner: CommandOwner;
    command_id?: string;
    created_by_principal_id: string;
    definition: CommandDefinitionContent;
  }>): { command: CommandRecord; draft: CommandDefinitionRevision } {
    validateOwner(input.owner);
    nonEmpty("created_by_principal_id", input.created_by_principal_id);
    validateCommandDefinition(input.definition);
    const commandId = input.command_id ?? `command_${randomUUID()}`;
    nonEmpty("command_id", commandId);
    const at = this.now();
    let draft!: CommandDefinitionRevision;
    transaction(this.db, () => {
      this.db.prepare(`
        INSERT INTO commands (
          command_id, owner_kind, owner_id, status, current_revision_id,
          created_at, updated_at, retired_at
        ) VALUES (?, ?, ?, 'active', NULL, ?, ?, NULL)
      `).run(commandId, input.owner.kind, input.owner.id, at, at);
      draft = this.insertDraft({
        command_id: commandId,
        owner: input.owner,
        based_on_revision_id: null,
        created_by_principal_id: input.created_by_principal_id,
        definition: input.definition,
      });
    });
    return { command: this.requireCommand(commandId), draft };
  }

  createDraft(input: Readonly<{
    command_id: string;
    based_on_revision_id?: string | null;
    created_by_principal_id: string;
    definition: CommandDefinitionContent;
  }>): CommandDefinitionRevision {
    const command = this.requireCommand(input.command_id);
    if (command.status === "retired") throw invalid(`retired Command '${command.command_id}' cannot receive a draft`);
    const basedOn = input.based_on_revision_id === undefined
      ? command.current_revision_id
      : input.based_on_revision_id;
    if (basedOn !== null) this.requireRevisionForCommand(basedOn, command.command_id);
    return this.insertDraft({
      command_id: command.command_id,
      owner: command.owner,
      based_on_revision_id: basedOn,
      created_by_principal_id: input.created_by_principal_id,
      definition: input.definition,
    });
  }

  replaceDraft(input: Readonly<{
    command_definition_revision_id: string;
    expected_digest: string;
    definition: CommandDefinitionContent;
  }>): CommandDefinitionRevision {
    validateCommandDefinition(input.definition);
    const revision = this.requireRevision(input.command_definition_revision_id);
    if (revision.published_at || revision.withdrawn_at) {
      throw new CommandDefinitionImmutableError(revision.command_definition_revision_id);
    }
    if (revision.semantic_digest !== input.expected_digest) {
      throw new CommandDefinitionDraftConflictError(
        revision.command_definition_revision_id,
        input.expected_digest,
        revision.semantic_digest,
      );
    }
    this.db.prepare(`
      UPDATE command_definition_revisions
      SET semantic_digest = ?, content_json = ?
      WHERE command_definition_revision_id = ? AND published_at IS NULL AND withdrawn_at IS NULL
    `).run(
      commandDefinitionDigest(input.definition),
      JSON.stringify(input.definition),
      revision.command_definition_revision_id,
    );
    return this.requireRevision(revision.command_definition_revision_id);
  }

  publishDraft(input: Readonly<{
    command_definition_revision_id: string;
    expected_current_revision_id: string | null;
    changed_by_principal_id: string;
  }>): CommandDefinitionRevision {
    const revision = this.requireRevision(input.command_definition_revision_id);
    if (revision.withdrawn_at) throw new CommandDefinitionImmutableError(revision.command_definition_revision_id);
    if (revision.published_at) {
      if (this.requireCommand(revision.command_id).current_revision_id === revision.command_definition_revision_id) {
        return revision;
      }
      throw new CommandDefinitionImmutableError(revision.command_definition_revision_id);
    }
    transaction(this.db, () => this.moveHead({
      revision,
      expected_current_revision_id: input.expected_current_revision_id,
      changed_by_principal_id: input.changed_by_principal_id,
      reason: "publish",
      publish_at: this.now(),
    }));
    return this.requireRevision(revision.command_definition_revision_id);
  }

  rollback(input: Readonly<{
    command_id: string;
    to_published_revision_id: string;
    expected_current_revision_id: string;
    changed_by_principal_id: string;
  }>): CommandDefinitionRevision {
    const command = this.requireCommand(input.command_id);
    const revision = this.requireRevisionForCommand(input.to_published_revision_id, command.command_id);
    if (!revision.published_at || revision.withdrawn_at) {
      throw invalid("rollback target must be a retained published Command definition");
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

  withdrawDraft(commandDefinitionRevisionId: string): CommandDefinitionRevision {
    const revision = this.requireRevision(commandDefinitionRevisionId);
    if (revision.published_at) throw new CommandDefinitionImmutableError(commandDefinitionRevisionId);
    if (!revision.withdrawn_at) {
      this.db.prepare(`
        UPDATE command_definition_revisions SET withdrawn_at = ?
        WHERE command_definition_revision_id = ? AND published_at IS NULL
      `).run(this.now(), commandDefinitionRevisionId);
    }
    return this.requireRevision(commandDefinitionRevisionId);
  }

  setCommandStatus(input: Readonly<{
    command_id: string;
    status: "active" | "retired";
    expected_current_revision_id: string | null;
  }>): CommandRecord {
    const command = this.requireCommand(input.command_id);
    if (command.current_revision_id !== input.expected_current_revision_id) {
      throw new CommandDefinitionConflictError(
        command.command_id,
        input.expected_current_revision_id,
        command.current_revision_id,
      );
    }
    const at = this.now();
    this.db.prepare(`
      UPDATE commands SET status = ?, retired_at = ?, updated_at = ? WHERE command_id = ?
    `).run(input.status, input.status === "retired" ? at : null, at, command.command_id);
    return this.requireCommand(command.command_id);
  }

  getCommand(commandId: string): CommandRecord | null {
    const row = this.db.prepare(`SELECT * FROM commands WHERE command_id = ?`).get(commandId) as any;
    return row ? rowToCommand(row) : null;
  }

  requireCommand(commandId: string): CommandRecord {
    const command = this.getCommand(commandId);
    if (!command) throw new CommandNotFoundError(commandId);
    return command;
  }

  listCommands(owner: CommandOwner, options: Readonly<{ include_retired?: boolean }> = {}): CommandRecord[] {
    validateOwner(owner);
    const rows = options.include_retired
      ? this.db.prepare(`
          SELECT * FROM commands WHERE owner_kind = ? AND owner_id = ? ORDER BY created_at, command_id
        `).all(owner.kind, owner.id)
      : this.db.prepare(`
          SELECT * FROM commands
          WHERE owner_kind = ? AND owner_id = ? AND status = 'active'
          ORDER BY created_at, command_id
        `).all(owner.kind, owner.id);
    return (rows as any[]).map(rowToCommand);
  }

  getRevision(revisionId: string): CommandDefinitionRevision | null {
    const row = this.db.prepare(`
      SELECT * FROM command_definition_revisions WHERE command_definition_revision_id = ?
    `).get(revisionId) as any;
    return row ? rowToRevision(row) : null;
  }

  requireRevision(revisionId: string): CommandDefinitionRevision {
    const revision = this.getRevision(revisionId);
    if (!revision) throw new CommandDefinitionRevisionNotFoundError(revisionId);
    return revision;
  }

  getCurrentDefinition(commandId: string): CommandDefinitionRevision | null {
    const command = this.requireCommand(commandId);
    return command.current_revision_id ? this.requireRevision(command.current_revision_id) : null;
  }

  listRevisions(commandId: string): CommandDefinitionRevision[] {
    this.requireCommand(commandId);
    return (this.db.prepare(`
      SELECT * FROM command_definition_revisions
      WHERE command_id = ? ORDER BY revision_number DESC
    `).all(commandId) as any[]).map(rowToRevision);
  }

  listHeadChanges(commandId: string): CommandDefinitionHeadChange[] {
    this.requireCommand(commandId);
    return (this.db.prepare(`
      SELECT * FROM command_definition_head_changes
      WHERE command_id = ? ORDER BY rowid
    `).all(commandId) as any[]).map(rowToHeadChange);
  }

  private insertDraft(input: Readonly<{
    command_id: string;
    owner: CommandOwner;
    based_on_revision_id: string | null;
    created_by_principal_id: string;
    definition: CommandDefinitionContent;
  }>): CommandDefinitionRevision {
    nonEmpty("created_by_principal_id", input.created_by_principal_id);
    validateCommandDefinition(input.definition);
    const revisionId = `command_definition_${randomUUID()}`;
    const revisionNumber = Number((this.db.prepare(`
      SELECT COALESCE(MAX(revision_number), 0) + 1 AS next
      FROM command_definition_revisions WHERE command_id = ?
    `).get(input.command_id) as { next: number }).next);
    this.db.prepare(`
      INSERT INTO command_definition_revisions (
        command_definition_revision_id, command_id, owner_kind, owner_id,
        revision_number, based_on_revision_id, semantic_digest, content_json,
        created_by_principal_id, created_at, published_at, withdrawn_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
      revisionId,
      input.command_id,
      input.owner.kind,
      input.owner.id,
      revisionNumber,
      input.based_on_revision_id,
      commandDefinitionDigest(input.definition),
      JSON.stringify(input.definition),
      input.created_by_principal_id,
      this.now(),
    );
    return this.requireRevision(revisionId);
  }

  private requireRevisionForCommand(revisionId: string, commandId: string): CommandDefinitionRevision {
    const revision = this.requireRevision(revisionId);
    if (revision.command_id !== commandId) throw invalid(`definition '${revisionId}' belongs to another Command`);
    return revision;
  }

  private moveHead(input: Readonly<{
    revision: CommandDefinitionRevision;
    expected_current_revision_id: string | null;
    changed_by_principal_id: string;
    reason: "publish" | "rollback";
    publish_at: string | null;
  }>): void {
    nonEmpty("changed_by_principal_id", input.changed_by_principal_id);
    const command = this.requireCommand(input.revision.command_id);
    if (command.status === "retired") throw invalid(`retired Command '${command.command_id}' cannot change its current definition`);
    if (!sameOwner(command.owner, input.revision.owner)) throw invalid("Command definition owner does not match its Command");
    if (command.current_revision_id !== input.expected_current_revision_id) {
      throw new CommandDefinitionConflictError(
        command.command_id,
        input.expected_current_revision_id,
        command.current_revision_id,
      );
    }
    const at = input.publish_at ?? this.now();
    if (input.publish_at) {
      this.db.prepare(`
        UPDATE command_definition_revisions SET published_at = ?
        WHERE command_definition_revision_id = ? AND published_at IS NULL AND withdrawn_at IS NULL
      `).run(input.publish_at, input.revision.command_definition_revision_id);
    }
    this.db.prepare(`
      UPDATE commands SET current_revision_id = ?, updated_at = ? WHERE command_id = ?
    `).run(input.revision.command_definition_revision_id, at, command.command_id);
    this.db.prepare(`
      INSERT INTO command_definition_head_changes (
        head_change_id, command_id, owner_kind, owner_id, from_revision_id,
        to_revision_id, reason, changed_by_principal_id, changed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `command_head_change_${randomUUID()}`,
      command.command_id,
      command.owner.kind,
      command.owner.id,
      command.current_revision_id,
      input.revision.command_definition_revision_id,
      input.reason,
      input.changed_by_principal_id,
      at,
    );
  }
}

function rowToCommand(row: any): CommandRecord {
  return {
    command_id: String(row.command_id),
    owner: { kind: String(row.owner_kind) as CommandOwner["kind"], id: String(row.owner_id) },
    status: String(row.status) as CommandRecord["status"],
    current_revision_id: row.current_revision_id == null ? null : String(row.current_revision_id),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    retired_at: row.retired_at == null ? null : String(row.retired_at),
  };
}

function rowToRevision(row: any): CommandDefinitionRevision {
  const content = JSON.parse(String(row.content_json)) as CommandDefinitionContent;
  validateCommandDefinition(content);
  return {
    command_definition_revision_id: String(row.command_definition_revision_id),
    command_id: String(row.command_id),
    owner: { kind: String(row.owner_kind) as CommandOwner["kind"], id: String(row.owner_id) },
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

function rowToHeadChange(row: any): CommandDefinitionHeadChange {
  return {
    head_change_id: String(row.head_change_id),
    command_id: String(row.command_id),
    owner: { kind: String(row.owner_kind) as CommandOwner["kind"], id: String(row.owner_id) },
    from_revision_id: row.from_revision_id == null ? null : String(row.from_revision_id),
    to_revision_id: String(row.to_revision_id),
    reason: String(row.reason) as CommandDefinitionHeadChange["reason"],
    changed_by_principal_id: String(row.changed_by_principal_id),
    changed_at: String(row.changed_at),
  };
}

function validateVersionedSchema(value: VersionedOperationSchema, label: string): void {
  nonEmpty(`${label} schema version`, value.version);
  if (!isPlainObject(value.schema)) throw invalid(`${label} schema must be a JSON object`);
}

function validateExactRef(ref: OperationResourceRef, label: string): void {
  nonEmpty(`${label} kind`, ref.kind);
  nonEmpty(`${label} id`, ref.id);
  if (ref.revision == null) throw invalid(`${label} must pin an exact revision`);
  nonEmpty(`${label} revision`, ref.revision);
}

function validateOwner(owner: CommandOwner): void {
  if (!["workspace", "host", "extension_package_version"].includes(owner.kind)) {
    throw invalid(`unsupported Command owner '${owner.kind}'`);
  }
  nonEmpty("Command owner id", owner.id);
}

function sameOwner(left: CommandOwner, right: CommandOwner): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function unique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    nonEmpty(label, value);
    if (seen.has(value)) throw invalid(`duplicate ${label} '${value}'`);
    seen.add(value);
  }
}

function nonEmpty(label: string, value: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw invalid(`${label} must be non-empty text without control characters`);
  }
}

function invalid(reason: string): CommandDefinitionValidationError {
  return new CommandDefinitionValidationError(reason);
}

function isPlainObject(value: unknown): value is JsonSchema {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
  const savepoint = `command_definition_change_${randomUUID().replaceAll("-", "")}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = action();
    db.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO ${savepoint}`);
    db.exec(`RELEASE ${savepoint}`);
    throw error;
  }
}
