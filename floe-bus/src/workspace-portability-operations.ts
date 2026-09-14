import {
  refusal,
  requiredAction,
  requireWorkspaceAuthorityId,
  type JsonSchema,
  type OperationExecutionContext,
  type OperationRefusal,
  type SemanticOperationDefinition,
  type SemanticOperationRegistry,
} from "./operations.js";
import {
  SUPPLY_WORKSPACE_CONTENT_OPERATION_ID,
  WorkspacePortabilityError,
  WorkspacePortabilityService,
  type WorkspaceBundleDependency,
  type WorkspaceDependencyReconciliationResult,
  type WorkspaceBundleManifest,
  type WorkspaceRestoreHold,
} from "./workspace-portability.js";

export const EXPORT_WORKSPACE_BUNDLE_OPERATION_ID = "workspace.package.export";
export const LOCATE_WORKSPACE_BUNDLE_OPERATION_ID = "workspace.package.locate";
export const PREFLIGHT_WORKSPACE_RESTORE_OPERATION_ID = "workspace.package.preflight_restore";
export const RESTORE_WORKSPACE_BUNDLE_OPERATION_ID = "workspace.package.restore";
export const INSPECT_WORKSPACE_RESTORE_OPERATION_ID = "workspace.package.inspect_restore";
export const RECONCILE_WORKSPACE_RESTORE_OPERATION_ID = "workspace.package.reconcile_restore";
export const RELEASE_WORKSPACE_RESTORE_HOLD_OPERATION_ID = "workspace.package.release_restore_hold";

type BundleSummary = Readonly<{
  bundle_id: string;
  bundle_digest: string;
  workspace_id: string;
  format_version: number;
  source_database_schema_version: number;
  record_count: number;
  included_content_count: number;
  portable_external_content_count: number;
  unresolved_dependencies: readonly WorkspaceBundleDependency[];
}>;

const text: JsonSchema = { type: "string", minLength: 1 };
const nullableText: JsonSchema = { oneOf: [text, { type: "null" }] };
const empty: JsonSchema = { type: "object", additionalProperties: false };
const dependencySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["dependency_id", "kind", "resource_id", "reason"],
  properties: {
    dependency_id: text,
    kind: { enum: ["content", "secret_ref", "endpoint_attachment", "actor_runtime", "command_runtime", "connector_runtime", "extension_runtime"] },
    resource_id: text,
    reason: text,
  },
};
const bundleSummarySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "bundle_id", "bundle_digest", "workspace_id", "format_version",
    "source_database_schema_version", "record_count", "included_content_count",
    "portable_external_content_count", "unresolved_dependencies",
  ],
  properties: {
    bundle_id: text,
    bundle_digest: text,
    workspace_id: text,
    format_version: { type: "integer", minimum: 1 },
    source_database_schema_version: { type: "integer", minimum: 1 },
    record_count: { type: "integer", minimum: 0 },
    included_content_count: { type: "integer", minimum: 0 },
    portable_external_content_count: { type: "integer", minimum: 0 },
    unresolved_dependencies: { type: "array", items: dependencySchema },
  },
};
const restoreHoldSchema: JsonSchema = {
  oneOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "workspace_id", "bundle_id", "bundle_digest", "state", "reason",
        "restored_at", "released_at", "released_by_principal_id",
      ],
      properties: {
        workspace_id: text,
        bundle_id: text,
        bundle_digest: text,
        state: { enum: ["held", "released"] },
        reason: text,
        restored_at: text,
        released_at: nullableText,
        released_by_principal_id: nullableText,
      },
    },
  ],
};
const restoreInspectionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["hold", "unresolved_dependencies"],
  properties: {
    hold: restoreHoldSchema,
    unresolved_dependencies: { type: "array", items: dependencySchema },
  },
};

function selectedWorkspace(context: OperationExecutionContext): string {
  const workspaceId = requireWorkspaceAuthorityId(context.authority);
  const target = context.target?.ref;
  if (!target || target.kind !== "workspace" || target.id !== workspaceId) {
    throw new WorkspacePortabilityError(
      "workspace_target_invalid",
      "Select the same Workspace carried by the authenticated authority boundary.",
    );
  }
  return workspaceId;
}

