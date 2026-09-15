/**
 * local-operator-actor — provision the operator Actor for a Workspace.
 *
 * The operator is an ordinary Actor. It appears in the same Actor listing as
 * any other, `request` can address it, and it is created through the same
 * definition → runtime-profile → binding path any Actor is. The only thing that
 * distinguishes it is its runtime adapter: the profile declares the `client`
 * adapter, which no Bridge provides, so the existing adapter-match filter skips
 * it and a model Bridge never tries to run it. Its turns are executed by
 * whatever client is attached to it.
 *
 * Nothing here names what backs the Actor. The adapter names only what executes
 * the turn (a client). This provisioning is idempotent and runs on every
 * workspace registration, so every workspace has an addressable operator Actor
 * however it was registered.
 */
import type { ActorDefinitionContent, ActorDefinitionStore } from "./actor-definitions.js";
import { CLIENT_ADAPTER_ID, type RuntimeProfileContent, type RuntimeProfileStore } from "./runtime-profiles.js";

type Broadcast = (type: string, payload: Record<string, unknown>) => void;

export const OPERATOR_ACTOR_SLUG = "operator";
export const OPERATOR_ACTOR_LABEL = "Operator";

/** The Actor id and Endpoint id share the substrate convention `actor:<ws>:<slug>`. */
export function operatorActorId(workspaceId: string): string {
  return `actor:${workspaceId}:${OPERATOR_ACTOR_SLUG}`;
}

export interface OperatorActorDeps {
  readonly actors: ActorDefinitionStore;
  readonly runtimes: RuntimeProfileStore;
  readonly principalId: string;
  readonly getEndpoint: (endpointId: string) => unknown;
  readonly registerEndpoint: (
    input: {
      endpoint_id: string;
      workspace_id: string;
      name: string;
      agent_id?: string | null;
      bridge_id?: string | null;
      status?: string;
    },
    broadcast: Broadcast,
  ) => unknown;
}

export type OperatorActorResult = Readonly<{
  created: boolean;
  actor_id: string;
  endpoint_id: string;
}>;

/**
 * Ensure the Workspace has its operator Actor: an active Actor bound to a
 * published `client`-adapter runtime profile, with an addressable Endpoint row
 * so `request`/endpoint listing resolves it. Safe to call on every
 * registration — an existing Actor is left as-is (its addressable Endpoint row
 * is backfilled if a pre-existing workspace lacked one).
 */
export function ensureOperatorActor(
  deps: OperatorActorDeps,
  workspaceId: string,
  broadcast: Broadcast,
): OperatorActorResult {
  const actorId = operatorActorId(workspaceId);
  const endpointId = actorId;

  if (deps.actors.getActor(actorId)) {
    if (!deps.getEndpoint(endpointId)) {
      deps.registerEndpoint(
        { endpoint_id: endpointId, workspace_id: workspaceId, name: OPERATOR_ACTOR_LABEL, agent_id: OPERATOR_ACTOR_SLUG, bridge_id: null, status: "idle" },
        broadcast,
      );
    }
    return { created: false, actor_id: actorId, endpoint_id: endpointId };
  }

  const definition: ActorDefinitionContent = {
    label: OPERATOR_ACTOR_LABEL,
    charter: "Operates this Floe workspace.",
    responsibilities: [],
    instructions: "Turns for this Actor are executed by an attached client.",
    knowledge_refs: [],
    capability_grant_ids: [],
    policy_refs: { budget: null, trust: null, approval: null },
    escalation_rules: [],
  };
  const { draft } = deps.actors.createActor({
    workspace_id: workspaceId,
    actor_id: actorId,
    created_by_principal_id: deps.principalId,
    definition,
  });
  deps.actors.publishDraft({
    actor_definition_revision_id: draft.actor_definition_revision_id,
    expected_current_revision_id: null,
    changed_by_principal_id: deps.principalId,
  });

  const profileContent: RuntimeProfileContent = {
    label: OPERATOR_ACTOR_LABEL,
    backing_kind: "service",
    adapter_id: CLIENT_ADAPTER_ID,
    configuration: {},
    secret_ref_ids: [],
    required_capability_ids: [],
    checkpoint_policy: { mode: "none", schema_ref: null },
    resource_policy: {},
  };
  const { draft: profileDraft } = deps.runtimes.createProfile({
    runtime_profile_id: `runtime-profile:${actorId}`,
    owner: { kind: "workspace", id: workspaceId },
    created_by_principal_id: deps.principalId,
    content: profileContent,
  });
  deps.runtimes.publishDraft({
    runtime_profile_revision_id: profileDraft.runtime_profile_revision_id,
    expected_current_revision_id: null,
    changed_by_principal_id: deps.principalId,
  });

  deps.runtimes.bindActor({
    actor_id: actorId,
    runtime_profile_revision_id: profileDraft.runtime_profile_revision_id,
    endpoint_id: endpointId,
    status: "resolved",
    unresolved_reasons: [],
    expected_current_binding_id: null,
    created_by_principal_id: deps.principalId,
  });

  deps.registerEndpoint(
    { endpoint_id: endpointId, workspace_id: workspaceId, name: OPERATOR_ACTOR_LABEL, agent_id: OPERATOR_ACTOR_SLUG, bridge_id: null, status: "idle" },
    broadcast,
  );

  return { created: true, actor_id: actorId, endpoint_id: endpointId };
}
