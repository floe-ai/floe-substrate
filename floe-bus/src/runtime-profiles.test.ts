import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ActorDefinitionStore, type ActorDefinitionContent } from "./actor-definitions.js";
import {
  ActorRuntimeBindingConflictError,
  RuntimeProfileImmutableError,
  RuntimeProfileStore,
  RuntimeProfileValidationError,
  type RuntimeProfileContent,
} from "./runtime-profiles.js";

const actorDefinition: ActorDefinitionContent = {
  label: "Builder",
  charter: "Build accepted work.",
  responsibilities: [],
  instructions: "Build and verify.",
  knowledge_refs: [],
  capability_grant_ids: [],
  policy_refs: { budget: null, trust: null, approval: null },
  escalation_rules: [],
};

function profile(label: string): RuntimeProfileContent {
  return {
    label,
    backing_kind: "model",
    adapter_id: "pi",
    configuration: { provider: "openai-codex", model: "gpt-5.6", reasoning_effort: "high" },
    secret_ref_ids: ["secretref:openai-codex"],
    required_capability_ids: ["workspace.files.read"],
    checkpoint_policy: { mode: "provider_neutral", schema_ref: "floe.runtime-checkpoint.v1" },
    resource_policy: { max_concurrent_turns: 1 },
  };
}

