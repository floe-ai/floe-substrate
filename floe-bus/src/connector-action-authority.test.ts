import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApprovalDeniedError,
  ApprovalStore,
  applyApprovalSchema,
  type ApprovalAction,
} from "./approvals.js";
import {
  CanonicalConnectorActionAuthority,
} from "./connector-action-authority.js";
import {
  ConnectorStore,
  connectorBindingStateRevision,
  type ConnectorBindingContent,
  type ConnectorDefinitionContent,
  type ConnectorOwner,
  type ExternalEffectReceipt,
} from "./connectors.js";
import {
  CONNECTOR_WORKER_ACTION_OPERATION_ID,
  type ConnectorWorkerPin,
} from "./connector-worker.js";
import type { ScopeExecutionStore } from "./scope-executions.js";

const OWNER: ConnectorOwner = { kind: "workspace", id: "workspace:connector-authority" };
const WORKER = "principal:connector-worker";
const OPERATOR = "principal:operator";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const EVIDENCE = { kind: "evidence", id: "evidence:request", revision: DIGEST_A } as const;
const INPUT = { kind: "artefact_version", id: "artefactversion:site-v1", revision: DIGEST_A } as const;
const PROVENANCE = {
  cause_event_id: "event:source",
  delivery_ids: ["delivery:source"],
  execution_attempt_id: "executionattempt:one",
  node_execution_id: "nodeexecution:one",
  scope_execution_id: "scopeexecution:one",
} as const;

function definition(): ConnectorDefinitionContent {
  return {
    label: "Publisher",
    description: "Publishes one exact reviewed output.",
    implementation_ref: {
      kind: "extension_package_version",
      id: "extensionpackageversion:publisher-v3",
      revision: DIGEST_A,
    },
    configuration_schema_ref: "schema:publisher-config@1",
    configuration_ui_schema_ref: null,
    credential_slots: [],
    source_interfaces: [],
    action_interfaces: [{
      interface_id: "publish",
      title: "Publish reviewed output",
      action_kind: "core:api-action",
      input_schema_ref: "schema:publish@1",
      result_schema_ref: "schema:publish-result@1",
      effect: "irreversible",
      idempotency: "required",
      retry: "after_reconcile",
      compensation_action_interface_id: null,
      approval: { required: true, policy_ref: "policy:publish-reviewed@3" },
      credential_slot_ids: [],
      required_capability_ids: ["external.publish"],
    }],
    health: { check_capability_id: "connector.health.inspect", evidence_schema_ref: null },
    rate_limit_policy_ref: null,
  };
}

function bindingContent(): ConnectorBindingContent {
  return {
    external_resource: { kind: "site", id: "site:production", display_name: "Production site" },
    configuration: { endpoint: "production" },
    enabled_source_interface_ids: [],
    enabled_action_interface_ids: ["publish"],
    secret_bindings: [],
    capability_grant_ids: ["capgrant:publish", "capgrant:network"],
  };
}

