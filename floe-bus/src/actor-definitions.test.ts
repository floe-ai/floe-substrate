import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ActorDefinitionConflictError,
  ActorDefinitionDraftConflictError,
  ActorDefinitionImmutableError,
  ActorDefinitionStore,
  ActorDefinitionValidationError,
  type ActorDefinitionContent,
} from "./actor-definitions.js";

function definition(label: string): ActorDefinitionContent {
  return {
    label,
    charter: "Turn an accepted brief into a tested implementation.",
    responsibilities: [{
      responsibility_id: "build",
      title: "Build",
      description: "Produce and verify the requested implementation.",
    }],
    instructions: `# ${label}\n\nUse exact evidence.`,
    knowledge_refs: [{ kind: "context", id: "context:product", revision: null }],
    capability_grant_ids: ["capgrant:workspace-files"],
    policy_refs: {
      budget: { kind: "policy", id: "policy:budget", revision: "v1" },
      trust: null,
      approval: { kind: "policy", id: "policy:release", revision: "v3" },
    },
    escalation_rules: [{
      rule_id: "outside-charter",
      when: "The request is outside the charter.",
      action: "signal_unowned",
    }],
  };
}

describe("ActorDefinitionStore", () => {
  let db: DatabaseSync;
  let store: ActorDefinitionStore;
  let tick: number;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    tick = 0;
    store = new ActorDefinitionStore(db, () => `2026-09-04T00:00:${String(tick++).padStart(2, "0")}.000Z`);
  });

  afterEach(() => db.close());

  it("keeps stable Actor identity while publishing immutable definition revisions", () => {
    const created = store.createActor({
      actor_id: "actor:builder",
      workspace_id: "workspace:one",
      created_by_principal_id: "principal:operator",
      definition: definition("Builder"),
    });
    expect(created.actor.current_definition_revision_id).toBeNull();

    const first = store.publishDraft({
      actor_definition_revision_id: created.draft.actor_definition_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: "principal:operator",
    });
    const secondDraft = store.createDraft({
      actor_id: created.actor.actor_id,
      created_by_principal_id: "actor:floe",
      definition: definition("Application Builder"),
    });
    const second = store.publishDraft({
      actor_definition_revision_id: secondDraft.actor_definition_revision_id,
      expected_current_revision_id: first.actor_definition_revision_id,
      changed_by_principal_id: "actor:floe",
    });

    expect(store.requireActor(created.actor.actor_id)).toMatchObject({
      actor_id: "actor:builder",
      current_definition_revision_id: second.actor_definition_revision_id,
    });
    expect(store.listRevisions(created.actor.actor_id).map((item) => item.revision_number)).toEqual([2, 1]);
    expect(() => store.replaceDraft({
      actor_definition_revision_id: first.actor_definition_revision_id,
      expected_digest: first.semantic_digest,
      definition: definition("Mutated"),
    })).toThrow(ActorDefinitionImmutableError);
  });

  it("uses compare-and-swap for draft edits and current-head publication", () => {
    const { draft } = store.createActor({
      actor_id: "actor:judge",
      workspace_id: "workspace:one",
      created_by_principal_id: "principal:operator",
      definition: definition("Judge"),
    });

    expect(() => store.replaceDraft({
      actor_definition_revision_id: draft.actor_definition_revision_id,
      expected_digest: "stale",
      definition: definition("Quality Judge"),
    })).toThrow(ActorDefinitionDraftConflictError);
    const edited = store.replaceDraft({
      actor_definition_revision_id: draft.actor_definition_revision_id,
      expected_digest: draft.semantic_digest,
      definition: definition("Quality Judge"),
    });
    expect(edited.semantic_digest).not.toBe(draft.semantic_digest);
    expect(() => store.publishDraft({
      actor_definition_revision_id: edited.actor_definition_revision_id,
      expected_current_revision_id: "another-revision",
      changed_by_principal_id: "principal:operator",
    })).toThrow(ActorDefinitionConflictError);
  });

  it("rolls the current head back explicitly without rewriting either revision", () => {
    const { actor, draft } = store.createActor({
      actor_id: "actor:architect",
      workspace_id: "workspace:one",
      created_by_principal_id: "principal:operator",
      definition: definition("Architect v1"),
    });
    const first = store.publishDraft({
      actor_definition_revision_id: draft.actor_definition_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: "principal:operator",
    });
    const nextDraft = store.createDraft({
      actor_id: actor.actor_id,
      created_by_principal_id: "principal:operator",
      definition: definition("Architect v2"),
    });
    const second = store.publishDraft({
      actor_definition_revision_id: nextDraft.actor_definition_revision_id,
      expected_current_revision_id: first.actor_definition_revision_id,
      changed_by_principal_id: "principal:operator",
    });

    store.rollback({
      actor_id: actor.actor_id,
      to_published_revision_id: first.actor_definition_revision_id,
      expected_current_revision_id: second.actor_definition_revision_id,
      changed_by_principal_id: "principal:operator",
    });

    expect(store.getCurrentDefinition(actor.actor_id)?.content.label).toBe("Architect v1");
    expect(store.requireRevision(second.actor_definition_revision_id).content.label).toBe("Architect v2");
    expect(store.listHeadChanges(actor.actor_id).map((item) => item.reason)).toEqual([
      "publish",
      "publish",
      "rollback",
    ]);
  });

  it("retires and restores an Actor without deleting definitions", () => {
    const { actor, draft } = store.createActor({
      actor_id: "actor:reviewer",
      workspace_id: "workspace:one",
      created_by_principal_id: "principal:operator",
      definition: definition("Reviewer"),
    });
    const published = store.publishDraft({
      actor_definition_revision_id: draft.actor_definition_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: "principal:operator",
    });
    expect(store.setActorStatus({
      actor_id: actor.actor_id,
      status: "retired",
      expected_current_definition_revision_id: published.actor_definition_revision_id,
    }).status).toBe("retired");
    expect(store.listActors("workspace:one")).toHaveLength(0);
    expect(store.listActors("workspace:one", { include_retired: true })).toHaveLength(1);
    expect(store.getCurrentDefinition(actor.actor_id)?.actor_definition_revision_id)
      .toBe(published.actor_definition_revision_id);
    expect(store.setActorStatus({
      actor_id: actor.actor_id,
      status: "active",
      expected_current_definition_revision_id: published.actor_definition_revision_id,
    }).status).toBe("active");
  });

  it("rejects ambiguous delegation and cross-Actor ancestry", () => {
    const invalid = {
      ...definition("Invalid"),
      escalation_rules: [{
        rule_id: "delegate",
        when: "Another Actor owns this.",
        action: "delegate" as const,
      }],
    };
    expect(() => store.createActor({
      actor_id: "actor:invalid",
      workspace_id: "workspace:one",
      created_by_principal_id: "principal:operator",
      definition: invalid,
    })).toThrow(ActorDefinitionValidationError);

    const first = store.createActor({
      actor_id: "actor:first",
      workspace_id: "workspace:one",
      created_by_principal_id: "principal:operator",
      definition: definition("First"),
    });
    const second = store.createActor({
      actor_id: "actor:second",
      workspace_id: "workspace:one",
      created_by_principal_id: "principal:operator",
      definition: definition("Second"),
    });
    expect(() => store.createDraft({
      actor_id: second.actor.actor_id,
      based_on_revision_id: first.draft.actor_definition_revision_id,
      created_by_principal_id: "principal:operator",
      definition: definition("Second v2"),
    })).toThrow(ActorDefinitionValidationError);
  });
});
