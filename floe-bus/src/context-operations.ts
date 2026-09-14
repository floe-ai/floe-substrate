import {
  ContextLifecycleConflictError,
  ContextNotFoundError,
  ContextParticipantRequiredError,
  ContextRevisionConflictError,
  ContextStore,
  type CanonicalContextRecord,
  type ContextListRow,
  type ContextParticipantAccess,
  type ContextParticipantInput,
  type ContextParticipantRecord,
} from "./contexts/store.js";
import {
  refusal,
  requireWorkspaceAuthorityId,
  requiredAction,
  type JsonSchema,
  type OperationAuthorityContext,
  type OperationExecutionContext,
  type OperationRefusal,
  type OperationResourceRef,
  type ResolvedOperationResource,
  type SemanticOperationDefinition,
  type SemanticOperationRegistry,
} from "./operations.js";

/** Context is collaboration and retained understanding. It never advances Scope routing. */
export const LIST_CONTEXTS_OPERATION_ID = "context.list";
export const GET_CONTEXT_OPERATION_ID = "context.get";
export const INSPECT_CONTEXT_OPERATION_ID = "context.inspect";
export const CREATE_CONTEXT_OPERATION_ID = "context.create";
export const ARCHIVE_CONTEXT_OPERATION_ID = "context.archive";
export const RESTORE_CONTEXT_OPERATION_ID = "context.restore";
export const SET_CONTEXT_PARTICIPANT_ACCESS_OPERATION_ID = "context.participant.set_access";
export const REMOVE_CONTEXT_PARTICIPANT_OPERATION_ID = "context.participant.remove";
export const EMIT_CONTEXT_COMMUNICATION_OPERATION_ID = "context.communication.emit";
export const DESTROY_CONTEXT_PERMANENTLY_OPERATION_ID = "context.destroy_permanently";

export type ContextRetainedReference = OperationResourceRef & Readonly<{
  relationship: string;
}>;

export type ContextDestructionOutcome =
  | Readonly<{
      destroyed: true;
      context: CanonicalContextRecord;
      events_deleted: number;
    }>
  | Readonly<{
      destroyed: false;
      retained_references: readonly ContextRetainedReference[];
    }>;

export type DirectContextCommunicationIntent = Readonly<{
  workspace_id: string;
  context_id: string;
  principal_id: string;
  event_type: string;
  recipient_participant_id: string | null;
  content: Readonly<Record<string, unknown>>;
  artefact_version_ids: readonly string[];
  attachment_ingress_ids: readonly string[];
  response_expected: boolean;
  invocation_id: string;
  provenance: OperationExecutionContext["provenance"];
}>;

export type DirectContextCommunicationOutcome =
  | Readonly<{
      emitted: true;
      event_ref: OperationResourceRef;
      artefact_version_refs: readonly OperationResourceRef[];
    }>
  | Readonly<{
      emitted: false;
      code: string;
      message: string;
      retryable: boolean;
      details?: Readonly<Record<string, unknown>>;
    }>;

/**
 * Cross-resource checks and Event creation remain in the owning Bus adapter.
 * In particular, destruction must re-check retained references atomically with
 * tombstoning, and direct communication must reuse the existing Event path.
 */
export interface ContextOperationBackend {
  readonly contexts: ContextStore;
  participantExists(workspaceId: string, participantId: string): boolean;
  scopeExists(workspaceId: string, scopeId: string): boolean;
  listRetainedReferences(workspaceId: string, contextId: string): readonly ContextRetainedReference[];
  publishContextChange(
    type: "created" | "archived" | "restored" | "participant_changed" | "tombstoned",
    context: CanonicalContextRecord,
    details?: Readonly<Record<string, unknown>>,
  ): void;
  destroyContextPermanently(input: Readonly<{
    workspace_id: string;
    context_id: string;
    expected_revision: number;
    principal_id: string;
    reason: string;
    invocation_id: string;
  }>): ContextDestructionOutcome | Promise<ContextDestructionOutcome>;
  emitDirectContextCommunication(
    intent: DirectContextCommunicationIntent,
  ): DirectContextCommunicationOutcome | Promise<DirectContextCommunicationOutcome>;
}

