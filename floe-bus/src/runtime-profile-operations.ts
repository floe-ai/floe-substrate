import {
  ActorRuntimeBindingConflictError,
  RuntimeProfileConflictError,
  RuntimeProfileImmutableError,
  RuntimeProfileNotFoundError,
  RuntimeProfileRevisionNotFoundError,
  RuntimeProfileStore,
  RuntimeProfileValidationError,
  type ActorRuntimeBindingRecord,
  type RuntimeProfileContent,
  type RuntimeProfileHeadChange,
  type RuntimeProfileRecord,
  type RuntimeProfileRevision,
} from "./runtime-profiles.js";
import { NO_ACTOR_DEFINITION_REVISION } from "./actor-definition-operations.js";
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

/** Runtime selection stays separate from provider-neutral Actor meaning. */

export const LIST_RUNTIME_PROFILES_OPERATION_ID = "runtime-profile.list";
export const INSPECT_RUNTIME_PROFILE_OPERATION_ID = "runtime-profile.inspect";
export const GET_RUNTIME_PROFILE_REVISION_OPERATION_ID = "runtime-profile.revision.get";
export const CREATE_RUNTIME_PROFILE_OPERATION_ID = "runtime-profile.create";
export const CREATE_RUNTIME_PROFILE_DRAFT_OPERATION_ID = "runtime-profile.draft.create";
export const REPLACE_RUNTIME_PROFILE_DRAFT_OPERATION_ID = "runtime-profile.draft.replace";
export const PUBLISH_RUNTIME_PROFILE_OPERATION_ID = "runtime-profile.publish";
export const ROLLBACK_RUNTIME_PROFILE_OPERATION_ID = "runtime-profile.rollback";
export const RETIRE_RUNTIME_PROFILE_OPERATION_ID = "runtime-profile.retire";
export const REACTIVATE_RUNTIME_PROFILE_OPERATION_ID = "runtime-profile.reactivate";
export const INSPECT_ACTOR_RUNTIME_BINDING_OPERATION_ID = "actor.runtime-binding.inspect";
export const GET_ACTOR_RUNTIME_BINDING_OPERATION_ID = "actor.runtime-binding.get";
export const CREATE_ACTOR_RUNTIME_BINDING_OPERATION_ID = "actor.runtime-binding.create";
export const REPLACE_ACTOR_RUNTIME_BINDING_OPERATION_ID = "actor.runtime-binding.replace";

export const NO_RUNTIME_PROFILE_REVISION = "none";

export type RuntimeProfileListResult = Readonly<{
  profiles: readonly Readonly<{
    profile: RuntimeProfileRecord;
    current_revision: RuntimeProfileRevision | null;
  }>[];
}>;

export type RuntimeProfileInspection = Readonly<{
  profile: RuntimeProfileRecord;
  current_revision: RuntimeProfileRevision | null;
  history_complete: boolean;
  revisions: readonly RuntimeProfileRevision[];
  head_changes: readonly RuntimeProfileHeadChange[];
}>;

export type ActorRuntimeBindingInspection = Readonly<{
  actor_id: string;
  current_binding: ActorRuntimeBindingRecord | null;
  history_complete: boolean;
  bindings: readonly ActorRuntimeBindingRecord[];
}>;

type ActorRow = Readonly<{
  actor_id: string;
  workspace_id: string;
  status: string;
  current_definition_revision_id: string | null;
}>;

const nonEmptyString: JsonSchema = { type: "string", minLength: 1 };
const nullableString: JsonSchema = { oneOf: [nonEmptyString, { type: "null" }] };
const emptyInput: JsonSchema = { type: "object", additionalProperties: false };
const stringArray: JsonSchema = { type: "array", items: nonEmptyString, uniqueItems: true };

