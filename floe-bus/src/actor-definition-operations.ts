import {
  ActorDefinitionConflictError,
  ActorDefinitionDraftConflictError,
  ActorDefinitionImmutableError,
  ActorDefinitionRevisionNotFoundError,
  ActorDefinitionStore,
  ActorDefinitionValidationError,
  ActorNotFoundError,
  type ActorDefinitionContent,
  type ActorDefinitionHeadChange,
  type ActorDefinitionRevision,
  type ActorRecord,
} from "./actor-definitions.js";
import {
  refusal,
  requireWorkspaceAuthorityId,
  requiredAction,
  type JsonSchema,
  type OperationEvaluationContext,
  type OperationExecutionContext,
  type OperationRefusal,
  type SemanticOperationDefinition,
  type SemanticOperationRegistry,
} from "./operations.js";

function authorityWorkspaceId(context: OperationEvaluationContext): string {
  return requireWorkspaceAuthorityId(context.authority);
}

/**
 * Canonical Actor-definition operations. Clients discover these definitions;
 * they do not copy Actor lifecycle validation into app, Bridge, CLI, or MCP code.
 */

export const LIST_ACTORS_OPERATION_ID = "actor.list";
export const INSPECT_ACTOR_OPERATION_ID = "actor.inspect";
export const GET_ACTOR_DEFINITION_OPERATION_ID = "actor.definition.get";
export const CREATE_ACTOR_OPERATION_ID = "actor.create";
export const CREATE_ACTOR_DEFINITION_DRAFT_OPERATION_ID = "actor.definition.draft.create";
export const REPLACE_ACTOR_DEFINITION_DRAFT_OPERATION_ID = "actor.definition.draft.replace";
export const PUBLISH_ACTOR_DEFINITION_OPERATION_ID = "actor.definition.publish";
export const ROLLBACK_ACTOR_DEFINITION_OPERATION_ID = "actor.definition.rollback";
export const RETIRE_ACTOR_OPERATION_ID = "actor.retire";
export const REACTIVATE_ACTOR_OPERATION_ID = "actor.reactivate";

export const NO_ACTOR_DEFINITION_REVISION = "none";

export type ActorListResult = Readonly<{
  actors: readonly Readonly<{
    actor: ActorRecord;
    current_definition: ActorDefinitionRevision | null;
  }>[];
}>;

export type ActorInspection = Readonly<{
  actor: ActorRecord;
  current_definition: ActorDefinitionRevision | null;
  history_complete: boolean;
  revisions: readonly ActorDefinitionRevision[];
  head_changes: readonly ActorDefinitionHeadChange[];
}>;

