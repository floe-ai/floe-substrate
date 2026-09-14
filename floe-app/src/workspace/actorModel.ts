import { invokeOperation, listOperations } from "../bus-client/client.ts";
import type { ActorDefinitionRevision, ActorInspection, OperationInvocationRequest } from "../bus-client/types.ts";
import type { ActorRuntimeBindingRecord, RuntimeProfileRevision } from "../../../floe-bus/src/runtime-profiles.ts";
import { grantProviderRuntimeAccess, type ModelProviderStatus } from "../providers/modelProviders.ts";

export type ActorModel = { actor: ActorInspection; binding: ActorRuntimeBindingRecord; profile: RuntimeProfileRevision };
type Operations = Pick<typeof import("../bus-client/client.ts"), "invokeOperation" | "listOperations">;

function workspaceOperations(workspaceId: string, operations: Operations) {
  return async <T>(operationId: string, input: unknown, options: Partial<OperationInvocationRequest> = {}): Promise<T> => {
    const descriptor = (await operations.listOperations(workspaceId, options.target ?? undefined)).find(item => item.operation_id === operationId);
    if (!descriptor) throw new Error("This Floe installation cannot change model settings yet.");
    if (!descriptor.availability.available) throw new Error(descriptor.availability.refusal.message);
    const receipt = await operations.invokeOperation(workspaceId, {
      operation_id: descriptor.operation_id, operation_version: descriptor.operation_version, input_schema_version: descriptor.input.version,
      idempotency_key: `actor-model:${crypto.randomUUID()}`, input, ...options,
    });
    if (receipt.refusal) throw new Error(receipt.refusal.message);
    if (receipt.state !== "completed" || !receipt.result) throw new Error("Floe has not confirmed the model change. Refresh its saved state before retrying.");
    return receipt.result as T;
  };
}

/** Resolve the retained Endpoint binding, never a display name or Actor ID convention. */
export async function loadActorModel(workspaceId: string, endpointId: string, operations: Operations = { invokeOperation, listOperations }): Promise<ActorModel> {
  const invoke = workspaceOperations(workspaceId, operations);
  const { actors } = await invoke<{ actors: ActorInspection[] }>("actor.list", {});
  // Equal identifiers are common. They are only a search hint; the binding must prove ownership.
  const ordered = [...actors].sort((a, b) => Number(b.actor.actor_id === endpointId) - Number(a.actor.actor_id === endpointId));
  for (const actor of ordered) {
    const { current_binding: binding } = await invoke<{ current_binding: ActorRuntimeBindingRecord | null }>("actor.runtime-binding.inspect", {}, { target: { kind: "actor", id: actor.actor.actor_id } });
    if (binding?.endpoint_id !== endpointId) continue;
    const { revision: profile } = await invoke<{ revision: RuntimeProfileRevision }>("runtime-profile.revision.get", {}, { target: { kind: "runtime_profile_revision", id: binding.runtime_profile_revision_id } });
    return { actor, binding, profile };
  }
  throw new Error("This collaborator has no model connection yet.");
}

export async function saveActorModel(
  workspaceId: string, current: ActorModel, provider: ModelProviderStatus, model: string, effort: string,
  operations: Operations = { invokeOperation, listOperations },
  authorize = grantProviderRuntimeAccess,
): Promise<ActorModel> {
  const option = provider.models.find(item => item.id === model);
  if (!provider.connected || !provider.secret_ref_id || !option) throw new Error("Choose a connected account and an available model.");
  if (effort !== "off" && !option.reasoning_efforts.includes(effort)) throw new Error("Choose an effort supported by this model.");
  if (current.binding.status === "disabled") throw new Error("This collaborator's model connection was disabled. Restore it explicitly before choosing a model.");
  const invoke = workspaceOperations(workspaceId, operations);
  const actorId = current.actor.actor.actor_id;
  let definition = current.actor.current_definition;
  if (!definition) throw new Error("This collaborator has no published instructions yet.");
  const grantId = await authorize(provider, workspaceId, actorId);
  if (!definition.content.capability_grant_ids.includes(grantId)) {
    const { revision: draft } = await invoke<{ revision: ActorDefinitionRevision }>("actor.definition.draft.create", {
      based_on_revision_id: definition.actor_definition_revision_id,
      definition: { ...definition.content, capability_grant_ids: [...definition.content.capability_grant_ids, grantId] },
    }, { target: { kind: "actor", id: actorId }, expected_resource_revision: definition.actor_definition_revision_id });
    const published = await invoke<{ revision: ActorDefinitionRevision }>("actor.definition.publish", { expected_current_definition_revision_id: definition.actor_definition_revision_id }, {
      target: { kind: "actor_definition_revision", id: draft.actor_definition_revision_id }, expected_resource_revision: draft.semantic_digest,
    });
    definition = published.revision;
  }
  const { current_revision: head } = await invoke<{ current_revision: RuntimeProfileRevision | null }>("runtime-profile.inspect", {}, { target: { kind: "runtime_profile", id: current.profile.runtime_profile_id } });
  const configuration = { ...current.profile.content.configuration, provider: provider.provider, model, thinking_level: effort };
  delete (configuration as Record<string, unknown>).auth_profile;
  delete (configuration as Record<string, unknown>).auth_profile_id;
  const { revision: draft } = await invoke<{ revision: RuntimeProfileRevision }>("runtime-profile.draft.create", {
    based_on_revision_id: current.profile.runtime_profile_revision_id,
    content: { ...current.profile.content, backing_kind: "model", adapter_id: "pi-agent-core", configuration, secret_ref_ids: [provider.secret_ref_id] },
  }, { target: { kind: "runtime_profile", id: current.profile.runtime_profile_id }, expected_resource_revision: head?.runtime_profile_revision_id ?? "none" });
  const { revision: profile } = await invoke<{ revision: RuntimeProfileRevision }>("runtime-profile.publish", { expected_current_revision_id: head?.runtime_profile_revision_id ?? null }, {
    target: { kind: "runtime_profile_revision", id: draft.runtime_profile_revision_id }, expected_resource_revision: draft.semantic_digest,
  });
  const reasons = current.binding.unresolved_reasons.filter(reason => ![
    "runtime_credential_reference_missing", "runtime_credential_unresolved", "runtime_credential_authority_unresolved", "runtime_configuration_missing:model", "runtime_configuration_missing:provider",
  ].includes(reason));
  const { binding } = await invoke<{ binding: ActorRuntimeBindingRecord }>("actor.runtime-binding.replace", {
    runtime_profile_revision_id: profile.runtime_profile_revision_id, endpoint_id: current.binding.endpoint_id,
    status: reasons.length ? "unresolved" : "resolved", unresolved_reasons: reasons,
  }, { target: { kind: "actor_runtime_binding", id: current.binding.actor_runtime_binding_id }, expected_resource_revision: current.binding.actor_runtime_binding_id });
  return { actor: { ...current.actor, current_definition: definition, actor: { ...current.actor.actor, current_definition_revision_id: definition.actor_definition_revision_id } }, binding, profile };
}
