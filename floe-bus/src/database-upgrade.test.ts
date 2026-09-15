import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURRENT_BUS_SCHEMA_VERSION,
  DatabaseSchemaTooNewError,
  runDatabaseUpgrade,
} from "./database-upgrade.js";
import { applyContextSchema, ContextStore } from "./contexts/store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "floe-upgrade-"));
  roots.push(root);
  const path = join(root, "floe-bus.sqlite");
  return { root, path, db: new DatabaseSync(path) };
}

describe("database upgrade boundary", () => {
  it("creates a verified recovery copy before changing an existing database", () => {
    const { db, path } = fixture();
    db.exec("CREATE TABLE retained (id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO retained VALUES ('one', 'valuable');");

    const result = runDatabaseUpgrade({
      db,
      database_path: path,
      target_version: 1,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
      migrate: () => db.exec("ALTER TABLE retained ADD COLUMN added TEXT;"),
    });

    expect(result).toMatchObject({ previous_version: 0, current_version: 1, changed: true });
    expect(result.backup_path).not.toBeNull();
    expect(existsSync(result.backup_path as string)).toBe(true);
    const backup = new DatabaseSync(result.backup_path as string, { readOnly: true });
    expect(backup.prepare("SELECT * FROM retained").get()).toEqual({ id: "one", value: "valuable" });
    expect(backup.prepare("PRAGMA table_info(retained)").all()).toHaveLength(2);
    backup.close();
    expect(db.prepare("PRAGMA table_info(retained)").all()).toHaveLength(3);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
    db.close();
  });

  it("does not create a recovery copy for a new empty database", () => {
    const { db, path } = fixture();
    const result = runDatabaseUpgrade({
      db,
      database_path: path,
      target_version: 1,
      migrate: () => db.exec("CREATE TABLE first_table (id TEXT PRIMARY KEY);"),
    });
    expect(result.backup_path).toBeNull();
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'first_table'").get()).toBeTruthy();
    db.close();
  });

  it("rolls back the schema transaction when migration fails", () => {
    const { db, path } = fixture();
    db.exec("CREATE TABLE retained (id TEXT PRIMARY KEY); INSERT INTO retained VALUES ('one');");

    expect(() => runDatabaseUpgrade({
      db,
      database_path: path,
      target_version: 1,
      migrate: () => {
        db.exec("ALTER TABLE retained ADD COLUMN transient TEXT;");
        throw new Error("migration failed");
      },
    })).toThrow("migration failed");

    expect(db.prepare("PRAGMA table_info(retained)").all()).toHaveLength(1);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(0);
    db.close();
  });

  it("refuses to open data written by a newer schema", () => {
    const { db, path } = fixture();
    db.exec("PRAGMA user_version = 7");
    expect(() => runDatabaseUpgrade({
      db,
      database_path: path,
      target_version: 6,
      migrate: () => undefined,
    })).toThrow(DatabaseSchemaTooNewError);
    db.close();
  });

  it("re-runs the idempotent schema ensure at a completed version without a backup or version change", () => {
    const { db, path } = fixture();
    db.exec("PRAGMA user_version = 2");
    let ran = 0;
    const result = runDatabaseUpgrade({
      db,
      database_path: path,
      target_version: 2,
      // migrate() is an idempotent ensure step; it must run every boot, even at
      // the current version, so forgotten additive schema cannot strand.
      migrate: () => { ran += 1; db.exec("CREATE TABLE IF NOT EXISTS ensured (id TEXT PRIMARY KEY);"); },
    });
    expect(ran).toBe(1);
    expect(result).toEqual({ previous_version: 2, current_version: 2, changed: false, backup_path: null });
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'ensured'").get()).toBeTruthy();
    db.close();
  });

  it("repairs and loudly reports schema stranded at the current version without a bump", () => {
    const { db, path } = fixture();
    // Simulate the defect: a database stamped at the current version but missing
    // a table that migrate() should have created (a forgotten version bump).
    db.exec(`CREATE TABLE existing (id TEXT PRIMARY KEY); PRAGMA user_version = ${CURRENT_BUS_SCHEMA_VERSION};`);
    const warnings: string[] = [];
    const result = runDatabaseUpgrade({
      db,
      database_path: path,
      migrate: () => db.exec("CREATE TABLE IF NOT EXISTS stranded_table (id TEXT PRIMARY KEY);"),
      warn: (message) => warnings.push(message),
    });
    expect(result.changed).toBe(false);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'stranded_table'").get()).toBeTruthy();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("stranded_table");
    db.close();
  });

  it("makes a fresh database and a same-version incomplete database converge to identical schema", () => {
    // The class-killing invariant: whatever migrate() produces on a fresh
    // database must also be produced on an existing database already stamped at
    // the current version. This is what stops a fresh-only test from passing
    // while every existing install lacks new tables.
    const ensure = (target: DatabaseSync) => {
      target.exec("CREATE TABLE IF NOT EXISTS alpha (id TEXT PRIMARY KEY);");
      target.exec("CREATE TABLE IF NOT EXISTS beta (id TEXT PRIMARY KEY);");
    };

    const fresh = fixture();
    runDatabaseUpgrade({ db: fresh.db, database_path: fresh.path, migrate: () => ensure(fresh.db) });
    const freshTables = (fresh.db.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    fresh.db.close();

    const existing = fixture();
    // An old install that only ever received "alpha" and was stamped current.
    existing.db.exec(`CREATE TABLE alpha (id TEXT PRIMARY KEY); PRAGMA user_version = ${CURRENT_BUS_SCHEMA_VERSION};`);
    runDatabaseUpgrade({ db: existing.db, database_path: existing.path, migrate: () => ensure(existing.db), warn: () => undefined });
    const existingTables = (existing.db.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    existing.db.close();

    expect(existingTables).toEqual(freshTables);
  });

  it("upgrades retained Context rows from schema 7 to the canonical lifecycle schema", () => {
    const { db, path } = fixture();
    db.exec(`
      CREATE TABLE contexts (
        context_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        scope_id TEXT NOT NULL DEFAULT 'default',
        parent_context_id TEXT,
        created_by_endpoint_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        title TEXT
      );
      CREATE TABLE context_participants (
        context_id TEXT NOT NULL,
        endpoint_id TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (context_id, endpoint_id)
      );
      INSERT INTO contexts VALUES (
        'context:retained', 'workspace:one', 'default', NULL,
        'actor:one', '2026-09-01T00:00:00.000Z', 'Retained conversation'
      );
      INSERT INTO context_participants VALUES (
        'context:retained', 'actor:one', '2026-09-01T00:00:00.000Z'
      );
      PRAGMA user_version = 7;
    `);

    const result = runDatabaseUpgrade({
      db,
      database_path: path,
      migrate: () => applyContextSchema(db),
    });

    expect(result).toMatchObject({
      previous_version: 7,
      current_version: CURRENT_BUS_SCHEMA_VERSION,
      changed: true,
    });
    expect(result.backup_path).not.toBeNull();
    expect(new ContextStore(db).getContext("context:retained")).toMatchObject({
      scope_id: null,
      created_by_endpoint_id: "actor:one",
      title: "Retained conversation",
      state_revision: 1,
      lifecycle_state: "active",
      content_state: "available",
      updated_at: "2026-09-01T00:00:00.000Z",
    });
    expect(new ContextStore(db).getContextParticipantRecords("context:retained")).toEqual([
      expect.objectContaining({
        participant_id: "actor:one",
        role: "participant",
        access: "contribute",
      }),
    ]);
    db.close();
  });
});
