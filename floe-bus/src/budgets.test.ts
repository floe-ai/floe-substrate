import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BudgetExceededError, BudgetStore, applyBudgetSchema, type ResourceUsageFacts } from "./budgets.js";
import { PolicyStore, applyPolicySchema, type PolicyEvaluationFacts } from "./policies.js";

function policyFacts(workspaceId = "workspace-1"): PolicyEvaluationFacts {
  return {
    authority_boundary: { kind: "workspace", workspace_id: workspaceId },
    workspace_id: workspaceId,
    principal_id: "actor:builder",
    principal_roles: ["builder"],
    actor_role_evidence: [],
    interaction_mode: "unattended",
    provenance: {
      cause_event_id: null,
      delivery_ids: [],
      execution_attempt_id: null,
      node_execution_id: null,
      scope_execution_id: null,
    },
    operation_id: "runtime.turn",
    target: null,
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "brokered" },
    scope_id: "scope-1",
    actor_id: "actor-1",
    scope_composition_revision_id: "scope-revision-1",
    node_placement_id: "node-1",
    connector_binding_id: null,
    extension_installation_id: null,
    extension_package_version_id: null,
    data_classes: ["internal"],
    worker_trust_level: "managed",
  };
}

function usageFacts(workspaceId = "workspace-1", scopeExecutionId = "execution-1"): ResourceUsageFacts {
  return {
    workspace_id: workspaceId,
    principal_id: "actor:builder",
    operation_id: "runtime.turn",
    scope_id: "scope-1",
    scope_execution_id: scopeExecutionId,
    actor_id: "actor-1",
    scope_composition_revision_id: "scope-revision-1",
    node_placement_id: "node-1",
    connector_binding_id: null,
    extension_installation_id: null,
  };
}

