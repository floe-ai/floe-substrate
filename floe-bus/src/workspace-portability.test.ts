import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_BUS_SCHEMA_VERSION } from "./database-upgrade.js";

import {
  WORKSPACE_BUNDLE_RESTORE_SEMANTICS,
  WorkspacePortabilityError,
  WorkspacePortabilityService,
} from "./workspace-portability.js";

const opened: DatabaseSync[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

describe("canonical portable Workspace package", () => {
  it("exports deterministically and restores exact identity, lineage, history and waits without host credentials or automatic effects", () => {
    const root = mkdtempSync(join(tmpdir(), "floe-portability-"));
    const sourceRoot = join(root, "source", "C-drive-workspace");
    const targetRoot = join(root, "target", "restored-workspace");
    const bundles = join(root, "bundles");
    mkdirSync(join(sourceRoot, "inputs"), { recursive: true });
    const content = Buffer.from("portable exact content", "utf8");
    writeFileSync(join(sourceRoot, "inputs", "concept.txt"), content);
    const contentDigest = sha256(content);

    const sourcePath = join(root, "source", "source.sqlite");
    const source = fixtureDatabase(sourcePath);
    seedCompleteWorkspace(source, sourceRoot, contentDigest, content.length);
    seedCollidingOtherWorkspace(source);
    const exporter = new WorkspacePortabilityService({
      db: source,
      database_path: sourcePath,
      bundle_root: bundles,
      workspace_locator: (workspaceId) => workspaceId === "workspace_alpha" ? sourceRoot : null,
      now: () => "2026-09-04T01:00:00.000Z",
    });

    const first = exporter.exportWorkspace("workspace_alpha");
    const second = exporter.exportWorkspace("workspace_alpha");
    expect(second.bundle_id).toBe(first.bundle_id);
    expect(second.bundle_digest).toBe(first.bundle_digest);
    expect(second.manifest.records.map((item) => item.table)).toEqual(
      [...second.manifest.records.map((item) => item.table)].sort(),
    );
    expect(second.manifest.restore_semantics).toEqual(WORKSPACE_BUNDLE_RESTORE_SEMANTICS);
    expect(second.manifest.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        artefact_version_id: "artefact_version_source",
        mode: "included",
        digest: contentDigest,
      }),
      expect.objectContaining({
        artefact_version_id: "artefact_version_result",
        mode: "unresolved",
      }),
    ]));

    const serialized = collectBundleText(first.bundle_directory);
    expect(serialized).not.toContain(sourceRoot);
    expect(serialized).not.toContain("/home/source/private.txt");
    expect(serialized).not.toContain("super-secret-broker-locator");
    expect(serialized).not.toContain("sk_abcdefghijklmnopqrstuvwxyz");
    expect(serialized).not.toContain("BETA_ONLY_RELATION_MARKER");
    expect(serialized).not.toContain("workspace_beta");
    expect(serialized).not.toContain("command_worker_principal_source");
    expect(serialized).not.toContain("command_worker_endpoint_source");
    expect(serialized).toContain("credential-redacted");
    expect(first.manifest.unresolved_dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "secret_ref", resource_id: "secret_openai" }),
      expect.objectContaining({ kind: "endpoint_attachment", resource_id: "endpoint_builder" }),
      expect.objectContaining({ kind: "actor_runtime", resource_id: "actor_runtime_binding_builder" }),
      expect.objectContaining({ kind: "connector_runtime", resource_id: "connector_binding_source" }),
      expect.objectContaining({ kind: "extension_runtime", resource_id: "extension_installation_tools" }),
    ]));

    const targetPath = join(root, "target", "target.sqlite");
    const target = fixtureDatabase(targetPath);
    const restorer = new WorkspacePortabilityService({
      db: target,
      database_path: targetPath,
      bundle_root: bundles,
      workspace_locator: () => null,
      now: () => "2026-09-04T02:00:00.000Z",
    });
    const restored = restorer.restoreWorkspace({
      bundle_directory: first.bundle_directory,
      workspace_locator: targetRoot,
    });
    expect(restored).toEqual(expect.objectContaining({
      workspace_id: "workspace_alpha",
      bundle_id: first.bundle_id,
      bundle_digest: first.bundle_digest,
      state: "held",
      backup_path: null,
    }));
    expect(restored.inserted_record_count).toBeGreaterThan(20);

    expect(row(target, "SELECT * FROM workspaces")).toEqual(expect.objectContaining({
      workspace_id: "workspace_alpha",
      creation_kind: "created",
    }));
    expect(row(target, "SELECT * FROM scopes")).toEqual(expect.objectContaining({
      scope_id: "scope_pipeline",
      published_revision_id: "scope_revision_1",
    }));
    expect(row(target, "SELECT * FROM scope_executions")).toEqual(expect.objectContaining({
      execution_id: "scope_execution_1",
      revision_id: "scope_revision_1",
      status: "waiting_external",
    }));
    expect(row(target, "SELECT * FROM node_executions")).toEqual(expect.objectContaining({
      node_execution_id: "node_execution_1",
      context_id: "context_pipeline",
      status: "waiting",
    }));
    expect(row(target, "SELECT * FROM event_queue")).toEqual(expect.objectContaining({
      queue_id: "queue_1",
      state: "queued",
    }));
    expect(row(target, "SELECT * FROM delivery_bundles")).toEqual(expect.objectContaining({
      delivery_id: "delivery_1",
      state: "reserved",
    }));
    expect(row(target, "SELECT * FROM pending_responses")).toEqual(expect.objectContaining({
      pending_id: "pending_1",
      status: "pending",
    }));
    expect(row(target, "SELECT * FROM external_effect_receipts")).toEqual(expect.objectContaining({
      external_effect_receipt_id: "external_effect_1",
      status: "succeeded",
      idempotency_key: "external-once",
    }));
    expect(row(target, "SELECT * FROM artefact_lineage")).toEqual(expect.objectContaining({
      subject_version_id: "artefact_version_result",
      object_version_id: "artefact_version_source",
    }));
    expect(row(target, "SELECT * FROM endpoints")).toEqual(expect.objectContaining({
      endpoint_id: "endpoint_builder",
      bridge_id: null,
      status: "offline",
    }));
    expect(row(target, "SELECT * FROM secret_refs")).toEqual(expect.objectContaining({
      secret_ref_id: "secret_openai",
      resolution: "unresolved",
      broker_id: null,
      broker_locator: null,
    }));
    expect(row(target, "SELECT status FROM connector_bindings")).toEqual({ status: "enabled" });
    expect(row(target, "SELECT lifecycle FROM extension_installations")).toEqual({ lifecycle: "enabled" });
    expect(restorer.getRestoreHold("workspace_alpha")).toEqual(expect.objectContaining({
      state: "held",
      bundle_digest: first.bundle_digest,
    }));
    expect(() => restorer.releaseRestoreHold({
      workspace_id: "workspace_alpha",
      expected_bundle_digest: first.bundle_digest,
      principal_id: "principal_operator_target",
    })).toThrowError(expect.objectContaining({ code: "restore_dependencies_unresolved" }));

    const restoredContent = row(target, "SELECT content_ref_json FROM artefact_versions WHERE artefact_version_id = 'artefact_version_source'");
    const contentRef = JSON.parse(String(restoredContent.content_ref_json)) as { path: string };
    expect(contentRef.path).toBe(`.floe/portable-content/sha256/${contentDigest}`);
    expect(readFileSync(join(targetRoot, ...contentRef.path.split("/")))).toEqual(content);

    const replay = restorer.restoreWorkspace({
      bundle_directory: first.bundle_directory,
      workspace_locator: targetRoot,
    });
    expect(replay.inserted_record_count).toBe(0);
    expect(Number(row(target, "SELECT COUNT(*) AS count FROM external_effect_receipts").count)).toBe(1);
    expect(Number(row(target, "SELECT COUNT(*) AS count FROM event_queue").count)).toBe(1);
    expect(Number(row(target, "SELECT COUNT(*) AS count FROM operation_invocation_ledger").count)).toBe(1);
  });

  it("refuses a record collision before changing retained state", () => {
    const root = mkdtempSync(join(tmpdir(), "floe-portability-collision-"));
    const sourceRoot = join(root, "source-workspace");
    mkdirSync(join(sourceRoot, "inputs"), { recursive: true });
    const bytes = Buffer.from("exact", "utf8");
    writeFileSync(join(sourceRoot, "inputs", "concept.txt"), bytes);
    const sourcePath = join(root, "source.sqlite");
    const source = fixtureDatabase(sourcePath);
    seedCompleteWorkspace(source, sourceRoot, sha256(bytes), bytes.length);
    const bundles = join(root, "bundles");
    const bundle = new WorkspacePortabilityService({
      db: source,
      database_path: sourcePath,
      bundle_root: bundles,
      workspace_locator: () => sourceRoot,
    }).exportWorkspace("workspace_alpha");

    const targetPath = join(root, "target.sqlite");
    const target = fixtureDatabase(targetPath);
    target.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)").run(
      "workspace_alpha", "Conflicting identity", "created", null,
      "2026-09-04T00:00:00.000Z", "2026-09-04T00:00:00.000Z",
    );
    const restorer = new WorkspacePortabilityService({
      db: target,
      database_path: targetPath,
      bundle_root: bundles,
      workspace_locator: () => null,
    });
    expect(() => restorer.restoreWorkspace({
      bundle_directory: bundle.bundle_directory,
      workspace_locator: join(root, "restore"),
    })).toThrowError(expect.objectContaining({ code: "restore_identity_collision" }));
    expect(Number(row(target, "SELECT COUNT(*) AS count FROM scopes").count)).toBe(0);
    expect(row(target, "SELECT name FROM workspaces").name).toBe("Conflicting identity");
  });

  it("releases restored work only after exact new local dependency evidence is reconciled", () => {
    const root = mkdtempSync(join(tmpdir(), "floe-portability-recovery-"));
    const sourceRoot = join(root, "source-workspace");
    const targetRoot = join(root, "target-workspace");
    mkdirSync(join(sourceRoot, "inputs"), { recursive: true });
    const bytes = Buffer.from("portable recovery content", "utf8");
    const recoveredExternalBytes = Buffer.from("exact recovered external content", "utf8");
    const recoveredExternalPath = join(root, "operator-selected-recovery.bin");
    writeFileSync(recoveredExternalPath, recoveredExternalBytes);
    writeFileSync(join(sourceRoot, "inputs", "concept.txt"), bytes);
    const sourcePath = join(root, "source.sqlite");
    const source = fixtureDatabase(sourcePath);
    seedCompleteWorkspace(source, sourceRoot, sha256(bytes), bytes.length, sha256(recoveredExternalBytes));
    const bundles = join(root, "bundles");
    const bundle = new WorkspacePortabilityService({
      db: source,
      database_path: sourcePath,
      bundle_root: bundles,
      workspace_locator: () => sourceRoot,
      now: () => "2026-09-04T01:00:00.000Z",
    }).exportWorkspace("workspace_alpha");
    expect(bundle.manifest.unresolved_dependencies.map((item) => item.kind).sort()).toEqual([
      "actor_runtime", "command_runtime", "connector_runtime", "content", "endpoint_attachment", "extension_runtime", "secret_ref",
    ]);

    const targetPath = join(root, "target.sqlite");
    const target = fixtureDatabase(targetPath);
    const restorer = new WorkspacePortabilityService({
      db: target,
      database_path: targetPath,
      bundle_root: bundles,
      workspace_locator: () => targetRoot,
      now: () => "2026-09-04T03:00:00.000Z",
    });
    const restored = restorer.restoreWorkspace({
      bundle_directory: bundle.bundle_directory,
      workspace_locator: targetRoot,
    });
    expect(restorer.listUnresolvedDependencies("workspace_alpha")).toHaveLength(7);

    const contentDependency = bundle.manifest.unresolved_dependencies.find((item) => item.kind === "content")!;
    const supplied = restorer.supplyContentDependency({
      workspace_id: "workspace_alpha",
      expected_bundle_digest: restored.bundle_digest,
      dependency_id: contentDependency.dependency_id,
      source_path: recoveredExternalPath,
    });
    insertOperationReceipt(target, {
      receipt_id: "receipt_supply_content", invocation_id: "invocation_supply_content",
      operation_id: "workspace.package.supply_content", target_kind: "workspace",
      target_id: "workspace_alpha", result: supplied, completed_at: "2026-09-04T03:30:00.000Z",
      boundary_kind: "host", boundary_id: "host_target",
    });

    const recoveredAt = "2026-09-04T03:30:00.000Z";
    target.prepare(`
      UPDATE secret_refs SET resolution = 'resolved', broker_id = ?, broker_locator = ?, generation = generation + 1, updated_at = ?
      WHERE secret_ref_id = ?
    `).run("windows-dpapi", "target-host-protected-locator", recoveredAt, "secret_openai");
    insertOperationReceipt(target, {
      receipt_id: "receipt_rebind_secret", invocation_id: "invocation_rebind_secret",
      operation_id: "credential.bind", target_kind: "secret_ref", target_id: "secret_openai",
      changed_refs: [{ kind: "secret_ref", id: "secret_openai" }], completed_at: recoveredAt,
    });

    target.prepare("INSERT INTO bridges VALUES (?, ?, ?, ?, ?)").run(
      "bridge_target_host", "online", "{}", recoveredAt, recoveredAt,
    );
    target.prepare(`
      UPDATE endpoints SET bridge_id = ?, status = 'idle', updated_at = ? WHERE endpoint_id = ?
    `).run("bridge_target_host", recoveredAt, "endpoint_builder");

    target.prepare("INSERT INTO endpoints VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "command_worker_endpoint_target", "workspace_alpha", "Floe Command worker", null, null, "idle",
      JSON.stringify({ endpoint_kind: "command_worker", command_worker_binding_id: "command_worker_target", host_id: "host_target" }),
      recoveredAt, recoveredAt,
    );
    target.prepare("INSERT INTO command_worker_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "command_worker_target", "workspace_alpha", "host_target", "command_worker_endpoint_target",
      "command_worker_principal_target", "available", '["core_command_implementation"]', recoveredAt, recoveredAt,
    );

    target.prepare(`UPDATE actor_runtime_bindings SET superseded_at = ? WHERE actor_runtime_binding_id = ?`).run(
      recoveredAt, "actor_runtime_binding_builder",
    );
    target.prepare("INSERT INTO actor_runtime_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "actor_runtime_binding_target", "actor_builder", "workspace_alpha", "runtime_profile_builder",
      "runtime_profile_revision_1", "endpoint_builder", "resolved", "[]", "principal_operator", recoveredAt, null,
    );
    insertOperationReceipt(target, {
      receipt_id: "receipt_rebind_runtime", invocation_id: "invocation_rebind_runtime",
      operation_id: "actor.runtime-binding.replace", target_kind: "actor_runtime_binding",
      target_id: "actor_runtime_binding_builder",
      changed_refs: [{ kind: "actor_runtime_binding", id: "actor_runtime_binding_target" }],
      completed_at: recoveredAt,
    });

    target.prepare(`
      INSERT INTO connector_health_observations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "connector_health_target", "connector_binding_source", "connector_binding_revision_1",
      "workspace", "workspace_alpha", "healthy", null, "Target account verified", "[]", recoveredAt, recoveredAt,
    );
    insertOperationReceipt(target, {
      receipt_id: "receipt_connector_health", invocation_id: "invocation_connector_health",
      operation_id: "connector.health.record", target_kind: "connector_binding",
      target_id: "connector_binding_source",
      changed_refs: [{ kind: "connector_health_observation", id: "connector_health_target" }],
      completed_at: recoveredAt,
    });

    target.prepare(`
      INSERT INTO extension_activation_attempts VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      "extension_activation_target", "invocation_extension_enable", "workspace_alpha",
      "extension_installation_tools", "extension_package_1", "extension.enable", "principal_operator",
      "enabled", ".floe/extensions/tools", "3".repeat(64), "approval_target", "6".repeat(64),
      "[]", "completed", "{}", null, null, recoveredAt, recoveredAt,
    );
    insertOperationReceipt(target, {
      receipt_id: "receipt_extension_enable", invocation_id: "invocation_extension_enable",
      operation_id: "extension.enable", target_kind: "extension_installation",
      target_id: "extension_installation_tools",
      changed_refs: [{ kind: "extension_installation", id: "extension_installation_tools" }],
      completed_at: recoveredAt,
    });

    insertOperationReceipt(target, {
      receipt_id: "receipt_restore_reconcile", invocation_id: "invocation_restore_reconcile",
      operation_id: "workspace.package.reconcile_restore", target_kind: "workspace",
      target_id: "workspace_alpha", state: "running", completed_at: null,
    });
    const reconciliation = restorer.reconcileRestoreDependencies({
      workspace_id: "workspace_alpha",
      expected_bundle_digest: restored.bundle_digest,
      reconciliation_operation_receipt_id: "receipt_restore_reconcile",
    });
    expect(reconciliation.unresolved_dependencies).toEqual([]);
    expect(reconciliation.resolved_dependencies).toHaveLength(7);
    expect(row(target, `
      SELECT resolved_by_operation_receipt_id FROM workspace_portability_dependencies
      WHERE kind = 'endpoint_attachment'
    `)).toEqual({ resolved_by_operation_receipt_id: "receipt_restore_reconcile" });
    target.prepare(`
      UPDATE operation_invocation_ledger SET state = 'completed', completed_at = ?, updated_at = ?
      WHERE receipt_id = ?
    `).run(recoveredAt, recoveredAt, "receipt_restore_reconcile");

    const released = restorer.releaseRestoreHold({
      workspace_id: "workspace_alpha",
      expected_bundle_digest: restored.bundle_digest,
      principal_id: "principal_operator_target",
    });
    expect(released.state).toBe("released");
  }, 15_000);

  it("rolls back materialized content and canonical rows when a later database write fails", () => {
    const root = mkdtempSync(join(tmpdir(), "floe-portability-rollback-"));
    const sourceRoot = join(root, "source-workspace");
    const targetRoot = join(root, "target-workspace");
    mkdirSync(join(sourceRoot, "inputs"), { recursive: true });
    const bytes = Buffer.from("rollback exact content", "utf8");
    const digest = sha256(bytes);
    writeFileSync(join(sourceRoot, "inputs", "concept.txt"), bytes);
    const sourcePath = join(root, "source.sqlite");
    const source = fixtureDatabase(sourcePath);
    seedCompleteWorkspace(source, sourceRoot, digest, bytes.length);
    const bundles = join(root, "bundles");
    const bundle = new WorkspacePortabilityService({
      db: source,
      database_path: sourcePath,
      bundle_root: bundles,
      workspace_locator: () => sourceRoot,
    }).exportWorkspace("workspace_alpha");

    const targetPath = join(root, "target.sqlite");
    const target = fixtureDatabase(targetPath);
    const restorer = new WorkspacePortabilityService({
      db: target,
      database_path: targetPath,
      bundle_root: bundles,
      workspace_locator: () => null,
    });
    target.exec(`
      CREATE TRIGGER fail_restore_hold
      BEFORE INSERT ON workspace_restore_holds
      BEGIN
        SELECT RAISE(ABORT, 'simulated later restore failure');
      END
    `);

    expect(() => restorer.restoreWorkspace({
      bundle_directory: bundle.bundle_directory,
      workspace_locator: targetRoot,
    })).toThrow("simulated later restore failure");
    expect(existsSync(join(targetRoot, ".floe", "portable-content", "sha256", digest))).toBe(false);
    expect(Number(row(target, "SELECT COUNT(*) AS count FROM workspaces").count)).toBe(0);
    expect(Number(row(target, "SELECT COUNT(*) AS count FROM workspace_restore_holds").count)).toBe(0);
  }, 15_000);

  it("detects package tampering before restore", () => {
    const root = mkdtempSync(join(tmpdir(), "floe-portability-tamper-"));
    const sourceRoot = join(root, "source-workspace");
    mkdirSync(join(sourceRoot, "inputs"), { recursive: true });
    const bytes = Buffer.from("exact", "utf8");
    writeFileSync(join(sourceRoot, "inputs", "concept.txt"), bytes);
    const sourcePath = join(root, "source.sqlite");
    const source = fixtureDatabase(sourcePath);
    seedCompleteWorkspace(source, sourceRoot, sha256(bytes), bytes.length);
    const service = new WorkspacePortabilityService({
      db: source,
      database_path: sourcePath,
      bundle_root: join(root, "bundles"),
      workspace_locator: () => sourceRoot,
    });
    const bundle = service.exportWorkspace("workspace_alpha");
    writeFileSync(join(bundle.bundle_directory, "records", "events.jsonl"), "{}\n", "utf8");
    expect(() => service.validateBundle(bundle.bundle_directory)).toThrowError(
      expect.objectContaining({ code: "bundle_records_digest_mismatch" }),
    );
  });
});

function fixtureDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  opened.push(db);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA user_version = ${CURRENT_BUS_SCHEMA_VERSION};
    CREATE TABLE workspaces (
      workspace_id TEXT PRIMARY KEY, name TEXT NOT NULL, creation_kind TEXT NOT NULL,
      source_workspace_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE scopes (
      workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, published_revision_id TEXT,
      PRIMARY KEY (workspace_id, scope_id)
    );
    CREATE TABLE scope_composition_revisions (
      revision_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL, routing_mode TEXT NOT NULL, based_on_revision_id TEXT,
      semantic_digest TEXT NOT NULL, created_by_endpoint_id TEXT, created_at TEXT NOT NULL,
      published_at TEXT, withdrawn_at TEXT
    );
    CREATE TABLE scope_node_placements (
      revision_id TEXT NOT NULL, node_id TEXT NOT NULL, kind TEXT NOT NULL, label TEXT,
      resource_id TEXT, config_json TEXT NOT NULL, bindings_json TEXT NOT NULL,
      activation_json TEXT NOT NULL, context_policy_json TEXT NOT NULL,
      PRIMARY KEY (revision_id, node_id)
    );
    CREATE TABLE scope_ports (
      revision_id TEXT NOT NULL, port_id TEXT NOT NULL, node_id TEXT NOT NULL,
      name TEXT NOT NULL, direction TEXT NOT NULL, event_types_json TEXT NOT NULL,
      artefact_types_json TEXT NOT NULL, schema_ref TEXT, min_count INTEGER NOT NULL,
      max_count INTEGER, PRIMARY KEY (revision_id, port_id)
    );
    CREATE TABLE scope_edges (
      revision_id TEXT NOT NULL, edge_id TEXT NOT NULL, source_port_id TEXT NOT NULL,
      target_port_id TEXT NOT NULL, enabled INTEGER NOT NULL, priority INTEGER NOT NULL,
      policy_json TEXT NOT NULL, PRIMARY KEY (revision_id, edge_id)
    );
    CREATE TABLE contexts (
      context_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope_id TEXT,
      parent_context_id TEXT, created_by_endpoint_id TEXT, created_at TEXT NOT NULL,
      title TEXT, created_by_principal_id TEXT, updated_at TEXT, state_revision INTEGER,
      lifecycle_state TEXT, archived_at TEXT, archived_by_principal_id TEXT,
      archive_reason TEXT, restored_at TEXT, restored_by_principal_id TEXT,
      content_state TEXT, redacted_at TEXT, redacted_by_principal_id TEXT,
      redaction_reason TEXT, tombstoned_at TEXT, tombstoned_by_principal_id TEXT,
      tombstone_reason TEXT
    );
    CREATE TABLE context_participants (
      context_id TEXT NOT NULL, endpoint_id TEXT NOT NULL, joined_at TEXT NOT NULL,
      role TEXT, access TEXT, updated_at TEXT, actor_role_assignment_id TEXT,
      PRIMARY KEY (context_id, endpoint_id)
    );
    CREATE TABLE endpoints (
      endpoint_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
      agent_id TEXT, bridge_id TEXT, status TEXT NOT NULL, metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE bridges (
      bridge_id TEXT PRIMARY KEY, status TEXT NOT NULL, capabilities_json TEXT NOT NULL,
      last_seen_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY, type TEXT NOT NULL, workspace_id TEXT NOT NULL,
      source_endpoint_id TEXT, thread_id TEXT NOT NULL, scope_id TEXT, correlation_id TEXT,
      destination_json TEXT NOT NULL, content_json TEXT NOT NULL, response_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL, idempotency_key TEXT, created_at TEXT NOT NULL,
      destination_endpoint_id TEXT, context_id TEXT,
      artefact_version_ids_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE event_queue (
      queue_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      destination_endpoint_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
      delivery_id TEXT, lease_expires_at TEXT, attempt_count INTEGER, last_error TEXT,
      delivered_at TEXT, scope_execution_id TEXT, composition_revision_id TEXT,
      source_node_id TEXT, source_port_id TEXT, target_node_id TEXT, target_port_id TEXT,
      edge_id TEXT, node_execution_id TEXT, output_publication_id TEXT,
      actor_definition_revision_id TEXT, runtime_profile_revision_id TEXT,
      actor_runtime_binding_id TEXT
    );
    CREATE TABLE delivery_bundles (
      delivery_id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      trigger_event_id TEXT NOT NULL, events_json TEXT NOT NULL, state TEXT NOT NULL,
      lease_expires_at TEXT, attempt_count INTEGER, last_error TEXT, created_at TEXT NOT NULL,
      claimed_at TEXT, operation_authority_session_id TEXT, wait_id TEXT, resume_reason TEXT,
      stable_delivery_ids_json TEXT, execution_attempt_id TEXT,
      actor_definition_revision_id TEXT, runtime_profile_revision_id TEXT,
      actor_runtime_binding_id TEXT
    );
    CREATE TABLE pending_responses (
      pending_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, waiting_endpoint_id TEXT NOT NULL,
      source_event_id TEXT NOT NULL, mode TEXT NOT NULL, thread_id TEXT, correlation_id TEXT,
      timeout_at TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE TABLE scope_executions (
      execution_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL,
      revision_id TEXT NOT NULL, cause_event_id TEXT, root_event_id TEXT,
      ingress_node_id TEXT NOT NULL, ingress_port_id TEXT NOT NULL,
      initiator_endpoint_id TEXT, idempotency_key TEXT, parent_execution_id TEXT,
      redo_of_node_execution_id TEXT, state_revision INTEGER, status TEXT NOT NULL,
      environment_json TEXT NOT NULL, budget_json TEXT NOT NULL, terminal_json TEXT NOT NULL,
      created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, cancelled_at TEXT
    );
    CREATE TABLE node_executions (
      node_execution_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, revision_id TEXT NOT NULL,
      node_id TEXT NOT NULL, activation_key TEXT NOT NULL, join_key TEXT, context_id TEXT NOT NULL,
      actor_definition_revision_id TEXT, runtime_profile_revision_id TEXT,
      actor_runtime_binding_id TEXT, state_revision INTEGER, status TEXT NOT NULL,
      assigned_actor_ids_json TEXT NOT NULL, missing_port_ids_json TEXT NOT NULL,
      failure_json TEXT NOT NULL, created_at TEXT NOT NULL, activated_at TEXT,
      completed_at TEXT, cancelled_at TEXT
    );
    CREATE TABLE execution_attempts (
      attempt_id TEXT PRIMARY KEY, node_execution_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      delivery_id TEXT, delivery_bundle_id TEXT, actor_definition_revision_id TEXT,
      runtime_profile_revision_id TEXT, actor_runtime_binding_id TEXT, status TEXT NOT NULL,
      runtime_json TEXT NOT NULL, resource_use_json TEXT NOT NULL, result_json TEXT NOT NULL,
      error_json TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT
    );
    CREATE TABLE command_worker_bindings (
      command_worker_binding_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      host_id TEXT NOT NULL, worker_endpoint_id TEXT NOT NULL UNIQUE,
      worker_principal_id TEXT NOT NULL, status TEXT NOT NULL,
      supported_implementation_kinds_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, host_id)
    );
    CREATE TABLE command_attempt_contracts (
      attempt_id TEXT PRIMARY KEY, processing_contract_id TEXT NOT NULL UNIQUE,
      semantic_digest TEXT NOT NULL, command_definition_revision_id TEXT NOT NULL,
      command_worker_binding_id TEXT NOT NULL, contract_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE actors (
      actor_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, status TEXT NOT NULL,
      current_definition_revision_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      retired_at TEXT
    );
    CREATE TABLE actor_definition_revisions (
      actor_definition_revision_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL, revision_number INTEGER NOT NULL,
      based_on_revision_id TEXT, semantic_digest TEXT NOT NULL, content_json TEXT NOT NULL,
      created_by_principal_id TEXT NOT NULL, created_at TEXT NOT NULL,
      published_at TEXT, withdrawn_at TEXT
    );
    CREATE TABLE runtime_profiles (
      runtime_profile_id TEXT PRIMARY KEY, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
      current_revision_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, retired_at TEXT
    );
    CREATE TABLE runtime_profile_revisions (
      runtime_profile_revision_id TEXT PRIMARY KEY, runtime_profile_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL, based_on_revision_id TEXT, semantic_digest TEXT NOT NULL,
      content_json TEXT NOT NULL, created_by_principal_id TEXT NOT NULL,
      created_at TEXT NOT NULL, published_at TEXT, withdrawn_at TEXT
    );
    CREATE TABLE actor_runtime_bindings (
      actor_runtime_binding_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL, runtime_profile_id TEXT NOT NULL,
      runtime_profile_revision_id TEXT NOT NULL, endpoint_id TEXT, status TEXT NOT NULL,
      unresolved_reasons_json TEXT NOT NULL, created_by_principal_id TEXT NOT NULL,
      created_at TEXT NOT NULL, superseded_at TEXT
    );
    CREATE TABLE artefacts (
      artefact_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, type_ref TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, request_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE artefact_versions (
      artefact_version_id TEXT PRIMARY KEY, artefact_id TEXT NOT NULL REFERENCES artefacts(artefact_id),
      ordinal INTEGER NOT NULL, schema_ref TEXT, content_ref_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, request_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE artefact_lineage (
      lineage_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      subject_version_id TEXT NOT NULL REFERENCES artefact_versions(artefact_version_id),
      relation_type TEXT NOT NULL,
      object_version_id TEXT NOT NULL REFERENCES artefact_versions(artefact_version_id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE connector_definitions (
      connector_definition_id TEXT PRIMARY KEY, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
      status TEXT NOT NULL, current_revision_id TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, retired_at TEXT
    );
    CREATE TABLE connector_definition_revisions (
      connector_definition_revision_id TEXT PRIMARY KEY, connector_definition_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL, based_on_revision_id TEXT, semantic_digest TEXT NOT NULL,
      content_json TEXT NOT NULL, created_by_principal_id TEXT NOT NULL,
      created_at TEXT NOT NULL, published_at TEXT NOT NULL
    );
    CREATE TABLE connector_bindings (
      connector_binding_id TEXT PRIMARY KEY, connector_definition_id TEXT NOT NULL,
      owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, status TEXT NOT NULL,
      state_version INTEGER NOT NULL, current_revision_id TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, enabled_at TEXT,
      disabled_at TEXT, retired_at TEXT
    );
    CREATE TABLE connector_binding_revisions (
      connector_binding_revision_id TEXT PRIMARY KEY, connector_binding_id TEXT NOT NULL,
      connector_definition_revision_id TEXT NOT NULL, revision_number INTEGER NOT NULL,
      based_on_revision_id TEXT, semantic_digest TEXT NOT NULL, content_json TEXT NOT NULL,
      created_by_principal_id TEXT NOT NULL, created_at TEXT NOT NULL, published_at TEXT NOT NULL
    );
    CREATE TABLE connector_health_observations (
      connector_health_observation_id TEXT PRIMARY KEY,
      connector_binding_id TEXT NOT NULL,
      connector_binding_revision_id TEXT NOT NULL,
      owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, status TEXT NOT NULL,
      code TEXT, message TEXT NOT NULL, evidence_refs_json TEXT NOT NULL,
      observed_at TEXT NOT NULL, recorded_at TEXT NOT NULL
    );
    CREATE TABLE external_effect_receipts (
      external_effect_receipt_id TEXT PRIMARY KEY, connector_binding_id TEXT NOT NULL,
      connector_binding_revision_id TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
      action_interface_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, input_digest TEXT NOT NULL,
      input_refs_json TEXT NOT NULL, secret_ref_ids_json TEXT NOT NULL,
      capability_grant_ids_json TEXT NOT NULL, approval_receipt_ids_json TEXT NOT NULL,
      requested_by_principal_id TEXT NOT NULL, invocation_provenance_json TEXT NOT NULL,
      status TEXT NOT NULL, attempt_count INTEGER NOT NULL, requested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE canonical_extensions (
      extension_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, label TEXT NOT NULL,
      status TEXT NOT NULL, current_package_version_id TEXT, revision_number INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, retired_at TEXT
    );
    CREATE TABLE extension_package_versions (
      extension_package_version_id TEXT PRIMARY KEY, extension_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL, package_version TEXT NOT NULL, content_digest TEXT NOT NULL,
      permission_digest TEXT NOT NULL, record_digest TEXT NOT NULL, definition_json TEXT NOT NULL,
      registered_by_principal_id TEXT NOT NULL, registered_at TEXT NOT NULL
    );
    CREATE TABLE extension_installations (
      extension_installation_id TEXT PRIMARY KEY, extension_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL, installation_name TEXT NOT NULL,
      installation_locator TEXT NOT NULL, installed_package_version_id TEXT,
      pending_package_version_id TEXT, lifecycle TEXT NOT NULL, rollback_target_json TEXT NOT NULL,
      permission_approval_receipt_refs_json TEXT NOT NULL, isolation_host_id TEXT,
      isolation_level TEXT, activation_receipt_ref TEXT, deactivation_receipt_ref TEXT,
      unresolved_bindings_json TEXT NOT NULL, data_ref_json TEXT, revision_number INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, disabled_at TEXT
    );
    CREATE TABLE extension_activation_attempts (
      extension_activation_attempt_id TEXT PRIMARY KEY,
      invocation_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      extension_installation_id TEXT NOT NULL,
      extension_package_version_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      authorized_principal_id TEXT NOT NULL,
      requested_lifecycle TEXT NOT NULL,
      installation_locator TEXT NOT NULL,
      permission_digest TEXT NOT NULL,
      approval_receipt_ref TEXT NOT NULL,
      approval_action_digest TEXT NOT NULL,
      capability_grant_ids_json TEXT NOT NULL,
      state TEXT NOT NULL,
      host_claim_json TEXT,
      failure_code TEXT,
      failure_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE secret_refs (
      secret_ref_id TEXT PRIMARY KEY, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
      resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, secret_kind TEXT NOT NULL,
      label TEXT NOT NULL, resolution TEXT NOT NULL, broker_id TEXT, broker_locator TEXT,
      generation INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE capability_grants (
      grant_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, boundary_kind TEXT NOT NULL,
      boundary_id TEXT NOT NULL, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      revoked_at TEXT, issuer_id TEXT NOT NULL, evidence_json TEXT NOT NULL
    );
    CREATE TABLE capability_grant_operations (
      grant_id TEXT NOT NULL, operation_id TEXT NOT NULL,
      PRIMARY KEY (grant_id, operation_id)
    );
    CREATE TABLE operation_invocation_ledger (
      ledger_key TEXT PRIMARY KEY, request_digest TEXT NOT NULL, receipt_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL, boundary_kind TEXT NOT NULL, boundary_id TEXT NOT NULL,
      principal_id TEXT NOT NULL, operation_id TEXT NOT NULL, operation_version TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, state TEXT NOT NULL, receipt_json TEXT NOT NULL,
      started_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
  `);
  return db;
}

function insertOperationReceipt(db: DatabaseSync, input: Readonly<{
  receipt_id: string;
  invocation_id: string;
  operation_id: string;
  target_kind: string;
  target_id: string;
  changed_refs?: readonly Readonly<{ kind: string; id: string }>[];
  result?: Readonly<Record<string, unknown>> | null;
  state?: "running" | "completed";
  completed_at: string | null;
  boundary_kind?: "workspace" | "host";
  boundary_id?: string;
}>): void {
  const state = input.state ?? "completed";
  const startedAt = "2026-09-04T03:20:00.000Z";
  const receipt = {
    receipt_id: input.receipt_id,
    invocation_id: input.invocation_id,
    operation_id: input.operation_id,
    target: { kind: input.target_kind, id: input.target_id },
    changed_refs: input.changed_refs ?? [],
    result: input.result ?? null,
  };
  db.prepare("INSERT INTO operation_invocation_ledger VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    `ledger_${input.receipt_id}`, "7".repeat(64), input.receipt_id, input.invocation_id,
    input.boundary_kind ?? "workspace", input.boundary_id ?? "workspace_alpha", "principal_operator", input.operation_id, "1",
    `idempotency_${input.receipt_id}`, state, JSON.stringify(receipt), startedAt, input.completed_at ?? startedAt,
    input.completed_at,
  );
}

function seedCompleteWorkspace(
  db: DatabaseSync,
  sourceRoot: string,
  contentDigest: string,
  contentSize: number,
  externalContentDigest = "d".repeat(64),
): void {
  const at = "2026-09-04T00:00:00.000Z";
  db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)").run("workspace_alpha", "Alpha", "created", null, at, at);
  db.prepare("INSERT INTO endpoints VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "endpoint_builder", "workspace_alpha", "Builder", "actor_builder", "bridge_source_host", "idle", "{}", at, at,
  );
  db.prepare("INSERT INTO endpoints VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "command_worker_endpoint_source", "workspace_alpha", "Floe Command worker", null, null, "idle",
    JSON.stringify({ endpoint_kind: "command_worker", command_worker_binding_id: "command_worker_source", host_id: "host_source" }),
    at, at,
  );
  db.prepare("INSERT INTO scopes VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "workspace_alpha", "scope_pipeline", "Pipeline", null, "active", at, at, "scope_revision_1",
  );
  db.prepare("INSERT INTO scope_composition_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "scope_revision_1", "workspace_alpha", "scope_pipeline", 1, "edge", null, "a".repeat(64), "endpoint_builder", at, at, null,
  );
  db.prepare("INSERT INTO scope_node_placements VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "scope_revision_1", "node_builder", "actor", "Builder", "actor_builder", "{}", "{}", '{"mode":"per_delivery"}', '{"mode":"new_per_execution"}',
  );
  db.prepare("INSERT INTO scope_ports VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "scope_revision_1", "port_builder_in", "node_builder", "Input", "input", '["work.requested"]', "[]", null, 1, 1,
  );
  db.prepare("INSERT INTO scope_ports VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "scope_revision_1", "port_builder_out", "node_builder", "Output", "output", '["work.completed"]', "[]", null, 0, null,
  );
  db.prepare("INSERT INTO scope_edges VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "scope_revision_1", "edge_loop", "port_builder_out", "port_builder_in", 0, 0, "{}",
  );
  db.prepare("INSERT INTO contexts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "context_pipeline", "workspace_alpha", "scope_pipeline", null, "endpoint_builder", at,
    "Pipeline Context", "principal_operator", at, 1, "active", null, null, null,
    null, null, "available", null, null, null, null, null, null,
  );
  db.prepare("INSERT INTO context_participants VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "context_pipeline", "endpoint_builder", at, "builder", "contribute", at, null,
  );
  db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "event_1", "work.requested", "workspace_alpha", null, "context_pipeline", "scope_pipeline", "correlation_1",
    '{"kind":"endpoint","endpoint_id":"endpoint_builder"}',
    JSON.stringify({
      prompt: "Build it",
      observed_path: sourceRoot,
      unix_host_path: "/home/source/private.txt",
      api_key: "sk_abcdefghijklmnopqrstuvwxyz",
    }),
    "{}", "{}", "event-once", at, "endpoint_builder", "context_pipeline", "[]",
  );
  db.prepare("INSERT INTO scope_executions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "scope_execution_1", "workspace_alpha", "scope_pipeline", "scope_revision_1", "event_1", "event_1",
    "node_builder", "port_builder_in", "endpoint_builder", "scope-once", null, null, 2,
    "waiting_external", "{}", "{}", "{}", at, at, null, null,
  );
  db.prepare("INSERT INTO node_executions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "node_execution_1", "scope_execution_1", "scope_revision_1", "node_builder", "activation_1", null,
    "context_pipeline", "actor_definition_revision_1", "runtime_profile_revision_1",
    "actor_runtime_binding_builder", 2, "waiting", '["actor_builder"]', "[]", "{}", at, at, null, null,
  );
  db.prepare("INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "attempt_1", "node_execution_1", 1, "delivery_1", "delivery_1", "actor_definition_revision_1",
    "runtime_profile_revision_1", "actor_runtime_binding_builder", "running", "{}", "{}", "{}", "{}", at, at, null,
  );
  db.prepare("INSERT INTO command_worker_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "command_worker_source", "workspace_alpha", "host_source", "command_worker_endpoint_source",
    "command_worker_principal_source", "available", '["core_command_implementation"]', at, at,
  );
  db.prepare("INSERT INTO command_attempt_contracts VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "attempt_1", "command_contract_1", "0".repeat(64), "command_definition_revision_1",
    "command_worker_source", "{}", at,
  );
  db.prepare("INSERT INTO event_queue VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "queue_1", "event_1", "workspace_alpha", "endpoint_builder", "queued", at, "delivery_1", at,
    1, null, null, "scope_execution_1", "scope_revision_1", null, null, "node_builder",
    "port_builder_in", null, "node_execution_1", null, "actor_definition_revision_1",
    "runtime_profile_revision_1", "actor_runtime_binding_builder",
  );
  db.prepare("INSERT INTO delivery_bundles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "delivery_1", "endpoint_builder", "workspace_alpha", "event_1", "[]", "reserved", at, 1,
    null, at, at, null, "pending_1", "event", '["queue_1"]', "attempt_1",
    "actor_definition_revision_1", "runtime_profile_revision_1", "actor_runtime_binding_builder",
  );
  db.prepare("INSERT INTO pending_responses VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "pending_1", "workspace_alpha", "endpoint_builder", "event_1", "correlated",
    "context_pipeline", "correlation_1", null, "pending", at, null,
  );
  db.prepare("INSERT INTO actors VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "actor_builder", "workspace_alpha", "active", "actor_definition_revision_1", at, at, null,
  );
  db.prepare("INSERT INTO actor_definition_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "actor_definition_revision_1", "actor_builder", "workspace_alpha", 1, null, "b".repeat(64),
    '{"label":"Builder"}', "principal_operator", at, at, null,
  );
  db.prepare("INSERT INTO runtime_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "runtime_profile_builder", "workspace", "workspace_alpha", "runtime_profile_revision_1", "active", at, at, null,
  );
  db.prepare("INSERT INTO runtime_profile_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "runtime_profile_revision_1", "runtime_profile_builder", 1, null, "c".repeat(64),
    '{"provider":"openai","model":"gpt-5.6"}', "principal_operator", at, at, null,
  );
  db.prepare("INSERT INTO actor_runtime_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "actor_runtime_binding_builder", "actor_builder", "workspace_alpha", "runtime_profile_builder",
    "runtime_profile_revision_1", "endpoint_builder", "resolved", "[]", "principal_operator", at, null,
  );
  db.prepare("INSERT INTO artefacts VALUES (?, ?, ?, ?, ?, ?)").run(
    "artefact_source", "workspace_alpha", "text/plain", "artefact-source", "fp-source", at,
  );
  db.prepare("INSERT INTO artefacts VALUES (?, ?, ?, ?, ?, ?)").run(
    "artefact_result", "workspace_alpha", "application/json", "artefact-result", "fp-result", at,
  );
  db.prepare("INSERT INTO artefact_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "artefact_version_source", "artefact_source", 1, null,
    JSON.stringify({
      kind: "workspace-relative",
      path: "inputs/concept.txt",
      digest: { algorithm: "sha256", value: contentDigest },
      media_type: "text/plain",
      size_bytes: contentSize,
    }),
    "version-source", "fp-version-source", at,
  );
  db.prepare("INSERT INTO artefact_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "artefact_version_result", "artefact_result", 1, null,
    JSON.stringify({
      kind: "external-revision", resolver_id: "nonportable-provider",
      external_id: "result-1", revision: "r1", digest: { algorithm: "sha256", value: externalContentDigest },
      media_type: "application/json",
    }),
    "version-result", "fp-version-result", at,
  );
  db.prepare("INSERT INTO artefact_lineage VALUES (?, ?, ?, ?, ?, ?)").run(
    "lineage_1", "workspace_alpha", "artefact_version_result", "core:derived-from", "artefact_version_source", at,
  );
  db.prepare("INSERT INTO connector_definitions VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "connector_definition_source", "workspace", "workspace_alpha", "active",
    "connector_definition_revision_1", at, at, null,
  );
  db.prepare("INSERT INTO connector_definition_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "connector_definition_revision_1", "connector_definition_source", 1, null, "e".repeat(64),
    "{}", "principal_operator", at, at,
  );
  db.prepare("INSERT INTO connector_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "connector_binding_source", "connector_definition_source", "workspace", "workspace_alpha", "enabled", 1,
    "connector_binding_revision_1", at, at, at, null, null,
  );
  db.prepare("INSERT INTO connector_binding_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "connector_binding_revision_1", "connector_binding_source", "connector_definition_revision_1", 1,
    null, "f".repeat(64), "{}", "principal_operator", at, at,
  );
  db.prepare("INSERT INTO external_effect_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "external_effect_1", "connector_binding_source", "connector_binding_revision_1", "workspace",
    "workspace_alpha", "publish", "external-once", "1".repeat(64), "[]", '["secret_openai"]',
    '["grant_workspace"]', "[]", "principal_operator", "{}", "succeeded", 1, at, at, at,
  );
  db.prepare("INSERT INTO canonical_extensions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "extension_tools", "workspace_alpha", "Tools", "active", "extension_package_1", 1, at, at, null,
  );
  db.prepare("INSERT INTO extension_package_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "extension_package_1", "extension_tools", "workspace_alpha", "1.0.0", "2".repeat(64),
    "3".repeat(64), "4".repeat(64), "{}", "principal_operator", at,
  );
  db.prepare("INSERT INTO extension_installations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "extension_installation_tools", "extension_tools", "workspace_alpha", "tools", ".floe/extensions/tools",
    "extension_package_1", null, "enabled", "{}", "[]", "extension_host_source", "process",
    "approval_1", null, "[]", null, 1, at, at, null,
  );
  db.prepare("INSERT INTO secret_refs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "secret_openai", "workspace", "workspace_alpha", "provider_account", "account_openai",
    "oauth", "ChatGPT", "resolved", "windows-dpapi", "super-secret-broker-locator", 1, at, at,
  );
  db.prepare("INSERT INTO capability_grants VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "grant_workspace", "principal_operator", "workspace", "workspace_alpha", at,
    "2030-01-01T00:00:00.000Z", null, "principal_operator", "{}",
  );
  db.prepare("INSERT INTO capability_grant_operations VALUES (?, ?)").run("grant_workspace", "workspace.inspect");
  db.prepare("INSERT INTO operation_invocation_ledger VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "ledger_1", "5".repeat(64), "receipt_1", "invocation_1", "workspace", "workspace_alpha",
    "principal_operator", "connector.action", "1", "external-once", "completed",
    JSON.stringify({ state: "completed", result: { api_key: "sk_abcdefghijklmnopqrstuvwxyz" } }), at, at, at,
  );
}

function seedCollidingOtherWorkspace(db: DatabaseSync): void {
  const at = "2026-09-04T00:30:00.000Z";
  db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)").run(
    "workspace_beta", "Beta", "created", null, at, at,
  );
  // These IDs deliberately equal IDs of unrelated Alpha record kinds. A
  // string-based closure leaks them; typed relationships do not.
  db.prepare("INSERT INTO endpoints VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "scope_revision_1", "workspace_beta", "BETA_ONLY_RELATION_MARKER", null, null, "offline", "{}", at, at,
  );
  db.prepare(`
    INSERT INTO contexts (
      context_id, workspace_id, scope_id, parent_context_id,
      created_by_endpoint_id, created_at, title, updated_at,
      state_revision, lifecycle_state, content_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "context_beta", "workspace_beta", null, null, "scope_revision_1", at,
    "BETA_ONLY_RELATION_MARKER", at, 1, "active", "available",
  );
  db.prepare("INSERT INTO context_participants VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "context_beta", "scope_revision_1", at, "BETA_ONLY_RELATION_MARKER", "active", at, null,
  );
  db.prepare("INSERT INTO scopes VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "workspace_beta", "scope_beta", "BETA_ONLY_RELATION_MARKER", null, "active", at, at, "actor_builder",
  );
  db.prepare("INSERT INTO scope_composition_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "actor_builder", "workspace_beta", "scope_beta", 1, "edge", null, "9".repeat(64), "scope_revision_1", at, at, null,
  );
  db.prepare("INSERT INTO scope_node_placements VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "actor_builder", "node_beta", "actor", "BETA_ONLY_RELATION_MARKER", null, "{}", "{}", "{}", "{}",
  );
  db.prepare("INSERT INTO runtime_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "scope_revision_1", "workspace", "workspace_beta", "runtime_profile_revision_beta", "active", at, at, null,
  );
  db.prepare("INSERT INTO runtime_profile_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "runtime_profile_revision_beta", "scope_revision_1", 1, null, "8".repeat(64),
    JSON.stringify({ label: "BETA_ONLY_RELATION_MARKER" }), "principal_beta", at, at, null,
  );
}

function row(db: DatabaseSync, sql: string): Record<string, unknown> {
  return db.prepare(sql).get() as Record<string, unknown>;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function collectBundleText(bundleDirectory: string): string {
  const manifest = readFileSync(join(bundleDirectory, "manifest.json"), "utf8");
  const parsed = JSON.parse(manifest) as { records: Array<{ path: string }> };
  return [manifest, ...parsed.records.map((item) => readFileSync(join(bundleDirectory, ...item.path.split("/")), "utf8"))].join("\n");
}
