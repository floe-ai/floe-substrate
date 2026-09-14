import {
  WorkspaceBindingChangedError,
  WorkspaceBindingNotFoundError,
  WorkspaceExplicitRebindRequiredError,
  WorkspaceIdentityConflictError,
  WorkspaceIdentityNotFoundError,
  WorkspaceLocatorConflictError,
  WorkspaceLocatorInvalidError,
  type RemoteWorkspaceProjection,
  type WorkspaceIdentitySnapshot,
} from "./workspace-identities.js";
import {
  refusal,
  requiredAction,
  type JsonSchema,
  type OperationExecutionContext,
  type OperationRefusal,
  type SemanticOperationDefinition,
  type SemanticOperationRegistry,
} from "./operations.js";

export const INSPECT_WORKSPACE_OPERATION_ID = "workspace.inspect";
export const REGISTER_WORKSPACE_OPERATION_ID = "workspace.register";
export const REBIND_WORKSPACE_OPERATION_ID = "workspace.rebind";
export const RESTORE_WORKSPACE_OPERATION_ID = "workspace.restore_identity";
export const COPY_WORKSPACE_OPERATION_ID = "workspace.copy_identity";
export const FORK_WORKSPACE_OPERATION_ID = "workspace.fork_identity";

/**
 * These operations establish identity before Workspace authority exists. They
 * keep canonical semantic definitions, but only the authenticated host-local
 * adapter may expose them. A caller must never invent a Workspace authority
 * merely to bootstrap one.
 */
export const HOST_LOCAL_WORKSPACE_OPERATION_IDS = new Set([
  REGISTER_WORKSPACE_OPERATION_ID,
  REBIND_WORKSPACE_OPERATION_ID,
  RESTORE_WORKSPACE_OPERATION_ID,
  COPY_WORKSPACE_OPERATION_ID,
  FORK_WORKSPACE_OPERATION_ID,
]);

export class WorkspaceDirectoryNotFoundError extends Error {
  constructor(readonly locator: string) {
    super("The selected Workspace directory does not exist.");
    this.name = "WorkspaceDirectoryNotFoundError";
  }
}

export interface WorkspaceOperationBackend {
  inspect(workspaceId: string): RemoteWorkspaceProjection | null;
  register(input: {
    locator: string;
    name?: string;
    init_authorized?: boolean;
    create_directory?: boolean;
  }): RemoteWorkspaceProjection;
  rebind(input: {
    workspace_id: string;
    locator: string;
    expected_binding_id: string;
    init_authorized?: boolean;
  }): RemoteWorkspaceProjection;
  restore(input: {
    snapshot: WorkspaceIdentitySnapshot;
    locator: string;
    init_authorized?: boolean;
  }): RemoteWorkspaceProjection;
  derive(input: {
    source_workspace_id: string;
    kind: "copied" | "forked";
    name: string;
    locator: string;
    init_authorized?: boolean;
  }): RemoteWorkspaceProjection;
}

const stringSchema: JsonSchema = { type: "string", minLength: 1 };
const nullableStringSchema: JsonSchema = { oneOf: [stringSchema, { type: "null" }] };
const emptyInputSchema: JsonSchema = { type: "object", additionalProperties: false };
const remoteWorkspaceSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "workspace_id", "name", "creation_kind", "source_workspace_id",
    "created_at", "updated_at", "availability",
  ],
  properties: {
    workspace_id: stringSchema,
    name: stringSchema,
    creation_kind: { enum: ["created", "legacy_retained", "copied", "forked"] },
    source_workspace_id: nullableStringSchema,
    created_at: stringSchema,
    updated_at: stringSchema,
    availability: {
      type: "object",
      additionalProperties: false,
      required: ["bound_on_serving_host", "status"],
      properties: {
        bound_on_serving_host: { type: "boolean" },
        status: nullableStringSchema,
      },
    },
  },
};
const workspaceResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["workspace"],
  properties: { workspace: remoteWorkspaceSchema },
};
const localBindingProperties = {
  locator: stringSchema,
  init_authorized: { type: "boolean" },
};
const registerInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["locator"],
  properties: {
    ...localBindingProperties,
    name: stringSchema,
    create_directory: { type: "boolean" },
  },
};
const rebindInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["locator", "expected_binding_id"],
  properties: {
    ...localBindingProperties,
    expected_binding_id: stringSchema,
  },
};
const identitySnapshotSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["workspace_id", "name", "creation_kind", "source_workspace_id", "created_at", "updated_at"],
  properties: {
    workspace_id: stringSchema,
    name: stringSchema,
    creation_kind: { enum: ["created", "legacy_retained", "copied", "forked"] },
    source_workspace_id: nullableStringSchema,
    created_at: stringSchema,
    updated_at: stringSchema,
  },
};
const restoreInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["snapshot", "locator"],
  properties: {
    snapshot: identitySnapshotSchema,
    ...localBindingProperties,
  },
};
const deriveInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "locator"],
  properties: {
    name: stringSchema,
    ...localBindingProperties,
  },
};