describe("BudgetStore", () => {
  let db: DatabaseSync;
  let policies: PolicyStore;
  let budgets: BudgetStore;
  let currentTime: string;

  beforeEach(() => {
    currentTime = "2026-10-04T15:30:00.000Z";
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    applyPolicySchema(db);
    applyBudgetSchema(db);
    policies = new PolicyStore(db, { now: () => currentTime });
    budgets = new BudgetStore(db, { now: () => currentTime });
  });

  afterEach(() => db.close());

  function evaluation(maximum: number, window: "operation" | "scope_execution" | "day" | "all_time" = "scope_execution") {
    const policy = policies.createPolicy({
      workspace_id: "workspace-1",
      category: "budget",
      content: {
        label: "Runtime budget",
        description: "Bounds model use.",
        rules: [{
          rule_id: "tokens",
          priority: 1,
          match: { operation_ids: ["runtime.turn"] },
          effect: {
            kind: "limit",
            limits: [{
              metric: "tokens.total",
              maximum,
              window,
              ...(window === "day" ? { timezone: "Australia/Sydney" } : {}),
            }],
          },
        }],
      },
      created_by_principal_id: "operator-1",
    });
    const published = policies.publishRevision({
      workspace_id: "workspace-1",
      policy_revision_id: policy.draft.policy_revision_id,
      expected_current_revision_id: null,
    });
    policies.bindRevision({
      workspace_id: "workspace-1",
      policy_revision_id: published.revision.policy_revision_id,
      subject: { kind: "scope", id: "scope-1" },
      bound_by_principal_id: "operator-1",
    });
    return policies.evaluate(policyFacts());
  }

  it("reserves atomically so concurrent work cannot oversubscribe a limit", () => {
    const assessed = evaluation(100);
    const first = budgets.reserve({
      source: { kind: "execution_attempt", id: "attempt-1" },
      evaluation: assessed,
      facts: usageFacts(),
      estimates: { "tokens.total": 60 },
    });
    expect(first?.state).toBe("reserved");

    expect(() => budgets.reserve({
      source: { kind: "execution_attempt", id: "attempt-2" },
      evaluation: assessed,
      facts: usageFacts(),
      estimates: { "tokens.total": 50 },
    })).toThrow(BudgetExceededError);

    budgets.release({ workspace_id: "workspace-1", reservation_id: first!.reservation_id });
    expect(budgets.reserve({
      source: { kind: "execution_attempt", id: "attempt-2" },
      evaluation: assessed,
      facts: usageFacts(),
      estimates: { "tokens.total": 50 },
    })?.state).toBe("reserved");
  });

  it("commits exact resource use and preserves idempotent replay", () => {
    const assessed = evaluation(100);
    const reservation = budgets.reserve({
      source: { kind: "execution_attempt", id: "attempt-1" },
      evaluation: assessed,
      facts: usageFacts(),
      estimates: { "tokens.total": 80, "cost.micros": 25 },
    })!;
    const committed = budgets.commit({
      workspace_id: "workspace-1",
      reservation_id: reservation.reservation_id,
      actual_usage: { "tokens.total": 70, "cost.micros": 20 },
    });
    expect(committed.state).toBe("committed");
    expect(budgets.listUsage("workspace-1").map((entry) => [entry.metric, entry.amount]).sort()).toEqual([
      ["cost.micros", 20],
      ["tokens.total", 70],
    ]);
    expect(budgets.commit({
      workspace_id: "workspace-1",
      reservation_id: reservation.reservation_id,
      actual_usage: { "tokens.total": 70, "cost.micros": 20 },
    }).state).toBe("committed");
  });

  it("keeps uncertain effects charged until reconciliation proves no effect", () => {
    const assessed = evaluation(100);
    const reservation = budgets.reserve({
      source: { kind: "execution_attempt", id: "attempt-unknown" },
      evaluation: assessed,
      facts: usageFacts(),
      estimates: { "tokens.total": 90 },
    })!;
    budgets.markOutcomeUnknown({ workspace_id: "workspace-1", reservation_id: reservation.reservation_id });
    expect(() => budgets.reserve({
      source: { kind: "execution_attempt", id: "attempt-next" },
      evaluation: assessed,
      facts: usageFacts(),
      estimates: { "tokens.total": 20 },
    })).toThrow(BudgetExceededError);

    budgets.reconcileNoEffect({ workspace_id: "workspace-1", reservation_id: reservation.reservation_id });
    expect(budgets.reserve({
      source: { kind: "execution_attempt", id: "attempt-next" },
      evaluation: assessed,
      facts: usageFacts(),
      estimates: { "tokens.total": 20 },
    })).not.toBeNull();
  });

  it("uses the same calendar window across the daylight-saving transition", () => {
    const assessed = evaluation(100, "day");
    currentTime = "2026-10-04T01:00:00.000Z";
    const beforeTransition = budgets.reserve({
      source: { kind: "execution_attempt", id: "attempt-before-dst" },
      evaluation: assessed,
      facts: usageFacts(),
      estimates: { "tokens.total": 70 },
    })!;
    expect(beforeTransition.items[0]?.window_start).toBe("2026-10-03T14:00:00.000Z");
    expect(beforeTransition.items[0]?.window_end).toBe("2026-10-04T13:00:00.000Z");
    budgets.commit({
      workspace_id: "workspace-1",
      reservation_id: beforeTransition.reservation_id,
      actual_usage: { "tokens.total": 70 },
    });

    currentTime = "2026-10-04T12:00:00.000Z";
    expect(() => budgets.reserve({
      source: { kind: "execution_attempt", id: "attempt-same-local-day" },
      evaluation: assessed,
      facts: usageFacts(),
      estimates: { "tokens.total": 40 },
    })).toThrow(BudgetExceededError);

    currentTime = "2026-10-04T13:00:00.000Z";
    expect(budgets.reserve({
      source: { kind: "execution_attempt", id: "attempt-next-local-day" },
      evaluation: assessed,
      facts: usageFacts(),
      estimates: { "tokens.total": 40 },
    })).not.toBeNull();
  });

  it("marks an effect that exceeds its reservation without hiding actual use", () => {
    const assessed = evaluation(100, "operation");
    const reservation = budgets.reserve({
      source: { kind: "operation_invocation", id: "operation-1" },
      evaluation: assessed,
      facts: usageFacts(),
      estimates: { "tokens.total": 50 },
    })!;
    const completed = budgets.commit({
      workspace_id: "workspace-1",
      reservation_id: reservation.reservation_id,
      actual_usage: { "tokens.total": 120 },
    });
    expect(completed.state).toBe("exceeded");
    expect(budgets.listUsage("workspace-1", { metric: "tokens.total" })[0]?.amount).toBe(120);
  });
});