const nonEmptyString: JsonSchema = { type: "string", minLength: 1 };
const nullableString: JsonSchema = { oneOf: [nonEmptyString, { type: "null" }] };
const emptyInput: JsonSchema = { type: "object", additionalProperties: false };
const resourceRefSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id", "revision"],
  properties: { kind: nonEmptyString, id: nonEmptyString, revision: nullableString },
};
const responsibilitySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["responsibility_id", "title", "description"],
  properties: {
    responsibility_id: nonEmptyString,
    title: nonEmptyString,
    description: nonEmptyString,
  },
};
const escalationRuleSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rule_id", "when", "action"],
  properties: {
    rule_id: nonEmptyString,
    when: nonEmptyString,
    action: { enum: ["decline", "delegate", "escalate", "signal_unowned"] },
    target_actor_id: nullableString,
  },
};
export const ACTOR_DEFINITION_CONTENT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "label",
    "charter",
    "responsibilities",
    "instructions",
    "knowledge_refs",
    "capability_grant_ids",
    "policy_refs",
    "escalation_rules",
  ],
  properties: {
    label: nonEmptyString,
    charter: nonEmptyString,
    responsibilities: { type: "array", items: responsibilitySchema },
    instructions: nonEmptyString,
    knowledge_refs: { type: "array", items: resourceRefSchema },
    capability_grant_ids: { type: "array", items: nonEmptyString, uniqueItems: true,
      description: "Grant IDs issued to this Actor in this Workspace. Start a new Actor with an empty list, discover permission delegation, then publish its own grants. Never copy another Actor's grant IDs." },
    policy_refs: {
      type: "object",
      additionalProperties: false,
      required: ["budget", "trust", "approval"],
      properties: {
        budget: { oneOf: [resourceRefSchema, { type: "null" }] },
        trust: { oneOf: [resourceRefSchema, { type: "null" }] },
        approval: { oneOf: [resourceRefSchema, { type: "null" }] },
      },
    },
    escalation_rules: { type: "array", items: escalationRuleSchema },
  },
};
const actorSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "actor_id", "workspace_id", "status", "current_definition_revision_id",
    "created_at", "updated_at", "retired_at",
  ],
  properties: {
    actor_id: nonEmptyString,
    workspace_id: nonEmptyString,
    status: { enum: ["active", "retired"] },
    current_definition_revision_id: nullableString,
    created_at: nonEmptyString,
    updated_at: nonEmptyString,
    retired_at: nullableString,
  },
};
const actorDefinitionRevisionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "actor_definition_revision_id", "actor_id", "workspace_id", "revision_number",
    "based_on_revision_id", "semantic_digest", "content", "created_by_principal_id",
    "created_at", "published_at", "withdrawn_at",
  ],
  properties: {
    actor_definition_revision_id: nonEmptyString,
    actor_id: nonEmptyString,
    workspace_id: nonEmptyString,
    revision_number: { type: "integer", minimum: 1 },
    based_on_revision_id: nullableString,
    semantic_digest: nonEmptyString,
    content: ACTOR_DEFINITION_CONTENT_SCHEMA,
    created_by_principal_id: nonEmptyString,
    created_at: nonEmptyString,
    published_at: nullableString,
    withdrawn_at: nullableString,
  },
};
const actorHeadChangeSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "head_change_id", "actor_id", "workspace_id", "from_revision_id", "to_revision_id",
    "reason", "changed_by_principal_id", "changed_at",
  ],
  properties: {
    head_change_id: nonEmptyString,
    actor_id: nonEmptyString,
    workspace_id: nonEmptyString,
    from_revision_id: nullableString,
    to_revision_id: nonEmptyString,
    reason: { enum: ["publish", "rollback"] },
    changed_by_principal_id: nonEmptyString,
    changed_at: nonEmptyString,
  },
};
const actorWithDefinitionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actor", "current_definition"],
  properties: {
    actor: actorSchema,
    current_definition: { oneOf: [actorDefinitionRevisionSchema, { type: "null" }] },
  },
};
const actorListResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actors"],
  properties: { actors: { type: "array", items: actorWithDefinitionSchema } },
};
const actorInspectionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actor", "current_definition", "history_complete", "revisions", "head_changes"],
  properties: {
    actor: actorSchema,
    current_definition: { oneOf: [actorDefinitionRevisionSchema, { type: "null" }] },
    history_complete: { type: "boolean" },
    revisions: { type: "array", items: actorDefinitionRevisionSchema },
    head_changes: { type: "array", items: actorHeadChangeSchema },
  },
};
const actorAndDraftSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actor", "draft"],
  properties: { actor: actorSchema, draft: actorDefinitionRevisionSchema },
};
const actorAndRevisionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actor", "revision"],
  properties: { actor: actorSchema, revision: actorDefinitionRevisionSchema },
};
const actorOnlySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actor"],
  properties: { actor: actorSchema },
};
const listInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { include_retired: { type: "boolean" } },
};
const inspectInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { include_history: { type: "boolean" } },
};
const createActorInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["definition"],
  properties: { actor_id: nonEmptyString, definition: ACTOR_DEFINITION_CONTENT_SCHEMA },
};
const createDraftInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["definition"],
  properties: {
    based_on_revision_id: nullableString,
    definition: ACTOR_DEFINITION_CONTENT_SCHEMA,
  },
};
const replaceDraftInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["definition"],
  properties: { definition: ACTOR_DEFINITION_CONTENT_SCHEMA },
};
const publishInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expected_current_definition_revision_id"],
  properties: { expected_current_definition_revision_id: nullableString },
};
const rollbackInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["to_published_revision_id"],
  properties: { to_published_revision_id: nonEmptyString },
};

