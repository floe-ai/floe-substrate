import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ExtensionResourceRef = Readonly<{
  kind: string;
  id: string;
  revision: string | null;
}>;

export type ExtensionSource = Readonly<{
  kind: "git" | "package" | "workspace_source";
  canonical_ref: string;
  revision: string;
}>;

export type ExtensionProvenance = Readonly<{
  built_from_refs: readonly ExtensionResourceRef[];
  build_invocation_ref: ExtensionResourceRef;
  trust_evidence: readonly Readonly<{
    kind: "signature" | "attestation" | "source_control";
    evidence_ref: ExtensionResourceRef;
    subject_content_digest: string;
  }>[];
}>;

export type ExtensionCompatibility = Readonly<{
  floe_version_range: string;
  operation_contract_versions: readonly string[];
}>;

export type ExtensionIsolationLevel = "process_sandbox" | "container" | "virtual_machine";

export type ExtensionPermissions = Readonly<{
  network: readonly Readonly<{
    permission_id: string;
    origin: string;
    methods: readonly ("GET" | "POST" | "PUT" | "PATCH" | "DELETE")[];
  }>[];
  filesystem: readonly Readonly<{
    permission_id: string;
    scope: "workspace" | "extension_data" | "temporary";
    relative_pattern: string;
    access: "read" | "write" | "read_write";
  }>[];
  secrets: readonly Readonly<{
    permission_id: string;
    secret_ref_id: string;
    purpose: string;
  }>[];
  data: readonly Readonly<{
    permission_id: string;
    data_class: string;
    access: "read" | "write" | "read_write";
  }>[];
  actions: readonly Readonly<{
    permission_id: string;
    operation_id: string;
  }>[];
}>;

export type ExtensionContributionSchema = Readonly<{
  schema_id: string;
  schema_version: string;
  schema_digest: string;
  schema: Readonly<Record<string, unknown>>;
}>;

export type ExtensionContributions = Readonly<{
  capabilities: readonly Readonly<{
    capability_id: string;
    operation_ids: readonly string[];
    input_schema_ref: string | null;
    result_schema_ref: string | null;
  }>[];
  connectors: readonly Readonly<{
    connector_id: string;
    definition_schema_ref: string;
  }>[];
  schemas: readonly ExtensionContributionSchema[];
  product_surfaces: readonly Readonly<{
    surface_id: string;
    surface_version: string;
    kind: "preview" | "renderer" | "lens" | "dashboard";
    title: string;
    projection_operation_id: string;
    action_operation_ids: readonly string[];
    presentation_schema_ref: string;
  }>[];
}>;

export type ExtensionTestEvidence = Readonly<{
  evidence_id: string;
  kind: "deterministic" | "adversarial" | "manual";
  result: "passed" | "failed";
  subject_content_digest: string;
  report_ref: ExtensionResourceRef;
}>;

export type ExtensionEntryPoint = Readonly<{
  entry_point_id: string;
  kind: "capability" | "connector" | "event_source" | "command" | "migration" | "health_check";
  package_path: string;
}>;

export type ExtensionPackageDefinition = Readonly<{
  package_version: string;
  content_digest: string;
  source: ExtensionSource;
  provenance: ExtensionProvenance;
  compatibility: ExtensionCompatibility;
  required_isolation_level: ExtensionIsolationLevel;
  permissions: ExtensionPermissions;
  contributions: ExtensionContributions;
  entry_points: readonly ExtensionEntryPoint[];
  test_evidence: readonly ExtensionTestEvidence[];
}>;

export type ExtensionRecord = Readonly<{
  extension_id: string;
  workspace_id: string;
  label: string;
  status: "active" | "retired";
  current_package_version_id: string | null;
  revision_number: number;
  created_at: string;
  updated_at: string;
  retired_at: string | null;
}>;

export type ExtensionPackageVersion = Readonly<{
  extension_package_version_id: string;
  extension_id: string;
  workspace_id: string;
  package_version: string;
  content_digest: string;
  permission_digest: string;
  record_digest: string;
  definition: ExtensionPackageDefinition;
  registered_by_principal_id: string;
  registered_at: string;
}>;

/**
 * Canonical projection of declarations from the exact package currently active
 * for one Workspace installation. It is derived from retained Extension state;
 * it is not a second registration ledger.
 */
export type ActiveExtensionContributions = Readonly<{
  extension_installation_id: string;
  extension_id: string;
  extension_package_version_id: string;
  package_record_digest: string;
  content_digest: string;
  contributions: ExtensionContributions;
}>;

export type ExtensionExecutionPackagePin = Readonly<{
  execution_attempt_id: string;
  extension_installation_id: string;
  extension_package_version_id: string;
  pinned_by_invocation_id: string;
  pinned_at: string;
}>;

export type ExtensionUnresolvedBinding = Readonly<{
  kind: "permission_approval" | "isolation_host" | "compatibility" | "secret" | "capability" | "connector";
  binding_key: string;
  reason_code: string;
  message: string;
}>;

export type ExtensionRollbackTarget =
  | Readonly<{ kind: "disabled" }>
  | Readonly<{ kind: "version"; extension_package_version_id: string }>;

export type ExtensionInstallationLifecycle =
  | "unresolved"
  | "installed"
  | "enabled"
  | "disabled"
  | "quarantined"
  | "failed"
  | "rolled_back";

export type ExtensionInstallation = Readonly<{
  extension_installation_id: string;
  extension_id: string;
  workspace_id: string;
  installation_name: string;
  installation_locator: string;
  installed_package_version_id: string | null;
  pending_package_version_id: string | null;
  lifecycle: ExtensionInstallationLifecycle;
  rollback_target: ExtensionRollbackTarget;
  permission_approval_receipt_refs: readonly string[];
  isolation_host_id: string | null;
  isolation_level: ExtensionIsolationLevel | null;
  activation_receipt_ref: string | null;
  deactivation_receipt_ref: string | null;
  unresolved_bindings: readonly ExtensionUnresolvedBinding[];
  data_ref: ExtensionResourceRef | null;
  revision_number: number;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
}>;

export type ExtensionInstallationChange = Readonly<{
  extension_installation_change_id: string;
  extension_installation_id: string;
  workspace_id: string;
  reason: "install" | "enable" | "upgrade" | "disable" | "rollback" | "quarantine";
  from_package_version_id: string | null;
  to_package_version_id: string | null;
  lifecycle: ExtensionInstallationLifecycle;
  changed_by_principal_id: string;
  changed_at: string;
}>;

export type ExtensionPermissionApprovalClaim = Readonly<{
  receipt_ref: string;
  workspace_id: string;
  extension_id: string;
  permission_digest: string;
  decision: "approved" | "denied" | "revoked";
}>;

export type ExtensionIsolationHostClaim = Readonly<{
  host_id: string;
  workspace_id: string;
  supported_isolation_levels: readonly ExtensionIsolationLevel[];
  status: "available" | "unavailable";
  receipt_ref: string;
  subject_content_digest: string;
  installation_locator: string;
  result_lifecycle: "installed" | "enabled";
}>;

export type ExtensionDeactivationClaim = Readonly<{
  receipt_ref: string;
  workspace_id: string;
  extension_installation_id: string;
  extension_package_version_id: string;
  isolation_host_id: string;
  result: "disabled" | "uncertain";
}>;

export type ExtensionActivationAssessment = Readonly<{
  permission_approvals: readonly ExtensionPermissionApprovalClaim[];
  isolation_hosts: readonly ExtensionIsolationHostClaim[];
  unresolved_bindings: readonly ExtensionUnresolvedBinding[];
}>;

/**
 * Implemented by the trusted Bus integration boundary. The Extension store
 * never accepts caller assertions that permissions, bindings, or an isolation
 * host are valid.
 */
