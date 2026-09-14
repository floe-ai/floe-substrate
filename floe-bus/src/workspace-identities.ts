import { createHash, randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type WorkspaceLocatorPlatform = "windows" | "posix";
export type WorkspaceCreationKind = "created" | "legacy_retained" | "copied" | "forked";
export type WorkspaceBindingState = "current" | "superseded";

export type WorkspaceIdentityRecord = Readonly<{
  workspace_id: string;
  name: string;
  creation_kind: WorkspaceCreationKind;
  source_workspace_id: string | null;
  created_at: string;
  updated_at: string;
}>;

export type WorkspaceLocatorBindingRecord = Readonly<{
  binding_id: string;
  workspace_id: string;
  host_id: string;
  platform: WorkspaceLocatorPlatform;
  locator: string;
  normalized_locator: string;
  state: WorkspaceBindingState;
  status: string;
  init_authorized: boolean;
  active_config_hash: string | null;
  selected_at: string | null;
  bound_at: string;
  updated_at: string;
  superseded_at: string | null;
  superseded_by_binding_id: string | null;
}>;

/**
 * The projection used by a local bridge or trusted local settings surface.
 * Host paths deliberately exist only in this local projection.
 */
export type LocalWorkspaceProjection = WorkspaceIdentityRecord & Readonly<{
  binding: WorkspaceLocatorBindingRecord | null;
}>;

/**
 * Safe for remote clients. Availability is useful product state, but neither
 * the host identity nor any current or historical locator crosses this seam.
 */
export type RemoteWorkspaceProjection = WorkspaceIdentityRecord & Readonly<{
  availability: Readonly<{
    bound_on_serving_host: boolean;
    status: string | null;
  }>;
}>;

export type WorkspaceIdentitySnapshot = WorkspaceIdentityRecord;

export type WorkspaceBindingInput = Readonly<{
  host_id: string;
  platform: WorkspaceLocatorPlatform;
  locator: string;
  init_authorized?: boolean;
}>;

export type WorkspaceIdentityStoreDependencies = Readonly<{
  now?: () => string;
  workspace_id_factory?: () => string;
  binding_id_factory?: () => string;
}>;

export type LocalHostIdentityRecord = Readonly<{
  host_id: string;
  created_at: string;
}>;

type WorkspaceIdentityRow = {
  workspace_id: string;
  name: string;
  creation_kind: string;
  source_workspace_id: string | null;
  created_at: string;
  updated_at: string;
};

type WorkspaceBindingRow = {
  binding_id: string;
  workspace_id: string;
  host_id: string;
  platform: string;
  locator: string;
  normalized_locator: string;
  state: string;
  status: string;
  init_authorized: number;
  active_config_hash: string | null;
  selected_at: string | null;
  bound_at: string;
  updated_at: string;
  superseded_at: string | null;
  superseded_by_binding_id: string | null;
};

type LegacyWorkspaceRow = {
  workspace_id: string;
  name: string;
  locator: string;
  status: string;
  init_authorized: number;
  active_config_hash: string | null;
  selected_at: string | null;
  created_at: string;
  updated_at: string;
};

export class WorkspaceIdentityNotFoundError extends Error {
  readonly code = "E_WORKSPACE_IDENTITY_NOT_FOUND" as const;

  constructor(readonly workspace_id: string) {
    super(`Workspace identity not found: ${workspace_id}`);
    this.name = "WorkspaceIdentityNotFoundError";
  }
}

export class WorkspaceIdentityConflictError extends Error {
  readonly code = "E_WORKSPACE_IDENTITY_CONFLICT" as const;

  constructor(readonly workspace_id: string, readonly reason: string) {
    super(`Workspace identity '${workspace_id}' conflicts with retained state: ${reason}`);
    this.name = "WorkspaceIdentityConflictError";
  }
}

export class WorkspaceLocatorInvalidError extends Error {
  readonly code = "E_WORKSPACE_LOCATOR_INVALID" as const;

  constructor(readonly platform: WorkspaceLocatorPlatform, readonly reason: string) {
    super(`Invalid ${platform} Workspace locator: ${reason}`);
    this.name = "WorkspaceLocatorInvalidError";
  }
}

export class WorkspaceLocatorConflictError extends Error {
  readonly code = "E_WORKSPACE_LOCATOR_CONFLICT" as const;

  constructor(
    readonly workspace_id: string,
    readonly conflicting_workspace_id: string,
    readonly host_id: string,
  ) {
    super(`The requested local Workspace location is already bound to Workspace '${conflicting_workspace_id}'.`);
    this.name = "WorkspaceLocatorConflictError";
  }
}

export class WorkspaceExplicitRebindRequiredError extends Error {
  readonly code = "E_WORKSPACE_EXPLICIT_REBIND_REQUIRED" as const;

  constructor(readonly workspace_id: string, readonly host_id: string, readonly current_binding_id: string) {
    super(`Workspace '${workspace_id}' already has a location on this host. Use the explicit rebind operation to move it.`);
    this.name = "WorkspaceExplicitRebindRequiredError";
  }
}

export class WorkspaceBindingNotFoundError extends Error {
  readonly code = "E_WORKSPACE_BINDING_NOT_FOUND" as const;

  constructor(readonly workspace_id: string, readonly host_id: string) {
    super(`Workspace '${workspace_id}' has no current location on this host.`);
    this.name = "WorkspaceBindingNotFoundError";
  }
}

export class WorkspaceBindingChangedError extends Error {
  readonly code = "E_WORKSPACE_BINDING_CHANGED" as const;

  constructor(
    readonly workspace_id: string,
    readonly expected_binding_id: string,
    readonly actual_binding_id: string,
  ) {
    super(`Workspace '${workspace_id}' location changed before the requested rebind could be applied.`);
    this.name = "WorkspaceBindingChangedError";
  }
}

export type WorkspaceMigrationRefusalCode =
  | "unsupported_workspace_schema"
  | "partial_identity_schema"
  | "invalid_legacy_locator"
  | "normalized_locator_conflict";

export type WorkspaceMigrationRefusal = Readonly<{
  code: WorkspaceMigrationRefusalCode;
  message: string;
  workspace_ids: readonly string[];
}>;

export type LegacyWorkspaceMigrationAction = Readonly<{
  workspace: LegacyWorkspaceRow;
  binding_id: string;
  normalized_locator: string;
}>;

export type WorkspaceIdentityMigrationPlan = Readonly<{
  plan_version: 1;
  kind: "bootstrap" | "migrate_legacy" | "ensure_bindings" | "already_current" | "blocked";
  host_id: string;
  platform: WorkspaceLocatorPlatform;
  source_fingerprint: string;
  actions: readonly LegacyWorkspaceMigrationAction[];
  refusals: readonly WorkspaceMigrationRefusal[];
}>;

export type WorkspaceIdentityMigrationResult = Readonly<{
  changed: boolean;
  migrated_workspace_ids: readonly string[];
}>;

export class WorkspaceIdentityMigrationRefusedError extends Error {
  readonly code = "E_WORKSPACE_IDENTITY_MIGRATION_REFUSED" as const;

  constructor(readonly refusals: readonly WorkspaceMigrationRefusal[]) {
    super(`Workspace identity migration was refused: ${refusals.map((item) => item.message).join("; ")}`);
    this.name = "WorkspaceIdentityMigrationRefusedError";
  }
}

export class WorkspaceIdentityMigrationPlanStaleError extends Error {
  readonly code = "E_WORKSPACE_IDENTITY_MIGRATION_PLAN_STALE" as const;

  constructor() {
    super("Workspace identity migration state changed after it was inspected. Create a new migration plan.");
    this.name = "WorkspaceIdentityMigrationPlanStaleError";
  }
}

/**
 * Returns this Bus installation's opaque local host identity. It is stored in
 * local database state, not derived from a computer name, account, or path.
 */
export function getOrCreateLocalHostIdentity(
  db: DatabaseSync,
  dependencies: Readonly<{ host_id_factory?: () => string; now?: () => string }> = {},
): LocalHostIdentityRecord {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_host_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      host_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
  `);
  const existing = db.prepare(`
    SELECT host_id, created_at FROM local_host_identity WHERE singleton = 1
  `).get() as LocalHostIdentityRecord | undefined;
  if (existing) return existing;

  const hostId = (dependencies.host_id_factory ?? (() => `host_${randomUUID()}`))();
  assertNonEmpty("host_id", hostId);
  const createdAt = (dependencies.now ?? (() => new Date().toISOString()))();
  assertTimestamp("created_at", createdAt);
  db.prepare(`
    INSERT INTO local_host_identity (singleton, host_id, created_at) VALUES (1, ?, ?)
  `).run(hostId, createdAt);
  return { host_id: hostId, created_at: createdAt };
}

/**
 * Normalises for comparison on the host which owns the locator. It never
 * resolves through the process cwd and never touches the filesystem.
 */
export function normalizeWorkspaceLocator(locator: string, platform: WorkspaceLocatorPlatform): string {
  const value = locator.trim();
  if (!value) throw new WorkspaceLocatorInvalidError(platform, "the location is empty");

  if (platform === "windows") {
    if (!win32.isAbsolute(value)) {
      throw new WorkspaceLocatorInvalidError(platform, "an absolute path is required");
    }
    return trimNonRootTrailingSeparators(win32.normalize(value), "windows").toLowerCase();
  }

  if (!posix.isAbsolute(value)) {
    throw new WorkspaceLocatorInvalidError(platform, "an absolute path is required");
  }
  return trimNonRootTrailingSeparators(posix.normalize(value), "posix");
}

/** Creates the destination schema only when no legacy migration is required. */
export function applyWorkspaceIdentitySchema(db: DatabaseSync): void {
  const columns = workspaceColumns(db);
  if (columns.includes("locator")) {
    throw new WorkspaceIdentityMigrationRefusedError([{
      code: "partial_identity_schema",
      message: "The legacy Workspace table still owns local paths; plan and apply its identity migration first.",
      workspace_ids: [],
    }]);
  }
  ensureCanonicalWorkspaceSchema(db);
  ensureWorkspaceBindingSchema(db);
}

/**
 * Inspects the old locator-derived Workspace table without changing it. The
 * plan is explicit so backup/approval policy can run before schema mutation.
 */
export function planWorkspaceIdentityMigration(
  db: DatabaseSync,
  input: Readonly<{ host_id: string; platform: WorkspaceLocatorPlatform }>,
): WorkspaceIdentityMigrationPlan {
  assertNonEmpty("host_id", input.host_id);
  const columns = workspaceColumns(db);
  const bindingTableExists = tableExists(db, "workspace_locator_bindings");

  if (columns.length === 0) {
    return migrationPlan("bootstrap", input, fingerprint({ columns }), [], []);
  }

  if (!columns.includes("locator")) {
    const canonical = canonicalWorkspaceColumns.every((column) => columns.includes(column));
    if (!canonical) {
      return migrationPlan("blocked", input, fingerprint({ columns }), [], [{
        code: "unsupported_workspace_schema",
        message: "The Workspace table is neither the supported legacy schema nor the canonical identity schema.",
        workspace_ids: [],
      }]);
    }
    return migrationPlan(
      bindingTableExists ? "already_current" : "ensure_bindings",
      input,
      fingerprint({ columns, bindingTableExists }),
      [],
      [],
    );
  }

  const requiredLegacy = [
    "workspace_id", "name", "locator", "status", "init_authorized",
    "active_config_hash", "selected_at", "created_at", "updated_at",
  ];
  if (!requiredLegacy.every((column) => columns.includes(column))) {
    return migrationPlan("blocked", input, fingerprint({ columns }), [], [{
      code: "unsupported_workspace_schema",
      message: "The legacy Workspace table does not contain every field needed for a lossless migration.",
      workspace_ids: [],
    }]);
  }
  if (bindingTableExists) {
    return migrationPlan("blocked", input, fingerprint({ columns, bindingTableExists }), [], [{
      code: "partial_identity_schema",
      message: "Legacy Workspace paths and canonical locator bindings coexist. Automatic migration will not choose a source of truth.",
      workspace_ids: [],
    }]);
  }

  const rows = db.prepare(`
    SELECT workspace_id, name, locator, status, init_authorized, active_config_hash,
           selected_at, created_at, updated_at
    FROM workspaces
    ORDER BY workspace_id
  `).all() as LegacyWorkspaceRow[];
  const actions: LegacyWorkspaceMigrationAction[] = [];
  const refusals: WorkspaceMigrationRefusal[] = [];
  const ownersByLocator = new Map<string, string[]>();

  for (const workspace of rows) {
    try {
      const normalizedLocator = normalizeWorkspaceLocator(workspace.locator, input.platform);
      actions.push({
        workspace,
        binding_id: migratedBindingId(input.host_id, workspace.workspace_id, normalizedLocator),
        normalized_locator: normalizedLocator,
      });
      const owners = ownersByLocator.get(normalizedLocator) ?? [];
      owners.push(workspace.workspace_id);
      ownersByLocator.set(normalizedLocator, owners);
    } catch (error) {
      refusals.push({
        code: "invalid_legacy_locator",
        message: error instanceof Error ? error.message : "A legacy Workspace locator is invalid.",
        workspace_ids: [workspace.workspace_id],
      });
    }
  }

  for (const owners of ownersByLocator.values()) {
    if (owners.length < 2) continue;
    refusals.push({
      code: "normalized_locator_conflict",
      message: `Legacy Workspace rows ${owners.join(", ")} resolve to the same location on this host.`,
      workspace_ids: owners,
    });
  }

  const sourceFingerprint = fingerprint({ columns, rows, host_id: input.host_id, platform: input.platform });
  return migrationPlan(
    refusals.length > 0 ? "blocked" : "migrate_legacy",
    input,
    sourceFingerprint,
    actions,
    refusals,
  );
}

/** Applies exactly the inspected plan. Re-running against canonical state is a no-op. */
export function applyWorkspaceIdentityMigration(
  db: DatabaseSync,
  plan: WorkspaceIdentityMigrationPlan,
): WorkspaceIdentityMigrationResult {
  if (plan.refusals.length > 0 || plan.kind === "blocked") {
    throw new WorkspaceIdentityMigrationRefusedError(plan.refusals);
  }

  return inSavepoint(db, () => {
    const current = planWorkspaceIdentityMigration(db, {
      host_id: plan.host_id,
      platform: plan.platform,
    });
    if (current.source_fingerprint !== plan.source_fingerprint || current.kind !== plan.kind) {
      throw new WorkspaceIdentityMigrationPlanStaleError();
    }

    if (plan.kind === "already_current") {
      return { changed: false, migrated_workspace_ids: [] };
    }
    if (plan.kind === "bootstrap" || plan.kind === "ensure_bindings") {
      ensureCanonicalWorkspaceSchema(db);
      ensureWorkspaceBindingSchema(db);
      return { changed: true, migrated_workspace_ids: [] };
    }

    migrateLegacyWorkspaceTable(db, plan.actions, plan.host_id, plan.platform);
    return {
      changed: true,
      migrated_workspace_ids: plan.actions.map((action) => action.workspace.workspace_id),
    };
  });
}

export class SqliteWorkspaceIdentityStore {
  private readonly now: () => string;
  private readonly workspaceIdFactory: () => string;
  private readonly bindingIdFactory: () => string;

  constructor(readonly db: DatabaseSync, dependencies: WorkspaceIdentityStoreDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.workspaceIdFactory = dependencies.workspace_id_factory ?? (() => `workspace_${randomUUID()}`);
    this.bindingIdFactory = dependencies.binding_id_factory ?? (() => `wbind_${randomUUID()}`);
  }

  createWorkspace(input: Readonly<{ name: string; binding?: WorkspaceBindingInput }>): WorkspaceIdentityRecord {
    const workspaceId = this.workspaceIdFactory();
    assertNonEmpty("workspace_id", workspaceId);
    const timestamp = this.now();
    const identity: WorkspaceIdentityRecord = {
      workspace_id: workspaceId,
      name: normalizedName(input.name),
      creation_kind: "created",
      source_workspace_id: null,
      created_at: timestamp,
      updated_at: timestamp,
    };

    return inSavepoint(this.db, () => {
      this.insertIdentity(identity);
      if (input.binding) this.insertBinding(identity.workspace_id, input.binding, "registered", null);
      return identity;
    });
  }

  createDerivedWorkspace(input: Readonly<{
    source_workspace_id: string;
    kind: "copied" | "forked";
    name: string;
    binding?: WorkspaceBindingInput;
  }>): WorkspaceIdentityRecord {
    this.requireIdentity(input.source_workspace_id);
    const workspaceId = this.workspaceIdFactory();
    assertNonEmpty("workspace_id", workspaceId);
    const timestamp = this.now();
    const identity: WorkspaceIdentityRecord = {
      workspace_id: workspaceId,
      name: normalizedName(input.name),
      creation_kind: input.kind,
      source_workspace_id: input.source_workspace_id,
      created_at: timestamp,
      updated_at: timestamp,
    };

    return inSavepoint(this.db, () => {
      this.insertIdentity(identity);
      if (input.binding) this.insertBinding(identity.workspace_id, input.binding, "registered", null);
      return identity;
    });
  }

  /** Restoring retains the exported identity; it never silently becomes a copy. */
  restoreWorkspace(input: Readonly<{
    snapshot: WorkspaceIdentitySnapshot;
    binding?: WorkspaceBindingInput;
  }>): WorkspaceIdentityRecord {
    validateIdentitySnapshot(input.snapshot);
    return inSavepoint(this.db, () => {
      const existing = this.getIdentity(input.snapshot.workspace_id);
      if (existing) {
        assertSameRetainedIdentity(existing, input.snapshot);
      } else {
        this.insertIdentity(input.snapshot);
      }
      if (input.binding) this.bindLocator(input.snapshot.workspace_id, input.binding);
      return this.requireIdentity(input.snapshot.workspace_id);
    });
  }

  bindLocator(workspaceId: string, input: WorkspaceBindingInput): WorkspaceLocatorBindingRecord {
    this.requireIdentity(workspaceId);
    assertNonEmpty("host_id", input.host_id);
    const normalizedLocator = normalizeWorkspaceLocator(input.locator, input.platform);
    const current = this.getCurrentBinding(workspaceId, input.host_id);
    if (current) {
      if (current.normalized_locator === normalizedLocator && current.platform === input.platform) return current;
      throw new WorkspaceExplicitRebindRequiredError(workspaceId, input.host_id, current.binding_id);
    }
    this.assertLocatorAvailable(workspaceId, input.host_id, normalizedLocator);
    return this.insertBinding(workspaceId, input, "registered", null);
  }

  rebindLocator(input: Readonly<{
    workspace_id: string;
    host_id: string;
    platform: WorkspaceLocatorPlatform;
    locator: string;
    expected_binding_id: string;
    init_authorized?: boolean;
  }>): WorkspaceLocatorBindingRecord {
    const normalizedLocator = normalizeWorkspaceLocator(input.locator, input.platform);
    return inSavepoint(this.db, () => {
      const current = this.getCurrentBinding(input.workspace_id, input.host_id);
      if (!current) throw new WorkspaceBindingNotFoundError(input.workspace_id, input.host_id);
      if (current.binding_id !== input.expected_binding_id) {
        throw new WorkspaceBindingChangedError(input.workspace_id, input.expected_binding_id, current.binding_id);
      }
      if (current.platform === input.platform && current.normalized_locator === normalizedLocator) return current;

      this.assertLocatorAvailable(input.workspace_id, input.host_id, normalizedLocator);
      const timestamp = this.now();
      const replacementId = this.bindingIdFactory();
      assertNonEmpty("binding_id", replacementId);
      this.db.prepare(`
        UPDATE workspace_locator_bindings
        SET state = 'superseded', superseded_at = ?, superseded_by_binding_id = ?, updated_at = ?
        WHERE binding_id = ? AND state = 'current'
      `).run(timestamp, replacementId, timestamp, current.binding_id);
      this.insertBinding(input.workspace_id, input, "registered", replacementId, current.selected_at);
      return this.requireBinding(replacementId);
    });
  }

  /**
   * Records local attachment state only when it still describes the current
   * binding. A late callback from a superseded path cannot mutate the new one.
   */
  updateCurrentBinding(input: Readonly<{
    workspace_id: string;
    host_id: string;
    expected_binding_id: string;
    status?: string;
    init_authorized?: boolean;
    active_config_hash?: string | null;
    selected_at?: string | null;
  }>): WorkspaceLocatorBindingRecord {
    return inSavepoint(this.db, () => {
      const current = this.getCurrentBinding(input.workspace_id, input.host_id);
      if (!current) throw new WorkspaceBindingNotFoundError(input.workspace_id, input.host_id);
      if (current.binding_id !== input.expected_binding_id) {
        throw new WorkspaceBindingChangedError(
          input.workspace_id,
          input.expected_binding_id,
          current.binding_id,
        );
      }
      const updatedAt = this.now();
      this.db.prepare(`
        UPDATE workspace_locator_bindings
        SET status = ?, init_authorized = ?, active_config_hash = ?, selected_at = ?, updated_at = ?
        WHERE binding_id = ? AND state = 'current'
      `).run(
        input.status ?? current.status,
        input.init_authorized === undefined ? (current.init_authorized ? 1 : 0) : (input.init_authorized ? 1 : 0),
        input.active_config_hash === undefined ? current.active_config_hash : input.active_config_hash,
        input.selected_at === undefined ? current.selected_at : input.selected_at,
        updatedAt,
        current.binding_id,
      );
      return this.requireBinding(current.binding_id);
    });
  }

  updateWorkspaceName(workspaceId: string, name: string): WorkspaceIdentityRecord {
    this.requireIdentity(workspaceId);
    this.db.prepare(`UPDATE workspaces SET name = ?, updated_at = ? WHERE workspace_id = ?`)
      .run(normalizedName(name), this.now(), workspaceId);
    return this.requireIdentity(workspaceId);
  }

  selectLocalWorkspace(workspaceId: string, hostId: string): WorkspaceLocatorBindingRecord {
    return inSavepoint(this.db, () => {
      const binding = this.getCurrentBinding(workspaceId, hostId);
      if (!binding) throw new WorkspaceBindingNotFoundError(workspaceId, hostId);
      const timestamp = this.now();
      this.db.prepare(`
        UPDATE workspace_locator_bindings
        SET selected_at = NULL, updated_at = ?
        WHERE host_id = ? AND state = 'current' AND selected_at IS NOT NULL
      `).run(timestamp, hostId);
      this.db.prepare(`
        UPDATE workspace_locator_bindings SET selected_at = ?, updated_at = ?
        WHERE binding_id = ? AND state = 'current'
      `).run(timestamp, timestamp, binding.binding_id);
      return this.requireBinding(binding.binding_id);
    });
  }

  getIdentity(workspaceId: string): WorkspaceIdentityRecord | null {
    const row = this.db.prepare(`
      SELECT workspace_id, name, creation_kind, source_workspace_id, created_at, updated_at
      FROM workspaces
      WHERE workspace_id = ?
    `).get(workspaceId) as WorkspaceIdentityRow | undefined;
    return row ? identityFromRow(row) : null;
  }

  getLocalProjection(workspaceId: string, hostId: string): LocalWorkspaceProjection | null {
    const identity = this.getIdentity(workspaceId);
    if (!identity) return null;
    return { ...identity, binding: this.getCurrentBinding(workspaceId, hostId) };
  }

  listLocalProjections(hostId: string): LocalWorkspaceProjection[] {
    return this.listIdentities().map((identity) => ({
      ...identity,
      binding: this.getCurrentBinding(identity.workspace_id, hostId),
    }));
  }

  getRemoteProjection(workspaceId: string, servingHostId: string): RemoteWorkspaceProjection | null {
    const identity = this.getIdentity(workspaceId);
    if (!identity) return null;
    return remoteProjection(identity, this.getCurrentBinding(workspaceId, servingHostId));
  }

  listRemoteProjections(servingHostId: string): RemoteWorkspaceProjection[] {
    return this.listIdentities().map((identity) =>
      remoteProjection(identity, this.getCurrentBinding(identity.workspace_id, servingHostId)));
  }

  resolveWorkspaceByLocator(
    hostId: string,
    platform: WorkspaceLocatorPlatform,
    locator: string,
  ): WorkspaceIdentityRecord | null {
    const normalizedLocator = normalizeWorkspaceLocator(locator, platform);
    const row = this.db.prepare(`
      SELECT w.workspace_id, w.name, w.creation_kind, w.source_workspace_id, w.created_at, w.updated_at
      FROM workspace_locator_bindings b
      JOIN workspaces w ON w.workspace_id = b.workspace_id
      WHERE b.host_id = ? AND b.normalized_locator = ? AND b.state = 'current'
    `).get(hostId, normalizedLocator) as WorkspaceIdentityRow | undefined;
    return row ? identityFromRow(row) : null;
  }

  getCurrentBinding(workspaceId: string, hostId: string): WorkspaceLocatorBindingRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM workspace_locator_bindings
      WHERE workspace_id = ? AND host_id = ? AND state = 'current'
    `).get(workspaceId, hostId) as WorkspaceBindingRow | undefined;
    return row ? bindingFromRow(row) : null;
  }

  listBindingHistory(workspaceId: string, hostId: string): WorkspaceLocatorBindingRecord[] {
    return (this.db.prepare(`
      SELECT *
      FROM workspace_locator_bindings
      WHERE workspace_id = ? AND host_id = ?
      ORDER BY bound_at, binding_id
    `).all(workspaceId, hostId) as WorkspaceBindingRow[]).map(bindingFromRow);
  }

  private listIdentities(): WorkspaceIdentityRecord[] {
    return (this.db.prepare(`
      SELECT workspace_id, name, creation_kind, source_workspace_id, created_at, updated_at
      FROM workspaces
      ORDER BY created_at DESC, workspace_id
    `).all() as WorkspaceIdentityRow[]).map(identityFromRow);
  }

  private requireIdentity(workspaceId: string): WorkspaceIdentityRecord {
    const identity = this.getIdentity(workspaceId);
    if (!identity) throw new WorkspaceIdentityNotFoundError(workspaceId);
    return identity;
  }

  private insertIdentity(identity: WorkspaceIdentityRecord): void {
    try {
      this.db.prepare(`
        INSERT INTO workspaces (
          workspace_id, name, creation_kind, source_workspace_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        identity.workspace_id,
        identity.name,
        identity.creation_kind,
        identity.source_workspace_id,
        identity.created_at,
        identity.updated_at,
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new WorkspaceIdentityConflictError(identity.workspace_id, "that opaque identity already exists");
      }
      throw error;
    }
  }

  private insertBinding(
    workspaceId: string,
    input: WorkspaceBindingInput,
    status: string,
    prescribedBindingId: string | null,
    selectedAt: string | null = null,
  ): WorkspaceLocatorBindingRecord {
    assertNonEmpty("host_id", input.host_id);
    const normalizedLocator = normalizeWorkspaceLocator(input.locator, input.platform);
    this.assertLocatorAvailable(workspaceId, input.host_id, normalizedLocator);
    const bindingId = prescribedBindingId ?? this.bindingIdFactory();
    assertNonEmpty("binding_id", bindingId);
    const timestamp = this.now();
    try {
      this.db.prepare(`
        INSERT INTO workspace_locator_bindings (
          binding_id, workspace_id, host_id, platform, locator, normalized_locator,
          state, status, init_authorized, active_config_hash, selected_at,
          bound_at, updated_at, superseded_at, superseded_by_binding_id
        ) VALUES (?, ?, ?, ?, ?, ?, 'current', ?, ?, NULL, ?, ?, ?, NULL, NULL)
      `).run(
        bindingId,
        workspaceId,
        input.host_id,
        input.platform,
        input.locator.trim(),
        normalizedLocator,
        status,
        input.init_authorized ? 1 : 0,
        selectedAt,
        timestamp,
        timestamp,
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        const conflict = this.currentBindingAt(input.host_id, normalizedLocator);
        if (conflict && conflict.workspace_id !== workspaceId) {
          throw new WorkspaceLocatorConflictError(workspaceId, conflict.workspace_id, input.host_id);
        }
      }
      throw error;
    }
    return this.requireBinding(bindingId);
  }

  private requireBinding(bindingId: string): WorkspaceLocatorBindingRecord {
    const row = this.db.prepare(`SELECT * FROM workspace_locator_bindings WHERE binding_id = ?`)
      .get(bindingId) as WorkspaceBindingRow | undefined;
    if (!row) throw new Error(`Workspace locator binding was not persisted: ${bindingId}`);
    return bindingFromRow(row);
  }

  private assertLocatorAvailable(workspaceId: string, hostId: string, normalizedLocator: string): void {
    const conflict = this.currentBindingAt(hostId, normalizedLocator);
    if (conflict && conflict.workspace_id !== workspaceId) {
      throw new WorkspaceLocatorConflictError(workspaceId, conflict.workspace_id, hostId);
    }
  }

  private currentBindingAt(hostId: string, normalizedLocator: string): WorkspaceLocatorBindingRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM workspace_locator_bindings
      WHERE host_id = ? AND normalized_locator = ? AND state = 'current'
    `).get(hostId, normalizedLocator) as WorkspaceBindingRow | undefined;
    return row ? bindingFromRow(row) : null;
  }
}

