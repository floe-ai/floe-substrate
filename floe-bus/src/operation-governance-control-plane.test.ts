import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import { defaultConfig } from "./config.js";
import { registerExecutableActorFixture } from "./executable-actor-test-fixture.js";
import {
  createOperationAuthorityContext,
  refusal,
  type OperationAuthorityBoundary,
  type OperationAuthorityContext,
  type OperationInvocationProvenance,
  type OperationInvocationRequest,
  type OperationInvocationResponse,
  type SemanticOperationDefinition,
} from "./operations.js";
import type { PolicyRule } from "./policies.js";
import { BusStore } from "./store.js";

type TestInput = Readonly<{
  secret?: string;
  artefact_version_id?: string;
}>;
type TestResult = Readonly<{ ok: true }>;

const TEST_OPERATION = "test.governed-effect";
const TEST_UNKNOWN_OPERATION = "test.unknown-effect";
const TEST_METRIC_OPERATION = "test.metric-effect";
const TEST_REFUSED_OPERATION = "test.refused-effect";
const TEST_RECOVERY_OPERATION = "test.recovery-effect";
const TEST_SPOOF_OPERATION = "test.spoof-effect";
const TEST_CROSS_CONTEXT_OPERATION = "test.cross-context-effect";
const TEST_HELD_OPERATION = "test.held-effect";
const TEST_REBIND_OPERATION = "test.restore-rebind";

function receipt(response: OperationInvocationResponse) {
  expect(response.kind).toBe("receipt");
  if (response.kind !== "receipt") throw new Error("Expected operation receipt");
  return response.receipt;
}