export const RUNTIME_PROFILE_CONTENT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "label", "backing_kind", "adapter_id", "configuration", "secret_ref_ids",
    "required_capability_ids", "checkpoint_policy", "resource_policy",
  ],
  properties: {
    label: nonEmptyString,
    backing_kind: { enum: ["human", "model", "service", "team"] },
    adapter_id: nonEmptyString,
    configuration: { type: "object" },
    secret_ref_ids: stringArray,
    required_capability_ids: stringArray,
    checkpoint_policy: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "schema_ref"],
      properties: {
        mode: { enum: ["none", "provider_neutral", "required"] },
        schema_ref: nullableString,
      },
    },
    resource_policy: { type: "object" },
  },
};
const runtimeProfileOwnerSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id"],
  properties: {
    kind: { enum: ["workspace", "host", "deployment"] },
    id: nonEmptyString,
  },
};
const runtimeProfileSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "runtime_profile_id", "owner", "current_revision_id", "status",
    "created_at", "updated_at", "retired_at",
  ],
  properties: {
    runtime_profile_id: nonEmptyString,
    owner: runtimeProfileOwnerSchema,
    current_revision_id: nullableString,
    status: { enum: ["active", "retired"] },
    created_at: nonEmptyString,
    updated_at: nonEmptyString,
    retired_at: nullableString,
  },
};
const runtimeProfileRevisionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "runtime_profile_revision_id", "runtime_profile_id", "revision_number",
    "based_on_revision_id", "semantic_digest", "content", "created_by_principal_id",
    "created_at", "published_at", "withdrawn_at",
  ],
  properties: {
    runtime_profile_revision_id: nonEmptyString,
    runtime_profile_id: nonEmptyString,
    revision_number: { type: "integer", minimum: 1 },
    based_on_revision_id: nullableString,
    semantic_digest: nonEmptyString,
    content: RUNTIME_PROFILE_CONTENT_SCHEMA,
    created_by_principal_id: nonEmptyString,
    created_at: nonEmptyString,
    published_at: nullableString,
    withdrawn_at: nullableString,
  },
};
const runtimeProfileHeadChangeSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "head_change_id", "runtime_profile_id", "from_revision_id", "to_revision_id",
    "reason", "changed_by_principal_id", "changed_at",
  ],
  properties: {
    head_change_id: nonEmptyString,
    runtime_profile_id: nonEmptyString,
    from_revision_id: nullableString,
    to_revision_id: nonEmptyString,
    reason: { enum: ["publish", "rollback"] },
    changed_by_principal_id: nonEmptyString,
    changed_at: nonEmptyString,
  },
};
const actorRuntimeBindingSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "actor_runtime_binding_id", "actor_id", "workspace_id", "runtime_profile_id",
    "runtime_profile_revision_id", "endpoint_id", "status", "unresolved_reasons",
    "created_by_principal_id", "created_at", "superseded_at",
  ],
  properties: {
    actor_runtime_binding_id: nonEmptyString,
    actor_id: nonEmptyString,
    workspace_id: nonEmptyString,
    runtime_profile_id: nonEmptyString,
    runtime_profile_revision_id: nonEmptyString,
    endpoint_id: nullableString,
    status: { enum: ["resolved", "unresolved", "disabled"] },
    unresolved_reasons: stringArray,
    created_by_principal_id: nonEmptyString,
    created_at: nonEmptyString,
    superseded_at: nullableString,
  },
};
const profileWithCurrentSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["profile", "current_revision"],
  properties: {
    profile: runtimeProfileSchema,
    current_revision: { oneOf: [runtimeProfileRevisionSchema, { type: "null" }] },
  },
};
const profileListResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["profiles"],
  properties: { profiles: { type: "array", items: profileWithCurrentSchema } },
};
const profileInspectionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["profile", "current_revision", "history_complete", "revisions", "head_changes"],
  properties: {
    profile: runtimeProfileSchema,
    current_revision: { oneOf: [runtimeProfileRevisionSchema, { type: "null" }] },
    history_complete: { type: "boolean" },
    revisions: { type: "array", items: runtimeProfileRevisionSchema },
    head_changes: { type: "array", items: runtimeProfileHeadChangeSchema },
  },
};
const profileAndDraftSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["profile", "draft"],
  properties: { profile: runtimeProfileSchema, draft: runtimeProfileRevisionSchema },
};
const profileAndRevisionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["profile", "revision"],
  properties: { profile: runtimeProfileSchema, revision: runtimeProfileRevisionSchema },
};
const profileOnlySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["profile"],
  properties: { profile: runtimeProfileSchema },
};
const bindingOnlySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["binding"],
  properties: { binding: actorRuntimeBindingSchema },
};
const bindingInspectionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actor_id", "current_binding", "history_complete", "bindings"],
  properties: {
    actor_id: nonEmptyString,
    current_binding: { oneOf: [actorRuntimeBindingSchema, { type: "null" }] },
    history_complete: { type: "boolean" },
    bindings: { type: "array", items: actorRuntimeBindingSchema },
  },
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
const createProfileInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["content"],
  properties: { runtime_profile_id: nonEmptyString, content: RUNTIME_PROFILE_CONTENT_SCHEMA },
};
const createDraftInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["content"],
  properties: { based_on_revision_id: nullableString, content: RUNTIME_PROFILE_CONTENT_SCHEMA },
};
const replaceDraftInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["content"],
  properties: { content: RUNTIME_PROFILE_CONTENT_SCHEMA },
};
const publishInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expected_current_revision_id"],
  properties: { expected_current_revision_id: nullableString },
};
const rollbackInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["to_published_revision_id"],
  properties: { to_published_revision_id: nonEmptyString },
};
const bindingInputProperties = {
  runtime_profile_revision_id: nonEmptyString,
  endpoint_id: nullableString,
  status: { enum: ["resolved", "unresolved", "disabled"] },
  unresolved_reasons: stringArray,
};
const bindingInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["runtime_profile_revision_id", "status"],
  properties: bindingInputProperties,
};

