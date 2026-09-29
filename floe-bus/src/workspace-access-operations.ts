/**
 * @invariant Workspace folders and System access are changed only by an
 * interactive surface, never by an unattended Actor, so an Actor cannot widen
 * its own file boundary. Every change is recorded and pushed.
 */
import {
  refusal,
  requireWorkspaceAuthorityId,
  type JsonSchema,
  type OperationExecutionContext,
  type SemanticOperationDefinition,
  type SemanticOperationRegistry,
} from "./operations.js";
import { WorkspaceFolderError, type WorkspaceAccess, type WorkspaceAccessStore } from "./workspace-access.js";

export const INSPECT_WORKSPACE_ACCESS_OPERATION_ID = "workspace.access.inspect";
export const ADD_WORKSPACE_FOLDER_OPERATION_ID = "workspace.folder.add";
export const REMOVE_WORKSPACE_FOLDER_OPERATION_ID = "workspace.folder.remove";
export const SET_WORKSPACE_SYSTEM_ACCESS_OPERATION_ID = "workspace.system_access.set";
export const ACKNOWLEDGE_WORKSPACE_NOTICE_OPERATION_ID = "workspace.notice.acknowledge";

const nonEmptyString: JsonSchema = { type: "string", minLength: 1 };
const nullableString: JsonSchema = { oneOf: [nonEmptyString, { type: "null" }] };
const accessSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["workspace_id", "folders", "system_access", "records"],
  properties: {
    workspace_id: nonEmptyString,
    folders: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["folder_id", "path", "home", "available", "added_at"],
        properties: {
          folder_id: nonEmptyString,
          path: nonEmptyString,
          home: { type: "boolean" },
          available: { type: "boolean" },
          added_at: nullableString,
        },
      },
    },
    system_access: { type: "boolean" },
    records: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["record_id", "kind", "summary", "path", "principal_id", "recorded_at", "seen_by"],
        properties: {
          record_id: nonEmptyString,
          kind: nonEmptyString,
          summary: nonEmptyString,
          path: nullableString,
          principal_id: nonEmptyString,
          recorded_at: nonEmptyString,
          seen_by: { type: "array", items: nonEmptyString, description: "People who have seen it as it now reads." },
          seen: { type: "boolean", description: "Whether you have seen it as it now reads." },
        },
      },
    },
  },
};

export type WorkspaceAccessOperationDependencies = Readonly<{
  access: WorkspaceAccessStore;
  /** Told after a committed-to-be change so it can re-check waiting approvals and push. */
  changed: (access: WorkspaceAccess) => void;
  /** Told when a person has seen a notice; nothing Actors may reach has changed. */
  acknowledged: (access: WorkspaceAccess) => void;
}>;

/** The access state as one person sees it: each record also says whether they have seen it. */
function forViewer(access: WorkspaceAccess, principalId: string) {
  return { ...access, records: access.records.map(record => ({ ...record, seen: record.seen_by.includes(principalId) })) };
}

function auditRef(context: OperationExecutionContext) {
  return { kind: "operation_invocation", id: context.invocation_id, revision: null };
}

function accessRef(workspaceId: string) {
  return { kind: "workspace_access", id: workspaceId, revision: null };
}

function change(dependencies: WorkspaceAccessOperationDependencies, context: OperationExecutionContext, work: () => WorkspaceAccess | null) {
  try {
    const access = work();
    if (access) dependencies.changed(access);
    const result = access ?? dependencies.access.inspect(requireWorkspaceAuthorityId(context.authority));
    return {
      state: "completed" as const,
      result,
      changed_refs: access ? [accessRef(access.workspace_id)] : [],
      audit_ref: auditRef(context),
    };
  } catch (error) {
    if (error instanceof WorkspaceFolderError) {
      return { state: "refused" as const, refusal: refusal(error.code, error.message, false, null) };
    }
    throw error;
  }
}

const writeEffects = { mode: "write", reversibility: "reversible", external: false, secret_access: "none" } as const;
const interactiveOnly = { allowed_modes: ["interactive"] } as const;
const noTarget = { resource_kinds: [], expected_revision: "not_applicable" } as const;

