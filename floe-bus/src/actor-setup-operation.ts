/**
 * @invariant actor.setup is the existing Actor steps run as one unit: create,
 * bind to a runtime, delegate access, then publish. It adds no authority of its
 * own: the caller must hold every step's grant, and each step keeps its own
 * rules. It runs synchronously inside one savepoint, so a refusal at any step
 * leaves nothing behind and nothing is announced. Publishing is the commit
 * point: the Actor exists for others only once the whole unit has completed.
 */
import {
  CREATE_ACTOR_OPERATION_ID,
  NO_ACTOR_DEFINITION_REVISION,
  PUBLISH_ACTOR_DEFINITION_OPERATION_ID,
  actorDefinitionRevisionSchema,
  actorOperationRefusal,
  actorSchema,
  createActorInputSchema,
  createActorWithToolAccess,
  definitionRef,
  actorRef,
  newActorToolAccessSchema,
} from "./actor-definition-operations.js";
import type { ActorDefinitionContent, ActorDefinitionRevision, ActorDefinitionStore, ActorRecord } from "./actor-definitions.js";
import type { NewActorToolAccess } from "./actor-tool-access.js";
import {
  capabilityGrantSchema,
  delegateAccessToActor,
  delegationRequestSchema,
  type DelegationRequest,
} from "./capability-grant-operations.js";
import type { CapabilityGrantRecord, SqliteCapabilityGrantStore } from "./capability-grants.js";
import type { SqliteSecretRefStore } from "./credential-broker.js";
import {
  refusal,
  type JsonSchema,
  type OperationExecutionContext,
  type OperationRefusal,
  type SemanticOperationDefinition,
} from "./operations.js";
import {
  CREATE_ACTOR_RUNTIME_BINDING_OPERATION_ID,
  actorRuntimeBindingSchema,
  bindUnboundActor,
  bindingRef,
  runtimeOperationRefusal,
} from "./runtime-profile-operations.js";
import type { ActorRuntimeBindingRecord, RuntimeProfileStore } from "./runtime-profiles.js";

export const SETUP_ACTOR_OPERATION_ID = "actor.setup";

type SetupStep = "create" | "bind_runtime" | "delegate_access" | "publish";

type SetupActorInput = Readonly<{
  actor_id?: string;
  definition: ActorDefinitionContent;
  engine_tool_operation_ids?: string[];
  runtime_profile_revision_id: string;
  grants?: readonly DelegationRequest[];
}>;

type SetupActorResult = Readonly<{
  actor: ActorRecord;
  revision: ActorDefinitionRevision;
  binding: ActorRuntimeBindingRecord;
  tool_access: NewActorToolAccess;
  delegated_grants: readonly CapabilityGrantRecord[];
}>;

type Dependencies = Readonly<{
  actors: ActorDefinitionStore;
  runtimes: RuntimeProfileStore;
  grants: SqliteCapabilityGrantStore;
  refs: SqliteSecretRefStore;
}>;

const setupInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["definition", "runtime_profile_revision_id"],
  properties: {
    ...(createActorInputSchema as { properties: Record<string, JsonSchema> }).properties,
    runtime_profile_revision_id: { type: "string", minLength: 1,
      description: "The exact published Runtime Profile revision the Actor runs on. To run it the way you run, use the one from your own binding (actor.runtime-binding.inspect on yourself)." },
    grants: {
      type: "array",
      items: delegationRequestSchema as unknown as JsonSchema,
      description: "Optional further access to give the Actor, each a subset of one of your own session grants (see capability.grant.delegate). Access can only narrow, never widen.",
    },
  },
};

const setupResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actor", "revision", "binding", "tool_access", "delegated_grants"],
  properties: {
    actor: actorSchema,
    revision: actorDefinitionRevisionSchema,
    binding: actorRuntimeBindingSchema,
    tool_access: newActorToolAccessSchema,
    delegated_grants: { type: "array", items: capabilityGrantSchema as unknown as JsonSchema },
  },
};

const STEP_NAMES: Readonly<Record<SetupStep, string>> = {
  create: "creating the Actor",
  bind_runtime: "binding it to its runtime",
  delegate_access: "giving it access",
  publish: "publishing it",
};

class SetupStepRefused extends Error {
  constructor(readonly step: SetupStep, readonly cause_refusal: OperationRefusal) {
    super(cause_refusal.message);
  }
}