const canonicalWorkspaceColumns = [
  "workspace_id",
  "name",
  "creation_kind",
  "source_workspace_id",
  "created_at",
  "updated_at",
];

function ensureCanonicalWorkspaceSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      workspace_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      creation_kind TEXT NOT NULL CHECK (creation_kind IN ('created', 'legacy_retained', 'copied', 'forked')),
      source_workspace_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (creation_kind IN ('created', 'legacy_retained') AND source_workspace_id IS NULL)
        OR (creation_kind IN ('copied', 'forked') AND source_workspace_id IS NOT NULL)
      )
    );
  `);
}

function ensureWorkspaceBindingSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_locator_bindings (
      binding_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
      host_id TEXT NOT NULL,
      platform TEXT NOT NULL CHECK (platform IN ('windows', 'posix')),
      locator TEXT NOT NULL,
      normalized_locator TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('current', 'superseded')),
      status TEXT NOT NULL,
      init_authorized INTEGER NOT NULL DEFAULT 0 CHECK (init_authorized IN (0, 1)),
      active_config_hash TEXT,
      selected_at TEXT,
      bound_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      superseded_at TEXT,
      superseded_by_binding_id TEXT,
      CHECK (
        (state = 'current' AND superseded_at IS NULL AND superseded_by_binding_id IS NULL)
        OR (state = 'superseded' AND superseded_at IS NOT NULL AND superseded_by_binding_id IS NOT NULL)
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_binding_current_workspace_host
      ON workspace_locator_bindings(workspace_id, host_id)
      WHERE state = 'current';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_binding_current_locator
      ON workspace_locator_bindings(host_id, normalized_locator)
      WHERE state = 'current';

    CREATE INDEX IF NOT EXISTS idx_workspace_binding_history
      ON workspace_locator_bindings(workspace_id, host_id, bound_at);
  `);
}