type WorkspaceResult = { workspace: RemoteWorkspaceProjection };

function targetWorkspace(context: OperationExecutionContext): string {
  const target = context.target?.ref;
  if (
    !target
    || target.kind !== "workspace"
    || (
      context.authority.boundary.kind === "workspace"
      && target.id !== context.authority.boundary.workspace_id
    )
  ) {
    throw new WorkspaceIdentityNotFoundError(target?.id ?? "missing-target");
  }
  return target.id;
}

export function workspaceOperationRefusal(error: unknown): OperationRefusal {
  if (error instanceof WorkspaceDirectoryNotFoundError) {
    return refusal(
      "workspace_directory_not_found",
      error.message,
      false,
      requiredAction("choose_location", "Choose a Workspace folder", "Choose an existing folder or allow Floe to create it."),
      { locator: error.locator },
    );
  }
  if (error instanceof WorkspaceLocatorConflictError) {
    return refusal(
      "workspace_locator_conflict",
      "That local location is already bound to another Workspace.",
      false,
      requiredAction("choose_location", "Choose another location", "Choose an unbound folder or inspect the Workspace already using this location."),
      { conflicting_workspace_id: error.conflicting_workspace_id },
    );
  }
  if (error instanceof WorkspaceExplicitRebindRequiredError) {
    return refusal(
      "workspace_explicit_rebind_required",
      "This Workspace already has a local location. Moving it requires an explicit rebind.",
      false,
      requiredAction("rebind_workspace", "Move this Workspace", "Use workspace.rebind with the current binding reference."),
      { current_binding_id: error.current_binding_id },
    );
  }
  if (error instanceof WorkspaceBindingChangedError) {
    return refusal(
      "workspace_binding_changed",
      "The local Workspace location changed before this request completed.",
      true,
      requiredAction("refresh_workspace", "Refresh Workspace", "Refresh its local binding before deciding whether to move it again."),
    );
  }
  if (error instanceof WorkspaceBindingNotFoundError || error instanceof WorkspaceIdentityNotFoundError) {
    return refusal(
      "workspace_not_found",
      "The requested Workspace or local binding is not available.",
      false,
      requiredAction("refresh_workspaces", "Refresh Workspaces", "Refresh available Workspaces and choose a retained identity."),
    );
  }
  if (error instanceof WorkspaceLocatorInvalidError) {
    return refusal(
      "workspace_locator_invalid",
      error.message,
      false,
      requiredAction("choose_absolute_location", "Choose a valid location", "Choose an absolute path on the machine running this Floe host."),
    );
  }
  if (error instanceof WorkspaceIdentityConflictError) {
    return refusal(
      "workspace_identity_conflict",
      "The imported Workspace identity conflicts with retained identity provenance.",
      false,
      requiredAction("inspect_import", "Inspect the imported Workspace", "Confirm whether this is a restore or an independent copy before continuing."),
    );
  }
  return refusal(
    "workspace_operation_failed",
    "Floe could not prove that the Workspace operation completed.",
    false,
    requiredAction("inspect_workspaces", "Inspect Workspaces", "Inspect retained Workspace identities and local bindings before retrying."),
  );
}

