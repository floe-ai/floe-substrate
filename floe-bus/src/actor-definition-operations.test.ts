import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ActorDefinitionStore, type ActorDefinitionContent } from "./actor-definitions.js";
import {
  CREATE_ACTOR_DEFINITION_DRAFT_OPERATION_ID,
  CREATE_ACTOR_OPERATION_ID,
  GET_ACTOR_DEFINITION_OPERATION_ID,
  INSPECT_ACTOR_OPERATION_ID,
  LIST_ACTORS_OPERATION_ID,
  NO_ACTOR_DEFINITION_REVISION,
  PUBLISH_ACTOR_DEFINITION_OPERATION_ID,
  REACTIVATE_ACTOR_OPERATION_ID,
  REPLACE_ACTOR_DEFINITION_DRAFT_OPERATION_ID,
  RETIRE_ACTOR_OPERATION_ID,
  ROLLBACK_ACTOR_DEFINITION_OPERATION_ID,
  actorDefinitionOperationDefinitions,
  registerActorDefinitionOperations,
} from "./actor-definition-operations.js";
import { AjvOperationSchemaValidator } from "./operation-schema-validator-ajv.js";
import { createTestOperationRegistry } from "./operation-test-fixtures.js";
import {
  type OperationAuthorityContext,
  type OperationInvocationEnvironment,
  type OperationInvocationRequest,
  type OperationInvocationResponse,
  type OperationInteractionMode,
  type ResolvedOperationResource,
} from "./operations.js";

const OPERATION_IDS = [
  LIST_ACTORS_OPERATION_ID,
  INSPECT_ACTOR_OPERATION_ID,
  GET_ACTOR_DEFINITION_OPERATION_ID,
  CREATE_ACTOR_OPERATION_ID,
  CREATE_ACTOR_DEFINITION_DRAFT_OPERATION_ID,
  REPLACE_ACTOR_DEFINITION_DRAFT_OPERATION_ID,
  PUBLISH_ACTOR_DEFINITION_OPERATION_ID,
  ROLLBACK_ACTOR_DEFINITION_OPERATION_ID,
  RETIRE_ACTOR_OPERATION_ID,
  REACTIVATE_ACTOR_OPERATION_ID,
] as const;

function definition(label: string): ActorDefinitionContent {
  return {
    label,
    charter: "Turn accepted outcomes into tested work.",
    responsibilities: [{
      responsibility_id: "build",
      title: "Build",
      description: "Build and verify the requested outcome.",
    }],
    instructions: `# ${label}\n\nUse exact evidence.`,
    knowledge_refs: [{ kind: "context", id: "context:product", revision: null }],
    capability_grant_ids: ["capgrant:workspace"],
    policy_refs: { budget: null, trust: null, approval: null },
    escalation_rules: [{
      rule_id: "outside-charter",
      when: "The request is outside this Actor's charter.",
      action: "signal_unowned",
    }],
  };
}

function authority(
  workspaceId = "workspace:one",
  mode: OperationInteractionMode = "interactive",
  grants: ReadonlySet<string> = new Set(OPERATION_IDS),
): OperationAuthorityContext & { boundary: { kind: "workspace"; workspace_id: string } } {
  return {
    principal_id: "principal:operator",
    boundary: { kind: "workspace", workspace_id: workspaceId },
    grants,
    interaction: {
      mode,
      session_id: "session:test",
      confirmed_prompts: new Set(),
      approval_refs: new Set(),
    },
  };
}

function environment(store: ActorDefinitionStore, auth = authority()): OperationInvocationEnvironment {
  return {
    authority: auth,
    resolve_resource: async (target): Promise<ResolvedOperationResource | null> => {
      if (target.kind === "actor") {
        const actor = store.getActor(target.id);
        return actor?.workspace_id === auth.boundary.workspace_id
          ? {
              ref: {
                ...target,
                revision: actor.current_definition_revision_id ?? NO_ACTOR_DEFINITION_REVISION,
              },
              state: actor,
            }
          : null;
      }
      if (target.kind === "actor_definition_revision") {
        const revision = store.getRevision(target.id);
        return revision?.workspace_id === auth.boundary.workspace_id
          ? { ref: { ...target, revision: revision.semantic_digest }, state: revision }
          : null;
      }
      return null;
    },
    now: () => "2026-09-04T04:00:00.000Z",
  };
}

function request(
  operationId: string,
  input: unknown,
  idempotencyKey: string,
  options: Readonly<{
    target?: { kind: string; id: string };
    expected_revision?: string;
  }> = {},
): OperationInvocationRequest {
  return {
    operation_id: operationId,
    operation_version: "1",
    input_schema_version: "1",
    input,
    idempotency_key: idempotencyKey,
    ...(options.target ? { target: options.target } : {}),
    ...(options.expected_revision !== undefined
      ? { expected_resource_revision: options.expected_revision }
      : {}),
  };
}

function receipt(response: OperationInvocationResponse) {
  expect(response.kind).toBe("receipt");
  if (response.kind !== "receipt") throw new Error("Expected operation receipt");
  return response.receipt;
}

