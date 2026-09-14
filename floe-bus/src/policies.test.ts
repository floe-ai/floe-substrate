import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PolicyConflictError,
  PolicyStore,
  PolicyValidationError,
  applyPolicySchema,
  type PolicyContent,
  type PolicyEvaluationFacts,
} from "./policies.js";

const effects = {
  mode: "write" as const,
  reversibility: "irreversible" as const,
  external: true,
  secret_access: "brokered" as const,
};

function facts(overrides: Partial<PolicyEvaluationFacts> = {}): PolicyEvaluationFacts {
  return {
    authority_boundary: { kind: "workspace", workspace_id: "workspace-1" },
    workspace_id: "workspace-1",
    principal_id: "actor:publisher",
    principal_roles: ["publisher"],
    actor_role_evidence: [],
    interaction_mode: "unattended",
    provenance: {
      cause_event_id: null,
      delivery_ids: [],
      execution_attempt_id: null,
      node_execution_id: null,
      scope_execution_id: null,
    },
    operation_id: "connector.action.request",
    target: { kind: "connector_action", id: "publish-site", revision: "r1" },
    effects,
    scope_id: "scope-campaign",
    actor_id: "actor-publisher",
    scope_composition_revision_id: "scope-revision-1",
    node_placement_id: "publish-node",
    connector_binding_id: "binding-gallery",
    extension_installation_id: null,
    extension_package_version_id: "extension-gallery-v2",
    data_classes: ["public"],
    worker_trust_level: "managed",
    ...overrides,
  };
}

function content(rules: PolicyContent["rules"]): PolicyContent {
  return {
    label: "Publishing controls",
    description: "Controls irreversible publishing actions.",
    rules,
  };
}