function profileRef(profile: RuntimeProfileRecord) {
  return {
    kind: "runtime_profile",
    id: profile.runtime_profile_id,
    revision: profile.current_revision_id ?? NO_RUNTIME_PROFILE_REVISION,
  };
}

function profileRevisionRef(revision: RuntimeProfileRevision) {
  return {
    kind: "runtime_profile_revision",
    id: revision.runtime_profile_revision_id,
    revision: revision.semantic_digest,
  };
}

function bindingRef(binding: ActorRuntimeBindingRecord) {
  return {
    kind: "actor_runtime_binding",
    id: binding.actor_runtime_binding_id,
    revision: binding.actor_runtime_binding_id,
  };
}

function auditRef(context: OperationExecutionContext) {
  return { kind: "operation_invocation", id: context.invocation_id, revision: null };
}

function expectedProfileHead(value: string | null): string | null {
  return value === NO_RUNTIME_PROFILE_REVISION ? null : value;
}

function workspaceProfile(
  store: RuntimeProfileStore,
  workspaceId: string,
  profileId: string,
): RuntimeProfileRecord | null {
  const profile = store.getProfile(profileId);
  return profile?.owner.kind === "workspace" && profile.owner.id === workspaceId ? profile : null;
}

function workspaceRevision(
  store: RuntimeProfileStore,
  workspaceId: string,
  revisionId: string,
): RuntimeProfileRevision | null {
  const revision = store.getRevision(revisionId);
  return revision && workspaceProfile(store, workspaceId, revision.runtime_profile_id) ? revision : null;
}

function workspaceActor(store: RuntimeProfileStore, workspaceId: string, actorId: string): ActorRow | null {
  const actor = store.db.prepare(`
    SELECT actor_id, workspace_id, status, current_definition_revision_id
    FROM actors WHERE actor_id = ?
  `).get(actorId) as ActorRow | undefined;
  return actor?.workspace_id === workspaceId ? actor : null;
}

function workspaceBinding(
  store: RuntimeProfileStore,
  workspaceId: string,
  bindingId: string,
): ActorRuntimeBindingRecord | null {
  try {
    const binding = store.requireActorBinding(bindingId);
    return binding.workspace_id === workspaceId ? binding : null;
  } catch {
    return null;
  }
}

function listWorkspaceProfiles(
  store: RuntimeProfileStore,
  workspaceId: string,
  includeRetired: boolean,
): RuntimeProfileRecord[] {
  const rows = store.db.prepare(`
    SELECT runtime_profile_id FROM runtime_profiles
    WHERE owner_kind = 'workspace' AND owner_id = ?
      ${includeRetired ? "" : "AND status = 'active'"}
    ORDER BY created_at, runtime_profile_id
  `).all(workspaceId) as Array<{ runtime_profile_id: string }>;
  return rows.map((row) => store.requireProfile(String(row.runtime_profile_id)));
}

function profileAvailability(
  store: RuntimeProfileStore,
  context: OperationEvaluationContext,
  requiredStatus?: RuntimeProfileRecord["status"],
) {
  const target = context.target?.ref;
  const profile = target?.kind === "runtime_profile"
    ? workspaceProfile(store, authorityWorkspaceId(context), target.id)
    : null;
  if (!profile) {
    return {
      available: false as const,
      refusal: refusal(
        "runtime_profile_not_found",
        "This Runtime Profile is not available in the current Workspace.",
        false,
        requiredAction("refresh_runtime_profiles", "Refresh Runtime Profiles", "Refresh this Workspace and select an available Runtime Profile."),
      ),
    };
  }
  if (requiredStatus && profile.status !== requiredStatus) {
    return {
      available: false as const,
      refusal: refusal(
        requiredStatus === "active" ? "runtime_profile_already_retired" : "runtime_profile_already_active",
        requiredStatus === "active" ? "This Runtime Profile is already retired." : "This Runtime Profile is already active.",
        false,
        requiredAction("inspect_runtime_profile", "Inspect Runtime Profile", "Inspect its retained configuration and lifecycle state."),
      ),
    };
  }
  return { available: true as const };
}

function profileRevisionAvailability(store: RuntimeProfileStore, context: OperationEvaluationContext) {
  const target = context.target?.ref;
  const revision = target?.kind === "runtime_profile_revision"
    ? workspaceRevision(store, authorityWorkspaceId(context), target.id)
    : null;
  return revision
    ? { available: true as const }
    : {
        available: false as const,
        refusal: refusal(
          "runtime_profile_revision_not_found",
          "This Runtime Profile revision is not available in the current Workspace.",
          false,
          requiredAction("inspect_runtime_profile", "Inspect Runtime Profile", "Select one exact retained Runtime Profile revision."),
        ),
      };
}