describe("Actor definition semantic operations", () => {
  let db: DatabaseSync;
  let store: ActorDefinitionStore;
  let registry: ReturnType<typeof createTestOperationRegistry>;
  let tick: number;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    tick = 0;
    store = new ActorDefinitionStore(
      db,
      () => `2026-09-04T03:00:${String(tick++).padStart(2, "0")}.000Z`,
    );
    registry = registerActorDefinitionOperations(
      createTestOperationRegistry(new AjvOperationSchemaValidator()),
      store,
    );
  });

  afterEach(() => db.close());

  it("discovers one provider-neutral contract for interactive and unattended clients", async () => {
    const [interactive, unattended] = await Promise.all([
      registry.project({ authority: authority() }),
      registry.project({ authority: authority("workspace:one", "unattended") }),
    ]);

    expect(interactive).toEqual(unattended);
    expect(interactive.map((item) => item.operation_id)).toEqual(OPERATION_IDS);
    expect(interactive.every((item) =>
      item.required_grants.length === 1
      && item.required_grants[0] === item.operation_id
      && item.interaction_constraints.allowed_modes.includes("interactive")
      && item.interaction_constraints.allowed_modes.includes("unattended")
    )).toBe(true);
    expect(actorDefinitionOperationDefinitions(store)).toHaveLength(OPERATION_IDS.length);
  });

  it("uses explicit grants and refuses unsupported interaction modes during discovery", async () => {
    const withoutGrants = await registry.project({ authority: authority("workspace:one", "interactive", new Set()) });
    expect(withoutGrants.every((item) =>
      !item.availability.available
      && item.availability.refusal.code === "operation_grant_required"
    )).toBe(true);

    const brokered = await registry.project({ authority: authority("workspace:one", "brokered") });
    expect(brokered.every((item) =>
      !item.availability.available
      && item.availability.refusal.code === "operation_interaction_not_supported"
    )).toBe(true);
  });

  it("creates, revises, publishes, rolls back, retires, and reactivates one Actor idempotently", async () => {
    const createRequest = request(
      CREATE_ACTOR_OPERATION_ID,
      { actor_id: "actor:builder", definition: definition("Builder v1") },
      "create-builder",
    );
    const created = receipt(await registry.invoke(environment(store), createRequest));
    expect(created.state).toBe("completed");
    expect((created.result as any).actor).toMatchObject({
      actor_id: "actor:builder",
      workspace_id: "workspace:one",
      current_definition_revision_id: null,
    });
    expect((created.result as any).draft.created_by_principal_id).toBe("principal:operator");

    const replay = await registry.invoke(environment(store), createRequest);
    expect(replay).toMatchObject({ kind: "receipt", replayed: true });
    expect(store.listActors("workspace:one")).toHaveLength(1);

    const firstDraft = (created.result as any).draft;
    const firstPublished = receipt(await registry.invoke(
      environment(store),
      request(
        PUBLISH_ACTOR_DEFINITION_OPERATION_ID,
        { expected_current_definition_revision_id: null },
        "publish-v1",
        {
          target: { kind: "actor_definition_revision", id: firstDraft.actor_definition_revision_id },
          expected_revision: firstDraft.semantic_digest,
        },
      ),
    ));
    const firstRevisionId = (firstPublished.result as any).revision.actor_definition_revision_id as string;

    const drafted = receipt(await registry.invoke(
      environment(store),
      request(
        CREATE_ACTOR_DEFINITION_DRAFT_OPERATION_ID,
        { definition: definition("Builder v2") },
        "draft-v2",
        {
          target: { kind: "actor", id: "actor:builder" },
          expected_revision: firstRevisionId,
        },
      ),
    ));
    const secondDraft = (drafted.result as any).revision;

    const replaced = receipt(await registry.invoke(
      environment(store),
      request(
        REPLACE_ACTOR_DEFINITION_DRAFT_OPERATION_ID,
        { definition: definition("Builder v2 edited") },
        "replace-v2",
        {
          target: { kind: "actor_definition_revision", id: secondDraft.actor_definition_revision_id },
          expected_revision: secondDraft.semantic_digest,
        },
      ),
    ));
    const edited = (replaced.result as any).revision;
    expect(edited.content.label).toBe("Builder v2 edited");

    const secondPublished = receipt(await registry.invoke(
      environment(store),
      request(
        PUBLISH_ACTOR_DEFINITION_OPERATION_ID,
        { expected_current_definition_revision_id: firstRevisionId },
        "publish-v2",
        {
          target: { kind: "actor_definition_revision", id: edited.actor_definition_revision_id },
          expected_revision: edited.semantic_digest,
        },
      ),
    ));
    const secondRevisionId = (secondPublished.result as any).revision.actor_definition_revision_id as string;

    const rolledBack = receipt(await registry.invoke(
      environment(store),
      request(
        ROLLBACK_ACTOR_DEFINITION_OPERATION_ID,
        { to_published_revision_id: firstRevisionId },
        "rollback-v1",
        {
          target: { kind: "actor", id: "actor:builder" },
          expected_revision: secondRevisionId,
        },
      ),
    ));
    expect((rolledBack.result as any).actor.current_definition_revision_id).toBe(firstRevisionId);

    const retired = receipt(await registry.invoke(
      environment(store),
      request(
        RETIRE_ACTOR_OPERATION_ID,
        {},
        "retire-builder",
        {
          target: { kind: "actor", id: "actor:builder" },
          expected_revision: firstRevisionId,
        },
      ),
    ));
    expect((retired.result as any).actor.status).toBe("retired");

    const reactivated = receipt(await registry.invoke(
      environment(store),
      request(
        REACTIVATE_ACTOR_OPERATION_ID,
        {},
        "reactivate-builder",
        {
          target: { kind: "actor", id: "actor:builder" },
          expected_revision: firstRevisionId,
        },
      ),
    ));
    expect((reactivated.result as any).actor.status).toBe("active");
    expect(store.listRevisions("actor:builder")).toHaveLength(2);
    expect(store.listHeadChanges("actor:builder").map((item) => item.reason))
      .toEqual(["publish", "publish", "rollback"]);
  });

  it("lists and inspects only the authorised Workspace, with history secondary by default", async () => {
    const one = store.createActor({
      actor_id: "actor:one",
      workspace_id: "workspace:one",
      created_by_principal_id: "principal:operator",
      definition: definition("One"),
    });
    store.publishDraft({
      actor_definition_revision_id: one.draft.actor_definition_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: "principal:operator",
    });
    store.createDraft({
      actor_id: one.actor.actor_id,
      created_by_principal_id: "principal:operator",
      definition: definition("One draft"),
    });
    store.createActor({
      actor_id: "actor:other",
      workspace_id: "workspace:other",
      created_by_principal_id: "principal:other",
      definition: definition("Other"),
    });

    const listed = receipt(await registry.invoke(
      environment(store),
      request(LIST_ACTORS_OPERATION_ID, {}, "list-one"),
    ));
    expect((listed.result as any).actors.map((item: any) => item.actor.actor_id)).toEqual(["actor:one"]);

    const inspected = receipt(await registry.invoke(
      environment(store),
      request(
        INSPECT_ACTOR_OPERATION_ID,
        {},
        "inspect-one",
        { target: { kind: "actor", id: "actor:one" } },
      ),
    ));
    expect((inspected.result as any)).toMatchObject({ history_complete: false, head_changes: [] });
    expect((inspected.result as any).revisions).toHaveLength(2);

    const exact = receipt(await registry.invoke(
      environment(store),
      request(
        GET_ACTOR_DEFINITION_OPERATION_ID,
        {},
        "get-one-v1",
        {
          target: {
            kind: "actor_definition_revision",
            id: one.draft.actor_definition_revision_id,
          },
        },
      ),
    ));
    expect((exact.result as any).revision.actor_definition_revision_id)
      .toBe(one.draft.actor_definition_revision_id);

    const unavailable = await registry.project({
      authority: authority(),
      target: {
        ref: { kind: "actor", id: "actor:other", revision: NO_ACTOR_DEFINITION_REVISION },
      },
    });
    expect(unavailable.every((item) =>
      !item.availability.available
      && item.availability.refusal.code === "actor_not_found"
    )).toBe(true);
  });

  it("refuses stale expected revisions and invalid Actor definitions without changing retained state", async () => {
    const created = store.createActor({
      actor_id: "actor:builder",
      workspace_id: "workspace:one",
      created_by_principal_id: "principal:operator",
      definition: definition("Builder"),
    });
    const published = store.publishDraft({
      actor_definition_revision_id: created.draft.actor_definition_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: "principal:operator",
    });

    const stale = receipt(await registry.invoke(
      environment(store),
      request(
        CREATE_ACTOR_DEFINITION_DRAFT_OPERATION_ID,
        { definition: definition("Stale") },
        "stale-draft",
        {
          target: { kind: "actor", id: "actor:builder" },
          expected_revision: NO_ACTOR_DEFINITION_REVISION,
        },
      ),
    ));
    expect(stale).toMatchObject({
      state: "refused",
      refusal: { code: "operation_resource_revision_conflict", retryable: true },
    });

    const invalid = receipt(await registry.invoke(
      environment(store),
      request(
        CREATE_ACTOR_DEFINITION_DRAFT_OPERATION_ID,
        {
          definition: {
            ...definition("Invalid"),
            escalation_rules: [{
              rule_id: "delegate",
              when: "Another Actor owns this.",
              action: "delegate",
            }],
          },
        },
        "invalid-draft",
        {
          target: { kind: "actor", id: "actor:builder" },
          expected_revision: published.actor_definition_revision_id,
        },
      ),
    ));
    expect(invalid).toMatchObject({
      state: "refused",
      refusal: { code: "actor_definition_invalid" },
    });
    expect(store.listRevisions("actor:builder")).toHaveLength(1);
  });
});