function summary(manifest: WorkspaceBundleManifest): BundleSummary {
  return {
    bundle_id: manifest.bundle_id,
    bundle_digest: manifest.bundle_digest,
    workspace_id: manifest.workspace_id,
    format_version: manifest.format_version,
    source_database_schema_version: manifest.source_database_schema_version,
    record_count: manifest.records.reduce((total, item) => total + item.record_count, 0),
    included_content_count: manifest.content.filter((item) => item.mode === "included").length,
    portable_external_content_count: manifest.content.filter((item) => item.mode === "portable_external").length,
    unresolved_dependencies: manifest.unresolved_dependencies,
  };
}

function portabilityRefusal(error: unknown): OperationRefusal {
  if (error instanceof WorkspacePortabilityError) {
    const actions: Record<string, ReturnType<typeof requiredAction>> = {
      workspace_not_found: requiredAction("select_workspace", "Choose a Workspace", "Choose a retained Workspace before exporting it."),
      bundle_not_found: requiredAction("choose_bundle", "Choose a Workspace package", "Choose an intact Floe Workspace package directory."),
      bundle_schema_too_new: requiredAction("upgrade_floe", "Upgrade Floe", "Use a Floe build that supports this package format and canonical schema."),
      source_schema_incompatible: requiredAction("upgrade_workspace", "Finish the Workspace upgrade", "Open the Workspace with this Floe version and complete its verified schema upgrade first."),
      target_schema_incompatible: requiredAction("upgrade_floe", "Upgrade Floe", "Complete the target host's verified database upgrade before restoring a Workspace."),
      restore_identity_collision: requiredAction("choose_restore_mode", "Resolve the identity collision", "Restore into a clean host, or explicitly choose copy or fork when this is independent work."),
      restore_dependencies_unresolved: requiredAction("resolve_bindings", "Reconnect local dependencies", "Reconnect credentials, runtimes, Connectors, Extensions, and Endpoint attachments before releasing restored work."),
      restore_dependency_evidence_incomplete: requiredAction("wait_for_reconciliation", "Finish restore checks", "Wait for the exact dependency reconciliation receipt to complete before releasing restored work."),
      restore_hold_changed: requiredAction("refresh_restore", "Refresh restore status", "Inspect the current restore hold before deciding whether to release it."),
    };
    return refusal(
      error.code,
      error.message,
      ["bundle_not_found", "restore_hold_changed"].includes(error.code),
      actions[error.code] ?? requiredAction("inspect_workspace_package", "Inspect the Workspace package", "Validate the package and target host before retrying."),
      error.details,
    );
  }
  return refusal(
    "workspace_package_failed",
    "Floe could not prove that the Workspace package operation completed.",
    false,
    requiredAction("inspect_workspace_package", "Inspect the Workspace package", "Validate the package and target host before retrying."),
  );
}

function exportDefinition(service: WorkspacePortabilityService): SemanticOperationDefinition<Record<string, never>, { bundle: BundleSummary }> {
  return {
    operation_id: EXPORT_WORKSPACE_BUNDLE_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "workspaces",
    title: "Export portable Workspace",
    description: "Create a verified portable directory package containing canonical Workspace history and exact reachable content, with credentials excluded.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "reference" },
    required_grants: ["workspace.export"],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["workspace"], expected_revision: "not_applicable" },
    input: { version: "1", schema: empty },
    result: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["bundle"],
        properties: { bundle: bundleSummarySchema },
      },
    },
    handler: async (context) => {
      try {
        const exported = service.exportWorkspace(selectedWorkspace(context));
        return {
          state: "completed",
          result: { bundle: summary(exported.manifest) },
          changed_refs: [{ kind: "workspace_bundle", id: exported.bundle_id, revision: exported.bundle_digest }],
        };
      } catch (error) {
        return { state: "refused", refusal: portabilityRefusal(error) };
      }
    },
  };
}