describe("RuntimeProfileStore", () => {
  let db: DatabaseSync;
  let actors: ActorDefinitionStore;
  let store: RuntimeProfileStore;
  let tick: number;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    tick = 0;
    const now = () => `2026-09-04T01:00:${String(tick++).padStart(2, "0")}.000Z`;
    actors = new ActorDefinitionStore(db, now);
    store = new RuntimeProfileStore(db, now);
  });

  afterEach(() => db.close());

  it("publishes immutable provider-neutral runtime profile revisions", () => {
    const created = store.createProfile({
      runtime_profile_id: "runtime-profile:codex",
      owner: { kind: "workspace", id: "workspace:one" },
      created_by_principal_id: "principal:operator",
      content: profile("Codex"),
    });
    const first = store.publishDraft({
      runtime_profile_revision_id: created.draft.runtime_profile_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: "principal:operator",
    });
    const nextDraft = store.createDraft({
      runtime_profile_id: created.profile.runtime_profile_id,
      created_by_principal_id: "principal:operator",
      content: { ...profile("Codex"), configuration: { provider: "openai-codex", model: "gpt-5.7" } },
    });
    store.publishDraft({
      runtime_profile_revision_id: nextDraft.runtime_profile_revision_id,
      expected_current_revision_id: first.runtime_profile_revision_id,
      changed_by_principal_id: "principal:operator",
    });

    expect(store.listRevisions(created.profile.runtime_profile_id)).toHaveLength(2);
    expect(() => store.replaceDraft({
      runtime_profile_revision_id: first.runtime_profile_revision_id,
      expected_digest: first.semantic_digest,
      content: profile("Mutated"),
    })).toThrow(RuntimeProfileImmutableError);
  });

  it("binds an Actor to an exact published profile revision and retains replaced bindings", () => {
    const actor = actors.createActor({
      actor_id: "actor:builder",
      workspace_id: "workspace:one",
      created_by_principal_id: "principal:operator",
      definition: actorDefinition,
    });
    actors.publishDraft({
      actor_definition_revision_id: actor.draft.actor_definition_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: "principal:operator",
    });
    const runtime = store.createProfile({
      runtime_profile_id: "runtime-profile:codex",
      owner: { kind: "workspace", id: "workspace:one" },
      created_by_principal_id: "principal:operator",
      content: profile("Codex"),
    });
    const revision = store.publishDraft({
      runtime_profile_revision_id: runtime.draft.runtime_profile_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: "principal:operator",
    });
    const first = store.bindActor({
      actor_id: actor.actor.actor_id,
      runtime_profile_revision_id: revision.runtime_profile_revision_id,
      endpoint_id: "endpoint:local-builder",
      status: "resolved",
      expected_current_binding_id: null,
      created_by_principal_id: "principal:operator",
    });
    const second = store.bindActor({
      actor_id: actor.actor.actor_id,
      runtime_profile_revision_id: revision.runtime_profile_revision_id,
      status: "unresolved",
      unresolved_reasons: ["SecretRef is not bound on this host."],
      expected_current_binding_id: first.actor_runtime_binding_id,
      created_by_principal_id: "principal:operator",
    });

    expect(store.getCurrentActorBinding(actor.actor.actor_id)?.actor_runtime_binding_id)
      .toBe(second.actor_runtime_binding_id);
    expect(store.requireActorBinding(first.actor_runtime_binding_id).superseded_at).not.toBeNull();
    expect(store.listActorBindings(actor.actor.actor_id)).toHaveLength(2);
  });

  it("uses compare-and-swap when replacing a runtime binding", () => {
    const actor = actors.createActor({
      actor_id: "actor:builder",
      workspace_id: "workspace:one",
      created_by_principal_id: "principal:operator",
      definition: actorDefinition,
    });
    const runtime = store.createProfile({
      runtime_profile_id: "runtime-profile:human",
      owner: { kind: "workspace", id: "workspace:one" },
      created_by_principal_id: "principal:operator",
      content: { ...profile("Human"), backing_kind: "human", adapter_id: "human-attention", secret_ref_ids: [] },
    });
    const revision = store.publishDraft({
      runtime_profile_revision_id: runtime.draft.runtime_profile_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: "principal:operator",
    });
    expect(() => store.bindActor({
      actor_id: actor.actor.actor_id,
      runtime_profile_revision_id: revision.runtime_profile_revision_id,
      status: "resolved",
      expected_current_binding_id: "stale",
      created_by_principal_id: "principal:operator",
    })).toThrow(ActorRuntimeBindingConflictError);
  });

  it("stores only SecretRef IDs and rejects likely credential material anywhere in policy data", () => {
    expect(() => store.createProfile({
      owner: { kind: "workspace", id: "workspace:one" },
      created_by_principal_id: "principal:operator",
      content: {
        ...profile("Unsafe"),
        configuration: { provider: { access_token: "plaintext" } },
      },
    })).toThrow(RuntimeProfileValidationError);
    expect(() => store.createProfile({
      owner: { kind: "workspace", id: "workspace:one" },
      created_by_principal_id: "principal:operator",
      content: {
        ...profile("Unsafe policy"),
        resource_policy: { nested: [{ apiKey: "plaintext" }] },
      },
    })).toThrow(RuntimeProfileValidationError);
  });

  it("records explicit rollback and retirement without deleting runtime history", () => {
    const created = store.createProfile({
      runtime_profile_id: "runtime-profile:service",
      owner: { kind: "deployment", id: "deployment:local" },
      created_by_principal_id: "principal:operator",
      content: { ...profile("Service v1"), backing_kind: "service", adapter_id: "worker" },
    });
    const first = store.publishDraft({
      runtime_profile_revision_id: created.draft.runtime_profile_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: "principal:operator",
    });
    const nextDraft = store.createDraft({
      runtime_profile_id: created.profile.runtime_profile_id,
      created_by_principal_id: "principal:operator",
      content: { ...profile("Service v2"), backing_kind: "service", adapter_id: "worker-v2" },
    });
    const second = store.publishDraft({
      runtime_profile_revision_id: nextDraft.runtime_profile_revision_id,
      expected_current_revision_id: first.runtime_profile_revision_id,
      changed_by_principal_id: "principal:operator",
    });

    store.rollback({
      runtime_profile_id: created.profile.runtime_profile_id,
      to_published_revision_id: first.runtime_profile_revision_id,
      expected_current_revision_id: second.runtime_profile_revision_id,
      changed_by_principal_id: "principal:operator",
    });
    const retired = store.setProfileStatus({
      runtime_profile_id: created.profile.runtime_profile_id,
      status: "retired",
      expected_current_revision_id: first.runtime_profile_revision_id,
    });

    expect(retired.status).toBe("retired");
    expect(store.listRevisions(created.profile.runtime_profile_id)).toHaveLength(2);
    expect(store.listHeadChanges(created.profile.runtime_profile_id).map((item) => item.reason))
      .toEqual(["publish", "publish", "rollback"]);
  });
});