export interface ExtensionActivationAssuranceProvider {
  assess(input: Readonly<{
    invocation_id: string;
    operation_id: "extension.install" | "extension.enable" | "extension.upgrade" | "extension.rollback";
    authorized_principal_id: string;
    capability_grant_ids: readonly string[];
    approval_policy_ref: ExtensionResourceRef | null;
    extension_installation_id: string;
    workspace_id: string;
    extension: ExtensionRecord;
    package_version: ExtensionPackageVersion;
    approval_receipt_refs: readonly string[];
    installation_locator: string;
    requested_lifecycle: "installed" | "enabled";
  }>): ExtensionActivationAssessment | Promise<ExtensionActivationAssessment>;
  deactivate(input: Readonly<{
    workspace_id: string;
    installation: ExtensionInstallation;
    package_version: ExtensionPackageVersion;
  }>): ExtensionDeactivationClaim | null | Promise<ExtensionDeactivationClaim | null>;
}

/**
 * Safe host adapter for installations where no trusted isolated Extension host
 * is connected. Extension records remain inspectable, but code cannot become
 * active and an existing activation cannot be claimed stopped.
 */
export class UnavailableExtensionActivationAssuranceProvider
implements ExtensionActivationAssuranceProvider {
  assess(): ExtensionActivationAssessment {
    return {
      permission_approvals: [],
      isolation_hosts: [],
      unresolved_bindings: [],
    };
  }

  deactivate(): null {
    return null;
  }
}

export class ExtensionValidationError extends Error {
  readonly code = "E_EXTENSION_INVALID" as const;
  constructor(readonly reason: string) {
    super(`Invalid Extension: ${reason}`);
    this.name = "ExtensionValidationError";
  }
}

export class ExtensionNotFoundError extends Error {
  readonly code = "E_EXTENSION_NOT_FOUND" as const;
  constructor(readonly extension_id: string) {
    super(`Extension not found: ${extension_id}`);
    this.name = "ExtensionNotFoundError";
  }
}

export class ExtensionPackageVersionNotFoundError extends Error {
  readonly code = "E_EXTENSION_PACKAGE_VERSION_NOT_FOUND" as const;
  constructor(readonly extension_package_version_id: string) {
    super(`Extension package version not found: ${extension_package_version_id}`);
    this.name = "ExtensionPackageVersionNotFoundError";
  }
}

export class ExtensionInstallationNotFoundError extends Error {
  readonly code = "E_EXTENSION_INSTALLATION_NOT_FOUND" as const;
  constructor(readonly extension_installation_id: string) {
    super(`Extension installation not found: ${extension_installation_id}`);
    this.name = "ExtensionInstallationNotFoundError";
  }
}

export class ExtensionPackageImmutableError extends Error {
  readonly code = "E_EXTENSION_PACKAGE_IMMUTABLE" as const;
  constructor(readonly package_version: string) {
    super(`Extension package version '${package_version}' is immutable.`);
    this.name = "ExtensionPackageImmutableError";
  }
}

export class ExtensionRevisionConflictError extends Error {
  readonly code = "E_EXTENSION_REVISION_CONFLICT" as const;
  constructor(readonly expected: string, readonly actual: string) {
    super(`Extension resource changed: expected revision '${expected}', found '${actual}'.`);
    this.name = "ExtensionRevisionConflictError";
  }
}

export class ExtensionExecutionPackageConflictError extends Error {
  readonly code = "E_EXTENSION_EXECUTION_PACKAGE_CONFLICT" as const;
  constructor(
    readonly execution_attempt_id: string,
    readonly extension_installation_id: string,
  ) {
    super(`Execution attempt '${execution_attempt_id}' already pins another exact package for Extension installation '${extension_installation_id}'.`);
    this.name = "ExtensionExecutionPackageConflictError";
  }
}

export function extensionPermissionDigest(permissions: ExtensionPermissions): string {
  validatePermissions(permissions);
  return sha256(canonicalJson(permissions));
}

export function extensionPackageRecordDigest(definition: ExtensionPackageDefinition): string {
  validatePackageDefinition(definition);
  return sha256(canonicalJson(definition));
}

export function extensionInstallationRevision(installation: ExtensionInstallation): string {
  return String(installation.revision_number);
}

export function extensionIdentityRevision(extension: ExtensionRecord): string {
  return String(extension.revision_number);
}