function locateDefinition(service: WorkspacePortabilityService): SemanticOperationDefinition<{ bundle_id: string }, { bundle_id: string; bundle_directory: string }> {
  return {
    operation_id: LOCATE_WORKSPACE_BUNDLE_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["host"],
    category: "workspaces",
    title: "Locate managed Workspace package",
    description: "Resolve one managed package identity to a path for an authenticated local host adapter. The path is never projected to a Workspace or remote session.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [LOCATE_WORKSPACE_BUNDLE_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive"] },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    input: {
      version: "1",
      schema: {
        type: "object", additionalProperties: false, required: ["bundle_id"],
        properties: { bundle_id: text },
      },
    },
    result: {
      version: "1",
      schema: {
        type: "object", additionalProperties: false, required: ["bundle_id", "bundle_directory"],
        properties: { bundle_id: text, bundle_directory: text },
      },
    },
    handler: async (_context, input) => {
      try {
        return {
          state: "completed",
          result: { bundle_id: input.bundle_id, bundle_directory: service.locateManagedBundle(input.bundle_id) },
        };
      } catch (error) {
        return { state: "refused", refusal: portabilityRefusal(error) };
      }
    },
  };
}

function preflightDefinition(service: WorkspacePortabilityService): SemanticOperationDefinition<{ bundle_directory: string }, { bundle: BundleSummary }> {
  return {
    operation_id: PREFLIGHT_WORKSPACE_RESTORE_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["host"],
    category: "workspaces",
    title: "Validate Workspace package",
    description: "Verify package identity, schema compatibility, record digests, content digests, and unresolved target-host dependencies before restore.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [PREFLIGHT_WORKSPACE_RESTORE_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive"] },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    input: {
      version: "1",
      schema: {
        type: "object", additionalProperties: false, required: ["bundle_directory"],
        properties: { bundle_directory: text },
      },
    },
    result: {
      version: "1",
      schema: {
        type: "object", additionalProperties: false, required: ["bundle"],
        properties: { bundle: bundleSummarySchema },
      },
    },
    handler: async (_context, input) => {
      try {
        return { state: "completed", result: { bundle: summary(service.preflightRestore(input.bundle_directory).manifest) } };
      } catch (error) {
        return { state: "refused", refusal: portabilityRefusal(error) };
      }
    },
  };
}

function restoreDefinition(service: WorkspacePortabilityService): SemanticOperationDefinition<{
  bundle_directory: string;
  workspace_locator: string;
}, {
  workspace_id: string;
  bundle_id: string;
  bundle_digest: string;
  state: "held";
  inserted_record_count: number;
  retained_record_count: number;
  unresolved_dependencies: readonly WorkspaceBundleDependency[];
  backup_created: boolean;
}> {
  return {
    operation_id: RESTORE_WORKSPACE_BUNDLE_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["host"],
    category: "workspaces",
    title: "Restore portable Workspace",
    description: "Restore a verified package under its retained Workspace identity, materialize exact content, and hold all work until local dependencies are rebound.",
    effects: { mode: "write", reversibility: "irreversible", external: true, secret_access: "reference" },
    required_grants: [RESTORE_WORKSPACE_BUNDLE_OPERATION_ID],
    interaction_constraints: {
      allowed_modes: ["interactive"],
      confirmation: {
        required: true,
        prompt_id: "restore_verified_workspace_package",
        title: "Restore this Workspace?",
        description: "Floe will retain its identity and history, copy verified content, and hold all work until target-host dependencies are reconnected.",
      },
    },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    input: {
      version: "1",
      schema: {
        type: "object", additionalProperties: false,
        required: ["bundle_directory", "workspace_locator"],
        properties: { bundle_directory: text, workspace_locator: text },
      },
    },
    result: {
      version: "1",
      schema: {
        type: "object", additionalProperties: false,
        required: [
          "workspace_id", "bundle_id", "bundle_digest", "state",
          "inserted_record_count", "retained_record_count",
          "unresolved_dependencies", "backup_created",
        ],
        properties: {
          workspace_id: text,
          bundle_id: text,
          bundle_digest: text,
          state: { const: "held" },
          inserted_record_count: { type: "integer", minimum: 0 },
          retained_record_count: { type: "integer", minimum: 0 },
          unresolved_dependencies: { type: "array", items: dependencySchema },
          backup_created: { type: "boolean" },
        },
      },
    },
    handler: async (_context, input) => {
      try {
        const restored = service.restoreWorkspace(input);
        return {
          state: "completed",
          result: {
            workspace_id: restored.workspace_id,
            bundle_id: restored.bundle_id,
            bundle_digest: restored.bundle_digest,
            state: restored.state,
            inserted_record_count: restored.inserted_record_count,
            retained_record_count: restored.retained_record_count,
            unresolved_dependencies: restored.unresolved_dependencies,
            backup_created: restored.backup_path !== null,
          },
          changed_refs: [
            { kind: "workspace", id: restored.workspace_id, revision: null },
            { kind: "workspace_restore_hold", id: restored.workspace_id, revision: restored.bundle_digest },
          ],
        };
      } catch (error) {
        return { state: "refused", refusal: portabilityRefusal(error) };
      }
    },
  };
}