function migrateLegacyWorkspaceTable(
  db: DatabaseSync,
  actions: readonly LegacyWorkspaceMigrationAction[],
  hostId: string,
  platform: WorkspaceLocatorPlatform,
): void {
  db.exec(`
    CREATE TABLE workspaces_identity_next (
      workspace_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      creation_kind TEXT NOT NULL CHECK (creation_kind IN ('created', 'legacy_retained', 'copied', 'forked')),
      source_workspace_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (creation_kind IN ('created', 'legacy_retained') AND source_workspace_id IS NULL)
        OR (creation_kind IN ('copied', 'forked') AND source_workspace_id IS NOT NULL)
      )
    );
  `);
  const insertWorkspace = db.prepare(`
    INSERT INTO workspaces_identity_next (
      workspace_id, name, creation_kind, source_workspace_id, created_at, updated_at
    ) VALUES (?, ?, 'legacy_retained', NULL, ?, ?)
  `);
  for (const action of actions) {
    insertWorkspace.run(
      action.workspace.workspace_id,
      action.workspace.name,
      action.workspace.created_at,
      action.workspace.updated_at,
    );
  }

  db.exec(`
    DROP TABLE workspaces;
    ALTER TABLE workspaces_identity_next RENAME TO workspaces;
  `);
  ensureWorkspaceBindingSchema(db);

  const insertBinding = db.prepare(`
    INSERT INTO workspace_locator_bindings (
      binding_id, workspace_id, host_id, platform, locator, normalized_locator,
      state, status, init_authorized, active_config_hash, selected_at,
      bound_at, updated_at, superseded_at, superseded_by_binding_id
    ) VALUES (?, ?, ?, ?, ?, ?, 'current', ?, ?, ?, ?, ?, ?, NULL, NULL)
  `);
  for (const action of actions) {
    insertBinding.run(
      action.binding_id,
      action.workspace.workspace_id,
      hostId,
      platform,
      action.workspace.locator,
      action.normalized_locator,
      action.workspace.status,
      action.workspace.init_authorized ? 1 : 0,
      action.workspace.active_config_hash,
      action.workspace.selected_at,
      action.workspace.created_at,
      action.workspace.updated_at,
    );
  }
}

