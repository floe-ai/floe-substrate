import type { ActorDefinitionRevision, ActorDefinitionStore } from "./actor-definitions.js";
import type { Artefact, ArtefactStore, ArtefactVersion } from "./artefacts.js";
import type {
  ActorRuntimeBindingRecord,
  RuntimeProfileRevision,
  RuntimeProfileStore,
} from "./runtime-profiles.js";
import type { ScopeCompositionStore, ScopeNodePlacement, ScopePort } from "./scope-compositions.js";
import type {
  ExecutionAttemptRecord,
  NodeExecutionInputRecord,
  NodeExecutionRecord,
  ScopeExecutionRecord,
  ScopeExecutionStore,
} from "./scope-executions.js";

export type RuntimeProcessingEvent = Readonly<{
  event_id: string;
  type: string;
  workspace_id: string;
  context_id: string;
  scope_id: string | null;
  source_endpoint_id: string | null;
  correlation_id: string | null;
  content: Readonly<Record<string, unknown>>;
  metadata: Readonly<Record<string, unknown>>;
  artefact_version_ids: readonly string[];
  created_at: string;
}>;

export type RuntimeProcessingInput = Readonly<{
  input_id: string;
  port: ScopePort;
  delivery_id: string;
  member_key: string;
  event: RuntimeProcessingEvent;
  artefact: Readonly<{
    identity: Artefact;
    version: ArtefactVersion;
  }> | null;
}>;

/**
 * Exact, provider-neutral input to one runtime attempt. This is a projection of
 * canonical records, not another lifecycle or source of truth.
 *
 * Deliberately absent: Scope Edges and downstream Node identities. A runtime
 * publishes only to one of its named output Ports; the pinned composition owns
 * subsequent movement.
 */
export type RuntimeProcessingContract = Readonly<{
  contract_kind: "scope_node";
  contract_version: 1;
  processing_contract_id: string;
  workspace_id: string;
  scope_execution: ScopeExecutionRecord;
  node_execution: NodeExecutionRecord;
  execution_attempt: ExecutionAttemptRecord;
  placement: ScopeNodePlacement;
  context: Readonly<{
    context_id: string;
    inspect_operation_id: "context.inspect";
  }>;
  actor: Readonly<{
    actor_id: string;
    definition: ActorDefinitionRevision;
  }>;
  runtime: Readonly<{
    binding: ActorRuntimeBindingRecord;
    profile: RuntimeProfileRevision;
  }>;
  operation_authority: Readonly<{
    principal_id: string;
    capability_grant_ids: readonly string[];
    authority_session_required: true;
  }>;
  inputs: readonly RuntimeProcessingInput[];
  outputs: Readonly<{
    publish_operation_id: "scope.node-output.publish";
    ports: readonly ScopePort[];
  }>;
}>;

export type DirectRuntimeProcessingContract = Readonly<{
  contract_kind: "direct_context";
  contract_version: 1;
  processing_contract_id: string;
  workspace_id: string;
  delivery: Readonly<{
    delivery_id: string;
    stable_delivery_ids: readonly string[];
    endpoint_id: string;
    context_id: string;
  }>;
  context: Readonly<{
    context_id: string;
    inspect_operation_id: "context.inspect";
  }>;
  actor: Readonly<{
    actor_id: string;
    definition: ActorDefinitionRevision;
  }>;
  runtime: Readonly<{
    binding: ActorRuntimeBindingRecord;
    profile: RuntimeProfileRevision;
  }>;
  operation_authority: Readonly<{
    principal_id: string;
    capability_grant_ids: readonly string[];
    authority_session_required: true;
  }>;
  events: readonly RuntimeProcessingEvent[];
  outputs: Readonly<{
    publish_operation_id: null;
    ports: readonly [];
  }>;
}>;

export type RuntimeDispatchContract = RuntimeProcessingContract | DirectRuntimeProcessingContract;