describe("CanonicalConnectorActionAuthority", () => {
  let db: DatabaseSync;
  let now: string;
  let connectorStore: ConnectorStore;
  let approvalStore: ApprovalStore;
  let authority: CanonicalConnectorActionAuthority;
  let pin: ConnectorWorkerPin;
  let nextApprovalReceiptId: string;
  let sequence: number;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE contexts (context_id TEXT PRIMARY KEY)");
    db.exec("INSERT INTO contexts (context_id) VALUES ('context:operator-approval')");
    db.exec("PRAGMA foreign_keys = ON");
    now = "2026-09-04T04:00:00.000Z";
    sequence = 0;
    nextApprovalReceiptId = "approvalreceipt:one";
    connectorStore = new ConnectorStore(db, () => now);
    applyApprovalSchema(db);
    approvalStore = new ApprovalStore(db, {
      now: () => now,
      request_id_factory: () => `approvalrequest:${++sequence}`,
      receipt_id_factory: () => nextApprovalReceiptId,
    });
    const created = connectorStore.createDefinition({
      connector_definition_id: "connectordefinition:publisher",
      owner: OWNER,
      content: definition(),
      created_by_principal_id: "principal:installer",
    });
    const bound = connectorStore.createBinding({
      connector_binding_id: "connectorbinding:publisher",
      connector_definition_revision_id: created.revision.connector_definition_revision_id,
      owner: OWNER,
      content: bindingContent(),
      created_by_principal_id: "principal:installer",
    });
    const enabled = connectorStore.setBindingStatus({
      connector_binding_id: bound.binding.connector_binding_id,
      owner: OWNER,
      status: "enabled",
      expected_state_revision: connectorBindingStateRevision(bound.binding),
    });
    pin = {
      owner: OWNER,
      binding: enabled,
      binding_revision: bound.revision,
      definition_revision: created.revision,
    };
    const executions = {
      getExecution: (id: string) => id === PROVENANCE.scope_execution_id ? ({
        execution_id: PROVENANCE.scope_execution_id,
        workspace_id: OWNER.id,
        revision_id: "compositionrevision:published-v4",
      } as any) : null,
      getNodeExecution: (id: string) => id === PROVENANCE.node_execution_id ? ({
        node_execution_id: PROVENANCE.node_execution_id,
        execution_id: PROVENANCE.scope_execution_id,
        revision_id: "compositionrevision:published-v4",
        node_id: "nodeplacement:publish",
      } as any) : null,
      getAttempt: (id: string) => id === PROVENANCE.execution_attempt_id ? ({
        attempt_id: PROVENANCE.execution_attempt_id,
        node_execution_id: PROVENANCE.node_execution_id,
        delivery_ids: [...PROVENANCE.delivery_ids],
      } as any) : null,
    } satisfies Pick<ScopeExecutionStore, "getExecution" | "getNodeExecution" | "getAttempt">;
    authority = new CanonicalConnectorActionAuthority(db, connectorStore, approvalStore, executions, WORKER);
  });

  afterEach(() => db.close());

  function requestEffect(approvalReceiptIds: readonly string[]): ExternalEffectReceipt {
    return connectorStore.requestExternalAction({
      connector_binding_id: pin.binding.connector_binding_id,
      connector_binding_revision_id: pin.binding_revision.connector_binding_revision_id,
      owner: OWNER,
      action_interface_id: "publish",
      idempotency_key: `publish:${sequence}`,
      input_digest: DIGEST_A,
      input_refs: [INPUT],
      approval_receipt_ids: approvalReceiptIds,
      requested_by_principal_id: OPERATOR,
      invocation_provenance: PROVENANCE,
    }).receipt;
  }

  function issueApproval(action: ApprovalAction, receiptId = nextApprovalReceiptId): string {
    nextApprovalReceiptId = receiptId;
    const request = approvalStore.createRequest({
      workspace_id: OWNER.id,
      action,
      context_id: "context:operator-approval",
      requested_by_principal_id: OPERATOR,
      reason: "Approve this exact publication.",
      expires_at: "2026-09-04T08:00:00.000Z",
      maximum_uses: 1,
      idempotency_key: `approval:${++sequence}`,
    });
    return approvalStore.decideRequest({
      workspace_id: OWNER.id,
      approval_request_id: request.approval_request_id,
      expected_state_revision: request.state_revision,
      decision: "approved",
      decided_by_principal_id: OPERATOR,
      decision_event_id: `event:decision:${sequence}`,
      decision_reason: "Approved for the exact retained inputs.",
    }).receipt!.approval_receipt_id;
  }

  function beginInput(receipt: ExternalEffectReceipt) {
    return {
      operation_id: CONNECTOR_WORKER_ACTION_OPERATION_ID,
      principal_id: WORKER,
      pin,
      action: pin.definition_revision.content.action_interfaces[0],
      external_effect: receipt,
      request_evidence_ref: EVIDENCE,
      approval_receipt_ids: receipt.approval_receipt_ids,
      checked_at: now,
    } as const;
  }

  it("binds exact execution provenance and consumes approval atomically with the attempt", async () => {
    const receipt = requestEffect([nextApprovalReceiptId]);
    const action = authority.approvalActionForReceipt(receipt);
    expect(action).toMatchObject({
      authorized_principal_id: WORKER,
      input_digest: DIGEST_A,
      artefact_version_ids: [INPUT.id],
      composition_revision_id: "compositionrevision:published-v4",
      node_placement_id: "nodeplacement:publish",
      scope_execution_id: PROVENANCE.scope_execution_id,
      node_execution_id: PROVENANCE.node_execution_id,
      connector_binding_revision_id: pin.binding_revision.connector_binding_revision_id,
      extension_package_version_id: "extensionpackageversion:publisher-v3",
      capability_grant_ids: ["capgrant:network", "capgrant:publish"],
      expected_effect: { external: true, reversibility: "irreversible" },
    });
    const approvalReceiptId = issueApproval(action);

    const attempt = await authority.beginActionAttempt(beginInput(receipt));
    expect(attempt).toMatchObject({ status: "started", attempt_number: 1 });
    expect(approvalStore.requireReceipt(approvalReceiptId).use_count).toBe(1);
    expect(connectorStore.requireExternalEffectReceiptForOwner(receipt.external_effect_receipt_id, OWNER).status)
      .toBe("running");
  });

  it.each([
    ["input", (action: ApprovalAction): ApprovalAction => ({ ...action, input_digest: DIGEST_B })],
    ["policy", (action: ApprovalAction): ApprovalAction => ({
      ...action,
      approval_policy_ref: { kind: "approval_policy", id: "policy:stale", revision: "old" },
    })],
    ["binding", (action: ApprovalAction): ApprovalAction => ({
      ...action,
      connector_binding_revision_id: "connectorbindingrevision:stale",
    })],
    ["grant", (action: ApprovalAction): ApprovalAction => ({
      ...action,
      capability_grant_ids: ["capgrant:stale"],
    })],
  ])("rejects a stale %s approval without beginning an attempt", async (_label, stale) => {
    const receipt = requestEffect([nextApprovalReceiptId]);
    issueApproval(stale(authority.approvalActionForReceipt(receipt)));
    await expect(authority.beginActionAttempt(beginInput(receipt)))
      .rejects.toBeInstanceOf(ApprovalDeniedError);
    expect(approvalStore.requireReceipt(nextApprovalReceiptId).use_count).toBe(0);
    expect(connectorStore.listExternalActionAttempts(receipt.external_effect_receipt_id, OWNER)).toEqual([]);
  });

  it("rejects expired and revoked approvals", async () => {
    const expired = requestEffect([nextApprovalReceiptId]);
    issueApproval(authority.approvalActionForReceipt(expired));
    now = "2026-09-04T09:00:00.000Z";
    await expect(authority.beginActionAttempt(beginInput(expired))).rejects.toMatchObject({ denial_code: "approval_expired" });

    now = "2026-09-04T04:00:00.000Z";
    nextApprovalReceiptId = "approvalreceipt:revoked";
    const revoked = requestEffect([nextApprovalReceiptId]);
    const revokedId = issueApproval(authority.approvalActionForReceipt(revoked));
    approvalStore.revokeReceipt({
      workspace_id: OWNER.id,
      approval_receipt_id: revokedId,
      revoked_by_principal_id: OPERATOR,
      reason: "The operator withdrew approval.",
    });
    await expect(authority.beginActionAttempt(beginInput(revoked))).rejects.toMatchObject({ denial_code: "approval_revoked" });
  });

  it("reuses one approval use when retrying the same reconciled effect", async () => {
    const receipt = requestEffect([nextApprovalReceiptId]);
    const approvalId = issueApproval(authority.approvalActionForReceipt(receipt));
    const first = await authority.beginActionAttempt(beginInput(receipt));
    connectorStore.completeExternalActionAttempt({
      external_action_attempt_id: first.external_action_attempt_id,
      owner: OWNER,
      outcome: "outcome_unknown",
      error_code: "connection_lost",
      error_message: "The request outcome is unknown.",
    });
    connectorStore.reconcileExternalAction({
      external_effect_receipt_id: receipt.external_effect_receipt_id,
      owner: OWNER,
      outcome: "failed",
      evidence_ref: EVIDENCE,
      reconciled_by_principal_id: OPERATOR,
    });

    const second = await authority.beginActionAttempt(beginInput(receipt));
    expect(second.attempt_number).toBe(2);
    expect(approvalStore.requireReceipt(approvalId).use_count).toBe(1);
  });

  it("rolls back earlier approval consumption if any required receipt is invalid", async () => {
    const ids = ["approvalreceipt:first", "approvalreceipt:second"];
    const receipt = requestEffect(ids);
    const exact = authority.approvalActionForReceipt(receipt);
    issueApproval(exact, ids[0]);
    issueApproval({ ...exact, input_digest: DIGEST_B }, ids[1]);

    await expect(authority.beginActionAttempt(beginInput(receipt))).rejects.toBeInstanceOf(ApprovalDeniedError);
    expect(approvalStore.requireReceipt(ids[0]).use_count).toBe(0);
    expect(approvalStore.requireReceipt(ids[1]).use_count).toBe(0);
    expect(connectorStore.requireExternalEffectReceiptForOwner(receipt.external_effect_receipt_id, OWNER).status)
      .toBe("requested");
  });

  it("uses retained receipts after the authority host restarts", async () => {
    const receipt = requestEffect([nextApprovalReceiptId]);
    issueApproval(authority.approvalActionForReceipt(receipt));
    const restarted = new CanonicalConnectorActionAuthority(
      db,
      new ConnectorStore(db, () => now),
      new ApprovalStore(db, { now: () => now }),
      {
        getExecution: (id: string) => authorityExecution("scope", id),
        getNodeExecution: (id: string) => authorityExecution("node", id),
        getAttempt: (id: string) => authorityExecution("attempt", id),
      } as any,
      WORKER,
    );

    const attempt = await restarted.beginActionAttempt(beginInput(receipt));
    expect(attempt).toMatchObject({ status: "started", attempt_number: 1 });
  });

  function authorityExecution(kind: "scope" | "node" | "attempt", id: string): any {
    if (kind === "scope" && id === PROVENANCE.scope_execution_id) return {
      execution_id: id,
      workspace_id: OWNER.id,
      revision_id: "compositionrevision:published-v4",
    };
    if (kind === "node" && id === PROVENANCE.node_execution_id) return {
      node_execution_id: id,
      execution_id: PROVENANCE.scope_execution_id,
      revision_id: "compositionrevision:published-v4",
      node_id: "nodeplacement:publish",
    };
    if (kind === "attempt" && id === PROVENANCE.execution_attempt_id) return {
      attempt_id: id,
      node_execution_id: PROVENANCE.node_execution_id,
      delivery_ids: [...PROVENANCE.delivery_ids],
    };
    return null;
  }
});