function setupRefusal(step: SetupStep, cause: OperationRefusal): OperationRefusal {
  return refusal(
    "actor_setup_refused",
    `Setting up the Actor stopped at ${STEP_NAMES[step]}: ${cause.message} Nothing was created.`,
    cause.retryable,
    cause.required_action,
    { step, cause_code: cause.code, cause_details: cause.details },
  );
}

function step<T>(name: SetupStep, toRefusal: (error: unknown) => OperationRefusal, work: () => T | { refusal: OperationRefusal }): T {
  let outcome: T | { refusal: OperationRefusal };
  try {
    outcome = work();
  } catch (error) {
    throw new SetupStepRefused(name, toRefusal(error));
  }
  if (outcome && typeof outcome === "object" && "refusal" in outcome) throw new SetupStepRefused(name, outcome.refusal);
  return outcome as T;
}

function setUp(deps: Dependencies, context: OperationExecutionContext, input: SetupActorInput): SetupActorResult {
  const created = step("create", actorOperationRefusal,
    () => createActorWithToolAccess(deps.actors, deps.grants, context, input));
  const actorId = created.actor.actor_id;
  const binding = step("bind_runtime", runtimeOperationRefusal,
    () => bindUnboundActor(deps.runtimes, context, actorId, NO_ACTOR_DEFINITION_REVISION, {
      runtime_profile_revision_id: input.runtime_profile_revision_id,
      status: "resolved",
    }));
  const delegated = (input.grants ?? []).map(request => step("delegate_access", actorOperationRefusal,
    () => delegateAccessToActor(deps, context, actorId, NO_ACTOR_DEFINITION_REVISION, request)).grant);
  const revision = step("publish", actorOperationRefusal, () => {
    const draft = delegated.length === 0 ? created.draft : deps.actors.replaceDraft({
      actor_definition_revision_id: created.draft.actor_definition_revision_id,
      expected_digest: created.draft.semantic_digest,
      definition: {
        ...created.draft.content,
        capability_grant_ids: [...new Set([...created.draft.content.capability_grant_ids, ...delegated.map(grant => grant.grant_id)])],
      },
    });
    return deps.actors.publishDraft({
      actor_definition_revision_id: draft.actor_definition_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: context.authority.principal_id,
    });
  });
  return {
    actor: deps.actors.requireActor(actorId),
    revision,
    binding,
    tool_access: created.tool_access,
    delegated_grants: delegated,
  };
}

export function setupActorOperation(deps: Dependencies): SemanticOperationDefinition<SetupActorInput, SetupActorResult> {
  return {
    operation_id: SETUP_ACTOR_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "actors",
    title: "Set up a working Actor",
    description: "Create an Actor, bind it to a runtime, give it access, and publish it, in one step. Either every part happens or none does: if any part is refused, nothing is created and the refusal names the part and the reason. Requires the same permissions as doing each part yourself (actor.create, actor.runtime-binding.create, actor.definition.publish, and capability.grant.delegate when giving grants). The new Actor can receive work as soon as this completes.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "reference" },
    // No authority of its own: exactly the grants its steps require.
    required_grants: [CREATE_ACTOR_OPERATION_ID, CREATE_ACTOR_RUNTIME_BINDING_OPERATION_ID, PUBLISH_ACTOR_DEFINITION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    input: { version: "1", schema: setupInputSchema },
    result: { version: "1", schema: setupResultSchema },
    // Synchronous on purpose: nothing else may run inside the savepoint, and
    // a binding is announced only after the unit has been kept.
    handler: (context, input) => {
      deps.actors.db.exec("SAVEPOINT setup_actor");
      try {
        const result = setUp(deps, context, input);
        deps.actors.db.exec("RELEASE setup_actor");
        return {
          state: "completed" as const,
          result,
          changed_refs: [
            actorRef(result.actor),
            definitionRef(result.revision),
            bindingRef(result.binding),
            ...[...result.tool_access.grant_ids, ...result.delegated_grants.map(grant => grant.grant_id)]
              .map(id => ({ kind: "capability_grant", id, revision: null })),
          ],
          audit_ref: { kind: "operation_invocation", id: context.invocation_id, revision: null },
        };
      } catch (error) {
        deps.actors.db.exec("ROLLBACK TO setup_actor");
        deps.actors.db.exec("RELEASE setup_actor");
        if (error instanceof SetupStepRefused) {
          return { state: "refused" as const, refusal: setupRefusal(error.step, error.cause_refusal) };
        }
        throw error;
      }
    },
  };
}
