import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { CURRENT_BUS_SCHEMA_VERSION } from "./database-upgrade.js";
import { resolveWithinRoot } from "./fs/resolveWithinRoot.js";

export const WORKSPACE_BUNDLE_FORMAT = "floe.workspace.directory-bundle" as const;
export const WORKSPACE_BUNDLE_FORMAT_VERSION = 1 as const;
export const WORKSPACE_BUNDLE_RECORD_VERSION = 1 as const;
export const SUPPLY_WORKSPACE_CONTENT_OPERATION_ID = "workspace.package.supply_content" as const;

type SqlValue = string | number | bigint | null | Uint8Array;
type SqlRow = Record<string, SqlValue>;

export type WorkspaceBundleContentMode = "included" | "portable_external" | "unresolved";

export type WorkspaceBundleRecordInventory = Readonly<{
  table: string;
  columns: readonly string[];
  primary_key: readonly string[];
  schema_digest: string;
  record_count: number;
  records_digest: string;
  path: string;
}>;

export type WorkspaceBundleContentInventory = Readonly<{
  artefact_version_id: string;
  mode: WorkspaceBundleContentMode;
  digest: string | null;
  size_bytes: number | null;
  media_type: string | null;
  resolver_id: string | null;
  package_path: string | null;
  reason: string | null;
}>;

export type WorkspaceBundleDependency = Readonly<{
  dependency_id: string;
  kind: "content" | "secret_ref" | "endpoint_attachment" | "actor_runtime" | "command_runtime" | "connector_runtime" | "extension_runtime";
  resource_id: string;
  reason: string;
}>;

export type WorkspaceBundleRestoreTransform = Readonly<{
  record_kind: string;
  fields: readonly string[];
  restore_result: string;
}>;

export type WorkspaceBundleRestoreSemantics = Readonly<{
  retained_history: "exact_packaged_records";
  operational_rebindings: readonly WorkspaceBundleRestoreTransform[];
}>;

export const WORKSPACE_BUNDLE_RESTORE_SEMANTICS: WorkspaceBundleRestoreSemantics = {
  retained_history: "exact_packaged_records",
  operational_rebindings: [
    {
      record_kind: "secret_refs",
      fields: ["resolution", "broker_id", "broker_locator"],
      restore_result: "unresolved_without_credential_material",
    },
    {
      record_kind: "endpoints",
      fields: ["bridge_id", "status"],
      restore_result: "detached_and_offline",
    },
    {
      record_kind: "actor_runtime_bindings",
      fields: ["status", "unresolved_reasons_json"],
      restore_result: "unresolved_pending_runtime_validation",
    },
    {
      record_kind: "command_attempt_contracts",
      fields: ["command_worker_binding_id", "contract_json"],
      restore_result: "origin_worker_is_history_only_and_active_attempt_requires_target_worker",
    },
    {
      record_kind: "artefact_versions",
      fields: ["content_ref_json"],
      restore_result: "included_bytes_relocated_or_dependency_marked_unresolved",
    },
  ],
};

export type WorkspaceBundleManifest = Readonly<{
  format: typeof WORKSPACE_BUNDLE_FORMAT;
  format_version: typeof WORKSPACE_BUNDLE_FORMAT_VERSION;
  record_version: typeof WORKSPACE_BUNDLE_RECORD_VERSION;
  source_database_schema_version: number;
  minimum_target_database_schema_version: number;
  workspace_id: string;
  workspace_identity_digest: string;
  records: readonly WorkspaceBundleRecordInventory[];
  content: readonly WorkspaceBundleContentInventory[];
  restore_semantics: WorkspaceBundleRestoreSemantics;
  unresolved_dependencies: readonly WorkspaceBundleDependency[];
  redaction_count: number;
  bundle_digest: string;
  bundle_id: string;
}>;

export type WorkspaceBundleExportResult = Readonly<{
  bundle_id: string;
  bundle_digest: string;
  workspace_id: string;
  bundle_directory: string;
  manifest: WorkspaceBundleManifest;
}>;

export type WorkspaceBundleValidationResult = Readonly<{
  bundle_directory: string;
  manifest: WorkspaceBundleManifest;
  records: ReadonlyMap<string, readonly SqlRow[]>;
}>;

export type WorkspaceRestoreHold = Readonly<{
  workspace_id: string;
  bundle_id: string;
  bundle_digest: string;
  state: "held" | "released";
  reason: string;
  restored_at: string;
  released_at: string | null;
  released_by_principal_id: string | null;
}>;

export type WorkspaceBundleRestoreResult = Readonly<{
  workspace_id: string;
  bundle_id: string;
  bundle_digest: string;
  state: "held";
  inserted_record_count: number;
  retained_record_count: number;
  unresolved_dependencies: readonly WorkspaceBundleDependency[];
  backup_path: string | null;
}>;

export type WorkspaceDependencyReconciliationResult = Readonly<{
  resolved_dependencies: readonly WorkspaceBundleDependency[];
  unresolved_dependencies: readonly WorkspaceBundleDependency[];
}>;

export type WorkspaceSuppliedContent = Readonly<{
  workspace_id: string;
  bundle_digest: string;
  dependency_id: string;
  artefact_version_id: string;
  digest: string;
  size_bytes: number;
}>;

export type PortableContentResolver = Readonly<{
  guaranteesPortableExactReference(contentRef: Readonly<Record<string, unknown>>): boolean;
}>;

export type WorkspacePortabilityDependencies = Readonly<{
  db: DatabaseSync;
  database_path: string;
  bundle_root: string;
  workspace_locator(workspaceId: string): string | null;
  bind_workspace_locator?: (workspaceId: string, locator: string) => void;
  portable_content_resolvers?: ReadonlyMap<string, PortableContentResolver>;
  now?: () => string;
}>;

export class WorkspacePortabilityError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "WorkspacePortabilityError";
    this.code = code;
    this.details = details;
  }
}

type PortableRecord = Readonly<{
  digest: string;
  source_digest: string;
  transforms: readonly string[];
  row: SqlRow;
}>;

type MinimalOperationReceipt = Readonly<{
  receipt_id: string;
  invocation_id: string;
  operation_id: string;
  target: Readonly<{ kind: string; id: string }> | null;
  changed_refs: readonly Readonly<{ kind: string; id: string }>[];
  result: Readonly<Record<string, unknown>> | null;
}>;

type MutableExport = {
  records: Map<string, SqlRow[]>;
  primaryKeys: Map<string, string[]>;
  redactionCount: number;
  dependencies: WorkspaceBundleDependency[];
};

/**
 * Tables whose records are part of a portable Workspace. This is deliberately
 * explicit: adding a new Workspace-owned table without classifying it makes
 * export fail closed instead of silently losing state.
 */
export const PORTABLE_WORKSPACE_TABLES = new Set([
  "actor_definition_head_changes",
  "actor_definition_revisions",
  "actor_role_assignments",
  "actor_runtime_bindings",
  "actors",
  "approval_individual_decisions",
  "approval_receipt_revocations",
  "approval_receipt_uses",
  "approval_receipts",
  "approval_requests",
  "artefact_annotations",
  "artefact_associations",
  "artefact_collection_members",
  "artefact_lineage",
  "artefact_versions",
  "artefacts",
  "audit_outcomes",
  "audit_requests",
  "budget_reservation_items",
  "budget_reservations",
  "canonical_extensions",
  "capability_grant_operations",
  "capability_grant_delegations",
  "capability_grant_targets",
  "capability_grants",
  "command_definition_head_changes",
  "command_definition_revisions",
  "command_attempt_contracts",
  "commands",
  "connector_binding_revisions",
  "connector_bindings",
  "connector_definition_revisions",
  "connector_definitions",
  "connector_head_changes",
  "connector_health_observations",
  "connector_ingress_observations",
  "connector_ingress_receipts",
  "connector_source_checkpoints",
  "context_participants",
  "context_subscriptions",
  "contexts",
  "delivery_bundles",
  "endpoint_watermarks",
  "endpoints",
  "event_queue",
  "events",
  "execution_attempt_deliveries",
  "execution_attempts",
  "extension_activation_attempts",
  "extension_execution_package_pins",
  "extension_installation_changes",
  "extension_installations",
  "extension_package_versions",
  "extension_runtime_audit",
  "external_action_attempts",
  "external_action_reconciliations",
  "external_effect_receipts",
  "legacy_artefact_import_evidence",
  "node_context_bindings",
  "node_execution_expected_memberships",
  "node_execution_inputs",
  "node_execution_join_expectations",
  "node_execution_outputs",
  "node_executions",
  "operation_invocation_ledger",
  "pending_responses",
  "policies",
  "policy_bindings",
  "policy_evaluations",
  "policy_revisions",
  "principal_actor_bindings",
  "pulse_delivery_contexts",
  "pulse_subscribers",
  "pulses",
  "resource_usage_entries",
  "runtime_profile_head_changes",
  "runtime_profile_revisions",
  "runtime_profiles",
  "runtime_telemetry",
  "scope_composition_revisions",
  "scope_edge_traversals",
  "scope_edges",
  "scope_execution_pause_deliveries",
  "scope_execution_pause_nodes",
  "scope_execution_pauses",
  "scope_executions",
  "scope_graphs",
  "scope_node_placements",
  "scope_output_publications",
  "scope_ports",
  "scopes",
  "secret_access_audit",
  "secret_grant_constraint_purposes",
  "secret_grant_constraints",
  "secret_refs",
  "workspace_configuration_import_policies",
  "workspace_configuration_import_receipts",
  "workspace_configuration_import_resources",
  "workspaces",
]);

/** Host credentials, host attachment, ephemeral sessions and rebuildable push indexes never travel. */
export const NON_PORTABLE_HOST_TABLES = new Set([
  "bridges",
  "command_worker_bindings",
  "host_capability_policy_revisions",
  "local_host_identity",
  "local_operator_principals",
  "operation_authority_sessions",
  "runtime_bindings",
  "saved_configs",
  "schema_migrations",
  "transport_credentials",
  "transport_push_checkpoints",
  "transport_push_entries",
  "workspace_locator_bindings",
  "workspace_portability_imported_operation_receipts",
  "workspace_portability_dependencies",
  "workspace_portability_restores",
  "workspace_restore_holds",
]);

const DIRECT_SCOPE_EXCEPTIONS = new Set([
  "runtime_profiles",
  "connector_definitions",
  "connector_bindings",
  "capability_grants",
  "operation_invocation_ledger",
  "secret_access_audit",
  "secret_refs",
]);

type PortableRelationship = Readonly<{
  child_table: string;
  child_columns: readonly string[];
  parent_table: string;
  parent_columns: readonly string[];
}>;

/**
 * Typed relations missing from older SQLite schemas. A value is followed only
 * through the named record kind; equal opaque strings in unrelated kinds are
 * never treated as a relationship.
 */