function actorRef(actor: ActorRecord) {
  return {
    kind: "actor",
    id: actor.actor_id,
    revision: actor.current_definition_revision_id ?? NO_ACTOR_DEFINITION_REVISION,
  };
}

function definitionRef(revision: ActorDefinitionRevision) {
  return {
    kind: "actor_definition_revision",
    id: revision.actor_definition_revision_id,
    revision: revision.semantic_digest,
  };
}

function auditRef(context: OperationExecutionContext) {
  return { kind: "operation_invocation", id: context.invocation_id, revision: null };
}

function expectedHead(value: string | null): string | null {
  return value === NO_ACTOR_DEFINITION_REVISION ? null : value;
}

function actorInWorkspace(
  store: ActorDefinitionStore,
  workspaceId: string,
  actorId: string,
): ActorRecord | null {
  const actor = store.getActor(actorId);
  return actor?.workspace_id === workspaceId ? actor : null;
}

function revisionInWorkspace(
  store: ActorDefinitionStore,
  workspaceId: string,
  revisionId: string,
): ActorDefinitionRevision | null {
  const revision = store.getRevision(revisionId);
  return revision?.workspace_id === workspaceId ? revision : null;
}

function actorAvailability(
  store: ActorDefinitionStore,
  context: OperationEvaluationContext,
  requiredStatus?: ActorRecord["status"],
) {
  const target = context.target?.ref;
  const actor = target?.kind === "actor"
    ? actorInWorkspace(store, authorityWorkspaceId(context), target.id)
    : null;
  if (!actor) {
    return {
      available: false as const,
      refusal: refusal(
        "actor_not_found",
        "This Actor is not available in the current Workspace.",
        false,
        requiredAction("refresh_actors", "Refresh Actors", "Refresh this Workspace and select an available Actor."),
      ),
    };
  }
  if (requiredStatus && actor.status !== requiredStatus) {
    return {
      available: false as const,
      refusal: refusal(
        requiredStatus === "active" ? "actor_already_retired" : "actor_already_active",
        requiredStatus === "active" ? "This Actor is already retired." : "This Actor is already active.",
        false,
        requiredAction("inspect_actor", "Inspect Actor", "Inspect the Actor's retained definition and current lifecycle state."),
      ),
    };
  }
  return { available: true as const };
}

function revisionAvailability(store: ActorDefinitionStore, context: OperationEvaluationContext) {
  const target = context.target?.ref;
  const revision = target?.kind === "actor_definition_revision"
    ? revisionInWorkspace(store, authorityWorkspaceId(context), target.id)
    : null;
  return revision
    ? { available: true as const }
    : {
        available: false as const,
        refusal: refusal(
          "actor_definition_not_found",
          "This Actor definition revision is not available in the current Workspace.",
          false,
          requiredAction("inspect_actor", "Inspect Actor", "Inspect the Actor and select one retained definition revision."),
        ),
      };
}

function actorOperationRefusal(error: unknown): OperationRefusal {
  if (error instanceof ActorDefinitionConflictError || error instanceof ActorDefinitionDraftConflictError) {
    return refusal(
      "actor_definition_revision_conflict",
      "The Actor definition changed before this operation completed.",
      true,
      requiredAction("refresh_actor", "Review the latest Actor", "Refresh the Actor and retry against its exact current revision."),
    );
  }
  if (error instanceof ActorDefinitionImmutableError) {
    return refusal(
      "actor_definition_immutable",
      "Published or withdrawn Actor definitions cannot be replaced.",
      false,
      requiredAction("create_actor_definition_draft", "Create a new draft", "Create a new definition draft based on a retained revision."),
    );
  }
  if (error instanceof ActorNotFoundError || error instanceof ActorDefinitionRevisionNotFoundError) {
    return refusal(
      "actor_not_found",
      "The requested Actor or definition revision was not found in this Workspace.",
      false,
      requiredAction("refresh_actors", "Refresh Actors", "Refresh retained Actors and choose an available exact revision."),
    );
  }
  if (error instanceof ActorDefinitionValidationError) {
    return refusal(
      "actor_definition_invalid",
      error.message,
      false,
      requiredAction("correct_actor_definition", "Correct the Actor definition", "Use the exact discovered Actor definition contract."),
    );
  }
  return refusal(
    "actor_operation_failed",
    "Floe could not prove that the Actor operation completed.",
    false,
    requiredAction("inspect_actor", "Inspect Actor", "Inspect retained Actor state before deciding whether a retry is safe."),
  );
}

