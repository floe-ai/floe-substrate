/**
 * @invariant A Workspace's folders and its System access setting are the
 * default boundary for Floe-enforced file tools on this host. The home folder
 * (where `.floe` lives) is always one of them. Every change, and every time
 * Floe itself gives existing Actors tool access, is recorded here so a surface
 * can show it. Nothing here decides a tool call; tool-policy does.
 */
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { canonicalAbsolutePath, pathUnder } from "./workspace-paths.js";

export const HOME_FOLDER_ID = "home";
export const TOOL_ACCESS_NOTICE = "Floe Actors in this workspace can now use tools inside its folders.";

export type WorkspaceFolder = Readonly<{
  folder_id: string;
  path: string;
  home: boolean;
  /** False when the folder cannot currently be found on this machine. */
  available: boolean;
  added_at: string | null;
}>;

export type WorkspaceAccessRecordKind =
  | "folder_added"
  | "folder_removed"
  | "system_access_turned_on"
  | "system_access_turned_off"
  | "tool_access_given"
  | "actor_access_moved"
  | "actor_access_lapsing"
  | "access_carried"
  | "access_left_behind";

export type WorkspaceAccessRecord = Readonly<{
  record_id: string;
  kind: WorkspaceAccessRecordKind;
  summary: string;
  path: string | null;
  principal_id: string;
  recorded_at: string;
  /** People who have seen this record as it now reads; a changed notice is unseen again. */
  seen_by: readonly string[];
}>;

export type WorkspaceAccess = Readonly<{
  workspace_id: string;
  folders: readonly WorkspaceFolder[];
  system_access: boolean;
  /** Newest first. */
  records: readonly WorkspaceAccessRecord[];
}>;

/** What a tool decision needs: canonical real folders and the System access setting. */
export type WorkspaceToolBoundary = Readonly<{
  home: string | null;
  folders: readonly string[];
  system_access: boolean;
}>;

export class WorkspaceFolderError extends Error {
  constructor(readonly code: "folder_invalid" | "folder_already_included" | "folder_not_found" | "home_folder_fixed" | "notice_not_found", message: string) {
    super(message);
    this.name = "WorkspaceFolderError";
  }
}

const RECORD_LIMIT = 50;