const EXPLICIT_PORTABLE_RELATIONSHIPS: readonly PortableRelationship[] = [
  relation("actor_definition_revisions", "actor_id", "actors", "actor_id"),
  relation("artefact_annotations", "artefact_version_id", "artefact_versions", "artefact_version_id"),
  relation("artefact_associations", "artefact_version_id", "artefact_versions", "artefact_version_id"),
  relation("artefact_collection_members", "collection_version_id", "artefact_versions", "artefact_version_id"),
  relation("artefact_collection_members", "member_version_id", "artefact_versions", "artefact_version_id"),
  relation("artefact_versions", "artefact_id", "artefacts", "artefact_id"),
  relation("audit_outcomes", "audit_id", "audit_requests", "audit_id"),
  relation("budget_reservation_items", "reservation_id", "budget_reservations", "reservation_id"),
  relation("capability_grant_operations", "grant_id", "capability_grants", "grant_id"),
  relation("capability_grant_delegations", "grant_id", "capability_grants", "grant_id"),
  relation("capability_grant_targets", "grant_id", "capability_grants", "grant_id"),
  relation("connector_binding_revisions", "connector_binding_id", "connector_bindings", "connector_binding_id"),
  relation("connector_binding_revisions", "connector_definition_revision_id", "connector_definition_revisions", "connector_definition_revision_id"),
  relation("connector_definition_revisions", "connector_definition_id", "connector_definitions", "connector_definition_id"),
  relation("connector_ingress_observations", "connector_ingress_receipt_id", "connector_ingress_receipts", "connector_ingress_receipt_id"),
  relation("command_attempt_contracts", "attempt_id", "execution_attempts", "attempt_id"),
  relation("command_attempt_contracts", "command_definition_revision_id", "command_definition_revisions", "command_definition_revision_id"),
  relation("context_participants", "context_id", "contexts", "context_id"),
  relation("context_subscriptions", "context_id", "contexts", "context_id"),
  relation("execution_attempt_deliveries", "attempt_id", "execution_attempts", "attempt_id"),
  relation("execution_attempt_deliveries", "delivery_id", "delivery_bundles", "delivery_id"),
  relation("execution_attempts", "node_execution_id", "node_executions", "node_execution_id"),
  relation("extension_execution_package_pins", "execution_attempt_id", "execution_attempts", "attempt_id"),
  relation("extension_execution_package_pins", "extension_installation_id", "extension_installations", "extension_installation_id"),
  relation("extension_execution_package_pins", "extension_package_version_id", "extension_package_versions", "extension_package_version_id"),
  relation("extension_installations", "extension_id", "canonical_extensions", "extension_id"),
  relation("extension_package_versions", "extension_id", "canonical_extensions", "extension_id"),
  relation("external_action_attempts", "external_effect_receipt_id", "external_effect_receipts", "external_effect_receipt_id"),
  relation("external_action_reconciliations", "external_effect_receipt_id", "external_effect_receipts", "external_effect_receipt_id"),
  relation("node_execution_expected_memberships", "node_execution_id", "node_executions", "node_execution_id"),
  relation("node_execution_inputs", "node_execution_id", "node_executions", "node_execution_id"),
  relation("node_execution_join_expectations", "node_execution_id", "node_executions", "node_execution_id"),
  relation("node_execution_outputs", "publication_id", "scope_output_publications", "publication_id"),
  relation("node_executions", "execution_id", "scope_executions", "execution_id"),
  relation("pulse_subscribers", "pulse_id", "pulses", "pulse_id"),
  relation("runtime_profile_head_changes", "runtime_profile_id", "runtime_profiles", "runtime_profile_id"),
  relation("runtime_profile_revisions", "runtime_profile_id", "runtime_profiles", "runtime_profile_id"),
  relation("scope_edge_traversals", "publication_id", "scope_output_publications", "publication_id"),
  relation("scope_execution_pause_deliveries", "pause_id", "scope_execution_pauses", "pause_id"),
  relation("scope_execution_pause_nodes", "pause_id", "scope_execution_pauses", "pause_id"),
  relation("scope_execution_pauses", "execution_id", "scope_executions", "execution_id"),
  relation("scope_node_placements", "revision_id", "scope_composition_revisions", "revision_id"),
  relation("scope_output_publications", "node_execution_id", "node_executions", "node_execution_id"),
  relation("scope_ports", "revision_id", "scope_composition_revisions", "revision_id"),
  relation("scope_edges", "revision_id", "scope_composition_revisions", "revision_id"),
  relation("secret_grant_constraint_purposes", "grant_id", "secret_grant_constraints", "grant_id"),
];