function migrationPlan(
  kind: WorkspaceIdentityMigrationPlan["kind"],
  input: Readonly<{ host_id: string; platform: WorkspaceLocatorPlatform }>,
  sourceFingerprint: string,
  actions: readonly LegacyWorkspaceMigrationAction[],
  refusals: readonly WorkspaceMigrationRefusal[],
): WorkspaceIdentityMigrationPlan {
  return {
    plan_version: 1,
    kind,
    host_id: input.host_id,
    platform: input.platform,
    source_fingerprint: sourceFingerprint,
    actions,
    refusals,
  };
}

function workspaceColumns(db: DatabaseSync): string[] {
  if (!tableExists(db, "workspaces")) return [];
  return (db.prepare(`PRAGMA table_info(workspaces)`).all() as Array<{ name: string }>).map((row) => row.name);
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?`).get(tableName));
}

function identityFromRow(row: WorkspaceIdentityRow): WorkspaceIdentityRecord {
  return {
    workspace_id: row.workspace_id,
    name: row.name,
    creation_kind: row.creation_kind as WorkspaceCreationKind,
    source_workspace_id: row.source_workspace_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function bindingFromRow(row: WorkspaceBindingRow): WorkspaceLocatorBindingRecord {
  return {
    binding_id: row.binding_id,
    workspace_id: row.workspace_id,
    host_id: row.host_id,
    platform: row.platform as WorkspaceLocatorPlatform,
    locator: row.locator,
    normalized_locator: row.normalized_locator,
    state: row.state as WorkspaceBindingState,
    status: row.status,
    init_authorized: row.init_authorized === 1,
    active_config_hash: row.active_config_hash,
    selected_at: row.selected_at,
    bound_at: row.bound_at,
    updated_at: row.updated_at,
    superseded_at: row.superseded_at,
    superseded_by_binding_id: row.superseded_by_binding_id,
  };
}

function remoteProjection(
  identity: WorkspaceIdentityRecord,
  binding: WorkspaceLocatorBindingRecord | null,
): RemoteWorkspaceProjection {
  return {
    ...identity,
    availability: {
      bound_on_serving_host: binding !== null,
      status: binding?.status ?? null,
    },
  };
}

function assertSameRetainedIdentity(
  existing: WorkspaceIdentityRecord,
  snapshot: WorkspaceIdentitySnapshot,
): void {
  if (
    existing.created_at !== snapshot.created_at
    || existing.creation_kind !== snapshot.creation_kind
    || existing.source_workspace_id !== snapshot.source_workspace_id
  ) {
    throw new WorkspaceIdentityConflictError(
      snapshot.workspace_id,
      "the imported identity provenance does not match the identity already stored here",
    );
  }
}

function validateIdentitySnapshot(snapshot: WorkspaceIdentitySnapshot): void {
  assertNonEmpty("workspace_id", snapshot.workspace_id);
  normalizedName(snapshot.name);
  if (!(["created", "legacy_retained", "copied", "forked"] as string[]).includes(snapshot.creation_kind)) {
    throw new WorkspaceIdentityConflictError(snapshot.workspace_id, "the creation kind is unsupported");
  }
  const derived = snapshot.creation_kind === "copied" || snapshot.creation_kind === "forked";
  if (derived !== Boolean(snapshot.source_workspace_id)) {
    throw new WorkspaceIdentityConflictError(snapshot.workspace_id, "the identity provenance is incomplete");
  }
  if (snapshot.source_workspace_id === snapshot.workspace_id) {
    throw new WorkspaceIdentityConflictError(snapshot.workspace_id, "a Workspace cannot be derived from itself");
  }
  assertTimestamp("created_at", snapshot.created_at);
  assertTimestamp("updated_at", snapshot.updated_at);
}

function normalizedName(name: string): string {
  const value = name.trim();
  if (!value) throw new Error("Workspace name must not be empty.");
  return value;
}

function assertTimestamp(field: string, value: string): void {
  if (!value || Number.isNaN(Date.parse(value))) throw new Error(`${field} must be an ISO timestamp.`);
}

function assertNonEmpty(field: string, value: string): void {
  if (!value.trim()) throw new Error(`${field} must not be empty.`);
}

function trimNonRootTrailingSeparators(value: string, platform: WorkspaceLocatorPlatform): string {
  const path = platform === "windows" ? win32 : posix;
  const root = path.parse(value).root;
  let result = value;
  while (result.length > root.length && /[\\/]$/.test(result)) result = result.slice(0, -1);
  return result;
}

function migratedBindingId(hostId: string, workspaceId: string, normalizedLocator: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([hostId, workspaceId, normalizedLocator]))
    .digest("hex")
    .slice(0, 24);
  return `wbind_migrated_${digest}`;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

let savepointSequence = 0;

function inSavepoint<T>(db: DatabaseSync, action: () => T): T {
  savepointSequence += 1;
  const name = `workspace_identity_${savepointSequence}`;
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

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(error.message);
}
