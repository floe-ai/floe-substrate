import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CANCEL_APPROVAL_OPERATION_ID,
  CONFIGURE_APPROVAL_RESPONSE_OPERATION_ID,
  DECIDE_APPROVAL_OPERATION_ID,
  INSPECT_APPROVAL_OPERATION_ID,
  LIST_APPROVALS_OPERATION_ID,
  REQUEST_APPROVAL_OPERATION_ID,
  REVOKE_APPROVAL_RECEIPT_OPERATION_ID,
  approvalOperationDefinitions,
  registerApprovalOperations,
  type ApprovalOperationBackend,
} from "./approval-operations.js";
import {
  ApprovalStore,
  applyApprovalSchema,
  approvalReceiptStateRevision,
  type ApprovalAction,
} from "./approvals.js";
import { AjvOperationSchemaValidator } from "./operation-schema-validator-ajv.js";
import { createTestOperationRegistry } from "./operation-test-fixtures.js";
import {
  type OperationAuthorityContext,
  type OperationInvocationEnvironment,
  type OperationInvocationRequest,
  type OperationInvocationResponse,
  type ResolvedOperationResource,
} from "./operations.js";

const OPERATION_IDS = [
  LIST_APPROVALS_OPERATION_ID,
  INSPECT_APPROVAL_OPERATION_ID,
  REQUEST_APPROVAL_OPERATION_ID,
  DECIDE_APPROVAL_OPERATION_ID,
  CONFIGURE_APPROVAL_RESPONSE_OPERATION_ID,
  CANCEL_APPROVAL_OPERATION_ID,
  REVOKE_APPROVAL_RECEIPT_OPERATION_ID,
] as const;

function exactAction(): ApprovalAction {
  return {
    operation_id: "connector.worker.action.execute",
    authorized_principal_id: "worker:connector-host",
    target: { kind: "connector_binding", id: "connector-binding:publish", revision: "revision:2" },
    input_digest: "a".repeat(64),
    artefact_version_ids: ["artefact-version:report", "artefact-version:site"],
    composition_revision_id: "scope-composition-revision:4",
    node_placement_id: "node:publish",
    scope_execution_id: "scope-execution:42",
    node_execution_id: "node-execution:publish-42",
    connector_binding_revision_id: "connector-binding-revision:2",
    extension_package_version_id: "extension-package-version:publisher-3",
    approval_policy_ref: { kind: "policy", id: "policy:publish", revision: "3" },
    capability_grant_ids: ["capability-grant:publish"],
    expected_effect: {
      summary: "Publish the exact accepted site to the production target.",
      external: true,
      reversibility: "reversible",
      resource_refs: [{ kind: "external_target", id: "site:campaign", revision: "production" }],
    },
  };
}

function authority(
  workspaceId = "workspace:campaign",
  grants: ReadonlySet<string> = new Set(OPERATION_IDS),
): OperationAuthorityContext & { boundary: { kind: "workspace"; workspace_id: string } } {
  return {
    principal_id: "principal:operator",
    capability_grant_ids: ["capability-grant:operator"],
    boundary: { kind: "workspace", workspace_id: workspaceId },
    grants,
    interaction: {
      mode: "interactive",
      session_id: "session:operator",
      confirmed_prompts: new Set(),
      approval_refs: new Set(),
    },
  };
}

function invocation(
  operationId: string,
  input: unknown,
  idempotencyKey: string,
  target?: { kind: string; id: string },
  expectedRevision?: string,
): OperationInvocationRequest {
  return {
    operation_id: operationId,
    operation_version: "1",
    input_schema_version: "1",
    input,
    idempotency_key: idempotencyKey,
    ...(target ? { target } : {}),
    ...(expectedRevision === undefined ? {} : { expected_resource_revision: expectedRevision }),
  };
}

function receipt(response: OperationInvocationResponse) {
  expect(response.kind).toBe("receipt");
  if (response.kind !== "receipt") throw new Error("Expected operation receipt");
  return response.receipt;
}