describe("Bus semantic-operation governance control plane", () => {
  let temp: string;
  let store: BusStore;
  let workspaceId: string;

  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), "floe-operation-governance-"));
    const configPath = join(temp, "config.yaml");
    const config = defaultConfig(temp);
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    store = new BusStore(configPath, config);
    const locator = join(temp, "workspace");
    mkdirSync(locator, { recursive: true });
    workspaceId = store.registerWorkspace({ locator, name: "Governed Workspace" }, () => {}).workspace_id;
  });

  afterEach(() => {
    try { store.close(); } catch {}
    rmSync(temp, { recursive: true, force: true });
  });

  function authority(
    boundary: OperationAuthorityBoundary = { kind: "workspace", workspace_id: workspaceId },
    principalId = "principal:operator",
  ): OperationAuthorityContext {
    return createOperationAuthorityContext({
      principal_id: principalId,
      boundary,
      capability_grant_ids: [`grant:${principalId}`],
      grants: new Set([
        TEST_OPERATION,
        TEST_UNKNOWN_OPERATION,
        TEST_METRIC_OPERATION,
        TEST_REFUSED_OPERATION,
        TEST_RECOVERY_OPERATION,
        TEST_SPOOF_OPERATION,
        TEST_CROSS_CONTEXT_OPERATION,
        TEST_HELD_OPERATION,
        TEST_REBIND_OPERATION,
      ]),
      interaction: {
        mode: "interactive",
        session_id: `session:${principalId}`,
        confirmed_prompts: new Set(),
        // Session strings deliberately do not authorize canonical approvals.
        approval_refs: new Set(["caller-claimed-approval"]),
      },
    });
  }

  function environment(
    principal = authority(),
    provenance: OperationInvocationProvenance = {
      cause_event_id: null,
      delivery_ids: [] as string[],
      execution_attempt_id: null,
      node_execution_id: null,
      scope_execution_id: null,
    },
  ) {
    return {
      authority: principal,
      provenance,
      resolve_resource: (target: { kind: string; id: string }) =>
        store.resolveOperationResource(target, principal.boundary),
    };
  }

  function request(operationId: string, key: string, input: TestInput = {}): OperationInvocationRequest {
    return {
      operation_id: operationId,
      operation_version: "1",
      input_schema_version: "1",
      idempotency_key: key,
      input,
    };
  }

  function definition(
    operationId: string,
    handler: SemanticOperationDefinition<TestInput, TestResult>["handler"],
    accounting?: SemanticOperationDefinition<TestInput, TestResult>["resource_accounting"],
  ): SemanticOperationDefinition<TestInput, TestResult> {
    return {
      operation_id: operationId,
      operation_version: "1",
      authority_boundary_kinds: ["workspace", "host"],
      category: "test",
      title: "Governed effect",
      description: "Exercises the canonical operation governance boundary.",
      effects: { mode: "write", reversibility: "reversible", external: true, secret_access: "brokered" },
      required_grants: [operationId],
      interaction_constraints: { allowed_modes: ["interactive"] },
      target: { resource_kinds: [], expected_revision: "not_applicable" },
      input: {
        version: "1",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            secret: { type: "string" },
            artefact_version_id: { type: "string" },
          },
        },
      },
      result: {
        version: "1",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["ok"],
          properties: { ok: { const: true } },
        },
      },
      resource_accounting: accounting,
      handler,
    };
  }

  function bindPolicy(policyId: string, rules: readonly PolicyRule[]) {
    const created = store.policyStore.createPolicy({
      workspace_id: workspaceId,
      policy_id: policyId,
      category: "operation",
      content: { label: policyId, description: `Rules for ${policyId}`, rules },
      created_by_principal_id: "principal:policy-owner",
    });
    const published = store.policyStore.publishRevision({
      workspace_id: workspaceId,
      policy_revision_id: created.draft.policy_revision_id,
      expected_current_revision_id: null,
    });
    store.policyStore.bindRevision({
      workspace_id: workspaceId,
      policy_revision_id: published.revision.policy_revision_id,
      subject: { kind: "workspace", id: workspaceId },
      bound_by_principal_id: "principal:policy-owner",
    });
    return published;
  }

  it("applies Workspace Policy before the handler, keeps host authority separate, audits exact refs, and replays once", async () => {
    const handler = vi.fn(async () => ({ state: "completed" as const, result: { ok: true as const } }));
    store.operationRegistry.register(definition(TEST_OPERATION, handler));
    store.artefactStore.createArtefact({
      artefact_id: "artefact:input",
      workspace_id: workspaceId,
      type_ref: "application/test",
      idempotency_key: "governed-artefact",
    });
    store.artefactStore.publishVersion({
      artefact_id: "artefact:input",
      artefact_version_id: "artefact-version:input:1",
      idempotency_key: "governed-artefact-v1",
      content_ref: {
        kind: "content-addressed",
        resolver_id: "test",
        digest: { algorithm: "sha256", value: "a".repeat(64) },
        media_type: "application/test",
      },
    });

    const firstRequest = request(TEST_OPERATION, "allowed-once", {
      secret: "must-never-appear-in-audit",
      artefact_version_id: "artefact-version:input:1",
    });
    const first = receipt(await store.operationRegistry.invoke(environment(), firstRequest));
    const replay = receipt(await store.operationRegistry.invoke(environment(), firstRequest));
    expect(first.state).toBe("completed");
    expect(replay).toEqual(first);
    expect(handler).toHaveBeenCalledTimes(1);

    const audit = store.auditStore.require(first.audit_ref!.id);
    expect(audit.request).toMatchObject({
      workspace_id: workspaceId,
      authority_boundary: { kind: "workspace", workspace_id: workspaceId },
      capability_grant_ids: ["grant:principal:operator"],
      artefact_version_ids: ["artefact-version:input:1"],
      provenance: {
        cause_event_id: null,
        delivery_ids: [],
        execution_attempt_id: null,
        node_execution_id: null,
        scope_execution_id: null,
      },
    });
    expect(JSON.stringify(audit)).not.toContain("must-never-appear-in-audit");
    expect(audit.outcome?.state).toBe("completed");

    const noGrantAuthority = createOperationAuthorityContext({
      principal_id: "principal:no-grant",
      boundary: { kind: "workspace", workspace_id: workspaceId },
      capability_grant_ids: [],
      grants: new Set(),
      interaction: {
        mode: "interactive",
        session_id: "session:no-grant",
        confirmed_prompts: new Set(),
        approval_refs: new Set(),
      },
    });
    const noGrant = receipt(await store.operationRegistry.invoke(
      environment(noGrantAuthority),
      request(TEST_OPERATION, "valid-but-not-granted"),
    ));
    expect(noGrant.state).toBe("refused");
    expect(noGrant.refusal?.code).toBe("operation_grant_required");
    expect(noGrant.governance.policy_evaluation_id).not.toBeNull();
    expect(store.auditStore.require(noGrant.audit_ref!.id).outcome?.state).toBe("refused");
    expect(handler).toHaveBeenCalledTimes(1);

    bindPolicy("deny-test-operation", [{
      rule_id: "deny",
      priority: 100,
      match: { operation_ids: [TEST_OPERATION] },
      effect: { kind: "deny", reason: "The Workspace has stopped this operation." },
    }]);
    const denied = receipt(await store.operationRegistry.invoke(
      environment(),
      request(TEST_OPERATION, "denied", { secret: "also-redacted" }),
    ));
    expect(denied.state).toBe("refused");
    expect(denied.refusal?.code).toBe("operation_policy_denied");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.auditStore.require(denied.audit_ref!.id).outcome?.state).toBe("refused");

    const host = authority({ kind: "host", host_id: store.localHostId });
    const hostReceipt = receipt(await store.operationRegistry.invoke(
      environment(host),
      request(TEST_OPERATION, "host-is-not-workspace", { secret: "host-redacted" }),
    ));
    expect(hostReceipt.state).toBe("completed");
    expect(handler).toHaveBeenCalledTimes(2);
    const hostEvaluation = store.policyStore.getEvaluation(hostReceipt.governance.policy_evaluation_id!)!;
    expect(hostEvaluation).toMatchObject({
      workspace_id: null,
      authority_boundary: { kind: "host", host_id: store.localHostId },
      evaluated_policy_revision_ids: [],
      decision: "allow",
    });
    expect(store.auditStore.require(hostReceipt.audit_ref!.id).request.workspace_id).toBeNull();
  });

  it("requires and idempotently consumes exact current role-approved receipts, then rejects stale authority", async () => {
    const handler = vi.fn(async () => ({ state: "completed" as const, result: { ok: true as const } }));
    store.operationRegistry.register(definition(TEST_OPERATION, handler));
    bindPolicy("approve-test-operation", [{
      rule_id: "reviewer-approval",
      priority: 50,
      match: { operation_ids: [TEST_OPERATION] },
      effect: {
        kind: "require_approval",
        reason: "A current reviewer must approve this exact effect.",
        approvers: { mode: "any", principal_ids: [], roles: ["reviewer"] },
      },
    }]);

    const reviewerActor = `actor:${workspaceId}:reviewer`;
    const reviewerPrincipal = "principal:reviewer";
    store.registerEndpoint({
      endpoint_id: reviewerActor,
      workspace_id: workspaceId,
      name: "Reviewer",
      bridge_id: null,
      status: "idle",
    }, () => {});
    registerExecutableActorFixture(store, workspaceId, reviewerActor);
    store.actorRoleAuthorityStore.bindPrincipal({
      workspace_id: workspaceId,
      principal_id: reviewerPrincipal,
      actor_id: reviewerActor,
      bound_by_principal_id: "principal:policy-owner",
      evidence_refs: [{ kind: "test_identity", id: reviewerPrincipal, revision: "1" }],
    });
    const reviewerRole = store.actorRoleAuthorityStore.assignRole({
      workspace_id: workspaceId,
      actor_id: reviewerActor,
      role: "reviewer",
      boundary: { kind: "workspace", workspace_id: workspaceId },
      assigned_by_principal_id: "principal:policy-owner",
    });
    store.capabilityGrantStore.issueGrant({
      principal_id: reviewerPrincipal,
      boundary: { kind: "workspace", workspace_id: workspaceId },
      operation_ids: ["approval.decide"],
      expires_at: "2099-01-01T00:00:00.000Z",
      issuer_id: "principal:policy-owner",
      evidence: [{ kind: "test", ref: "reviewer-role" }],
    });

    const rejectedRequest = request(TEST_OPERATION, "approval-rejected", { secret: "rejected-redacted" });
    const rejectedPending = receipt(await store.operationRegistry.invoke(environment(), rejectedRequest));
    expect(rejectedPending.state).toBe("awaiting_approval");
    const rejectedApproval = store.approvalStore.requireRequest(
      rejectedPending.governance.approval_request_ids[0]!,
    );
    store.decideApprovalRequest({
      workspace_id: workspaceId,
      approval_request_id: rejectedApproval.approval_request_id,
      expected_state_revision: rejectedApproval.state_revision,
      decision: "rejected",
      decided_by_principal_id: reviewerPrincipal,
      decision_reason: "The exact effect was not approved.",
      operation_invocation_id: "approval-decision:rejected",
    });
    const rejected = receipt(await store.operationRegistry.invoke(environment(), rejectedRequest));
    expect(rejected.state).toBe("refused");
    expect(rejected.refusal?.code).toBe("operation_approval_not_granted");
    expect(store.auditStore.require(rejected.audit_ref!.id).outcome?.state).toBe("refused");
    expect(handler).not.toHaveBeenCalled();

    const exactRequest = request(TEST_OPERATION, "approval-success", { secret: "approved-redacted" });
    const pending = receipt(await store.operationRegistry.invoke(environment(), exactRequest));
    expect(pending.state).toBe("awaiting_approval");
    expect(handler).not.toHaveBeenCalled();
    const approvalRequest = store.approvalStore.requireRequest(pending.governance.approval_request_ids[0]!);
    expect(approvalRequest.context_id).toBeNull();
    expect(approvalRequest.decision_binding).toBeNull();
    expect(approvalRequest.action).toMatchObject({
      operation_id: TEST_OPERATION,
      authorized_principal_id: "principal:operator",
      approval_policy_ref: {
        kind: "policy_evaluation",
        id: pending.governance.policy_evaluation_id,
      },
      capability_grant_ids: ["grant:principal:operator"],
    });
    const decision = store.decideApprovalRequest({
      workspace_id: workspaceId,
      approval_request_id: approvalRequest.approval_request_id,
      expected_state_revision: approvalRequest.state_revision,
      decision: "approved",
      decided_by_principal_id: reviewerPrincipal,
      decision_reason: "Reviewed the exact operation and effect.",
      operation_invocation_id: "approval-decision:success",
    });
    expect(decision.individual_decision.role_evidence).toEqual([
      expect.objectContaining({ role: "reviewer" }),
    ]);

    const completed = receipt(await store.operationRegistry.invoke(environment(), exactRequest));
    const completedReplay = receipt(await store.operationRegistry.invoke(environment(), exactRequest));
    expect(completed.state).toBe("completed");
    expect(completedReplay).toEqual(completed);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.approvalStore.requireReceipt(completed.governance.approval_receipt_ids[0]!).use_count).toBe(1);

    const staleRequest = request(TEST_OPERATION, "approval-stale", { secret: "stale-redacted" });
    const stalePending = receipt(await store.operationRegistry.invoke(environment(), staleRequest));
    const staleApproval = store.approvalStore.requireRequest(stalePending.governance.approval_request_ids[0]!);
    const staleDecision = store.decideApprovalRequest({
      workspace_id: workspaceId,
      approval_request_id: staleApproval.approval_request_id,
      expected_state_revision: staleApproval.state_revision,
      decision: "approved",
      decided_by_principal_id: reviewerPrincipal,
      decision_reason: "Reviewed before authority changed.",
      operation_invocation_id: "approval-decision:stale",
    });
    store.actorRoleAuthorityStore.revokeRoleAssignment({
      workspace_id: workspaceId,
      actor_role_assignment_id: reviewerRole.actor_role_assignment_id,
      revoked_by_principal_id: "principal:policy-owner",
      reason: "Reviewer rotation",
    });
    const stale = receipt(await store.operationRegistry.invoke(environment(), staleRequest));
    expect(stale.state).toBe("refused");
    expect(stale.refusal?.code).toBe("operation_approval_receipt_invalid");
    expect(store.approvalStore.requireReceipt(staleDecision.receipt!.approval_receipt_id).revoked_at).not.toBeNull();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("reserves before effects, commits measured use, refuses excess/missing metrics, and holds uncertain use", async () => {
    const completedHandler = vi.fn(async () => ({ state: "completed" as const, result: { ok: true as const } }));
    store.operationRegistry.register(definition(TEST_OPERATION, completedHandler));
    bindPolicy("one-operation-budget", [{
      rule_id: "one-operation",
      priority: 10,
      match: { operation_ids: [TEST_OPERATION] },
      effect: { kind: "limit", limits: [{ metric: "operation.count", maximum: 1, window: "all_time" }] },
    }]);
    const first = receipt(await store.operationRegistry.invoke(environment(), request(TEST_OPERATION, "budget-first")));
    expect(first.state).toBe("completed");
    expect(store.budgetStore.requireReservation(first.governance.budget_reservation_id!).state).toBe("committed");
    const exceeded = receipt(await store.operationRegistry.invoke(environment(), request(TEST_OPERATION, "budget-second")));
    expect(exceeded.state).toBe("refused");
    expect(exceeded.refusal?.code).toBe("operation_budget_exceeded");
    expect(completedHandler).toHaveBeenCalledTimes(1);

    const missingMetricHandler = vi.fn(async () => ({ state: "completed" as const, result: { ok: true as const } }));
    store.operationRegistry.register(definition(TEST_METRIC_OPERATION, missingMetricHandler));
    bindPolicy("required-metric-budget", [{
      rule_id: "tokens",
      priority: 10,
      match: { operation_ids: [TEST_METRIC_OPERATION] },
      effect: { kind: "limit", limits: [{ metric: "model.tokens", maximum: 100, window: "operation" }] },
    }]);
    const unavailable = receipt(await store.operationRegistry.invoke(
      environment(),
      request(TEST_METRIC_OPERATION, "metric-unavailable"),
    ));
    expect(unavailable.state).toBe("refused");
    expect(unavailable.refusal?.code).toBe("operation_budget_estimate_unavailable");
    expect(missingMetricHandler).not.toHaveBeenCalled();

    const unknownHandler = vi.fn(async () => {
      throw new Error("lost handler ownership");
    });
    store.operationRegistry.register(definition(TEST_UNKNOWN_OPERATION, unknownHandler));
    bindPolicy("unknown-operation-budget", [{
      rule_id: "unknown-operation",
      priority: 10,
      match: { operation_ids: [TEST_UNKNOWN_OPERATION] },
      effect: { kind: "limit", limits: [{ metric: "operation.count", maximum: 5, window: "all_time" }] },
    }]);
    const unknown = receipt(await store.operationRegistry.invoke(
      environment(),
      request(TEST_UNKNOWN_OPERATION, "budget-unknown"),
    ));
    expect(unknown.state).toBe("outcome_unknown");
    expect(unknown.refusal?.code).toBe("operation_outcome_unknown");
    expect(store.budgetStore.requireReservation(unknown.governance.budget_reservation_id!).state)
      .toBe("outcome_unknown");
    expect(store.auditStore.require(unknown.audit_ref!.id).outcome?.state).toBe("outcome_unknown");

    const refusalHandler = vi.fn(async () => ({
      state: "refused" as const,
      refusal: refusal(
        "test_effect_not_started",
        "The handler proved that no effect began.",
        false,
        null,
      ),
    }));
    store.operationRegistry.register(definition(TEST_REFUSED_OPERATION, refusalHandler));
    bindPolicy("refused-operation-budget", [{
      rule_id: "refused-operation",
      priority: 10,
      match: { operation_ids: [TEST_REFUSED_OPERATION] },
      effect: { kind: "limit", limits: [{ metric: "operation.count", maximum: 5, window: "all_time" }] },
    }]);
    const refused = receipt(await store.operationRegistry.invoke(
      environment(),
      request(TEST_REFUSED_OPERATION, "budget-release"),
    ));
    expect(refused.state).toBe("refused");
    expect(refusalHandler).toHaveBeenCalledTimes(1);
    expect(store.budgetStore.requireReservation(refused.governance.budget_reservation_id!).state)
      .toBe("released");
    expect(store.auditStore.require(refused.audit_ref!.id).outcome?.state).toBe("refused");
  });

  it("recovers a durable running invocation as outcome_unknown after runtime ownership is lost", async () => {
    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => { handlerStarted = resolve; });
    const handler = vi.fn(async () => {
      handlerStarted();
      return new Promise<never>(() => {});
    });
    store.operationRegistry.register(definition(TEST_RECOVERY_OPERATION, handler));
    bindPolicy("recovery-operation-budget", [{
      rule_id: "recovery-operation",
      priority: 10,
      match: { operation_ids: [TEST_RECOVERY_OPERATION] },
      effect: { kind: "limit", limits: [{ metric: "operation.count", maximum: 5, window: "all_time" }] },
    }]);

    const exactRequest = request(TEST_RECOVERY_OPERATION, "recover-running");
    const abandonedInvocation = store.operationRegistry.invoke(environment(), exactRequest);
    await started;
    const row = store.db.prepare(`
      SELECT ledger_key, receipt_json FROM operation_invocation_ledger
      WHERE operation_id = ? AND idempotency_key = ?
    `).get(TEST_RECOVERY_OPERATION, exactRequest.idempotency_key) as {
      ledger_key: string;
      receipt_json: string;
    };
    const running = JSON.parse(row.receipt_json) as { execution_owner_id: string; audit_ref: { id: string }; governance: { budget_reservation_id: string } };
    expect(running.execution_owner_id).toMatch(/^operation_owner_/);
    store.db.prepare(`
      UPDATE operation_invocation_ledger SET receipt_json = ? WHERE ledger_key = ?
    `).run(JSON.stringify({ ...running, execution_owner_id: "operation_owner_99999999_abandoned" }), row.ledger_key);

    const recovered = receipt(await store.operationRegistry.invoke(environment(), exactRequest));
    expect(recovered.state).toBe("outcome_unknown");
    expect(recovered.refusal?.code).toBe("operation_outcome_unknown");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.budgetStore.requireReservation(running.governance.budget_reservation_id).state)
      .toBe("outcome_unknown");
    expect(store.auditStore.require(running.audit_ref.id).outcome?.state).toBe("outcome_unknown");
    void abandonedInvocation;
  });

  it("ignores caller-supplied role claims and refuses spoofed execution provenance before the handler", async () => {
    const handler = vi.fn(async () => ({ state: "completed" as const, result: { ok: true as const } }));
    store.operationRegistry.register(definition(TEST_SPOOF_OPERATION, handler));
    bindPolicy("do-not-trust-role-claims", [{
      rule_id: "deny-claimed-admin",
      priority: 100,
      match: { operation_ids: [TEST_SPOOF_OPERATION], principal_roles: ["admin"] },
      effect: { kind: "deny", reason: "Admin role claim was accepted." },
    }]);
    const roleClaimingAuthority = {
      ...authority(),
      principal_roles: ["admin"],
      actor_role_evidence: [{ role: "admin", authority_ref: "caller:claim" }],
    } as OperationAuthorityContext;

    const roleClaimIgnored = receipt(await store.operationRegistry.invoke(
      environment(roleClaimingAuthority),
      request(TEST_SPOOF_OPERATION, "role-claim-is-not-authority"),
    ));
    expect(roleClaimIgnored.state).toBe("completed");
    const evaluated = store.policyStore.getEvaluation(roleClaimIgnored.governance.policy_evaluation_id!)!;
    expect(evaluated.facts?.principal_roles).toEqual([]);
    expect(evaluated.facts?.actor_role_evidence).toEqual([]);
    expect(handler).toHaveBeenCalledTimes(1);

    const spoofedProvenance = receipt(await store.operationRegistry.invoke(
      environment(roleClaimingAuthority, {
        cause_event_id: null,
        delivery_ids: [],
        execution_attempt_id: null,
        node_execution_id: "node-execution:caller-claim",
        scope_execution_id: "scope-execution:caller-claim",
      }),
      request(TEST_SPOOF_OPERATION, "provenance-claim-is-refused"),
    ));
    expect(spoofedProvenance.state).toBe("refused");
    expect(spoofedProvenance.refusal?.code).toBe("operation_governance_provenance_invalid");
    expect(spoofedProvenance.governance.policy_evaluation_id).toBeNull();
    expect(store.auditStore.require(spoofedProvenance.audit_ref!.id).outcome?.state).toBe("refused");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("accepts a cross-Context causal Event only when it is an exact received NodeExecution input", async () => {
    const handler = vi.fn(async () => ({ state: "completed" as const, result: { ok: true as const } }));
    store.operationRegistry.register(definition(TEST_CROSS_CONTEXT_OPERATION, handler));
    const scope = store.createScope({
      workspace_id: workspaceId,
      scope_id: "cross-context-provenance",
      title: "Cross-Context provenance",
    }, () => {});
    const sourceContextId = store.contextStore.createContext({
      context_id: "context:source",
      workspace_id: workspaceId,
      scope_id: scope.scope_id,
      created_by_endpoint_id: null,
      created_by_principal_id: store.localOperatorPrincipalId,
      participants: [],
      title: "Source Context",
    });
    const workingContextId = store.contextStore.createContext({
      context_id: "context:working",
      workspace_id: workspaceId,
      scope_id: scope.scope_id,
      created_by_endpoint_id: null,
      created_by_principal_id: store.localOperatorPrincipalId,
      participants: [],
      title: "Working Context",
    });
    const actorId = `actor:${workspaceId}:cross-context-worker`;
    registerExecutableActorFixture(store, workspaceId, actorId);
    const draft = store.createScopeCompositionDraft({
      workspace_id: workspaceId,
      scope_id: scope.scope_id,
      content: {
        nodes: [{
          node_id: "worker",
          kind: "actor",
          resource_id: actorId,
          activation: { mode: "per_delivery" },
          context_policy: { mode: "fixed", context_id: workingContextId },
        }],
        ports: [{
          port_id: "worker:in",
          node_id: "worker",
          name: "input",
          direction: "input",
          event_types: ["test.input"],
          min_count: 1,
        }],
        edges: [],
      },
    }, () => {});
    const revision = store.publishScopeComposition({
      revision_id: draft.revision_id,
      expected_published_revision_id: null,
    }, () => {});
    const execution = store.scopeExecutionStore.createExecution({
      workspace_id: workspaceId,
      scope_id: scope.scope_id,
      revision_id: revision.revision_id,
      ingress_node_id: "worker",
      ingress_port_id: "worker:in",
    });
    const nodeExecution = store.scopeExecutionStore.createOrGetNodeExecution({
      execution_id: execution.execution_id,
      revision_id: revision.revision_id,
      node_id: "worker",
      activation_key: "input:1",
      context_id: workingContextId,
      status: "ready",
    });
    const received = store.appendContextEvent({
      type: "test.input",
      workspace_id: workspaceId,
      context_id: sourceContextId,
      content: { value: "received" },
      metadata: {},
    }, () => {});
    const unrelated = store.appendContextEvent({
      type: "test.input",
      workspace_id: workspaceId,
      context_id: sourceContextId,
      content: { value: "unrelated" },
      metadata: {},
    }, () => {});
    store.scopeExecutionStore.acceptInput({
      node_execution_id: nodeExecution.node_execution_id,
      port_id: "worker:in",
      delivery_id: "delivery:received",
      event_id: received.event_id,
    });
    const provenance = (causeEventId: string): OperationInvocationProvenance => ({
      cause_event_id: causeEventId,
      delivery_ids: [],
      execution_attempt_id: null,
      node_execution_id: nodeExecution.node_execution_id,
      scope_execution_id: execution.execution_id,
    });

    const exact = receipt(await store.operationRegistry.invoke(
      environment(authority(), provenance(received.event_id)),
      request(TEST_CROSS_CONTEXT_OPERATION, "exact-cross-context-input"),
    ));
    expect(exact.state).toBe("completed");

    const spoofed = receipt(await store.operationRegistry.invoke(
      environment(authority(), provenance(unrelated.event_id)),
      request(TEST_CROSS_CONTEXT_OPERATION, "unrelated-cross-context-event"),
    ));
    expect(spoofed.state).toBe("refused");
    expect(spoofed.refusal?.code).toBe("operation_governance_provenance_invalid");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("blocks held Workspace effects before the handler and allows only explicitly declared recovery effects", async () => {
    store.db.prepare(`
      INSERT INTO workspace_restore_holds (
        workspace_id, bundle_id, bundle_digest, state, reason, restored_at
      ) VALUES (?, ?, ?, 'held', ?, ?)
    `).run(
      workspaceId,
      "workspace-bundle:test",
      "b".repeat(64),
      "Target-host bindings are unresolved.",
      new Date().toISOString(),
    );
    const heldHandler = vi.fn(async () => ({ state: "completed" as const, result: { ok: true as const } }));
    store.operationRegistry.register(definition(TEST_HELD_OPERATION, heldHandler));

    const held = receipt(await store.operationRegistry.invoke(
      environment(),
      request(TEST_HELD_OPERATION, "held-effect"),
    ));
    expect(held.state).toBe("refused");
    expect(held.refusal?.code).toBe("workspace_restore_held");
    expect(held.governance.policy_evaluation_id).not.toBeNull();
    expect(store.auditStore.require(held.audit_ref!.id).outcome?.state).toBe("refused");
    expect(heldHandler).not.toHaveBeenCalled();

    const rebindHandler = vi.fn(async () => ({ state: "completed" as const, result: { ok: true as const } }));
    const rebindDefinition = definition(TEST_REBIND_OPERATION, rebindHandler);
    store.operationRegistry.register({
      ...rebindDefinition,
      effects: { ...rebindDefinition.effects, allowed_during_restore_hold: true },
    });
    const rebound = receipt(await store.operationRegistry.invoke(
      environment(),
      request(TEST_REBIND_OPERATION, "held-rebind"),
    ));
    expect(rebound.state).toBe("completed");
    expect(rebindHandler).toHaveBeenCalledTimes(1);
  });

  it("limits the restore-hold exemption to the exact canonical recovery operations", () => {
    const recoveryOperations = store.operationRegistry.listCurrentOperationMetadata({
      interaction_mode: "interactive",
      boundary_kind: "workspace",
    })
      .filter((operation) => operation.effects.allowed_during_restore_hold === true)
      .map((operation) => operation.operation_id)
      .sort();

    expect(recoveryOperations).toEqual([
      "actor.runtime-binding.replace",
      "connector.health.record",
      "credential.bind",
      "extension.enable",
      "workspace.package.reconcile_restore",
      "workspace.package.release_restore_hold",
    ]);
  });

  it("treats an invalid handler result as outcome_unknown rather than a harmless refusal", async () => {
    store.operationRegistry.register(definition(TEST_OPERATION, async () => ({
      state: "completed",
      result: { ok: false } as unknown as TestResult,
      changed_refs: [{ kind: "external_target", id: "target:possibly-changed", revision: "2" }],
    })));
    const result = receipt(await store.operationRegistry.invoke(
      environment(),
      request(TEST_OPERATION, "invalid-result"),
    ));
    expect(result.state).toBe("outcome_unknown");
    expect(result.refusal?.code).toBe("operation_result_invalid");
    expect(result.result).toBeNull();
    expect(result.changed_refs).toEqual([
      { kind: "external_target", id: "target:possibly-changed", revision: "2" },
    ]);
  });

  it("does not accept legacy caller session approval strings as an operation contract", () => {
    expect(() => store.operationRegistry.register({
      ...definition(TEST_OPERATION, async () => ({ state: "completed", result: { ok: true } })),
      interaction_constraints: {
        allowed_modes: ["interactive"],
        approval: {
          approval_id: "caller-claimed-approval",
          title: "Legacy approval",
          description: "Must not trust a session string.",
        },
      },
    })).toThrow(/canonical bound Policy decision/);
  });
});