const SECRET_KEY = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|cookie|client[_-]?secret|private[_-]?key|secret[_-]?(?:value|material)|credential[_-]?material)$/i;
const SECRET_VALUE_PATTERNS = [
  /\b(?:sk|sess|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}\b/gi,
];
const WINDOWS_ABSOLUTE_PATH = /\b[A-Za-z]:\\(?:[^\s"'<>|\r\n]+\\?)+/g;
const UNC_ABSOLUTE_PATH = /\\\\[^\s\\/]+\\[^\s"'<>|\r\n]+/g;
const POSIX_ABSOLUTE_PATH = /(^|[\s"'(:=])\/(?!\/)([^\s"'<>|\r\n]*)/g;

export function applyWorkspacePortabilitySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_portability_restores (
      workspace_id TEXT NOT NULL,
      bundle_id TEXT NOT NULL,
      bundle_digest TEXT NOT NULL,
      format_version INTEGER NOT NULL,
      source_database_schema_version INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('held', 'released')),
      restored_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, bundle_digest),
      UNIQUE (bundle_id)
    );

    CREATE TABLE IF NOT EXISTS workspace_restore_holds (
      workspace_id TEXT PRIMARY KEY,
      bundle_id TEXT NOT NULL,
      bundle_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('held', 'released')),
      reason TEXT NOT NULL,
      restored_at TEXT NOT NULL,
      released_at TEXT,
      released_by_principal_id TEXT
    );

    CREATE TABLE IF NOT EXISTS workspace_portability_dependencies (
      workspace_id TEXT NOT NULL,
      bundle_digest TEXT NOT NULL,
      dependency_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('unresolved', 'resolved')),
      resolved_at TEXT,
      resolved_by_operation_receipt_id TEXT,
      PRIMARY KEY (workspace_id, bundle_digest, dependency_id)
    );

    CREATE TABLE IF NOT EXISTS workspace_portability_imported_operation_receipts (
      workspace_id TEXT NOT NULL,
      bundle_digest TEXT NOT NULL,
      receipt_id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, bundle_digest, receipt_id)
    );
  `);
}

export class WorkspacePortabilityService {
  private readonly now: () => string;

  constructor(private readonly dependencies: WorkspacePortabilityDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    applyWorkspacePortabilitySchema(dependencies.db);
  }

  exportWorkspace(workspaceId: string): WorkspaceBundleExportResult {
    requireStableId(workspaceId, "workspace_id");
    const identity = this.dependencies.db.prepare("SELECT * FROM workspaces WHERE workspace_id = ?")
      .get(workspaceId) as SqlRow | undefined;
    if (!identity) {
      throw new WorkspacePortabilityError("workspace_not_found", "The Workspace does not exist.", { workspace_id: workspaceId });
    }
    this.assertCurrentSchema(this.dependencies.db, "source");
    this.assertEveryWorkspaceTableClassified();

    const selected = this.selectWorkspaceRecords(workspaceId);
    const workspaceLocator = this.dependencies.workspace_locator(workspaceId);
    const root = resolve(this.dependencies.bundle_root);
    mkdirSync(root, { recursive: true });
    const staging = mkdtempSync(join(root, ".staging-"));
    const recordDirectory = join(staging, "records");
    const contentDirectory = join(staging, "content", "sha256");
    mkdirSync(recordDirectory, { recursive: true });
    mkdirSync(contentDirectory, { recursive: true });

    try {
      const recordInventory: WorkspaceBundleRecordInventory[] = [];
      const sourcePathTokens = workspaceLocator ? [resolve(workspaceLocator)] : [];
      for (const table of [...selected.records.keys()].sort()) {
        const rows = selected.records.get(table) ?? [];
        const pk = selected.primaryKeys.get(table) ?? [];
        rows.sort((left, right) => compareRows(left, right, pk));
        const portableRows = rows.map((row) => sanitizePortableRecord(row, sourcePathTokens));
        selected.redactionCount += portableRows.reduce((total, item) => total + item.transforms.length, 0);
        const path = `records/${table}.jsonl`;
        const bytes = Buffer.from(portableRows.map((item) => `${canonicalJson(item)}\n`).join(""), "utf8");
        writeFileSync(join(staging, ...path.split("/")), bytes);
        const columns = tableColumns(this.dependencies.db, table).map((column) => column.name);
        recordInventory.push({
          table,
          columns,
          primary_key: pk,
          schema_digest: sha256(canonicalJson(tableColumns(this.dependencies.db, table))),
          record_count: portableRows.length,
          records_digest: sha256(bytes),
          path,
        });
        selected.records.set(table, portableRows.map((item) => item.row));
      }

      const content = this.exportContent(selected.records.get("artefact_versions") ?? [], workspaceLocator, staging);
      selected.dependencies.push(...content.dependencies);
      selected.dependencies.push(...this.bindingDependencies(selected.records));
      const dependencies = deduplicateDependencies(selected.dependencies);
      const contentInventory = [...content.inventory].sort((left, right) =>
        left.artefact_version_id.localeCompare(right.artefact_version_id));
      const identityPortable = sanitizePortableRecord(identity, sourcePathTokens).row;
      const unsigned = {
        format: WORKSPACE_BUNDLE_FORMAT,
        format_version: WORKSPACE_BUNDLE_FORMAT_VERSION,
        record_version: WORKSPACE_BUNDLE_RECORD_VERSION,
        source_database_schema_version: CURRENT_BUS_SCHEMA_VERSION,
        minimum_target_database_schema_version: CURRENT_BUS_SCHEMA_VERSION,
        workspace_id: workspaceId,
        workspace_identity_digest: sha256(canonicalJson(identityPortable)),
        records: recordInventory,
        content: contentInventory,
        restore_semantics: WORKSPACE_BUNDLE_RESTORE_SEMANTICS,
        unresolved_dependencies: dependencies,
        redaction_count: selected.redactionCount,
      } as const;
      const bundleDigest = sha256(canonicalJson(unsigned));
      const bundleId = `workspace_bundle_${sha256(`${workspaceId}:${bundleDigest}`).slice(0, 32)}`;
      const manifest: WorkspaceBundleManifest = {
        ...unsigned,
        bundle_digest: bundleDigest,
        bundle_id: bundleId,
      };
      writeFileSync(join(staging, "manifest.json"), `${canonicalJson(manifest)}\n`, "utf8");

      const target = join(root, bundleId);
      if (existsSync(target)) {
        const retained = this.validateBundle(target).manifest;
        if (retained.bundle_digest !== bundleDigest) {
          throw new WorkspacePortabilityError(
            "bundle_identity_collision",
            "A different Workspace package already uses this bundle identity.",
            { bundle_id: bundleId },
          );
        }
        removeOwnedStagingDirectory(staging, root);
        return { bundle_id: bundleId, bundle_digest: bundleDigest, workspace_id: workspaceId, bundle_directory: target, manifest: retained };
      }
      renameDirectoryWithWindowsRetry(staging, target);
      return { bundle_id: bundleId, bundle_digest: bundleDigest, workspace_id: workspaceId, bundle_directory: target, manifest };
    } catch (error) {
      if (existsSync(staging)) removeOwnedStagingDirectory(staging, root);
      throw error;
    }
  }

  validateBundle(bundleDirectory: string): WorkspaceBundleValidationResult {
    const bundleRoot = resolve(bundleDirectory);
    if (!existsSync(bundleRoot) || !statSync(bundleRoot).isDirectory()) {
      throw new WorkspacePortabilityError("bundle_not_found", "The Workspace package directory does not exist.");
    }
    assertNoSymlinks(bundleRoot);
    const manifestPath = resolvePackagePath(bundleRoot, "manifest.json");
    let manifest: WorkspaceBundleManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WorkspaceBundleManifest;
    } catch {
      throw new WorkspacePortabilityError("bundle_manifest_invalid", "The Workspace package manifest is not valid JSON.");
    }
    validateManifestShape(manifest);
    const { bundle_id: _bundleId, bundle_digest: _bundleDigest, ...unsigned } = manifest;
    const actualBundleDigest = sha256(canonicalJson(unsigned));
    if (manifest.bundle_digest !== actualBundleDigest) {
      throw new WorkspacePortabilityError("bundle_digest_mismatch", "The Workspace package manifest digest does not match its contents.");
    }
    const expectedBundleId = `workspace_bundle_${sha256(`${manifest.workspace_id}:${manifest.bundle_digest}`).slice(0, 32)}`;
    if (manifest.bundle_id !== expectedBundleId || basename(bundleRoot) !== manifest.bundle_id) {
      throw new WorkspacePortabilityError("bundle_identity_mismatch", "The Workspace package identity or directory name is invalid.");
    }

    const records = new Map<string, readonly SqlRow[]>();
    for (const inventory of manifest.records) {
      if (!PORTABLE_WORKSPACE_TABLES.has(inventory.table)) {
        throw new WorkspacePortabilityError("bundle_table_unsupported", `Workspace package table '${inventory.table}' is not supported.`);
      }
      const path = resolvePackagePath(bundleRoot, inventory.path);
      const bytes = readFileSync(path);
      if (sha256(bytes) !== inventory.records_digest) {
        throw new WorkspacePortabilityError("bundle_records_digest_mismatch", `Workspace package records for '${inventory.table}' changed.`);
      }
      const lines = bytes.toString("utf8").split("\n").filter(Boolean);
      if (lines.length !== inventory.record_count) {
        throw new WorkspacePortabilityError("bundle_record_count_mismatch", `Workspace package record count for '${inventory.table}' changed.`);
      }
      const parsed = lines.map((line) => {
        const value = JSON.parse(line) as PortableRecord;
        if (!value || typeof value !== "object" || !value.row || value.digest !== sha256(canonicalJson(value.row))) {
          throw new WorkspacePortabilityError("bundle_record_digest_mismatch", `A Workspace package record in '${inventory.table}' changed.`);
        }
        return value.row;
      });
      records.set(inventory.table, parsed);
    }
    for (const item of manifest.content) {
      if (item.mode !== "included") continue;
      if (!item.package_path || !item.digest || item.size_bytes === null) {
        throw new WorkspacePortabilityError("bundle_content_manifest_invalid", "Included content is missing its exact package reference.");
      }
      const bytes = readFileSync(resolvePackagePath(bundleRoot, item.package_path));
      if (bytes.length !== item.size_bytes || sha256(bytes) !== item.digest) {
        throw new WorkspacePortabilityError("bundle_content_digest_mismatch", `Content for '${item.artefact_version_id}' changed.`);
      }
    }
    return { bundle_directory: bundleRoot, manifest, records };
  }

  preflightRestore(bundleDirectory: string): WorkspaceBundleValidationResult {
    const validated = this.validateBundle(bundleDirectory);
    this.assertCurrentSchema(this.dependencies.db, "target");
    if (validated.manifest.minimum_target_database_schema_version > CURRENT_BUS_SCHEMA_VERSION) {
      throw new WorkspacePortabilityError(
        "bundle_schema_too_new",
        "This Floe build cannot restore the package's canonical record schema.",
      );
    }
    for (const inventory of validated.manifest.records) {
      if (!tableExists(this.dependencies.db, inventory.table)) {
        throw new WorkspacePortabilityError("restore_table_missing", `The target database does not contain '${inventory.table}'.`);
      }
      const targetColumns = new Set(tableColumns(this.dependencies.db, inventory.table).map((column) => column.name));
      const missing = inventory.columns.filter((column) => !targetColumns.has(column));
      if (missing.length > 0) {
        throw new WorkspacePortabilityError(
          "restore_schema_incompatible",
          `The target database cannot store '${inventory.table}' from this package.`,
          { missing_columns: missing },
        );
      }
    }
    return validated;
  }

  restoreWorkspace(input: Readonly<{
    bundle_directory: string;
    workspace_locator: string;
  }>): WorkspaceBundleRestoreResult {
    const validated = this.preflightRestore(input.bundle_directory);
    const manifest = validated.manifest;
    if (!isAbsolute(input.workspace_locator)) {
      throw new WorkspacePortabilityError("restore_locator_invalid", "Restore requires an absolute host-local Workspace location.");
    }
    const targetWorkspaceRoot = resolve(input.workspace_locator);
    const restoredRows = this.prepareRestoredRows(validated, targetWorkspaceRoot);
    const collision = this.findCollision(restoredRows);
    if (collision) {
      throw new WorkspacePortabilityError(
        "restore_identity_collision",
        `Retained record '${collision.table}' conflicts with the Workspace package.`,
        collision,
      );
    }

    const existingWorkspace = this.dependencies.db.prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
      .get(manifest.workspace_id) as { workspace_id: string } | undefined;
    const needsRecords = [...restoredRows.entries()].some(([table, rows]) =>
      rows.some((row) => !this.findExisting(table, row)));
    const backupPath = existingWorkspace && needsRecords ? this.createVerifiedRestoreBackup(manifest) : null;

    let inserted = 0;
    let retained = 0;
    const createdContentPaths: string[] = [];
    const createdWorkspaceRoot = !existsSync(targetWorkspaceRoot);
    const db = this.dependencies.db;
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of [...restoredRows.keys()].sort((left, right) => restoreTableRank(left) - restoreTableRank(right) || left.localeCompare(right))) {
        for (const row of restoredRows.get(table) ?? []) {
          if (this.findExisting(table, row)) {
            retained += 1;
          } else {
            insertRow(db, table, row);
            inserted += 1;
          }
        }
      }
      this.dependencies.bind_workspace_locator?.(manifest.workspace_id, targetWorkspaceRoot);
      mkdirSync(targetWorkspaceRoot, { recursive: true });
      this.materializeIncludedContent(validated, targetWorkspaceRoot, createdContentPaths);
      const at = this.now();
      db.prepare(`
        INSERT OR IGNORE INTO workspace_portability_restores (
          workspace_id, bundle_id, bundle_digest, format_version,
          source_database_schema_version, state, restored_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, 'held', ?, ?)
      `).run(
        manifest.workspace_id,
        manifest.bundle_id,
        manifest.bundle_digest,
        manifest.format_version,
        manifest.source_database_schema_version,
        at,
        at,
      );
      db.prepare(`
        INSERT INTO workspace_restore_holds (
          workspace_id, bundle_id, bundle_digest, state, reason, restored_at,
          released_at, released_by_principal_id
        ) VALUES (?, ?, ?, 'held', ?, ?, NULL, NULL)
        ON CONFLICT(workspace_id) DO UPDATE SET
          bundle_id = excluded.bundle_id,
          bundle_digest = excluded.bundle_digest,
          state = CASE
            WHEN workspace_restore_holds.bundle_digest = excluded.bundle_digest
              THEN workspace_restore_holds.state
            ELSE 'held'
          END,
          reason = excluded.reason,
          restored_at = CASE
            WHEN workspace_restore_holds.bundle_digest = excluded.bundle_digest
              THEN workspace_restore_holds.restored_at
            ELSE excluded.restored_at
          END,
          released_at = CASE
            WHEN workspace_restore_holds.bundle_digest = excluded.bundle_digest
              THEN workspace_restore_holds.released_at
            ELSE NULL
          END,
          released_by_principal_id = CASE
            WHEN workspace_restore_holds.bundle_digest = excluded.bundle_digest
              THEN workspace_restore_holds.released_by_principal_id
            ELSE NULL
          END
      `).run(
        manifest.workspace_id,
        manifest.bundle_id,
        manifest.bundle_digest,
        "Restored work is held until this host validates its local bindings and the operator explicitly releases it.",
        at,
      );
      for (const dependency of manifest.unresolved_dependencies) {
        db.prepare(`
          INSERT OR IGNORE INTO workspace_portability_dependencies (
            workspace_id, bundle_digest, dependency_id, kind, resource_id,
            reason, state, resolved_at, resolved_by_operation_receipt_id
          ) VALUES (?, ?, ?, ?, ?, ?, 'unresolved', NULL, NULL)
        `).run(
          manifest.workspace_id,
          manifest.bundle_digest,
          dependency.dependency_id,
          dependency.kind,
          dependency.resource_id,
          dependency.reason,
        );
      }
      for (const receipt of restoredRows.get("operation_invocation_ledger") ?? []) {
        if (typeof receipt.receipt_id !== "string" || receipt.receipt_id.length === 0) continue;
        db.prepare(`
          INSERT OR IGNORE INTO workspace_portability_imported_operation_receipts (
            workspace_id, bundle_digest, receipt_id
          ) VALUES (?, ?, ?)
        `).run(manifest.workspace_id, manifest.bundle_digest, receipt.receipt_id);
      }
      const violations = db.prepare("PRAGMA foreign_key_check").all() as Array<Record<string, unknown>>;
      if (violations.length > 0) {
        throw new WorkspacePortabilityError(
          "restore_foreign_key_violation",
          "The Workspace package has unresolved canonical record relationships.",
          { violations: violations.slice(0, 20) },
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      removeMaterializedContent(createdContentPaths, targetWorkspaceRoot);
      if (createdWorkspaceRoot && existsSync(targetWorkspaceRoot)) {
        try { rmSync(targetWorkspaceRoot); } catch {}
      }
      throw error;
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
    return {
      workspace_id: manifest.workspace_id,
      bundle_id: manifest.bundle_id,
      bundle_digest: manifest.bundle_digest,
      state: "held",
      inserted_record_count: inserted,
      retained_record_count: retained,
      unresolved_dependencies: manifest.unresolved_dependencies,
      backup_path: backupPath,
    };
  }

  getRestoreHold(workspaceId: string): WorkspaceRestoreHold | null {
    const row = this.dependencies.db.prepare("SELECT * FROM workspace_restore_holds WHERE workspace_id = ?")
      .get(workspaceId) as WorkspaceRestoreHold | undefined;
    return row ?? null;
  }

  isRestoreHeld(workspaceId: string): boolean {
    return this.getRestoreHold(workspaceId)?.state === "held";
  }

  locateManagedBundle(bundleId: string): string {
    requireStableId(bundleId, "bundle_id");
    const candidate = join(resolve(this.dependencies.bundle_root), bundleId);
    const validated = this.validateBundle(candidate);
    if (validated.manifest.bundle_id !== bundleId) {
      throw new WorkspacePortabilityError("bundle_identity_mismatch", "The managed Workspace package identity is invalid.");
    }
    return candidate;
  }

  listUnresolvedDependencies(workspaceId: string): WorkspaceBundleDependency[] {
    const rows = this.dependencies.db.prepare(`
      SELECT dependency_id, kind, resource_id, reason
      FROM workspace_portability_dependencies
      WHERE workspace_id = ? AND state = 'unresolved'
      ORDER BY kind, resource_id, dependency_id
    `).all(workspaceId) as WorkspaceBundleDependency[];
    return rows;
  }

  hasUnresolvedDependency(
    workspaceId: string,
    kind: WorkspaceBundleDependency["kind"],
    resourceId: string,
  ): boolean {
    return Boolean(this.dependencies.db.prepare(`
      SELECT 1
      FROM workspace_portability_dependencies
      WHERE workspace_id = ? AND kind = ? AND resource_id = ? AND state = 'unresolved'
      LIMIT 1
    `).get(workspaceId, kind, resourceId));
  }

  requireOperationReceiptId(invocationId: string): string {
    const row = this.dependencies.db.prepare(`
      SELECT receipt_id FROM operation_invocation_ledger WHERE invocation_id = ?
    `).get(invocationId) as { receipt_id: string } | undefined;
    if (!row) {
      throw new WorkspacePortabilityError("restore_operation_receipt_missing", "The governed restore operation receipt is unavailable.");
    }
    return row.receipt_id;
  }

  supplyContentDependency(input: Readonly<{
    workspace_id: string;
    expected_bundle_digest: string;
    dependency_id: string;
    source_path: string;
  }>): WorkspaceSuppliedContent {
    const hold = this.requireCurrentHold(input.workspace_id, input.expected_bundle_digest);
    if (hold.state !== "held") {
      throw new WorkspacePortabilityError("restore_hold_released", "This Workspace restore is no longer waiting for content.");
    }
    const pending = this.dependencies.db.prepare(`
      SELECT dependency_id, kind, resource_id, reason
      FROM workspace_portability_dependencies
      WHERE workspace_id = ? AND bundle_digest = ? AND dependency_id = ? AND state = 'unresolved'
    `).get(input.workspace_id, input.expected_bundle_digest, input.dependency_id) as WorkspaceBundleDependency | undefined;
    if (!pending || pending.kind !== "content") {
      throw new WorkspacePortabilityError("restore_content_dependency_not_found", "The selected unresolved content dependency is unavailable.");
    }
    if (!isAbsolute(input.source_path)) {
      throw new WorkspacePortabilityError("restore_content_source_invalid", "Content recovery requires an absolute host-local file path.");
    }
    const sourcePath = resolve(input.source_path);
    if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile() || lstatSync(sourcePath).isSymbolicLink()) {
      throw new WorkspacePortabilityError("restore_content_source_invalid", "The selected content recovery source is not a regular file.");
    }
    const version = this.dependencies.db.prepare(`
      SELECT versions.content_ref_json
      FROM artefact_versions AS versions
      JOIN artefacts ON artefacts.artefact_id = versions.artefact_id
      WHERE versions.artefact_version_id = ? AND artefacts.workspace_id = ?
    `).get(pending.resource_id, input.workspace_id) as { content_ref_json: string } | undefined;
    if (!version) {
      throw new WorkspacePortabilityError("restore_content_identity_missing", "The exact retained ArtefactVersion is unavailable.");
    }
    const contentRef = parseJsonObject(version.content_ref_json, "restored content reference");
    const digest = contentDigest(contentRef);
    const relativePath = typeof contentRef.path === "string" ? contentRef.path : null;
    if (contentRef.kind !== "workspace-relative" || !digest || !relativePath) {
      throw new WorkspacePortabilityError(
        "restore_content_digest_missing",
        "This content dependency cannot be resolved without its exact retained digest.",
      );
    }
    const bytes = readFileSync(sourcePath);
    if (sha256(bytes) !== digest) {
      throw new WorkspacePortabilityError("restore_content_digest_mismatch", "The selected file is not the exact missing content.");
    }
    const workspaceRoot = this.dependencies.workspace_locator(input.workspace_id);
    if (!workspaceRoot) {
      throw new WorkspacePortabilityError("workspace_locator_unavailable", "The restored Workspace is not attached to this host.");
    }
    const destination = resolveWithinRoot(workspaceRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    if (existsSync(destination)) {
      if (sha256(readFileSync(destination)) !== digest) {
        throw new WorkspacePortabilityError("restore_content_collision", "Existing Workspace content conflicts with the missing exact content.");
      }
    } else {
      const temporary = `${destination}.restore-${digest.slice(0, 16)}.tmp`;
      try {
        writeFileSync(temporary, bytes, { flag: "wx" });
        renameSync(temporary, destination);
      } finally {
        if (existsSync(temporary)) rmSync(temporary, { force: true });
      }
    }
    return {
      workspace_id: input.workspace_id,
      bundle_digest: hold.bundle_digest,
      dependency_id: pending.dependency_id,
      artefact_version_id: pending.resource_id,
      digest,
      size_bytes: bytes.length,
    };
  }

  reconcileRestoreDependencies(input: Readonly<{
    workspace_id: string;
    expected_bundle_digest: string;
    reconciliation_operation_receipt_id: string;
  }>): WorkspaceDependencyReconciliationResult {
    const hold = this.requireCurrentHold(input.workspace_id, input.expected_bundle_digest);
    const pending = this.listUnresolvedDependencies(input.workspace_id);
    const resolved: WorkspaceBundleDependency[] = [];
    const at = this.now();
    this.dependencies.db.exec("SAVEPOINT reconcile_workspace_restore_dependencies");
    try {
      for (const item of pending) {
        const proofReceipt = this.dependencyResolutionReceipt(item, hold, input.reconciliation_operation_receipt_id);
        if (!proofReceipt) continue;
        this.dependencies.db.prepare(`
          UPDATE workspace_portability_dependencies
          SET state = 'resolved', resolved_at = ?, resolved_by_operation_receipt_id = ?
          WHERE workspace_id = ? AND bundle_digest = ? AND dependency_id = ? AND state = 'unresolved'
        `).run(at, proofReceipt, input.workspace_id, hold.bundle_digest, item.dependency_id);
        resolved.push(item);
      }
      this.dependencies.db.exec("RELEASE SAVEPOINT reconcile_workspace_restore_dependencies");
    } catch (error) {
      this.dependencies.db.exec("ROLLBACK TO SAVEPOINT reconcile_workspace_restore_dependencies");
      this.dependencies.db.exec("RELEASE SAVEPOINT reconcile_workspace_restore_dependencies");
      throw error;
    }
    return {
      resolved_dependencies: resolved,
      unresolved_dependencies: this.listUnresolvedDependencies(input.workspace_id),
    };
  }

  releaseRestoreHold(input: Readonly<{
    workspace_id: string;
    expected_bundle_digest: string;
    principal_id: string;
  }>): WorkspaceRestoreHold {
    const hold = this.getRestoreHold(input.workspace_id);
    if (!hold || hold.bundle_digest !== input.expected_bundle_digest) {
      throw new WorkspacePortabilityError("restore_hold_changed", "The retained restore hold changed before it could be released.");
    }
    if (hold.state === "released") return hold;
    const unresolved = this.listUnresolvedDependencies(input.workspace_id);
    if (unresolved.length > 0) {
      throw new WorkspacePortabilityError(
        "restore_dependencies_unresolved",
        "This Workspace still has local bindings that must be resolved before work can resume.",
        { dependencies: unresolved },
      );
    }
    const incompleteEvidence = this.dependencies.db.prepare(`
      SELECT dependencies.dependency_id, dependencies.resolved_by_operation_receipt_id
      FROM workspace_portability_dependencies AS dependencies
      LEFT JOIN operation_invocation_ledger AS ledger
        ON ledger.receipt_id = dependencies.resolved_by_operation_receipt_id
      WHERE dependencies.workspace_id = ? AND dependencies.bundle_digest = ?
        AND dependencies.state = 'resolved'
        AND (ledger.receipt_id IS NULL OR ledger.state <> 'completed')
      ORDER BY dependencies.dependency_id
    `).all(input.workspace_id, input.expected_bundle_digest) as Array<{
      dependency_id: string; resolved_by_operation_receipt_id: string | null;
    }>;
    if (incompleteEvidence.length > 0) {
      throw new WorkspacePortabilityError(
        "restore_dependency_evidence_incomplete",
        "One or more restore dependency receipts have not completed.",
        { dependencies: incompleteEvidence },
      );
    }
    const at = this.now();
    this.dependencies.db.prepare(`
      UPDATE workspace_restore_holds
      SET state = 'released', released_at = ?, released_by_principal_id = ?
      WHERE workspace_id = ? AND bundle_digest = ? AND state = 'held'
    `).run(at, input.principal_id, input.workspace_id, input.expected_bundle_digest);
    this.dependencies.db.prepare(`
      UPDATE workspace_portability_restores SET state = 'released'
      WHERE workspace_id = ? AND bundle_digest = ?
    `).run(input.workspace_id, input.expected_bundle_digest);
    return this.getRestoreHold(input.workspace_id) as WorkspaceRestoreHold;
  }

  private requireCurrentHold(workspaceId: string, expectedBundleDigest: string): WorkspaceRestoreHold {
    const hold = this.getRestoreHold(workspaceId);
    if (!hold || hold.bundle_digest !== expectedBundleDigest) {
      throw new WorkspacePortabilityError("restore_hold_changed", "The retained restore hold changed before it could be reconciled.");
    }
    return hold;
  }

  private dependencyResolutionReceipt(
    item: WorkspaceBundleDependency,
    hold: WorkspaceRestoreHold,
    reconciliationReceiptId: string,
  ): string | null {
    if (item.kind === "endpoint_attachment") {
      const endpoint = this.dependencies.db.prepare(`
        SELECT endpoint_id, bridge_id, status, updated_at
        FROM endpoints WHERE endpoint_id = ? AND workspace_id = ?
      `).get(item.resource_id, hold.workspace_id) as {
        endpoint_id: string; bridge_id: string | null; status: string; updated_at: string;
      } | undefined;
      if (!endpoint?.bridge_id || ["offline", "error", "retired", "runtime_unconfigured"].includes(endpoint.status)) return null;
      const bridge = this.dependencies.db.prepare(`
        SELECT status, last_seen_at FROM bridges WHERE bridge_id = ?
      `).get(endpoint.bridge_id) as { status: string; last_seen_at: string } | undefined;
      return bridge?.status === "online"
        && endpoint.updated_at >= hold.restored_at
        && bridge.last_seen_at >= hold.restored_at
        ? reconciliationReceiptId
        : null;
    }

    if (item.kind === "secret_ref") {
      const ref = this.dependencies.db.prepare(`
        SELECT resolution FROM secret_refs
        WHERE secret_ref_id = ? AND owner_kind = 'workspace' AND owner_id = ?
      `).get(item.resource_id, hold.workspace_id) as { resolution: string } | undefined;
      if (ref?.resolution !== "resolved") return null;
      return this.completedWorkspaceOperationReceipt(hold, ["credential.bind", "credential.rotate"], "secret_ref", item.resource_id)?.receipt_id ?? null;
    }

    if (item.kind === "actor_runtime") {
      const original = this.dependencies.db.prepare(`
        SELECT actor_id FROM actor_runtime_bindings
        WHERE actor_runtime_binding_id = ? AND workspace_id = ?
      `).get(item.resource_id, hold.workspace_id) as { actor_id: string } | undefined;
      if (!original) return null;
      const current = this.dependencies.db.prepare(`
        SELECT actor_runtime_binding_id
        FROM actor_runtime_bindings
        WHERE actor_id = ? AND workspace_id = ? AND superseded_at IS NULL AND status = 'resolved'
      `).get(original.actor_id, hold.workspace_id) as { actor_runtime_binding_id: string } | undefined;
      const receipt = this.completedWorkspaceOperationReceipt(
        hold,
        ["actor.runtime-binding.replace"],
        "actor_runtime_binding",
        item.resource_id,
      );
      return current && receipt && receipt.changed_refs.some((ref) =>
        ref.kind === "actor_runtime_binding" && ref.id === current.actor_runtime_binding_id)
        ? receipt.receipt_id
        : null;
    }

    if (item.kind === "connector_runtime") {
      const binding = this.dependencies.db.prepare(`
        SELECT current_revision_id FROM connector_bindings
        WHERE connector_binding_id = ? AND owner_kind = 'workspace' AND owner_id = ? AND status = 'enabled'
      `).get(item.resource_id, hold.workspace_id) as { current_revision_id: string } | undefined;
      const receipt = this.completedWorkspaceOperationReceipt(
        hold,
        ["connector.health.record"],
        "connector_binding",
        item.resource_id,
      );
      if (!binding || !receipt) return null;
      const healthIds = receipt.changed_refs
        .filter((ref) => ref.kind === "connector_health_observation")
        .map((ref) => ref.id);
      if (healthIds.length === 0) return null;
      const placeholders = healthIds.map(() => "?").join(", ");
      const health = this.dependencies.db.prepare(`
        SELECT 1 FROM connector_health_observations
        WHERE connector_health_observation_id IN (${placeholders})
          AND connector_binding_id = ? AND connector_binding_revision_id = ?
          AND owner_kind = 'workspace' AND owner_id = ? AND status = 'healthy'
        LIMIT 1
      `).get(...healthIds, item.resource_id, binding.current_revision_id, hold.workspace_id);
      return health ? receipt.receipt_id : null;
    }

    if (item.kind === "command_runtime") {
      const attempt = this.dependencies.db.prepare(`
        SELECT status FROM execution_attempts WHERE attempt_id = ?
      `).get(item.resource_id) as { status: string } | undefined;
      if (!attempt || !["pending", "running"].includes(attempt.status)) return reconciliationReceiptId;
      const worker = this.dependencies.db.prepare(`
        SELECT command_worker_binding_id, worker_endpoint_id
        FROM command_worker_bindings
        WHERE workspace_id = ? AND status = 'available' AND updated_at >= ?
        ORDER BY updated_at DESC LIMIT 1
      `).get(hold.workspace_id, hold.restored_at) as {
        command_worker_binding_id: string; worker_endpoint_id: string;
      } | undefined;
      if (!worker) return null;
      const endpoint = this.dependencies.db.prepare(`
        SELECT status, bridge_id, metadata_json, updated_at
        FROM endpoints WHERE endpoint_id = ? AND workspace_id = ?
      `).get(worker.worker_endpoint_id, hold.workspace_id) as {
        status: string; bridge_id: string | null; metadata_json: string; updated_at: string;
      } | undefined;
      if (!endpoint || endpoint.bridge_id !== null || ["offline", "error", "retired"].includes(endpoint.status)
        || endpoint.updated_at < hold.restored_at) return null;
      const metadata = parseJsonObject(endpoint.metadata_json, "Command worker Endpoint metadata");
      return metadata.command_worker_binding_id === worker.command_worker_binding_id
        ? reconciliationReceiptId
        : null;
    }

    if (item.kind === "extension_runtime") {
      const installation = this.dependencies.db.prepare(`
        SELECT installed_package_version_id, lifecycle
        FROM extension_installations
        WHERE extension_installation_id = ? AND workspace_id = ?
      `).get(item.resource_id, hold.workspace_id) as {
        installed_package_version_id: string | null; lifecycle: string;
      } | undefined;
      const receipt = this.completedWorkspaceOperationReceipt(
        hold,
        ["extension.enable"],
        "extension_installation",
        item.resource_id,
      );
      if (!installation?.installed_package_version_id || installation.lifecycle !== "enabled" || !receipt) return null;
      const attempt = this.dependencies.db.prepare(`
        SELECT 1 FROM extension_activation_attempts
        WHERE invocation_id = ? AND workspace_id = ? AND extension_installation_id = ?
          AND extension_package_version_id = ? AND operation_id = 'extension.enable' AND state = 'completed'
      `).get(
        receipt.invocation_id,
        hold.workspace_id,
        item.resource_id,
        installation.installed_package_version_id,
      );
      return attempt ? receipt.receipt_id : null;
    }

    if (item.kind === "content") {
      const version = this.dependencies.db.prepare(`
        SELECT versions.content_ref_json
        FROM artefact_versions AS versions
        JOIN artefacts ON artefacts.artefact_id = versions.artefact_id
        WHERE versions.artefact_version_id = ? AND artefacts.workspace_id = ?
      `).get(item.resource_id, hold.workspace_id) as { content_ref_json: string } | undefined;
      if (!version) return null;
      const contentRef = parseJsonObject(version.content_ref_json, "restored content reference");
      const digest = contentDigest(contentRef);
      const path = typeof contentRef.path === "string" ? contentRef.path : null;
      const workspaceRoot = this.dependencies.workspace_locator(hold.workspace_id);
      if (contentRef.kind !== "workspace-relative" || !digest || !path || !workspaceRoot) return null;
      const destination = resolveWithinRoot(workspaceRoot, path);
      if (!existsSync(destination) || !lstatSync(destination).isFile() || sha256(readFileSync(destination)) !== digest) return null;
      return this.completedContentSupplyReceipt(hold, item.dependency_id, item.resource_id, digest)?.receipt_id ?? null;
    }

    return null;
  }

  private completedWorkspaceOperationReceipt(
    hold: WorkspaceRestoreHold,
    operationIds: readonly string[],
    targetKind: string,
    targetId: string,
  ): MinimalOperationReceipt | null {
    if (operationIds.length === 0) return null;
    const placeholders = operationIds.map(() => "?").join(", ");
    const rows = this.dependencies.db.prepare(`
      SELECT ledger.receipt_id, ledger.invocation_id, ledger.operation_id, ledger.receipt_json
      FROM operation_invocation_ledger AS ledger
      WHERE ledger.boundary_kind = 'workspace' AND ledger.boundary_id = ?
        AND ledger.operation_id IN (${placeholders}) AND ledger.state = 'completed'
        AND ledger.completed_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM workspace_portability_imported_operation_receipts AS imported
          WHERE imported.workspace_id = ? AND imported.bundle_digest = ?
            AND imported.receipt_id = ledger.receipt_id
        )
      ORDER BY ledger.completed_at DESC, ledger.receipt_id DESC
    `).all(
      hold.workspace_id,
      ...operationIds,
      hold.restored_at,
      hold.workspace_id,
      hold.bundle_digest,
    ) as Array<{ receipt_id: string; invocation_id: string; operation_id: string; receipt_json: string }>;
    for (const row of rows) {
      const receipt = parseMinimalOperationReceipt(row);
      if (receipt.target?.kind === targetKind && receipt.target.id === targetId) return receipt;
    }
    return null;
  }

  private completedContentSupplyReceipt(
    hold: WorkspaceRestoreHold,
    dependencyId: string,
    artefactVersionId: string,
    digest: string,
  ): MinimalOperationReceipt | null {
    const rows = this.dependencies.db.prepare(`
      SELECT ledger.receipt_id, ledger.invocation_id, ledger.operation_id, ledger.receipt_json
      FROM operation_invocation_ledger AS ledger
      WHERE ledger.operation_id = ? AND ledger.state = 'completed' AND ledger.completed_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM workspace_portability_imported_operation_receipts AS imported
          WHERE imported.workspace_id = ? AND imported.bundle_digest = ?
            AND imported.receipt_id = ledger.receipt_id
        )
      ORDER BY ledger.completed_at DESC, ledger.receipt_id DESC
    `).all(
      SUPPLY_WORKSPACE_CONTENT_OPERATION_ID,
      hold.restored_at,
      hold.workspace_id,
      hold.bundle_digest,
    ) as Array<{ receipt_id: string; invocation_id: string; operation_id: string; receipt_json: string }>;
    for (const row of rows) {
      const receipt = parseMinimalOperationReceipt(row);
      const result = receipt.result;
      if (
        result?.workspace_id === hold.workspace_id
        && result.bundle_digest === hold.bundle_digest
        && result.dependency_id === dependencyId
        && result.artefact_version_id === artefactVersionId
        && result.digest === digest
      ) return receipt;
    }
    return null;
  }

  private selectWorkspaceRecords(workspaceId: string): MutableExport {
    const records = new Map<string, SqlRow[]>();
    const primaryKeys = new Map<string, string[]>();
    const existingTables = listTables(this.dependencies.db);
    for (const table of [...PORTABLE_WORKSPACE_TABLES].sort()) {
      if (!existingTables.has(table)) continue;
      primaryKeys.set(table, tablePrimaryKey(this.dependencies.db, table));
      const columns = new Set(tableColumns(this.dependencies.db, table).map((column) => column.name));
      let rows: SqlRow[] = [];
      if (table === "workspaces") {
        rows = queryRows(this.dependencies.db, table, "workspace_id = ?", [workspaceId]);
      } else if (columns.has("workspace_id") && !DIRECT_SCOPE_EXCEPTIONS.has(table)) {
        rows = queryRows(this.dependencies.db, table, "workspace_id = ?", [workspaceId]);
      } else if (columns.has("owner_kind") && columns.has("owner_id")) {
        rows = queryRows(this.dependencies.db, table, "owner_kind = 'workspace' AND owner_id = ?", [workspaceId]);
      } else if (columns.has("boundary_kind") && columns.has("boundary_id")) {
        rows = queryRows(this.dependencies.db, table, "boundary_kind = 'workspace' AND boundary_id = ?", [workspaceId]);
      } else if (table === "secret_refs") {
        rows = queryRows(this.dependencies.db, table, "owner_kind = 'workspace' AND owner_id = ?", [workspaceId]);
      } else if (table === "secret_access_audit") {
        rows = queryRows(this.dependencies.db, table, "authority_boundary_kind = 'workspace' AND authority_boundary_id = ?", [workspaceId]);
      } else if (table === "capability_grants") {
        rows = queryRows(this.dependencies.db, table, "boundary_kind = 'workspace' AND boundary_id = ?", [workspaceId]);
      } else if (table === "operation_invocation_ledger") {
        rows = queryRows(this.dependencies.db, table, "boundary_kind = 'workspace' AND boundary_id = ?", [workspaceId]);
      }
      if (table === "endpoints") {
        rows = rows.filter((row) => {
          try {
            return parseJsonObject(row.metadata_json, "Endpoint metadata").endpoint_kind !== "command_worker";
          } catch {
            return true;
          }
        });
      }
      if (rows.length > 0) records.set(table, rows);
    }

    const seen = new Map<string, Set<string>>();
    for (const [table, rows] of records) {
      const pk = primaryKeys.get(table) ?? [];
      const keys = new Set(rows.map((row) => rowIdentity(row, pk)));
      seen.set(table, keys);
    }

    const relationships = portableRelationships(this.dependencies.db, existingTables);
    let changed = true;
    while (changed) {
      changed = false;
      for (const relationship of relationships) {
        changed = addRelatedRecords(
          this.dependencies.db,
          records,
          primaryKeys,
          seen,
          relationship,
          "children",
        ) || changed;
        changed = addRelatedRecords(
          this.dependencies.db,
          records,
          primaryKeys,
          seen,
          relationship,
          "parents",
        ) || changed;
      }
    }
    return { records, primaryKeys, redactionCount: 0, dependencies: [] };
  }

  private exportContent(
    versionRows: readonly SqlRow[],
    workspaceLocator: string | null,
    stagingDirectory: string,
  ): { inventory: WorkspaceBundleContentInventory[]; dependencies: WorkspaceBundleDependency[] } {
    const inventory: WorkspaceBundleContentInventory[] = [];
    const dependencies: WorkspaceBundleDependency[] = [];
    for (const row of versionRows) {
      const versionId = String(row.artefact_version_id);
      const contentRef = parseJsonObject(row.content_ref_json, `ArtefactVersion '${versionId}' content reference`);
      const kind = String(contentRef.kind ?? "");
      const digest = contentDigest(contentRef);
      const size = typeof contentRef.size_bytes === "number" ? contentRef.size_bytes : null;
      const media = typeof contentRef.media_type === "string" ? contentRef.media_type : null;
      if (kind === "workspace-relative" && workspaceLocator && digest) {
        const portablePath = typeof contentRef.path === "string" ? contentRef.path : "";
        try {
          const source = resolveWithinRoot(workspaceLocator, portablePath);
          const stat = statSync(source);
          if (!stat.isFile()) throw new Error("not a file");
          const bytes = readFileSync(source);
          if (sha256(bytes) !== digest || (size !== null && size !== bytes.length)) throw new Error("digest or size mismatch");
          if (containsSensitivePortableText(bytes, workspaceLocator)) throw new Error("content contains non-portable host or credential material");
          const packagePath = `content/sha256/${digest}`;
          const destination = resolvePackagePath(stagingDirectory, packagePath);
          if (!existsSync(destination)) writeFileSync(destination, bytes);
          inventory.push({
            artefact_version_id: versionId,
            mode: "included",
            digest,
            size_bytes: bytes.length,
            media_type: media,
            resolver_id: null,
            package_path: packagePath,
            reason: null,
          });
          continue;
        } catch (error) {
          const reason = `Exact Workspace content was not portable: ${(error as Error).message}`;
          inventory.push({
            artefact_version_id: versionId,
            mode: "unresolved",
            digest,
            size_bytes: size,
            media_type: media,
            resolver_id: null,
            package_path: null,
            reason,
          });
          dependencies.push(dependency("content", versionId, reason));
          continue;
        }
      }
      const resolverId = typeof contentRef.resolver_id === "string" ? contentRef.resolver_id : null;
      const resolver = resolverId ? this.dependencies.portable_content_resolvers?.get(resolverId) : null;
      if (resolver && resolver.guaranteesPortableExactReference(contentRef)) {
        inventory.push({
          artefact_version_id: versionId,
          mode: "portable_external",
          digest,
          size_bytes: size,
          media_type: media,
          resolver_id: resolverId,
          package_path: null,
          reason: null,
        });
      } else {
        const reason = kind === "workspace-relative"
          ? "The source Workspace locator or exact bytes were unavailable."
          : "No installed resolver guarantees this exact reference is portable across hosts.";
        inventory.push({
          artefact_version_id: versionId,
          mode: "unresolved",
          digest,
          size_bytes: size,
          media_type: media,
          resolver_id: resolverId,
          package_path: null,
          reason,
        });
        dependencies.push(dependency("content", versionId, reason));
      }
    }
    return { inventory, dependencies };
  }

  private bindingDependencies(records: ReadonlyMap<string, readonly SqlRow[]>): WorkspaceBundleDependency[] {
    const dependencies: WorkspaceBundleDependency[] = [];
    for (const row of records.get("secret_refs") ?? []) {
      dependencies.push(dependency("secret_ref", String(row.secret_ref_id), "Credential material is never exported; explicitly reconnect this SecretRef on the target host."));
    }
    for (const row of records.get("endpoints") ?? []) {
      if (row.bridge_id != null) dependencies.push(dependency("endpoint_attachment", String(row.endpoint_id), "Endpoint attachment belongs to the source host and must be re-established."));
    }
    for (const row of records.get("actor_runtime_bindings") ?? []) {
      if (row.status === "resolved" && row.superseded_at == null) {
        dependencies.push(dependency("actor_runtime", String(row.actor_runtime_binding_id), "The pinned runtime profile is retained, but host runtime availability must be revalidated."));
      }
    }
    for (const row of records.get("connector_bindings") ?? []) {
      if (row.status === "enabled") dependencies.push(dependency("connector_runtime", String(row.connector_binding_id), "The exact Connector revision is retained, but its implementation and external account must be revalidated."));
    }
    for (const row of records.get("extension_installations") ?? []) {
      if (row.lifecycle === "enabled" || row.lifecycle === "rolled_back") {
        dependencies.push(dependency("extension_runtime", String(row.extension_installation_id), "The exact Extension package pin is retained, but package bytes, permissions, and isolation must be revalidated."));
      }
    }
    const attempts = new Map((records.get("execution_attempts") ?? []).map((row) => [String(row.attempt_id), row]));
    for (const row of records.get("command_attempt_contracts") ?? []) {
      const attemptId = String(row.attempt_id);
      const status = attempts.get(attemptId)?.status;
      if (status === "pending" || status === "running") {
        dependencies.push(dependency(
          "command_runtime",
          attemptId,
          "The retained Command attempt names its origin worker only as history; a target-host Command worker must be attached before work can resume.",
        ));
      }
    }
    return dependencies;
  }

  private prepareRestoredRows(
    validated: WorkspaceBundleValidationResult,
    targetWorkspaceRoot: string,
  ): Map<string, SqlRow[]> {
    const contentByVersion = new Map(validated.manifest.content.map((item) => [item.artefact_version_id, item]));
    const result = new Map<string, SqlRow[]>();
    for (const [table, rows] of validated.records) {
      result.set(table, rows.map((source) => {
        const row = cloneSqlRow(source);
        if (table === "secret_refs") {
          row.resolution = "unresolved";
          row.broker_id = null;
          row.broker_locator = null;
        } else if (table === "endpoints") {
          row.bridge_id = null;
          row.status = "offline";
        } else if (table === "actor_runtime_bindings" && row.status === "resolved") {
          row.status = "unresolved";
          const reasons = parseJsonArray(row.unresolved_reasons_json);
          if (!reasons.some((value) => value === "workspace_restore_requires_runtime_validation")) {
            reasons.push("workspace_restore_requires_runtime_validation");
          }
          row.unresolved_reasons_json = canonicalJson(reasons);
        } else if (table === "artefact_versions") {
          const versionId = String(row.artefact_version_id);
          const content = contentByVersion.get(versionId);
          if (content?.mode === "included" && content.digest) {
            const path = `.floe/portable-content/sha256/${content.digest}`;
            row.content_ref_json = canonicalJson({
              kind: "workspace-relative",
              path,
              digest: { algorithm: "sha256", value: content.digest },
              ...(content.media_type ? { media_type: content.media_type } : {}),
              ...(content.size_bytes !== null ? { size_bytes: content.size_bytes } : {}),
            });
          } else if (content?.mode === "unresolved") {
            const original = parseJsonObject(row.content_ref_json, "unresolved content reference");
            const originalDigest = content.digest ?? contentDigest(original);
            if (originalDigest) {
              row.content_ref_json = canonicalJson({
                kind: "workspace-relative",
                path: `.floe/portable-content/sha256/${originalDigest}`,
                digest: { algorithm: "sha256", value: originalDigest },
                ...(content.media_type ? { media_type: content.media_type } : {}),
                ...(content.size_bytes !== null ? { size_bytes: content.size_bytes } : {}),
              });
            }
          }
        }
        return row;
      }));
    }
    void targetWorkspaceRoot;
    return result;
  }

  private materializeIncludedContent(
    validated: WorkspaceBundleValidationResult,
    workspaceRoot: string,
    createdPaths: string[],
  ): void {
    for (const item of validated.manifest.content) {
      if (item.mode !== "included" || !item.package_path || !item.digest) continue;
      const source = resolvePackagePath(validated.bundle_directory, item.package_path);
      const destination = resolveWithinRoot(workspaceRoot, `.floe/portable-content/sha256/${item.digest}`);
      mkdirSync(dirname(destination), { recursive: true });
      const bytes = readFileSync(source);
      if (existsSync(destination)) {
        const existing = readFileSync(destination);
        if (sha256(existing) !== item.digest) {
          throw new WorkspacePortabilityError("restore_content_collision", "Existing Workspace content conflicts with the package digest.", { digest: item.digest });
        }
      } else {
        createdPaths.push(destination);
        writeFileSync(destination, bytes);
      }
    }
  }

  private findCollision(records: ReadonlyMap<string, readonly SqlRow[]>): { table: string; identity: string } | null {
    for (const [table, rows] of records) {
      for (const row of rows) {
        const existing = this.findExisting(table, row);
        if (existing && canonicalJson(existing) !== canonicalJson(row)) {
          return { table, identity: rowIdentity(row, tablePrimaryKey(this.dependencies.db, table)) };
        }
      }
    }
    return null;
  }

  private findExisting(table: string, row: SqlRow): SqlRow | null {
    const primaryKey = tablePrimaryKey(this.dependencies.db, table);
    if (primaryKey.length === 0) {
      throw new WorkspacePortabilityError("restore_table_without_identity", `Table '${table}' has no stable primary key.`);
    }
    const where = primaryKey.map((column) => `${quoteIdentifier(column)} IS ?`).join(" AND ");
    return (this.dependencies.db.prepare(`SELECT * FROM ${quoteIdentifier(table)} WHERE ${where}`)
      .get(...primaryKey.map((column) => row[column])) as SqlRow | undefined) ?? null;
  }

  private createVerifiedRestoreBackup(manifest: WorkspaceBundleManifest): string {
    if (this.dependencies.database_path === ":memory:") {
      throw new WorkspacePortabilityError("restore_backup_required", "An existing in-memory Workspace cannot be changed without a recoverable backup.");
    }
    const backupDirectory = join(dirname(this.dependencies.database_path), "backups");
    mkdirSync(backupDirectory, { recursive: true });
    const backupPath = join(
      backupDirectory,
      `${basename(this.dependencies.database_path).replace(/\.sqlite$/i, "")}.before-restore-${manifest.bundle_digest.slice(0, 12)}.${this.now().replace(/[:.]/g, "-")}.sqlite`,
    );
    if (existsSync(backupPath)) {
      throw new WorkspacePortabilityError("restore_backup_collision", "The intended pre-restore backup path already exists.");
    }
    const quoted = backupPath.replaceAll("'", "''");
    this.dependencies.db.exec(`VACUUM INTO '${quoted}'`);
    this.dependencies.db.exec(`ATTACH DATABASE '${quoted}' AS floe_portability_backup`);
    try {
      const result = this.dependencies.db.prepare("PRAGMA floe_portability_backup.integrity_check").get() as { integrity_check?: string };
      if (result.integrity_check !== "ok") {
        throw new WorkspacePortabilityError("restore_backup_invalid", "The pre-restore backup failed its SQLite integrity check.");
      }
    } finally {
      this.dependencies.db.exec("DETACH DATABASE floe_portability_backup");
    }
    return backupPath;
  }

  private assertCurrentSchema(db: DatabaseSync, boundary: "source" | "target"): void {
    const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version !== CURRENT_BUS_SCHEMA_VERSION) {
      throw new WorkspacePortabilityError(
        `${boundary}_schema_incompatible`,
        `The ${boundary} database schema is ${version}; this exporter requires ${CURRENT_BUS_SCHEMA_VERSION}.`,
        { found: version, supported: CURRENT_BUS_SCHEMA_VERSION },
      );
    }
  }

  private assertEveryWorkspaceTableClassified(): void {
    for (const table of listTables(this.dependencies.db)) {
      if (PORTABLE_WORKSPACE_TABLES.has(table) || NON_PORTABLE_HOST_TABLES.has(table)) continue;
      throw new WorkspacePortabilityError(
        "workspace_table_unclassified",
        `Application table '${table}' has not been classified as portable Workspace state or host-only state.`,
      );
    }
  }
}

function restoreTableRank(table: string): number {
  if (table === "workspaces") return 0;
  if (["scopes", "contexts", "actors", "runtime_profiles", "connector_definitions", "canonical_extensions", "policies", "capability_grants", "artefacts"].includes(table)) return 10;
  if (table.endsWith("_revisions") || table === "artefact_versions" || table === "secret_refs") return 20;
  return 50;
}

function dependency(kind: WorkspaceBundleDependency["kind"], resourceId: string, reason: string): WorkspaceBundleDependency {
  return {
    dependency_id: `dependency_${sha256(`${kind}:${resourceId}:${reason}`).slice(0, 32)}`,
    kind,
    resource_id: resourceId,
    reason,
  };
}

function deduplicateDependencies(values: readonly WorkspaceBundleDependency[]): WorkspaceBundleDependency[] {
  return [...new Map(values.map((value) => [value.dependency_id, value])).values()]
    .sort((left, right) => left.kind.localeCompare(right.kind)
      || left.resource_id.localeCompare(right.resource_id)
      || left.dependency_id.localeCompare(right.dependency_id));
}

function contentDigest(contentRef: Readonly<Record<string, unknown>>): string | null {
  const digest = contentRef.digest;
  if (!digest || typeof digest !== "object" || Array.isArray(digest)) return null;
  const record = digest as Record<string, unknown>;
  return record.algorithm === "sha256" && typeof record.value === "string" && /^[a-f0-9]{64}$/i.test(record.value)
    ? record.value.toLowerCase()
    : null;
}

function containsSensitivePortableText(bytes: Buffer, sourceWorkspaceLocator: string): boolean {
  const text = bytes.toString("utf8");
  if (text.includes(sourceWorkspaceLocator)) return true;
  return SECRET_VALUE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function sanitizePortableRecord(row: SqlRow, sourcePaths: readonly string[]): PortableRecord {
  const transforms: string[] = [];
  const portable: SqlRow = {};
  for (const [column, value] of Object.entries(row)) {
    if (typeof value !== "string") {
      portable[column] = value;
      continue;
    }
    if (column === "broker_locator") {
      portable[column] = null;
      if (value) transforms.push(`${column}:credential-binding-removed`);
      continue;
    }
    if (column.endsWith("_json") || column === "event_types") {
      try {
        const parsed = JSON.parse(value) as unknown;
        const result = sanitizeJsonValue(parsed, sourcePaths, [column]);
        portable[column] = canonicalJson(result.value);
        transforms.push(...result.transforms);
        continue;
      } catch {
        // Invalid legacy JSON remains evidence, but still receives string redaction.
      }
    }
    const sanitized = sanitizeString(value, sourcePaths);
    portable[column] = sanitized.value;
    if (sanitized.changed) transforms.push(`${column}:redacted`);
  }
  if (row.resolution === "resolved" && "broker_locator" in row) {
    portable.resolution = "unresolved";
    portable.broker_id = null;
    portable.broker_locator = null;
    transforms.push("credential-binding:unresolved");
  }
  return {
    digest: sha256(canonicalJson(portable)),
    source_digest: sha256(canonicalJson(row)),
    transforms: [...new Set(transforms)].sort(),
    row: portable,
  };
}

function sanitizeJsonValue(
  value: unknown,
  sourcePaths: readonly string[],
  path: readonly string[],
): { value: unknown; transforms: string[] } {
  if (Array.isArray(value)) {
    const values: unknown[] = [];
    const transforms: string[] = [];
    value.forEach((item, index) => {
      const result = sanitizeJsonValue(item, sourcePaths, [...path, String(index)]);
      values.push(result.value);
      transforms.push(...result.transforms);
    });
    return { value: values, transforms };
  }
  if (value && typeof value === "object") {
    const record: Record<string, unknown> = {};
    const transforms: string[] = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) {
        record[key] = child == null ? child : `[credential-redacted:${sha256(canonicalJson(child)).slice(0, 16)}]`;
        if (child != null) transforms.push(`${[...path, key].join(".")}:credential-redacted`);
      } else {
        const result = sanitizeJsonValue(child, sourcePaths, [...path, key]);
        record[key] = result.value;
        transforms.push(...result.transforms);
      }
    }
    return { value: record, transforms };
  }
  if (typeof value === "string") {
    const result = sanitizeString(value, sourcePaths);
    return {
      value: result.value,
      transforms: result.changed ? [`${path.join(".")}:redacted`] : [],
    };
  }
  return { value, transforms: [] };
}

function sanitizeString(value: string, sourcePaths: readonly string[]): { value: string; changed: boolean } {
  let result = value;
  for (const source of sourcePaths) {
    if (!source) continue;
    result = replaceCaseInsensitive(result, source, `[workspace-locator:${sha256(source.toLowerCase()).slice(0, 16)}]`);
  }
  result = result.replace(WINDOWS_ABSOLUTE_PATH, (path) => `[host-path:${sha256(path.toLowerCase()).slice(0, 16)}]`);
  result = result.replace(UNC_ABSOLUTE_PATH, (path) => `[host-path:${sha256(path.toLowerCase()).slice(0, 16)}]`);
  result = result.replace(POSIX_ABSOLUTE_PATH, (_match, prefix: string, tail: string) => {
    const path = `/${tail}`;
    return `${prefix}[host-path:${sha256(path).slice(0, 16)}]`;
  });
  for (const pattern of SECRET_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (secret) => `[credential-redacted:${sha256(secret).slice(0, 16)}]`);
  }
  return { value: result, changed: result !== value };
}

function replaceCaseInsensitive(value: string, needle: string, replacement: string): string {
  if (!needle) return value;
  const lowerNeedle = needle.toLowerCase();
  let remaining = value;
  let result = "";
  while (true) {
    const index = remaining.toLowerCase().indexOf(lowerNeedle);
    if (index < 0) return result + remaining;
    result += remaining.slice(0, index) + replacement;
    remaining = remaining.slice(index + needle.length);
  }
}

function cloneSqlRow(row: SqlRow): SqlRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value instanceof Uint8Array ? Uint8Array.from(value) : value,
  ]));
}

function parseJsonObject(value: SqlValue | undefined, label: string): Record<string, unknown> {
  if (typeof value !== "string") throw new WorkspacePortabilityError("portable_record_invalid", `${label} is missing.`);
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkspacePortabilityError("portable_record_invalid", `${label} is not an object.`);
  }
  return parsed as Record<string, unknown>;
}

function parseJsonArray(value: SqlValue | undefined): unknown[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseMinimalOperationReceipt(row: Readonly<{
  receipt_id: string;
  invocation_id: string;
  operation_id: string;
  receipt_json: string;
}>): MinimalOperationReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.receipt_json) as unknown;
  } catch {
    throw new WorkspacePortabilityError("restore_operation_receipt_invalid", "A retained operation receipt is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkspacePortabilityError("restore_operation_receipt_invalid", "A retained operation receipt has an invalid shape.");
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.receipt_id !== row.receipt_id
    || value.invocation_id !== row.invocation_id
    || value.operation_id !== row.operation_id
  ) {
    throw new WorkspacePortabilityError("restore_operation_receipt_invalid", "A retained operation receipt conflicts with its ledger identity.");
  }
  const targetValue = value.target;
  const target = targetValue && typeof targetValue === "object" && !Array.isArray(targetValue)
    && typeof (targetValue as Record<string, unknown>).kind === "string"
    && typeof (targetValue as Record<string, unknown>).id === "string"
    ? {
        kind: String((targetValue as Record<string, unknown>).kind),
        id: String((targetValue as Record<string, unknown>).id),
      }
    : null;
  const changedRefs = Array.isArray(value.changed_refs)
    ? value.changed_refs.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const ref = item as Record<string, unknown>;
        return typeof ref.kind === "string" && typeof ref.id === "string"
          ? [{ kind: ref.kind, id: ref.id }]
          : [];
      })
    : [];
  const result = value.result && typeof value.result === "object" && !Array.isArray(value.result)
    ? value.result as Record<string, unknown>
    : null;
  return {
    receipt_id: row.receipt_id,
    invocation_id: row.invocation_id,
    operation_id: row.operation_id,
    target,
    changed_refs: changedRefs,
    result,
  };
}

function insertRow(db: DatabaseSync, table: string, row: SqlRow): void {
  const columns = Object.keys(row);
  const sql = `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
  db.prepare(sql).run(...columns.map((column) => row[column]));
}

