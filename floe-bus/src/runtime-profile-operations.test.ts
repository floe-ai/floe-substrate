import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ActorDefinitionStore, type ActorDefinitionContent } from "./actor-definitions.js";
import { NO_ACTOR_DEFINITION_REVISION } from "./actor-definition-operations.js";
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
import {
  CREATE_ACTOR_RUNTIME_BINDING_OPERATION_ID,
  CREATE_RUNTIME_PROFILE_DRAFT_OPERATION_ID,
  CREATE_RUNTIME_PROFILE_OPERATION_ID,
  GET_ACTOR_RUNTIME_BINDING_OPERATION_ID,
  GET_RUNTIME_PROFILE_REVISION_OPERATION_ID,
  INSPECT_ACTOR_RUNTIME_BINDING_OPERATION_ID,
  INSPECT_RUNTIME_PROFILE_OPERATION_ID,
  LIST_RUNTIME_PROFILES_OPERATION_ID,
  NO_RUNTIME_PROFILE_REVISION,
  PUBLISH_RUNTIME_PROFILE_OPERATION_ID,
  REACTIVATE_RUNTIME_PROFILE_OPERATION_ID,
  REPLACE_ACTOR_RUNTIME_BINDING_OPERATION_ID,
  REPLACE_RUNTIME_PROFILE_DRAFT_OPERATION_ID,
  RETIRE_RUNTIME_PROFILE_OPERATION_ID,
  ROLLBACK_RUNTIME_PROFILE_OPERATION_ID,
  registerRuntimeProfileOperations,
  runtimeProfileOperationDefinitions,
} from "./runtime-profile-operations.js";
import { RuntimeProfileStore, type RuntimeProfileContent } from "./runtime-profiles.js";

const OPERATION_IDS = [
  LIST_RUNTIME_PROFILES_OPERATION_ID,
  INSPECT_RUNTIME_PROFILE_OPERATION_ID,
  GET_RUNTIME_PROFILE_REVISION_OPERATION_ID,
  CREATE_RUNTIME_PROFILE_OPERATION_ID,
  CREATE_RUNTIME_PROFILE_DRAFT_OPERATION_ID,
  REPLACE_RUNTIME_PROFILE_DRAFT_OPERATION_ID,
  PUBLISH_RUNTIME_PROFILE_OPERATION_ID,
  ROLLBACK_RUNTIME_PROFILE_OPERATION_ID,
  RETIRE_RUNTIME_PROFILE_OPERATION_ID,
  REACTIVATE_RUNTIME_PROFILE_OPERATION_ID,
  INSPECT_ACTOR_RUNTIME_BINDING_OPERATION_ID,
  GET_ACTOR_RUNTIME_BINDING_OPERATION_ID,
  CREATE_ACTOR_RUNTIME_BINDING_OPERATION_ID,
  REPLACE_ACTOR_RUNTIME_BINDING_OPERATION_ID,
] as const;

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

