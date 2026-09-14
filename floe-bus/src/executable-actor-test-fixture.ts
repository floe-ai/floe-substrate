import type { BusStore } from "./store.js";

/**
 * Give a legacy delivery endpoint the canonical Actor definition and runtime
 * binding required by Scope execution. This helper exists only for tests that
 * predate immutable Actor/runtime pins.
 */
export function registerExecutableActorFixture(
  store: BusStore,
  workspaceId: string,
  actorId: string,
): void {
  if (!store.getEndpoint(actorId)) {
    store.registerEndpoint({
      endpoint_id: actorId,
      workspace_id: workspaceId,
      name: actorId,
      bridge_id: null,
      status: "idle",
    }, () => {});
  }

  if (store.actorDefinitionStore.getActor(actorId)) return;

  const principalId = "principal:test-fixture";
  const runtimeGrant = store.capabilityGrantStore.issueGrant({
    principal_id: actorId,
    boundary: { kind: "workspace", workspace_id: workspaceId },
    operation_ids: ["context.inspect", "scope.node-output.publish"],
    expires_at: "2099-01-01T00:00:00.000Z",
    issuer_id: principalId,
    evidence: [{
      kind: "test_fixture",
      ref: "executable-actor-operation-authority",
    }],
  });
  const actor = store.actorDefinitionStore.createActor({
    actor_id: actorId,
    workspace_id: workspaceId,
    created_by_principal_id: principalId,
    definition: {
      label: actorId,
      charter: "Execute the bounded work assigned by this test.",
      responsibilities: [],
      instructions: "Complete the assigned work and report its result.",
      knowledge_refs: [],
      capability_grant_ids: [runtimeGrant.grant_id],
      policy_refs: { budget: null, trust: null, approval: null },
      escalation_rules: [],
    },
  });
  store.actorDefinitionStore.publishDraft({
    actor_definition_revision_id: actor.draft.actor_definition_revision_id,
    expected_current_revision_id: null,
    changed_by_principal_id: principalId,
  });

  const runtime = store.runtimeProfileStore.createProfile({
    runtime_profile_id: `runtime-profile:${actorId}`,
    owner: { kind: "workspace", id: workspaceId },
    created_by_principal_id: principalId,
    content: {
      label: `Runtime for ${actorId}`,
      backing_kind: "service",
      adapter_id: "adapter:test-fixture",
      configuration: {},
      secret_ref_ids: [],
      required_capability_ids: [],
      checkpoint_policy: { mode: "none", schema_ref: null },
      resource_policy: {},
    },
  });
  const runtimeRevision = store.runtimeProfileStore.publishDraft({
    runtime_profile_revision_id: runtime.draft.runtime_profile_revision_id,
    expected_current_revision_id: null,
    changed_by_principal_id: principalId,
  });
  store.runtimeProfileStore.bindActor({
    actor_id: actorId,
    runtime_profile_revision_id: runtimeRevision.runtime_profile_revision_id,
    endpoint_id: actorId,
    status: "resolved",
    expected_current_binding_id: null,
    created_by_principal_id: principalId,
  });
}