export type ContextInspection = Readonly<{
  context: CanonicalContextRecord;
  participants: readonly ContextParticipantRecord[];
  retained_references: readonly ContextRetainedReference[];
}>;

const nonEmptyString: JsonSchema = { type: "string", minLength: 1 };
const nullableString: JsonSchema = { oneOf: [nonEmptyString, { type: "null" }] };
const emptyInput: JsonSchema = { type: "object", additionalProperties: false };
const accessSchema: JsonSchema = { enum: ["read", "contribute", "manage"] };
const resourceRefSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id", "revision"],
  properties: { kind: nonEmptyString, id: nonEmptyString, revision: nullableString },
};
const retainedReferenceSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id", "revision", "relationship"],
  properties: {
    kind: nonEmptyString,
    id: nonEmptyString,
    revision: nullableString,
    relationship: nonEmptyString,
  },
};
const contextSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "context_id", "workspace_id", "scope_id", "parent_context_id",
    "created_by_endpoint_id", "created_by_principal_id", "created_at", "updated_at",
    "title", "state_revision", "lifecycle_state", "archived_at",
    "archived_by_principal_id", "archive_reason", "restored_at",
    "restored_by_principal_id", "content_state", "redacted_at",
    "redacted_by_principal_id", "redaction_reason", "tombstoned_at",
    "tombstoned_by_principal_id", "tombstone_reason",
  ],
  properties: {
    context_id: nonEmptyString,
    workspace_id: nonEmptyString,
    scope_id: nullableString,
    parent_context_id: nullableString,
    created_by_endpoint_id: nullableString,
    created_by_principal_id: nullableString,
    created_at: nonEmptyString,
    updated_at: nonEmptyString,
    title: nullableString,
    state_revision: { type: "integer", minimum: 1 },
    lifecycle_state: { enum: ["active", "archived", "tombstoned"] },
    archived_at: nullableString,
    archived_by_principal_id: nullableString,
    archive_reason: nullableString,
    restored_at: nullableString,
    restored_by_principal_id: nullableString,
    content_state: { enum: ["available", "redacted", "destroyed"] },
    redacted_at: nullableString,
    redacted_by_principal_id: nullableString,
    redaction_reason: nullableString,
    tombstoned_at: nullableString,
    tombstoned_by_principal_id: nullableString,
    tombstone_reason: nullableString,
  },
};
const participantSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "participant_id", "role", "access", "actor_role_assignment_id", "joined_at", "updated_at",
  ],
  properties: {
    participant_id: nonEmptyString,
    role: nonEmptyString,
    access: accessSchema,
    actor_role_assignment_id: nullableString,
    joined_at: nonEmptyString,
    updated_at: nonEmptyString,
  },
};
const contextListRowSchema: JsonSchema = {
  ...contextSchema,
  required: [
    ...(contextSchema.required as string[]),
    "participants", "last_event_at", "activity_at", "topic",
  ],
  properties: {
    ...(contextSchema.properties as Record<string, unknown>),
    participants: { type: "array", items: nonEmptyString, uniqueItems: true },
    last_event_at: nullableString,
    activity_at: nonEmptyString,
    topic: nullableString,
  },
};
const contextOnlyResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["context"],
  properties: { context: contextSchema },
};
const listInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    participant_id: nonEmptyString,
    scope_id: nonEmptyString,
    include_archived: { type: "boolean" },
    include_tombstoned: { type: "boolean" },
    limit: { type: "integer", minimum: 1, maximum: 500 },
  },
};
const listResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["contexts"],
  properties: { contexts: { type: "array", items: contextListRowSchema } },
};
const inspectResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["context", "participants", "retained_references"],
  properties: {
    context: contextSchema,
    participants: { type: "array", items: participantSchema },
    retained_references: { type: "array", items: retainedReferenceSchema },
  },
};
const participantInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["participant_id"],
  properties: {
    participant_id: nonEmptyString,
    role: nonEmptyString,
    access: accessSchema,
  },
};
const createInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    context_id: nonEmptyString,
    title: nullableString,
    scope_id: nullableString,
    parent_context_id: nullableString,
    participants: { type: "array", items: participantInputSchema, uniqueItems: true },
  },
};
const reasonInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { reason: nullableString },
};
const destroyInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reason"],
  properties: { reason: nonEmptyString },
};
const setParticipantInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["participant_id", "role", "access"],
  properties: {
    participant_id: nonEmptyString,
    role: nonEmptyString,
    access: accessSchema,
  },
};
const removeParticipantInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["participant_id"],
  properties: { participant_id: nonEmptyString },
};
const participantMutationResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["context", "participant", "changed"],
  properties: { context: contextSchema, participant: participantSchema, changed: { type: "boolean" } },
};
const participantRemovalResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["context", "participant_id", "removed"],
  properties: { context: contextSchema, participant_id: nonEmptyString, removed: { type: "boolean" } },
};
const communicationInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["event_type", "content", "response_expected"],
  properties: {
    event_type: nonEmptyString,
    recipient_participant_id: nullableString,
    content: { type: "object", properties: {
      references: { type: "array", description: "Optional named navigation references for clients. They do not assert record state, grant access or execute an action.", items: {
        type: "object", required: ["name", "resource_ref"], additionalProperties: false,
        properties: { name: nonEmptyString, resource_ref: resourceRefSchema },
      } },
    } },
    artefact_version_ids: { type: "array", items: nonEmptyString, uniqueItems: true },
    attachment_ingress_ids: { type: "array", items: nonEmptyString, uniqueItems: true, maxItems: 5 },
    response_expected: { type: "boolean" },
  },
};
const communicationResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["event_ref", "artefact_version_refs"],
  properties: {
    event_ref: resourceRefSchema,
    artefact_version_refs: { type: "array", items: resourceRefSchema, uniqueItems: true },
  },
};
const destructionResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["context", "events_deleted"],
  properties: { context: contextSchema, events_deleted: { type: "integer", minimum: 0 } },
};