export function workspaceAccessOperationDefinitions(
  dependencies: WorkspaceAccessOperationDependencies,
): SemanticOperationDefinition<any, WorkspaceAccess>[] {
  return [
    {
      operation_id: INSPECT_WORKSPACE_ACCESS_OPERATION_ID,
      operation_version: "1",
      authority_boundary_kinds: ["workspace"],
      category: "workspace",
      title: "Show Workspace folders and System access",
      description: "List the folders Floe Actors' file tools may use in this Workspace, whether System access is on, and recent changes and notices, each marked seen or not by you.",
      effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
      required_grants: [INSPECT_WORKSPACE_ACCESS_OPERATION_ID],
      interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
      target: noTarget,
      input: { version: "1", schema: { type: "object", additionalProperties: false } },
      result: { version: "1", schema: accessSchema },
      handler: (context) => ({
        state: "completed" as const,
        result: forViewer(dependencies.access.inspect(requireWorkspaceAuthorityId(context.authority)), context.authority.principal_id),
        changed_refs: [],
        audit_ref: auditRef(context),
      }),
    },
    {
      operation_id: ADD_WORKSPACE_FOLDER_OPERATION_ID,
      operation_version: "1",
      authority_boundary_kinds: ["workspace"],
      category: "workspace",
      title: "Add a folder to the Workspace",
      description: "Let Floe Actors' file tools use another folder on this machine, by its full path.",
      effects: writeEffects,
      required_grants: [ADD_WORKSPACE_FOLDER_OPERATION_ID],
      interaction_constraints: interactiveOnly,
      target: noTarget,
      input: { version: "1", schema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: nonEmptyString } } },
      result: { version: "1", schema: accessSchema },
      handler: (context, input: { path: string }) => change(dependencies, context, () => dependencies.access.addFolder({
        workspace_id: requireWorkspaceAuthorityId(context.authority),
        path: input.path,
        principal_id: context.authority.principal_id,
      })),
    },
    {
      operation_id: REMOVE_WORKSPACE_FOLDER_OPERATION_ID,
      operation_version: "1",
      authority_boundary_kinds: ["workspace"],
      category: "workspace",
      title: "Remove a folder from the Workspace",
      description: "Stop Floe Actors' file tools using a folder that was added to this Workspace. The Workspace's own folder stays.",
      effects: writeEffects,
      required_grants: [REMOVE_WORKSPACE_FOLDER_OPERATION_ID],
      interaction_constraints: interactiveOnly,
      target: noTarget,
      input: { version: "1", schema: { type: "object", additionalProperties: false, required: ["folder_id"], properties: { folder_id: nonEmptyString } } },
      result: { version: "1", schema: accessSchema },
      handler: (context, input: { folder_id: string }) => change(dependencies, context, () => dependencies.access.removeFolder({
        workspace_id: requireWorkspaceAuthorityId(context.authority),
        folder_id: input.folder_id,
        principal_id: context.authority.principal_id,
      })),
    },
    {
      operation_id: SET_WORKSPACE_SYSTEM_ACCESS_OPERATION_ID,
      operation_version: "1",
      authority_boundary_kinds: ["workspace"],
      category: "workspace",
      title: "Turn System access on or off",
      description: "When on, Floe Actors' file tools may reach anywhere on this machine, and an engine may be allowed to"
        + " bypass its sandbox. Off by default.",
      effects: writeEffects,
      required_grants: [SET_WORKSPACE_SYSTEM_ACCESS_OPERATION_ID],
      interaction_constraints: interactiveOnly,
      target: noTarget,
      input: { version: "1", schema: { type: "object", additionalProperties: false, required: ["enabled"], properties: { enabled: { type: "boolean" } } } },
      result: { version: "1", schema: accessSchema },
      handler: (context, input: { enabled: boolean }) => change(dependencies, context, () => dependencies.access.setSystemAccess({
        workspace_id: requireWorkspaceAuthorityId(context.authority),
        enabled: input.enabled,
        principal_id: context.authority.principal_id,
      })),
    },
    {
      operation_id: ACKNOWLEDGE_WORKSPACE_NOTICE_OPERATION_ID,
      operation_version: "1",
      authority_boundary_kinds: ["workspace"],
      category: "workspace",
      title: "Mark a notice as seen",
      description: "Record that you have seen a Workspace notice or change, so every surface you use stops showing it as new."
        + " If the notice later changes, it shows as new again.",
      effects: writeEffects,
      required_grants: [ACKNOWLEDGE_WORKSPACE_NOTICE_OPERATION_ID],
      interaction_constraints: interactiveOnly,
      target: noTarget,
      input: { version: "1", schema: { type: "object", additionalProperties: false, required: ["record_id"], properties: { record_id: nonEmptyString } } },
      result: { version: "1", schema: accessSchema },
      handler: (context, input: { record_id: string }) => {
        const workspaceId = requireWorkspaceAuthorityId(context.authority);
        const principalId = context.authority.principal_id;
        try {
          const changed = dependencies.access.acknowledge({ workspace_id: workspaceId, record_id: input.record_id, principal_id: principalId });
          const access = dependencies.access.inspect(workspaceId);
          if (changed) dependencies.acknowledged(access);
          return { state: "completed" as const, result: forViewer(access, principalId),
            changed_refs: changed ? [accessRef(workspaceId)] : [], audit_ref: auditRef(context) };
        } catch (error) {
          if (error instanceof WorkspaceFolderError) {
            return { state: "refused" as const, refusal: refusal(error.code, error.message, false, null) };
          }
          throw error;
        }
      },
    },
  ];
}

export function registerWorkspaceAccessOperations<T extends SemanticOperationRegistry>(
  registry: T,
  dependencies: WorkspaceAccessOperationDependencies,
): T {
  for (const definition of workspaceAccessOperationDefinitions(dependencies)) registry.register(definition);
  return registry;
}