export type RuntimeProcessingContractSources = Readonly<{
  executions: Pick<
    ScopeExecutionStore,
    "getAttempt" | "getNodeExecution" | "getExecution" | "listReceivedInputs"
  >;
  compositions: Pick<ScopeCompositionStore, "getRevision">;
  actors: Pick<ActorDefinitionStore, "getRevision">;
  runtimes: Pick<RuntimeProfileStore, "getRevision" | "requireActorBinding">;
  artefacts: Pick<ArtefactStore, "getArtefact" | "getVersion">;
  get_event: (eventId: string) => RuntimeProcessingEvent | null;
}>;

export class RuntimeProcessingContractError extends Error {
  readonly code = "E_RUNTIME_PROCESSING_CONTRACT_UNAVAILABLE" as const;

  constructor(readonly reason: string) {
    super(`Runtime processing contract unavailable: ${reason}`);
    this.name = "RuntimeProcessingContractError";
  }
}

export class RuntimeProcessingContractResolver {
  constructor(private readonly sources: RuntimeProcessingContractSources) {}

  resolve(attemptId: string): RuntimeProcessingContract {
    const attempt = this.sources.executions.getAttempt(attemptId);
    if (!attempt) throw unavailable(`ExecutionAttempt '${attemptId}' does not exist`);
    if (attempt.status !== "pending" && attempt.status !== "running") {
      throw unavailable(`ExecutionAttempt '${attemptId}' is '${attempt.status}', not executable`);
    }

    const nodeExecution = this.sources.executions.getNodeExecution(attempt.node_execution_id);
    if (!nodeExecution) {
      throw unavailable(`NodeExecution '${attempt.node_execution_id}' does not exist`);
    }
    const scopeExecution = this.sources.executions.getExecution(nodeExecution.execution_id);
    if (!scopeExecution) {
      throw unavailable(`ScopeExecution '${nodeExecution.execution_id}' does not exist`);
    }
    if (scopeExecution.workspace_id.trim().length === 0 || nodeExecution.context_id.trim().length === 0) {
      throw unavailable("the execution has no exact Workspace or Context relationship");
    }
    if (nodeExecution.revision_id !== scopeExecution.revision_id) {
      throw unavailable("the NodeExecution and ScopeExecution pin different composition revisions");
    }

    const revision = this.sources.compositions.getRevision(scopeExecution.revision_id);
    if (!revision
      || revision.workspace_id !== scopeExecution.workspace_id
      || revision.scope_id !== scopeExecution.scope_id) {
      throw unavailable(`pinned ScopeCompositionRevision '${scopeExecution.revision_id}' is unavailable`);
    }
    const placement = revision.nodes.find((candidate) => candidate.node_id === nodeExecution.node_id);
    if (!placement || placement.kind !== "actor" || !placement.resource_id) {
      throw unavailable(`Node '${nodeExecution.node_id}' is not a pinned Actor placement`);
    }

    const actorDefinition = this.requireActorDefinition(
      attempt,
      nodeExecution,
      placement,
      scopeExecution.workspace_id,
    );
    const runtimeProfile = this.requireRuntimeProfile(attempt, nodeExecution);
    const runtimeBinding = this.requireRuntimeBinding(
      attempt,
      nodeExecution,
      actorDefinition,
      runtimeProfile,
    );
    const inputs = this.sources.executions.listReceivedInputs(nodeExecution.node_execution_id)
      .map((input) => this.resolveInput(input, revision.ports, scopeExecution.workspace_id));
    const outputPorts = revision.ports
      .filter((port) => port.node_id === nodeExecution.node_id && port.direction === "output")
      .map(copyPort);

    return Object.freeze({
      contract_kind: "scope_node" as const,
      contract_version: 1 as const,
      processing_contract_id: `runtime-processing-contract:v1:${attempt.attempt_id}`,
      workspace_id: scopeExecution.workspace_id,
      scope_execution: scopeExecution,
      node_execution: nodeExecution,
      execution_attempt: attempt,
      placement: Object.freeze({
        ...placement,
        bindings: placement.bindings ? [...placement.bindings] : undefined,
      }),
      context: Object.freeze({
        context_id: nodeExecution.context_id,
        inspect_operation_id: "context.inspect" as const,
      }),
      actor: Object.freeze({
        actor_id: actorDefinition.actor_id,
        definition: actorDefinition,
      }),
      runtime: Object.freeze({
        binding: runtimeBinding,
        profile: runtimeProfile,
      }),
      operation_authority: Object.freeze({
        principal_id: actorDefinition.actor_id,
        capability_grant_ids: Object.freeze([...actorDefinition.content.capability_grant_ids]),
        authority_session_required: true as const,
      }),
      inputs: Object.freeze(inputs),
      outputs: Object.freeze({
        publish_operation_id: "scope.node-output.publish" as const,
        ports: Object.freeze(outputPorts),
      }),
    });
  }