function contextRevision(context: CanonicalContextRecord): string {
  return String(context.state_revision);
}

function contextRef(context: CanonicalContextRecord): OperationResourceRef {
  return { kind: "context", id: context.context_id, revision: contextRevision(context) };
}

function participantRef(contextId: string, participantId: string): OperationResourceRef {
  return { kind: "context_participant", id: `${contextId}:${participantId}`, revision: null };
}

function auditRef(context: OperationExecutionContext): OperationResourceRef {
  return { kind: "operation_invocation", id: context.invocation_id, revision: null };
}

function workspaceId(context: Readonly<{ authority: OperationAuthorityContext }>): string {
  return requireWorkspaceAuthorityId(context.authority);
}

function contextInWorkspace(
  store: ContextStore,
  workspaceId: string,
  contextId: string,
): CanonicalContextRecord | null {
  const context = store.getContext(contextId);
  return context?.workspace_id === workspaceId ? context : null;
}

export function resolveContextOperationResource(
  store: ContextStore,
  workspaceId: string,
  target: Readonly<{ kind: string; id: string }>,
): ResolvedOperationResource | null {
  if (target.kind !== "context") return null;
  const context = contextInWorkspace(store, workspaceId, target.id);
  return context ? { ref: contextRef(context), state: context } : null;
}

function contextAvailability(
  backend: ContextOperationBackend,
  workspaceId: string,
  contextId: string,
  expectedState?: CanonicalContextRecord["lifecycle_state"],
) {
  const context = contextInWorkspace(backend.contexts, workspaceId, contextId);
  if (!context) {
    return {
      available: false as const,
      refusal: refusal(
        "context_not_found",
        "This Context is not available in the current Workspace.",
        false,
        requiredAction("refresh_contexts", "Refresh Contexts", "Refresh this Workspace and select an available Context."),
      ),
    };
  }
  if (expectedState && context.lifecycle_state !== expectedState) {
    return {
      available: false as const,
      refusal: lifecycleRefusal(context.lifecycle_state),
    };
  }
  return { available: true as const };
}

