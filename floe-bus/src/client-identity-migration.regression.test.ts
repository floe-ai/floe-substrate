import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import YAML from "yaml";
import { BusStore } from "./store.js";
import { defaultConfig } from "./config.js";

const IDENTITY_TABLES = [
  "client_identities",
  "client_identity_workspaces",
  "client_identity_challenges",
  "client_identity_sessions",
] as const;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function environment() {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-migrate-"));
  roots.push(tmp);
  const cfgPath = join(tmp, "config.yaml");
  const cfg = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  return { tmp, cfgPath, cfg, dbPath: join(tmp, "bus", "floe-bus.sqlite") };
}

function tableNames(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  ).all() as Array<{ name: string }>;
  db.close();
  return rows.map((row) => row.name);
}

describe("client identity schema on an existing install", () => {
  // Reproduces the defect that shipped: client identity tables were added inside
  // migrate() but the recorded schema version was never bumped past 14, so every
  // database already stamped at 14 never received them and `identity add` failed
  // with `no such table: client_identities`. A fresh database passed every test.
  it("adds the identity tables to a database that predates them", () => {
    const env = environment();

    // Build a real, complete database, then rewind it to look like an existing
    // install from before the identity tables existed.
    const seed = new BusStore(env.cfgPath, env.cfg);
    seed.close();
    for (const name of IDENTITY_TABLES) {
      expect(tableNames(env.dbPath)).toContain(name);
    }

    const raw = new DatabaseSync(env.dbPath);
    for (const name of [...IDENTITY_TABLES].reverse()) {
      raw.exec(`DROP TABLE IF EXISTS ${name};`);
    }
    raw.exec("PRAGMA user_version = 14;");
    raw.close();
    for (const name of IDENTITY_TABLES) {
      expect(tableNames(env.dbPath)).not.toContain(name);
    }

    // Reopening the existing install must restore the tables automatically.
    const reopened = new BusStore(env.cfgPath, env.cfg);
    reopened.close();
    for (const name of IDENTITY_TABLES) {
      expect(tableNames(env.dbPath)).toContain(name);
    }
  });
});
