import { beforeEach, describe, expect, it, vi } from "vitest";

import * as client from "../bus-client/client.ts";
import type {
  ActorDefinitionContent,
  ActorDefinitionRevision,
  ActorRecord,
  OperationInvocationReceipt,
  SemanticOperationDescriptor,
} from "../bus-client/types.ts";
import {
  ACTOR_DEFINITION_DRAFT_CREATE_OPERATION_ID,
  ACTOR_DEFINITION_PUBLISH_OPERATION_ID,
  ACTOR_INSPECT_OPERATION_ID,
  reviseActorDefinition,
} from "./actorDefinitionOperations.ts";

vi.mock("../bus-client/client.ts", () => ({
  invokeOperation: vi.fn(),
  listOperations: vi.fn(),
}));

const actor: ActorRecord = {
  actor_id: "actor:builder",
  workspace_id: "workspace:one",
  status: "active",
  current_definition_revision_id: "actor-definition:1",
  created_at: "2026-09-04T00:00:00.000Z",
  updated_at: "2026-09-04T00:00:00.000Z",
  retired_at: null,
};

const content: ActorDefinitionContent = {
  label: "Builder",
  charter: "Build accepted work.",
  responsibilities: [],
  instructions: "Build and verify.",
  knowledge_refs: [],
  capability_grant_ids: ["grant:builder"],
  policy_refs: { budget: null, trust: null, approval: null },
  escalation_rules: [],
};

function revision(id: string, digest: string, value = content): ActorDefinitionRevision {
  return {
    actor_definition_revision_id: id,
    actor_id: actor.actor_id,
    workspace_id: actor.workspace_id,
    revision_number: id.endsWith("2") ? 2 : 1,
    based_on_revision_id: id.endsWith("2") ? "actor-definition:1" : null,
    semantic_digest: digest,
    content: value,
    created_by_principal_id: "principal:operator",
    created_at: "2026-09-04T00:00:00.000Z",
    published_at: id.endsWith("1") ? "2026-09-04T00:00:00.000Z" : null,
    withdrawn_at: null,
  };
}

function descriptor(id: string): SemanticOperationDescriptor {
  return {
    operation_id: id,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "actors",
    title: id,
    description: id,
    effects: { mode: id === ACTOR_INSPECT_OPERATION_ID ? "read" : "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [id],
    interaction_constraints: {},
    target: { resource_kinds: ["actor"], expected_revision: "required" },
    input: { version: "1", schema: {} },
    result: { version: "1", schema: {} },
    availability: { available: true },
  };
}

function receipt(result: unknown): OperationInvocationReceipt {
  return { state: "completed", result, refusal: null } as OperationInvocationReceipt;
}

describe("canonical Actor definition editing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.listOperations).mockImplementation(async (_workspaceId, target) => [
      descriptor(target?.kind === "actor_definition_revision"
        ? ACTOR_DEFINITION_PUBLISH_OPERATION_ID
        : target
          ? ACTOR_INSPECT_OPERATION_ID
          : ACTOR_INSPECT_OPERATION_ID),
      ...(target?.kind === "actor" ? [descriptor(ACTOR_DEFINITION_DRAFT_CREATE_OPERATION_ID)] : []),
    ]);
    const current = revision("actor-definition:1", "digest:1");
    const draft = revision("actor-definition:2", "digest:2", { ...content, label: "Delivery Builder" });
    vi.mocked(client.invokeOperation)
      .mockResolvedValueOnce(receipt({ actor, current_definition: current, history_complete: false, revisions: [current], head_changes: [] }))
      .mockResolvedValueOnce(receipt({ actor, revision: draft }))
      .mockResolvedValueOnce(receipt({ actor: { ...actor, current_definition_revision_id: draft.actor_definition_revision_id }, revision: { ...draft, published_at: "2026-09-04T00:01:00.000Z" } }));
  });

  it("creates and publishes an immutable revision through discovered operations", async () => {
    await reviseActorDefinition("workspace:one", actor.actor_id, current => ({
      ...current,
      label: "Delivery Builder",
    }));

    expect(client.invokeOperation).toHaveBeenNthCalledWith(2, "workspace:one", expect.objectContaining({
      operation_id: ACTOR_DEFINITION_DRAFT_CREATE_OPERATION_ID,
      target: { kind: "actor", id: actor.actor_id },
      expected_resource_revision: "actor-definition:1",
      input: {
        based_on_revision_id: "actor-definition:1",
        definition: { ...content, label: "Delivery Builder" },
      },
    }));
    expect(client.invokeOperation).toHaveBeenNthCalledWith(3, "workspace:one", expect.objectContaining({
      operation_id: ACTOR_DEFINITION_PUBLISH_OPERATION_ID,
      target: { kind: "actor_definition_revision", id: "actor-definition:2" },
      expected_resource_revision: "digest:2",
      input: { expected_current_definition_revision_id: "actor-definition:1" },
    }));
  });
});
