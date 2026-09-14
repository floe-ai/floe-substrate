import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ARCHIVE_CONTEXT_OPERATION_ID,
  CREATE_CONTEXT_OPERATION_ID,
  DESTROY_CONTEXT_PERMANENTLY_OPERATION_ID,
  EMIT_CONTEXT_COMMUNICATION_OPERATION_ID,
  GET_CONTEXT_OPERATION_ID,
  INSPECT_CONTEXT_OPERATION_ID,
  LIST_CONTEXTS_OPERATION_ID,
  REMOVE_CONTEXT_PARTICIPANT_OPERATION_ID,
  RESTORE_CONTEXT_OPERATION_ID,
  SET_CONTEXT_PARTICIPANT_ACCESS_OPERATION_ID,
  contextOperationDefinitions,
  registerContextOperations,
  resolveContextOperationResource,
  type ContextOperationBackend,
  type ContextRetainedReference,
  type DirectContextCommunicationIntent,
} from "./context-operations.js";
import { applyContextSchema, ContextStore } from "./contexts/store.js";
import { AjvOperationSchemaValidator } from "./operation-schema-validator-ajv.js";
import { createTestOperationRegistry } from "./operation-test-fixtures.js";
import {
  type OperationAuthorityContext,
  type OperationInvocationEnvironment,
  type OperationInvocationRequest,
  type OperationInvocationResponse,
  type OperationInteractionMode,
} from "./operations.js";

const OPERATION_IDS = [
  LIST_CONTEXTS_OPERATION_ID,
  GET_CONTEXT_OPERATION_ID,
  INSPECT_CONTEXT_OPERATION_ID,
  CREATE_CONTEXT_OPERATION_ID,
  ARCHIVE_CONTEXT_OPERATION_ID,
  RESTORE_CONTEXT_OPERATION_ID,
  SET_CONTEXT_PARTICIPANT_ACCESS_OPERATION_ID,
  REMOVE_CONTEXT_PARTICIPANT_OPERATION_ID,
  EMIT_CONTEXT_COMMUNICATION_OPERATION_ID,
  DESTROY_CONTEXT_PERMANENTLY_OPERATION_ID,
] as const;

function authority(
  workspaceId = "workspace:one",
  options: Readonly<{
    mode?: OperationInteractionMode;
    grants?: ReadonlySet<string>;
    confirmed?: ReadonlySet<string>;
  }> = {},
): OperationAuthorityContext {
  return {
    principal_id: "principal:operator",
    boundary: { kind: "workspace", workspace_id: workspaceId },
    grants: options.grants ?? new Set(OPERATION_IDS),
    interaction: {
      mode: options.mode ?? "interactive",
      session_id: "session:test",
      confirmed_prompts: options.confirmed ?? new Set(),
      approval_refs: new Set(),
    },
  };
}