describe("PolicyStore", () => {
  let db: DatabaseSync;
  let store: PolicyStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    applyPolicySchema(db);
    store = new PolicyStore(db, { now: () => "2026-09-04T00:00:00.000Z" });
  });

  afterEach(() => db.close());

  it("publishes immutable revisions and retains exact rollback targets", () => {
    const first = store.createPolicy({
      workspace_id: "workspace-1",
      policy_id: "publishing-policy",
      category: "approval",
      content: content([{
        rule_id: "approve-external",
        priority: 10,
        match: { external_effect: true },
        effect: {
          kind: "require_approval",
          reason: "A publisher must approve the external effect.",
          approvers: { mode: "any", principal_ids: [], roles: ["publisher"] },
        },
      }]),
      created_by_principal_id: "operator-1",
    });
    const publishedFirst = store.publishRevision({
      workspace_id: "workspace-1",
      policy_revision_id: first.draft.policy_revision_id,
      expected_current_revision_id: null,
    });

    expect(() => store.replaceDraft({
      workspace_id: "workspace-1",
      policy_revision_id: first.draft.policy_revision_id,
      expected_semantic_digest: first.draft.semantic_digest,
      content: content([]),
    })).toThrow(PolicyConflictError);

    const secondDraft = store.createDraft({
      workspace_id: "workspace-1",
      policy_id: first.policy.policy_id,
      based_on_revision_id: publishedFirst.revision.policy_revision_id,
      content: content([{
        rule_id: "stop-external",
        priority: 20,
        match: { external_effect: true },
        effect: { kind: "deny", reason: "Publishing is stopped." },
      }]),
      created_by_principal_id: "operator-1",
    });
    const publishedSecond = store.publishRevision({
      workspace_id: "workspace-1",
      policy_revision_id: secondDraft.policy_revision_id,
      expected_current_revision_id: publishedFirst.revision.policy_revision_id,
    });
    expect(publishedSecond.policy.current_revision_id).toBe(secondDraft.policy_revision_id);

    const rolledBack = store.rollback({
      workspace_id: "workspace-1",
      policy_id: first.policy.policy_id,
      target_revision_id: publishedFirst.revision.policy_revision_id,
      expected_current_revision_id: publishedSecond.revision.policy_revision_id,
    });
    expect(rolledBack.current_revision_id).toBe(publishedFirst.revision.policy_revision_id);
    expect(store.listRevisions(first.policy.policy_id)).toHaveLength(2);
  });

  it("evaluates only exact active bindings and applies deny before approval", () => {
    const policy = store.createPolicy({
      workspace_id: "workspace-1",
      policy_id: "combined-policy",
      category: "operation",
      content: content([
        {
          rule_id: "approval",
          priority: 10,
          match: { operation_ids: ["connector.action.request"], external_effect: true },
          effect: {
            kind: "require_approval",
            reason: "Approval is required.",
            approvers: { mode: "any", principal_ids: [], roles: ["publisher"] },
          },
        },
        {
          rule_id: "blocked-actor",
          priority: 100,
          match: { principal_ids: ["actor:publisher"] },
          effect: { kind: "deny", reason: "This Actor is stopped." },
        },
      ]),
      created_by_principal_id: "operator-1",
    });
    const published = store.publishRevision({
      workspace_id: "workspace-1",
      policy_revision_id: policy.draft.policy_revision_id,
      expected_current_revision_id: null,
    });

    const unbound = store.evaluate(facts());
    expect(unbound.decision).toBe("allow");
    expect(unbound.evaluated_policy_revision_ids).toEqual([]);

    const binding = store.bindRevision({
      workspace_id: "workspace-1",
      policy_revision_id: published.revision.policy_revision_id,
      subject: { kind: "workspace", id: "workspace-1" },
      bound_by_principal_id: "operator-1",
    });
    const denied = store.evaluate(facts());
    expect(denied.decision).toBe("deny");
    expect(denied.denial_reasons).toEqual(["This Actor is stopped."]);
    expect(denied.approval_requirements).toHaveLength(1);
    expect(denied.evaluated_policy_revision_ids).toEqual([published.revision.policy_revision_id]);
    expect(denied.facts).toEqual(facts());
    expect(store.getEvaluation(denied.evaluation_id)).toEqual(denied);

    store.revokeBinding({
      workspace_id: "workspace-1",
      policy_binding_id: binding.policy_binding_id,
      revoked_by_principal_id: "operator-1",
      reason: "Stop ended.",
    });
    expect(store.evaluate(facts()).decision).toBe("allow");
  });

  it("preserves older decisions without inventing missing facts", () => {
    db.exec("DROP TABLE policy_evaluations");
    db.exec(`
      CREATE TABLE policy_evaluations (
        evaluation_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        facts_digest TEXT NOT NULL,
        evaluated_policy_revision_ids_json TEXT NOT NULL,
        matched_rules_json TEXT NOT NULL,
        decision TEXT NOT NULL,
        denial_reasons_json TEXT NOT NULL,
        approval_requirements_json TEXT NOT NULL,
        budget_limits_json TEXT NOT NULL,
        evaluated_at TEXT NOT NULL
      )
    `);
    db.prepare(`
      INSERT INTO policy_evaluations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("old-evaluation", "workspace-1", "old-digest", "[]", "[]", "allow", "[]", "[]", "[]", "2026-09-03T00:00:00.000Z");

    applyPolicySchema(db);
    expect(store.getEvaluation("old-evaluation")?.facts).toBeNull();
  });

  it("retains broad and exact budget scopes while removing weaker duplicates", () => {
    for (const [id, subject, maximum] of [
      ["workspace-budget", { kind: "workspace", id: "workspace-1" }, 100_000],
      ["scope-budget", { kind: "scope", id: "scope-campaign" }, 20_000],
      ["other-scope-budget", { kind: "scope", id: "scope-other" }, 1],
    ] as const) {
      const policy = store.createPolicy({
        workspace_id: "workspace-1",
        policy_id: id,
        category: "budget",
        content: content([{
          rule_id: "token-limit",
          priority: 1,
          match: {},
          effect: {
            kind: "limit",
            limits: [{ metric: "tokens.total", maximum, window: "scope_execution" }],
          },
        }]),
        created_by_principal_id: "operator-1",
      });
      const published = store.publishRevision({
        workspace_id: "workspace-1",
        policy_revision_id: policy.draft.policy_revision_id,
        expected_current_revision_id: null,
      });
      store.bindRevision({
        workspace_id: "workspace-1",
        policy_revision_id: published.revision.policy_revision_id,
        subject,
        bound_by_principal_id: "operator-1",
      });
    }

    const limits = store.evaluate(facts()).budget_limits;
    expect(limits).toHaveLength(2);
    expect(limits.map((limit) => ({ subject: limit.subject, maximum: limit.maximum }))).toEqual([
      { subject: { kind: "scope", id: "scope-campaign" }, maximum: 20_000 },
      { subject: { kind: "workspace", id: "workspace-1" }, maximum: 100_000 },
    ]);
  });

  it("matches data, trust, target, and interaction facts without inventing missing facts", () => {
    const policy = store.createPolicy({
      workspace_id: "workspace-1",
      policy_id: "data-policy",
      category: "data",
      content: content([{
        rule_id: "deny-confidential-on-personal-runtime",
        priority: 10,
        match: {
          data_classes: ["confidential"],
          worker_trust_levels: ["personal"],
          target_kinds: ["connector_action"],
          interaction_modes: ["unattended"],
        },
        effect: { kind: "deny", reason: "Confidential data requires a managed runtime." },
      }]),
      created_by_principal_id: "operator-1",
    });
    const published = store.publishRevision({
      workspace_id: "workspace-1",
      policy_revision_id: policy.draft.policy_revision_id,
      expected_current_revision_id: null,
    });
    store.bindRevision({
      workspace_id: "workspace-1",
      policy_revision_id: published.revision.policy_revision_id,
      subject: { kind: "workspace", id: "workspace-1" },
      bound_by_principal_id: "operator-1",
    });

    expect(store.evaluate(facts({ data_classes: [], worker_trust_level: null })).decision).toBe("allow");
    expect(store.evaluate(facts({ data_classes: ["confidential"], worker_trust_level: "managed" })).decision).toBe("allow");
    expect(store.evaluate(facts({ data_classes: ["confidential"], worker_trust_level: "personal" })).decision).toBe("deny");
  });

  it("never treats a revision-local NodePlacement id as a global Policy subject", () => {
    const policy = store.createPolicy({
      workspace_id: "workspace-1",
      category: "operation",
      content: content([{
        rule_id: "stop-placement",
        priority: 1,
        match: {
          scope_composition_revision_ids: ["scope-revision-1"],
          node_placement_ids: ["publish-node"],
        },
        effect: { kind: "deny", reason: "This exact placement is stopped." },
      }]),
      created_by_principal_id: "operator-1",
    });
    const published = store.publishRevision({
      workspace_id: "workspace-1",
      policy_revision_id: policy.draft.policy_revision_id,
      expected_current_revision_id: null,
    });
    store.bindRevision({
      workspace_id: "workspace-1",
      policy_revision_id: published.revision.policy_revision_id,
      subject: {
        kind: "node_placement",
        id: "publish-node",
        composition_revision_id: "scope-revision-1",
      },
      bound_by_principal_id: "operator-1",
    });

    expect(store.evaluate(facts()).decision).toBe("deny");
    expect(store.evaluate(facts({ scope_composition_revision_id: "scope-revision-2" })).decision).toBe("allow");
    expect(() => store.evaluate(facts({ scope_composition_revision_id: null }))).toThrow(PolicyValidationError);
  });

  it("rejects ambiguous Policy rules and cross-Workspace bindings", () => {
    expect(() => store.createPolicy({
      workspace_id: "workspace-1",
      category: "operation",
      content: content([{
        rule_id: "empty-selector",
        priority: 1,
        match: { operation_ids: [] },
        effect: { kind: "deny", reason: "No." },
      }]),
      created_by_principal_id: "operator-1",
    })).toThrow(PolicyValidationError);

    const policy = store.createPolicy({
      workspace_id: "workspace-1",
      category: "operation",
      content: content([]),
      created_by_principal_id: "operator-1",
    });
    const published = store.publishRevision({
      workspace_id: "workspace-1",
      policy_revision_id: policy.draft.policy_revision_id,
      expected_current_revision_id: null,
    });
    expect(() => store.bindRevision({
      workspace_id: "workspace-1",
      policy_revision_id: published.revision.policy_revision_id,
      subject: { kind: "workspace", id: "workspace-2" },
      bound_by_principal_id: "operator-1",
    })).toThrow(PolicyValidationError);
    expect(() => store.bindRevision({
      workspace_id: "workspace-1",
      policy_revision_id: published.revision.policy_revision_id,
      subject: { kind: "node_placement", id: "publish-node" },
      bound_by_principal_id: "operator-1",
    })).toThrow(PolicyValidationError);
    expect(() => store.requireRevisionForWorkspace(published.revision.policy_revision_id, "workspace-2"))
      .toThrow();
  });
});