export function applyWorkspaceAccessSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_folders (
      folder_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      locator TEXT NOT NULL,
      added_at TEXT NOT NULL,
      added_by_principal_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_folders_workspace ON workspace_folders(workspace_id, host_id);
    CREATE TABLE IF NOT EXISTS workspace_system_access (
      workspace_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      changed_at TEXT NOT NULL,
      changed_by_principal_id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, host_id)
    );
    CREATE TABLE IF NOT EXISTS workspace_access_records (
      record_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      path TEXT,
      summary TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_access_records_workspace
      ON workspace_access_records(workspace_id, host_id, recorded_at);
    CREATE TABLE IF NOT EXISTS workspace_notice_acknowledgements (
      record_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      record_recorded_at TEXT NOT NULL,
      acknowledged_at TEXT NOT NULL,
      PRIMARY KEY (record_id, principal_id)
    );
  `);
}

/** The folder's canonical real path, or null when it is not an existing directory. */
function realFolder(locator: string | null): string | null {
  if (!locator) return null;
  try {
    const real = realpathSync.native(locator);
    return statSync(real).isDirectory() ? canonicalAbsolutePath(real) : null;
  } catch {
    return null;
  }
}

export class WorkspaceAccessStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly dependencies: Readonly<{
      host_id: string;
      /** The Workspace's current home folder on this host. */
      home_locator: (workspaceId: string) => string | null;
      /** Told when Floe records, changes or removes a notice by itself, so surfaces hear of it now. */
      notice_changed?: (workspaceId: string) => void;
      now?: () => string;
    }>,
  ) {
    applyWorkspaceAccessSchema(db);
  }

  private now(): string {
    return this.dependencies.now?.() ?? new Date().toISOString();
  }

  inspect(workspaceId: string): WorkspaceAccess {
    const home = this.dependencies.home_locator(workspaceId);
    const folders: WorkspaceFolder[] = home
      ? [{ folder_id: HOME_FOLDER_ID, path: home, home: true, available: realFolder(home) !== null, added_at: null }]
      : [];
    for (const row of this.folderRows(workspaceId)) {
      folders.push({ folder_id: row.folder_id, path: row.locator, home: false,
        available: realFolder(row.locator) !== null, added_at: row.added_at });
    }
    const seen = new Map<string, string[]>();
    for (const row of this.db.prepare(`SELECT a.record_id, a.principal_id FROM workspace_notice_acknowledgements a
      JOIN workspace_access_records r ON r.record_id = a.record_id AND r.recorded_at = a.record_recorded_at
      WHERE r.workspace_id = ? AND r.host_id = ? ORDER BY a.acknowledged_at, a.principal_id`)
      .all(workspaceId, this.dependencies.host_id) as Array<{ record_id: string; principal_id: string }>) {
      seen.set(row.record_id, [...(seen.get(row.record_id) ?? []), row.principal_id]);
    }
    const records = (this.db.prepare(`SELECT record_id, kind, summary, path, principal_id, recorded_at
      FROM workspace_access_records WHERE workspace_id = ? AND host_id = ?
      ORDER BY recorded_at DESC, record_id DESC LIMIT ?`)
      .all(workspaceId, this.dependencies.host_id, RECORD_LIMIT) as Omit<WorkspaceAccessRecord, "seen_by">[])
      .map(row => ({ ...row, seen_by: seen.get(row.record_id) ?? [] }));
    return { workspace_id: workspaceId, folders, system_access: this.systemAccess(workspaceId), records };
  }

  toolBoundary(workspaceId: string): WorkspaceToolBoundary {
    return {
      home: realFolder(this.dependencies.home_locator(workspaceId)),
      folders: this.folderRows(workspaceId).map(row => realFolder(row.locator)).filter((value): value is string => value !== null),
      system_access: this.systemAccess(workspaceId),
    };
  }

  addFolder(input: Readonly<{ workspace_id: string; path: string; principal_id: string }>): WorkspaceAccess {
    if (!path.isAbsolute(input.path)) {
      throw new WorkspaceFolderError("folder_invalid", "Choose a folder by its full path on this machine.");
    }
    const locator = path.resolve(input.path);
    const real = realFolder(locator);
    if (!real) throw new WorkspaceFolderError("folder_invalid", "That folder does not exist on this machine.");
    const home = realFolder(this.dependencies.home_locator(input.workspace_id));
    const existing = [home, ...this.folderRows(input.workspace_id).map(row => realFolder(row.locator))];
    if (existing.some(folder => folder !== null && pathUnder(folder, real) !== null)) {
      throw new WorkspaceFolderError("folder_already_included", "That folder is already inside this Workspace's folders.");
    }
    const at = this.now();
    this.db.prepare(`INSERT INTO workspace_folders (folder_id, workspace_id, host_id, locator, added_at, added_by_principal_id)
      VALUES (?, ?, ?, ?, ?, ?)`).run(`folder_${randomUUID()}`, input.workspace_id, this.dependencies.host_id, locator, at, input.principal_id);
    this.record(input.workspace_id, "folder_added", `Added the folder ${locator}.`, locator, input.principal_id, at);
    return this.inspect(input.workspace_id);
  }

  removeFolder(input: Readonly<{ workspace_id: string; folder_id: string; principal_id: string }>): WorkspaceAccess {
    if (input.folder_id === HOME_FOLDER_ID) {
      throw new WorkspaceFolderError("home_folder_fixed", "The Workspace's own folder cannot be removed. Move the Workspace instead.");
    }
    const row = this.folderRows(input.workspace_id).find(item => item.folder_id === input.folder_id);
    if (!row) throw new WorkspaceFolderError("folder_not_found", "That folder is not one of this Workspace's folders.");
    this.db.prepare("DELETE FROM workspace_folders WHERE folder_id = ?").run(row.folder_id);
    this.record(input.workspace_id, "folder_removed", `Removed the folder ${row.locator}.`, row.locator, input.principal_id, this.now());
    return this.inspect(input.workspace_id);
  }

  /** Returns null when the setting already had this value, so nothing changed. */
  setSystemAccess(input: Readonly<{ workspace_id: string; enabled: boolean; principal_id: string }>): WorkspaceAccess | null {
    if (this.systemAccess(input.workspace_id) === input.enabled) return null;
    const at = this.now();
    this.db.prepare(`INSERT INTO workspace_system_access (workspace_id, host_id, enabled, changed_at, changed_by_principal_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, host_id) DO UPDATE SET enabled = excluded.enabled,
        changed_at = excluded.changed_at, changed_by_principal_id = excluded.changed_by_principal_id`)
      .run(input.workspace_id, this.dependencies.host_id, input.enabled ? 1 : 0, at, input.principal_id);
    this.record(input.workspace_id,
      input.enabled ? "system_access_turned_on" : "system_access_turned_off",
      input.enabled
        ? "System access turned on: file tools may reach anywhere on this machine."
        : "System access turned off: file tools are limited to this Workspace's folders.",
      null, input.principal_id, at);
    return this.inspect(input.workspace_id);
  }

  /**
   * Gives a new Workspace the extra folders and System access of the
   * Workspace it was copied or forked from on this machine, keeping who
   * first chose each one, and records a notice saying what came across.
   */
  carryAccess(input: Readonly<{
    source_workspace_id: string;
    workspace_id: string;
    how: "copied" | "forked";
    principal_id: string;
  }>): void {
    const host = this.dependencies.host_id;
    const folders = this.db.prepare(`SELECT locator, added_at, added_by_principal_id FROM workspace_folders
      WHERE workspace_id = ? AND host_id = ? ORDER BY added_at, folder_id`)
      .all(input.source_workspace_id, host) as Array<{ locator: string; added_at: string; added_by_principal_id: string }>;
    const system = this.db.prepare(`SELECT changed_at, changed_by_principal_id FROM workspace_system_access
      WHERE workspace_id = ? AND host_id = ? AND enabled = 1`)
      .get(input.source_workspace_id, host) as { changed_at: string; changed_by_principal_id: string } | undefined;
    if (folders.length === 0 && !system) return;
    for (const folder of folders) {
      this.db.prepare(`INSERT INTO workspace_folders (folder_id, workspace_id, host_id, locator, added_at, added_by_principal_id)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(`folder_${randomUUID()}`, input.workspace_id, host, folder.locator, folder.added_at, folder.added_by_principal_id);
    }
    if (system) {
      this.db.prepare(`INSERT INTO workspace_system_access (workspace_id, host_id, enabled, changed_at, changed_by_principal_id)
        VALUES (?, ?, 1, ?, ?)`).run(input.workspace_id, host, system.changed_at, system.changed_by_principal_id);
    }
    this.record(input.workspace_id, "access_carried",
      carriedSummary(input.how, folders.map(folder => folder.locator), Boolean(system)),
      null, input.principal_id, this.now());
  }

  /** The extra folders and System access this machine holds for a Workspace. */
  hostAccess(workspaceId: string): Readonly<{ folder_locators: readonly string[]; system_access: boolean }> {
    return { folder_locators: this.folderRows(workspaceId).map(row => row.locator), system_access: this.systemAccess(workspaceId) };
  }

  /**
   * Tells a restored Workspace what its package left behind. Restoring the
   * same package again changes nothing.
   */
  recordLeftBehind(workspaceId: string, leftBehind: Readonly<{ folder_names: readonly string[]; system_access: boolean }>): boolean {
    const parts = [
      ...(leftBehind.folder_names.length > 0
        ? [`${leftBehind.folder_names.length === 1 ? "the folder" : `${leftBehind.folder_names.length} folders`} ${leftBehind.folder_names.join(", ")}, which you can add again`]
        : []),
      ...(leftBehind.system_access ? ["System access, which was on where it came from and is off here until you turn it on"] : []),
    ];
    return this.recordStandingNotice({
      record_id: `notice:left-behind:${workspaceId}`,
      workspace_id: workspaceId,
      kind: "access_left_behind",
      summary: `This Workspace was restored from a package, which does not carry machine access. Left behind: ${parts.join("; ")}.`,
      principal_id: "system:workspace-restore",
    });
  }

  /** Records the tool access notice once per Workspace; true when it was recorded now. */
  recordToolAccessNotice(workspaceId: string, principalId: string): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO workspace_access_records
      (record_id, workspace_id, host_id, kind, path, summary, principal_id, recorded_at)
      VALUES (?, ?, ?, 'tool_access_given', NULL, ?, ?, ?)`)
      .run(`notice:tool-access:${workspaceId}`, workspaceId, this.dependencies.host_id, TOOL_ACCESS_NOTICE, principalId, this.now());
    return this.noticed(workspaceId, Number(result.changes) > 0);
  }

  /**
   * Keeps one standing notice under a stable id. A changed summary replaces
   * the old one and counts as new; the same summary again changes nothing.
   * True when the notice was recorded or changed now.
   */
  recordStandingNotice(input: Readonly<{
    record_id: string;
    workspace_id: string;
    kind: WorkspaceAccessRecordKind;
    summary: string;
    principal_id: string;
  }>): boolean {
    const result = this.db.prepare(`INSERT INTO workspace_access_records
      (record_id, workspace_id, host_id, kind, path, summary, principal_id, recorded_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET kind = excluded.kind, summary = excluded.summary,
        principal_id = excluded.principal_id, recorded_at = excluded.recorded_at
      WHERE workspace_access_records.summary <> excluded.summary OR workspace_access_records.kind <> excluded.kind`)
      .run(input.record_id, input.workspace_id, this.dependencies.host_id, input.kind, input.summary, input.principal_id, this.now());
    return this.noticed(input.workspace_id, Number(result.changes) > 0);
  }

  /**
   * Marks a record seen by one person, as it now reads. False when it was
   * already seen; throws when the Workspace has no such record.
   */
  acknowledge(input: Readonly<{ workspace_id: string; record_id: string; principal_id: string }>): boolean {
    const record = this.db.prepare(`SELECT recorded_at FROM workspace_access_records
      WHERE record_id = ? AND workspace_id = ? AND host_id = ?`)
      .get(input.record_id, input.workspace_id, this.dependencies.host_id) as { recorded_at: string } | undefined;
    if (!record) throw new WorkspaceFolderError("notice_not_found", "This Workspace has no notice with that id.");
    return Number(this.db.prepare(`INSERT INTO workspace_notice_acknowledgements
      (record_id, principal_id, workspace_id, record_recorded_at, acknowledged_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(record_id, principal_id) DO UPDATE SET record_recorded_at = excluded.record_recorded_at,
        acknowledged_at = excluded.acknowledged_at
      WHERE workspace_notice_acknowledgements.record_recorded_at <> excluded.record_recorded_at`)
      .run(input.record_id, input.principal_id, input.workspace_id, record.recorded_at, this.now()).changes) > 0;
  }

  removeStandingNotice(recordId: string): boolean {
    const row = this.db.prepare("SELECT workspace_id FROM workspace_access_records WHERE record_id = ? AND host_id = ?")
      .get(recordId, this.dependencies.host_id) as { workspace_id: string } | undefined;
    if (!row) return false;
    this.db.prepare("DELETE FROM workspace_notice_acknowledgements WHERE record_id = ?").run(recordId);
    this.db.prepare("DELETE FROM workspace_access_records WHERE record_id = ? AND host_id = ?").run(recordId, this.dependencies.host_id);
    return this.noticed(row.workspace_id, true);
  }

  private noticed(workspaceId: string, changed: boolean): boolean {
    if (changed) this.dependencies.notice_changed?.(workspaceId);
    return changed;
  }

  /** Removes everything held for a deleted Workspace. */
  forgetWorkspace(workspaceId: string): void {
    for (const table of ["workspace_folders", "workspace_system_access", "workspace_access_records", "workspace_notice_acknowledgements"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId);
    }
  }

  private systemAccess(workspaceId: string): boolean {
    const row = this.db.prepare("SELECT enabled FROM workspace_system_access WHERE workspace_id = ? AND host_id = ?")
      .get(workspaceId, this.dependencies.host_id) as { enabled: number } | undefined;
    return row?.enabled === 1;
  }

  private folderRows(workspaceId: string): Array<{ folder_id: string; locator: string; added_at: string }> {
    return this.db.prepare(`SELECT folder_id, locator, added_at FROM workspace_folders
      WHERE workspace_id = ? AND host_id = ? ORDER BY added_at, folder_id`)
      .all(workspaceId, this.dependencies.host_id) as Array<{ folder_id: string; locator: string; added_at: string }>;
  }

  private record(workspaceId: string, kind: WorkspaceAccessRecordKind, summary: string, recordPath: string | null, principalId: string, at: string): void {
    this.db.prepare(`INSERT INTO workspace_access_records
      (record_id, workspace_id, host_id, kind, path, summary, principal_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`access_${randomUUID()}`, workspaceId, this.dependencies.host_id, kind, recordPath, summary, principalId, at);
  }
}