function actorAvailability(
  store: RuntimeProfileStore,
  context: OperationEvaluationContext,
  requireActive = false,
) {
  const target = context.target?.ref;
  const actor = target?.kind === "actor"
    ? workspaceActor(store, authorityWorkspaceId(context), target.id)
    : null;
  if (!actor || (requireActive && actor.status !== "active")) {
    return {
      available: false as const,
      refusal: refusal(
        actor ? "actor_retired" : "actor_not_found",
        actor ? "A retired Actor cannot receive a Runtime Binding." : "This Actor is not available in the current Workspace.",
        false,
        requiredAction("inspect_actor", "Inspect Actor", "Select an active Actor in this Workspace."),
      ),
    };
  }
  return { available: true as const };
}

function bindingAvailability(store: RuntimeProfileStore, context: OperationEvaluationContext) {
  const target = context.target?.ref;
  const binding = target?.kind === "actor_runtime_binding"
    ? workspaceBinding(store, authorityWorkspaceId(context), target.id)
    : null;
  return binding
    ? { available: true as const }
    : {
        available: false as const,
        refusal: refusal(
          "actor_runtime_binding_not_found",
          "This Actor Runtime Binding is not available in the current Workspace.",
          false,
          requiredAction("inspect_actor_runtime", "Inspect Actor runtime", "Refresh the Actor and select its exact current Runtime Binding."),
        ),
      };
}

function runtimeOperationRefusal(error: unknown): OperationRefusal {
  if (error instanceof RuntimeProfileConflictError || error instanceof ActorRuntimeBindingConflictError) {
    return refusal(
      "runtime_profile_revision_conflict",
      "The Runtime Profile or Actor Runtime Binding changed before this operation completed.",
      true,
      requiredAction("refresh_runtime_profile", "Review current runtime state", "Refresh the exact Runtime Profile and Actor Runtime Binding before retrying."),
    );
  }
  if (error instanceof RuntimeProfileImmutableError) {
    return refusal(
      "runtime_profile_revision_immutable",
      "Published or withdrawn Runtime Profile revisions cannot be replaced.",
      false,
      requiredAction("create_runtime_profile_draft", "Create a new draft", "Create a new Runtime Profile draft based on a retained revision."),
    );
  }
  if (error instanceof RuntimeProfileNotFoundError || error instanceof RuntimeProfileRevisionNotFoundError) {
    return refusal(
      "runtime_profile_not_found",
      "The requested Runtime Profile or exact revision was not found in this Workspace.",
      false,
      requiredAction("refresh_runtime_profiles", "Refresh Runtime Profiles", "Refresh retained Runtime Profiles and select an available exact revision."),
    );
  }
  if (error instanceof RuntimeProfileValidationError) {
    return refusal(
      "runtime_profile_invalid",
      error.message,
      false,
      requiredAction("correct_runtime_profile", "Correct the Runtime Profile", "Use provider-neutral configuration and SecretRef IDs from the discovered contract."),
    );
  }
  return refusal(
    "runtime_profile_operation_failed",
    "Floe could not prove that the Runtime Profile operation completed.",
    false,
    requiredAction("inspect_runtime_profile", "Inspect runtime state", "Inspect retained Runtime Profile and Actor Runtime Binding state before retrying."),
  );
}

async function handle<TResult>(work: () => TResult | Promise<TResult>) {
  try {
    return await work();
  } catch (error) {
    return { state: "refused" as const, refusal: runtimeOperationRefusal(error) };
  }
}

function requireUsableRevision(
  store: RuntimeProfileStore,
  workspaceId: string,
  revisionId: string,
): RuntimeProfileRevision {
  const revision = workspaceRevision(store, workspaceId, revisionId);
  if (!revision) throw new RuntimeProfileRevisionNotFoundError(revisionId);
  const profile = store.requireProfile(revision.runtime_profile_id);
  if (profile.status !== "active") {
    throw new RuntimeProfileValidationError("a retired Runtime Profile cannot receive a new Actor Runtime Binding");
  }
  if (!revision.published_at || revision.withdrawn_at) {
    throw new RuntimeProfileValidationError("an Actor can bind only to a retained published Runtime Profile revision");
  }
  return revision;
}

