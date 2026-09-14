import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditConflictError, AuditStore, applyAuditSchema, auditValueDigest } from "./audit.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe("AuditStore", () => {
  let db: DatabaseSync;
  let store: AuditStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    applyAuditSchema(db);
    store = new AuditStore(db, { now: () => "2026-09-04T01:00:00.000Z" });
  });

  afterEach(() => db.close());

  function begin(overrides: Record<string, unknown> = {}) {
    return store.begin({
      invocation_id: "opinv-1",
      workspace_id: "workspace-1",
      principal_id: "operator-1",
      authority_boundary: { kind: "workspace", workspace_id: "workspace-1" },
      capability_grant_ids: ["grant-2", "grant-1"],
      interaction_mode: "interactive",
      operation_id: "scope.composition.publish",
      operation_version: "1",
      target_before: { kind: "scope", id: "scope-1", revision: "revision-1" },
      expected_resource_revision: "revision-1",
      idempotency_key: "publish-design-1",
      input_schema_version: "1",
      input_digest: sha("input"),
      request_summary: { selected_revision_id: "revision-2" },
      reason: "Publish the reviewed design.",
      artefact_version_ids: ["artefact-version-2", "artefact-version-1"],
      provenance: {
        cause_event_id: "event-1",
        delivery_ids: ["delivery-1"],
        execution_attempt_id: "attempt-1",
        node_execution_id: "node-execution-1",
        scope_execution_id: "scope-execution-1",
      },
      policy_evaluation_id: "policy-evaluation-1",
      budget_reservation_id: "budget-reservation-1",
      ...overrides,
    } as Parameters<AuditStore["begin"]>[0]);
  }

  it("records an exact request and one immutable outcome", () => {
    const request = begin();
    expect(request.capability_grant_ids).toEqual(["grant-1", "grant-2"]);
    expect(request.artefact_version_ids).toEqual(["artefact-version-1", "artefact-version-2"]);

    const outcome = store.complete({
      audit_id: request.audit_id,
      state: "completed",
      result_schema_version: "1",
      result_digest: auditValueDigest({ revision: "revision-2" }),
      result_summary: { published_revision_id: "revision-2" },
      refusal: null,
      changed_refs: [{ kind: "scope", id: "scope-1", revision: "revision-2" }],
      target_after: { kind: "scope", id: "scope-1", revision: "revision-2" },
      prior_state_digest: sha("before"),
      resulting_state_digest: sha("after"),
      affected_artefact_version_ids: ["artefact-version-1"],
    });
    expect(store.require(request.audit_id)).toEqual({ request, outcome });
    expect(store.list({ workspace_id: "workspace-1", state: "completed" })).toHaveLength(1);
  });

  it("replays the same request and outcome but rejects contradictory evidence", () => {
    const request = begin();
    expect(begin().audit_id).toBe(request.audit_id);
    expect(() => begin({ reason: "A different request." })).toThrow(AuditConflictError);

    const input = {
      audit_id: request.audit_id,
      state: "refused" as const,
      result_schema_version: "1",
      result_digest: null,
      result_summary: {},
      refusal: {
        code: "policy_denied",
        message: "Publishing is stopped.",
        retryable: false,
        required_action: null,
        details: {},
      },
      changed_refs: [],
      target_after: request.target_before,
      prior_state_digest: sha("before"),
      resulting_state_digest: sha("before"),
      affected_artefact_version_ids: [],
    };
    expect(store.complete(input)).toEqual(store.complete(input));
    expect(() => store.complete({ ...input, state: "outcome_unknown", refusal: null })).toThrow(AuditConflictError);
  });

  it("keeps host authority separate from Workspace audit", () => {
    const host = begin({
      invocation_id: "host-op-1",
      workspace_id: null,
      authority_boundary: { kind: "host", host_id: "host-1" },
      operation_id: "credential.account.prepare",
      target_before: null,
      expected_resource_revision: null,
      policy_evaluation_id: null,
      budget_reservation_id: null,
      provenance: {
        cause_event_id: null,
        delivery_ids: [],
        execution_attempt_id: null,
        node_execution_id: null,
        scope_execution_id: null,
      },
    });
    expect(host.workspace_id).toBeNull();
    expect(store.list({ workspace_id: null })).toHaveLength(1);
    expect(store.list({ workspace_id: "workspace-1" })).toHaveLength(0);
  });
});
