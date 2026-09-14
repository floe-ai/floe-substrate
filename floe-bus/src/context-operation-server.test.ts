import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { defaultConfig, type LocalConfig } from "./config.js";
import {
  ARCHIVE_CONTEXT_OPERATION_ID,
  CREATE_CONTEXT_OPERATION_ID,
  DESTROY_CONTEXT_PERMANENTLY_OPERATION_ID,
  EMIT_CONTEXT_COMMUNICATION_OPERATION_ID,
  SET_CONTEXT_PARTICIPANT_ACCESS_OPERATION_ID,
} from "./context-operations.js";
import { createBusServer } from "./server.js";

const HOST_TOKEN = `floe-context-host-${"h".repeat(48)}`;
type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

describe("authenticated Context operation routes", () => {
  let handle: ServerHandle;
  let directory: string;
  let workspaceId: string;
  let sessionToken: string;
  let floeEndpointId: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "floe-context-server-"));
    const configPath = join(directory, "config.yaml");
    const config: LocalConfig = defaultConfig(directory);
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    handle = await createBusServer(configPath, config, {
      host_control_token: HOST_TOKEN,
      host_control_expires_at: "2099-01-01T00:00:00.000Z",
    });
    await handle.app.ready();
    const locator = join(directory, "workspace");
    mkdirSync(locator, { recursive: true });
    workspaceId = (handle.store.registerWorkspace({ locator, name: "Context routes" }, handle.broadcast) as {
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
    const issued = await handle.app.inject({
      method: "POST",
      url: `/v1/local/workspaces/${encodeURIComponent(workspaceId)}/operation-sessions`,
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
      payload: { interaction_session_id: "context-route-test" },
    });
    expect(issued.statusCode, issued.body).toBe(201);
    sessionToken = issued.json().bearer_token as string;
  });

  afterEach(async () => {
    try { await handle.app.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  });

  const auth = () => ({ authorization: `Bearer ${sessionToken}` });

  it("discovers and invokes the same Context operation contract as other clients", async () => {
    const discovery = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations?query=Context`,
      headers: auth(),
    });
    expect(discovery.statusCode).toBe(200);
    const ids = (discovery.json().operations as Array<{ operation_id: string }>).map((item) => item.operation_id);
    expect(ids).toEqual(expect.arrayContaining([
      CREATE_CONTEXT_OPERATION_ID,
      ARCHIVE_CONTEXT_OPERATION_ID,
      EMIT_CONTEXT_COMMUNICATION_OPERATION_ID,
    ]));

    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations/invoke`,
      headers: auth(),
      payload: {
        operation_id: CREATE_CONTEXT_OPERATION_ID,
        operation_version: "1",
        input_schema_version: "1",
        idempotency_key: "create-through-contract",
        input: {
          context_id: "context:canonical",
          participants: [{ participant_id: floeEndpointId }],
        },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({
      kind: "receipt",
      receipt: {
        state: "completed",
        principal_id: handle.store.localOperatorPrincipalId,
        result: { context: { context_id: "context:canonical" } },
      },
    });
  });

  it("atomically turns an operator upload into exact Context and Event ArtefactVersions", async () => {
    const contextId = handle.store.contextStore.createContext({
      context_id: "context:attachment",
      workspace_id: workspaceId,
      created_by_endpoint_id: floeEndpointId,
      participants: [floeEndpointId],
      title: "Image review",
    });
    const bytes = Buffer.from("exact image bytes");
    const issued = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/attachment-ingress-sessions`,
      headers: auth(),
      payload: {
        context_id: contextId,
        name: "concept.png",
        media_type: "image/png",
        size_bytes: bytes.byteLength,
      },
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const ingress = issued.json() as {
      session: { ingress_session_id: string };
      bearer_token: string;
    };

    const wrongBearer = await handle.app.inject({
      method: "PUT",
      url: `/v1/attachment-ingress-sessions/${encodeURIComponent(ingress.session.ingress_session_id)}/content`,
      headers: {
        authorization: "Bearer not-the-one-use-token",
        "content-type": "application/octet-stream",
      },
      payload: bytes,
    });
    expect(wrongBearer.statusCode).toBe(409);

    const uploaded = await handle.app.inject({
      method: "PUT",
      url: `/v1/attachment-ingress-sessions/${encodeURIComponent(ingress.session.ingress_session_id)}/content`,
      headers: {
        authorization: `Bearer ${ingress.bearer_token}`,
        "content-type": "application/octet-stream",
      },
      payload: bytes,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    expect(uploaded.json()).toMatchObject({
      session: {
        state: "ready",
        digest: { algorithm: "sha256", value: expect.stringMatching(/^[a-f0-9]{64}$/) },
      },
    });

    const opened = await handle.app.inject({
      method: "GET", url: `/v1/contexts/${encodeURIComponent(contextId)}`, headers: auth(),
    });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json()).toMatchObject({ state_revision: 1, lifecycle_state: "active", content_state: "available" });

    const invocation = {
      operation_id: EMIT_CONTEXT_COMMUNICATION_OPERATION_ID,
      operation_version: "1",
      input_schema_version: "2",
      target: { kind: "context", id: contextId },
      expected_resource_revision: String(opened.json().state_revision),
      idempotency_key: "attachment-message",
      input: {
        event_type: "message",
        recipient_participant_id: floeEndpointId,
        content: { text: "Review this concept." },
        artefact_version_ids: [],
        attachment_ingress_ids: [ingress.session.ingress_session_id],
        response_expected: true,
      },
    };
    const sent = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations/invoke`,
      headers: auth(),
      payload: invocation,
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const receipt = sent.json().receipt as {
      result: {
        event_ref: { id: string };
        artefact_version_refs: Array<{ id: string }>;
      };
    };
    expect(receipt.result.artefact_version_refs).toHaveLength(1);
    const versionId = receipt.result.artefact_version_refs[0]!.id;
    const version = handle.store.artefactStore.getVersion(versionId)!;
    expect(version.content_ref).toMatchObject({
      kind: "workspace-relative",
      media_type: "image/png",
      size_bytes: bytes.byteLength,
    });
    expect(version.content_ref.kind).toBe("workspace-relative");
    if (version.content_ref.kind !== "workspace-relative") throw new Error("expected workspace content");
    const locator = handle.store.getWorkspaceLocator(workspaceId)!;
    expect(readFileSync(join(locator, version.content_ref.path))).toEqual(bytes);
    expect(handle.store.artefactStore.listAssociations(versionId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ target_kind: "event", target_id: receipt.result.event_ref.id, role: "attachment" }),
      expect.objectContaining({ target_kind: "context", target_id: contextId, role: "attachment" }),
    ]));

    const retried = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations/invoke`,
      headers: auth(),
      payload: invocation,
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json().receipt.receipt_id).toBe(sent.json().receipt.receipt_id);
    expect(handle.store.artefactStore.listArtefacts(workspaceId)).toHaveLength(1);
  });

  it.each(["workspace", "principal"] as const)("isolates message retries by authenticated %s", async (boundary) => {
    const secondPrincipal = boundary === "principal" ? "principal:second" : handle.store.localOperatorPrincipalId;
    let secondWorkspace = workspaceId;
    if (boundary === "workspace") {
      const locator = join(directory, "second-workspace");
      mkdirSync(locator);
      secondWorkspace = (handle.store.registerWorkspace({ locator, name: "Second" }, handle.broadcast) as {
        workspace_id: string;
      }).workspace_id;
    }
    const secondContext = handle.store.contextStore.createContext({
      context_id: "context:second-message",
      workspace_id: secondWorkspace,
      created_by_endpoint_id: secondPrincipal,
      participants: [secondPrincipal],
    });
    const firstContext = handle.store.contextStore.createContext({
      context_id: "context:first-message",
      workspace_id: workspaceId,
      created_by_endpoint_id: floeEndpointId,
      participants: [floeEndpointId],
    });
    const grant = handle.store.capabilityGrantStore.issueGrant({
      principal_id: secondPrincipal,
      boundary: { kind: "workspace", workspace_id: secondWorkspace },
      operation_ids: [EMIT_CONTEXT_COMMUNICATION_OPERATION_ID],
      targets: [{ kind: "context", id: secondContext }],
      expires_at: "2099-01-01T00:00:00.000Z",
      issuer_id: "principal:test-host",
      evidence: [{ kind: "test_fixture", ref: "message-retry-isolation" }],
    });
    const secondToken = handle.store.operationAuthoritySessions.issueSession({
      principal_id: secondPrincipal,
      workspace_id: secondWorkspace,
      grant_ids: [grant.grant_id],
      interaction: { mode: "interactive", session_id: "second-window" },
      provenance: {
        cause_event_id: null, delivery_ids: [], execution_attempt_id: null,
        node_execution_id: null, scope_execution_id: null,
      },
      expires_at: "2099-01-01T00:00:00.000Z",
    }).bearer_token;
    const send = (workspace: string, context: string, token: string, text: string) => handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspace)}/operations/invoke`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        operation_id: EMIT_CONTEXT_COMMUNICATION_OPERATION_ID,
        operation_version: "1", input_schema_version: "2",
        target: { kind: "context", id: context }, expected_resource_revision: "1",
        idempotency_key: "send-1",
        input: { event_type: "message", content: { text }, response_expected: false },
      },
    });
    const first = await send(workspaceId, firstContext, sessionToken, "First message");
    const second = await send(secondWorkspace, secondContext, secondToken, "Second message");
    expect(first.json(), first.body).toMatchObject({ kind: "receipt", receipt: { state: "completed" } });
    expect(second.json(), second.body).toMatchObject({ kind: "receipt", receipt: { state: "completed" } });
    const firstId = first.json().receipt.result.event_ref.id;
    const secondId = second.json().receipt.result.event_ref.id;
    expect(secondId).not.toBe(firstId);
    const retained = handle.store.db.prepare("SELECT workspace_id, context_id, metadata_json, content_json FROM events WHERE event_id = ?")
      .get(secondId) as { workspace_id: string; context_id: string; metadata_json: string; content_json: string };
    expect(retained.workspace_id).toBe(secondWorkspace);
    expect(retained.context_id).toBe(secondContext);
    expect(JSON.parse(retained.metadata_json).source_principal_id).toBe(secondPrincipal);
    expect(JSON.parse(retained.content_json).text).toBe("Second message");
    const firstKey = (handle.store.db.prepare("SELECT idempotency_key FROM events WHERE event_id = ?").get(firstId) as {
      idempotency_key: string;
    }).idempotency_key;
    expect(() => handle.store.submitPrincipalContextCommunication({
      workspace_id: secondWorkspace, context_id: secondContext, principal_id: secondPrincipal,
      type: "message", recipient_endpoint_id: null, content: { text: "Second message" },
      artefact_version_ids: [], attachment_ingress_ids: [], response_expected: false, idempotency_key: firstKey,
      provenance: { cause_event_id: null, delivery_ids: [], execution_attempt_id: null, node_execution_id: null, scope_execution_id: null },
    }, handle.broadcast)).toThrow("does not identify communication by this principal");
    const replay = await send(secondWorkspace, secondContext, secondToken, "Second message");
    expect(replay.json().receipt.receipt_id).toBe(second.json().receipt.receipt_id);
    expect(replay.json().receipt.result.event_ref.id).toBe(secondId);
  });

  it.each([false, true])("removes only newly created upload content after a failed message (retained content: %s)", (retainContent) => {
    const contextId = handle.store.contextStore.createContext({
      workspace_id: workspaceId, created_by_endpoint_id: floeEndpointId, participants: [floeEndpointId],
    });
    const bytes = Buffer.from("exact attachment bytes");
    const command = {
      workspace_id: workspaceId, context_id: contextId, principal_id: handle.store.localOperatorPrincipalId,
      type: "message", recipient_endpoint_id: null, content: { text: "Review this" },
      artefact_version_ids: [] as string[], attachment_ingress_ids: [] as string[],
      response_expected: false, idempotency_key: "content-rollback",
      provenance: {
        cause_event_id: null, delivery_ids: [], execution_attempt_id: null,
        node_execution_id: null, scope_execution_id: null,
      },
    };
    const upload = () => {
      const issued = handle.store.attachmentIngressStore.issue({
        ...command, name: "concept.png", media_type: "image/png", size_bytes: bytes.byteLength,
      });
      const ready = handle.store.attachmentIngressStore.upload({
        ingress_session_id: issued.session.ingress_session_id, bearer_token: issued.bearer_token, bytes,
      });
      return ready;
    };
    if (retainContent) {
      handle.store.submitPrincipalContextCommunication({
        ...command, idempotency_key: "retained-message", attachment_ingress_ids: [upload().ingress_session_id],
      }, handle.broadcast);
    }
    const ready = upload();
    const contentPath = join(handle.store.getWorkspaceLocator(workspaceId)!, ".floe", "content", "sha256", ready.digest!.value);
    const failedCommand = {
      ...command, attachment_ingress_ids: [ready.ingress_session_id], artefact_version_ids: ["version:missing"],
    };
    expect(() => handle.store.submitPrincipalContextCommunication(failedCommand, handle.broadcast)).toThrow();
    expect(existsSync(contentPath)).toBe(retainContent);
    if (retainContent) expect(readFileSync(contentPath)).toEqual(bytes);
    expect(handle.store.db.prepare("SELECT count(*) AS count FROM events WHERE idempotency_key = ?")
      .get(command.idempotency_key)).toMatchObject({ count: 0 });
    const retried = handle.store.submitPrincipalContextCommunication({
      ...failedCommand, artefact_version_ids: [],
    }, handle.broadcast);
    expect(retried.attached_artefact_version_ids).toHaveLength(1);
    expect(readFileSync(contentPath)).toEqual(bytes);
  });

  it("rolls back a whole upload group when a later content write fails", () => {
    const contextId = handle.store.contextStore.createContext({
      workspace_id: workspaceId, created_by_endpoint_id: floeEndpointId, participants: [floeEndpointId],
    });
    const ready = [Buffer.from("first image"), Buffer.from("second image")].map(bytes => {
      const issued = handle.store.attachmentIngressStore.issue({
        workspace_id: workspaceId, context_id: contextId, principal_id: handle.store.localOperatorPrincipalId,
        name: "concept.png", media_type: "image/png", size_bytes: bytes.byteLength,
      });
      return handle.store.attachmentIngressStore.upload({
        ingress_session_id: issued.session.ingress_session_id, bearer_token: issued.bearer_token, bytes,
      });
    });
    const paths = ready.map(item => join(handle.store.getWorkspaceLocator(workspaceId)!, ".floe", "content", "sha256", item.digest!.value));
    mkdirSync(dirname(paths[1]!), { recursive: true });
    writeFileSync(paths[1]!, "damaged pre-existing content");
    const command = {
      workspace_id: workspaceId, context_id: contextId, principal_id: handle.store.localOperatorPrincipalId,
      type: "message", recipient_endpoint_id: null, content: { text: "Review both" },
      artefact_version_ids: [], attachment_ingress_ids: ready.map(item => item.ingress_session_id),
      response_expected: false, idempotency_key: "failed-upload-group",
      provenance: {
        cause_event_id: null, delivery_ids: [], execution_attempt_id: null,
        node_execution_id: null, scope_execution_id: null,
      },
    };
    expect(() => handle.store.submitPrincipalContextCommunication(command, handle.broadcast)).toThrow();
    expect(existsSync(paths[0]!)).toBe(false);
    expect(readFileSync(paths[1]!, "utf8")).toBe("damaged pre-existing content");
    expect(handle.store.artefactStore.listArtefacts(workspaceId)).toHaveLength(0);
    rmSync(paths[1]!);
    expect(handle.store.submitPrincipalContextCommunication(command, handle.broadcast).attached_artefact_version_ids).toHaveLength(2);
  });

  it("maps legacy app create, participant, and delete actions to canonical receipts", async () => {
    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/contexts`,
      headers: auth(),
      payload: { participants: [floeEndpointId], title: "Temporary conversation" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const contextId = created.json().context.context_id as string;
    const createReceipt = handle.store.operationInvocationLedger.getByReceiptId(created.json().receipt_id);
    expect(createReceipt).toMatchObject({ operation_id: CREATE_CONTEXT_OPERATION_ID, state: "completed" });

    const otherEndpoint = `actor:${workspaceId}:reviewer`;
    handle.store.registerEndpoint({
      endpoint_id: otherEndpoint,
      workspace_id: workspaceId,
      name: "Reviewer",
      bridge_id: null,
      status: "idle",
    }, handle.broadcast);
    const participant = await handle.app.inject({
      method: "POST",
      url: `/v1/contexts/${encodeURIComponent(contextId)}/participants`,
      headers: auth(),
      payload: { endpoint_id: otherEndpoint },
    });
    expect(participant.statusCode, participant.body).toBe(200);
    expect(handle.store.operationInvocationLedger.getByReceiptId(participant.json().receipt_id))
      .toMatchObject({ operation_id: SET_CONTEXT_PARTICIPANT_ACCESS_OPERATION_ID, state: "completed" });

    const removed = await handle.app.inject({
      method: "DELETE",
      url: `/v1/contexts/${encodeURIComponent(contextId)}`,
      headers: auth(),
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toMatchObject({ archived: true, events_deleted: 0 });
    expect(handle.store.contextStore.getContext(contextId)).toMatchObject({ lifecycle_state: "archived" });
    expect(handle.store.operationInvocationLedger.getByReceiptId(removed.json().receipt_id))
      .toMatchObject({ operation_id: ARCHIVE_CONTEXT_OPERATION_ID, state: "completed" });
  });

  it("does not leave the superseded Actor-only capability routes", async () => {
    const discovery = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities?query=delete%20Context`,
      headers: auth(),
    });
    expect(discovery.statusCode).toBe(401);

    const invocation = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/context.delete/invoke`,
      headers: auth(),
      payload: { caller_endpoint_id: floeEndpointId, input: { context_id: "context:any", delete_history: true } },
    });
    expect(invocation.statusCode).toBe(401);
  });

  it("refuses a Workspace session from another Workspace", async () => {
    const response = await handle.app.inject({
      method: "GET",
      url: "/v1/workspaces/workspace%3Aother/operations?query=Context",
      headers: auth(),
    });
    expect(response.statusCode).toBe(401);
  });

  it("confirms one exact irreversible Context operation through host control without elevating the Workspace session", async () => {
    const contextId = handle.store.contextStore.createContext({
      context_id: "context:native-confirmation",
      workspace_id: workspaceId,
      created_by_endpoint_id: floeEndpointId,
      participants: [floeEndpointId],
      title: "Disposable content",
    });
    const request = {
      operation_id: DESTROY_CONTEXT_PERMANENTLY_OPERATION_ID,
      operation_version: "1",
      input_schema_version: "1",
      target: { kind: "context", id: contextId },
      expected_resource_revision: "1",
      idempotency_key: "destroy-through-native-confirmation",
      input: { reason: "The operator explicitly confirmed permanent destruction." },
    };

    const workspaceAttempt = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations/invoke`,
      headers: auth(),
      payload: { ...request, idempotency_key: "ordinary-session-remains-unconfirmed" },
    });
    expect(workspaceAttempt.statusCode, workspaceAttempt.body).toBe(200);
    expect(workspaceAttempt.json()).toMatchObject({
      kind: "receipt",
      receipt: { refusal: { code: "operation_confirmation_required" } },
    });

    const confirmed = await handle.app.inject({
      method: "POST",
      url: `/v1/local/workspaces/${encodeURIComponent(workspaceId)}/operations/confirm-and-invoke`,
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
      payload: {
        interaction_session_id: "native-dialog-accepted",
        invocation: {
          ...request,
          idempotency_key: "destroy-through-native-confirmation-success",
        },
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json(), confirmed.body).toMatchObject({
      kind: "receipt",
      receipt: {
        operation_id: DESTROY_CONTEXT_PERMANENTLY_OPERATION_ID,
        principal_id: handle.store.localOperatorPrincipalId,
        state: "completed",
        result: {
          context: {
            context_id: contextId,
            lifecycle_state: "tombstoned",
            content_state: "destroyed",
            title: null,
          },
        },
      },
    });

    const ordinaryContextId = handle.store.contextStore.createContext({
      context_id: "context:ordinary-session-not-elevated",
      workspace_id: workspaceId,
      created_by_endpoint_id: floeEndpointId,
      participants: [floeEndpointId],
    });
    const stillUnconfirmed = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations/invoke`,
      headers: auth(),
      payload: {
        ...request,
        target: { kind: "context", id: ordinaryContextId },
        idempotency_key: "ordinary-session-still-unconfirmed",
      },
    });
    expect(stillUnconfirmed.json()).toMatchObject({
      kind: "receipt",
      receipt: { refusal: { code: "operation_confirmation_required" } },
    });
  });

  it("rejects confirmation self-assertion and preserves retained Context evidence", async () => {
    const contextId = handle.store.contextStore.createContext({
      context_id: "context:retained-confirmation",
      workspace_id: workspaceId,
      created_by_endpoint_id: floeEndpointId,
      participants: [floeEndpointId],
    });
    handle.store.appendContextEvent({
      type: "operator.approval.recorded",
      workspace_id: workspaceId,
      context_id: contextId,
      content: { decision: "retain" },
      metadata: {},
    }, handle.broadcast);
    const invocation = {
      operation_id: DESTROY_CONTEXT_PERMANENTLY_OPERATION_ID,
      operation_version: "1",
      input_schema_version: "1",
      target: { kind: "context", id: contextId },
      expected_resource_revision: "1",
      idempotency_key: "retained-destroy-attempt",
      input: { reason: "The operator explicitly confirmed permanent destruction." },
    };

    const workspaceTokenCannotConfirm = await handle.app.inject({
      method: "POST",
      url: `/v1/local/workspaces/${encodeURIComponent(workspaceId)}/operations/confirm-and-invoke`,
      headers: auth(),
      payload: { interaction_session_id: "browser-attempt", invocation },
    });
    expect(workspaceTokenCannotConfirm.statusCode).toBe(401);

    for (const asserted of [
      { prompt_id: "context.destroy_permanently" },
      { confirmed_prompts: ["context.destroy_permanently"] },
      { principal_id: handle.store.localOperatorPrincipalId },
      { grant_ids: [DESTROY_CONTEXT_PERMANENTLY_OPERATION_ID] },
      { confirmation: true },
    ]) {
      const response = await handle.app.inject({
        method: "POST",
        url: `/v1/local/workspaces/${encodeURIComponent(workspaceId)}/operations/confirm-and-invoke`,
        headers: { authorization: `Bearer ${HOST_TOKEN}` },
        payload: { interaction_session_id: "spoofed-confirmation", invocation, ...asserted },
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ error: "confirmed_operation_request_invalid" });
    }

    const retained = await handle.app.inject({
      method: "POST",
      url: `/v1/local/workspaces/${encodeURIComponent(workspaceId)}/operations/confirm-and-invoke`,
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
      payload: { interaction_session_id: "native-dialog-accepted", invocation },
    });
    expect(retained.statusCode, retained.body).toBe(200);
    expect(retained.json()).toMatchObject({
      kind: "receipt",
      receipt: {
        state: "refused",
        refusal: {
          code: "context_retained_references_exist",
          details: {
            retained_references: expect.arrayContaining([
              expect.objectContaining({ relationship: "decision_or_approval_evidence" }),
            ]),
          },
        },
      },
    });
    expect(handle.store.contextStore.getContext(contextId)).toMatchObject({
      lifecycle_state: "active",
      content_state: "available",
    });
  });

  it("does not exempt another semantic operation receipt from retained evidence", async () => {
    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations/invoke`,
      headers: auth(),
      payload: {
        operation_id: CREATE_CONTEXT_OPERATION_ID,
        operation_version: "1",
        input_schema_version: "1",
        idempotency_key: "create-retained-context",
        input: {
          context_id: "context:retained-operation-receipt",
          participants: [{ participant_id: floeEndpointId }],
          title: "Receipt-retained content",
        },
      },
    });
    expect(created.statusCode, created.body).toBe(200);

    const retained = await handle.app.inject({
      method: "POST",
      url: `/v1/local/workspaces/${encodeURIComponent(workspaceId)}/operations/confirm-and-invoke`,
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
      payload: {
        interaction_session_id: "native-dialog-accepted",
        invocation: {
          operation_id: DESTROY_CONTEXT_PERMANENTLY_OPERATION_ID,
          operation_version: "1",
          input_schema_version: "1",
          target: { kind: "context", id: "context:retained-operation-receipt" },
          expected_resource_revision: "1",
          idempotency_key: "destroy-receipt-retained-context",
          input: { reason: "The operator explicitly confirmed permanent destruction." },
        },
      },
    });
    expect(retained.statusCode, retained.body).toBe(200);
    expect(retained.json()).toMatchObject({
      kind: "receipt",
      receipt: {
        state: "refused",
        refusal: {
          code: "context_retained_references_exist",
          details: {
            retained_references: expect.arrayContaining([
              expect.objectContaining({ relationship: "operation_audit_context_snapshot" }),
            ]),
          },
        },
      },
    });
    expect(handle.store.contextStore.getContext("context:retained-operation-receipt"))
      .toMatchObject({ lifecycle_state: "active", content_state: "available" });
  });

  it("will not use the trusted confirmation boundary for an operation that needs no confirmation", async () => {
    const response = await handle.app.inject({
      method: "POST",
      url: `/v1/local/workspaces/${encodeURIComponent(workspaceId)}/operations/confirm-and-invoke`,
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
      payload: {
        interaction_session_id: "native-dialog-accepted",
        invocation: {
          operation_id: CREATE_CONTEXT_OPERATION_ID,
          operation_version: "1",
          input_schema_version: "1",
          idempotency_key: "confirmation-not-required",
          input: { participants: [{ participant_id: floeEndpointId }] },
        },
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ error: "operation_confirmation_not_required" });
  });
});