function inspectRestoreDefinition(service: WorkspacePortabilityService): SemanticOperationDefinition<Record<string, never>, {
  hold: WorkspaceRestoreHold | null;
  unresolved_dependencies: readonly WorkspaceBundleDependency[];
}> {
  return {
    operation_id: INSPECT_WORKSPACE_RESTORE_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "workspaces",
    title: "Inspect restored Workspace",
    description: "Inspect the operational restore hold and every unresolved target-host dependency without exposing credentials or host paths.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "reference" },
    required_grants: ["workspace.inspect"],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["workspace"], expected_revision: "not_applicable" },
    input: { version: "1", schema: empty },
    result: { version: "1", schema: restoreInspectionSchema },
    handler: async (context) => {
      try {
        const workspaceId = selectedWorkspace(context);
        return {
          state: "completed",
          result: {
            hold: service.getRestoreHold(workspaceId),
            unresolved_dependencies: service.listUnresolvedDependencies(workspaceId),
          },
        };
      } catch (error) {
        return { state: "refused", refusal: portabilityRefusal(error) };
      }
    },
  };
}

function supplyContentDefinition(service: WorkspacePortabilityService): SemanticOperationDefinition<{
  workspace_id: string;
  expected_bundle_digest: string;
  dependency_id: string;
  source_path: string;
}, {
  workspace_id: string;
  bundle_digest: string;
  dependency_id: string;
  artefact_version_id: string;
  digest: string;
  size_bytes: number;
}> {
  return {
    operation_id: SUPPLY_WORKSPACE_CONTENT_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["host"],
    category: "workspaces",
    title: "Supply missing Workspace content",
    description: "Copy one operator-selected file only after it matches the exact missing ArtefactVersion digest. The host path is not retained.",
    effects: { mode: "write", reversibility: "reversible", external: true, secret_access: "none" },
    required_grants: [SUPPLY_WORKSPACE_CONTENT_OPERATION_ID],
    interaction_constraints: {
      allowed_modes: ["interactive"],
      confirmation: {
        required: true,
        prompt_id: "workspace.restore.supply-content",
        title: "Use this file as the missing content?",
        description: "Floe will verify its exact digest before copying it into the restored Workspace.",
      },
    },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    input: {
      version: "1",
      schema: {
        type: "object", additionalProperties: false,
        required: ["workspace_id", "expected_bundle_digest", "dependency_id", "source_path"],
        properties: {
          workspace_id: text,
          expected_bundle_digest: text,
          dependency_id: text,
          source_path: text,
        },
      },
    },
    result: {
      version: "1",
      schema: {
        type: "object", additionalProperties: false,
        required: ["workspace_id", "bundle_digest", "dependency_id", "artefact_version_id", "digest", "size_bytes"],
        properties: {
          workspace_id: text,
          bundle_digest: text,
          dependency_id: text,
          artefact_version_id: text,
          digest: text,
          size_bytes: { type: "integer", minimum: 0 },
        },
      },
    },
    handler: async (_context, input) => {
      try {
        return { state: "completed", result: service.supplyContentDependency(input) };
      } catch (error) {
        return { state: "refused", refusal: portabilityRefusal(error) };
      }
    },
  };
}

