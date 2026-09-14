import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApprovalConflictError,
  ApprovalDeniedError,
  ApprovalStore,
  approvalActionDigest,
  applyApprovalSchema,
  type ApprovalAction,
  type ApprovalDecisionPolicySnapshot,
  type ApprovalRoleEvidence,
} from "./approvals.js";

const ACTION_INPUT_DIGEST = "1".repeat(64);
const CHANGED_INPUT_DIGEST = "2".repeat(64);

function action(overrides: Partial<ApprovalAction> = {}): ApprovalAction {
  return {
    operation_id: "connector.action.execute",
    authorized_principal_id: "actor:publisher",
    target: { kind: "external_target", id: "site:campaign", revision: "production" },
    input_digest: ACTION_INPUT_DIGEST,
    artefact_version_ids: ["artefact-version:report", "artefact-version:site"],
    composition_revision_id: "scope-revision:campaign-v4",
    node_placement_id: "placement:publish",
    scope_execution_id: "scope-execution:campaign-42",
    node_execution_id: "node-execution:publish-42",
    connector_binding_revision_id: "connector-binding-revision:publisher-v2",
    extension_package_version_id: null,
    approval_policy_ref: { kind: "policy", id: "policy:external-publish", revision: "v3" },
    capability_grant_ids: ["capability-grant:publish-production"],
    expected_effect: {
      summary: "Publish the reviewed campaign website to the production target.",
      external: true,
      reversibility: "reversible",
      resource_refs: [
        { kind: "artefact_version", id: "artefact-version:site" },
        { kind: "connector_binding_revision", id: "connector-binding-revision:publisher-v2" },
      ],
    },
    ...overrides,
  };
}

