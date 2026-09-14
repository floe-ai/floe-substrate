import { invokeOperation, listOperations } from "../bus-client/client.ts";
import type { ActorDefinitionRevision, ActorInspection, ActorRecord, OperationInvocationRequest } from "../bus-client/types.ts";
import type { ActorRuntimeBindingRecord, RuntimeProfileRevision } from "../../../floe-bus/src/runtime-profiles.ts";

type Operations = Pick<typeof import("../bus-client/client.ts"), "invokeOperation" | "listOperations">;

/** Local client onboarding composed from the same Actor operations any client uses. */
export async function ensureInteractiveActor(
  workspaceId: string,
  operations: Operations = { invokeOperation, listOperations },
): Promise<ActorRecord> {
  async function invoke<T>(operationId: string, input: unknown, options: Partial<OperationInvocationRequest> = {}): Promise<T> {
    const descriptor = (await operations.listOperations(workspaceId, options.target ?? undefined))
      .find(item => item.operation_id === operationId);
    if (!descriptor) throw new Error("Floe cannot prepare your workspace participant yet.");
    if (!descriptor.availability.available) throw new Error(descriptor.availability.refusal.message);
    const receipt = await operations.invokeOperation(workspaceId, {
      operation_id: descriptor.operation_id,
      operation_version: descriptor.operation_version,
      input_schema_version: descriptor.input.version,
      idempotency_key: `interactive-actor:${crypto.randomUUID()}`,
      input,
      ...options,
    });
    if (receipt.refusal) throw new Error(receipt.refusal.message);
    if (receipt.state !== "completed" || !receipt.result) throw new Error("Floe is still preparing your participant. Reload to check the same setup.");
    return receipt.result as T;
  }

  // The principal comes from authenticated resolution, never a name or Endpoint suffix.
  const current = await invoke<{ principal_id: string; actor_ids: string[] }>("actor.roles.resolve_current", {});
  if (current.actor_ids.length > 0) {
    const inspection = await invoke<ActorInspection>("actor.inspect", { include_history: false }, {
      target: { kind: "actor", id: current.actor_ids[0]! },
    });
    if (inspection.actor.status !== "active" || !inspection.current_definition) throw new Error("Your workspace participant is unavailable. Its definition and access need attention before you can continue.");
    await prepareInteractiveRuntime(inspection.actor);
    return inspection.actor;
  }

  // A stable request survives reload, a lost response and concurrent tabs. This
  // identifier locates the onboarding record; only the retained binding gives authority.
  const actorId = `actor:${workspaceId}:${current.principal_id}`;
  const key = `interactive-actor:${actorId}`;
  const creation = {
    actor_id: actorId,
    definition: {
      label: "Workspace operator",
      charter: "Express outcomes, collaborate, and provide judgement in this workspace.",
      responsibilities: [], instructions: "Collaborate through the workspace's shared context and capabilities under your granted authority.", knowledge_refs: [], capability_grant_ids: [],
      policy_refs: { budget: null, trust: null, approval: null }, escalation_rules: [],
    },
  };
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(creation)))))
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  const created = await invoke<{ actor: ActorRecord; draft: ActorDefinitionRevision }>("actor.create", creation, { idempotency_key: `${key}:create:${digest}` });
  const target = { kind: "actor", id: actorId };
  const authority = await invoke<{ principal_bindings: Array<{ principal_id: string; status: string }> }>(
    "actor.authority.inspect", { include_history: true }, { target },
  );
  const bindings = authority.principal_bindings.filter(item => item.principal_id === current.principal_id);
  if (bindings.some(item => item.status === "revoked") && !bindings.some(item => item.status === "active")) {
    throw new Error("Your workspace participant's access was revoked. It must be restored explicitly before you can continue.");
  }
  const inspection = await invoke<ActorInspection>("actor.inspect", { include_history: false }, { target });
  if (inspection.actor.status !== "active") throw new Error("Your workspace participant has been retired. Restore it before continuing.");
  let actor = inspection.actor;
  if (!inspection.current_definition) {
    const published = await invoke<{ actor: ActorRecord }>("actor.definition.publish", {
      expected_current_definition_revision_id: null,
    }, {
      target: { kind: "actor_definition_revision", id: created.draft.actor_definition_revision_id },
      expected_resource_revision: created.draft.semantic_digest,
      idempotency_key: `${key}:publish`,
    });
    actor = published.actor;
  }
  if (!bindings.some(item => item.status === "active")) {
    await invoke("actor.principal.bind", { principal_id: current.principal_id }, { target, idempotency_key: `${key}:bind` });
  }
  await prepareInteractiveRuntime(actor);
  return actor;

  async function prepareInteractiveRuntime(actor: ActorRecord): Promise<void> {
    const target = { kind: "actor", id: actor.actor_id };
    const { current_binding: binding } = await invoke<{ current_binding: ActorRuntimeBindingRecord | null }>(
      "actor.runtime-binding.inspect", {}, { target },
    );
    // Opening the app must never replace a chosen runtime or re-enable one.
    if (binding) return;
    const key = `interactive-runtime:${actor.actor_id}`;
    const { draft } = await invoke<{ draft: RuntimeProfileRevision }>("runtime-profile.create", {
      runtime_profile_id: `runtime-profile:${actor.actor_id}:floe-app`,
      content: {
        label: "Floe app participation", backing_kind: "human", adapter_id: "floe-app",
        configuration: {}, secret_ref_ids: [], required_capability_ids: [],
        checkpoint_policy: { mode: "none", schema_ref: null }, resource_policy: {},
      },
    }, { idempotency_key: `${key}:create` });
    const { current_revision } = await invoke<{ current_revision: RuntimeProfileRevision | null }>(
      "runtime-profile.inspect", {}, { target: { kind: "runtime_profile", id: draft.runtime_profile_id } },
    );
    if (current_revision && current_revision.runtime_profile_revision_id !== draft.runtime_profile_revision_id) {
      throw new Error("Your app participation settings changed during setup. Inspect the saved settings before continuing.");
    }
    if (!current_revision) {
      await invoke("runtime-profile.publish", { expected_current_revision_id: null }, {
        target: { kind: "runtime_profile_revision", id: draft.runtime_profile_revision_id },
        expected_resource_revision: draft.semantic_digest, idempotency_key: `${key}:publish`,
      });
    }
    // The client reads assigned work and publishes through semantic operations.
    // It does not register a model worker or claim a Bridge delivery session.
    await invoke("actor.runtime-binding.create", {
      runtime_profile_revision_id: draft.runtime_profile_revision_id, status: "resolved",
    }, {
      target, expected_resource_revision: actor.current_definition_revision_id!,
      idempotency_key: `${key}:bind:${actor.current_definition_revision_id}`,
    });
  }
}