function removeMaterializedContent(createdPaths: readonly string[], workspaceRoot: string): void {
  const root = resolve(workspaceRoot);
  for (const createdPath of [...createdPaths].reverse()) {
    const candidate = resolve(createdPath);
    if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
      throw new WorkspacePortabilityError(
        "restore_content_cleanup_boundary",
        "Restore rollback refused to remove content outside the target Workspace.",
      );
    }
    if (existsSync(candidate) && lstatSync(candidate).isFile()) {
      rmSync(candidate, { force: true });
    }
    let directory = dirname(candidate);
    while (directory !== root && directory.startsWith(`${root}${sep}`)) {
      try {
        rmSync(directory);
      } catch {
        break;
      }
      directory = dirname(directory);
    }
  }
}

function renameDirectoryWithWindowsRetry(source: string, destination: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!(["EPERM", "EBUSY"] as const).includes(code as "EPERM" | "EBUSY") || attempt >= 5) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}

function relation(
  childTable: string,
  childColumn: string,
  parentTable: string,
  parentColumn: string,
): PortableRelationship {
  return {
    child_table: childTable,
    child_columns: [childColumn],
    parent_table: parentTable,
    parent_columns: [parentColumn],
  };
}

function portableRelationships(db: DatabaseSync, existingTables: ReadonlySet<string>): PortableRelationship[] {
  const byIdentity = new Map<string, PortableRelationship>();
  for (const relationship of EXPLICIT_PORTABLE_RELATIONSHIPS) {
    if (!existingTables.has(relationship.child_table) || !existingTables.has(relationship.parent_table)) continue;
    byIdentity.set(canonicalJson(relationship), relationship);
  }
  for (const childTable of [...PORTABLE_WORKSPACE_TABLES].filter((table) => existingTables.has(table))) {
    const rows = db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(childTable)})`).all() as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string | null;
    }>;
    const groups = new Map<number, typeof rows>();
    for (const row of rows) {
      if (!PORTABLE_WORKSPACE_TABLES.has(row.table) || !existingTables.has(row.table)) continue;
      const group = groups.get(row.id) ?? [];
      group.push(row);
      groups.set(row.id, group);
    }
    for (const group of groups.values()) {
      group.sort((left, right) => left.seq - right.seq);
      const parentTable = group[0]!.table;
      const parentPrimaryKey = tablePrimaryKey(db, parentTable);
      const relationship: PortableRelationship = {
        child_table: childTable,
        child_columns: group.map((row) => row.from),
        parent_table: parentTable,
        parent_columns: group.map((row, index) => row.to ?? parentPrimaryKey[index] ?? ""),
      };
      if (relationship.parent_columns.some((column) => !column)) {
        throw new WorkspacePortabilityError(
          "workspace_relationship_unresolved",
          `Foreign-key metadata for '${childTable}' does not identify its parent columns.`,
        );
      }
      byIdentity.set(canonicalJson(relationship), relationship);
    }
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.child_table.localeCompare(right.child_table)
      || left.parent_table.localeCompare(right.parent_table)
      || canonicalJson(left.child_columns).localeCompare(canonicalJson(right.child_columns)));
}

function addRelatedRecords(
  db: DatabaseSync,
  records: Map<string, SqlRow[]>,
  primaryKeys: ReadonlyMap<string, readonly string[]>,
  seen: Map<string, Set<string>>,
  relationship: PortableRelationship,
  direction: "children" | "parents",
): boolean {
  const sourceTable = direction === "children" ? relationship.parent_table : relationship.child_table;
  const targetTable = direction === "children" ? relationship.child_table : relationship.parent_table;
  const sourceColumns = direction === "children" ? relationship.parent_columns : relationship.child_columns;
  const targetColumns = direction === "children" ? relationship.child_columns : relationship.parent_columns;
  const sources = records.get(sourceTable) ?? [];
  if (sources.length === 0) return false;
  const tuples = new Map<string, SqlValue[]>();
  for (const source of sources) {
    const values = sourceColumns.map((column) => source[column]);
    if (values.some((value) => value === null || value === undefined)) continue;
    tuples.set(canonicalJson(values), values as SqlValue[]);
  }
  if (tuples.size === 0) return false;

  const targetPrimaryKey = primaryKeys.get(targetTable) ?? tablePrimaryKey(db, targetTable);
  const retained = records.get(targetTable) ?? [];
  const tableSeen = seen.get(targetTable) ?? new Set(retained.map((row) => rowIdentity(row, targetPrimaryKey)));
  let changed = false;
  const values = [...tuples.values()];
  const tupleBatchSize = Math.max(1, Math.floor(800 / Math.max(1, targetColumns.length)));
  for (let offset = 0; offset < values.length; offset += tupleBatchSize) {
    const batch = values.slice(offset, offset + tupleBatchSize);
    const where = batch.map(() => `(${targetColumns.map((column) => `${quoteIdentifier(column)} IS ?`).join(" AND ")})`).join(" OR ");
    const candidates = queryRows(db, targetTable, where, batch.flat());
    for (const candidate of candidates) {
      const identity = rowIdentity(candidate, targetPrimaryKey);
      if (tableSeen.has(identity)) continue;
      tableSeen.add(identity);
      retained.push(candidate);
      changed = true;
    }
  }
  if (retained.length > 0) records.set(targetTable, retained);
  seen.set(targetTable, tableSeen);
  return changed;
}

function queryRows(db: DatabaseSync, table: string, where: string, parameters: readonly SqlValue[]): SqlRow[] {
  return db.prepare(`SELECT * FROM ${quoteIdentifier(table)} WHERE ${where}`).all(...parameters) as SqlRow[];
}

function listTables(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table));
}

type TableColumn = Readonly<{
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}>;

function tableColumns(db: DatabaseSync, table: string): TableColumn[] {
  return (db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as TableColumn[])
    .sort((left, right) => left.cid - right.cid);
}

function tablePrimaryKey(db: DatabaseSync, table: string): string[] {
  return tableColumns(db, table).filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
}

function rowIdentity(row: SqlRow, primaryKey: readonly string[]): string {
  return canonicalJson(primaryKey.map((column) => normalizeJsonSqlValue(row[column])));
}

function compareRows(left: SqlRow, right: SqlRow, primaryKey: readonly string[]): number {
  return rowIdentity(left, primaryKey).localeCompare(rowIdentity(right, primaryKey));
}

function normalizeJsonSqlValue(value: SqlValue | undefined): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return { bytes_base64: Buffer.from(value).toString("base64") };
  return value ?? null;
}

export function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Uint8Array) return canonicalJson({ bytes_base64: Buffer.from(value).toString("base64") });
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Unsafe SQLite identifier '${value}'.`);
  return `"${value}"`;
}

