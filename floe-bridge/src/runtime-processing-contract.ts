import type { AgentRuntimeConfig } from "./auth.js";
import type { RuntimeDispatchContract } from "./bus-client.js";

export type PinnedRuntimeSelection = Readonly<{
  adapter_id: string;
  config: AgentRuntimeConfig;
  secret_ref_ids: readonly string[];
  resource_policy: Readonly<Record<string, unknown>>;
}>;

export class PinnedRuntimeContractError extends Error {
  readonly code = "runtime_processing_contract_invalid" as const;

  constructor(readonly reason: string) {
    super(`Pinned runtime processing contract is invalid: ${reason}`);
    this.name = "PinnedRuntimeContractError";
  }
}

/**
 * Converts one Bus-issued processing contract into adapter configuration.
 * Nothing is looked up by current Actor, Endpoint, Workspace, or provider
 * state here: every semantic choice comes from the recorded revision pins.
 */
export function selectPinnedRuntime(
  contract: RuntimeDispatchContract,
): PinnedRuntimeSelection {
  assertContractPins(contract);
  const configuration = contract.runtime.profile.content.configuration;
  const provider = optionalString(configuration.provider, "configuration.provider");
  const model = optionalString(configuration.model, "configuration.model");
  const authProfile = optionalString(
    configuration.auth_profile ?? configuration.auth_profile_id,
    "configuration.auth_profile",
  );
  const thinkingLevel = optionalThinkingLevel(configuration.thinking_level);
  const actorInstructions = contract.actor.definition.content.instructions.trim();
  const placementInstructions = contract.contract_kind === "scope_node"
    ? (contract.placement.bindings ?? [])
        .filter((binding) => binding.kind === "instructions" && binding.text.trim().length > 0)
        .map((binding) => binding.text.trim())
    : [];

  return Object.freeze({
    adapter_id: requiredString(contract.runtime.profile.content.adapter_id, "adapter_id"),
    config: Object.freeze({
      ...(provider ? { provider } : {}),
      ...(model ? { model, model_source: "runtime_profile_revision" } : {}),
      ...(authProfile ? {
        auth_profile: authProfile,
        auth_profile_source: "runtime_profile_revision",
      } : {}),
      ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
      ...(actorInstructions || placementInstructions.length > 0
        ? { instructions: [actorInstructions, ...placementInstructions].filter(Boolean).join("\n\n") }
        : {}),
    }),
    secret_ref_ids: Object.freeze([...contract.runtime.profile.content.secret_ref_ids]),
    resource_policy: Object.freeze({ ...contract.runtime.profile.content.resource_policy }),
  });
}

function assertContractPins(contract: RuntimeDispatchContract): void {
  if (contract.contract_version !== 1) fail("unsupported contract version");
  if (contract.workspace_id !== contract.actor.definition.workspace_id
    || contract.workspace_id !== contract.runtime.binding.workspace_id) {
    fail("Actor or runtime binding belongs to another Workspace");
  }
  if (contract.actor.definition.actor_id !== contract.actor.actor_id) {
    fail("Actor definition belongs to another Actor");
  }
  if (contract.runtime.binding.actor_id !== contract.actor.actor_id) {
    fail("runtime binding belongs to another Actor");
  }
  if (contract.runtime.binding.runtime_profile_revision_id
      !== contract.runtime.profile.runtime_profile_revision_id) {
    fail("runtime binding and runtime profile pins do not match");
  }

  if (contract.contract_kind === "direct_context") {
    if (contract.context.context_id !== contract.delivery.context_id) {
      fail("Context reference does not match the direct Delivery");
    }
    if (contract.runtime.binding.endpoint_id !== contract.delivery.endpoint_id) {
      fail("runtime binding does not own the direct Delivery Endpoint");
    }
    return;
  }

  if (contract.context.context_id !== contract.node_execution.context_id) {
    fail("Context reference does not match the NodeExecution");
  }
  if (contract.placement.node_id !== contract.node_execution.node_id
    || contract.placement.resource_id !== contract.actor.actor_id) {
    fail("Actor placement does not match the NodeExecution and Actor");
  }
  if (contract.execution_attempt.node_execution_id !== contract.node_execution.node_execution_id) {
    fail("ExecutionAttempt does not belong to the NodeExecution");
  }
  if (contract.actor.definition.actor_definition_revision_id
      !== contract.node_execution.actor_definition_revision_id
    || contract.execution_attempt.actor_definition_revision_id
      !== contract.node_execution.actor_definition_revision_id) {
    fail("Actor definition pins do not match");
  }
  if (contract.runtime.profile.runtime_profile_revision_id
      !== contract.node_execution.runtime_profile_revision_id
    || contract.execution_attempt.runtime_profile_revision_id
      !== contract.node_execution.runtime_profile_revision_id) {
    fail("runtime profile pins do not match");
  }
  if (contract.runtime.binding.actor_runtime_binding_id
      !== contract.node_execution.actor_runtime_binding_id
    || contract.execution_attempt.actor_runtime_binding_id
      !== contract.node_execution.actor_runtime_binding_id) {
    fail("Actor runtime binding pins do not match");
  }
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return value.trim();
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value, label);
  if (!result) fail(`${label} is required`);
  return result;
}

function optionalThinkingLevel(value: unknown): AgentRuntimeConfig["thinking_level"] {
  if (value === undefined || value === null || value === "") return undefined;
  if (!(value === "off" || value === "minimal" || value === "low" || value === "medium"
    || value === "high" || value === "xhigh")) {
    fail("configuration.thinking_level is unsupported");
  }
  return value;
}

function fail(reason: string): never {
  throw new PinnedRuntimeContractError(reason);
}