function carriedSummary(how: "copied" | "forked", folders: readonly string[], systemAccess: boolean): string {
  const parts = [
    ...(folders.length > 0 ? [`the folder${folders.length === 1 ? "" : "s"} ${folders.join(", ")}`] : []),
    ...(systemAccess ? ["System access (file tools may reach anywhere on this machine)"] : []),
  ];
  return `This Workspace was ${how} with ${parts.join(" and ")}.`;
}

/**
 * Sorts the real paths an engine reported into the facts a tool decision keeps:
 * home-folder paths relative, other-folder paths absolute, and paths outside
 * every folder only counted, never named.
 */
export function classifyToolPaths(reported: readonly (string | null)[], boundary: WorkspaceToolBoundary): Readonly<{
  paths: string[];
  outside_path_count: number;
  unresolved_path_count: number;
}> {
  const paths: string[] = [];
  let outside = 0;
  let unresolved = 0;
  for (const value of reported) {
    if (value === null || !path.isAbsolute(value)) { unresolved += 1; continue; }
    const candidate = canonicalAbsolutePath(value);
    const inHome = boundary.home ? pathUnder(boundary.home, candidate) : null;
    if (inHome !== null) { paths.push(inHome); continue; }
    if (boundary.folders.some(folder => pathUnder(folder, candidate) !== null)) { paths.push(candidate); continue; }
    outside += 1;
  }
  return { paths, outside_path_count: outside, unresolved_path_count: unresolved };
}