function requireStableId(value: string, label: string): string {
  if (!value || !value.trim() || value.length > 512) {
    throw new WorkspacePortabilityError("portable_identity_invalid", `${label} is invalid.`);
  }
  return value;
}

function resolvePackagePath(root: string, portablePath: string): string {
  if (!portablePath || portablePath.includes("\\") || portablePath.startsWith("/") || portablePath.split("/").includes("..")) {
    throw new WorkspacePortabilityError("bundle_path_invalid", "The Workspace package contains an unsafe path.");
  }
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, ...portablePath.split("/"));
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  if (target !== resolvedRoot && !target.startsWith(prefix)) {
    throw new WorkspacePortabilityError("bundle_path_invalid", "The Workspace package path escapes its package directory.");
  }
  return target;
}

function assertNoSymlinks(root: string): void {
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new WorkspacePortabilityError("bundle_symlink_refused", "Workspace packages cannot contain symbolic links.");
      }
      if (stat.isDirectory()) visit(path);
    }
  };
  visit(root);
}

function validateManifestShape(value: WorkspaceBundleManifest): void {
  if (
    value?.format !== WORKSPACE_BUNDLE_FORMAT
    || value.format_version !== WORKSPACE_BUNDLE_FORMAT_VERSION
    || value.record_version !== WORKSPACE_BUNDLE_RECORD_VERSION
    || !value.workspace_id
    || !value.bundle_id
    || !/^[a-f0-9]{64}$/.test(value.bundle_digest)
    || !Array.isArray(value.records)
    || !Array.isArray(value.content)
    || canonicalJson(value.restore_semantics) !== canonicalJson(WORKSPACE_BUNDLE_RESTORE_SEMANTICS)
    || !Array.isArray(value.unresolved_dependencies)
  ) {
    throw new WorkspacePortabilityError("bundle_manifest_unsupported", "The Workspace package format is not supported by this Floe build.");
  }
}

function removeOwnedStagingDirectory(staging: string, bundleRoot: string): void {
  const root = resolve(bundleRoot);
  const target = resolve(staging);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!target.startsWith(prefix) || !basename(target).startsWith(".staging-")) {
    throw new Error("Refusing to remove a directory outside the managed Workspace package staging root.");
  }
  rmSync(target, { recursive: true, force: true });
}
