import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyCapabilityGrantSchema,
  rebuildCapabilityGrantsForUntilRevoked,
  SqliteCapabilityGrantStore,
} from "./capability-grants.js";
import { runDatabaseUpgrade } from "./database-upgrade.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

/** The grant table exactly as released databases declared it: expiry required. */
function openReleasedDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "floe-grant-upgrade-"));
  const path = join(dir, "floe-bus.sqlite");
  const db = new DatabaseSync(path);
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`CREATE TABLE capability_grants (
      grant_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      boundary_kind TEXT NOT NULL CHECK (boundary_kind IN ('workspace', 'host')),
      boundary_id TEXT NOT NULL CHECK (length(trim(boundary_id)) > 0),
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      issuer_id TEXT NOT NULL,
      evidence_json TEXT NOT NULL
    );`);
  applyCapabilityGrantSchema(db);
  db.exec("PRAGMA user_version = 15");
  return { db, path };
}

describe("upgrading grants to allow until-revoked authority", () => {
  it("keeps every grant, child row and delegation link, and then accepts until-revoked grants", () => {
    const { db, path } = openReleasedDatabase();
    const now = "2026-09-20T10:00:00.000Z";
    const store = new SqliteCapabilityGrantStore(db, { now: () => now });
    const boundary = { kind: "workspace" as const, workspace_id: "workspace:upgrade" };
    const base = { boundary, expires_at: "2099-01-01T00:00:00.000Z", issuer_id: "policy:test",
      evidence: [{ kind: "policy", ref: "upgrade" }] };
    const source = store.issueGrant({ ...base, principal_id: "principal:a",
      operation_ids: ["context.inspect", "capability.grant.delegate"], targets: [{ kind: "actor", id: null }] });
    const session = { principal_id: "principal:a", boundary, grant_ids: [source.grant_id],
      interaction: { mode: "unattended" as const, session_id: "s", confirmed_prompts: [], approval_refs: [] } };
    const recipient = { kind: "actor", id: "actor:b" };
    const child = store.delegateGrant({ authority: store.resolveSessionAuthority(session, recipient).authority,
      source_grant_id: source.grant_id, principal_id: recipient.id, recipient, operation_ids: ["context.inspect"],
      targets: [{ kind: "actor", id: "actor:b" }], expires_at: base.expires_at, invocation_id: "i" });
    const before = [store.getGrant(source.grant_id), store.getGrant(child.grant_id)];

    const result = runDatabaseUpgrade({ db, database_path: path, target_version: 16,
      migrate: () => applyCapabilityGrantSchema(db),
      rebuild: () => { rebuildCapabilityGrantsForUntilRevoked(db); } });

    expect(result.backup_path).not.toBeNull();
    const expiry = (db.prepare("PRAGMA table_info(capability_grants)").all() as Array<{ name: string; notnull: number }>)
      .find(column => column.name === "expires_at");
    expect(expiry?.notnull).toBe(0);
    expect(Number((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys)).toBe(1);
    expect([store.getGrant(source.grant_id), store.getGrant(child.grant_id)]).toEqual(before);
    expect(store.getDelegation(child.grant_id)).toEqual({ source_grant_id: source.grant_id, authority_grant_id: source.grant_id });

    const forever = store.issueGrant({ ...base, expires_at: null, principal_id: "principal:c", operation_ids: ["context.inspect"] });
    expect(store.getGrant(forever.grant_id)?.expires_at).toBeNull();
    store.revokeGrant(source.grant_id);
    expect(store.listActiveGrantsForPrincipalBoundary(recipient.id, boundary)).toEqual([]);
    expect(() => db.prepare("DELETE FROM capability_grants WHERE grant_id = ?").run(source.grant_id))
      .toThrow(/FOREIGN KEY/);
    expect(rebuildCapabilityGrantsForUntilRevoked(db)).toBe(false);
  });
});