function lifecycleRefusal(state: CanonicalContextRecord["lifecycle_state"]): OperationRefusal {
  if (state === "tombstoned") {
    return refusal(
      "context_tombstoned",
      "This Context has been permanently destroyed. Its retained tombstone is read-only.",
      false,
      requiredAction("inspect_context", "Inspect tombstone", "Inspect the retained Context identity and destruction metadata."),
    );
  }
  return refusal(
    state === "archived" ? "context_archived" : "context_already_active",
    state === "archived" ? "This Context is archived." : "This Context is already active.",
    false,
    requiredAction("inspect_context", "Inspect Context", "Inspect the Context's current lifecycle state."),
  );
}

function contextOperationRefusal(error: unknown): OperationRefusal {
  if (error instanceof ContextRevisionConflictError) {
    return refusal(
      "context_revision_conflict",
      "The Context changed before this operation completed.",
      true,
      requiredAction("refresh_context", "Review the latest Context", "Refresh the Context and retry against its exact revision."),
      { expected_revision: error.expected_revision, current_revision: error.current_revision },
    );
  }
  if (error instanceof ContextLifecycleConflictError) return lifecycleRefusal(error.lifecycle_state);
  if (error instanceof ContextParticipantRequiredError) {
    return refusal(
      "context_participant_required",
      "An unscoped active Context must retain at least one participant.",
      false,
      requiredAction("archive_context", "Archive Context", "Archive the Context before removing its final participant."),
    );
  }
  if (error instanceof ContextNotFoundError) {
    return refusal(
      "context_not_found",
      "This Context is not available in the current Workspace.",
      false,
      requiredAction("refresh_contexts", "Refresh Contexts", "Refresh this Workspace and select an available Context."),
    );
  }
  return refusal(
    "context_change_failed",
    error instanceof Error ? error.message : "The Context could not be changed.",
    false,
    requiredAction("inspect_context", "Inspect Context", "Inspect current Context state before trying another change."),
  );
}

async function handle<TResult>(work: () => TResult | Promise<TResult>) {
  try {
    return await work();
  } catch (error) {
    return { state: "refused" as const, refusal: contextOperationRefusal(error) };
  }
}

function requireExpectedRevision(context: OperationExecutionContext): number {
  const value = Number(context.expected_resource_revision);
  if (!Number.isInteger(value) || value < 1) {
    throw new ContextRevisionConflictError(context.target!.ref.id, value, Number(context.target!.ref.revision));
  }
  return value;
}

export function listContextsOperation(
  backend: ContextOperationBackend,
): SemanticOperationDefinition<{
  participant_id?: string;
  scope_id?: string;
  include_archived?: boolean;
  include_tombstoned?: boolean;
  limit?: number;
}, { contexts: ContextListRow[] }> {
  return {
    operation_id: LIST_CONTEXTS_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "contexts",
    title: "List Contexts",
    description: "List collaboration Contexts in this Workspace. Archived and tombstoned Contexts are hidden unless requested.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [LIST_CONTEXTS_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    input: { version: "1", schema: listInputSchema },
    result: { version: "1", schema: listResultSchema },
    handler: (context, input) => handle(() => ({
      state: "completed" as const,
      result: {
        contexts: input.participant_id
          ? backend.contexts.listContextsForParticipant(input.participant_id, {
              workspace_id: workspaceId(context),
              scope_id: input.scope_id,
              include_archived: input.include_archived,
              include_tombstoned: input.include_tombstoned,
              limit: input.limit,
            })
          : backend.contexts.listContextsForWorkspace(workspaceId(context), {
              scope_id: input.scope_id,
              include_archived: input.include_archived,
              include_tombstoned: input.include_tombstoned,
              limit: input.limit,
            }),
      },
      audit_ref: auditRef(context),
    })),
  };
}