function profile(label: string, model = "general-latest"): RuntimeProfileContent {
  return {
    label,
    backing_kind: "model",
    adapter_id: "runtime-adapter",
    configuration: { model, reasoning_effort: "high" },
    secret_ref_ids: ["secretref:subscription"],
    required_capability_ids: ["workspace.files.read"],
    checkpoint_policy: { mode: "provider_neutral", schema_ref: "floe.runtime-checkpoint.v1" },
    resource_policy: { max_concurrent_turns: 1 },
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

function environment(
  store: RuntimeProfileStore,
  actors: ActorDefinitionStore,
  auth = authority(),
): OperationInvocationEnvironment {
  return {
    authority: auth,
    resolve_resource: async (target): Promise<ResolvedOperationResource | null> => {
      if (target.kind === "runtime_profile") {
        const value = store.getProfile(target.id);
        return value?.owner.kind === "workspace" && value.owner.id === auth.boundary.workspace_id
          ? {
              ref: {
                ...target,
                revision: value.current_revision_id ?? NO_RUNTIME_PROFILE_REVISION,
              },
              state: value,
            }
          : null;
      }
      if (target.kind === "runtime_profile_revision") {
        const revision = store.getRevision(target.id);
        const owner = revision ? store.getProfile(revision.runtime_profile_id)?.owner : null;
        return revision && owner?.kind === "workspace" && owner.id === auth.boundary.workspace_id
          ? { ref: { ...target, revision: revision.semantic_digest }, state: revision }
          : null;
      }
      if (target.kind === "actor") {
        const actor = actors.getActor(target.id);
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
      if (target.kind === "actor_runtime_binding") {
        try {
          const binding = store.requireActorBinding(target.id);
          return binding.workspace_id === auth.boundary.workspace_id
            ? {
                ref: { ...target, revision: binding.actor_runtime_binding_id },
                state: binding,
              }
            : null;
        } catch {
          return null;
        }
      }
      return null;
    },
    now: () => "2026-09-04T06:00:00.000Z",
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

describe("Runtime Profile semantic operations", () => {
  let db: DatabaseSync;
  let actors: ActorDefinitionStore;
  let store: RuntimeProfileStore;
  let registry: ReturnType<typeof createTestOperationRegistry>;
  let tick: number;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    tick = 0;
    const now = () => `2026-09-04T05:00:${String(tick++).padStart(2, "0")}.000Z`;
    actors = new ActorDefinitionStore(db, now);
    store = new RuntimeProfileStore(db, now);
    registry = registerRuntimeProfileOperations(
      createTestOperationRegistry(new AjvOperationSchemaValidator()),
      store,
    );
  });

  afterEach(() => db.close());

  it("discovers one provider-neutral, SecretRef-only contract with explicit grants", async () => {
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
    const contract = JSON.stringify(interactive);
    expect(contract).toContain("secret_ref_ids");
    expect(contract).not.toMatch(/openai|anthropic|gemini|copilot|api_key|access_token/i);
    expect(runtimeProfileOperationDefinitions(store)).toHaveLength(OPERATION_IDS.length);

    const withoutGrants = await registry.project({
      authority: authority("workspace:one", "interactive", new Set()),
    });
    expect(withoutGrants.every((item) =>
      !item.availability.available
      && item.availability.refusal.code === "operation_grant_required"
    )).toBe(true);
  });

  it("creates, revises, publishes, rolls back, retires, and reactivates one Workspace-owned profile", async () => {
    const createRequest = request(
      CREATE_RUNTIME_PROFILE_OPERATION_ID,
      { runtime_profile_id: "runtime-profile:default", content: profile("Default v1") },
      "create-default",
    );
    const created = receipt(await registry.invoke(environment(store, actors), createRequest));
    expect(created.state).toBe("completed");
    expect((created.result as any).profile).toMatchObject({
      runtime_profile_id: "runtime-profile:default",
      owner: { kind: "workspace", id: "workspace:one" },
      current_revision_id: null,
    });
    expect((created.result as any).draft.content.secret_ref_ids)
      .toEqual(["secretref:subscription"]);

    const replay = await registry.invoke(environment(store, actors), createRequest);
    expect(replay).toMatchObject({ kind: "receipt", replayed: true });

    const firstDraft = (created.result as any).draft;
    const firstPublished = receipt(await registry.invoke(
      environment(store, actors),
      request(
        PUBLISH_RUNTIME_PROFILE_OPERATION_ID,
        { expected_current_revision_id: null },
        "publish-default-v1",
        {
          target: { kind: "runtime_profile_revision", id: firstDraft.runtime_profile_revision_id },
          expected_revision: firstDraft.semantic_digest,
        },
      ),
    ));
    const firstRevisionId = (firstPublished.result as any).revision.runtime_profile_revision_id as string;

    const drafted = receipt(await registry.invoke(
      environment(store, actors),
      request(
        CREATE_RUNTIME_PROFILE_DRAFT_OPERATION_ID,
        { content: profile("Default v2", "general-next") },
        "draft-default-v2",
        {
          target: { kind: "runtime_profile", id: "runtime-profile:default" },
          expected_revision: firstRevisionId,
        },
      ),
    ));
    const secondDraft = (drafted.result as any).revision;

    const replaced = receipt(await registry.invoke(
      environment(store, actors),
      request(
        REPLACE_RUNTIME_PROFILE_DRAFT_OPERATION_ID,
        { content: profile("Default v2 edited", "general-next") },
        "replace-default-v2",
        {
          target: { kind: "runtime_profile_revision", id: secondDraft.runtime_profile_revision_id },
          expected_revision: secondDraft.semantic_digest,
        },
      ),
    ));
    const edited = (replaced.result as any).revision;

    const secondPublished = receipt(await registry.invoke(
      environment(store, actors),
      request(
        PUBLISH_RUNTIME_PROFILE_OPERATION_ID,
        { expected_current_revision_id: firstRevisionId },
        "publish-default-v2",
        {
          target: { kind: "runtime_profile_revision", id: edited.runtime_profile_revision_id },
          expected_revision: edited.semantic_digest,
        },
      ),
    ));
    const secondRevisionId = (secondPublished.result as any).revision.runtime_profile_revision_id as string;

    const rolledBack = receipt(await registry.invoke(
      environment(store, actors),
      request(
        ROLLBACK_RUNTIME_PROFILE_OPERATION_ID,
        { to_published_revision_id: firstRevisionId },
        "rollback-default-v1",
        {
          target: { kind: "runtime_profile", id: "runtime-profile:default" },
          expected_revision: secondRevisionId,
        },
      ),
    ));
    expect((rolledBack.result as any).profile.current_revision_id).toBe(firstRevisionId);

    const retired = receipt(await registry.invoke(
      environment(store, actors),
      request(
        RETIRE_RUNTIME_PROFILE_OPERATION_ID,
        {},
        "retire-default",
        {
          target: { kind: "runtime_profile", id: "runtime-profile:default" },
          expected_revision: firstRevisionId,
        },
      ),
    ));
    expect((retired.result as any).profile.status).toBe("retired");

    const reactivated = receipt(await registry.invoke(
      environment(store, actors),
      request(
        REACTIVATE_RUNTIME_PROFILE_OPERATION_ID,
        {},
        "reactivate-default",
        {
          target: { kind: "runtime_profile", id: "runtime-profile:default" },
          expected_revision: firstRevisionId,
        },
      ),
    ));
    expect((reactivated.result as any).profile.status).toBe("active");
    expect(store.listRevisions("runtime-profile:default")).toHaveLength(2);
    expect(store.listHeadChanges("runtime-profile:default").map((item) => item.reason))
      .toEqual(["publish", "publish", "rollback"]);
  });

  it("lists, inspects, and gets only Runtime Profiles owned by the authorised Workspace", async () => {
    const local = store.createProfile({
      runtime_profile_id: "runtime-profile:local",
      owner: { kind: "workspace", id: "workspace:one" },
      created_by_principal_id: "principal:operator",
      content: profile("Local"),
    });
    const published = store.publishDraft({
      runtime_profile_revision_id: local.draft.runtime_profile_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: "principal:operator",
    });
    store.createDraft({
      runtime_profile_id: local.profile.runtime_profile_id,
      created_by_principal_id: "principal:operator",
      content: profile("Local draft"),
    });
    store.createProfile({
      runtime_profile_id: "runtime-profile:host",
      owner: { kind: "host", id: "host:one" },
      created_by_principal_id: "principal:host",
      content: profile("Host"),
    });
    store.createProfile({
      runtime_profile_id: "runtime-profile:other",
      owner: { kind: "workspace", id: "workspace:other" },
      created_by_principal_id: "principal:other",
      content: profile("Other"),
    });

    const listed = receipt(await registry.invoke(
      environment(store, actors),
      request(LIST_RUNTIME_PROFILES_OPERATION_ID, {}, "list-local"),
    ));
    expect((listed.result as any).profiles.map((item: any) => item.profile.runtime_profile_id))
      .toEqual(["runtime-profile:local"]);

    const inspected = receipt(await registry.invoke(
      environment(store, actors),
      request(
        INSPECT_RUNTIME_PROFILE_OPERATION_ID,
        {},
        "inspect-local",
        { target: { kind: "runtime_profile", id: "runtime-profile:local" } },
      ),
    ));
    expect((inspected.result as any)).toMatchObject({ history_complete: false, head_changes: [] });
    expect((inspected.result as any).revisions).toHaveLength(2);

    const exact = receipt(await registry.invoke(
      environment(store, actors),
      request(
        GET_RUNTIME_PROFILE_REVISION_OPERATION_ID,
        {},
        "get-local",
        {
          target: {
            kind: "runtime_profile_revision",
            id: published.runtime_profile_revision_id,
          },
        },
      ),
    ));
    expect((exact.result as any).revision.runtime_profile_revision_id)
      .toBe(published.runtime_profile_revision_id);

    const hostProjection = await registry.project({
      authority: authority(),
      target: {
        ref: {
          kind: "runtime_profile",
          id: "runtime-profile:host",
          revision: NO_RUNTIME_PROFILE_REVISION,
        },
      },
    });
    expect(hostProjection.every((item) =>
      !item.availability.available
      && item.availability.refusal.code === "runtime_profile_not_found"
    )).toBe(true);
  });

  it("creates and replaces exact Actor Runtime Bindings while retaining superseded evidence", async () => {
    const actor = actors.createActor({
      actor_id: "actor:builder",
      workspace_id: "workspace:one",
      created_by_principal_id: "principal:operator",
      definition: actorDefinition,
    });
    const actorRevision = actors.publishDraft({
      actor_definition_revision_id: actor.draft.actor_definition_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: "principal:operator",
    });
    const runtime = store.createProfile({
      runtime_profile_id: "runtime-profile:default",
      owner: { kind: "workspace", id: "workspace:one" },
      created_by_principal_id: "principal:operator",
      content: profile("Default"),
    });
    const runtimeRevision = store.publishDraft({
      runtime_profile_revision_id: runtime.draft.runtime_profile_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: "principal:operator",
    });

    const created = receipt(await registry.invoke(
      environment(store, actors),
      request(
        CREATE_ACTOR_RUNTIME_BINDING_OPERATION_ID,
        {
          runtime_profile_revision_id: runtimeRevision.runtime_profile_revision_id,
          status: "unresolved",
          unresolved_reasons: ["SecretRef is not bound on this host."],
        },
        "bind-builder",
        {
          target: { kind: "actor", id: "actor:builder" },
          expected_revision: actorRevision.actor_definition_revision_id,
        },
      ),
    ));
    const firstBinding = (created.result as any).binding;
    expect(firstBinding).toMatchObject({
      actor_id: "actor:builder",
      runtime_profile_revision_id: runtimeRevision.runtime_profile_revision_id,
      status: "unresolved",
    });

    const inspected = receipt(await registry.invoke(
      environment(store, actors),
      request(
        INSPECT_ACTOR_RUNTIME_BINDING_OPERATION_ID,
        {},
        "inspect-binding",
        { target: { kind: "actor", id: "actor:builder" } },
      ),
    ));
    expect((inspected.result as any).bindings).toHaveLength(1);

    const exact = receipt(await registry.invoke(
      environment(store, actors),
      request(
        GET_ACTOR_RUNTIME_BINDING_OPERATION_ID,
        {},
        "get-binding",
        {
          target: { kind: "actor_runtime_binding", id: firstBinding.actor_runtime_binding_id },
        },
      ),
    ));
    expect((exact.result as any).binding.actor_runtime_binding_id)
      .toBe(firstBinding.actor_runtime_binding_id);

    const replaced = receipt(await registry.invoke(
      environment(store, actors),
      request(
        REPLACE_ACTOR_RUNTIME_BINDING_OPERATION_ID,
        {
          runtime_profile_revision_id: runtimeRevision.runtime_profile_revision_id,
          endpoint_id: "endpoint:builder",
          status: "resolved",
          unresolved_reasons: [],
        },
        "replace-binding",
        {
          target: { kind: "actor_runtime_binding", id: firstBinding.actor_runtime_binding_id },
          expected_revision: firstBinding.actor_runtime_binding_id,
        },
      ),
    ));
    const secondBinding = (replaced.result as any).binding;
    expect(secondBinding).toMatchObject({ status: "resolved", endpoint_id: "endpoint:builder" });
    expect(store.requireActorBinding(firstBinding.actor_runtime_binding_id).superseded_at).not.toBeNull();
    expect(store.getCurrentActorBinding("actor:builder")?.actor_runtime_binding_id)
      .toBe(secondBinding.actor_runtime_binding_id);
    expect(store.listActorBindings("actor:builder")).toHaveLength(2);
  });

  it("refuses raw credentials, caller-selected ownership, stale revisions, and cross-Workspace bindings", async () => {
    const rawSecret = receipt(await registry.invoke(
      environment(store, actors),
      request(
        CREATE_RUNTIME_PROFILE_OPERATION_ID,
        {
          content: {
            ...profile("Unsafe"),
            configuration: { access_token: "plaintext-secret" },
          },
        },
        "unsafe-profile",
      ),
    ));
    expect(rawSecret).toMatchObject({
      state: "refused",
      refusal: { code: "runtime_profile_invalid" },
    });

    const callerOwner = receipt(await registry.invoke(
      environment(store, actors),
      request(
        CREATE_RUNTIME_PROFILE_OPERATION_ID,
        {
          owner: { kind: "host", id: "host:claimed" },
          content: profile("Claimed"),
        },
        "claimed-owner",
      ),
    ));
    expect(callerOwner).toMatchObject({
      state: "refused",
      refusal: { code: "operation_input_invalid" },
    });

    const created = store.createProfile({
      runtime_profile_id: "runtime-profile:local",
      owner: { kind: "workspace", id: "workspace:one" },
      created_by_principal_id: "principal:operator",
      content: profile("Local"),
    });
    const published = store.publishDraft({
      runtime_profile_revision_id: created.draft.runtime_profile_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: "principal:operator",
    });
    const stale = receipt(await registry.invoke(
      environment(store, actors),
      request(
        CREATE_RUNTIME_PROFILE_DRAFT_OPERATION_ID,
        { content: profile("Stale") },
        "stale-profile",
        {
          target: { kind: "runtime_profile", id: created.profile.runtime_profile_id },
          expected_revision: NO_RUNTIME_PROFILE_REVISION,
        },
      ),
    ));
    expect(stale).toMatchObject({
      state: "refused",
      refusal: { code: "operation_resource_revision_conflict", retryable: true },
    });

    const actor = actors.createActor({
      actor_id: "actor:builder",
      workspace_id: "workspace:one",
      created_by_principal_id: "principal:operator",
      definition: actorDefinition,
    });
    const otherRuntime = store.createProfile({
      runtime_profile_id: "runtime-profile:other",
      owner: { kind: "workspace", id: "workspace:other" },
      created_by_principal_id: "principal:other",
      content: profile("Other"),
    });
    const otherRevision = store.publishDraft({
      runtime_profile_revision_id: otherRuntime.draft.runtime_profile_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: "principal:other",
    });
    const crossWorkspace = receipt(await registry.invoke(
      environment(store, actors),
      request(
        CREATE_ACTOR_RUNTIME_BINDING_OPERATION_ID,
        {
          runtime_profile_revision_id: otherRevision.runtime_profile_revision_id,
          status: "resolved",
        },
        "cross-workspace-binding",
        {
          target: { kind: "actor", id: actor.actor.actor_id },
          expected_revision: NO_ACTOR_DEFINITION_REVISION,
        },
      ),
    ));
    expect(crossWorkspace).toMatchObject({
      state: "refused",
      refusal: { code: "runtime_profile_not_found" },
    });
    expect(store.getCurrentActorBinding(actor.actor.actor_id)).toBeNull();
    expect(published.runtime_profile_revision_id).toBeTruthy();
  });
});