export function listRuntimeProfilesOperation(
  store: RuntimeProfileStore,
): SemanticOperationDefinition<{ include_retired?: boolean }, RuntimeProfileListResult> {
  return {
    operation_id: LIST_RUNTIME_PROFILES_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "runtime-profiles",
    title: "List Runtime Profiles",
    description: "List provider-neutral Runtime Profiles owned by this Workspace.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "reference" },
    required_grants: [LIST_RUNTIME_PROFILES_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    input: { version: "1", schema: listInputSchema },
    result: { version: "1", schema: profileListResultSchema },
    handler: (context, input) => handle(() => ({
      state: "completed" as const,
      result: {
        profiles: listWorkspaceProfiles(
          store,
          authorityWorkspaceId(context),
          input.include_retired === true,
        ).map((profile) => ({
          profile,
          current_revision: profile.current_revision_id
            ? store.requireRevision(profile.current_revision_id)
            : null,
        })),
      },
      audit_ref: auditRef(context),
    })),
  };
}

export function inspectRuntimeProfileOperation(
  store: RuntimeProfileStore,
): SemanticOperationDefinition<{ include_history?: boolean }, RuntimeProfileInspection> {
  return {
    operation_id: INSPECT_RUNTIME_PROFILE_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "runtime-profiles",
    title: "Inspect Runtime Profile",
    description: "Inspect current, draft, and optionally historical provider-neutral Runtime Profile revisions.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "reference" },
    required_grants: [INSPECT_RUNTIME_PROFILE_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["runtime_profile"], expected_revision: "not_applicable" },
    input: { version: "1", schema: inspectInputSchema },
    result: { version: "1", schema: profileInspectionSchema },
    availability: (context) => profileAvailability(store, context),
    handler: (context, input) => handle(() => {
      const profile = workspaceProfile(store, authorityWorkspaceId(context), context.target!.ref.id);
      if (!profile) throw new RuntimeProfileNotFoundError(context.target!.ref.id);
      const all = store.listRevisions(profile.runtime_profile_id);
      const includeHistory = input.include_history === true;
      return {
        state: "completed" as const,
        result: {
          profile,
          current_revision: profile.current_revision_id
            ? store.requireRevision(profile.current_revision_id)
            : null,
          history_complete: includeHistory,
          revisions: includeHistory
            ? all
            : all.filter((revision) =>
                revision.runtime_profile_revision_id === profile.current_revision_id
                || (!revision.published_at && !revision.withdrawn_at)),
          head_changes: includeHistory ? store.listHeadChanges(profile.runtime_profile_id) : [],
        },
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function getRuntimeProfileRevisionOperation(
  store: RuntimeProfileStore,
): SemanticOperationDefinition<Record<string, never>, { profile: RuntimeProfileRecord; revision: RuntimeProfileRevision }> {
  return {
    operation_id: GET_RUNTIME_PROFILE_REVISION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "runtime-profiles",
    title: "Get Runtime Profile revision",
    description: "Get one exact retained RuntimeProfileRevision without resolving or exposing credential material.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "reference" },
    required_grants: [GET_RUNTIME_PROFILE_REVISION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["runtime_profile_revision"], expected_revision: "not_applicable" },
    input: { version: "1", schema: emptyInput },
    result: { version: "1", schema: profileAndRevisionSchema },
    availability: (context) => profileRevisionAvailability(store, context),
    handler: (context) => handle(() => {
      const revision = workspaceRevision(store, authorityWorkspaceId(context), context.target!.ref.id);
      if (!revision) throw new RuntimeProfileRevisionNotFoundError(context.target!.ref.id);
      return {
        state: "completed" as const,
        result: { profile: store.requireProfile(revision.runtime_profile_id), revision },
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function createRuntimeProfileOperation(
  store: RuntimeProfileStore,
): SemanticOperationDefinition<{
  runtime_profile_id?: string;
  content: RuntimeProfileContent;
}, { profile: RuntimeProfileRecord; draft: RuntimeProfileRevision }> {
  return {
    operation_id: CREATE_RUNTIME_PROFILE_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "runtime-profiles",
    title: "Create Runtime Profile",
    description: "Create a Workspace-owned, provider-neutral Runtime Profile and its first unpublished draft.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "reference" },
    required_grants: [CREATE_RUNTIME_PROFILE_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    input: { version: "1", schema: createProfileInputSchema },
    result: { version: "1", schema: profileAndDraftSchema },
    handler: (context, input) => handle(() => {
      const created = store.createProfile({
        owner: { kind: "workspace", id: authorityWorkspaceId(context) },
        created_by_principal_id: context.authority.principal_id,
        content: input.content,
        ...(input.runtime_profile_id ? { runtime_profile_id: input.runtime_profile_id } : {}),
      });
      return {
        state: "completed" as const,
        result: created,
        changed_refs: [profileRef(created.profile), profileRevisionRef(created.draft)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function createRuntimeProfileDraftOperation(
  store: RuntimeProfileStore,
): SemanticOperationDefinition<{
  based_on_revision_id?: string | null;
  content: RuntimeProfileContent;
}, { profile: RuntimeProfileRecord; revision: RuntimeProfileRevision }> {
  return {
    operation_id: CREATE_RUNTIME_PROFILE_DRAFT_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "runtime-profiles",
    title: "Create Runtime Profile draft",
    description: "Create a new draft from the current or an explicitly selected retained Runtime Profile revision.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "reference" },
    required_grants: [CREATE_RUNTIME_PROFILE_DRAFT_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["runtime_profile"], expected_revision: "required" },
    input: { version: "1", schema: createDraftInputSchema },
    result: { version: "1", schema: profileAndRevisionSchema },
    availability: (context) => profileAvailability(store, context, "active"),
    handler: (context, input) => handle(() => {
      const profile = store.requireProfile(context.target!.ref.id);
      const expected = expectedProfileHead(context.expected_resource_revision);
      if (profile.current_revision_id !== expected) {
        throw new RuntimeProfileConflictError(profile.runtime_profile_id, expected, profile.current_revision_id);
      }
      const revision = store.createDraft({
        runtime_profile_id: profile.runtime_profile_id,
        created_by_principal_id: context.authority.principal_id,
        content: input.content,
        ...(input.based_on_revision_id !== undefined
          ? { based_on_revision_id: input.based_on_revision_id }
          : {}),
      });
      return {
        state: "completed" as const,
        result: { profile: store.requireProfile(profile.runtime_profile_id), revision },
        changed_refs: [profileRef(profile), profileRevisionRef(revision)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function replaceRuntimeProfileDraftOperation(
  store: RuntimeProfileStore,
): SemanticOperationDefinition<{ content: RuntimeProfileContent }, { profile: RuntimeProfileRecord; revision: RuntimeProfileRevision }> {
  return {
    operation_id: REPLACE_RUNTIME_PROFILE_DRAFT_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "runtime-profiles",
    title: "Replace Runtime Profile draft",
    description: "Replace only an unpublished Runtime Profile draft using its exact semantic digest.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "reference" },
    required_grants: [REPLACE_RUNTIME_PROFILE_DRAFT_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["runtime_profile_revision"], expected_revision: "required" },
    input: { version: "1", schema: replaceDraftInputSchema },
    result: { version: "1", schema: profileAndRevisionSchema },
    availability: (context) => profileRevisionAvailability(store, context),
    handler: (context, input) => handle(() => {
      const revision = store.replaceDraft({
        runtime_profile_revision_id: context.target!.ref.id,
        expected_digest: context.expected_resource_revision!,
        content: input.content,
      });
      return {
        state: "completed" as const,
        result: { profile: store.requireProfile(revision.runtime_profile_id), revision },
        changed_refs: [profileRevisionRef(revision)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function publishRuntimeProfileOperation(
  store: RuntimeProfileStore,
): SemanticOperationDefinition<{
  expected_current_revision_id: string | null;
}, { profile: RuntimeProfileRecord; revision: RuntimeProfileRevision }> {
  return {
    operation_id: PUBLISH_RUNTIME_PROFILE_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "runtime-profiles",
    title: "Publish Runtime Profile",
    description: "Make one draft current while retaining every exact published Runtime Profile revision.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "reference" },
    required_grants: [PUBLISH_RUNTIME_PROFILE_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["runtime_profile_revision"], expected_revision: "required" },
    input: { version: "1", schema: publishInputSchema },
    result: { version: "1", schema: profileAndRevisionSchema },
    availability: (context) => profileRevisionAvailability(store, context),
    handler: (context, input) => handle(() => {
      const current = store.requireRevision(context.target!.ref.id);
      if (current.semantic_digest !== context.expected_resource_revision) {
        throw new RuntimeProfileConflictError(
          current.runtime_profile_revision_id,
          context.expected_resource_revision,
          current.semantic_digest,
        );
      }
      const revision = store.publishDraft({
        runtime_profile_revision_id: current.runtime_profile_revision_id,
        expected_current_revision_id: input.expected_current_revision_id,
        changed_by_principal_id: context.authority.principal_id,
      });
      const profile = store.requireProfile(revision.runtime_profile_id);
      return {
        state: "completed" as const,
        result: { profile, revision },
        changed_refs: [profileRef(profile), profileRevisionRef(revision)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function rollbackRuntimeProfileOperation(
  store: RuntimeProfileStore,
): SemanticOperationDefinition<{ to_published_revision_id: string }, { profile: RuntimeProfileRecord; revision: RuntimeProfileRevision }> {
  return {
    operation_id: ROLLBACK_RUNTIME_PROFILE_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "runtime-profiles",
    title: "Roll back Runtime Profile",
    description: "Move the current Runtime Profile to an exact retained published revision without rewriting history.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "reference" },
    required_grants: [ROLLBACK_RUNTIME_PROFILE_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["runtime_profile"], expected_revision: "required" },
    input: { version: "1", schema: rollbackInputSchema },
    result: { version: "1", schema: profileAndRevisionSchema },
    availability: (context) => profileAvailability(store, context, "active"),
    handler: (context, input) => handle(() => {
      const profile = store.requireProfile(context.target!.ref.id);
      const revision = store.rollback({
        runtime_profile_id: profile.runtime_profile_id,
        to_published_revision_id: input.to_published_revision_id,
        expected_current_revision_id: context.expected_resource_revision!,
        changed_by_principal_id: context.authority.principal_id,
      });
      const changed = store.requireProfile(profile.runtime_profile_id);
      return {
        state: "completed" as const,
        result: { profile: changed, revision },
        changed_refs: [profileRef(changed), profileRevisionRef(revision)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

function runtimeProfileStatusOperation(
  store: RuntimeProfileStore,
  status: "active" | "retired",
): SemanticOperationDefinition<Record<string, never>, { profile: RuntimeProfileRecord }> {
  const reactivating = status === "active";
  const operationId = reactivating ? REACTIVATE_RUNTIME_PROFILE_OPERATION_ID : RETIRE_RUNTIME_PROFILE_OPERATION_ID;
  return {
    operation_id: operationId,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "runtime-profiles",
    title: reactivating ? "Reactivate Runtime Profile" : "Retire Runtime Profile",
    description: reactivating
      ? "Return a retired Runtime Profile to active selection without changing its retained revisions."
      : "Remove a Runtime Profile from active selection while retaining its exact revisions and bindings.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "reference" },
    required_grants: [operationId],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["runtime_profile"], expected_revision: "required" },
    input: { version: "1", schema: emptyInput },
    result: { version: "1", schema: profileOnlySchema },
    availability: (context) => profileAvailability(store, context, reactivating ? "retired" : "active"),
    handler: (context) => handle(() => {
      const profile = store.setProfileStatus({
        runtime_profile_id: context.target!.ref.id,
        status,
        expected_current_revision_id: expectedProfileHead(context.expected_resource_revision),
      });
      return {
        state: "completed" as const,
        result: { profile },
        changed_refs: [profileRef(profile)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function inspectActorRuntimeBindingOperation(
  store: RuntimeProfileStore,
): SemanticOperationDefinition<{ include_history?: boolean }, ActorRuntimeBindingInspection> {
  return {
    operation_id: INSPECT_ACTOR_RUNTIME_BINDING_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "runtime-profiles",
    title: "Inspect Actor Runtime Binding",
    description: "Inspect the Actor's current exact Runtime Profile binding and optionally its retained binding history.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [INSPECT_ACTOR_RUNTIME_BINDING_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["actor"], expected_revision: "not_applicable" },
    input: { version: "1", schema: inspectInputSchema },
    result: { version: "1", schema: bindingInspectionSchema },
    availability: (context) => actorAvailability(store, context),
    handler: (context, input) => handle(() => {
      const actor = workspaceActor(store, authorityWorkspaceId(context), context.target!.ref.id);
      if (!actor) throw new RuntimeProfileValidationError("Actor is not available in this Workspace");
      const current = store.getCurrentActorBinding(actor.actor_id);
      return {
        state: "completed" as const,
        result: {
          actor_id: actor.actor_id,
          current_binding: current,
          history_complete: input.include_history === true,
          bindings: input.include_history === true
            ? store.listActorBindings(actor.actor_id)
            : current ? [current] : [],
        },
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function getActorRuntimeBindingOperation(
  store: RuntimeProfileStore,
): SemanticOperationDefinition<Record<string, never>, { binding: ActorRuntimeBindingRecord }> {
  return {
    operation_id: GET_ACTOR_RUNTIME_BINDING_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "runtime-profiles",
    title: "Get Actor Runtime Binding",
    description: "Get one exact retained ActorRuntimeBinding without resolving any SecretRef value.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [GET_ACTOR_RUNTIME_BINDING_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["actor_runtime_binding"], expected_revision: "not_applicable" },
    input: { version: "1", schema: emptyInput },
    result: { version: "1", schema: bindingOnlySchema },
    availability: (context) => bindingAvailability(store, context),
    handler: (context) => handle(() => {
      const binding = workspaceBinding(store, authorityWorkspaceId(context), context.target!.ref.id);
      if (!binding) throw new RuntimeProfileValidationError("Actor Runtime Binding is not available in this Workspace");
      return { state: "completed" as const, result: { binding }, audit_ref: auditRef(context) };
    }),
  };
}

type BindActorInput = Readonly<{
  runtime_profile_revision_id: string;
  endpoint_id?: string | null;
  status: ActorRuntimeBindingRecord["status"];
  unresolved_reasons?: readonly string[];
}>;

export function createActorRuntimeBindingOperation(
  store: RuntimeProfileStore,
): SemanticOperationDefinition<BindActorInput, { binding: ActorRuntimeBindingRecord }> {
  return {
    operation_id: CREATE_ACTOR_RUNTIME_BINDING_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "runtime-profiles",
    title: "Create Actor Runtime Binding",
    description: "Bind an unbound Actor to one exact published Runtime Profile revision in this Workspace.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [CREATE_ACTOR_RUNTIME_BINDING_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["actor"], expected_revision: "required" },
    input: { version: "1", schema: bindingInputSchema },
    result: { version: "1", schema: bindingOnlySchema },
    availability: (context) => actorAvailability(store, context, true),
    handler: (context, input) => handle(() => {
      const actor = workspaceActor(store, authorityWorkspaceId(context), context.target!.ref.id);
      if (!actor) throw new RuntimeProfileValidationError("Actor is not available in this Workspace");
      const actorRevision = actor.current_definition_revision_id ?? NO_ACTOR_DEFINITION_REVISION;
      if (actorRevision !== context.expected_resource_revision) {
        throw new RuntimeProfileConflictError(actor.actor_id, context.expected_resource_revision, actorRevision);
      }
      const current = store.getCurrentActorBinding(actor.actor_id);
      if (current) {
        throw new ActorRuntimeBindingConflictError(actor.actor_id, null, current.actor_runtime_binding_id);
      }
      requireUsableRevision(store, authorityWorkspaceId(context), input.runtime_profile_revision_id);
      const binding = store.bindActor({
        actor_id: actor.actor_id,
        runtime_profile_revision_id: input.runtime_profile_revision_id,
        endpoint_id: input.endpoint_id ?? null,
        status: input.status,
        unresolved_reasons: input.unresolved_reasons ?? [],
        expected_current_binding_id: null,
        created_by_principal_id: context.authority.principal_id,
      });
      return {
        state: "completed" as const,
        result: { binding },
        changed_refs: [bindingRef(binding)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function replaceActorRuntimeBindingOperation(
  store: RuntimeProfileStore,
): SemanticOperationDefinition<BindActorInput, { binding: ActorRuntimeBindingRecord }> {
  return {
    operation_id: REPLACE_ACTOR_RUNTIME_BINDING_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "runtime-profiles",
    title: "Replace Actor Runtime Binding",
    description: "Replace the exact current Actor Runtime Binding while retaining the superseded binding as evidence.",
    effects: {
      mode: "write",
      reversibility: "reversible",
      external: false,
      secret_access: "none",
      allowed_during_restore_hold: true,
    },
    required_grants: [REPLACE_ACTOR_RUNTIME_BINDING_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["actor_runtime_binding"], expected_revision: "required" },
    input: { version: "1", schema: bindingInputSchema },
    result: { version: "1", schema: bindingOnlySchema },
    availability: (context) => bindingAvailability(store, context),
    handler: (context, input) => handle(() => {
      const previous = store.requireActorBinding(context.target!.ref.id);
      if (previous.actor_runtime_binding_id !== context.expected_resource_revision) {
        throw new ActorRuntimeBindingConflictError(
          previous.actor_id,
          context.expected_resource_revision,
          previous.actor_runtime_binding_id,
        );
      }
      const current = store.getCurrentActorBinding(previous.actor_id);
      if (current?.actor_runtime_binding_id !== previous.actor_runtime_binding_id) {
        throw new ActorRuntimeBindingConflictError(
          previous.actor_id,
          previous.actor_runtime_binding_id,
          current?.actor_runtime_binding_id ?? null,
        );
      }
      const actor = workspaceActor(store, authorityWorkspaceId(context), previous.actor_id);
      if (!actor || actor.status !== "active") {
        throw new RuntimeProfileValidationError("a retired or unavailable Actor cannot receive a Runtime Binding");
      }
      requireUsableRevision(store, authorityWorkspaceId(context), input.runtime_profile_revision_id);
      const binding = store.bindActor({
        actor_id: previous.actor_id,
        runtime_profile_revision_id: input.runtime_profile_revision_id,
        endpoint_id: input.endpoint_id ?? null,
        status: input.status,
        unresolved_reasons: input.unresolved_reasons ?? [],
        expected_current_binding_id: previous.actor_runtime_binding_id,
        created_by_principal_id: context.authority.principal_id,
      });
      return {
        state: "completed" as const,
        result: { binding },
        changed_refs: [bindingRef(previous), bindingRef(binding)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function runtimeProfileOperationDefinitions(
  store: RuntimeProfileStore,
): SemanticOperationDefinition<any, any>[] {
  return [
    listRuntimeProfilesOperation(store),
    inspectRuntimeProfileOperation(store),
    getRuntimeProfileRevisionOperation(store),
    createRuntimeProfileOperation(store),
    createRuntimeProfileDraftOperation(store),
    replaceRuntimeProfileDraftOperation(store),
    publishRuntimeProfileOperation(store),
    rollbackRuntimeProfileOperation(store),
    runtimeProfileStatusOperation(store, "retired"),
    runtimeProfileStatusOperation(store, "active"),
    inspectActorRuntimeBindingOperation(store),
    getActorRuntimeBindingOperation(store),
    createActorRuntimeBindingOperation(store),
    replaceActorRuntimeBindingOperation(store),
  ];
}

export function registerRuntimeProfileOperations<T extends SemanticOperationRegistry>(
  registry: T,
  store: RuntimeProfileStore,
): T {
  for (const definition of runtimeProfileOperationDefinitions(store)) registry.register(definition);
  return registry;
}