export function getContextOperation(
  backend: ContextOperationBackend,
): SemanticOperationDefinition<Record<string, never>, { context: CanonicalContextRecord }> {
  return {
    operation_id: GET_CONTEXT_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "contexts",
    title: "Get Context",
    description: "Get one exact Context identity and its lifecycle metadata from this Workspace.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [GET_CONTEXT_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["context"], expected_revision: "not_applicable" },
    input: { version: "1", schema: emptyInput },
    result: { version: "1", schema: contextOnlyResultSchema },
    availability: (context) => contextAvailability(
      backend,
      workspaceId(context),
      context.target!.ref.id,
    ),
    handler: (context) => handle(() => {
      const value = contextInWorkspace(backend.contexts, workspaceId(context), context.target!.ref.id);
      if (!value) throw new ContextNotFoundError(context.target!.ref.id);
      return { state: "completed" as const, result: { context: value }, audit_ref: auditRef(context) };
    }),
  };
}

export function inspectContextOperation(
  backend: ContextOperationBackend,
): SemanticOperationDefinition<Record<string, never>, ContextInspection> {
  return {
    operation_id: INSPECT_CONTEXT_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "contexts",
    title: "Inspect Context",
    description: "Inspect a Context's participants, access, lifecycle, and canonical records that require its evidence to be retained.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [INSPECT_CONTEXT_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["context"], expected_revision: "not_applicable" },
    input: { version: "1", schema: emptyInput },
    result: { version: "1", schema: inspectResultSchema },
    availability: (context) => contextAvailability(
      backend,
      workspaceId(context),
      context.target!.ref.id,
    ),
    handler: (context) => handle(() => {
      const value = contextInWorkspace(backend.contexts, workspaceId(context), context.target!.ref.id);
      if (!value) throw new ContextNotFoundError(context.target!.ref.id);
      return {
        state: "completed" as const,
        result: {
          context: value,
          participants: backend.contexts.getContextParticipantRecords(value.context_id),
          retained_references: [...backend.listRetainedReferences(value.workspace_id, value.context_id)],
        },
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function createContextOperation(
  backend: ContextOperationBackend,
): SemanticOperationDefinition<{
  context_id?: string;
  title?: string | null;
  scope_id?: string | null;
  parent_context_id?: string | null;
  participants?: ContextParticipantInput[];
}, { context: CanonicalContextRecord }> {
  return {
    operation_id: CREATE_CONTEXT_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "contexts",
    title: "Create Context",
    description: "Create a durable collaboration Context. Membership grants access and understanding; it never defines Scope routing.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [CREATE_CONTEXT_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    input: { version: "1", schema: createInputSchema },
    result: { version: "1", schema: contextOnlyResultSchema },
    handler: (context, input) => handle(() => {
      const participants = input.participants ?? [];
      if (!input.scope_id && participants.length === 0) {
        return {
          state: "refused" as const,
          refusal: refusal(
            "context_anchor_required",
            "A Context requires at least one participant or an owning Scope reference.",
            false,
            requiredAction("supply_context_anchor", "Choose participants", "Choose at least one participant or a Scope for this Context."),
          ),
        };
      }
      if (input.scope_id && !backend.scopeExists(workspaceId(context), input.scope_id)) {
        return {
          state: "refused" as const,
          refusal: refusal(
            "context_scope_not_found",
            "The selected Scope is not available in this Workspace.",
            false,
            requiredAction("select_scope", "Select a Scope", "Select a Scope from the current Workspace."),
          ),
        };
      }
      if (input.parent_context_id) {
        if (
          input.context_id
          && (
            input.parent_context_id === input.context_id
            || backend.contexts.wouldCreateCycle(input.parent_context_id, input.context_id)
          )
        ) {
          return {
            state: "refused" as const,
            refusal: refusal(
              "context_parent_cycle",
              "The selected parent would create a Context cycle.",
              false,
              requiredAction("select_context", "Select another parent", "Select a Context outside this Context's descendant chain."),
            ),
          };
        }
        const parent = contextInWorkspace(backend.contexts, workspaceId(context), input.parent_context_id);
        if (!parent || parent.lifecycle_state === "tombstoned") {
          return {
            state: "refused" as const,
            refusal: refusal(
              "context_parent_not_found",
              "The parent Context is not available in this Workspace.",
              false,
              requiredAction("select_context", "Select a parent Context", "Select an available parent Context from this Workspace."),
            ),
          };
        }
      }
      const missing = participants.find((participant) =>
        !backend.participantExists(workspaceId(context), participant.participant_id));
      if (missing) {
        return {
          state: "refused" as const,
          refusal: refusal(
            "context_participant_not_found",
            "A selected participant is not available in this Workspace.",
            false,
            requiredAction("select_participant", "Select a participant", "Select participants from the current Workspace."),
            { participant_id: missing.participant_id },
          ),
        };
      }
      const id = backend.contexts.createContext({
        workspace_id: workspaceId(context),
        scope_id: input.scope_id ?? null,
        parent_context_id: input.parent_context_id ?? null,
        created_by_endpoint_id: null,
        created_by_principal_id: context.authority.principal_id,
        participants,
        ...(input.context_id ? { context_id: input.context_id } : {}),
        title: input.title ?? null,
      });
      const created = backend.contexts.requireContext(id);
      backend.publishContextChange("created", created);
      return {
        state: "completed" as const,
        result: { context: created },
        changed_refs: [contextRef(created)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

function contextLifecycleOperation(
  backend: ContextOperationBackend,
  lifecycle: "archive" | "restore",
): SemanticOperationDefinition<{ reason?: string | null }, { context: CanonicalContextRecord }> {
  const archive = lifecycle === "archive";
  const operationId = archive ? ARCHIVE_CONTEXT_OPERATION_ID : RESTORE_CONTEXT_OPERATION_ID;
  return {
    operation_id: operationId,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "contexts",
    title: archive ? "Archive Context" : "Restore Context",
    description: archive
      ? "Hide a Context from normal active collaboration while retaining its identity, content, and evidence."
      : "Return an archived Context to active collaboration without replacing its retained identity or history.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [operationId],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["context"], expected_revision: "required" },
    input: { version: "1", schema: reasonInputSchema },
    result: { version: "1", schema: contextOnlyResultSchema },
    availability: (context) => contextAvailability(
      backend,
      workspaceId(context),
      context.target!.ref.id,
      archive ? "active" : "archived",
    ),
    handler: (context, input) => handle(() => {
      const expectedRevision = requireExpectedRevision(context);
      const changed = archive
        ? backend.contexts.archiveContext({
            context_id: context.target!.ref.id,
            expected_revision: expectedRevision,
            archived_by_principal_id: context.authority.principal_id,
            reason: input.reason ?? null,
          })
        : backend.contexts.restoreContext({
            context_id: context.target!.ref.id,
            expected_revision: expectedRevision,
            restored_by_principal_id: context.authority.principal_id,
          });
      backend.publishContextChange(archive ? "archived" : "restored", changed);
      return {
        state: "completed" as const,
        result: { context: changed },
        changed_refs: [contextRef(changed)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function setContextParticipantAccessOperation(
  backend: ContextOperationBackend,
): SemanticOperationDefinition<{
  participant_id: string;
  role: string;
  access: ContextParticipantAccess;
}, { context: CanonicalContextRecord; participant: ContextParticipantRecord; changed: boolean }> {
  return {
    operation_id: SET_CONTEXT_PARTICIPANT_ACCESS_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "contexts",
    title: "Set Context participant access",
    description: "Add a participant or change their role and access in a Context. This changes collaboration only, never Scope routing.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [SET_CONTEXT_PARTICIPANT_ACCESS_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["context"], expected_revision: "required" },
    input: { version: "1", schema: setParticipantInputSchema },
    result: { version: "1", schema: participantMutationResultSchema },
    availability: (context) => contextAvailability(
      backend,
      workspaceId(context),
      context.target!.ref.id,
      "active",
    ),
    handler: (context, input) => handle(() => {
      if (!backend.participantExists(workspaceId(context), input.participant_id)) {
        return {
          state: "refused" as const,
          refusal: refusal(
            "context_participant_not_found",
            "The selected participant is not available in this Workspace.",
            false,
            requiredAction("select_participant", "Select a participant", "Select a participant from the current Workspace."),
          ),
        };
      }
      const result = backend.contexts.setParticipantAccess({
        context_id: context.target!.ref.id,
        participant_id: input.participant_id,
        role: input.role,
        access: input.access,
        expected_revision: requireExpectedRevision(context),
        changed_by_principal_id: context.authority.principal_id,
      });
      if (result.changed) {
        backend.publishContextChange("participant_changed", result.context, {
          participant_id: input.participant_id,
          change: "set_access",
        });
      }
      return {
        state: "completed" as const,
        result,
        changed_refs: result.changed
          ? [contextRef(result.context), participantRef(result.context.context_id, input.participant_id)]
          : [],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function removeContextParticipantOperation(
  backend: ContextOperationBackend,
): SemanticOperationDefinition<{ participant_id: string }, {
  context: CanonicalContextRecord;
  participant_id: string;
  removed: boolean;
}> {
  return {
    operation_id: REMOVE_CONTEXT_PARTICIPANT_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "contexts",
    title: "Remove Context participant",
    description: "Remove one participant's Context access without changing Scope routing or deleting retained history.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [REMOVE_CONTEXT_PARTICIPANT_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["context"], expected_revision: "required" },
    input: { version: "1", schema: removeParticipantInputSchema },
    result: { version: "1", schema: participantRemovalResultSchema },
    availability: (context) => contextAvailability(
      backend,
      workspaceId(context),
      context.target!.ref.id,
      "active",
    ),
    handler: (context, input) => handle(() => {
      const result = backend.contexts.removeParticipantAccess({
        context_id: context.target!.ref.id,
        participant_id: input.participant_id,
        expected_revision: requireExpectedRevision(context),
        changed_by_principal_id: context.authority.principal_id,
      });
      if (result.removed) {
        backend.publishContextChange("participant_changed", result.context, {
          participant_id: input.participant_id,
          change: "removed",
        });
      }
      return {
        state: "completed" as const,
        result,
        changed_refs: result.removed
          ? [contextRef(result.context), participantRef(result.context.context_id, input.participant_id)]
          : [],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function emitContextCommunicationOperation(
  backend: ContextOperationBackend,
): SemanticOperationDefinition<{
  event_type: string;
  recipient_participant_id?: string | null;
  content: Record<string, unknown>;
  artefact_version_ids?: string[];
  attachment_ingress_ids?: string[];
  response_expected: boolean;
}, {
  event_ref: OperationResourceRef;
  artefact_version_refs: readonly OperationResourceRef[];
}> {
  return {
    operation_id: EMIT_CONTEXT_COMMUNICATION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "contexts",
    title: "Communicate in Context",
    description: "Emit deliberate direct communication in a Context through the canonical Event path. This never traverses Scope Edges.",
    effects: { mode: "write", reversibility: "irreversible", external: false, secret_access: "none" },
    required_grants: [EMIT_CONTEXT_COMMUNICATION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["context"], expected_revision: "required" },
    input: { version: "2", schema: communicationInputSchema },
    result: { version: "1", schema: communicationResultSchema },
    availability: (context) => contextAvailability(
      backend,
      workspaceId(context),
      context.target!.ref.id,
      "active",
    ),
    handler: (context, input) => handle(async () => {
      const value = contextInWorkspace(backend.contexts, workspaceId(context), context.target!.ref.id);
      if (!value) throw new ContextNotFoundError(context.target!.ref.id);
      requireExpectedRevision(context);
      if (input.recipient_participant_id && !backend.contexts.isParticipant(value.context_id, input.recipient_participant_id)) {
        return {
          state: "refused" as const,
          refusal: refusal(
            "context_recipient_not_found",
            "The selected recipient does not participate in this Context.",
            false,
            requiredAction("select_participant", "Select a participant", "Select a current Context participant or address all participants."),
          ),
        };
      }
      const outcome = await backend.emitDirectContextCommunication({
        workspace_id: value.workspace_id,
        context_id: value.context_id,
        principal_id: context.authority.principal_id,
        event_type: input.event_type,
        recipient_participant_id: input.recipient_participant_id ?? null,
        content: input.content,
        artefact_version_ids: input.artefact_version_ids ?? [],
        attachment_ingress_ids: input.attachment_ingress_ids ?? [],
        response_expected: input.response_expected,
        invocation_id: context.invocation_id,
        provenance: context.provenance,
      });
      if (!outcome.emitted) {
        return {
          state: "refused" as const,
          refusal: refusal(
            outcome.code,
            outcome.message,
            outcome.retryable,
            requiredAction("inspect_context", "Inspect Context", "Inspect participant access and current Context state."),
            outcome.details ?? {},
          ),
        };
      }
      return {
        state: "completed" as const,
        result: {
          event_ref: outcome.event_ref,
          artefact_version_refs: outcome.artefact_version_refs,
        },
        changed_refs: [outcome.event_ref, ...outcome.artefact_version_refs],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function destroyContextPermanentlyOperation(
  backend: ContextOperationBackend,
): SemanticOperationDefinition<{ reason: string }, { context: CanonicalContextRecord; events_deleted: number }> {
  return {
    operation_id: DESTROY_CONTEXT_PERMANENTLY_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "contexts",
    title: "Permanently destroy Context content",
    description: "Irreversibly remove unreferenced Context content while retaining a redacted identity tombstone for audit references.",
    effects: { mode: "write", reversibility: "irreversible", external: false, secret_access: "none" },
    required_grants: [DESTROY_CONTEXT_PERMANENTLY_OPERATION_ID],
    interaction_constraints: {
      allowed_modes: ["interactive"],
      confirmation: {
        required: true,
        prompt_id: "context.destroy_permanently",
        title: "Permanently destroy Context content",
        description: "This permanently removes the Context's content and cannot be undone.",
      },
    },
    target: { resource_kinds: ["context"], expected_revision: "required" },
    input: { version: "1", schema: destroyInputSchema },
    result: { version: "1", schema: destructionResultSchema },
    availability: (context) => {
      const base = contextAvailability(
        backend,
        workspaceId(context),
        context.target!.ref.id,
      );
      if (!base.available) return base;
      const value = contextInWorkspace(backend.contexts, workspaceId(context), context.target!.ref.id)!;
      if (value.lifecycle_state === "tombstoned") return { available: false as const, refusal: lifecycleRefusal("tombstoned") };
      // The invocation ledger records the attempt before availability is
      // evaluated. Retained evidence is therefore decided only by the atomic
      // destruction handler, which can exclude that exact current invocation
      // and re-check every other canonical reference without a race.
      return { available: true as const };
    },
    handler: (context, input) => handle(async () => {
      const outcome = await backend.destroyContextPermanently({
        workspace_id: workspaceId(context),
        context_id: context.target!.ref.id,
        expected_revision: requireExpectedRevision(context),
        principal_id: context.authority.principal_id,
        reason: input.reason,
        invocation_id: context.invocation_id,
      });
      if (!outcome.destroyed) {
        return { state: "refused" as const, refusal: retainedReferencesRefusal(outcome.retained_references) };
      }
      backend.publishContextChange("tombstoned", outcome.context, {
        events_deleted: outcome.events_deleted,
      });
      return {
        state: "completed" as const,
        result: { context: outcome.context, events_deleted: outcome.events_deleted },
        changed_refs: [contextRef(outcome.context)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

function retainedReferencesRefusal(references: readonly ContextRetainedReference[]): OperationRefusal {
  return refusal(
    "context_retained_references_exist",
    "This Context is retained by canonical evidence and cannot be permanently destroyed.",
    false,
    requiredAction("inspect_context", "Inspect retained evidence", "Inspect the Context to see the records that require its evidence."),
    { retained_references: references },
  );
}

export function contextOperationDefinitions(
  backend: ContextOperationBackend,
): SemanticOperationDefinition<any, any>[] {
  return [
    listContextsOperation(backend),
    getContextOperation(backend),
    inspectContextOperation(backend),
    createContextOperation(backend),
    contextLifecycleOperation(backend, "archive"),
    contextLifecycleOperation(backend, "restore"),
    setContextParticipantAccessOperation(backend),
    removeContextParticipantOperation(backend),
    emitContextCommunicationOperation(backend),
    destroyContextPermanentlyOperation(backend),
  ];
}

export function registerContextOperations<T extends SemanticOperationRegistry>(
  registry: T,
  backend: ContextOperationBackend,
): T {
  for (const definition of contextOperationDefinitions(backend)) registry.register(definition);
  return registry;
}