describe("approval semantic operations", () => {
  let db: DatabaseSync;
  let now: string;
  let store: ApprovalStore;
  let backend: ApprovalOperationBackend;
  let registry: ReturnType<typeof createTestOperationRegistry>;
  let decisionEvents: Array<Record<string, unknown>>;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE contexts (context_id TEXT PRIMARY KEY)");
    db.exec("INSERT INTO contexts (context_id) VALUES ('context:publish')");
    db.exec("PRAGMA foreign_keys = ON");
    applyApprovalSchema(db);
    now = "2026-09-04T00:00:00.000Z";
    decisionEvents = [];
    let requestNumber = 0;
    let receiptNumber = 0;
    store = new ApprovalStore(db, {
      now: () => now,
      request_id_factory: () => `approval-request:${++requestNumber}`,
      receipt_id_factory: () => `approval-receipt:${++receiptNumber}`,
    });
    backend = {
      store,
      contextBelongsToWorkspace: (contextId, workspaceId) =>
        contextId === "context:publish" && workspaceId === "workspace:campaign",
      createRequest: (input) => store.createRequest(input),
      configureResponse: (input) => store.configureResponse(input),
      decideRequest: (input) => {
        const request = store.requireRequestForWorkspace(input.approval_request_id, input.workspace_id);
        const eventId = `event:approval-decision:${decisionEvents.length + 1}`;
        decisionEvents.push({
          event_id: eventId,
          context_id: request.context_id,
          decision: input.decision,
          reason: input.decision_reason,
          approval_request_id: request.approval_request_id,
          operation_invocation_id: input.operation_invocation_id,
        });
        return store.decideRequest({
          workspace_id: input.workspace_id,
          approval_request_id: input.approval_request_id,
          expected_state_revision: input.expected_state_revision,
          decision: input.decision,
          decided_by_principal_id: input.decided_by_principal_id,
          decision_event_id: eventId,
          decision_reason: input.decision_reason,
          ...(input.receipt_expires_at ? { receipt_expires_at: input.receipt_expires_at } : {}),
          ...(input.supersedes_decision_id ? { supersedes_decision_id: input.supersedes_decision_id } : {}),
          idempotency_key: input.operation_invocation_id,
        });
      },
    };
    registry = registerApprovalOperations(
      createTestOperationRegistry(new AjvOperationSchemaValidator()),
      backend,
    );
  });

  afterEach(() => db.close());

  function environment(auth = authority()): OperationInvocationEnvironment {
    return {
      authority: auth,
      resolve_resource: async (target): Promise<ResolvedOperationResource | null> => {
        if (target.kind === "approval_request") {
          const request = store.getRequest(target.id);
          return request?.workspace_id === auth.boundary.workspace_id
            ? { ref: { ...target, revision: String(request.state_revision) }, state: request }
            : null;
        }
        if (target.kind === "approval_receipt") {
          const found = store.getReceipt(target.id);
          return found?.workspace_id === auth.boundary.workspace_id
            ? { ref: { ...target, revision: approvalReceiptStateRevision(found) }, state: found }
            : null;
        }
        return null;
      },
      now: () => now,
    };
  }

  async function createRequest(idempotencyKey = "request:publish") {
    const result = receipt(await registry.invoke(environment(), invocation(
      REQUEST_APPROVAL_OPERATION_ID,
      {
        action: exactAction(),
        context_id: "context:publish",
        reason: "The accepted site is ready for a deliberate publication decision.",
        expires_at: "2026-09-04T01:00:00.000Z",
        maximum_uses: 1,
      },
      idempotencyKey,
    )));
    expect(result.state).toBe("completed");
    return (result.result as any).request as ReturnType<ApprovalStore["requireRequest"]>;
  }

  it("discovers the same canonical approval contract for every client", async () => {
    const descriptors = await registry.project({ authority: authority() });
    expect(descriptors.map((item) => item.operation_id)).toEqual(OPERATION_IDS);
    expect(descriptors.every((item) =>
      item.required_grants.length === 1
      && item.required_grants[0] === item.operation_id
      && item.interaction_constraints.allowed_modes.includes("interactive")
    )).toBe(true);
    expect(approvalOperationDefinitions(backend)).toHaveLength(OPERATION_IDS.length);
  });

  it("returns selectable canonical references from approval lists and inspection", async () => {
    const request = await createRequest();
    const list = receipt(await registry.invoke(environment(), invocation(LIST_APPROVALS_OPERATION_ID, {}, "list:references")));
    const expected = { kind: "approval_request", id: request.approval_request_id, revision: String(request.state_revision) };
    expect((list.result as any).requests[0].resource_ref).toEqual(expected);
    const inspected = receipt(await registry.invoke(environment(), invocation(INSPECT_APPROVAL_OPERATION_ID, {}, "inspect:reference", { kind: "approval_request", id: request.approval_request_id })));
    expect((inspected.result as any).request.resource_ref).toEqual(expected);
  });

  it("creates an exact request from authenticated authority and refuses a foreign Context", async () => {
    const request = await createRequest();
    expect(request).toMatchObject({
      workspace_id: "workspace:campaign",
      context_id: "context:publish",
      requested_by_principal_id: "principal:operator",
      idempotency_key: "request:publish",
      status: "pending",
    });

    const refused = receipt(await registry.invoke(environment(), invocation(
      REQUEST_APPROVAL_OPERATION_ID,
      {
        action: exactAction(),
        context_id: "context:foreign",
        reason: "This Context does not belong to the authorised Workspace.",
        expires_at: "2026-09-04T01:00:00.000Z",
      },
      "request:foreign",
    )));
    expect(refused).toMatchObject({ state: "refused", refusal: { code: "approval_invalid" } });
  });

  it("records the decision Event and exact receipt through one backend decision boundary", async () => {
    const request = await createRequest();
    const decided = receipt(await registry.invoke(environment(), invocation(
      DECIDE_APPROVAL_OPERATION_ID,
      { decision: "approved", reason: "The exact evidence and production effect are accepted." },
      "decision:publish",
      { kind: "approval_request", id: request.approval_request_id },
    )));

    expect(decided.state).toBe("completed");
    expect((decided.result as any).request.status).toBe("approved");
    expect((decided.result as any).receipt).toMatchObject({
      context_id: "context:publish",
      requested_by_principal_id: "principal:operator",
      approved_by_principal_id: "principal:operator",
      decision_event_id: "event:approval-decision:1",
    });
    expect(decisionEvents).toEqual([expect.objectContaining({
      context_id: "context:publish",
      decision: "approved",
      approval_request_id: request.approval_request_id,
    })]);

    const inspection = receipt(await registry.invoke(environment(), invocation(
      INSPECT_APPROVAL_OPERATION_ID,
      {},
      "inspect:receipt",
      { kind: "approval_receipt", id: (decided.result as any).receipt.approval_receipt_id },
    )));
    expect((inspection.result as any).request.approval_request_id).toBe(request.approval_request_id);
    expect((inspection.result as any).receipt.action).toEqual(exactAction());
  });

  it("does not use mutable request revisions as a concurrency gate for individual decisions", async () => {
    const request = await createRequest();
    const stale = receipt(await registry.invoke(environment(), invocation(
      DECIDE_APPROVAL_OPERATION_ID,
      { decision: "approved", reason: "This decision used stale state." },
      "decision:stale",
      { kind: "approval_request", id: request.approval_request_id },
      String(request.state_revision + 1),
    )));
    expect(stale).toMatchObject({ state: "refused", refusal: { code: "operation_revision_not_supported" } });
    expect(store.requireRequest(request.approval_request_id).status).toBe("pending");
    expect(decisionEvents).toHaveLength(0);
  });

  it("lists attention, cancels pending work, and revokes issued authority without deleting evidence", async () => {
    const cancelledRequest = await createRequest("request:cancel");
    const cancelled = receipt(await registry.invoke(environment(), invocation(
      CANCEL_APPROVAL_OPERATION_ID,
      { reason: "The target is no longer in scope." },
      "cancel:request",
      { kind: "approval_request", id: cancelledRequest.approval_request_id },
      String(cancelledRequest.state_revision),
    )));
    expect((cancelled.result as any).request.status).toBe("cancelled");

    const approvedRequest = await createRequest("request:approve");
    const approved = receipt(await registry.invoke(environment(), invocation(
      DECIDE_APPROVAL_OPERATION_ID,
      { decision: "approved", reason: "Approve this exact action." },
      "decision:approve",
      { kind: "approval_request", id: approvedRequest.approval_request_id },
    )));
    const approvalReceiptId = (approved.result as any).receipt.approval_receipt_id as string;
    const approvalReceiptRevision = approvalReceiptStateRevision(store.requireReceipt(approvalReceiptId));
    const revoked = receipt(await registry.invoke(environment(), invocation(
      REVOKE_APPROVAL_RECEIPT_OPERATION_ID,
      { reason: "Authority was withdrawn before the external effect started." },
      "revoke:receipt",
      { kind: "approval_receipt", id: approvalReceiptId },
      approvalReceiptRevision,
    )));
    expect((revoked.result as any).receipt.revoked_by_principal_id).toBe("principal:operator");

    const listed = receipt(await registry.invoke(environment(), invocation(
      LIST_APPROVALS_OPERATION_ID,
      { attention_only: true },
      "list:attention",
    )));
    expect((listed.result as any).requests).toEqual([]);
    expect(store.requireRequest(cancelledRequest.approval_request_id).status).toBe("cancelled");
    expect(store.requireReceipt(approvalReceiptId).revoked_at).not.toBeNull();
  });
});