export function applyExtensionSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS canonical_extensions (
      extension_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
      current_package_version_id TEXT,
      revision_number INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      retired_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_canonical_extensions_workspace
      ON canonical_extensions(workspace_id, status, created_at);

    CREATE TABLE IF NOT EXISTS extension_package_versions (
      extension_package_version_id TEXT PRIMARY KEY,
      extension_id TEXT NOT NULL REFERENCES canonical_extensions(extension_id),
      workspace_id TEXT NOT NULL,
      package_version TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      permission_digest TEXT NOT NULL,
      record_digest TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      registered_by_principal_id TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      UNIQUE(extension_id, package_version),
      UNIQUE(extension_id, content_digest)
    );

    CREATE INDEX IF NOT EXISTS idx_extension_package_versions_extension
      ON extension_package_versions(extension_id, registered_at, extension_package_version_id);

    CREATE TABLE IF NOT EXISTS extension_installations (
      extension_installation_id TEXT PRIMARY KEY,
      extension_id TEXT NOT NULL REFERENCES canonical_extensions(extension_id),
      workspace_id TEXT NOT NULL,
      installation_name TEXT NOT NULL,
      installation_locator TEXT NOT NULL,
      installed_package_version_id TEXT REFERENCES extension_package_versions(extension_package_version_id),
      pending_package_version_id TEXT REFERENCES extension_package_versions(extension_package_version_id),
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('unresolved', 'installed', 'enabled', 'disabled', 'quarantined', 'failed', 'rolled_back')),
      rollback_target_json TEXT NOT NULL,
      permission_approval_receipt_refs_json TEXT NOT NULL,
      isolation_host_id TEXT,
      isolation_level TEXT,
      activation_receipt_ref TEXT,
      deactivation_receipt_ref TEXT,
      unresolved_bindings_json TEXT NOT NULL,
      data_ref_json TEXT,
      revision_number INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      disabled_at TEXT,
      UNIQUE(workspace_id, installation_name),
      UNIQUE(workspace_id, extension_id)
    );

    CREATE INDEX IF NOT EXISTS idx_extension_installations_workspace
      ON extension_installations(workspace_id, lifecycle, created_at);

    CREATE TABLE IF NOT EXISTS extension_installation_changes (
      extension_installation_change_id TEXT PRIMARY KEY,
      extension_installation_id TEXT NOT NULL REFERENCES extension_installations(extension_installation_id),
      workspace_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('install', 'enable', 'upgrade', 'disable', 'rollback', 'quarantine')),
      from_package_version_id TEXT,
      to_package_version_id TEXT,
      lifecycle TEXT NOT NULL,
      changed_by_principal_id TEXT NOT NULL,
      changed_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_extension_installation_changes_installation
      ON extension_installation_changes(extension_installation_id, changed_at, extension_installation_change_id);

    CREATE TABLE IF NOT EXISTS extension_execution_package_pins (
      execution_attempt_id TEXT NOT NULL REFERENCES execution_attempts(attempt_id),
      extension_installation_id TEXT NOT NULL REFERENCES extension_installations(extension_installation_id),
      extension_package_version_id TEXT NOT NULL REFERENCES extension_package_versions(extension_package_version_id),
      pinned_by_invocation_id TEXT NOT NULL,
      pinned_at TEXT NOT NULL,
      PRIMARY KEY (execution_attempt_id, extension_installation_id)
    );

    CREATE INDEX IF NOT EXISTS idx_extension_execution_package_pins_package
      ON extension_execution_package_pins(extension_package_version_id, execution_attempt_id);
  `);
  migrateExtensionInstallationChangeReasons(db);
}

export class ExtensionStore {
  constructor(
    readonly db: DatabaseSync,
    private readonly assurance: ExtensionActivationAssuranceProvider,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly activationRequiresRevalidation: (
      workspaceId: string,
      extensionInstallationId: string,
    ) => boolean = () => false,
  ) {
    applyExtensionSchema(db);
  }

  createExtension(input: Readonly<{
    workspace_id: string;
    extension_id?: string;
    label: string;
  }>): ExtensionRecord {
    nonEmpty("workspace_id", input.workspace_id);
    nonEmpty("label", input.label);
    const extensionId = input.extension_id ?? `extension_${randomUUID()}`;
    nonEmpty("extension_id", extensionId);
    const at = this.now();
    this.db.prepare(`
      INSERT INTO canonical_extensions (
        extension_id, workspace_id, label, status, current_package_version_id,
        revision_number, created_at, updated_at, retired_at
      ) VALUES (?, ?, ?, 'active', NULL, 0, ?, ?, NULL)
    `).run(extensionId, input.workspace_id, input.label, at, at);
    return this.requireExtension(extensionId);
  }

  registerPackage(input: Readonly<{
    workspace_id: string;
    extension_id?: string;
    label: string;
    definition: ExtensionPackageDefinition;
    registered_by_principal_id: string;
    expected_extension_revision?: string | null;
  }>): { extension: ExtensionRecord; package_version: ExtensionPackageVersion } {
    nonEmpty("workspace_id", input.workspace_id);
    nonEmpty("label", input.label);
    nonEmpty("registered_by_principal_id", input.registered_by_principal_id);
    validatePackageDefinition(input.definition);
    const extensionId = input.extension_id ?? `extension_${randomUUID()}`;
    nonEmpty("extension_id", extensionId);
    const recordDigest = extensionPackageRecordDigest(input.definition);
    const permissionDigest = extensionPermissionDigest(input.definition.permissions);
    const packageVersionId = `extpkg_${sha256(`${extensionId}:${input.definition.content_digest}`).slice(0, 32)}`;
    const at = this.now();

    transaction(this.db, () => {
      let extension = this.getExtension(extensionId);
      if (!extension) {
        if (input.expected_extension_revision != null) {
          throw new ExtensionRevisionConflictError(input.expected_extension_revision, "none");
        }
        this.db.prepare(`
          INSERT INTO canonical_extensions (
            extension_id, workspace_id, label, status, current_package_version_id,
            revision_number, created_at, updated_at, retired_at
          ) VALUES (?, ?, ?, 'active', NULL, 0, ?, ?, NULL)
        `).run(extensionId, input.workspace_id, input.label, at, at);
        extension = this.requireExtension(extensionId);
      } else {
        if (extension.workspace_id !== input.workspace_id) throw new ExtensionNotFoundError(extensionId);
        if (extension.status !== "active") throw new ExtensionValidationError("a retired Extension cannot receive a package version");
        if (input.expected_extension_revision == null) {
          throw new ExtensionValidationError("expected_extension_revision is required for an existing Extension");
        }
        const actual = extensionIdentityRevision(extension);
        if (actual !== input.expected_extension_revision) {
          throw new ExtensionRevisionConflictError(input.expected_extension_revision, actual);
        }
      }

      const byVersion = this.getPackageBySemanticVersion(extensionId, input.definition.package_version);
      if (byVersion) {
        if (byVersion.record_digest !== recordDigest || byVersion.content_digest !== input.definition.content_digest) {
          throw new ExtensionPackageImmutableError(input.definition.package_version);
        }
        return;
      }

      this.db.prepare(`
        INSERT INTO extension_package_versions (
          extension_package_version_id, extension_id, workspace_id, package_version,
          content_digest, permission_digest, record_digest, definition_json,
          registered_by_principal_id, registered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        packageVersionId,
        extensionId,
        input.workspace_id,
        input.definition.package_version,
        input.definition.content_digest,
        permissionDigest,
        recordDigest,
        JSON.stringify(input.definition),
        input.registered_by_principal_id,
        at,
      );
      this.db.prepare(`
        UPDATE canonical_extensions
        SET label = ?, current_package_version_id = ?, revision_number = revision_number + 1, updated_at = ?
        WHERE extension_id = ?
      `).run(input.label, packageVersionId, at, extensionId);
    });

    const packageVersion = this.getPackageBySemanticVersion(extensionId, input.definition.package_version);
    if (!packageVersion) throw new ExtensionPackageVersionNotFoundError(packageVersionId);
    return { extension: this.requireExtension(extensionId), package_version: packageVersion };
  }

  async install(input: Readonly<{
    invocation_id: string;
    workspace_id: string;
    extension_package_version_id: string;
    installation_name: string;
    activate: boolean;
    approval_receipt_refs: readonly string[];
    data_ref?: ExtensionResourceRef | null;
    changed_by_principal_id: string;
    capability_grant_ids: readonly string[];
    approval_policy_ref: ExtensionResourceRef | null;
  }>): Promise<ExtensionInstallation> {
    const packageVersion = this.requirePackageInWorkspace(input.extension_package_version_id, input.workspace_id);
    const extension = this.requireExtensionInWorkspace(packageVersion.extension_id, input.workspace_id);
    if (extension.status !== "active") throw new ExtensionValidationError("a retired Extension cannot be installed");
    validateInstallationName(input.installation_name);
    nonEmpty("changed_by_principal_id", input.changed_by_principal_id);
    if (input.data_ref) validateResourceRef(input.data_ref, "Extension data reference");
    const existing = this.getInstallationForExtension(extension.extension_id);
    if (existing) throw new ExtensionValidationError("this Extension already has a Workspace installation; use upgrade");
    const locator = installationLocator(input.installation_name);
    const installationId = `extinst_${sha256(`${input.workspace_id}:${extension.extension_id}`).slice(0, 32)}`;
    const requestedLifecycle = input.activate ? "enabled" as const : "installed" as const;
    const activation = await this.evaluateActivation(
      input.invocation_id,
      "extension.install",
      input.changed_by_principal_id,
      input.capability_grant_ids,
      input.approval_policy_ref,
      installationId,
      extension,
      packageVersion,
      input.approval_receipt_refs,
      locator,
      requestedLifecycle,
    );
    const at = this.now();
    const resolved = activation.unresolved_bindings.length === 0;
    const lifecycle: ExtensionInstallationLifecycle = resolved
      ? (input.activate ? "enabled" : "installed")
      : "unresolved";
    const installedVersionId = resolved ? packageVersion.extension_package_version_id : null;
    const pendingVersionId = resolved ? null : packageVersion.extension_package_version_id;
    transaction(this.db, () => {
      this.db.prepare(`
        INSERT INTO extension_installations (
          extension_installation_id, extension_id, workspace_id, installation_name,
        installation_locator, installed_package_version_id, pending_package_version_id,
        lifecycle, rollback_target_json, permission_approval_receipt_refs_json,
          isolation_host_id, isolation_level, activation_receipt_ref, deactivation_receipt_ref,
          unresolved_bindings_json, data_ref_json,
          revision_number, created_at, updated_at, disabled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, ?, NULL)
      `).run(
        installationId,
        extension.extension_id,
        input.workspace_id,
        input.installation_name,
        locator,
        installedVersionId,
        pendingVersionId,
        lifecycle,
        JSON.stringify({ kind: "disabled" }),
        JSON.stringify(activation.approval_receipt_refs),
        activation.isolation_host?.host_id ?? null,
        activation.isolation_host ? packageVersion.definition.required_isolation_level : null,
        activation.isolation_host?.receipt_ref ?? null,
        JSON.stringify(activation.unresolved_bindings),
        input.data_ref ? JSON.stringify(input.data_ref) : null,
        at,
        at,
      );
      this.insertInstallationChange({
        installation_id: installationId,
        workspace_id: input.workspace_id,
        reason: "install",
        from_package_version_id: null,
        to_package_version_id: packageVersion.extension_package_version_id,
        lifecycle,
        principal_id: input.changed_by_principal_id,
        at,
      });
    });
    return this.requireInstallation(installationId);
  }

  async upgrade(input: Readonly<{
    invocation_id: string;
    extension_installation_id: string;
    workspace_id: string;
    to_extension_package_version_id: string;
    expected_revision: string;
    activate: boolean;
    approval_receipt_refs: readonly string[];
    changed_by_principal_id: string;
    capability_grant_ids: readonly string[];
    approval_policy_ref: ExtensionResourceRef | null;
  }>): Promise<ExtensionInstallation> {
    const installation = this.requireInstallationInWorkspace(input.extension_installation_id, input.workspace_id);
    this.assertInstallationRevision(installation, input.expected_revision);
    const packageVersion = this.requirePackageInWorkspace(input.to_extension_package_version_id, input.workspace_id);
    if (packageVersion.extension_id !== installation.extension_id) {
      throw new ExtensionValidationError("an installation can only upgrade to a package version of the same Extension");
    }
    if (packageVersion.extension_package_version_id === installation.installed_package_version_id) return installation;
    const extension = this.requireExtensionInWorkspace(installation.extension_id, input.workspace_id);
    const requestedLifecycle = input.activate ? "enabled" as const : "installed" as const;
    const activation = await this.evaluateActivation(
      input.invocation_id,
      "extension.upgrade",
      input.changed_by_principal_id,
      input.capability_grant_ids,
      input.approval_policy_ref,
      installation.extension_installation_id,
      extension,
      packageVersion,
      input.approval_receipt_refs,
      installation.installation_locator,
      requestedLifecycle,
    );
    const resolved = activation.unresolved_bindings.length === 0;
    const lifecycle: ExtensionInstallationLifecycle = resolved
      ? (input.activate ? "enabled" : "installed")
      : installation.installed_package_version_id
        ? installation.lifecycle
        : "unresolved";
    const at = this.now();
    const rollbackTarget: ExtensionRollbackTarget = installation.installed_package_version_id
      ? { kind: "version", extension_package_version_id: installation.installed_package_version_id }
      : { kind: "disabled" };
    transaction(this.db, () => {
      this.db.prepare(`
        UPDATE extension_installations SET
          installed_package_version_id = ?, pending_package_version_id = ?, lifecycle = ?,
          rollback_target_json = ?, permission_approval_receipt_refs_json = ?,
          isolation_host_id = ?, isolation_level = ?, activation_receipt_ref = ?,
          deactivation_receipt_ref = NULL, unresolved_bindings_json = ?,
          revision_number = revision_number + 1, updated_at = ?, disabled_at = NULL
        WHERE extension_installation_id = ?
      `).run(
        resolved ? packageVersion.extension_package_version_id : installation.installed_package_version_id,
        resolved ? null : packageVersion.extension_package_version_id,
        lifecycle,
        JSON.stringify(rollbackTarget),
        JSON.stringify(resolved ? activation.approval_receipt_refs : installation.permission_approval_receipt_refs),
        resolved ? activation.isolation_host?.host_id ?? null : installation.isolation_host_id,
        resolved ? packageVersion.definition.required_isolation_level : installation.isolation_level,
        resolved ? activation.isolation_host?.receipt_ref ?? null : installation.activation_receipt_ref,
        JSON.stringify(activation.unresolved_bindings),
        at,
        installation.extension_installation_id,
      );
      this.insertInstallationChange({
        installation_id: installation.extension_installation_id,
        workspace_id: input.workspace_id,
        reason: "upgrade",
        from_package_version_id: installation.installed_package_version_id,
        to_package_version_id: packageVersion.extension_package_version_id,
        lifecycle,
        principal_id: input.changed_by_principal_id,
        at,
      });
    });
    return this.requireInstallation(installation.extension_installation_id);
  }

  async enable(input: Readonly<{
    invocation_id: string;
    extension_installation_id: string;
    workspace_id: string;
    expected_revision: string;
    approval_receipt_refs: readonly string[];
    changed_by_principal_id: string;
    capability_grant_ids: readonly string[];
    approval_policy_ref: ExtensionResourceRef | null;
  }>): Promise<ExtensionInstallation> {
    const installation = this.requireInstallationInWorkspace(input.extension_installation_id, input.workspace_id);
    this.assertInstallationRevision(installation, input.expected_revision);
    if (
      installation.lifecycle === "enabled"
      && !this.activationRequiresRevalidation(input.workspace_id, input.extension_installation_id)
    ) return installation;
    if (!installation.installed_package_version_id) {
      throw new ExtensionValidationError("an Extension installation needs an exact installed package before it can be enabled");
    }
    const packageVersion = this.requirePackageInWorkspace(
      installation.installed_package_version_id,
      input.workspace_id,
    );
    const extension = this.requireExtensionInWorkspace(installation.extension_id, input.workspace_id);
    const activation = await this.evaluateActivation(
      input.invocation_id,
      "extension.enable",
      input.changed_by_principal_id,
      input.capability_grant_ids,
      input.approval_policy_ref,
      installation.extension_installation_id,
      extension,
      packageVersion,
      input.approval_receipt_refs,
      installation.installation_locator,
      "enabled",
    );
    const resolved = activation.unresolved_bindings.length === 0;
    const lifecycle: ExtensionInstallationLifecycle = resolved ? "enabled" : "unresolved";
    const at = this.now();
    transaction(this.db, () => {
      this.db.prepare(`
        UPDATE extension_installations SET
          lifecycle = ?, pending_package_version_id = NULL,
          permission_approval_receipt_refs_json = ?, isolation_host_id = ?,
          isolation_level = ?, activation_receipt_ref = ?, deactivation_receipt_ref = NULL,
          unresolved_bindings_json = ?, revision_number = revision_number + 1,
          updated_at = ?, disabled_at = NULL
        WHERE extension_installation_id = ?
      `).run(
        lifecycle,
        JSON.stringify(resolved ? activation.approval_receipt_refs : installation.permission_approval_receipt_refs),
        resolved ? activation.isolation_host?.host_id ?? null : null,
        resolved ? packageVersion.definition.required_isolation_level : null,
        resolved ? activation.isolation_host?.receipt_ref ?? null : null,
        JSON.stringify(activation.unresolved_bindings),
        at,
        installation.extension_installation_id,
      );
      this.insertInstallationChange({
        installation_id: installation.extension_installation_id,
        workspace_id: input.workspace_id,
        reason: "enable",
        from_package_version_id: packageVersion.extension_package_version_id,
        to_package_version_id: packageVersion.extension_package_version_id,
        lifecycle,
        principal_id: input.changed_by_principal_id,
        at,
      });
    });
    return this.requireInstallation(installation.extension_installation_id);
  }

  async disable(input: Readonly<{
    extension_installation_id: string;
    workspace_id: string;
    expected_revision: string;
    changed_by_principal_id: string;
  }>): Promise<ExtensionInstallation> {
    const installation = this.requireInstallationInWorkspace(input.extension_installation_id, input.workspace_id);
    this.assertInstallationRevision(installation, input.expected_revision);
    if (installation.lifecycle === "disabled") return installation;
    let deactivationReceiptRef: string | null = null;
    let lifecycle: ExtensionInstallationLifecycle = "disabled";
    let unresolved: readonly ExtensionUnresolvedBinding[] = [];
    if (
      installation.installed_package_version_id
      && (installation.lifecycle === "enabled" || installation.lifecycle === "rolled_back")
      && installation.isolation_host_id
    ) {
      const packageVersion = this.requirePackageInWorkspace(
        installation.installed_package_version_id,
        input.workspace_id,
      );
      const claim = await this.assurance.deactivate({
        workspace_id: input.workspace_id,
        installation,
        package_version: packageVersion,
      });
      const confirmed = claim
        && claim.result === "disabled"
        && claim.workspace_id === input.workspace_id
        && claim.extension_installation_id === installation.extension_installation_id
        && claim.extension_package_version_id === packageVersion.extension_package_version_id
        && claim.isolation_host_id === installation.isolation_host_id;
      if (confirmed) {
        deactivationReceiptRef = claim.receipt_ref;
      } else {
        lifecycle = "quarantined";
        unresolved = [{
          kind: "isolation_host",
          binding_key: installation.isolation_host_id,
          reason_code: "extension_deactivation_unconfirmed",
          message: "Floe prevented new use but could not prove the isolated host stopped the active Extension.",
        }];
      }
    }
    const at = this.now();
    transaction(this.db, () => {
      this.db.prepare(`
        UPDATE extension_installations SET
          lifecycle = ?, pending_package_version_id = NULL,
          deactivation_receipt_ref = ?, unresolved_bindings_json = ?,
          revision_number = revision_number + 1,
          updated_at = ?, disabled_at = ?
        WHERE extension_installation_id = ?
      `).run(lifecycle, deactivationReceiptRef, JSON.stringify(unresolved), at, lifecycle === "disabled" ? at : null, installation.extension_installation_id);
      this.insertInstallationChange({
        installation_id: installation.extension_installation_id,
        workspace_id: input.workspace_id,
        reason: "disable",
        from_package_version_id: installation.installed_package_version_id,
        to_package_version_id: installation.installed_package_version_id,
        lifecycle,
        principal_id: input.changed_by_principal_id,
        at,
      });
    });
    return this.requireInstallation(installation.extension_installation_id);
  }

  /**
   * Trusted host callback. A crashed process is removed from active use while
   * retaining the exact package, data, and lifecycle evidence for inspection.
   */
  quarantineAfterHostCrash(input: Readonly<{
    workspace_id: string;
    extension_installation_id: string;
    extension_package_version_id: string;
    isolation_host_id: string;
    failure_code: string;
    failure_message: string;
  }>): ExtensionInstallation {
    const installation = this.requireInstallationInWorkspace(input.extension_installation_id, input.workspace_id);
    if (installation.lifecycle === "quarantined") return installation;
    if (
      installation.installed_package_version_id !== input.extension_package_version_id
      || installation.isolation_host_id !== input.isolation_host_id
      || (installation.lifecycle !== "enabled" && installation.lifecycle !== "rolled_back")
    ) {
      throw new ExtensionValidationError("host crash evidence does not match the active Extension package");
    }
    const at = this.now();
    const unresolved: ExtensionUnresolvedBinding[] = [{
      kind: "isolation_host",
      binding_key: input.isolation_host_id,
      reason_code: input.failure_code,
      message: input.failure_message,
    }];
    transaction(this.db, () => {
      this.db.prepare(`
        UPDATE extension_installations SET
          lifecycle = 'quarantined', pending_package_version_id = NULL,
          unresolved_bindings_json = ?, deactivation_receipt_ref = NULL,
          revision_number = revision_number + 1, updated_at = ?, disabled_at = NULL
        WHERE extension_installation_id = ?
      `).run(JSON.stringify(unresolved), at, installation.extension_installation_id);
      this.insertInstallationChange({
        installation_id: installation.extension_installation_id,
        workspace_id: input.workspace_id,
        reason: "quarantine",
        from_package_version_id: input.extension_package_version_id,
        to_package_version_id: input.extension_package_version_id,
        lifecycle: "quarantined",
        principal_id: input.isolation_host_id,
        at,
      });
    });
    return this.requireInstallation(installation.extension_installation_id);
  }

  async rollback(input: Readonly<{
    invocation_id: string;
    extension_installation_id: string;
    workspace_id: string;
    expected_revision: string;
    approval_receipt_refs: readonly string[];
    changed_by_principal_id: string;
    capability_grant_ids: readonly string[];
    approval_policy_ref: ExtensionResourceRef | null;
  }>): Promise<ExtensionInstallation> {
    const installation = this.requireInstallationInWorkspace(input.extension_installation_id, input.workspace_id);
    this.assertInstallationRevision(installation, input.expected_revision);
    const at = this.now();
    if (installation.rollback_target.kind === "disabled") {
      let lifecycle: ExtensionInstallationLifecycle = "rolled_back";
      let deactivationReceiptRef: string | null = null;
      let unresolved: readonly ExtensionUnresolvedBinding[] = [];
      if (
        installation.installed_package_version_id
        && (installation.lifecycle === "enabled" || installation.lifecycle === "rolled_back")
        && installation.isolation_host_id
      ) {
        const packageVersion = this.requirePackageInWorkspace(
          installation.installed_package_version_id,
          input.workspace_id,
        );
        const claim = await this.assurance.deactivate({
          workspace_id: input.workspace_id,
          installation,
          package_version: packageVersion,
        });
        const confirmed = claim
          && claim.result === "disabled"
          && claim.workspace_id === input.workspace_id
          && claim.extension_installation_id === installation.extension_installation_id
          && claim.extension_package_version_id === packageVersion.extension_package_version_id
          && claim.isolation_host_id === installation.isolation_host_id;
        if (confirmed) {
          deactivationReceiptRef = claim.receipt_ref;
        } else {
          lifecycle = "quarantined";
          unresolved = [{
            kind: "isolation_host",
            binding_key: installation.isolation_host_id,
            reason_code: "extension_deactivation_unconfirmed",
            message: "Floe prevented new use but could not prove the isolated host stopped the active Extension.",
          }];
        }
      }
      transaction(this.db, () => {
        this.db.prepare(`
          UPDATE extension_installations SET lifecycle = ?, pending_package_version_id = NULL,
            deactivation_receipt_ref = ?, unresolved_bindings_json = ?,
            revision_number = revision_number + 1,
            updated_at = ?, disabled_at = ?
          WHERE extension_installation_id = ?
        `).run(
          lifecycle,
          deactivationReceiptRef,
          JSON.stringify(unresolved),
          at,
          lifecycle === "rolled_back" ? at : null,
          installation.extension_installation_id,
        );
        this.insertInstallationChange({
          installation_id: installation.extension_installation_id,
          workspace_id: input.workspace_id,
          reason: "rollback",
          from_package_version_id: installation.installed_package_version_id,
          to_package_version_id: null,
          lifecycle,
          principal_id: input.changed_by_principal_id,
          at,
        });
      });
      return this.requireInstallation(installation.extension_installation_id);
    }

    const target = this.requirePackageInWorkspace(
      installation.rollback_target.extension_package_version_id,
      input.workspace_id,
    );
    const extension = this.requireExtensionInWorkspace(installation.extension_id, input.workspace_id);
    const activation = await this.evaluateActivation(
      input.invocation_id,
      "extension.rollback",
      input.changed_by_principal_id,
      input.capability_grant_ids,
      input.approval_policy_ref,
      installation.extension_installation_id,
      extension,
      target,
      input.approval_receipt_refs,
      installation.installation_locator,
      "enabled",
    );
    const resolved = activation.unresolved_bindings.length === 0;
    const previousCurrent = installation.installed_package_version_id;
    const lifecycle: ExtensionInstallationLifecycle = resolved ? "rolled_back" : installation.lifecycle;
    transaction(this.db, () => {
      this.db.prepare(`
        UPDATE extension_installations SET
          installed_package_version_id = ?, pending_package_version_id = ?, lifecycle = ?,
          rollback_target_json = ?, permission_approval_receipt_refs_json = ?,
          isolation_host_id = ?, isolation_level = ?, activation_receipt_ref = ?,
          deactivation_receipt_ref = NULL, unresolved_bindings_json = ?,
          revision_number = revision_number + 1, updated_at = ?, disabled_at = NULL
        WHERE extension_installation_id = ?
      `).run(
        resolved ? target.extension_package_version_id : installation.installed_package_version_id,
        resolved ? null : target.extension_package_version_id,
        lifecycle,
        JSON.stringify(previousCurrent
          ? { kind: "version", extension_package_version_id: previousCurrent }
          : { kind: "disabled" }),
        JSON.stringify(resolved ? activation.approval_receipt_refs : installation.permission_approval_receipt_refs),
        resolved ? activation.isolation_host?.host_id ?? null : installation.isolation_host_id,
        resolved ? target.definition.required_isolation_level : installation.isolation_level,
        resolved ? activation.isolation_host?.receipt_ref ?? null : installation.activation_receipt_ref,
        JSON.stringify(activation.unresolved_bindings),
        at,
        installation.extension_installation_id,
      );
      this.insertInstallationChange({
        installation_id: installation.extension_installation_id,
        workspace_id: input.workspace_id,
        reason: "rollback",
        from_package_version_id: previousCurrent,
        to_package_version_id: target.extension_package_version_id,
        lifecycle,
        principal_id: input.changed_by_principal_id,
        at,
      });
    });
    return this.requireInstallation(installation.extension_installation_id);
  }

  listExtensions(workspaceId: string, options: Readonly<{ include_retired?: boolean }> = {}): ExtensionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM canonical_extensions WHERE workspace_id = ?
      ${options.include_retired ? "" : "AND status = 'active'"}
      ORDER BY created_at, extension_id
    `).all(workspaceId) as unknown as ExtensionRow[];
    return rows.map(mapExtension);
  }

  getExtension(extensionId: string): ExtensionRecord | null {
    const row = this.db.prepare(`SELECT * FROM canonical_extensions WHERE extension_id = ?`)
      .get(extensionId) as unknown as ExtensionRow | undefined;
    return row ? mapExtension(row) : null;
  }

  requireExtension(extensionId: string): ExtensionRecord {
    const extension = this.getExtension(extensionId);
    if (!extension) throw new ExtensionNotFoundError(extensionId);
    return extension;
  }

  requireExtensionInWorkspace(extensionId: string, workspaceId: string): ExtensionRecord {
    const extension = this.getExtension(extensionId);
    if (!extension || extension.workspace_id !== workspaceId) throw new ExtensionNotFoundError(extensionId);
    return extension;
  }

  listPackageVersions(extensionId: string): ExtensionPackageVersion[] {
    return (this.db.prepare(`
      SELECT * FROM extension_package_versions WHERE extension_id = ?
      ORDER BY registered_at, extension_package_version_id
    `).all(extensionId) as unknown as ExtensionPackageRow[]).map(mapPackage);
  }

  getPackageVersion(packageVersionId: string): ExtensionPackageVersion | null {
    const row = this.db.prepare(`SELECT * FROM extension_package_versions WHERE extension_package_version_id = ?`)
      .get(packageVersionId) as unknown as ExtensionPackageRow | undefined;
    return row ? mapPackage(row) : null;
  }

  requirePackageVersion(packageVersionId: string): ExtensionPackageVersion {
    const version = this.getPackageVersion(packageVersionId);
    if (!version) throw new ExtensionPackageVersionNotFoundError(packageVersionId);
    return version;
  }

  requirePackageInWorkspace(packageVersionId: string, workspaceId: string): ExtensionPackageVersion {
    const version = this.getPackageVersion(packageVersionId);
    if (!version || version.workspace_id !== workspaceId) throw new ExtensionPackageVersionNotFoundError(packageVersionId);
    return version;
  }

  getPackageBySemanticVersion(extensionId: string, packageVersion: string): ExtensionPackageVersion | null {
    const row = this.db.prepare(`
      SELECT * FROM extension_package_versions WHERE extension_id = ? AND package_version = ?
    `).get(extensionId, packageVersion) as unknown as ExtensionPackageRow | undefined;
    return row ? mapPackage(row) : null;
  }

  listContributionSchemas(extensionId: string): ExtensionContributionSchema[] {
    return this.listPackageVersions(extensionId).flatMap((version) => version.definition.contributions.schemas);
  }

  listActiveContributions(workspaceId: string): ActiveExtensionContributions[] {
    return this.listInstallations(workspaceId).flatMap((installation) => {
      const active = installation.lifecycle === "enabled"
        || (installation.lifecycle === "rolled_back" && installation.deactivation_receipt_ref === null);
      if (!active || !installation.installed_package_version_id || !installation.isolation_host_id) return [];
      const packageVersion = this.requirePackageInWorkspace(
        installation.installed_package_version_id,
        workspaceId,
      );
      return [{
        extension_installation_id: installation.extension_installation_id,
        extension_id: installation.extension_id,
        extension_package_version_id: packageVersion.extension_package_version_id,
        package_record_digest: packageVersion.record_digest,
        content_digest: packageVersion.content_digest,
        contributions: packageVersion.definition.contributions,
      }];
    });
  }

  pinPackageForExecution(input: Readonly<{
    workspace_id: string;
    execution_attempt_id: string;
    extension_installation_id: string;
    extension_package_version_id: string;
    invocation_id: string;
  }>): ExtensionExecutionPackagePin {
    const installation = this.requireInstallationInWorkspace(input.extension_installation_id, input.workspace_id);
    const packageVersion = this.requirePackageInWorkspace(input.extension_package_version_id, input.workspace_id);
    if (installation.extension_id !== packageVersion.extension_id) {
      throw new ExtensionValidationError("an execution can only pin a package belonging to its Extension installation");
    }
    const existing = this.getExecutionPackagePin(input.execution_attempt_id, input.extension_installation_id);
    if (existing) {
      if (existing.extension_package_version_id !== input.extension_package_version_id) {
        throw new ExtensionExecutionPackageConflictError(
          input.execution_attempt_id,
          input.extension_installation_id,
        );
      }
      return existing;
    }
    const at = this.now();
    this.db.prepare(`
      INSERT INTO extension_execution_package_pins (
        execution_attempt_id, extension_installation_id, extension_package_version_id,
        pinned_by_invocation_id, pinned_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      input.execution_attempt_id,
      input.extension_installation_id,
      input.extension_package_version_id,
      input.invocation_id,
      at,
    );
    return this.getExecutionPackagePin(input.execution_attempt_id, input.extension_installation_id)!;
  }

  getExecutionPackagePin(
    executionAttemptId: string,
    extensionInstallationId: string,
  ): ExtensionExecutionPackagePin | null {
    const row = this.db.prepare(`
      SELECT execution_attempt_id, extension_installation_id, extension_package_version_id,
             pinned_by_invocation_id, pinned_at
      FROM extension_execution_package_pins
      WHERE execution_attempt_id = ? AND extension_installation_id = ?
    `).get(executionAttemptId, extensionInstallationId) as ExtensionExecutionPackagePin | undefined;
    return row ?? null;
  }

  getInstallation(installationId: string): ExtensionInstallation | null {
    const row = this.db.prepare(`SELECT * FROM extension_installations WHERE extension_installation_id = ?`)
      .get(installationId) as unknown as ExtensionInstallationRow | undefined;
    return row ? mapInstallation(row) : null;
  }

  getInstallationForExtension(extensionId: string): ExtensionInstallation | null {
    const row = this.db.prepare(`SELECT * FROM extension_installations WHERE extension_id = ?`)
      .get(extensionId) as unknown as ExtensionInstallationRow | undefined;
    return row ? mapInstallation(row) : null;
  }

  requireInstallation(installationId: string): ExtensionInstallation {
    const installation = this.getInstallation(installationId);
    if (!installation) throw new ExtensionInstallationNotFoundError(installationId);
    return installation;
  }

  requireInstallationInWorkspace(installationId: string, workspaceId: string): ExtensionInstallation {
    const installation = this.getInstallation(installationId);
    if (!installation || installation.workspace_id !== workspaceId) {
      throw new ExtensionInstallationNotFoundError(installationId);
    }
    return installation;
  }

  listInstallations(workspaceId: string): ExtensionInstallation[] {
    return (this.db.prepare(`
      SELECT * FROM extension_installations WHERE workspace_id = ? ORDER BY created_at, extension_installation_id
    `).all(workspaceId) as unknown as ExtensionInstallationRow[]).map(mapInstallation);
  }

  listInstallationChanges(installationId: string): ExtensionInstallationChange[] {
    return (this.db.prepare(`
      SELECT * FROM extension_installation_changes WHERE extension_installation_id = ?
      ORDER BY changed_at, extension_installation_change_id
    `).all(installationId) as unknown as ExtensionInstallationChangeRow[]).map(mapInstallationChange);
  }

  private async evaluateActivation(
    invocationId: string,
    operationId: "extension.install" | "extension.enable" | "extension.upgrade" | "extension.rollback",
    authorizedPrincipalId: string,
    capabilityGrantIds: readonly string[],
    approvalPolicyRef: ExtensionResourceRef | null,
    extensionInstallationId: string,
    extension: ExtensionRecord,
    packageVersion: ExtensionPackageVersion,
    approvalReceiptRefs: readonly string[],
    installationLocatorValue: string,
    requestedLifecycle: "installed" | "enabled",
  ): Promise<Readonly<{
    approval_receipt_refs: readonly string[];
    isolation_host: ExtensionIsolationHostClaim | null;
    unresolved_bindings: readonly ExtensionUnresolvedBinding[];
  }>> {
    const unresolved: ExtensionUnresolvedBinding[] = [];
    if (!hasPassingEvidence(packageVersion, "deterministic") || !hasPassingEvidence(packageVersion, "adversarial")) {
      unresolved.push({
        kind: "compatibility",
        binding_key: packageVersion.content_digest,
        reason_code: "extension_test_evidence_required",
        message: "The exact package needs passing deterministic and adversarial test evidence before activation.",
      });
    }
    const assessment = await this.assurance.assess({
      invocation_id: invocationId,
      operation_id: operationId,
      authorized_principal_id: authorizedPrincipalId,
      capability_grant_ids: capabilityGrantIds,
      approval_policy_ref: approvalPolicyRef,
      extension_installation_id: extensionInstallationId,
      workspace_id: extension.workspace_id,
      extension,
      package_version: packageVersion,
      approval_receipt_refs: [...new Set(approvalReceiptRefs)].sort(),
      installation_locator: installationLocatorValue,
      requested_lifecycle: requestedLifecycle,
    });
    const approvals = assessment.permission_approvals.filter((claim) =>
      claim.decision === "approved"
      && claim.workspace_id === extension.workspace_id
      && claim.extension_id === extension.extension_id
      && claim.permission_digest === packageVersion.permission_digest
      && approvalReceiptRefs.includes(claim.receipt_ref));
    if (approvals.length === 0) {
      unresolved.push({
        kind: "permission_approval",
        binding_key: packageVersion.permission_digest,
        reason_code: "extension_permission_approval_required",
        message: "The exact declared permission set needs an approval receipt for this Workspace.",
      });
    }
    const isolationHost = assessment.isolation_hosts.find((claim) =>
      claim.status === "available"
      && claim.workspace_id === extension.workspace_id
      && claim.supported_isolation_levels.includes(packageVersion.definition.required_isolation_level)
      && claim.subject_content_digest === packageVersion.content_digest
      && claim.installation_locator === installationLocatorValue
      && claim.result_lifecycle === requestedLifecycle
      && Boolean(claim.receipt_ref.trim())) ?? null;
    if (!isolationHost) {
      unresolved.push({
        kind: "isolation_host",
        binding_key: packageVersion.definition.required_isolation_level,
        reason_code: "extension_isolation_host_required",
        message: "A compatible isolated Extension host is required before this package can become active.",
      });
    }
    unresolved.push(...assessment.unresolved_bindings);
    return {
      approval_receipt_refs: approvals.map((claim) => claim.receipt_ref).sort(),
      isolation_host: isolationHost,
      unresolved_bindings: dedupeUnresolved(unresolved),
    };
  }

  private assertInstallationRevision(installation: ExtensionInstallation, expected: string): void {
    const actual = extensionInstallationRevision(installation);
    if (actual !== expected) throw new ExtensionRevisionConflictError(expected, actual);
  }

  private insertInstallationChange(input: Readonly<{
    installation_id: string;
    workspace_id: string;
    reason: ExtensionInstallationChange["reason"];
    from_package_version_id: string | null;
    to_package_version_id: string | null;
    lifecycle: ExtensionInstallationLifecycle;
    principal_id: string;
    at: string;
  }>): void {
    this.db.prepare(`
      INSERT INTO extension_installation_changes (
        extension_installation_change_id, extension_installation_id, workspace_id,
        reason, from_package_version_id, to_package_version_id, lifecycle,
        changed_by_principal_id, changed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `extchange_${randomUUID()}`,
      input.installation_id,
      input.workspace_id,
      input.reason,
      input.from_package_version_id,
      input.to_package_version_id,
      input.lifecycle,
      input.principal_id,
      input.at,
    );
  }
}

function validatePackageDefinition(definition: ExtensionPackageDefinition): void {
  nonEmpty("package_version", definition.package_version);
  validateDigest(definition.content_digest, "content_digest");
  validateSource(definition.source);
  validateResourceRef(definition.provenance.build_invocation_ref, "build invocation reference");
  for (const ref of definition.provenance.built_from_refs) validateResourceRef(ref, "build provenance reference");
  for (const evidence of definition.provenance.trust_evidence) {
    validateResourceRef(evidence.evidence_ref, "trust evidence reference");
    validateDigest(evidence.subject_content_digest, "trust evidence subject digest");
    if (evidence.subject_content_digest !== definition.content_digest) {
      throw new ExtensionValidationError("trust evidence must identify the exact package content digest");
    }
  }
  nonEmpty("floe_version_range", definition.compatibility.floe_version_range);
  unique(definition.compatibility.operation_contract_versions, "operation contract version");
  validatePermissions(definition.permissions);
  validateContributions(definition.contributions);
  unique(definition.entry_points.map((entry) => entry.entry_point_id), "entry point id");
  for (const entry of definition.entry_points) {
    nonEmpty("entry_point_id", entry.entry_point_id);
    validateRelativePackagePath(entry.package_path, "entry point package_path");
  }
  unique(definition.test_evidence.map((evidence) => evidence.evidence_id), "test evidence id");
  for (const evidence of definition.test_evidence) {
    validateDigest(evidence.subject_content_digest, "test evidence subject digest");
    if (evidence.subject_content_digest !== definition.content_digest) {
      throw new ExtensionValidationError("test evidence must identify the exact package content digest");
    }
    validateResourceRef(evidence.report_ref, "test evidence report reference");
  }
}

function validateSource(source: ExtensionSource): void {
  assertExactKeys(source, ["kind", "canonical_ref", "revision"], "Extension source");
  nonEmpty("source canonical_ref", source.canonical_ref);
  nonEmpty("source revision", source.revision);
  const normalized = source.canonical_ref.replaceAll("\\", "/").toLowerCase();
  if (normalized.includes(".floe/extensions/")) {
    throw new ExtensionValidationError("canonical source must not be the Workspace installation projection");
  }
}

function validatePermissions(permissions: ExtensionPermissions): void {
  assertExactKeys(permissions, ["network", "filesystem", "secrets", "data", "actions"], "Extension permissions");
  const allIds = [
    ...permissions.network.map((item) => item.permission_id),
    ...permissions.filesystem.map((item) => item.permission_id),
    ...permissions.secrets.map((item) => item.permission_id),
    ...permissions.data.map((item) => item.permission_id),
    ...permissions.actions.map((item) => item.permission_id),
  ];
  unique(allIds, "permission id");
  for (const item of permissions.network) {
    assertExactKeys(item, ["permission_id", "origin", "methods"], "network permission");
    nonEmpty("network permission id", item.permission_id);
    let url: URL;
    try { url = new URL(item.origin); } catch { throw new ExtensionValidationError("network origin must be an exact URL origin"); }
    if (!(["https:", "http:"].includes(url.protocol)) || url.username || url.password || url.origin !== item.origin) {
      throw new ExtensionValidationError("network origin must be an exact HTTP(S) origin without credentials or a path");
    }
    unique(item.methods, "network method");
  }
  for (const item of permissions.filesystem) {
    assertExactKeys(item, ["permission_id", "scope", "relative_pattern", "access"], "filesystem permission");
    nonEmpty("filesystem permission id", item.permission_id);
    validateRelativePattern(item.relative_pattern);
  }
  for (const item of permissions.secrets) {
    assertExactKeys(item, ["permission_id", "secret_ref_id", "purpose"], "secret permission");
    nonEmpty("secret permission id", item.permission_id);
    nonEmpty("SecretRef id", item.secret_ref_id);
    nonEmpty("secret purpose", item.purpose);
  }
  for (const item of permissions.data) {
    assertExactKeys(item, ["permission_id", "data_class", "access"], "data permission");
    nonEmpty("data permission id", item.permission_id);
    nonEmpty("data class", item.data_class);
  }
  for (const item of permissions.actions) {
    assertExactKeys(item, ["permission_id", "operation_id"], "action permission");
    nonEmpty("action permission id", item.permission_id);
    nonEmpty("semantic operation id", item.operation_id);
  }
}

function validateContributions(contributions: ExtensionContributions): void {
  unique(contributions.capabilities.map((item) => item.capability_id), "contributed capability id");
  for (const capability of contributions.capabilities) {
    nonEmpty("capability id", capability.capability_id);
    unique(capability.operation_ids, "capability operation id");
  }
  unique(contributions.connectors.map((item) => item.connector_id), "contributed connector id");
  for (const connector of contributions.connectors) {
    nonEmpty("connector id", connector.connector_id);
    nonEmpty("connector definition schema reference", connector.definition_schema_ref);
  }
  unique(contributions.schemas.map((item) => `${item.schema_id}@${item.schema_version}`), "contributed schema version");
  for (const schema of contributions.schemas) {
    nonEmpty("schema id", schema.schema_id);
    nonEmpty("schema version", schema.schema_version);
    validateDigest(schema.schema_digest, "schema digest");
    const actual = sha256(canonicalJson(schema.schema));
    if (actual !== schema.schema_digest) throw new ExtensionValidationError(`schema '${schema.schema_id}' digest does not match its content`);
  }
  unique(contributions.product_surfaces.map((item) => `${item.surface_id}@${item.surface_version}`), "product surface version");
  for (const surface of contributions.product_surfaces) {
    nonEmpty("product surface id", surface.surface_id);
    nonEmpty("product surface version", surface.surface_version);
    nonEmpty("product surface title", surface.title);
    nonEmpty("product surface projection operation id", surface.projection_operation_id);
    nonEmpty("product surface presentation schema reference", surface.presentation_schema_ref);
    unique(surface.action_operation_ids, "product surface action operation id");
    if (/(component|module|javascript|script):/i.test(surface.presentation_schema_ref)) {
      throw new ExtensionValidationError("product surfaces must bind declaratively to canonical APIs, not executable UI code");
    }
  }
}

function hasPassingEvidence(packageVersion: ExtensionPackageVersion, kind: ExtensionTestEvidence["kind"]): boolean {
  return packageVersion.definition.test_evidence.some((evidence) => evidence.kind === kind && evidence.result === "passed");
}

function validateInstallationName(value: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) {
    throw new ExtensionValidationError("installation_name must be a lowercase slug");
  }
}

function installationLocator(name: string): string {
  return `.floe/extensions/${name}/`;
}

function validateRelativePattern(value: string): void {
  nonEmpty("filesystem relative_pattern", value);
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-z]:\//i.test(normalized) || normalized.split("/").includes("..")) {
    throw new ExtensionValidationError("filesystem permissions must use a relative pattern within their declared scope");
  }
}

function validateRelativePackagePath(value: string, label: string): void {
  nonEmpty(label, value);
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-z]:\//i.test(normalized) || normalized.split("/").includes("..")) {
    throw new ExtensionValidationError(`${label} must remain inside the exact package`);
  }
}

function validateResourceRef(ref: ExtensionResourceRef, label: string): void {
  nonEmpty(`${label} kind`, ref.kind);
  nonEmpty(`${label} id`, ref.id);
}

function validateDigest(value: string, label: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new ExtensionValidationError(`${label} must be a lowercase sha256 content digest`);
  }
}

function unique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    nonEmpty(label, value);
    if (seen.has(value)) throw new ExtensionValidationError(`${label} '${value}' is duplicated`);
    seen.add(value);
  }
}

function nonEmpty(label: string, value: string): void {
  if (!value?.trim()) throw new ExtensionValidationError(`${label} must not be empty`);
}

function assertExactKeys(value: object, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ExtensionValidationError(`${label} contains unsupported field '${unknown.sort()[0]}'`);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function dedupeUnresolved(bindings: readonly ExtensionUnresolvedBinding[]): ExtensionUnresolvedBinding[] {
  const byKey = new Map<string, ExtensionUnresolvedBinding>();
  for (const binding of bindings) {
    byKey.set(`${binding.kind}:${binding.binding_key}:${binding.reason_code}`, binding);
  }
  return [...byKey.values()].sort((left, right) =>
    `${left.kind}:${left.binding_key}`.localeCompare(`${right.kind}:${right.binding_key}`));
}

function migrateExtensionInstallationChangeReasons(db: DatabaseSync): void {
  const row = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'extension_installation_changes'
  `).get() as { sql: string | null } | undefined;
  if (!row?.sql || (row.sql.includes("'enable'") && row.sql.includes("'quarantine'"))) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DROP INDEX IF EXISTS idx_extension_installation_changes_installation;
      ALTER TABLE extension_installation_changes RENAME TO extension_installation_changes_legacy;
      CREATE TABLE extension_installation_changes (
        extension_installation_change_id TEXT PRIMARY KEY,
        extension_installation_id TEXT NOT NULL REFERENCES extension_installations(extension_installation_id),
        workspace_id TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('install', 'enable', 'upgrade', 'disable', 'rollback', 'quarantine')),
        from_package_version_id TEXT,
        to_package_version_id TEXT,
        lifecycle TEXT NOT NULL,
        changed_by_principal_id TEXT NOT NULL,
        changed_at TEXT NOT NULL
      );
      INSERT INTO extension_installation_changes SELECT * FROM extension_installation_changes_legacy;
      DROP TABLE extension_installation_changes_legacy;
      CREATE INDEX idx_extension_installation_changes_installation
        ON extension_installation_changes(extension_installation_id, changed_at, extension_installation_change_id);
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function transaction(db: DatabaseSync, work: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    work();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

type ExtensionRow = {
  extension_id: string;
  workspace_id: string;
  label: string;
  status: ExtensionRecord["status"];
  current_package_version_id: string | null;
  revision_number: number;
  created_at: string;
  updated_at: string;
  retired_at: string | null;
};

type ExtensionPackageRow = {
  extension_package_version_id: string;
  extension_id: string;
  workspace_id: string;
  package_version: string;
  content_digest: string;
  permission_digest: string;
  record_digest: string;
  definition_json: string;
  registered_by_principal_id: string;
  registered_at: string;
};

type ExtensionInstallationRow = {
  extension_installation_id: string;
  extension_id: string;
  workspace_id: string;
  installation_name: string;
  installation_locator: string;
  installed_package_version_id: string | null;
  pending_package_version_id: string | null;
  lifecycle: ExtensionInstallationLifecycle;
  rollback_target_json: string;
  permission_approval_receipt_refs_json: string;
  isolation_host_id: string | null;
  isolation_level: ExtensionIsolationLevel | null;
  activation_receipt_ref: string | null;
  deactivation_receipt_ref: string | null;
  unresolved_bindings_json: string;
  data_ref_json: string | null;
  revision_number: number;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
};

type ExtensionInstallationChangeRow = {
  extension_installation_change_id: string;
  extension_installation_id: string;
  workspace_id: string;
  reason: ExtensionInstallationChange["reason"];
  from_package_version_id: string | null;
  to_package_version_id: string | null;
  lifecycle: ExtensionInstallationLifecycle;
  changed_by_principal_id: string;
  changed_at: string;
};

function mapExtension(row: ExtensionRow): ExtensionRecord {
  return { ...row };
}

function mapPackage(row: ExtensionPackageRow): ExtensionPackageVersion {
  return {
    extension_package_version_id: row.extension_package_version_id,
    extension_id: row.extension_id,
    workspace_id: row.workspace_id,
    package_version: row.package_version,
    content_digest: row.content_digest,
    permission_digest: row.permission_digest,
    record_digest: row.record_digest,
    definition: JSON.parse(row.definition_json) as ExtensionPackageDefinition,
    registered_by_principal_id: row.registered_by_principal_id,
    registered_at: row.registered_at,
  };
}

function mapInstallation(row: ExtensionInstallationRow): ExtensionInstallation {
  return {
    extension_installation_id: row.extension_installation_id,
    extension_id: row.extension_id,
    workspace_id: row.workspace_id,
    installation_name: row.installation_name,
    installation_locator: row.installation_locator,
    installed_package_version_id: row.installed_package_version_id,
    pending_package_version_id: row.pending_package_version_id,
    lifecycle: row.lifecycle,
    rollback_target: JSON.parse(row.rollback_target_json) as ExtensionRollbackTarget,
    permission_approval_receipt_refs: JSON.parse(row.permission_approval_receipt_refs_json) as string[],
    isolation_host_id: row.isolation_host_id,
    isolation_level: row.isolation_level,
    activation_receipt_ref: row.activation_receipt_ref,
    deactivation_receipt_ref: row.deactivation_receipt_ref,
    unresolved_bindings: JSON.parse(row.unresolved_bindings_json) as ExtensionUnresolvedBinding[],
    data_ref: row.data_ref_json ? JSON.parse(row.data_ref_json) as ExtensionResourceRef : null,
    revision_number: row.revision_number,
    created_at: row.created_at,
    updated_at: row.updated_at,
    disabled_at: row.disabled_at,
  };
}

function mapInstallationChange(row: ExtensionInstallationChangeRow): ExtensionInstallationChange {
  return { ...row };
}