describe("ApprovalStore", () => {
  let db: DatabaseSync;
  let store: ApprovalStore;
  let now: string;
  let requestNumber: number;
  let receiptNumber: number;
  let decisionNumber: number;
  let actionCurrent: boolean;
  let authorities: Map<string, {
    authority_grant_ids: string[];
    role_evidence: ApprovalRoleEvidence[];
  }>;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE contexts (context_id TEXT PRIMARY KEY)");
    db.exec("INSERT INTO contexts (context_id) VALUES ('context:publish-approval')");
    db.exec("PRAGMA foreign_keys = ON");
    applyApprovalSchema(db);
    now = "2026-09-04T00:00:00.000Z";
    requestNumber = 0;
    receiptNumber = 0;
    decisionNumber = 0;
    actionCurrent = true;
    authorities = new Map();
    store = new ApprovalStore(db, {
      now: () => now,
      request_id_factory: () => `approval-request:${++requestNumber}`,
      receipt_id_factory: () => `approval-receipt:${++receiptNumber}`,
      decision_id_factory: () => `approval-decision:${++decisionNumber}`,
      resolve_decision_authority: ({ principal_id }) => authorities.get(principal_id)
        ?? { authority_grant_ids: [], role_evidence: [] },
      action_is_current: () => actionCurrent,
    });
  });

  afterEach(() => db.close());

  function requestApproval(overrides: Partial<Parameters<ApprovalStore["createRequest"]>[0]> = {}) {
    return store.createRequest({
      workspace_id: "workspace:campaign",
      action: action(),
      context_id: "context:publish-approval",
      requested_by_principal_id: "actor:coordinator",
      reason: "The exact reviewed site is ready for operator approval.",
      expires_at: "2026-09-04T01:00:00.000Z",
      maximum_uses: 1,
      idempotency_key: "approval-request:publish:site-v1",
      ...overrides,
    });
  }

  function decisionPolicy(
    approvers: ApprovalDecisionPolicySnapshot["approvers"],
  ): ApprovalDecisionPolicySnapshot {
    return {
      source: {
        kind: "policy_evaluation",
        policy_evaluation_id: "policy-evaluation:publish",
        policy_revision_id: "policy-revision:publish-3",
        rule_id: "approve-publish",
        facts_digest: "f".repeat(64),
      },
      approvers,
    };
  }

  function permit(
    principalId: string,
    roles: ApprovalRoleEvidence[] = [],
  ): void {
    authorities.set(principalId, {
      authority_grant_ids: [`grant:${principalId}`],
      role_evidence: roles,
    });
  }

  function approveRequest(overrides: Partial<Parameters<ApprovalStore["decideRequest"]>[0]> = {}) {
    const request = requestApproval();
    const decision = store.decideRequest({
      workspace_id: request.workspace_id,
      approval_request_id: request.approval_request_id,
      expected_state_revision: request.state_revision,
      decision: "approved",
      decided_by_principal_id: "principal:operator",
      decision_event_id: "event:approval-decision",
      decision_reason: "The exact site and test report are accepted for this target.",
      ...overrides,
    });
    expect(decision.receipt).not.toBeNull();
    return { request: decision.request, receipt: decision.receipt! };
  }

  it("binds a request and receipt to the exact approved action and human decision", () => {
    const { request, receipt } = approveRequest();

    expect(request).toMatchObject({
      status: "approved",
      state_revision: 2,
      decided_by_principal_id: "principal:operator",
      decision_event_id: "event:approval-decision",
    });
    expect(receipt).toMatchObject({
      approval_request_id: request.approval_request_id,
      workspace_id: "workspace:campaign",
      action_digest: approvalActionDigest(action()),
      context_id: "context:publish-approval",
      requested_by_principal_id: "actor:coordinator",
      approved_by_principal_id: "principal:operator",
      decision_event_id: "event:approval-decision",
      maximum_uses: 1,
      use_count: 0,
    });
    expect(receipt.action).toEqual(action());
    expect(store.verifyReceipt({
      approval_receipt_id: receipt.approval_receipt_id,
      workspace_id: "workspace:campaign",
      principal_id: "actor:publisher",
      action: action(),
    }).valid).toBe(true);
  });

  it("normalises unordered exact references before computing the action digest", () => {
    const reversed = action({
      artefact_version_ids: ["artefact-version:report", "artefact-version:site", "artefact-version:site"],
      expected_effect: {
        ...action().expected_effect,
        resource_refs: [...action().expected_effect.resource_refs].reverse(),
      },
    });

    expect(approvalActionDigest(reversed)).toBe(approvalActionDigest(action()));
  });

  it("makes request creation idempotent only for identical approval details", () => {
    const first = requestApproval();
    const replay = requestApproval();
    expect(replay.approval_request_id).toBe(first.approval_request_id);

    expect(() => requestApproval({ action: action({ input_digest: CHANGED_INPUT_DIGEST }) }))
      .toThrow(ApprovalConflictError);
    expect(() => requestApproval({ reason: "A different justification for the same key." }))
      .toThrow(ApprovalConflictError);
  });

  it("allows a standalone request without a Context but rejects execution-bound requests without one", () => {
    expect(() => requestApproval({ context_id: null }))
      .toThrowError(/requires its exact active Context/);

    const standalone = requestApproval({
      action: action({
        composition_revision_id: null,
        node_placement_id: null,
        scope_execution_id: null,
        node_execution_id: null,
      }),
      context_id: null,
      idempotency_key: "approval-request:standalone",
    });
    expect(standalone.context_id).toBeNull();
  });

  it.each([
    ["input", action({ input_digest: CHANGED_INPUT_DIGEST })],
    ["ArtefactVersion", action({ artefact_version_ids: ["artefact-version:site-v2", "artefact-version:report"] })],
    ["composition revision", action({ composition_revision_id: "scope-revision:campaign-v5" })],
    ["Node", action({ node_placement_id: "placement:publish-copy" })],
    ["ScopeExecution", action({ scope_execution_id: "scope-execution:campaign-43" })],
    ["NodeExecution", action({ node_execution_id: "node-execution:publish-43" })],
    ["ConnectorBinding revision", action({ connector_binding_revision_id: "connector-binding-revision:publisher-v3" })],
    ["ExtensionPackageVersion", action({ extension_package_version_id: "extension-package-version:publisher-v3" })],
    ["approval Policy", action({ approval_policy_ref: { kind: "policy", id: "policy:external-publish", revision: "v4" } })],
    ["CapabilityGrant", action({ capability_grant_ids: ["capability-grant:publish-staging"] })],
    ["external target", action({ target: { kind: "external_target", id: "site:other", revision: "production" } })],
    ["expected effect", action({ expected_effect: { ...action().expected_effect, reversibility: "irreversible" } })],
  ])("rejects a stale receipt when the approved %s changes", (_label, changedAction) => {
    const { receipt } = approveRequest();
    expect(() => store.verifyReceipt({
      approval_receipt_id: receipt.approval_receipt_id,
      workspace_id: "workspace:campaign",
      principal_id: "actor:publisher",
      action: changedAction,
    })).toThrowError(expect.objectContaining({ denial_code: "approval_action_changed" }));
  });

  it("rejects a receipt for another Workspace, principal, operation, expiry, or revocation", () => {
    const { receipt } = approveRequest();
    const verify = (overrides: Partial<Parameters<ApprovalStore["verifyReceipt"]>[0]> = {}) => store.verifyReceipt({
      approval_receipt_id: receipt.approval_receipt_id,
      workspace_id: "workspace:campaign",
      principal_id: "actor:publisher",
      action: action(),
      ...overrides,
    });

    expect(() => verify({ workspace_id: "workspace:other" }))
      .toThrowError(expect.objectContaining({ denial_code: "approval_workspace_mismatch" }));
    expect(() => verify({ principal_id: "actor:other" }))
      .toThrowError(expect.objectContaining({ denial_code: "approval_principal_mismatch" }));
    expect(() => verify({ action: action({ operation_id: "connector.action.delete" }) }))
      .toThrowError(expect.objectContaining({ denial_code: "approval_operation_mismatch" }));

    now = receipt.expires_at;
    expect(() => verify()).toThrowError(expect.objectContaining({ denial_code: "approval_expired" }));

    now = "2026-09-04T00:30:00.000Z";
    store.revokeReceipt({
      workspace_id: "workspace:campaign",
      approval_receipt_id: receipt.approval_receipt_id,
      revoked_by_principal_id: "principal:operator",
      reason: "Publishing authority was withdrawn before execution.",
    });
    expect(() => verify()).toThrowError(expect.objectContaining({ denial_code: "approval_revoked" }));
  });

  it("consumes bounded uses once and treats the same use identity as an idempotent replay", () => {
    const request = requestApproval({ maximum_uses: 2 });
    const { receipt } = store.decideRequest({
      workspace_id: request.workspace_id,
      approval_request_id: request.approval_request_id,
      expected_state_revision: request.state_revision,
      decision: "approved",
      decided_by_principal_id: "principal:operator",
      decision_event_id: "event:approval-decision",
      decision_reason: "Permit two exact publication attempts.",
    });
    expect(receipt).not.toBeNull();

    const consume = (useId: string) => store.consumeReceipt({
      approval_receipt_id: receipt!.approval_receipt_id,
      use_id: useId,
      workspace_id: "workspace:campaign",
      principal_id: "actor:publisher",
      action: action(),
    });
    expect(consume("external-effect:attempt-1").prior_use).toBeNull();
    expect(consume("external-effect:attempt-1").prior_use?.use_id).toBe("external-effect:attempt-1");
    expect(consume("external-effect:attempt-2").prior_use).toBeNull();
    expect(store.requireReceipt(receipt!.approval_receipt_id).use_count).toBe(2);
    expect(() => consume("external-effect:attempt-3"))
      .toThrowError(expect.objectContaining({ denial_code: "approval_uses_exhausted" }));
    expect(store.listUses(receipt!.approval_receipt_id, "workspace:campaign")).toHaveLength(2);
  });

  it("does not let an idempotent use identity disguise a changed action", () => {
    const { receipt } = approveRequest();
    store.consumeReceipt({
      approval_receipt_id: receipt.approval_receipt_id,
      use_id: "external-effect:attempt-1",
      workspace_id: "workspace:campaign",
      principal_id: "actor:publisher",
      action: action(),
    });

    expect(() => store.consumeReceipt({
      approval_receipt_id: receipt.approval_receipt_id,
      use_id: "external-effect:attempt-1",
      workspace_id: "workspace:campaign",
      principal_id: "actor:publisher",
      action: action({ input_digest: CHANGED_INPUT_DIGEST }),
    })).toThrow(ApprovalDeniedError);
  });

  it("keeps all-named approval pending until every named principal has approved", () => {
    permit("principal:one");
    permit("principal:two");
    const request = requestApproval({
      decision_policy: decisionPolicy({
        mode: "all_named",
        principal_ids: ["principal:one", "principal:two"],
      }),
    });

    const first = store.decideRequest({
      workspace_id: request.workspace_id,
      approval_request_id: request.approval_request_id,
      expected_state_revision: request.state_revision,
      decision: "approved",
      decided_by_principal_id: "principal:one",
      decision_event_id: "event:approval-one",
      decision_reason: "The first reviewer accepts the exact action.",
      idempotency_key: "vote:one",
    });
    expect(first.request).toMatchObject({
      status: "pending",
      decision: null,
      progress: {
        approvals_received: 1,
        approvals_required: 2,
        remaining_named_principal_ids: ["principal:two"],
        resolution: null,
      },
    });
    expect(first.receipt).toBeNull();

    // Both voters may act from the same inspected request. Individual votes
    // append; mutable request revision is not a concurrency gate.
    const second = store.decideRequest({
      workspace_id: request.workspace_id,
      approval_request_id: request.approval_request_id,
      expected_state_revision: request.state_revision,
      decision: "approved",
      decided_by_principal_id: "principal:two",
      decision_event_id: "event:approval-two",
      decision_reason: "The second reviewer accepts the exact action.",
      idempotency_key: "vote:two",
    });
    expect(second.request).toMatchObject({
      status: "approved",
      decision: "approved",
      progress: {
        approvals_received: 2,
        approvals_required: 2,
        remaining_named_principal_ids: [],
        resolution: "approved",
      },
    });
    expect(second.receipt?.decision_set_digest).toBe(second.request.decision_set_digest);
    expect(second.request.decisions).toHaveLength(2);
  });

  it("counts a canonically evidenced role toward an exact quorum and rejects an ineligible principal", () => {
    permit("principal:named");
    permit("principal:reviewer", [{ role: "release-reviewer", authority_ref: "role-assignment:reviewer-1@1" }]);
    permit("principal:other", [{ role: "observer", authority_ref: "role-assignment:observer-1@1" }]);
    const request = requestApproval({
      decision_policy: decisionPolicy({
        mode: "quorum",
        principal_ids: ["principal:named"],
        roles: ["release-reviewer"],
        quorum: 2,
      }),
    });
    expect(() => store.decideRequest({
      workspace_id: request.workspace_id,
      approval_request_id: request.approval_request_id,
      expected_state_revision: request.state_revision,
      decision: "approved",
      decided_by_principal_id: "principal:other",
      decision_event_id: "event:other",
      decision_reason: "An observer cannot approve this action.",
    })).toThrowError(expect.objectContaining({ denial_code: "approval_approver_ineligible" }));

    store.decideRequest({
      workspace_id: request.workspace_id,
      approval_request_id: request.approval_request_id,
      expected_state_revision: request.state_revision,
      decision: "approved",
      decided_by_principal_id: "principal:named",
      decision_event_id: "event:named",
      decision_reason: "The named approver accepts the action.",
    });
    const resolved = store.decideRequest({
      workspace_id: request.workspace_id,
      approval_request_id: request.approval_request_id,
      expected_state_revision: request.state_revision,
      decision: "approved",
      decided_by_principal_id: "principal:reviewer",
      decision_event_id: "event:reviewer",
      decision_reason: "The assigned release reviewer accepts the action.",
    });
    expect(resolved.request.status).toBe("approved");
    expect(resolved.individual_decision.role_evidence).toEqual([
      { role: "release-reviewer", authority_ref: "role-assignment:reviewer-1@1" },
    ]);
  });

  it.each(["rejected", "changes_requested"] as const)(
    "resolves collective approval immediately when an eligible principal records %s",
    (decision) => {
      permit("principal:one");
      permit("principal:two");
      const request = requestApproval({
        decision_policy: decisionPolicy({
          mode: "all_named",
          principal_ids: ["principal:one", "principal:two"],
        }),
      });
      const result = store.decideRequest({
        workspace_id: request.workspace_id,
        approval_request_id: request.approval_request_id,
        expected_state_revision: request.state_revision,
        decision,
        decided_by_principal_id: "principal:one",
        decision_event_id: `event:${decision}`,
        decision_reason: `The first reviewer selected ${decision}.`,
      });
      expect(result.request).toMatchObject({ status: "rejected", decision });
      expect(result.receipt).toBeNull();
    },
  );

  it("makes duplicate votes idempotent and requires explicit supersession for a changed vote", () => {
    permit("principal:one");
    permit("principal:two");
    permit("principal:three");
    const request = requestApproval({
      decision_policy: decisionPolicy({
        mode: "all_named",
        principal_ids: ["principal:one", "principal:two", "principal:three"],
      }),
    });
    const first = store.decideRequest({
      workspace_id: request.workspace_id,
      approval_request_id: request.approval_request_id,
      expected_state_revision: request.state_revision,
      decision: "approved",
      decided_by_principal_id: "principal:one",
      decision_event_id: "event:first",
      decision_reason: "The first reviewer initially accepts the action.",
      idempotency_key: "vote:first",
    });
    const replay = store.decideRequest({
      workspace_id: request.workspace_id,
      approval_request_id: request.approval_request_id,
      expected_state_revision: first.request.state_revision,
      decision: "approved",
      decided_by_principal_id: "principal:one",
      decision_event_id: "event:retry-is-not-retained",
      decision_reason: "The first reviewer initially accepts the action.",
      idempotency_key: "vote:first",
    });
    expect(replay.individual_decision.approval_decision_id)
      .toBe(first.individual_decision.approval_decision_id);
    expect(store.listDecisions(request.approval_request_id)).toHaveLength(1);

    expect(() => store.decideRequest({
      workspace_id: request.workspace_id,
      approval_request_id: request.approval_request_id,
      expected_state_revision: first.request.state_revision,
      decision: "changes_requested",
      decided_by_principal_id: "principal:one",
      decision_event_id: "event:changed-without-supersession",
      decision_reason: "The first reviewer found a required correction.",
    })).toThrow(/must explicitly supersede/);

    const changed = store.decideRequest({
      workspace_id: request.workspace_id,
      approval_request_id: request.approval_request_id,
      expected_state_revision: first.request.state_revision,
      decision: "changes_requested",
      decided_by_principal_id: "principal:one",
      decision_event_id: "event:changed",
      decision_reason: "The first reviewer found a required correction.",
      supersedes_decision_id: first.individual_decision.approval_decision_id,
    });
    expect(changed.request).toMatchObject({ status: "rejected", decision: "changes_requested" });
    expect(changed.request.decisions).toHaveLength(2);
    expect(changed.individual_decision.supersedes_decision_id)
      .toBe(first.individual_decision.approval_decision_id);
  });

  it("invalidates pending and approved authority when exact evidence or approver authority changes", () => {
    permit("principal:one");
    permit("principal:two");
    const pending = requestApproval({
      decision_policy: decisionPolicy({
        mode: "all_named",
        principal_ids: ["principal:one", "principal:two"],
      }),
    });
    store.decideRequest({
      workspace_id: pending.workspace_id,
      approval_request_id: pending.approval_request_id,
      expected_state_revision: pending.state_revision,
      decision: "approved",
      decided_by_principal_id: "principal:one",
      decision_event_id: "event:pending-one",
      decision_reason: "The first reviewer accepts the action.",
    });
    authorities.delete("principal:one");
    const invalidated = store.refreshRequestValidity({
      workspace_id: pending.workspace_id,
      approval_request_id: pending.approval_request_id,
      invalidated_by_principal_id: "system:approval-validity",
    });
    expect(invalidated).toMatchObject({ invalidated: true, request: { status: "invalidated" } });

    permit("principal:two");
    const approved = requestApproval({
      idempotency_key: "approval-request:authority-revocation",
      decision_policy: decisionPolicy({ mode: "any", principal_ids: ["principal:two"], roles: [] }),
    });
    const result = store.decideRequest({
      workspace_id: approved.workspace_id,
      approval_request_id: approved.approval_request_id,
      expected_state_revision: approved.state_revision,
      decision: "approved",
      decided_by_principal_id: "principal:two",
      decision_event_id: "event:approved-two",
      decision_reason: "The authorised reviewer accepts the action.",
    });
    authorities.delete("principal:two");
    expect(() => store.verifyReceipt({
      approval_receipt_id: result.receipt!.approval_receipt_id,
      workspace_id: approved.workspace_id,
      principal_id: action().authorized_principal_id,
      action: action(),
    })).toThrowError(expect.objectContaining({ denial_code: "approval_approver_authority_changed" }));
    expect(store.requireReceipt(result.receipt!.approval_receipt_id).revoked_by_principal_id)
      .toBe("system:approval-validity");

    permit("principal:three");
    const staleAction = requestApproval({
      idempotency_key: "approval-request:stale-action",
      decision_policy: decisionPolicy({ mode: "any", principal_ids: ["principal:three"], roles: [] }),
    });
    actionCurrent = false;
    expect(store.refreshRequestValidity({
      workspace_id: staleAction.workspace_id,
      approval_request_id: staleAction.approval_request_id,
      invalidated_by_principal_id: "system:approval-validity",
    }).request.status).toBe("invalidated");
  });

  it("uses compare-and-swap decisions and keeps pending attention explicit", () => {
    const first = requestApproval();
    const second = requestApproval({
      idempotency_key: "approval-request:publish:site-v2",
      action: action({ input_digest: CHANGED_INPUT_DIGEST }),
    });
    expect(store.listAttention("workspace:campaign").map((item) => item.approval_request_id))
      .toEqual([first.approval_request_id, second.approval_request_id]);

    store.cancelRequest({
      workspace_id: first.workspace_id,
      approval_request_id: first.approval_request_id,
      expected_state_revision: first.state_revision,
      cancelled_by_principal_id: "principal:operator",
      reason: "The operator chose not to publish this version.",
    });
    expect(() => store.decideRequest({
      workspace_id: first.workspace_id,
      approval_request_id: first.approval_request_id,
      expected_state_revision: first.state_revision,
      decision: "approved",
      decided_by_principal_id: "principal:operator",
      decision_event_id: "event:late-decision",
      decision_reason: "This stale decision must not be accepted.",
    })).toThrow(ApprovalConflictError);
    expect(store.listAttention("workspace:campaign").map((item) => item.approval_request_id))
      .toEqual([second.approval_request_id]);
  });

  it("preserves retained approvals while adding decision bindings and changes-requested outcomes", () => {
    db.close();
    db = new DatabaseSync(":memory:");
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE contexts (context_id TEXT PRIMARY KEY);
      INSERT INTO contexts (context_id) VALUES ('context:publish-approval');
      CREATE TABLE approval_requests (
        approval_request_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        action_json TEXT NOT NULL,
        action_digest TEXT NOT NULL,
        context_id TEXT NOT NULL REFERENCES contexts(context_id),
        requested_by_principal_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        maximum_uses INTEGER NOT NULL CHECK (maximum_uses > 0),
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'invalidated')),
        state_revision INTEGER NOT NULL DEFAULT 1 CHECK (state_revision > 0),
        decided_by_principal_id TEXT,
        decision_event_id TEXT,
        decision_reason TEXT,
        decided_at TEXT,
        UNIQUE(workspace_id, requested_by_principal_id, idempotency_key)
      );
      CREATE TABLE approval_receipts (
        approval_receipt_id TEXT PRIMARY KEY,
        approval_request_id TEXT NOT NULL UNIQUE REFERENCES approval_requests(approval_request_id),
        workspace_id TEXT NOT NULL,
        action_json TEXT NOT NULL,
        action_digest TEXT NOT NULL,
        context_id TEXT NOT NULL REFERENCES contexts(context_id),
        requested_by_principal_id TEXT NOT NULL,
        approved_by_principal_id TEXT NOT NULL,
        decision_event_id TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        maximum_uses INTEGER NOT NULL CHECK (maximum_uses > 0)
      );
      CREATE TABLE retained_approval_receipt_links (
        link_id TEXT PRIMARY KEY,
        approval_receipt_id TEXT NOT NULL REFERENCES approval_receipts(approval_receipt_id)
      );
    `);
    const retainedAction = action();
    const retainedDigest = approvalActionDigest(retainedAction);
    db.prepare(`
      INSERT INTO approval_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "approval-request:retained", "workspace:campaign", JSON.stringify(retainedAction), retainedDigest,
      "context:publish-approval", "actor:coordinator", "Retained operator decision.",
      "2026-09-03T23:00:00.000Z", "2026-09-04T01:00:00.000Z", 1,
      "approval-request:retained", "approved", 2, "principal:operator",
      "event:retained-decision", "Accepted before the schema upgrade.", "2026-09-03T23:30:00.000Z",
    );
    db.prepare(`
      INSERT INTO approval_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "approval-receipt:retained", "approval-request:retained", "workspace:campaign",
      JSON.stringify(retainedAction), retainedDigest, "context:publish-approval", "actor:coordinator",
      "principal:operator", "event:retained-decision", "2026-09-03T23:30:00.000Z",
      "2026-09-04T01:00:00.000Z", 1,
    );
    db.prepare("INSERT INTO retained_approval_receipt_links VALUES (?, ?)").run(
      "retained-link:1",
      "approval-receipt:retained",
    );

    db.exec("BEGIN IMMEDIATE");
    try {
      applyApprovalSchema(db);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    store = new ApprovalStore(db, {
      now: () => "2026-09-04T00:00:00.000Z",
      request_id_factory: () => "approval-request:changes",
      receipt_id_factory: () => "approval-receipt:unexpected",
    });
    const retainedRequest = store.requireRequest("approval-request:retained");
    const retainedReceipt = store.requireReceipt("approval-receipt:retained");
    expect(retainedRequest).toMatchObject({
      decision_binding: null,
      decision_policy: {
        source: { kind: "legacy_any_one" },
        approvers: { mode: "any", principal_ids: ["principal:operator"], roles: [] },
      },
      progress: { approvals_received: 1, approvals_required: 1, resolution: "approved" },
    });
    expect(retainedRequest.decisions).toEqual([
      expect.objectContaining({
        principal_id: "principal:operator",
        decision: "approved",
        decision_event_id: "event:retained-decision",
        role_evidence: [{ role: "legacy:retained", authority_ref: "schema-migration" }],
        resolution_after: "approved",
      }),
    ]);
    expect(retainedReceipt).toMatchObject({
      decision_event_id: "event:retained-decision",
      decision_set_digest: retainedRequest.decision_set_digest,
    });
    expect(db.prepare("SELECT * FROM retained_approval_receipt_links").all()).toEqual([
      expect.objectContaining({ approval_receipt_id: "approval-receipt:retained" }),
    ]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    const request = requestApproval({ idempotency_key: "approval-request:changes" });
    const decision = store.decideRequest({
      workspace_id: request.workspace_id,
      approval_request_id: request.approval_request_id,
      expected_state_revision: request.state_revision,
      decision: "changes_requested",
      decided_by_principal_id: "principal:operator",
      decision_event_id: "event:changes-requested",
      decision_reason: "Revise the candidate and return it through the planned route.",
    });
    expect(decision.request).toMatchObject({ status: "rejected", decision: "changes_requested" });
    expect(decision.receipt).toBeNull();

    const upgradedStore = new ApprovalStore(db, {
      now: () => "2026-09-04T00:00:00.000Z",
      request_id_factory: () => "approval-request:standalone-after-upgrade",
      receipt_id_factory: () => "approval-receipt:standalone-after-upgrade",
    });
    const standalone = upgradedStore.createRequest({
      workspace_id: "workspace:campaign",
      action: action({
        composition_revision_id: null,
        node_placement_id: null,
        scope_execution_id: null,
        node_execution_id: null,
      }),
      context_id: null,
      requested_by_principal_id: "actor:coordinator",
      reason: "Standalone operator attention after the retained schema upgrade.",
      expires_at: "2026-09-04T01:00:00.000Z",
      maximum_uses: 1,
      idempotency_key: "approval-request:standalone-after-upgrade",
    });
    const approvedStandalone = upgradedStore.decideRequest({
      workspace_id: standalone.workspace_id,
      approval_request_id: standalone.approval_request_id,
      expected_state_revision: standalone.state_revision,
      decision: "approved",
      decided_by_principal_id: "principal:operator",
      decision_event_id: "event:standalone-after-upgrade",
      decision_reason: "Approved as a standalone attention item.",
    });
    expect(standalone.context_id).toBeNull();
    expect(approvedStandalone.receipt?.context_id).toBeNull();
    expect((db.prepare("PRAGMA table_info(approval_requests)").all() as Array<{ name: string; notnull: number }>)
      .find((column) => column.name === "context_id")?.notnull).toBe(0);
    expect((db.prepare("PRAGMA table_info(approval_receipts)").all() as Array<{ name: string; notnull: number }>)
      .find((column) => column.name === "context_id")?.notnull).toBe(0);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