function reconcileRestoreDefinition(service: WorkspacePortabilityService): SemanticOperationDefinition<{
  expected_bundle_digest: string;
}, WorkspaceDependencyReconciliationResult> {
  return {
    operation_id: RECONCILE_WORKSPACE_RESTORE_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "workspaces",
    title: "Revalidate restored Workspace",
    description: "Resolve only dependencies proven by new exact credential, runtime, Endpoint, Connector, Extension, or content evidence on this host.",
    effects: {
      mode: "write",
      reversibility: "none",
      external: false,
      secret_access: "reference",
      allowed_during_restore_hold: true,
    },
    required_grants: [RECONCILE_WORKSPACE_RESTORE_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["workspace"], expected_revision: "not_applicable" },
    input: {
      version: "1",
      schema: {
        type: "object", additionalProperties: false, required: ["expected_bundle_digest"],
        properties: { expected_bundle_digest: text },
      },
    },
    result: {
      version: "1",
      schema: {
        type: "object", additionalProperties: false,
        required: ["resolved_dependencies", "unresolved_dependencies"],
        properties: {
          resolved_dependencies: { type: "array", items: dependencySchema },
          unresolved_dependencies: { type: "array", items: dependencySchema },
        },
      },
    },
    handler: async (context, input) => {
      try {
        const workspaceId = selectedWorkspace(context);
        return {
          state: "completed",
          result: service.reconcileRestoreDependencies({
            workspace_id: workspaceId,
            expected_bundle_digest: input.expected_bundle_digest,
            reconciliation_operation_receipt_id: service.requireOperationReceiptId(context.invocation_id),
          }),
        };
      } catch (error) {
        return { state: "refused", refusal: portabilityRefusal(error) };
      }
    },
  };
}

function releaseHoldDefinition(service: WorkspacePortabilityService): SemanticOperationDefinition<{
  expected_bundle_digest: string;
}, { hold: WorkspaceRestoreHold }> {
  return {
    operation_id: RELEASE_WORKSPACE_RESTORE_HOLD_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "workspaces",
    title: "Release restored Workspace",
    description: "Release the operational restore hold only after every exact local dependency has been resolved through its owning operation.",
    effects: {
      mode: "write",
      reversibility: "irreversible",
      external: true,
      secret_access: "reference",
      allowed_during_restore_hold: true,
    },
    required_grants: [RELEASE_WORKSPACE_RESTORE_HOLD_OPERATION_ID],
    interaction_constraints: {
      allowed_modes: ["interactive"],
      confirmation: {
        required: true,
        prompt_id: "release_restored_workspace",
        title: "Allow restored work to resume?",
        description: "Queued work, schedules, Connectors, and Extensions may continue after this hold is released.",
      },
    },
    target: { resource_kinds: ["workspace"], expected_revision: "not_applicable" },
    input: {
      version: "1",
      schema: {
        type: "object", additionalProperties: false, required: ["expected_bundle_digest"],
        properties: { expected_bundle_digest: text },
      },
    },
    result: {
      version: "1",
      schema: {
        type: "object", additionalProperties: false, required: ["hold"],
        properties: { hold: restoreHoldSchema },
      },
    },
    handler: async (context, input) => {
      try {
        const workspaceId = selectedWorkspace(context);
        const hold = service.releaseRestoreHold({
          workspace_id: workspaceId,
          expected_bundle_digest: input.expected_bundle_digest,
          principal_id: context.authority.principal_id,
        });
        return {
          state: "completed",
          result: { hold },
          changed_refs: [{ kind: "workspace_restore_hold", id: workspaceId, revision: hold.bundle_digest }],
        };
      } catch (error) {
        return { state: "refused", refusal: portabilityRefusal(error) };
      }
    },
  };
}

export function workspacePortabilityOperationDefinitions(
  service: WorkspacePortabilityService,
): readonly SemanticOperationDefinition<any, any>[] {
  return [
    exportDefinition(service),
    locateDefinition(service),
    preflightDefinition(service),
    restoreDefinition(service),
    inspectRestoreDefinition(service),
    supplyContentDefinition(service),
    reconcileRestoreDefinition(service),
    releaseHoldDefinition(service),
  ];
}

export function registerWorkspacePortabilityOperations<T extends SemanticOperationRegistry>(
  registry: T,
  service: WorkspacePortabilityService,
): T {
  for (const definition of workspacePortabilityOperationDefinitions(service)) registry.register(definition);
  return registry;
}
