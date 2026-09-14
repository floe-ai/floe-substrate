import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { defaultConfig, type LocalConfig } from "./config.js";
import {
  ARCHIVE_CONTEXT_OPERATION_ID,
  CREATE_CONTEXT_OPERATION_ID,
  EMIT_CONTEXT_COMMUNICATION_OPERATION_ID,
  RESTORE_CONTEXT_OPERATION_ID,
} from "./context-operations.js";
import { createOperationAuthorityContext, type OperationInvocationRequest } from "./operations.js";
import { createBusServer } from "./server.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

describe("Bus Context operation backend", () => {
  let handle: ServerHandle;
  let directory: string;
  let workspaceId: string;
  let floeEndpointId: string;
  const principalId = "principal:operator";

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "floe-context-backend-"));
    const configPath = join(directory, "config.yaml");
    const config: LocalConfig = defaultConfig(directory);
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    handle = await createBusServer(configPath, config, { allow_unauthenticated_test_requests: true });
    await handle.app.ready();
    const locator = join(directory, "workspace");
    mkdirSync(locator, { recursive: true });
    workspaceId = (handle.store.registerWorkspace({ locator, name: "Context integration" }, handle.broadcast) as {
      workspace_id: string;
    }).workspace_id;
    floeEndpointId = `actor:${workspaceId}:floe`;
    handle.store.registerEndpoint({
      endpoint_id: floeEndpointId,
      workspace_id: workspaceId,
      name: "Floe",
      bridge_id: null,
      status: "idle",
    }, handle.broadcast);
  });

  afterEach(async () => {
    try { await handle.app.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  });

  async function invoke(request: OperationInvocationRequest) {
    return handle.store.operationRegistry.invoke({
      authority: createOperationAuthorityContext({
        principal_id: principalId,
        boundary: { kind: "workspace", workspace_id: workspaceId },
        grants: new Set(handle.store.operationRegistry.listCurrentOperationIds({
          interaction_mode: "interactive",
          boundary_kind: "workspace",
        })),
        interaction: {
          mode: "interactive",
          session_id: "integration",
          confirmed_prompts: new Set(),
          approval_refs: new Set(),
        },
      }),
      resolve_resource: (target) => handle.store.resolveOperationResource(
        target,
        { kind: "workspace", workspace_id: workspaceId },
      ),
    }, request);
  }

  it("runs creation, direct communication, archive, and restore through one canonical registry", async () => {
    const created = await invoke({
      operation_id: CREATE_CONTEXT_OPERATION_ID,
      operation_version: "1",
      input_schema_version: "1",
      idempotency_key: "create-context",
      input: {
        context_id: "context:conversation",
        title: "Operator and Floe",
        participants: [{ participant_id: floeEndpointId, role: "collaborator", access: "contribute" }],
      },
    });
    expect(created).toMatchObject({
      kind: "receipt",
      receipt: {
        state: "completed",
        principal_id: principalId,
        result: { context: { context_id: "context:conversation", state_revision: 1 } },
      },
    });
    handle.store.contextStore.subscribeToContext("context:conversation", floeEndpointId, ["message"]);
    handle.store.artefactStore.createArtefact({
      artefact_id: "artefact:brief",
      workspace_id: workspaceId,
      type_ref: "text/markdown",
      idempotency_key: "brief",
    });
    handle.store.artefactStore.publishVersion({
      artefact_id: "artefact:brief",
      artefact_version_id: "artefact-version:brief:1",
      idempotency_key: "brief-v1",
      content_ref: {
        kind: "content-addressed",
        resolver_id: "test-content",
        digest: { algorithm: "sha256", value: "d".repeat(64) },
        media_type: "text/markdown",
      },
    });

    const sent = await invoke({
      operation_id: EMIT_CONTEXT_COMMUNICATION_OPERATION_ID,
      operation_version: "1",
      input_schema_version: "2",
      target: { kind: "context", id: "context:conversation" },
      expected_resource_revision: "1",
      idempotency_key: "send-message",
      input: {
        event_type: "message",
        content: { text: "Help me reach this outcome.", references: [{ name: "Saved decision", resource_ref: { kind: "approval_request", id: "approval:reference-only", revision: "2" } }] },
        artefact_version_ids: ["artefact-version:brief:1"],
        response_expected: true,
      },
    });
    expect(sent).toMatchObject({ kind: "receipt", receipt: { state: "completed" } });
    const event = handle.store.listEvents({ context_id: "context:conversation" })[0]!;
    expect(event).toMatchObject({
      source_endpoint_id: null,
      destination_json: { kind: "context", context_id: "context:conversation" },
      content: { text: "Help me reach this outcome.", references: [{ name: "Saved decision", resource_ref: { kind: "approval_request", id: "approval:reference-only", revision: "2" } }] },
      response: { expected: true },
      artefact_version_ids: ["artefact-version:brief:1"],
      metadata: { source_principal_id: principalId, semantic_operation_id: EMIT_CONTEXT_COMMUNICATION_OPERATION_ID },
    });
    expect(handle.store.artefactStore.listAssociations("artefact-version:brief:1"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ target_kind: "event", target_id: event.event_id, role: "attachment" }),
        expect.objectContaining({ target_kind: "context", target_id: "context:conversation", role: "attachment" }),
      ]));
    expect(handle.store.db.prepare(`
      SELECT destination_endpoint_id, state FROM event_queue WHERE event_id = ?
    `).get(event.event_id)).toEqual({ destination_endpoint_id: floeEndpointId, state: "queued" });
    expect(handle.store.db.prepare(`SELECT 1 FROM pending_responses WHERE source_event_id = ?`).get(event.event_id))
      .toBeUndefined();

    const archived = await invoke({
      operation_id: ARCHIVE_CONTEXT_OPERATION_ID,
      operation_version: "1",
      input_schema_version: "1",
      target: { kind: "context", id: "context:conversation" },
      expected_resource_revision: "1",
      idempotency_key: "archive-context",
      input: { reason: "Finished for now" },
    });
    expect(archived).toMatchObject({
      kind: "receipt",
      receipt: { result: { context: { lifecycle_state: "archived", state_revision: 2 } } },
    });
    expect(handle.store.contextStore.listContextsForWorkspace(workspaceId)).toHaveLength(0);
    expect(handle.store.contextStore.getContextSubscriptions("context:conversation")).toHaveLength(0);

    const restored = await invoke({
      operation_id: RESTORE_CONTEXT_OPERATION_ID,
      operation_version: "1",
      input_schema_version: "1",
      target: { kind: "context", id: "context:conversation" },
      expected_resource_revision: "2",
      idempotency_key: "restore-context",
      input: {},
    });
    expect(restored).toMatchObject({
      kind: "receipt",
      receipt: { result: { context: { lifecycle_state: "active", state_revision: 3 } } },
    });
    expect(handle.store.contextStore.getContextSubscriptions("context:conversation")).toHaveLength(1);
  });

  it("rechecks canonical and unknown retained references in the tombstone transaction", () => {
    const contextId = handle.store.contextStore.createContext({
      context_id: "context:retained",
      workspace_id: workspaceId,
      created_by_endpoint_id: floeEndpointId,
      participants: [floeEndpointId],
    });
    handle.store.db.prepare(`
      INSERT INTO node_context_bindings (workspace_id, scope_id, node_id, binding_key, context_id, created_at)
      VALUES (?, 'scope:one', 'node:one', 'fixed', ?, ?)
    `).run(workspaceId, contextId, new Date().toISOString());
    expect(handle.store.contextOperationBackend.listRetainedReferences(workspaceId, contextId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ relationship: "persistent_node_context_binding" })]),
    );
    expect(handle.store.contextOperationBackend.destroyContextPermanently({
      workspace_id: workspaceId,
      context_id: contextId,
      expected_revision: 1,
      principal_id: principalId,
      reason: "Explicit erasure",
      invocation_id: "invocation:test",
    })).toMatchObject({ destroyed: false });

    handle.store.db.prepare(`DELETE FROM node_context_bindings WHERE context_id = ?`).run(contextId);

    handle.store.scopeStore.createScope({
      workspace_id: workspaceId,
      scope_id: "scope:retains-context",
      title: "Retains Context",
    });
    const composition = handle.store.scopeCompositionStore.createDraft({
      workspace_id: workspaceId,
      scope_id: "scope:retains-context",
      content: {
        nodes: [{ node_id: "context-node", kind: "context", resource_id: contextId }],
        ports: [],
        edges: [],
      },
    });
    expect(handle.store.contextOperationBackend.listRetainedReferences(workspaceId, contextId)).toEqual(
      expect.arrayContaining([expect.objectContaining({
        kind: "scope_composition_revision",
        id: composition.revision_id,
        relationship: "context_node:context-node",
      })]),
    );
    handle.store.db.prepare(`DELETE FROM scope_node_placements WHERE revision_id = ?`).run(composition.revision_id);
    handle.store.db.prepare(`DELETE FROM scope_composition_revisions WHERE revision_id = ?`).run(composition.revision_id);

    const actor = handle.store.actorDefinitionStore.createActor({
      workspace_id: workspaceId,
      actor_id: "actor:context-reader",
      created_by_principal_id: principalId,
      definition: {
        label: "Context reader",
        charter: "Understand retained Context evidence.",
        responsibilities: [],
        instructions: "Use the exact retained Context reference.",
        knowledge_refs: [{ kind: "context", id: contextId, revision: "1" }],
        capability_grant_ids: [],
        policy_refs: { budget: null, trust: null, approval: null },
        escalation_rules: [],
      },
    });
    expect(handle.store.contextOperationBackend.listRetainedReferences(workspaceId, contextId)).toEqual(
      expect.arrayContaining([expect.objectContaining({
        kind: "actor_definition_revision",
        id: actor.draft.actor_definition_revision_id,
        relationship: "definition_context_reference",
      })]),
    );
    handle.store.db.prepare(`DELETE FROM actor_definition_revisions WHERE actor_id = ?`).run(actor.actor.actor_id);
    handle.store.db.prepare(`DELETE FROM actors WHERE actor_id = ?`).run(actor.actor.actor_id);

    handle.store.db.exec(`CREATE TABLE future_records (future_id TEXT PRIMARY KEY, related_context_id TEXT)`);
    handle.store.db.prepare(`INSERT INTO future_records VALUES ('future:one', ?)`).run(contextId);
    expect(handle.store.contextOperationBackend.listRetainedReferences(workspaceId, contextId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "retention_surface", relationship: "unclassified:related_context_id" })]),
    );
    handle.store.db.prepare(`DELETE FROM future_records`).run();

    const destroyed = handle.store.contextOperationBackend.destroyContextPermanently({
      workspace_id: workspaceId,
      context_id: contextId,
      expected_revision: 1,
      principal_id: principalId,
      reason: "Explicit erasure",
      invocation_id: "invocation:test",
    });
    expect(destroyed).toMatchObject({
      destroyed: true,
      context: { context_id: contextId, lifecycle_state: "tombstoned", content_state: "destroyed" },
    });
  });

  it("retains decision and approval Events even when they have no delivery", () => {
    const contextId = handle.store.contextStore.createContext({
      workspace_id: workspaceId,
      created_by_endpoint_id: floeEndpointId,
      participants: [floeEndpointId],
    });
    const event = handle.store.appendContextEvent({
      type: "operator.approval.recorded",
      workspace_id: workspaceId,
      context_id: contextId,
      content: { decision: "ship" },
      metadata: {},
    }, handle.broadcast);
    expect(handle.store.contextOperationBackend.listRetainedReferences(workspaceId, contextId)).toEqual(
      expect.arrayContaining([expect.objectContaining({
        kind: "event",
        id: event.event_id,
        relationship: "decision_or_approval_evidence",
      })]),
    );
  });

  it("refuses a direct recipient that has no addressable Endpoint", async () => {
    const actorId = "actor:not-running";
    handle.store.actorDefinitionStore.createActor({
      workspace_id: workspaceId,
      actor_id: actorId,
      created_by_principal_id: principalId,
      definition: {
        label: "Not running",
        charter: "Remain a valid Actor without an active runtime Endpoint.",
        responsibilities: [],
        instructions: "Do not receive runtime delivery yet.",
        knowledge_refs: [],
        capability_grant_ids: [],
        policy_refs: { budget: null, trust: null, approval: null },
        escalation_rules: [],
      },
    });
    handle.store.contextStore.createContext({
      context_id: "context:not-running",
      workspace_id: workspaceId,
      created_by_endpoint_id: null,
      created_by_principal_id: principalId,
      participants: [actorId],
    });

    const result = await invoke({
      operation_id: EMIT_CONTEXT_COMMUNICATION_OPERATION_ID,
      operation_version: "1",
      input_schema_version: "2",
      target: { kind: "context", id: "context:not-running" },
      expected_resource_revision: "1",
      idempotency_key: "send-to-unavailable-actor",
      input: {
        event_type: "message",
        recipient_participant_id: actorId,
        content: { text: "Are you there?" },
        response_expected: true,
      },
    });
    expect(result).toMatchObject({
      kind: "receipt",
      receipt: {
        state: "refused",
        refusal: { code: "context_recipient_unavailable", retryable: true },
      },
    });
    expect(handle.store.listEvents({ context_id: "context:not-running" })).toHaveLength(0);
    const note = await invoke({
      operation_id: EMIT_CONTEXT_COMMUNICATION_OPERATION_ID, operation_version: "1", input_schema_version: "2",
      target: { kind: "context", id: "context:not-running" }, expected_resource_revision: "1",
      idempotency_key: "note-in-shared-context",
      input: { event_type: "message", content: { text: "A note for this work." }, response_expected: false },
    });
    expect(note).toMatchObject({ kind: "receipt", receipt: { state: "completed" } });
    expect(handle.store.listEvents({ context_id: "context:not-running" })).toMatchObject([{
      destination_json: { kind: "context", context_id: "context:not-running" },
      response: { expected: false }, content: { text: "A note for this work." },
    }]);
  });
});
