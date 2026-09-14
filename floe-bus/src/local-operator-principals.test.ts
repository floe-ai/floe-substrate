import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteLocalOperatorPrincipalStore } from "./local-operator-principals.js";

describe("local operator principal identity", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("creates one opaque principal that contains no host identity", () => {
    const db = new DatabaseSync(":memory:");
    let factoryCalls = 0;
    const store = new SqliteLocalOperatorPrincipalStore(db, {
      now: () => "2026-09-04T06:00:00.000Z",
      principal_id_factory: () => {
        factoryCalls += 1;
        return "principal:local-operator:opaque-identity";
      },
    });
    const first = store.getOrCreate();
    const second = store.getOrCreate();

    expect(first).toEqual({
      principal_id: "principal:local-operator:opaque-identity",
      purpose: "local_interactive_operator",
      created_at: "2026-09-04T06:00:00.000Z",
    });
    expect(second).toEqual(first);
    expect(factoryCalls).toBe(1);
    expect(first.principal_id).not.toContain("host:");
    db.close();
  });

  it("preserves the operator principal across Bus restart and host credential rotation", () => {
    const root = mkdtempSync(join(tmpdir(), "floe-local-operator-"));
    roots.push(root);
    const path = join(root, "bus.sqlite");
    const firstDb = new DatabaseSync(path);
    const first = new SqliteLocalOperatorPrincipalStore(firstDb, {
      now: () => "2026-09-04T06:00:00.000Z",
      principal_id_factory: () => "principal:local-operator:persisted",
    }).getOrCreate();
    firstDb.close();

    const reopenedDb = new DatabaseSync(path);
    const reopened = new SqliteLocalOperatorPrincipalStore(reopenedDb, {
      principal_id_factory: () => "principal:local-operator:must-not-replace",
    }).getOrCreate();
    expect(reopened).toEqual(first);
    reopenedDb.close();
  });
});
