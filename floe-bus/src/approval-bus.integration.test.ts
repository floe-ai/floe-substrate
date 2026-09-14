import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  DECIDE_APPROVAL_OPERATION_ID,
  CONFIGURE_APPROVAL_RESPONSE_OPERATION_ID,
  INSPECT_APPROVAL_OPERATION_ID,
  LIST_APPROVALS_OPERATION_ID,
  REQUEST_APPROVAL_OPERATION_ID,
} from "./approval-operations.js";
import {
  approvalReceiptStateRevision,
  type ApprovalAction,
  type ApprovalDecision,
  type ApprovalDecisionBinding,
  type ApprovalDecisionPolicyReference,
  type ApprovalRequestRecord,
} from "./approvals.js";
import { defaultConfig } from "./config.js";
import { registerExecutableActorFixture } from "./executable-actor-test-fixture.js";
import {
  createOperationAuthorityContext,
  type OperationInvocationRequest,
  type OperationInvocationResponse,
} from "./operations.js";
import { BusStore } from "./store.js";
import type { PolicyEvaluationFacts, PolicyRuleEffect } from "./policies.js";

const APPROVAL_GRANTS = new Set([
  LIST_APPROVALS_OPERATION_ID,
  INSPECT_APPROVAL_OPERATION_ID,
  REQUEST_APPROVAL_OPERATION_ID,
  DECIDE_APPROVAL_OPERATION_ID,
  CONFIGURE_APPROVAL_RESPONSE_OPERATION_ID,
]);

function action(): ApprovalAction {
  return {
    operation_id: "connector.worker.action.execute",
    authorized_principal_id: "worker:connector-host",
    target: { kind: "connector_binding", id: "connector-binding:publish", revision: "binding-revision:2" },
    input_digest: "b".repeat(64),
    artefact_version_ids: ["artefact-version:site"],
    composition_revision_id: null,
    node_placement_id: null,
    scope_execution_id: null,
    node_execution_id: null,
    connector_binding_revision_id: "connector-binding-revision:publish-2",
    extension_package_version_id: "extension-package-version:publisher-3",
    approval_policy_ref: { kind: "policy", id: "policy:publish", revision: "3" },
    capability_grant_ids: ["capability-grant:publisher"],
    expected_effect: {
      summary: "Publish the exact reviewed website to the production target.",
      external: true,
      reversibility: "reversible",
      resource_refs: [{ kind: "external_target", id: "site:campaign", revision: "production" }],
    },
  };
}

function receipt(response: OperationInvocationResponse) {
  expect(response.kind).toBe("receipt");
  if (response.kind !== "receipt") throw new Error("Expected operation receipt");
  return response.receipt;
}