  resolveDirect(input: Readonly<{
    delivery_id: string;
    stable_delivery_ids: readonly string[];
    endpoint_id: string;
    workspace_id: string;
    context_id: string;
    actor_definition_revision_id: string;
    runtime_profile_revision_id: string;
    actor_runtime_binding_id: string;
    events: readonly RuntimeProcessingEvent[];
  }>): DirectRuntimeProcessingContract {
    if (!input.context_id.trim()) throw unavailable("a direct Delivery has no exact Context relationship");
    const definition = this.sources.actors.getRevision(input.actor_definition_revision_id);
    if (!definition || definition.workspace_id !== input.workspace_id || !definition.published_at) {
      throw unavailable(`pinned Actor definition '${input.actor_definition_revision_id}' is unavailable`);
    }
    const profile = this.sources.runtimes.getRevision(input.runtime_profile_revision_id);
    if (!profile || !profile.published_at) {
      throw unavailable(`pinned runtime profile '${input.runtime_profile_revision_id}' is unavailable`);
    }
    let binding: ActorRuntimeBindingRecord;
    try {
      binding = this.sources.runtimes.requireActorBinding(input.actor_runtime_binding_id);
    } catch {
      throw unavailable(`pinned Actor runtime binding '${input.actor_runtime_binding_id}' is unavailable`);
    }
    if (binding.actor_id !== definition.actor_id
      || binding.workspace_id !== input.workspace_id
      || binding.endpoint_id !== input.endpoint_id
      || binding.runtime_profile_revision_id !== profile.runtime_profile_revision_id) {
      throw unavailable("the direct Delivery pins do not describe one Actor/runtime/Endpoint relationship");
    }
    if (input.events.length === 0 || input.events.some((event) => event.workspace_id !== input.workspace_id)) {
      throw unavailable("the direct Delivery Events are absent or belong to another Workspace");
    }
    return Object.freeze({
      contract_kind: "direct_context" as const,
      contract_version: 1 as const,
      processing_contract_id: `runtime-processing-contract:v1:delivery:${input.delivery_id}`,
      workspace_id: input.workspace_id,
      delivery: Object.freeze({
        delivery_id: input.delivery_id,
        stable_delivery_ids: Object.freeze([...input.stable_delivery_ids]),
        endpoint_id: input.endpoint_id,
        context_id: input.context_id,
      }),
      context: Object.freeze({
        context_id: input.context_id,
        inspect_operation_id: "context.inspect" as const,
      }),
      actor: Object.freeze({ actor_id: definition.actor_id, definition }),
      runtime: Object.freeze({ binding, profile }),
      operation_authority: Object.freeze({
        principal_id: definition.actor_id,
        capability_grant_ids: Object.freeze([...definition.content.capability_grant_ids]),
        authority_session_required: true as const,
      }),
      events: Object.freeze([...input.events]),
      outputs: Object.freeze({
        publish_operation_id: null,
        ports: Object.freeze([]) as readonly [],
      }),
    });
  }

  private requireActorDefinition(
    attempt: ExecutionAttemptRecord,
    node: NodeExecutionRecord,
    placement: ScopeNodePlacement,
    workspaceId: string,
  ): ActorDefinitionRevision {
    if (!node.actor_definition_revision_id) {
      throw unavailable(`NodeExecution '${node.node_execution_id}' has no Actor definition pin`);
    }
    const definition = this.sources.actors.getRevision(node.actor_definition_revision_id);
    if (!definition
      || definition.workspace_id !== workspaceId
      || definition.actor_id !== placement.resource_id
      || !definition.published_at) {
      throw unavailable(`pinned Actor definition '${node.actor_definition_revision_id}' is unavailable`);
    }
    if (!node.assigned_actor_ids.includes(definition.actor_id)) {
      throw unavailable(`NodeExecution '${node.node_execution_id}' is not assigned to its pinned Actor`);
    }
    if (attempt.node_execution_id !== node.node_execution_id
      || node.actor_definition_revision_id !== attempt.actor_definition_revision_id) {
      throw unavailable("the ExecutionAttempt and NodeExecution pin different Actor definitions");
    }
    return definition;
  }

