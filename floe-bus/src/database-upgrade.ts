import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const CURRENT_BUS_SCHEMA_VERSION = 15;

/**
 * Canonical fingerprint of every persistent schema object (tables, indexes,
 * triggers, views) in a database, order-independent. Used to detect schema
 * drift — a database whose recorded version matches this build but whose actual
 * schema does not match what `migrate()` produces. `schema_migrations` and the
 * volatile `sqlite_%` objects are excluded because they are bookkeeping, not
 * schema shape.
 */
export function computeSchemaFingerprint(db: DatabaseSync): string {
  const rows = db.prepare(`
    SELECT type, name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
      AND name <> 'schema_migrations'
      AND sql IS NOT NULL
    ORDER BY type, name
  `).all() as Array<{ type: string; name: string; sql: string }>;
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(`${row.type}\u0000${row.name}\u0000${row.sql}\u0001`);
  }
  return hash.digest("hex");
}

function schemaObjectNames(db: DatabaseSync): Set<string> {
  const rows = db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'
  `).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

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
 * Ensures the database schema is complete and up to date.
 *
 * Two responsibilities are deliberately separated:
 *
 * 1. **Schema completeness (every boot, unconditional).** `migrate()` is an
 *    idempotent "ensure schema" function (`CREATE TABLE/INDEX IF NOT EXISTS`,
 *    guarded `ADD COLUMN`, guarded table rebuilds). It runs on *every* boot,
 *    regardless of the recorded version. This is the mechanism that makes the
 *    project's defining defect impossible: previously, additive schema added to
 *    `migrate()` without bumping `CURRENT_BUS_SCHEMA_VERSION` was silently
 *    skipped on any database already stamped at the current version, so a fresh
 *    database passed every test while every existing install was permanently
 *    missing the new tables. Running the ensure step unconditionally means a
 *    fresh database and an existing database converge to the *same* schema, so a
 *    missing table now fails on the author's own fresh database too — it can no
 *    longer hide on existing installs alone.
 *
 * 2. **Versioned upgrade (backup + stamp, only when the integer version rises).**
 *    When `previousVersion < targetVersion` a verified backup of existing user
 *    state is taken before any mutation, and the new version is stamped and
 *    recorded. The version integer exists for operator-visible backups and for
 *    portability checks — not to gate whether schema is applied.
 *
 * If the ensure step changes the schema of a database whose version was already
 * current, that is schema drift (a forgotten version bump): it is repaired
 * automatically and reported loudly rather than left to surface later as a
 * `no such table` error.
 */
export function runDatabaseUpgrade(input: {
  db: DatabaseSync;
  database_path: string;
  target_version?: number;
  migrate: () => void;
  backup_directory?: string;
  now?: () => Date;
  warn?: (message: string) => void;
}): DatabaseUpgradeResult {
  const targetVersion = input.target_version ?? CURRENT_BUS_SCHEMA_VERSION;
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    throw new Error("Database target version must be a positive integer.");
  }
  const previousVersion = readUserVersion(input.db);
  if (previousVersion > targetVersion) {
    throw new DatabaseSchemaTooNewError(previousVersion, targetVersion);
  }
  const versionRises = previousVersion < targetVersion;

  const hasUserState = Number((input.db.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).get() as { count: number }).count) > 0;
  const backupPath = versionRises && hasUserState
    ? createVerifiedBackup({
        db: input.db,
        database_path: input.database_path,
        backup_directory: input.backup_directory,
        previous_version: previousVersion,
        target_version: targetVersion,
        now: input.now,
      })
    : null;

  // Fingerprint before the ensure step so drift at an unchanged version is
  // detectable and reportable.
  const beforeFingerprint = computeSchemaFingerprint(input.db);
  const beforeObjects = schemaObjectNames(input.db);

  input.db.exec("BEGIN IMMEDIATE");
  try {
    // Unconditional, idempotent schema ensure — see the doc comment above.
    input.migrate();
    if (versionRises) {
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
    }
    input.db.exec("COMMIT");
  } catch (error) {
    input.db.exec("ROLLBACK");
    throw error;
  }

  const afterFingerprint = computeSchemaFingerprint(input.db);
  if (!versionRises && beforeFingerprint !== afterFingerprint) {
    // The recorded version already matched this build, yet ensuring the schema
    // changed it: schema was added without bumping CURRENT_BUS_SCHEMA_VERSION.
    // It has just been repaired; say so loudly.
    const added = [...schemaObjectNames(input.db)].filter((name) => !beforeObjects.has(name));
    (input.warn ?? ((message: string) => console.warn(message)))(
      `floe-bus: repaired incomplete database schema at version ${previousVersion} `
      + `(schema was changed without a version bump).`
      + (added.length > 0 ? ` Added tables: ${added.sort().join(", ")}.` : ""),
    );
  }

  return {
    previous_version: previousVersion,
    current_version: targetVersion,
    changed: versionRises,
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
