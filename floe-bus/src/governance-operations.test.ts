import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditStore, applyAuditSchema, auditValueDigest } from "./audit.js";
import {
  INSPECT_AUDIT_RECORD_OPERATION_ID,
  LIST_AUDIT_RECORDS_OPERATION_ID,
  registerAuditOperations,
  resolveAuditOperationResource,
} from "./audit-operations.js";
import { BudgetStore, applyBudgetSchema } from "./budgets.js";
import {
  INSPECT_BUDGET_RESERVATION_OPERATION_ID,
  LIST_BUDGET_RESERVATIONS_OPERATION_ID,
  LIST_RESOURCE_USAGE_OPERATION_ID,
  RECONCILE_BUDGET_NO_EFFECT_OPERATION_ID,
  registerBudgetOperations,
  resolveBudgetOperationResource,
} from "./budget-operations.js";
import { AjvOperationSchemaValidator } from "./operation-schema-validator-ajv.js";
import { createTestOperationRegistry } from "./operation-test-fixtures.js";
import {
  type OperationAuthorityBoundary,
  type OperationAuthorityContext,
  type OperationInvocationEnvironment,
  type OperationInvocationRequest,
  type OperationInvocationResponse,
  type OperationResourceIdentity,
} from "./operations.js";
import { PolicyStore, applyPolicySchema, type PolicyEvaluationFacts } from "./policies.js";

const IDS = [
  LIST_BUDGET_RESERVATIONS_OPERATION_ID,
  INSPECT_BUDGET_RESERVATION_OPERATION_ID,
  LIST_RESOURCE_USAGE_OPERATION_ID,
  RECONCILE_BUDGET_NO_EFFECT_OPERATION_ID,
  LIST_AUDIT_RECORDS_OPERATION_ID,
  INSPECT_AUDIT_RECORD_OPERATION_ID,
] as const;

function authority(
  boundary: OperationAuthorityBoundary = { kind: "workspace", workspace_id: "workspace:one" },
  confirmed = false,
): OperationAuthorityContext {
  return {
    principal_id: "principal:operator",
    boundary,
    grants: new Set(IDS),
    interaction: {
      mode: "interactive",
      session_id: "session:test",
      confirmed_prompts: new Set(confirmed ? ["budget.reconcile_no_effect.confirm"] : []),
      approval_refs: new Set(),
    },
  };
}

function request(
  operationId: string,
  input: unknown,
  key: string,
  target?: Readonly<{ kind: string; id: string; revision?: string }>,
): OperationInvocationRequest {
  return {
    operation_id: operationId,
    operation_version: "1",
    input_schema_version: "1",
    input,
    idempotency_key: key,
    ...(target
      ? {
          target: { kind: target.kind, id: target.id },
          ...(target.revision ? { expected_resource_revision: target.revision } : {}),
        }
      : {}),
  };
}

function receipt(response: OperationInvocationResponse) {
  expect(response.kind).toBe("receipt");
  if (response.kind !== "receipt") throw new Error("Expected an operation receipt.");
  return response.receipt;
}

