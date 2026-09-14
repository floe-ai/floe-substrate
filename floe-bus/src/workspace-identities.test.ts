import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  SqliteWorkspaceIdentityStore,
  WorkspaceExplicitRebindRequiredError,
  WorkspaceIdentityConflictError,
  WorkspaceIdentityMigrationPlanStaleError,
  WorkspaceIdentityMigrationRefusedError,
  WorkspaceLocatorConflictError,
  applyWorkspaceIdentityMigration,
  getOrCreateLocalHostIdentity,
  normalizeWorkspaceLocator,
  planWorkspaceIdentityMigration,
  type WorkspaceIdentityRecord,
} from "./workspace-identities.js";

describe("portable Workspace identity", () => {
  it("uses a stable opaque installation identity without deriving it from machine details", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const first = getOrCreateLocalHostIdentity(db, {
        host_id_factory: () => "host_generated_once",
        now: () => "2026-09-03T00:00:00.000Z",
      });
      const second = getOrCreateLocalHostIdentity(db, {
        host_id_factory: () => "host_must_not_replace_existing",
        now: () => "2026-09-04T00:00:00.000Z",
      });

      expect(first).toEqual({
        host_id: "host_generated_once",
        created_at: "2026-09-03T00:00:00.000Z",
      });
      expect(second).toEqual(first);
    } finally {
      db.close();
    }
  });

  it("allocates an opaque identity independently of its local path", () => {
    const { db, store } = newCurrentStore();
    try {
      const workspace = store.createWorkspace({
      name: "Acme",
      binding: windowsBinding("C:\\Development\\Acme"),
      });

      expect(workspace.workspace_id).toBe("workspace_test_1");
      expect(workspace.workspace_id).not.toContain("Development");
      expect(store.getLocalProjection(workspace.workspace_id, "host_windows")?.binding?.locator)
      .toBe("C:\\Development\\Acme");
    } finally {
      db.close();
    }
  });

  it("treats Windows case, separator, dot, and trailing-slash variants as one location", () => {
    const { db, store } = newCurrentStore();
    try {
      const workspace = store.createWorkspace({
        name: "Floe",
        binding: windowsBinding("C:\\Development\\AI-Powered\\Floe\\"),
      });

      expect(store.resolveWorkspaceByLocator(
        "host_windows",
        "windows",
        "c:/development/ai-powered/./FLOE",
      )?.workspace_id).toBe(workspace.workspace_id);

      expect(() => store.createWorkspace({
        name: "Duplicate",
        binding: windowsBinding("c:/DEVELOPMENT/ai-powered/floe/"),
      })).toThrow(WorkspaceLocatorConflictError);
      expect(store.listLocalProjections("host_windows")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("requires an explicit compare-and-swap rebind when a Workspace moves", () => {
    const { db, store } = newCurrentStore();
    try {
      const workspace = store.createWorkspace({
        name: "Moved Workspace",
        binding: windowsBinding("C:\\Before"),
      });
      const first = store.getCurrentBinding(workspace.workspace_id, "host_windows")!;

      expect(() => store.bindLocator(
        workspace.workspace_id,
        windowsBinding("D:\\After"),
      )).toThrow(WorkspaceExplicitRebindRequiredError);

      const rebound = store.rebindLocator({
        workspace_id: workspace.workspace_id,
        host_id: "host_windows",
        platform: "windows",
        locator: "D:\\After",
        expected_binding_id: first.binding_id,
        init_authorized: true,
      });

      expect(rebound.workspace_id).toBe(workspace.workspace_id);
      expect(rebound.binding_id).not.toBe(first.binding_id);
      expect(rebound.status).toBe("registered");
      expect(rebound.active_config_hash).toBeNull();
      expect(rebound.init_authorized).toBe(true);
      expect(store.resolveWorkspaceByLocator("host_windows", "windows", "C:\\Before")).toBeNull();
      expect(store.resolveWorkspaceByLocator("host_windows", "windows", "d:/after")?.workspace_id)
        .toBe(workspace.workspace_id);

      const history = store.listBindingHistory(workspace.workspace_id, "host_windows");
      expect(history.map((binding) => binding.state)).toEqual(["superseded", "current"]);
      expect(history[0]?.superseded_by_binding_id).toBe(rebound.binding_id);
    } finally {
      db.close();
    }
  });

  it("does not retire the current binding when the requested destination belongs to another Workspace", () => {
    const { db, store } = newCurrentStore();
    try {
      const first = store.createWorkspace({ name: "First", binding: windowsBinding("C:\\First") });
      store.createWorkspace({ name: "Second", binding: windowsBinding("D:\\Occupied") });
      const originalBinding = store.getCurrentBinding(first.workspace_id, "host_windows")!;

      expect(() => store.rebindLocator({
        workspace_id: first.workspace_id,
        host_id: "host_windows",
        platform: "windows",
        locator: "d:/occupied",
        expected_binding_id: originalBinding.binding_id,
      })).toThrow(WorkspaceLocatorConflictError);

      expect(store.getCurrentBinding(first.workspace_id, "host_windows")?.binding_id)
        .toBe(originalBinding.binding_id);
      expect(store.listBindingHistory(first.workspace_id, "host_windows")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("restores an exported Workspace on another machine without changing its identity", () => {
    const source = newCurrentStore();
    const destination = newCurrentStore("restored_binding");
    try {
      const original = source.store.createWorkspace({
      name: "Portable Acme",
      binding: windowsBinding("C:\\Source\\Acme"),
      });
      const snapshot = source.store.getIdentity(original.workspace_id)!;

      const restored = destination.store.restoreWorkspace({
        snapshot,
        binding: {
          host_id: "host_linux",
          platform: "posix",
        locator: "/srv/floe/acme",
        },
      });

      expect(restored.workspace_id).toBe(original.workspace_id);
      expect(restored.created_at).toBe(original.created_at);
      expect(destination.store.resolveWorkspaceByLocator(
        "host_linux",
        "posix",
      "/srv/floe/acme/",
      )?.workspace_id).toBe(original.workspace_id);
    } finally {
      source.db.close();
      destination.db.close();
    }
  });

  it("refuses to overwrite different retained provenance during restore", () => {
    const { db, store } = newCurrentStore();
    try {
      const existing = store.createWorkspace({ name: "Existing" });
      const conflicting: WorkspaceIdentityRecord = {
        ...existing,
        created_at: "2025-01-01T00:00:00.000Z",
      };

      expect(() => store.restoreWorkspace({ snapshot: conflicting }))
        .toThrow(WorkspaceIdentityConflictError);
    } finally {
      db.close();
    }
  });

  it("gives copies and forks new identities while retaining their source relationship", () => {
    const { db, store } = newCurrentStore();
    try {
      const source = store.createWorkspace({ name: "Source" });
      const copy = store.createDerivedWorkspace({
        source_workspace_id: source.workspace_id,
        kind: "copied",
        name: "Independent Copy",
        binding: windowsBinding("C:\\Copy"),
      });
      const fork = store.createDerivedWorkspace({
        source_workspace_id: source.workspace_id,
        kind: "forked",
        name: "Experiment Fork",
        binding: windowsBinding("C:\\Fork"),
      });

      expect(new Set([source.workspace_id, copy.workspace_id, fork.workspace_id]).size).toBe(3);
      expect(copy).toMatchObject({ creation_kind: "copied", source_workspace_id: source.workspace_id });
      expect(fork).toMatchObject({ creation_kind: "forked", source_workspace_id: source.workspace_id });
    } finally {
      db.close();
    }
  });

  it("omits current and historical host paths from every remote projection", () => {
    const { db, store } = newCurrentStore();
    try {
      const workspace = store.createWorkspace({
        name: "Private Path",
        binding: windowsBinding("C:\\Users\\operator\\Secret Project"),
      });
      const first = store.getCurrentBinding(workspace.workspace_id, "host_windows")!;
      store.rebindLocator({
        workspace_id: workspace.workspace_id,
        host_id: "host_windows",
        platform: "windows",
        locator: "D:\\Moved Secret Project",
        expected_binding_id: first.binding_id,
      });

      const remote = store.listRemoteProjections("host_windows");
      const serialized = JSON.stringify(remote);
      expect(remote[0]?.availability).toEqual({
        bound_on_serving_host: true,
        status: "registered",
      });
      expect(serialized).not.toContain("C:\\\\Users");
      expect(serialized).not.toContain("Moved Secret Project");
      expect(serialized).not.toContain("host_windows");
      expect(collectKeys(remote)).not.toContain("locator");
      expect(collectKeys(remote)).not.toContain("normalized_locator");
      expect(collectKeys(remote)).not.toContain("binding_id");
      expect(collectKeys(remote)).not.toContain("host_id");
    } finally {
      db.close();
    }
  });

  it("rejects late attachment state from a superseded local path", () => {
    const { db, store } = newCurrentStore();
    try {
      const workspace = store.createWorkspace({
        name: "Callback safety",
        binding: windowsBinding("C:\\Before"),
      });
      const before = store.getCurrentBinding(workspace.workspace_id, "host_windows")!;
      const after = store.rebindLocator({
        workspace_id: workspace.workspace_id,
        host_id: "host_windows",
        platform: "windows",
        locator: "D:\\After",
        expected_binding_id: before.binding_id,
      });

      expect(() => store.updateCurrentBinding({
        workspace_id: workspace.workspace_id,
        host_id: "host_windows",
        expected_binding_id: before.binding_id,
        status: "attached",
        active_config_hash: "stale-observation",
      })).toThrow("location changed");
      expect(store.getCurrentBinding(workspace.workspace_id, "host_windows")).toMatchObject({
        binding_id: after.binding_id,
        status: "registered",
        active_config_hash: null,
      });
    } finally {
      db.close();
    }
  });

  it("keeps local selection on the host binding rather than portable identity", () => {
    const { db, store } = newCurrentStore();
    try {
      const first = store.createWorkspace({ name: "First", binding: windowsBinding("C:\\First") });
      const second = store.createWorkspace({ name: "Second", binding: windowsBinding("C:\\Second") });
      store.selectLocalWorkspace(first.workspace_id, "host_windows");
      store.selectLocalWorkspace(second.workspace_id, "host_windows");

      expect(store.getCurrentBinding(first.workspace_id, "host_windows")?.selected_at).toBeNull();
      expect(store.getCurrentBinding(second.workspace_id, "host_windows")?.selected_at).not.toBeNull();
      expect(store.getIdentity(second.workspace_id)).not.toHaveProperty("selected_at");
      expect(store.getRemoteProjection(second.workspace_id, "host_windows")).not.toHaveProperty("selected_at");
    } finally {
      db.close();
    }
  });
});

describe("legacy Workspace identity migration", () => {
  it("retains every existing opaque ID and moves local state into host bindings exactly once", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    createLegacyWorkspaceSchema(db);
    insertLegacyWorkspace(db, {
      workspace_id: "workspace:158878416ce47ff1",
      name: "Acme",
      locator: "C:\\Development\\Acme",
      status: "attached",
      init_authorized: 1,
      active_config_hash: "config-hash",
      selected_at: "2026-09-03T02:00:00.000Z",
    });
    insertLegacyWorkspace(db, {
      workspace_id: "workspace:old-opaque-id",
      name: "Other",
      locator: "D:\\Other",
      status: "registered",
      init_authorized: 0,
      active_config_hash: null,
      selected_at: null,
    });

    try {
      const plan = planWorkspaceIdentityMigration(db, {
        host_id: "desktop_installation_1",
        platform: "windows",
      });
      expect(plan.kind).toBe("migrate_legacy");
      expect(plan.actions.map((action) => action.workspace.workspace_id)).toEqual([
        "workspace:158878416ce47ff1",
        "workspace:old-opaque-id",
      ]);

      const applied = applyWorkspaceIdentityMigration(db, plan);
      expect(applied.migrated_workspace_ids).toEqual([
        "workspace:158878416ce47ff1",
        "workspace:old-opaque-id",
      ]);
      expect(workspaceColumnNames(db)).not.toContain("locator");

      const store = new SqliteWorkspaceIdentityStore(db);
      expect(store.getIdentity("workspace:158878416ce47ff1")).toMatchObject({
        workspace_id: "workspace:158878416ce47ff1",
        creation_kind: "legacy_retained",
        source_workspace_id: null,
      });
      expect(store.getCurrentBinding(
        "workspace:158878416ce47ff1",
        "desktop_installation_1",
      )).toMatchObject({
        locator: "C:\\Development\\Acme",
        normalized_locator: "c:\\development\\acme",
        status: "attached",
        init_authorized: true,
        active_config_hash: "config-hash",
        selected_at: "2026-09-03T02:00:00.000Z",
      });

      const secondPlan = planWorkspaceIdentityMigration(db, {
        host_id: "desktop_installation_1",
        platform: "windows",
      });
      expect(secondPlan.kind).toBe("already_current");
      expect(applyWorkspaceIdentityMigration(db, secondPlan)).toEqual({
        changed: false,
        migrated_workspace_ids: [],
      });
      expect(store.listBindingHistory(
        "workspace:158878416ce47ff1",
        "desktop_installation_1",
      )).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("refuses ambiguous legacy Windows path variants without changing the old table", () => {
    const db = new DatabaseSync(":memory:");
    createLegacyWorkspaceSchema(db);
    insertLegacyWorkspace(db, {
      workspace_id: "workspace:first",
      name: "First",
      locator: "C:\\Projects\\Floe",
      status: "attached",
      init_authorized: 1,
      active_config_hash: null,
      selected_at: null,
    });
    insertLegacyWorkspace(db, {
      workspace_id: "workspace:second",
      name: "Second",
      locator: "c:/projects/./FLOE/",
      status: "registered",
      init_authorized: 0,
      active_config_hash: null,
      selected_at: null,
    });

    try {
      const plan = planWorkspaceIdentityMigration(db, {
        host_id: "desktop_installation_1",
        platform: "windows",
      });
      expect(plan.kind).toBe("blocked");
      expect(plan.refusals).toContainEqual(expect.objectContaining({
        code: "normalized_locator_conflict",
        workspace_ids: ["workspace:first", "workspace:second"],
      }));
      expect(() => applyWorkspaceIdentityMigration(db, plan))
        .toThrow(WorkspaceIdentityMigrationRefusedError);
      expect(workspaceColumnNames(db)).toContain("locator");
      expect(Number((db.prepare("SELECT COUNT(*) AS count FROM workspaces").get() as { count: number }).count))
        .toBe(2);
    } finally {
      db.close();
    }
  });

  it("rejects a stale migration plan instead of applying it to changed state", () => {
    const db = new DatabaseSync(":memory:");
    createLegacyWorkspaceSchema(db);
    insertLegacyWorkspace(db, {
      workspace_id: "workspace:first",
      name: "First",
      locator: "C:\\First",
      status: "registered",
      init_authorized: 0,
      active_config_hash: null,
      selected_at: null,
    });

    try {
      const plan = planWorkspaceIdentityMigration(db, {
        host_id: "desktop_installation_1",
        platform: "windows",
      });
      db.prepare("UPDATE workspaces SET name = ? WHERE workspace_id = ?")
        .run("Changed after inspection", "workspace:first");

      expect(() => applyWorkspaceIdentityMigration(db, plan))
        .toThrow(WorkspaceIdentityMigrationPlanStaleError);
      expect(workspaceColumnNames(db)).toContain("locator");
    } finally {
      db.close();
    }
  });

  it("creates the canonical schema idempotently for an empty database", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const initial = planWorkspaceIdentityMigration(db, {
        host_id: "new_host",
        platform: "posix",
      });
      expect(initial.kind).toBe("bootstrap");
      expect(applyWorkspaceIdentityMigration(db, initial).changed).toBe(true);

      const current = planWorkspaceIdentityMigration(db, {
        host_id: "new_host",
        platform: "posix",
      });
      expect(current.kind).toBe("already_current");
      expect(applyWorkspaceIdentityMigration(db, current).changed).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("Workspace locator normalization", () => {
  it("keeps POSIX paths case-sensitive and rejects drive-relative Windows locators", () => {
    expect(normalizeWorkspaceLocator("/srv/Floe/../floe/", "posix")).toBe("/srv/floe");
    expect(normalizeWorkspaceLocator("/srv/Floe", "posix")).toBe("/srv/Floe");
    expect(() => normalizeWorkspaceLocator("C:", "windows")).toThrow("an absolute path is required");
  });
});

function newCurrentStore(bindingPrefix = "binding") {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const plan = planWorkspaceIdentityMigration(db, { host_id: "bootstrap", platform: "windows" });
  applyWorkspaceIdentityMigration(db, plan);
  let workspaceSequence = 0;
  let bindingSequence = 0;
  let timeSequence = 0;
  const store = new SqliteWorkspaceIdentityStore(db, {
    workspace_id_factory: () => `workspace_test_${++workspaceSequence}`,
    binding_id_factory: () => `${bindingPrefix}_${++bindingSequence}`,
    now: () => `2026-09-03T00:00:${String(timeSequence++).padStart(2, "0")}.000Z`,
  });
  return { db, store };
}

function windowsBinding(locator: string) {
  return {
    host_id: "host_windows",
    platform: "windows" as const,
    locator,
    init_authorized: false,
  };
}

function createLegacyWorkspaceSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE workspaces (
      workspace_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      locator TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      init_authorized INTEGER NOT NULL DEFAULT 0,
      active_config_hash TEXT,
      selected_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function insertLegacyWorkspace(
  db: DatabaseSync,
  input: Readonly<{
    workspace_id: string;
    name: string;
    locator: string;
    status: string;
    init_authorized: number;
    active_config_hash: string | null;
    selected_at: string | null;
  }>,
): void {
  db.prepare(`
    INSERT INTO workspaces (
      workspace_id, name, locator, status, init_authorized, active_config_hash,
      selected_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.workspace_id,
    input.name,
    input.locator,
    input.status,
    input.init_authorized,
    input.active_config_hash,
    input.selected_at,
    "2026-08-01T00:00:00.000Z",
    "2026-09-01T00:00:00.000Z",
  );
}

function workspaceColumnNames(db: DatabaseSync): string[] {
  return (db.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).map((row) => row.name);
}

function collectKeys(value: unknown, target = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, target);
    return target;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      target.add(key);
      collectKeys(item, target);
    }
  }
  return target;
}