  private requireRuntimeProfile(
    attempt: ExecutionAttemptRecord,
    node: NodeExecutionRecord,
  ): RuntimeProfileRevision {
    if (!node.runtime_profile_revision_id) {
      throw unavailable(`NodeExecution '${node.node_execution_id}' has no runtime profile pin`);
    }
    const profile = this.sources.runtimes.getRevision(node.runtime_profile_revision_id);
    if (!profile || !profile.published_at) {
      throw unavailable(`pinned runtime profile '${node.runtime_profile_revision_id}' is unavailable`);
    }
    if (attempt.node_execution_id !== node.node_execution_id
      || node.runtime_profile_revision_id !== attempt.runtime_profile_revision_id) {
      throw unavailable("the ExecutionAttempt and NodeExecution pin different runtime profiles");
    }
    return profile;
  }

  private requireRuntimeBinding(
    attempt: ExecutionAttemptRecord,
    node: NodeExecutionRecord,
    definition: ActorDefinitionRevision,
    profile: RuntimeProfileRevision,
  ): ActorRuntimeBindingRecord {
    if (!node.actor_runtime_binding_id) {
      throw unavailable(`NodeExecution '${node.node_execution_id}' has no Actor runtime binding pin`);
    }
    let binding: ActorRuntimeBindingRecord;
    try {
      binding = this.sources.runtimes.requireActorBinding(node.actor_runtime_binding_id);
    } catch {
      throw unavailable(`pinned Actor runtime binding '${node.actor_runtime_binding_id}' is unavailable`);
    }
    if (binding.actor_id !== definition.actor_id
      || binding.workspace_id !== definition.workspace_id
      || binding.runtime_profile_revision_id !== profile.runtime_profile_revision_id) {
      throw unavailable("the pinned Actor runtime binding does not match the pinned Actor and runtime profile");
    }
    if (attempt.node_execution_id !== node.node_execution_id
      || attempt.actor_runtime_binding_id !== binding.actor_runtime_binding_id) {
      throw unavailable("the ExecutionAttempt and NodeExecution pin different Actor runtime bindings");
    }
    return binding;
  }

  private resolveInput(
    input: NodeExecutionInputRecord,
    ports: readonly ScopePort[],
    workspaceId: string,
  ): RuntimeProcessingInput {
    const port = ports.find((candidate) => candidate.port_id === input.port_id);
    if (!port || port.direction !== "input") {
      throw unavailable(`input '${input.input_id}' does not reference an input Port in the pinned composition`);
    }
    const event = this.sources.get_event(input.event_id);
    if (!event || event.workspace_id !== workspaceId) {
      throw unavailable(`input Event '${input.event_id}' is unavailable in the execution Workspace`);
    }
    let artefact: RuntimeProcessingInput["artefact"] = null;
    if (input.artefact_version_id) {
      const version = this.sources.artefacts.getVersion(input.artefact_version_id);
      const identity = version ? this.sources.artefacts.getArtefact(version.artefact_id) : null;
      if (!version || !identity || identity.workspace_id !== workspaceId) {
        throw unavailable(`input ArtefactVersion '${input.artefact_version_id}' is unavailable in the execution Workspace`);
      }
      artefact = Object.freeze({ identity, version });
    }
    return Object.freeze({
      input_id: input.input_id,
      port: copyPort(port),
      delivery_id: input.delivery_id,
      member_key: input.member_key,
      event,
      artefact,
    });
  }
}

function unavailable(reason: string): RuntimeProcessingContractError {
  return new RuntimeProcessingContractError(reason);
}

function copyPort(port: ScopePort): ScopePort {
  return {
    ...port,
    event_types: port.event_types ? [...port.event_types] : undefined,
    artefact_types: port.artefact_types ? [...port.artefact_types] : undefined,
  };
}