describe("Budget and audit semantic operations", () => {
  let db: DatabaseSync;
  let policies: PolicyStore;
  let budgets: BudgetStore;
  let audits: AuditStore;
  let registry: ReturnType<typeof createTestOperationRegistry>;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    applyPolicySchema(db);
    applyBudgetSchema(db);
    applyAuditSchema(db);
    policies = new PolicyStore(db, { now: () => "2026-09-04T10:00:00.000Z" });
    budgets = new BudgetStore(db, { now: () => "2026-09-04T10:00:01.000Z" });
    audits = new AuditStore(db, { now: () => "2026-09-04T10:00:02.000Z" });
    registry = registerAuditOperations(
      registerBudgetOperations(
        createTestOperationRegistry(new AjvOperationSchemaValidator()),
        budgets,
      ),
      audits,
    );
  });

  afterEach(() => db.close());

  function environment(auth = authority()): OperationInvocationEnvironment {
    return {
      authority: auth,
      resolve_resource: async (target: OperationResourceIdentity) =>
        resolveBudgetOperationResource(budgets, auth.boundary, target)
        ?? resolveAuditOperationResource(audits, auth.boundary, target),
      now: () => "2026-09-04T10:00:03.000Z",
    };
  }

  function createUncertainReservation() {
    const created = policies.createPolicy({
      workspace_id: "workspace:one",
      policy_id: "policy:token-budget",
      category: "budget",
      content: {
        label: "Token budget",
        description: "Bound one operation.",
        rules: [{
          rule_id: "limit-tokens",
          priority: 1,
          match: {},
          effect: { kind: "limit", limits: [{ metric: "tokens.total", maximum: 100, window: "operation" }] },
        }],
      },
      created_by_principal_id: "principal:operator",
    });
    const published = policies.publishRevision({
      workspace_id: "workspace:one",
      policy_revision_id: created.draft.policy_revision_id,
      expected_current_revision_id: null,
    });
    policies.bindRevision({
      workspace_id: "workspace:one",
      policy_revision_id: published.revision.policy_revision_id,
      subject: { kind: "workspace", id: "workspace:one" },
      bound_by_principal_id: "principal:operator",
    });
    const facts: PolicyEvaluationFacts = {
      authority_boundary: { kind: "workspace", workspace_id: "workspace:one" },
      workspace_id: "workspace:one",
      principal_id: "principal:operator",
      principal_roles: [],
      actor_role_evidence: [],
      interaction_mode: "interactive",
      provenance: {
        cause_event_id: null,
        delivery_ids: [],
        execution_attempt_id: null,
        node_execution_id: null,
        scope_execution_id: null,
      },
      operation_id: "runtime.turn",
      target: null,
      effects: { mode: "write", reversibility: "none", external: false, secret_access: "brokered" },
      scope_id: null,
      actor_id: null,
      scope_composition_revision_id: null,
      node_placement_id: null,
      connector_binding_id: null,
      extension_installation_id: null,
      extension_package_version_id: null,
      data_classes: [],
      worker_trust_level: null,
    };
    const evaluation = policies.evaluate(facts);
    const reservation = budgets.reserve({
      source: { kind: "operation_invocation", id: "operation:one" },
      evaluation,
      facts: {
        workspace_id: "workspace:one",
        principal_id: "principal:operator",
        operation_id: "runtime.turn",
        scope_id: null,
        scope_execution_id: null,
        actor_id: null,
        scope_composition_revision_id: null,
        node_placement_id: null,
        connector_binding_id: null,
        extension_installation_id: null,
      },
      estimates: { "tokens.total": 50 },
    });
    if (!reservation) throw new Error("Expected a reservation.");
    return budgets.markOutcomeUnknown({
      workspace_id: "workspace:one",
      reservation_id: reservation.reservation_id,
    });
  }

  it("lists, inspects, and explicitly reconciles uncertain resource use", async () => {
    const reservation = createUncertainReservation();

    const listed = receipt(await registry.invoke(
      environment(),
      request(LIST_BUDGET_RESERVATIONS_OPERATION_ID, { state: "outcome_unknown" }, "list-budget"),
    ));
    expect((listed.result as any).reservations).toHaveLength(1);

    const inspected = receipt(await registry.invoke(
      environment(),
      request(INSPECT_BUDGET_RESERVATION_OPERATION_ID, {}, "inspect-budget", {
        kind: "budget_reservation",
        id: reservation.reservation_id,
      }),
    ));
    expect((inspected.result as any).state).toBe("outcome_unknown");

    const unconfirmed = receipt(await registry.invoke(
      environment(),
      request(RECONCILE_BUDGET_NO_EFFECT_OPERATION_ID, {}, "reconcile-unconfirmed", {
        kind: "budget_reservation",
        id: reservation.reservation_id,
        revision: reservation.updated_at,
      }),
    ));
    expect(unconfirmed.state).toBe("refused");
    expect(unconfirmed.refusal?.code).toBe("operation_confirmation_required");

    const reconciled = receipt(await registry.invoke(
      environment(authority(undefined, true)),
      request(RECONCILE_BUDGET_NO_EFFECT_OPERATION_ID, {}, "reconcile-confirmed", {
        kind: "budget_reservation",
        id: reservation.reservation_id,
        revision: reservation.updated_at,
      }),
    ));
    expect((reconciled.result as any).state).toBe("released");
  });

  it("keeps host and Workspace audit boundaries non-interchangeable", async () => {
    const emptyDigest = createHash("sha256").update("{}").digest("hex");
    const workspaceAudit = audits.begin({
      workspace_id: "workspace:one",
      invocation_id: "invocation:workspace",
      principal_id: "principal:operator",
      authority_boundary: { kind: "workspace", workspace_id: "workspace:one" },
      capability_grant_ids: [],
      interaction_mode: "interactive",
      operation_id: "scope.inspect",
      operation_version: "1",
      target_before: null,
      expected_resource_revision: null,
      idempotency_key: "workspace-audit",
      input_schema_version: "1",
      input_digest: emptyDigest,
      request_summary: {},
      reason: null,
      artefact_version_ids: [],
      provenance: {
        cause_event_id: null,
        delivery_ids: [],
        execution_attempt_id: null,
        node_execution_id: null,
        scope_execution_id: null,
      },
      policy_evaluation_id: null,
      budget_reservation_id: null,
    });
    audits.complete({
      audit_id: workspaceAudit.audit_id,
      state: "completed",
      result_schema_version: "1",
      result_digest: auditValueDigest({}),
      result_summary: {},
      refusal: null,
      changed_refs: [],
      target_after: null,
      prior_state_digest: null,
      resulting_state_digest: null,
      affected_artefact_version_ids: [],
    });
    audits.begin({
      workspace_id: null,
      invocation_id: "invocation:host",
      principal_id: "principal:host",
      authority_boundary: { kind: "host", host_id: "host:one" },
      capability_grant_ids: [],
      interaction_mode: "interactive",
      operation_id: "credential.account.prepare",
      operation_version: "1",
      target_before: null,
      expected_resource_revision: null,
      idempotency_key: "host-audit",
      input_schema_version: "1",
      input_digest: emptyDigest,
      request_summary: {},
      reason: null,
      artefact_version_ids: [],
      provenance: {
        cause_event_id: null,
        delivery_ids: [],
        execution_attempt_id: null,
        node_execution_id: null,
        scope_execution_id: null,
      },
      policy_evaluation_id: null,
      budget_reservation_id: null,
    });

    const workspaceList = receipt(await registry.invoke(
      environment(),
      request(LIST_AUDIT_RECORDS_OPERATION_ID, {}, "list-workspace-audit"),
    ));
    expect((workspaceList.result as any).records.map((item: any) => item.request.audit_id)).toEqual([workspaceAudit.audit_id]);

    const crossBoundary = receipt(await registry.invoke(
      environment(authority({ kind: "host", host_id: "host:one" })),
      request(INSPECT_AUDIT_RECORD_OPERATION_ID, {}, "cross-boundary-audit", {
        kind: "audit_record",
        id: workspaceAudit.audit_id,
      }),
    ));
    expect(crossBoundary.state).toBe("refused");
    expect(crossBoundary.refusal?.code).toBe("operation_target_not_found");
  });
});
