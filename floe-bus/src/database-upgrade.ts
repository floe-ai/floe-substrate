import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const CURRENT_BUS_SCHEMA_VERSION = 14;

export type DatabaseUpgradeResult = Readonly<{
  previous_version: number;
  current_version: number;
  changed: boolean;
  backup_path: string | null;
}>;

export class DatabaseSchemaTooNewError extends Error {
  readonly code = "E_DATABASE_SCHEMA_TOO_NEW" as const;

  constructor(readonly found: number, readonly supported: number) {
    super(`Database schema ${found} is newer than this Floe build supports (${supported}).`);
    this.name = "DatabaseSchemaTooNewError";
  }
}

export class DatabaseBackupInvalidError extends Error {
  readonly code = "E_DATABASE_BACKUP_INVALID" as const;

  constructor(readonly backup_path: string, readonly reason: string) {
    super(`Database backup could not be verified: ${reason}`);
    this.name = "DatabaseBackupInvalidError";
  }
}

/**
 * Runs one atomic schema upgrade after creating a verified, consistent SQLite
 * backup of any existing user database. New empty databases do not need a
 * backup. The caller owns the semantic migration function so this mechanism
 * remains policy-free and reusable for later schema versions.
 */
export function runDatabaseUpgrade(input: {
  db: DatabaseSync;
  database_path: string;
  target_version?: number;
  migrate: () => void;
  backup_directory?: string;
  now?: () => Date;
}): DatabaseUpgradeResult {
  const targetVersion = input.target_version ?? CURRENT_BUS_SCHEMA_VERSION;
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    throw new Error("Database target version must be a positive integer.");
  }
  const previousVersion = readUserVersion(input.db);
  if (previousVersion > targetVersion) {
    throw new DatabaseSchemaTooNewError(previousVersion, targetVersion);
  }
  if (previousVersion === targetVersion) {
    return {
      previous_version: previousVersion,
      current_version: targetVersion,
      changed: false,
      backup_path: null,
    };
  }

  const hasUserState = Number((input.db.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).get() as { count: number }).count) > 0;
  const backupPath = hasUserState
    ? createVerifiedBackup({
        db: input.db,
        database_path: input.database_path,
        backup_directory: input.backup_directory,
        previous_version: previousVersion,
        target_version: targetVersion,
        now: input.now,
      })
    : null;

  input.db.exec("BEGIN IMMEDIATE");
  try {
    input.migrate();
    input.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        schema_version INTEGER PRIMARY KEY,
        previous_version INTEGER NOT NULL,
        backup_path TEXT,
        applied_at TEXT NOT NULL
      );
    `);
    input.db.prepare(`
      INSERT OR REPLACE INTO schema_migrations (
        schema_version, previous_version, backup_path, applied_at
      ) VALUES (?, ?, ?, ?)
    `).run(
      targetVersion,
      previousVersion,
      backupPath,
      (input.now ?? (() => new Date()))().toISOString(),
    );
    input.db.exec(`PRAGMA user_version = ${targetVersion}`);
    input.db.exec("COMMIT");
  } catch (error) {
    input.db.exec("ROLLBACK");
    throw error;
  }

  return {
    previous_version: previousVersion,
    current_version: targetVersion,
    changed: true,
    backup_path: backupPath,
  };
}

function createVerifiedBackup(input: {
  db: DatabaseSync;
  database_path: string;
  backup_directory?: string;
  previous_version: number;
  target_version: number;
  now?: () => Date;
}): string {
  if (input.database_path === ":memory:") {
    throw new DatabaseBackupInvalidError(input.database_path, "an in-memory database cannot preserve a recovery file");
  }
  const directory = input.backup_directory ?? join(dirname(input.database_path), "backups");
  mkdirSync(directory, { recursive: true });
  const stamp = (input.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
  const name = basename(input.database_path).replace(/\.sqlite$/i, "");
  const backupPath = join(
    directory,
    `${name}.before-schema-${input.previous_version}-to-${input.target_version}.${stamp}.sqlite`,
  );
  if (existsSync(backupPath)) {
    throw new DatabaseBackupInvalidError(backupPath, "the intended backup path already exists");
  }

  // SQLite parameters are not accepted by VACUUM INTO. Escape the literal
  // rather than constructing a shell command; this remains inside SQLite.
  const quotedPath = backupPath.replaceAll("'", "''");
  input.db.exec(`VACUUM INTO '${quotedPath}'`);

  // Attach the copy read-only through SQLite itself so WAL state is included
  // and integrity is checked before any schema mutation begins.
  const alias = "floe_upgrade_backup";
  input.db.exec(`ATTACH DATABASE '${quotedPath}' AS ${alias}`);
  try {
    const integrity = input.db.prepare(`PRAGMA ${alias}.integrity_check`).get() as { integrity_check?: string };
    if (integrity?.integrity_check !== "ok") {
      throw new DatabaseBackupInvalidError(backupPath, integrity?.integrity_check ?? "integrity check returned no result");
    }
  } finally {
    input.db.exec(`DETACH DATABASE ${alias}`);
  }
  return backupPath;
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return Number(row.user_version);
}