async function handle<TResult>(work: () => TResult | Promise<TResult>) {
  try {
    return await work();
  } catch (error) {
    return { state: "refused" as const, refusal: actorOperationRefusal(error) };
  }
}

export function listActorsOperation(
  store: ActorDefinitionStore,
): SemanticOperationDefinition<{ include_retired?: boolean }, ActorListResult> {
  return {
    operation_id: LIST_ACTORS_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "actors",
    title: "List Actors",
    description: "List Actor identities in this Workspace with their current published definitions.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [LIST_ACTORS_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    input: { version: "1", schema: listInputSchema },
    result: { version: "1", schema: actorListResultSchema },
    handler: (context, input) => handle(() => ({
      state: "completed" as const,
      result: {
        actors: store.listActors(authorityWorkspaceId(context), {
          include_retired: input.include_retired === true,
        }).map((actor) => ({ actor, current_definition: store.getCurrentDefinition(actor.actor_id) })),
      },
      audit_ref: auditRef(context),
    })),
  };
}

export function inspectActorOperation(
  store: ActorDefinitionStore,
): SemanticOperationDefinition<{ include_history?: boolean }, ActorInspection> {
  return {
    operation_id: INSPECT_ACTOR_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "actors",
    title: "Inspect Actor",
    description: "Inspect an Actor's stable identity, current definition, drafts, and optionally retained definition history.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [INSPECT_ACTOR_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["actor"], expected_revision: "not_applicable" },
    input: { version: "1", schema: inspectInputSchema },
    result: { version: "1", schema: actorInspectionSchema },
    availability: (context) => actorAvailability(store, context),
    handler: (context, input) => handle(() => {
      const actor = actorInWorkspace(store, authorityWorkspaceId(context), context.target!.ref.id);
      if (!actor) throw new ActorNotFoundError(context.target!.ref.id);
      const all = store.listRevisions(actor.actor_id);
      const includeHistory = input.include_history === true;
      return {
        state: "completed" as const,
        result: {
          actor,
          current_definition: store.getCurrentDefinition(actor.actor_id),
          history_complete: includeHistory,
          revisions: includeHistory
            ? all
            : all.filter((revision) =>
                revision.actor_definition_revision_id === actor.current_definition_revision_id
                || (!revision.published_at && !revision.withdrawn_at)),
          head_changes: includeHistory ? store.listHeadChanges(actor.actor_id) : [],
        },
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function getActorDefinitionOperation(
  store: ActorDefinitionStore,
): SemanticOperationDefinition<Record<string, never>, { actor: ActorRecord; revision: ActorDefinitionRevision }> {
  return {
    operation_id: GET_ACTOR_DEFINITION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "actors",
    title: "Get Actor definition",
    description: "Get one exact retained ActorDefinitionRevision and its stable Actor identity.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [GET_ACTOR_DEFINITION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["actor_definition_revision"], expected_revision: "not_applicable" },
    input: { version: "1", schema: emptyInput },
    result: { version: "1", schema: actorAndRevisionSchema },
    availability: (context) => revisionAvailability(store, context),
    handler: (context) => handle(() => {
      const revision = revisionInWorkspace(store, authorityWorkspaceId(context), context.target!.ref.id);
      if (!revision) throw new ActorDefinitionRevisionNotFoundError(context.target!.ref.id);
      return {
        state: "completed" as const,
        result: { actor: store.requireActor(revision.actor_id), revision },
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function createActorOperation(
  store: ActorDefinitionStore,
): SemanticOperationDefinition<{ actor_id?: string; definition: ActorDefinitionContent }, { actor: ActorRecord; draft: ActorDefinitionRevision }> {
  return {
    operation_id: CREATE_ACTOR_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "actors",
    title: "Create Actor",
    description: "Create a stable Actor identity and its first unpublished definition draft in this Workspace.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [CREATE_ACTOR_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    input: { version: "1", schema: createActorInputSchema },
    result: { version: "1", schema: actorAndDraftSchema },
    handler: (context, input) => handle(() => {
      const created = store.createActor({
        workspace_id: authorityWorkspaceId(context),
        created_by_principal_id: context.authority.principal_id,
        definition: input.definition,
        ...(input.actor_id ? { actor_id: input.actor_id } : {}),
      });
      return {
        state: "completed" as const,
        result: created,
        changed_refs: [actorRef(created.actor), definitionRef(created.draft)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function createActorDefinitionDraftOperation(
  store: ActorDefinitionStore,
): SemanticOperationDefinition<{
  based_on_revision_id?: string | null;
  definition: ActorDefinitionContent;
}, { actor: ActorRecord; revision: ActorDefinitionRevision }> {
  return {
    operation_id: CREATE_ACTOR_DEFINITION_DRAFT_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "actors",
    title: "Create Actor definition draft",
    description: "Create a new definition draft from the Actor's current or an explicitly selected retained revision.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [CREATE_ACTOR_DEFINITION_DRAFT_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["actor"], expected_revision: "required" },
    input: { version: "1", schema: createDraftInputSchema },
    result: { version: "1", schema: actorAndRevisionSchema },
    availability: (context) => actorAvailability(store, context, "active"),
    handler: (context, input) => handle(() => {
      const actor = store.requireActor(context.target!.ref.id);
      const expected = expectedHead(context.expected_resource_revision);
      if (actor.current_definition_revision_id !== expected) {
        throw new ActorDefinitionConflictError(
          actor.actor_id,
          expected,
          actor.current_definition_revision_id,
        );
      }
      const revision = store.createDraft({
        actor_id: actor.actor_id,
        created_by_principal_id: context.authority.principal_id,
        definition: input.definition,
        ...(input.based_on_revision_id !== undefined
          ? { based_on_revision_id: input.based_on_revision_id }
          : {}),
      });
      return {
        state: "completed" as const,
        result: { actor: store.requireActor(actor.actor_id), revision },
        changed_refs: [actorRef(actor), definitionRef(revision)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function replaceActorDefinitionDraftOperation(
  store: ActorDefinitionStore,
): SemanticOperationDefinition<{ definition: ActorDefinitionContent }, { actor: ActorRecord; revision: ActorDefinitionRevision }> {
  return {
    operation_id: REPLACE_ACTOR_DEFINITION_DRAFT_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "actors",
    title: "Replace Actor definition draft",
    description: "Replace only an unpublished Actor definition draft using its exact semantic digest.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [REPLACE_ACTOR_DEFINITION_DRAFT_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["actor_definition_revision"], expected_revision: "required" },
    input: { version: "1", schema: replaceDraftInputSchema },
    result: { version: "1", schema: actorAndRevisionSchema },
    availability: (context) => revisionAvailability(store, context),
    handler: (context, input) => handle(() => {
      const revision = store.replaceDraft({
        actor_definition_revision_id: context.target!.ref.id,
        expected_digest: context.expected_resource_revision!,
        definition: input.definition,
      });
      return {
        state: "completed" as const,
        result: { actor: store.requireActor(revision.actor_id), revision },
        changed_refs: [definitionRef(revision)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function publishActorDefinitionOperation(
  store: ActorDefinitionStore,
): SemanticOperationDefinition<{
  expected_current_definition_revision_id: string | null;
}, { actor: ActorRecord; revision: ActorDefinitionRevision }> {
  return {
    operation_id: PUBLISH_ACTOR_DEFINITION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "actors",
    title: "Publish Actor definition",
    description: "Make one draft the Actor's current definition while retaining every published revision.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [PUBLISH_ACTOR_DEFINITION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["actor_definition_revision"], expected_revision: "required" },
    input: { version: "1", schema: publishInputSchema },
    result: { version: "1", schema: actorAndRevisionSchema },
    availability: (context) => revisionAvailability(store, context),
    handler: (context, input) => handle(() => {
      const current = store.requireRevision(context.target!.ref.id);
      if (current.semantic_digest !== context.expected_resource_revision) {
        throw new ActorDefinitionDraftConflictError(
          current.actor_definition_revision_id,
          context.expected_resource_revision!,
          current.semantic_digest,
        );
      }
      const revision = store.publishDraft({
        actor_definition_revision_id: context.target!.ref.id,
        expected_current_revision_id: input.expected_current_definition_revision_id,
        changed_by_principal_id: context.authority.principal_id,
      });
      const actor = store.requireActor(revision.actor_id);
      return {
        state: "completed" as const,
        result: { actor, revision },
        changed_refs: [actorRef(actor), definitionRef(revision)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function rollbackActorDefinitionOperation(
  store: ActorDefinitionStore,
): SemanticOperationDefinition<{ to_published_revision_id: string }, { actor: ActorRecord; revision: ActorDefinitionRevision }> {
  return {
    operation_id: ROLLBACK_ACTOR_DEFINITION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "actors",
    title: "Roll back Actor definition",
    description: "Move the Actor's current definition to an exact retained published revision without rewriting history.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [ROLLBACK_ACTOR_DEFINITION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["actor"], expected_revision: "required" },
    input: { version: "1", schema: rollbackInputSchema },
    result: { version: "1", schema: actorAndRevisionSchema },
    availability: (context) => actorAvailability(store, context, "active"),
    handler: (context, input) => handle(() => {
      const actor = store.requireActor(context.target!.ref.id);
      const revision = store.rollback({
        actor_id: actor.actor_id,
        to_published_revision_id: input.to_published_revision_id,
        expected_current_revision_id: context.expected_resource_revision!,
        changed_by_principal_id: context.authority.principal_id,
      });
      const changed = store.requireActor(actor.actor_id);
      return {
        state: "completed" as const,
        result: { actor: changed, revision },
        changed_refs: [actorRef(changed), definitionRef(revision)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

function actorStatusOperation(
  store: ActorDefinitionStore,
  status: "active" | "retired",
): SemanticOperationDefinition<Record<string, never>, { actor: ActorRecord }> {
  const reactivating = status === "active";
  const operationId = reactivating ? REACTIVATE_ACTOR_OPERATION_ID : RETIRE_ACTOR_OPERATION_ID;
  return {
    operation_id: operationId,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "actors",
    title: reactivating ? "Reactivate Actor" : "Retire Actor",
    description: reactivating
      ? "Return a retired Actor to active use without deleting or replacing its retained definitions."
      : "Remove an Actor from active use while retaining its identity, definitions, and history.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [operationId],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["actor"], expected_revision: "required" },
    input: { version: "1", schema: emptyInput },
    result: { version: "1", schema: actorOnlySchema },
    availability: (context) => actorAvailability(store, context, reactivating ? "retired" : "active"),
    handler: (context) => handle(() => {
      const actor = store.setActorStatus({
        actor_id: context.target!.ref.id,
        status,
        expected_current_definition_revision_id: expectedHead(context.expected_resource_revision),
      });
      return {
        state: "completed" as const,
        result: { actor },
        changed_refs: [actorRef(actor)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function actorDefinitionOperationDefinitions(
  store: ActorDefinitionStore,
): SemanticOperationDefinition<any, any>[] {
  return [
    listActorsOperation(store),
    inspectActorOperation(store),
    getActorDefinitionOperation(store),
    createActorOperation(store),
    createActorDefinitionDraftOperation(store),
    replaceActorDefinitionDraftOperation(store),
    publishActorDefinitionOperation(store),
    rollbackActorDefinitionOperation(store),
    actorStatusOperation(store, "retired"),
    actorStatusOperation(store, "active"),
  ];
}

export function registerActorDefinitionOperations<T extends SemanticOperationRegistry>(
  registry: T,
  store: ActorDefinitionStore,
): T {
  for (const definition of actorDefinitionOperationDefinitions(store)) registry.register(definition);
  return registry;
}