function definition<TInput>(input: {
  operation_id: string;
  title: string;
  description: string;
  mode: "read" | "write";
  reversibility: "none" | "reversible" | "irreversible";
  grant: string;
  authority_boundary_kind: "workspace" | "host";
  target: boolean;
  input_schema: JsonSchema;
  handler: (context: OperationExecutionContext, value: TInput) => RemoteWorkspaceProjection;
}): SemanticOperationDefinition<TInput, WorkspaceResult> {
  return {
    operation_id: input.operation_id,
    operation_version: "1",
    authority_boundary_kinds: [input.authority_boundary_kind],
    category: "workspaces",
    title: input.title,
    description: input.description,
    effects: {
      mode: input.mode,
      reversibility: input.reversibility,
      external: input.operation_id === REGISTER_WORKSPACE_OPERATION_ID,
      secret_access: "none",
    },
    required_grants: [input.grant],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: {
      resource_kinds: input.target ? ["workspace"] : [],
      expected_revision: "not_applicable",
    },
    input: { version: "1", schema: input.input_schema },
    result: { version: "1", schema: workspaceResultSchema },
    handler: async (context, value) => {
      try {
        return {
          state: "completed",
          result: { workspace: input.handler(context, value) },
        };
      } catch (error) {
        return { state: "refused", refusal: workspaceOperationRefusal(error) };
      }
    },
  };
}

export function workspaceOperationDefinitions(
  backend: WorkspaceOperationBackend,
): Array<SemanticOperationDefinition<any, WorkspaceResult>> {
  return [
    definition<Record<string, never>>({
      operation_id: INSPECT_WORKSPACE_OPERATION_ID,
      title: "Inspect Workspace",
      description: "Inspect portable Workspace identity and availability without exposing a host path.",
      mode: "read",
      reversibility: "none",
      grant: "workspace.inspect",
      authority_boundary_kind: "workspace",
      target: true,
      input_schema: emptyInputSchema,
      handler: (context) => {
        const id = targetWorkspace(context);
        const workspace = backend.inspect(id);
        if (!workspace) throw new WorkspaceIdentityNotFoundError(id);
        return workspace;
      },
    }),
    definition<{ locator: string; name?: string; init_authorized?: boolean; create_directory?: boolean }>({
      operation_id: REGISTER_WORKSPACE_OPERATION_ID,
      title: "Register Workspace",
      description: "Create an opaque Workspace identity and bind it to an authenticated host-local folder.",
      mode: "write",
      reversibility: "irreversible",
      grant: REGISTER_WORKSPACE_OPERATION_ID,
      authority_boundary_kind: "host",
      target: false,
      input_schema: registerInputSchema,
      handler: (_context, value) => backend.register(value),
    }),
    definition<{ locator: string; expected_binding_id: string; init_authorized?: boolean }>({
      operation_id: REBIND_WORKSPACE_OPERATION_ID,
      title: "Move Workspace",
      description: "Explicitly replace this host's local folder binding without changing Workspace identity.",
      mode: "write",
      reversibility: "reversible",
      grant: REBIND_WORKSPACE_OPERATION_ID,
      authority_boundary_kind: "host",
      target: true,
      input_schema: rebindInputSchema,
      handler: (context, value) => backend.rebind({ workspace_id: targetWorkspace(context), ...value }),
    }),
    definition<{ snapshot: WorkspaceIdentitySnapshot; locator: string; init_authorized?: boolean }>({
      operation_id: RESTORE_WORKSPACE_OPERATION_ID,
      title: "Restore Workspace identity",
      description: "Restore a verified exported Workspace identity on this host without treating it as a copy.",
      mode: "write",
      reversibility: "irreversible",
      grant: RESTORE_WORKSPACE_OPERATION_ID,
      authority_boundary_kind: "host",
      target: false,
      input_schema: restoreInputSchema,
      handler: (_context, value) => backend.restore(value),
    }),
    ...(["copied", "forked"] as const).map((kind) => definition<{
      name: string;
      locator: string;
      init_authorized?: boolean;
    }>({
      operation_id: kind === "copied" ? COPY_WORKSPACE_OPERATION_ID : FORK_WORKSPACE_OPERATION_ID,
      title: kind === "copied" ? "Copy Workspace identity" : "Fork Workspace identity",
      description: `Allocate a new opaque identity for a ${kind === "copied" ? "copy" : "fork"} while retaining its source relationship.`,
      mode: "write",
      reversibility: "irreversible",
      grant: kind === "copied" ? COPY_WORKSPACE_OPERATION_ID : FORK_WORKSPACE_OPERATION_ID,
      authority_boundary_kind: "host",
      target: true,
      input_schema: deriveInputSchema,
      handler: (context, value) => backend.derive({
        source_workspace_id: targetWorkspace(context),
        kind,
        ...value,
      }),
    })),
  ];
}

export function registerWorkspaceOperations<T extends SemanticOperationRegistry>(
  registry: T,
  backend: WorkspaceOperationBackend,
): T {
  for (const operation of workspaceOperationDefinitions(backend)) registry.register(operation);
  return registry;
}