describe("Approval canonical Bus integration", () => {
  let temp: string;
  let store: BusStore;
  let workspaceId: string;
  let contextId: string;
  const broadcasts: Array<{ type: string; payload: Record<string, unknown> }> = [];

  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), "floe-approval-integration-"));
    const configPath = join(temp, "config.yaml");
    const config = defaultConfig(temp);
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    store = new BusStore(configPath, config);
    broadcasts.length = 0;
    const broadcast = (type: string, payload: Record<string, unknown>) => broadcasts.push({ type, payload });
    store.setBroadcast(broadcast);
    const workspace = store.registerWorkspace({
      locator: join(temp, "workspace"),
      name: "Campaign",
      init_authorized: true,
    }, broadcast);
    workspaceId = workspace.workspace_id;
    const scope = store.createScope({
      workspace_id: workspaceId,
      scope_id: "campaign-publishing",
      title: "Campaign publishing",
    }, broadcast);
    contextId = store.contextStore.createContext({
      context_id: "context:publish-approval",
      workspace_id: workspaceId,
      scope_id: scope.scope_id,
      created_by_endpoint_id: null,
      created_by_principal_id: store.localOperatorPrincipalId,
      participants: [],
      title: "Approve campaign publication",
    });
    store.artefactStore.createArtefact({
      artefact_id: "artefact:site",
      workspace_id: workspaceId,
      type_ref: "core:website-tree",
      idempotency_key: "approval-test-site",
    });
    store.artefactStore.publishVersion({
      artefact_id: "artefact:site",
      artefact_version_id: "artefact-version:site",
      idempotency_key: "approval-test-site-v1",
      content_ref: {
        kind: "content-addressed",
        resolver_id: "test-content",
        digest: { algorithm: "sha256", value: "a".repeat(64) },
        media_type: "application/vnd.floe.website-tree+json",
      },
    });
    store.capabilityGrantStore.issueGrant({
      grant_id: "capability-grant:operator-approvals",
      principal_id: store.localOperatorPrincipalId,
      boundary: { kind: "workspace", workspace_id: workspaceId },
      operation_ids: [DECIDE_APPROVAL_OPERATION_ID],
      expires_at: "2099-09-04T01:00:00.000Z",
      issuer_id: "system:test-authority",
      evidence: [{ kind: "test", ref: "approval-bus.integration" }],
    });
  });

  afterEach(() => {
    try { store.close(); } catch {}
    rmSync(temp, { recursive: true, force: true });
  });

  function environment(
    principalId = store.localOperatorPrincipalId,
    sessionId = "session:operator",
  ) {
    const authority = createOperationAuthorityContext({
      principal_id: principalId,
      boundary: { kind: "workspace", workspace_id: workspaceId },
      grants: APPROVAL_GRANTS,
      interaction: {
        mode: "interactive",
        session_id: sessionId,
        confirmed_prompts: new Set(),
        approval_refs: new Set(),
      },
    });
    return {
      authority,
      resolve_resource: (target: { kind: string; id: string }) =>
        store.resolveOperationResource(target, authority.boundary),
    };
  }

  function operation(
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

  function registerActor(name: string): string {
    const endpointId = `actor:${workspaceId}:${name}`;
    store.registerEndpoint({
      endpoint_id: endpointId,
      workspace_id: workspaceId,
      name,
      bridge_id: null,
      status: "idle",
    }, () => {});
    registerExecutableActorFixture(store, workspaceId, endpointId);
    return endpointId;
  }

  function prepareApprovalGate(): {
    binding: ApprovalDecisionBinding;
    action: ApprovalAction;
    gate_actor_id: string;
    targets: Record<ApprovalDecision, string>;
    expected_edges: Record<ApprovalDecision, string>;
  } {
    const gate = registerActor("release-gate");
    const targets = {
      approved: registerActor("publisher"),
      rejected: registerActor("closer"),
      changes_requested: registerActor("reworker"),
    };
    const draft = store.createScopeCompositionDraft({
      workspace_id: workspaceId,
      scope_id: "campaign-publishing",
      content: {
        nodes: [
          {
            node_id: "ingress",
            kind: "event",
            context_policy: { mode: "fixed", context_id: contextId },
            config: { event_type: "release.ready" },
          },
          {
            node_id: "release-gate",
            kind: "actor",
            resource_id: gate,
            activation: { mode: "per_delivery" },
            context_policy: { mode: "fixed", context_id: contextId },
          },
          ...Object.entries(targets).map(([decision, endpointId]) => ({
            node_id: `after-${decision}`,
            kind: "actor" as const,
            resource_id: endpointId,
            activation: { mode: "per_delivery" as const },
            context_policy: { mode: "new_per_execution" as const },
          })),
        ],
        ports: [
          { port_id: "ingress:out", node_id: "ingress", name: "ready", direction: "output", event_types: ["release.ready"] },
          { port_id: "release-gate:in", node_id: "release-gate", name: "candidate", direction: "input", event_types: ["release.ready"], min_count: 1 },
          ...(["approved", "rejected", "changes_requested"] as ApprovalDecision[]).flatMap((decision) => [
            {
              port_id: `release-gate:${decision}`,
              node_id: "release-gate",
              name: decision,
              direction: "output" as const,
              event_types: [`approval.${decision}`],
              artefact_types: ["core:website-tree"],
              min_count: 1,
              max_count: 1,
            },
            {
              port_id: `after-${decision}:in`,
              node_id: `after-${decision}`,
              name: "decision",
              direction: "input" as const,
              event_types: [`approval.${decision}`],
              artefact_types: ["core:website-tree"],
              min_count: 1,
              max_count: 1,
            },
          ]),
        ],
        edges: [
          { edge_id: "ingress-to-gate", source_port_id: "ingress:out", target_port_id: "release-gate:in" },
          ...(["approved", "rejected", "changes_requested"] as ApprovalDecision[]).map((decision) => ({
            edge_id: `gate-${decision}`,
            source_port_id: `release-gate:${decision}`,
            target_port_id: `after-${decision}:in`,
          })),
        ],
      },
    }, () => {});
    const revision = store.publishScopeComposition({
      revision_id: draft.revision_id,
      expected_published_revision_id: null,
    }, () => {});
    const started = store.startScopeExecution({
      workspace_id: workspaceId,
      scope_id: "campaign-publishing",
      ingress_node_id: "ingress",
      output_port_id: "ingress:out",
      content: { candidate: "campaign-site" },
      idempotency_key: "release-candidate",
    }, () => {});
    const gateExecution = store.getScopeExecutionProjection(started.execution.execution_id)!
      .node_executions.find((node) => node.node_id === "release-gate")!;
    const waiting = store.scopeExecutionStore.setNodeExecutionStatus(
      gateExecution.node_execution_id,
      "waiting_human",
    );
    store.scopeExecutionStore.setExecutionStatus(started.execution.execution_id, "waiting_human");
    const binding: ApprovalDecisionBinding = {
      scope_execution_id: started.execution.execution_id,
      composition_revision_id: revision.revision_id,
      node_execution_id: waiting.node_execution_id,
      node_placement_id: waiting.node_id,
      node_execution_state_revision: waiting.state_revision,
      outcome_port_ids: {
        approved: "release-gate:approved",
        rejected: "release-gate:rejected",
        changes_requested: "release-gate:changes_requested",
      },
    };
    return {
      binding,
      action: {
        ...action(),
        target: { kind: "node_execution", id: binding.node_execution_id, revision: String(binding.node_execution_state_revision) },
        composition_revision_id: binding.composition_revision_id,
        node_placement_id: binding.node_placement_id,
        scope_execution_id: binding.scope_execution_id,
        node_execution_id: binding.node_execution_id,
        connector_binding_revision_id: null,
        extension_package_version_id: null,
        approval_policy_ref: null,
        capability_grant_ids: [],
      },
      gate_actor_id: gate,
      targets,
      expected_edges: {
        approved: "gate-approved",
        rejected: "gate-rejected",
        changes_requested: "gate-changes_requested",
      },
    };
  }

  function createDecisionPolicy(
    prepared: ReturnType<typeof prepareApprovalGate>,
    approvers: Extract<PolicyRuleEffect, { kind: "require_approval" }>["approvers"] = {
      mode: "any",
      principal_ids: [store.localOperatorPrincipalId],
      roles: [],
    },
  ): ApprovalDecisionPolicyReference {
    const policy = store.policyStore.createPolicy({
      workspace_id: workspaceId,
      policy_id: "policy:release-gate",
      category: "approval",
      content: {
        label: "Release decision",
        description: "Requires an exact decision before a release gate advances.",
        rules: [{
          rule_id: "approve-release-gate",
          priority: 100,
          match: {
            operation_ids: [prepared.action.operation_id],
            scope_composition_revision_ids: [prepared.binding.composition_revision_id],
            node_placement_ids: [prepared.binding.node_placement_id],
          },
          effect: {
            kind: "require_approval",
            reason: "The release gate requires the configured decision policy.",
            approvers,
          },
        }],
      },
      created_by_principal_id: store.localOperatorPrincipalId,
    });
    const published = store.policyStore.publishRevision({
      workspace_id: workspaceId,
      policy_revision_id: policy.draft.policy_revision_id,
      expected_current_revision_id: null,
    });
    store.policyStore.bindRevision({
      workspace_id: workspaceId,
      policy_revision_id: published.revision.policy_revision_id,
      subject: { kind: "workspace", id: workspaceId },
      bound_by_principal_id: store.localOperatorPrincipalId,
    });
    const facts: PolicyEvaluationFacts = {
      authority_boundary: { kind: "workspace", workspace_id: workspaceId },
      workspace_id: workspaceId,
      principal_id: prepared.action.authorized_principal_id,
      principal_roles: [],
      actor_role_evidence: [],
      interaction_mode: "unattended",
      provenance: {
        cause_event_id: null,
        delivery_ids: [],
        execution_attempt_id: null,
        node_execution_id: prepared.action.node_execution_id,
        scope_execution_id: prepared.action.scope_execution_id,
      },
      operation_id: prepared.action.operation_id,
      target: prepared.action.target,
      effects: {
        mode: "write",
        reversibility: prepared.action.expected_effect.reversibility,
        external: prepared.action.expected_effect.external,
        secret_access: "none",
      },
      scope_id: "campaign-publishing",
      actor_id: prepared.gate_actor_id,
      scope_composition_revision_id: prepared.binding.composition_revision_id,
      node_placement_id: prepared.binding.node_placement_id,
      connector_binding_id: null,
      extension_installation_id: null,
      extension_package_version_id: null,
      data_classes: [],
      worker_trust_level: null,
    };
    const evaluation = store.policyStore.evaluate(facts);
    expect(evaluation.decision).toBe("require_approval");
    return {
      policy_evaluation_id: evaluation.evaluation_id,
      policy_revision_id: published.revision.policy_revision_id,
      rule_id: "approve-release-gate",
    };
  }

  async function responseRequest() {
    const created = receipt(await store.operationRegistry.invoke(environment(), operation(
      REQUEST_APPROVAL_OPERATION_ID, { action: action(), context_id: contextId,
        reason: "Return the exact decision to its selected collaborator", expires_at: "2099-09-04T01:00:00.000Z" },
      "response:request")));
    expect(created.state, JSON.stringify(created.refusal)).toBe("completed");
    return store.approvalStore.requireRequest((created.result as { request: ApprovalRequestRecord }).request.approval_request_id);
  }

  it("upgrades a retained schema-13 approval and backs it up before adding response configuration", async () => {
    const recipient = registerActor("upgrade-recipient"); store.contextStore.addParticipant(contextId, recipient);
    const original = await responseRequest(); const config = store.config;
    store.db.exec("ALTER TABLE approval_requests DROP COLUMN response_participant_id; PRAGMA user_version = 13; DELETE FROM schema_migrations WHERE schema_version = 14;");
    store.close(); store = new BusStore(join(temp,"config.yaml"),config);
    expect(store.db.prepare("PRAGMA user_version").get()).toMatchObject({user_version:14});
    expect(store.approvalStore.requireRequest(original.approval_request_id)).toEqual(original);
    const migration = store.db.prepare("SELECT previous_version,backup_path FROM schema_migrations WHERE schema_version=14").get() as {previous_version:number;backup_path:string};
    expect(migration.previous_version).toBe(13);
    const backup = new DatabaseSync(migration.backup_path,{readOnly:true});
    try {
      expect(backup.prepare("PRAGMA user_version").get()).toMatchObject({user_version:13});
      expect(backup.prepare("PRAGMA table_info(approval_requests)").all().some(column=>column.name==='response_participant_id')).toBe(false);
      expect(backup.prepare("SELECT action_digest FROM approval_requests WHERE approval_request_id=?").get(original.approval_request_id)).toMatchObject({action_digest:original.action_digest});
    } finally {backup.close();}
    expect(store.configureApprovalResponse({workspace_id:workspaceId,approval_request_id:original.approval_request_id,
      expected_state_revision:original.state_revision,response_participant_id:recipient}).response_participant_id).toBe(recipient);
    expect(store.db.prepare("PRAGMA integrity_check").get()).toMatchObject({integrity_check:"ok"});
    expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each(["approved", "rejected", "changes_requested"] as const)("delivers one %s response after restart without changing the action", async decision => {
    const recipient = registerActor("response-recipient");
    store.contextStore.addParticipant(contextId, recipient);
    const original = await responseRequest();
    const configure = operation(CONFIGURE_APPROVAL_RESPONSE_OPERATION_ID, { response_participant_id: recipient },
      "response:configure", { kind: "approval_request", id: original.approval_request_id }, String(original.state_revision));
    const configured = receipt(await store.operationRegistry.invoke(environment(), configure));
    expect(configured.state, JSON.stringify(configured.refusal)).toBe("completed");
    const updated = store.approvalStore.requireRequest(original.approval_request_id);
    expect(updated).toMatchObject({ action: original.action, action_digest: original.action_digest,
      decision_policy_digest: original.decision_policy_digest, response_participant_id: recipient });
    expect(receipt(await store.operationRegistry.invoke(environment(), configure))).toEqual(configured);
    const config = store.config;
    store.close(); store = new BusStore(join(temp, "config.yaml"), config);
    store.setBroadcast((type, payload = {}) => broadcasts.push({type, payload}));
    expect(store.approvalStore.requireRequest(original.approval_request_id)).toEqual(updated);
    const decide = operation(DECIDE_APPROVAL_OPERATION_ID, { decision, reason: "Respond to the saved exact action" },
      "response:decide", {kind: "approval_request", id: original.approval_request_id});
    const result = receipt(await store.operationRegistry.invoke(environment(), decide));
    expect(result.state, JSON.stringify(result.refusal)).toBe("completed");
    const decided = (result.result as {request: ApprovalRequestRecord}).request;
    const queues = () => store.db.prepare("SELECT event_id, destination_endpoint_id FROM event_queue WHERE event_id = ?").all(decided.decision_event_id);
    expect(queues()).toEqual([{event_id: decided.decision_event_id, destination_endpoint_id: recipient}]);
    expect(store.getEvent(decided.decision_event_id!)?.context_id).toBe(contextId);
    expect(store.getEvent(decided.decision_event_id!)?.content).toMatchObject({decision, response_participant_id: recipient});
    expect(receipt(await store.operationRegistry.invoke(environment(), decide))).toEqual(result);
    expect(queues()).toHaveLength(1);
    expect(store.db.prepare("SELECT count(*) AS n FROM scope_executions WHERE workspace_id = ?").get(workspaceId)).toMatchObject({n:0});
  });

  it("refuses a missing recipient, missing authority and stale response changes", async () => {
    const original = await responseRequest();
    const target = {kind: "approval_request", id: original.approval_request_id};
    const recipient = registerActor("not-yet-participating");
    const missing = receipt(await store.operationRegistry.invoke(environment(), operation(
      CONFIGURE_APPROVAL_RESPONSE_OPERATION_ID, {response_participant_id: recipient}, "response:missing", target, "1")));
    expect(missing.state).toBe("refused");
    expect(store.approvalStore.requireRequest(original.approval_request_id)).toEqual(original);
    store.contextStore.addParticipant(contextId, recipient);
    const env = environment();
    const denied = await store.operationRegistry.invoke({...env, authority:{...env.authority, grants:new Set([INSPECT_APPROVAL_OPERATION_ID])}}, operation(
      CONFIGURE_APPROVAL_RESPONSE_OPERATION_ID, {response_participant_id: recipient}, "response:denied", target, "1"));
    expect(receipt(denied).state).toBe("refused");
    expect(receipt(await store.operationRegistry.invoke(environment(), operation(
      CONFIGURE_APPROVAL_RESPONSE_OPERATION_ID, {response_participant_id: recipient}, "response:allowed", target, "1"))).state).toBe("completed");
    expect(receipt(await store.operationRegistry.invoke(environment(), operation(
      CONFIGURE_APPROVAL_RESPONSE_OPERATION_ID, {response_participant_id: null}, "response:stale", target, "1"))).state).toBe("refused");
    expect(receipt(await store.operationRegistry.invoke(environment(), operation(
      CONFIGURE_APPROVAL_RESPONSE_OPERATION_ID, {response_participant_id: null}, "response:remove", target, "2"))).state).toBe("completed");
    expect(store.approvalStore.requireRequest(original.approval_request_id).response_participant_id).toBeNull();
  });

  it("records the decision without leaking it to a removed participant", async () => {
    const recipient = registerActor("removed-recipient"); store.contextStore.addParticipant(contextId, recipient);
    const original = await responseRequest();
    store.configureApprovalResponse({ workspace_id: workspaceId, approval_request_id: original.approval_request_id,
      expected_state_revision: original.state_revision, response_participant_id: recipient });
    store.contextStore.removeParticipant(contextId, recipient);
    const result = receipt(await store.operationRegistry.invoke(environment(), operation(DECIDE_APPROVAL_OPERATION_ID,
      {decision:"changes_requested", reason:"Keep the decision even if its recipient left"}, "response:removed-decision",
      {kind:"approval_request",id:original.approval_request_id})));
    expect(result.state).toBe("completed");
    const decided = (result.result as {request:ApprovalRequestRecord}).request;
    expect(store.db.prepare("SELECT count(*) AS n FROM event_queue WHERE event_id = ?").get(decided.decision_event_id)).toMatchObject({n:0});
    expect(store.getEvent(decided.decision_event_id!)?.metadata.response_suppressed_reason).toBe("recipient_unavailable");
  });

  it("stores one decision Event and one exact receipt through the shared operation registry", async () => {
    const requestResult = receipt(await store.operationRegistry.invoke(environment(), operation(
      REQUEST_APPROVAL_OPERATION_ID,
      {
        action: action(),
        context_id: contextId,
        reason: "The exact tested site is ready for a publication decision.",
        expires_at: "2099-09-04T01:00:00.000Z",
        maximum_uses: 1,
      },
      "request:publish-site",
    )));
    expect(requestResult.state, JSON.stringify(requestResult.refusal)).toBe("completed");
    const request = (requestResult.result as any).request;
    expect(store.resolveOperationResource(
      { kind: "approval_request", id: request.approval_request_id },
      { kind: "workspace", workspace_id: workspaceId },
    )?.ref.revision).toBe("1");

    const decisionInvocation = operation(
      DECIDE_APPROVAL_OPERATION_ID,
      { decision: "approved", reason: "Approve only this exact site and production target." },
      "decide:publish-site",
      { kind: "approval_request", id: request.approval_request_id },
    );
    const decisionResult = receipt(await store.operationRegistry.invoke(environment(), decisionInvocation));
    expect(decisionResult.state, JSON.stringify(decisionResult.refusal)).toBe("completed");
    const approvalReceipt = (decisionResult.result as any).receipt;
    expect(approvalReceipt).toMatchObject({
      action: action(),
      context_id: contextId,
      requested_by_principal_id: store.localOperatorPrincipalId,
      approved_by_principal_id: store.localOperatorPrincipalId,
      maximum_uses: 1,
    });

    const decisionEvents = store.db.prepare(`
      SELECT event_id, context_id, type, content_json, metadata_json
      FROM events WHERE context_id = ? AND type = 'approval.decision'
    `).all(contextId) as Array<Record<string, unknown>>;
    expect(decisionEvents).toHaveLength(1);
    expect(decisionEvents[0]).toMatchObject({
      event_id: approvalReceipt.decision_event_id,
      context_id: contextId,
      type: "approval.decision",
    });
    expect(JSON.parse(String(decisionEvents[0]!.content_json))).toMatchObject({
      approval_request_id: request.approval_request_id,
      decision: "approved",
      action_digest: approvalReceipt.action_digest,
      action: action(),
    });
    expect(JSON.parse(String(decisionEvents[0]!.metadata_json))).toMatchObject({
      source_principal_id: store.localOperatorPrincipalId,
      semantic_operation_id: DECIDE_APPROVAL_OPERATION_ID,
    });
    expect(store.artefactStore.listAssociations("artefact-version:site")).toEqual(expect.arrayContaining([
      expect.objectContaining({ target_kind: "event", target_id: approvalReceipt.decision_event_id, role: "evidence" }),
      expect.objectContaining({ target_kind: "context", target_id: contextId, role: "evidence" }),
    ]));
    expect(store.resolveOperationResource(
      { kind: "approval_receipt", id: approvalReceipt.approval_receipt_id },
      { kind: "workspace", workspace_id: workspaceId },
    )?.ref.revision).toBe(approvalReceiptStateRevision(approvalReceipt));
    expect(store.contextOperationBackend.listRetainedReferences(workspaceId, contextId))
      .toContainEqual(expect.objectContaining({
        kind: "approval_request",
        id: request.approval_request_id,
        relationship: "approval_context:approved",
      }));

    const replay = await store.operationRegistry.invoke(environment(), decisionInvocation);
    expect(replay).toMatchObject({ kind: "receipt", replayed: true });
    expect(store.db.prepare("SELECT count(*) AS count FROM events WHERE type = 'approval.decision'").get())
      .toMatchObject({ count: 1 });
    expect(broadcasts.some((item) => item.type === "approval_decided")).toBe(true);
  });

  it.each<ApprovalDecision>(["approved", "rejected", "changes_requested"])(
    "advances the pinned Scope exactly once when the operator decides %s",
    async (decision) => {
      const prepared = prepareApprovalGate();
      const decisionPolicyRef = createDecisionPolicy(prepared);
      const requestResult = receipt(await store.operationRegistry.invoke(environment(), operation(
        REQUEST_APPROVAL_OPERATION_ID,
        {
          action: prepared.action,
          context_id: contextId,
          decision_binding: prepared.binding,
          decision_policy_ref: decisionPolicyRef,
          reason: "The exact candidate is waiting for one explicit release decision.",
          expires_at: "2099-09-04T01:00:00.000Z",
          maximum_uses: 1,
        },
        `request:gate:${decision}`,
      )));
      expect(requestResult.state, JSON.stringify(requestResult.refusal)).toBe("completed");
      const request = (requestResult.result as any).request as ApprovalRequestRecord;
      expect(request.decision_binding).toEqual(prepared.binding);

      const invocationId = `decision:gate:${decision}`;
      const decisionInvocation = operation(
        DECIDE_APPROVAL_OPERATION_ID,
        { decision, reason: `The operator selected ${decision} for this exact candidate.` },
        invocationId,
        { kind: "approval_request", id: request.approval_request_id },
      );
      const decided = receipt(await store.operationRegistry.invoke(environment(), decisionInvocation));
      expect(decided.state, JSON.stringify(decided.refusal)).toBe("completed");
      expect((decided.result as any).request.status).toBe(decision === "approved" ? "approved" : "rejected");
      expect((decided.result as any).request.decision).toBe(decision);
      expect((decided.result as any).receipt === null).toBe(decision !== "approved");

      const retainedRequest = store.approvalStore.requireRequest(request.approval_request_id);
      const event = store.getEvent(retainedRequest.decision_event_id!);
      expect(event).toMatchObject({
        type: `approval.${decision}`,
        context_id: contextId,
        artefact_version_ids: ["artefact-version:site"],
        metadata: {
          origin: "scope_approval_decision",
          composition_revision_id: prepared.binding.composition_revision_id,
          scope_execution_id: prepared.binding.scope_execution_id,
          node_execution_id: prepared.binding.node_execution_id,
          candidate_output_port_id: prepared.binding.outcome_port_ids[decision],
        },
      });
      const publication = store.scopeExecutionStore.getPublicationByIdempotencyKey(
        `approval-decision-publication:${request.approval_request_id}`,
      );
      expect(publication).toMatchObject({
        node_execution_id: prepared.binding.node_execution_id,
        port_id: prepared.binding.outcome_port_ids[decision],
        event_id: event!.event_id,
        outputs: [{ artefact_version_id: "artefact-version:site", member_key: "" }],
      });
      const traversal = store.scopeExecutionStore.listTraversals(prepared.binding.scope_execution_id)
        .find((candidate) => candidate.publication_id === publication!.publication_id);
      expect(traversal).toMatchObject({ edge_id: prepared.expected_edges[decision] });
      const delivery = store.db.prepare("SELECT * FROM event_queue WHERE queue_id = ?")
        .get(traversal!.delivery_id) as any;
      expect(delivery).toMatchObject({
        event_id: event!.event_id,
        destination_endpoint_id: prepared.targets[decision],
        composition_revision_id: prepared.binding.composition_revision_id,
        source_node_id: prepared.binding.node_placement_id,
        source_port_id: prepared.binding.outcome_port_ids[decision],
        edge_id: prepared.expected_edges[decision],
      });
      expect(store.scopeExecutionStore.getNodeExecution(prepared.binding.node_execution_id)?.status)
        .toBe("completed");
      expect(store.scopeExecutionStore.getExecution(prepared.binding.scope_execution_id)?.status)
        .toBe("active");
      expect(store.artefactStore.listAssociations("artefact-version:site")).toEqual(expect.arrayContaining([
        expect.objectContaining({ target_kind: "event", target_id: event!.event_id, role: "evidence" }),
        expect.objectContaining({ target_kind: "context", target_id: contextId, role: "evidence" }),
        expect.objectContaining({ target_kind: "scope_execution", target_id: prepared.binding.scope_execution_id, role: "output" }),
        expect.objectContaining({ target_kind: "node_execution", target_id: prepared.binding.node_execution_id, role: "output" }),
      ]));

      const countsBeforeReplay = {
        events: store.db.prepare("SELECT count(*) AS count FROM events").get(),
        publications: store.db.prepare("SELECT count(*) AS count FROM scope_output_publications").get(),
        traversals: store.db.prepare("SELECT count(*) AS count FROM scope_edge_traversals").get(),
        deliveries: store.db.prepare("SELECT count(*) AS count FROM event_queue").get(),
      };
      const directReplay = store.decideApprovalRequest({
        workspace_id: workspaceId,
        approval_request_id: request.approval_request_id,
        expected_state_revision: request.state_revision,
        decision,
        decided_by_principal_id: store.localOperatorPrincipalId,
        decision_reason: `The operator selected ${decision} for this exact candidate.`,
        operation_invocation_id: `transport-retry:${decision}`,
      });
      expect(directReplay.request.decision_event_id).toBe(event!.event_id);
      expect({
        events: store.db.prepare("SELECT count(*) AS count FROM events").get(),
        publications: store.db.prepare("SELECT count(*) AS count FROM scope_output_publications").get(),
        traversals: store.db.prepare("SELECT count(*) AS count FROM scope_edge_traversals").get(),
        deliveries: store.db.prepare("SELECT count(*) AS count FROM event_queue").get(),
      }).toEqual(countsBeforeReplay);
      const operationReplay = await store.operationRegistry.invoke(environment(), decisionInvocation);
      expect(operationReplay).toMatchObject({ kind: "receipt", replayed: true });
    },
  );

  it("keeps a Scope gate waiting until a named-plus-role quorum resolves, then routes the resolving Event once", async () => {
    const prepared = prepareApprovalGate();
    const reviewerPrincipal = "principal:release-reviewer";
    const reviewerActor = registerActor("human-release-reviewer");
    store.actorRoleAuthorityStore.bindPrincipal({
      workspace_id: workspaceId,
      principal_id: reviewerPrincipal,
      actor_id: reviewerActor,
      bound_by_principal_id: store.localOperatorPrincipalId,
      evidence_refs: [{
        kind: "operation_invocation",
        id: "test:bind-release-reviewer",
        revision: null,
      }],
    });
    store.actorRoleAuthorityStore.assignRole({
      workspace_id: workspaceId,
      actor_id: reviewerActor,
      role: "release-reviewer",
      boundary: { kind: "workspace", workspace_id: workspaceId },
      assigned_by_principal_id: store.localOperatorPrincipalId,
    });
    store.capabilityGrantStore.issueGrant({
      grant_id: "capability-grant:release-reviewer-approvals",
      principal_id: reviewerPrincipal,
      boundary: { kind: "workspace", workspace_id: workspaceId },
      operation_ids: [DECIDE_APPROVAL_OPERATION_ID],
      expires_at: "2099-09-04T01:00:00.000Z",
      issuer_id: "system:test-authority",
      evidence: [{ kind: "test", ref: "collective-scope-gate" }],
    });
    const policyRef = createDecisionPolicy(prepared, {
      mode: "quorum",
      principal_ids: [store.localOperatorPrincipalId],
      roles: ["release-reviewer"],
      quorum: 2,
    });
    const requested = receipt(await store.operationRegistry.invoke(environment(), operation(
      REQUEST_APPROVAL_OPERATION_ID,
      {
        action: prepared.action,
        context_id: contextId,
        decision_binding: prepared.binding,
        decision_policy_ref: policyRef,
        reason: "Both configured perspectives must accept this exact candidate.",
        expires_at: "2099-09-04T01:00:00.000Z",
      },
      "request:collective-gate",
    )));
    const request = (requested.result as any).request as ApprovalRequestRecord;
    const responseRecipient = registerActor("collective-response");
    store.contextStore.addParticipant(contextId, responseRecipient);
    store.configureApprovalResponse({workspace_id:workspaceId, approval_request_id:request.approval_request_id,
      expected_state_revision:request.state_revision, response_participant_id:responseRecipient});

    const firstInvocation = operation(
      DECIDE_APPROVAL_OPERATION_ID,
      { decision: "approved", reason: "The named operator accepts the exact candidate." },
      "decision:collective-operator",
      { kind: "approval_request", id: request.approval_request_id },
    );
    const first = receipt(await store.operationRegistry.invoke(environment(), firstInvocation));
    expect(first.state, JSON.stringify(first.refusal)).toBe("completed");
    expect((first.result as any).request).toMatchObject({
      status: "pending",
      progress: { approvals_received: 1, approvals_required: 2, resolution: null },
    });
    expect((first.result as any).receipt).toBeNull();
    expect(store.db.prepare("SELECT count(*) AS n FROM event_queue WHERE destination_endpoint_id = ?").get(responseRecipient)).toMatchObject({n:0});
    expect(store.scopeExecutionStore.getNodeExecution(prepared.binding.node_execution_id)?.status)
      .toBe("waiting_human");
    expect(store.scopeExecutionStore.getPublicationByIdempotencyKey(
      `approval-decision-publication:${request.approval_request_id}`,
    )).toBeNull();

    const secondReason = "The canonically assigned release reviewer accepts the exact candidate.";
    const second = receipt(await store.operationRegistry.invoke(
      environment(reviewerPrincipal, "session:release-reviewer"),
      operation(
        DECIDE_APPROVAL_OPERATION_ID,
        { decision: "approved", reason: secondReason },
        "decision:collective-reviewer",
        { kind: "approval_request", id: request.approval_request_id },
      ),
    ));
    expect(second.state, JSON.stringify(second.refusal)).toBe("completed");
    expect((second.result as any).request).toMatchObject({
      status: "approved",
      progress: { approvals_received: 2, approvals_required: 2, resolution: "approved" },
    });
    const resolvingDecision = (second.result as any).individual_decision;
    expect(store.db.prepare("SELECT event_id FROM event_queue WHERE destination_endpoint_id = ?").all(responseRecipient))
      .toEqual([{event_id:resolvingDecision.decision_event_id}]);
    expect(resolvingDecision.role_evidence).toEqual([
      expect.objectContaining({ role: "release-reviewer" }),
    ]);
    const publication = store.scopeExecutionStore.getPublicationByIdempotencyKey(
      `approval-decision-publication:${request.approval_request_id}`,
    );
    expect(publication).toMatchObject({
      event_id: resolvingDecision.decision_event_id,
      port_id: prepared.binding.outcome_port_ids.approved,
    });
    expect(store.scopeExecutionStore.getNodeExecution(prepared.binding.node_execution_id)?.status)
      .toBe("completed");

    const counts = {
      events: store.db.prepare("SELECT count(*) AS count FROM events WHERE correlation_id = ?")
        .get(request.approval_request_id),
      publications: store.db.prepare("SELECT count(*) AS count FROM scope_output_publications").get(),
      traversals: store.db.prepare("SELECT count(*) AS count FROM scope_edge_traversals").get(),
    };
    const replay = store.decideApprovalRequest({
      workspace_id: workspaceId,
      approval_request_id: request.approval_request_id,
      expected_state_revision: request.state_revision,
      decision: "approved",
      decided_by_principal_id: reviewerPrincipal,
      decision_reason: secondReason,
      operation_invocation_id: "decision:collective-reviewer-transport-retry",
    });
    expect(replay.individual_decision.approval_decision_id)
      .toBe(resolvingDecision.approval_decision_id);
    expect({
      events: store.db.prepare("SELECT count(*) AS count FROM events WHERE correlation_id = ?")
        .get(request.approval_request_id),
      publications: store.db.prepare("SELECT count(*) AS count FROM scope_output_publications").get(),
      traversals: store.db.prepare("SELECT count(*) AS count FROM scope_edge_traversals").get(),
    }).toEqual(counts);
  });

  it("refuses stale, wrong-Context, and wrong-Port decision bindings before retaining a request", () => {
    const prepared = prepareApprovalGate();
    const decisionPolicyRef = createDecisionPolicy(prepared);
    const otherContextId = store.contextStore.createContext({
      context_id: "context:other-approval",
      workspace_id: workspaceId,
      scope_id: "campaign-publishing",
      created_by_endpoint_id: null,
      created_by_principal_id: store.localOperatorPrincipalId,
      participants: [],
      title: "Wrong approval Context",
    });
    const attempt = (
      id: string,
      context_id: string,
      decision_binding: ApprovalDecisionBinding,
    ) => store.createApprovalRequest({
      workspace_id: workspaceId,
      context_id,
      decision_binding,
      decision_policy_ref: decisionPolicyRef,
      action: prepared.action,
      requested_by_principal_id: store.localOperatorPrincipalId,
      reason: "This invalid binding must not become operator attention.",
      expires_at: "2099-09-04T01:00:00.000Z",
      idempotency_key: id,
    });

    expect(() => attempt("stale", contextId, {
      ...prepared.binding,
      node_execution_state_revision: prepared.binding.node_execution_state_revision - 1,
    })).toThrow(/changed after the decision binding was prepared/);
    expect(() => attempt("wrong-context", otherContextId, prepared.binding))
      .toThrow(/must use the ApprovalRequest Context/);
    expect(() => attempt("wrong-port", contextId, {
      ...prepared.binding,
      outcome_port_ids: { ...prepared.binding.outcome_port_ids, rejected: "ingress:out" },
    })).toThrow(/must identify an output Port owned by NodePlacement/);
    expect(store.approvalStore.listRequests(workspaceId)).toEqual([]);
  });

  it("invalidates a pending request when its waiting NodeExecution changes after the request", () => {
    const prepared = prepareApprovalGate();
    const decisionPolicyRef = createDecisionPolicy(prepared);
    const request = store.createApprovalRequest({
      workspace_id: workspaceId,
      context_id: contextId,
      decision_binding: prepared.binding,
      decision_policy_ref: decisionPolicyRef,
      action: prepared.action,
      requested_by_principal_id: store.localOperatorPrincipalId,
      reason: "This exact waiting state is the only state the operator may decide.",
      expires_at: "2099-09-04T01:00:00.000Z",
      idempotency_key: "request:gate:changed-after-request",
    });
    store.scopeExecutionStore.setNodeExecutionStatus(prepared.binding.node_execution_id, "active");
    store.scopeExecutionStore.setNodeExecutionStatus(prepared.binding.node_execution_id, "waiting_human");

    expect(() => store.decideApprovalRequest({
      workspace_id: workspaceId,
      approval_request_id: request.approval_request_id,
      expected_state_revision: request.state_revision,
      decision: "approved",
      decided_by_principal_id: store.localOperatorPrincipalId,
      decision_reason: "This decision must not apply to a changed execution state.",
      operation_invocation_id: "decision:gate:changed-after-request",
    })).toThrow(/Scope decision binding is no longer current/);
    expect(store.approvalStore.requireRequest(request.approval_request_id)).toMatchObject({
      status: "invalidated",
      decided_by_principal_id: "system:approval-validity",
    });
    expect(store.db.prepare("SELECT count(*) AS count FROM events WHERE correlation_id = ?")
      .get(request.approval_request_id)).toMatchObject({ count: 0 });
  });

  it("rolls the decision Event back when the approval already resolved", async () => {
    const request = store.approvalStore.createRequest({
      workspace_id: workspaceId,
      context_id: contextId,
      action: action(),
      requested_by_principal_id: store.localOperatorPrincipalId,
      reason: "Test atomic decision rollback against stale state.",
      expires_at: "2099-09-04T01:00:00.000Z",
      maximum_uses: 1,
      idempotency_key: "request:atomic-rollback",
    });
    store.approvalStore.cancelRequest({
      workspace_id: workspaceId,
      approval_request_id: request.approval_request_id,
      expected_state_revision: request.state_revision,
      cancelled_by_principal_id: store.localOperatorPrincipalId,
      reason: "The request was cancelled before a late decision arrived.",
    });
    expect(() => store.decideApprovalRequest({
      workspace_id: workspaceId,
      approval_request_id: request.approval_request_id,
      expected_state_revision: request.state_revision,
      decision: "approved",
      decided_by_principal_id: store.localOperatorPrincipalId,
      decision_reason: "This late decision must fail atomically.",
      operation_invocation_id: "invocation:stale-decision",
    })).toThrow();
    expect(store.approvalStore.requireRequest(request.approval_request_id).status).toBe("cancelled");
    expect(store.db.prepare("SELECT count(*) AS count FROM events WHERE type = 'approval.decision'").get())
      .toMatchObject({ count: 0 });
  });
});