function environment(
  store: ContextStore,
  auth = authority(),
): OperationInvocationEnvironment {
  return {
    authority: auth,
    resolve_resource: (target) => resolveContextOperationResource(
      store,
      auth.boundary.kind === "workspace" ? auth.boundary.workspace_id : "",
      target,
    ),
    now: () => "2026-09-04T05:00:00.000Z",
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
    input_schema_version: operationId === EMIT_CONTEXT_COMMUNICATION_OPERATION_ID ? "2" : "1",
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

class TestContextBackend implements ContextOperationBackend {
  readonly participants = new Map<string, Set<string>>([
    ["workspace:one", new Set(["principal:operator", "actor:architect", "actor:builder"])],
    ["workspace:two", new Set(["actor:other"])],
  ]);
  readonly scopes = new Map<string, Set<string>>([
    ["workspace:one", new Set(["scope:delivery"])],
    ["workspace:two", new Set(["scope:other"])],
  ]);
  readonly retained = new Map<string, ContextRetainedReference[]>();
  readonly communication: DirectContextCommunicationIntent[] = [];
  destructionRace: ContextRetainedReference[] | null = null;

  private static readonly retainedReferenceGuard = Symbol("retained-reference-guard");

  constructor(readonly contexts: ContextStore) {}

  publishContextChange(): void {}

  participantExists(workspaceId: string, participantId: string): boolean {
    return this.participants.get(workspaceId)?.has(participantId) ?? false;
  }

  scopeExists(workspaceId: string, scopeId: string): boolean {
    return this.scopes.get(workspaceId)?.has(scopeId) ?? false;
  }

  listRetainedReferences(workspaceId: string, contextId: string): readonly ContextRetainedReference[] {
    const context = this.contexts.getContext(contextId);
    if (!context || context.workspace_id !== workspaceId) return [];
    return this.retained.get(contextId) ?? [];
  }

  destroyContextPermanently(input: {
    workspace_id: string;
    context_id: string;
    expected_revision: number;
    principal_id: string;
    reason: string;
    invocation_id: string;
  }) {
    let retained: readonly ContextRetainedReference[] = [];
    try {
      const result = this.contexts.tombstoneContext({
        context_id: input.context_id,
        expected_revision: input.expected_revision,
        tombstoned_by_principal_id: input.principal_id,
        reason: input.reason,
        assert_no_retained_references: () => {
          retained = this.destructionRace
            ?? this.listRetainedReferences(input.workspace_id, input.context_id);
          if (retained.length > 0) throw TestContextBackend.retainedReferenceGuard;
        },
      });
      return { destroyed: true as const, ...result };
    } catch (error) {
      if (error === TestContextBackend.retainedReferenceGuard) {
        return { destroyed: false as const, retained_references: retained };
      }
      throw error;
    }
  }

  emitDirectContextCommunication(intent: DirectContextCommunicationIntent) {
    const participant = this.contexts.getContextParticipantRecords(intent.context_id)
      .find((value) => value.participant_id === intent.principal_id);
    if (!participant || participant.access === "read") {
      return {
        emitted: false as const,
        code: "context_contribution_not_allowed",
        message: "The current principal cannot contribute to this Context.",
        retryable: false,
      };
    }
    this.communication.push(intent);
    return {
      emitted: true as const,
      event_ref: { kind: "event", id: `event:${this.communication.length}`, revision: null },
      artefact_version_refs: [],
    };
  }
}

function createSupportingSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      source_endpoint_id TEXT,
      context_id TEXT,
      thread_id TEXT NOT NULL DEFAULT '',
      scope_id TEXT,
      correlation_id TEXT,
      destination_json TEXT NOT NULL DEFAULT '{}',
      content_json TEXT NOT NULL DEFAULT '{}',
      response_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      idempotency_key TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE event_queue (event_id TEXT, delivery_id TEXT);
    CREATE TABLE pending_responses (source_event_id TEXT);
    CREATE TABLE delivery_bundles (
      delivery_id TEXT PRIMARY KEY,
      trigger_event_id TEXT,
      events_json TEXT NOT NULL
    );
    CREATE TABLE runtime_telemetry (delivery_id TEXT);
  `);
}

describe("Context semantic operations", () => {
  let db: DatabaseSync;
  let contexts: ContextStore;
  let backend: TestContextBackend;
  let registry: ReturnType<typeof createTestOperationRegistry>;
  let tick: number;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    createSupportingSchema(db);
    applyContextSchema(db);
    tick = 0;
    contexts = new ContextStore(
      db,
      () => `2026-09-04T04:00:${String(tick++).padStart(2, "0")}.000Z`,
    );
    backend = new TestContextBackend(contexts);
    registry = registerContextOperations(
      createTestOperationRegistry(new AjvOperationSchemaValidator()),
      backend,
    );
  });

  afterEach(() => db.close());

  async function createContext(
    contextId: string,
    participants = [{ participant_id: "principal:operator", role: "operator", access: "manage" }],
  ) {
    return receipt(await registry.invoke(
      environment(contexts),
      request(
        CREATE_CONTEXT_OPERATION_ID,
        { context_id: contextId, title: "Product decision", participants },
        `create:${contextId}`,
      ),
    ));
  }

  it("discovers one Workspace-only contract with one exact grant per operation", async () => {
    const operations = await registry.project({ authority: authority() });

    expect(operations.map((item) => item.operation_id)).toEqual(OPERATION_IDS);
    expect(operations.every((item) =>
      item.authority_boundary_kinds.length === 1
      && item.authority_boundary_kinds[0] === "workspace"
      && item.required_grants.length === 1
      && item.required_grants[0] === item.operation_id
    )).toBe(true);
    expect(contextOperationDefinitions(backend)).toHaveLength(OPERATION_IDS.length);

    const unavailable = await registry.project({
      authority: authority("workspace:one", { grants: new Set() }),
    });
    expect(unavailable.every((item) =>
      !item.availability.available
      && item.availability.refusal.code === "operation_grant_required"
    )).toBe(true);
  });

  it("creates, lists, gets, and inspects Contexts without accepting a Workspace in input", async () => {
    const createRequest = request(
      CREATE_CONTEXT_OPERATION_ID,
      {
        context_id: "context:product",
        title: "Product decision",
        participants: [
          { participant_id: "principal:operator", role: "operator", access: "manage" },
          { participant_id: "actor:architect", role: "architect", access: "contribute" },
        ],
      },
      "create-product-context",
    );
    const created = receipt(await registry.invoke(environment(contexts), createRequest));

    expect(created.state).toBe("completed");
    expect((created.result as any).context).toMatchObject({
      context_id: "context:product",
      workspace_id: "workspace:one",
      created_by_principal_id: "principal:operator",
      lifecycle_state: "active",
      state_revision: 1,
    });

    const replay = await registry.invoke(environment(contexts), createRequest);
    expect(replay).toMatchObject({ kind: "receipt", replayed: true });

    const listed = receipt(await registry.invoke(
      environment(contexts),
      request(LIST_CONTEXTS_OPERATION_ID, {}, "list-product-contexts"),
    ));
    expect((listed.result as any).contexts).toHaveLength(1);

    const got = receipt(await registry.invoke(
      environment(contexts),
      request(GET_CONTEXT_OPERATION_ID, {}, "get-product", {
        target: { kind: "context", id: "context:product" },
      }),
    ));
    expect((got.result as any).context.context_id).toBe("context:product");

    const inspected = receipt(await registry.invoke(
      environment(contexts),
      request(INSPECT_CONTEXT_OPERATION_ID, {}, "inspect-product", {
        target: { kind: "context", id: "context:product" },
      }),
    ));
    expect((inspected.result as any).participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ participant_id: "principal:operator", role: "operator", access: "manage" }),
      expect.objectContaining({ participant_id: "actor:architect", role: "architect", access: "contribute" }),
    ]));

    const crossWorkspace = receipt(await registry.invoke(
      environment(contexts, authority("workspace:two")),
      request(INSPECT_CONTEXT_OPERATION_ID, {}, "inspect-cross-workspace", {
        target: { kind: "context", id: "context:product" },
      }),
    ));
    expect(crossWorkspace.refusal?.code).toBe("operation_target_not_found");
  });

  it("archives and restores without losing content, while active lists hide archived Contexts", async () => {
    await createContext("context:archive");
    contexts.subscribeToContext("context:archive", "principal:operator", ["message"]);
    expect(contexts.isSubscribed("context:archive", "principal:operator", "message")).toBe(true);

    const archived = receipt(await registry.invoke(
      environment(contexts),
      request(ARCHIVE_CONTEXT_OPERATION_ID, { reason: "No longer active" }, "archive", {
        target: { kind: "context", id: "context:archive" },
        expected_revision: "1",
      }),
    ));
    expect((archived.result as any).context).toMatchObject({
      lifecycle_state: "archived",
      state_revision: 2,
      title: "Product decision",
      archive_reason: "No longer active",
    });
    expect(contexts.isSubscribed("context:archive", "principal:operator", "message")).toBe(false);
    expect(contexts.getContextSubscriptions("context:archive")).toEqual([]);
    expect(contexts.getContextSubscriptions("context:archive", { include_inactive: true })).toHaveLength(1);

    const active = receipt(await registry.invoke(
      environment(contexts),
      request(LIST_CONTEXTS_OPERATION_ID, {}, "list-active"),
    ));
    expect((active.result as any).contexts).toHaveLength(0);

    const withArchived = receipt(await registry.invoke(
      environment(contexts),
      request(LIST_CONTEXTS_OPERATION_ID, { include_archived: true }, "list-archived"),
    ));
    expect((withArchived.result as any).contexts).toHaveLength(1);

    const staleRestore = receipt(await registry.invoke(
      environment(contexts),
      request(RESTORE_CONTEXT_OPERATION_ID, {}, "stale-restore", {
        target: { kind: "context", id: "context:archive" },
        expected_revision: "1",
      }),
    ));
    expect(staleRestore.refusal?.code).toBe("operation_resource_revision_conflict");

    const restored = receipt(await registry.invoke(
      environment(contexts),
      request(RESTORE_CONTEXT_OPERATION_ID, {}, "restore", {
        target: { kind: "context", id: "context:archive" },
        expected_revision: "2",
      }),
    ));
    expect((restored.result as any).context).toMatchObject({ lifecycle_state: "active", state_revision: 3 });
    expect(contexts.getContextParticipantRecords("context:archive")).toHaveLength(1);
    expect(contexts.isSubscribed("context:archive", "principal:operator", "message")).toBe(true);
  });

  it("changes participant role and access without creating routing or Event side effects", async () => {
    await createContext("context:access");

    const added = receipt(await registry.invoke(
      environment(contexts),
      request(
        SET_CONTEXT_PARTICIPANT_ACCESS_OPERATION_ID,
        { participant_id: "actor:builder", role: "reviewer", access: "read" },
        "add-reviewer",
        { target: { kind: "context", id: "context:access" }, expected_revision: "1" },
      ),
    ));
    expect((added.result as any)).toMatchObject({
      changed: true,
      context: { state_revision: 2 },
      participant: { participant_id: "actor:builder", role: "reviewer", access: "read" },
    });
    expect(backend.communication).toHaveLength(0);
    expect(contexts.getContextSubscriptions("context:access")).toHaveLength(0);

    const unchanged = receipt(await registry.invoke(
      environment(contexts),
      request(
        SET_CONTEXT_PARTICIPANT_ACCESS_OPERATION_ID,
        { participant_id: "actor:builder", role: "reviewer", access: "read" },
        "same-reviewer",
        { target: { kind: "context", id: "context:access" }, expected_revision: "2" },
      ),
    ));
    expect((unchanged.result as any)).toMatchObject({ changed: false, context: { state_revision: 2 } });

    const removed = receipt(await registry.invoke(
      environment(contexts),
      request(
        REMOVE_CONTEXT_PARTICIPANT_OPERATION_ID,
        { participant_id: "actor:builder" },
        "remove-reviewer",
        { target: { kind: "context", id: "context:access" }, expected_revision: "2" },
      ),
    ));
    expect((removed.result as any)).toMatchObject({ removed: true, context: { state_revision: 3 } });
  });

  it("delegates direct non-graph communication to the Event backend and leaves Context revision unchanged", async () => {
    await createContext("context:conversation");

    const sent = receipt(await registry.invoke(
      environment(contexts),
      request(
        EMIT_CONTEXT_COMMUNICATION_OPERATION_ID,
        {
          event_type: "message",
          recipient_participant_id: null,
          content: { text: "Please review this outcome." },
          response_expected: true,
        },
        "message-one",
        { target: { kind: "context", id: "context:conversation" }, expected_revision: "1" },
      ),
    ));

    expect(sent.state).toBe("completed");
    expect((sent.result as any).event_ref).toEqual({ kind: "event", id: "event:1", revision: null });
    expect(backend.communication).toMatchObject([{
      workspace_id: "workspace:one",
      context_id: "context:conversation",
      principal_id: "principal:operator",
      event_type: "message",
      invocation_id: sent.invocation_id,
    }]);
    expect(contexts.requireContext("context:conversation").state_revision).toBe(1);
  });

  it("refuses permanent destruction while retained evidence exists, then leaves a redacted tombstone", async () => {
    await createContext("context:retained");
    backend.retained.set("context:retained", [{
      kind: "node_execution",
      id: "node-execution:1",
      revision: "4",
      relationship: "execution_context",
    }]);

    const blocked = receipt(await registry.invoke(
      environment(contexts, authority("workspace:one", {
        confirmed: new Set(["context.destroy_permanently"]),
      })),
      request(
        DESTROY_CONTEXT_PERMANENTLY_OPERATION_ID,
        { reason: "Operator requested erasure" },
        "destroy-blocked",
        { target: { kind: "context", id: "context:retained" }, expected_revision: "1" },
      ),
    ));
    expect(blocked.refusal).toMatchObject({
      code: "context_retained_references_exist",
      details: { retained_references: [{ kind: "node_execution", id: "node-execution:1" }] },
    });

    backend.retained.set("context:retained", []);
    const confirmationRequired = receipt(await registry.invoke(
      environment(contexts),
      request(
        DESTROY_CONTEXT_PERMANENTLY_OPERATION_ID,
        { reason: "Operator requested erasure" },
        "destroy-unconfirmed",
        { target: { kind: "context", id: "context:retained" }, expected_revision: "1" },
      ),
    ));
    expect(confirmationRequired.refusal?.code).toBe("operation_confirmation_required");

    const destroyed = receipt(await registry.invoke(
      environment(contexts, authority("workspace:one", {
        confirmed: new Set(["context.destroy_permanently"]),
      })),
      request(
        DESTROY_CONTEXT_PERMANENTLY_OPERATION_ID,
        { reason: "Operator requested erasure" },
        "destroy-confirmed",
        { target: { kind: "context", id: "context:retained" }, expected_revision: "1" },
      ),
    ));
    expect((destroyed.result as any).context).toMatchObject({
      context_id: "context:retained",
      lifecycle_state: "tombstoned",
      content_state: "destroyed",
      title: null,
      state_revision: 2,
      tombstoned_by_principal_id: "principal:operator",
    });
    expect(contexts.getContextParticipantRecords("context:retained")).toHaveLength(0);

    const active = receipt(await registry.invoke(
      environment(contexts),
      request(LIST_CONTEXTS_OPERATION_ID, {}, "list-after-destruction"),
    ));
    expect((active.result as any).contexts).toHaveLength(0);

    const tombstones = receipt(await registry.invoke(
      environment(contexts),
      request(LIST_CONTEXTS_OPERATION_ID, { include_tombstoned: true }, "list-tombstones"),
    ));
    expect((tombstones.result as any).contexts).toHaveLength(1);
  });

  it("rechecks retained references atomically at permanent destruction", async () => {
    await createContext("context:race");
    backend.destructionRace = [{
      kind: "artefact_version",
      id: "artefact-version:late",
      revision: "1",
      relationship: "attachment",
    }];

    const response = receipt(await registry.invoke(
      environment(contexts, authority("workspace:one", {
        confirmed: new Set(["context.destroy_permanently"]),
      })),
      request(
        DESTROY_CONTEXT_PERMANENTLY_OPERATION_ID,
        { reason: "Erase unreferenced content" },
        "destroy-race",
        { target: { kind: "context", id: "context:race" }, expected_revision: "1" },
      ),
    ));

    expect(response.refusal?.code).toBe("context_retained_references_exist");
    expect(contexts.requireContext("context:race").lifecycle_state).toBe("active");
  });
});
