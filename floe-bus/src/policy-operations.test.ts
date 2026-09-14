import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AjvOperationSchemaValidator } from "./operation-schema-validator-ajv.js";
import { createTestOperationRegistry } from "./operation-test-fixtures.js";
import {
  type OperationAuthorityContext,
  type OperationInvocationEnvironment,
  type OperationInvocationRequest,
  type OperationInvocationResponse,
} from "./operations.js";
import {
  BIND_POLICY_OPERATION_ID,
  CREATE_POLICY_DRAFT_OPERATION_ID,
  CREATE_POLICY_OPERATION_ID,
  INSPECT_POLICY_EVALUATION_OPERATION_ID,
  INSPECT_POLICY_OPERATION_ID,
  LIST_POLICIES_OPERATION_ID,
  LIST_POLICY_EVALUATIONS_OPERATION_ID,
  PUBLISH_POLICY_OPERATION_ID,
  REACTIVATE_POLICY_OPERATION_ID,
  REPLACE_POLICY_DRAFT_OPERATION_ID,
  RETIRE_POLICY_OPERATION_ID,
  REVOKE_POLICY_BINDING_OPERATION_ID,
  ROLLBACK_POLICY_OPERATION_ID,
  policyOperationDefinitions,
  registerPolicyOperations,
  resolvePolicyOperationResource,
} from "./policy-operations.js";
import {
  PolicyStore,
  applyPolicySchema,
  type PolicyContent,
} from "./policies.js";

const OPERATION_IDS = [
  LIST_POLICIES_OPERATION_ID,
  INSPECT_POLICY_OPERATION_ID,
  CREATE_POLICY_OPERATION_ID,
  CREATE_POLICY_DRAFT_OPERATION_ID,
  REPLACE_POLICY_DRAFT_OPERATION_ID,
  PUBLISH_POLICY_OPERATION_ID,
  ROLLBACK_POLICY_OPERATION_ID,
  BIND_POLICY_OPERATION_ID,
  REVOKE_POLICY_BINDING_OPERATION_ID,
  RETIRE_POLICY_OPERATION_ID,
  REACTIVATE_POLICY_OPERATION_ID,
  LIST_POLICY_EVALUATIONS_OPERATION_ID,
  INSPECT_POLICY_EVALUATION_OPERATION_ID,
] as const;

function policy(label: string, reason: string): PolicyContent {
  return {
    label,
    description: "Retained operation controls.",
    rules: [{
      rule_id: "protect-external-effect",
      priority: 10,
      match: { external_effect: true },
      effect: { kind: "deny", reason },
    }],
  };
}

function authority(
  grants: ReadonlySet<string> = new Set(OPERATION_IDS),
): OperationAuthorityContext & { boundary: { kind: "workspace"; workspace_id: string } } {
  return {
    principal_id: "principal:operator",
    boundary: { kind: "workspace", workspace_id: "workspace:one" },
    grants,
    interaction: {
      mode: "interactive",
      session_id: "session:test",
      confirmed_prompts: new Set(),
      approval_refs: new Set(),
    },
  };
}

function environment(store: PolicyStore, auth = authority()): OperationInvocationEnvironment {
  return {
    authority: auth,
    resolve_resource: async (target) => resolvePolicyOperationResource(store, auth.boundary, target),
    now: () => "2026-09-04T09:00:00.000Z",
  };
}

function request(
  operationId: string,
  input: unknown,
  idempotencyKey: string,
  target?: Readonly<{ kind: string; id: string; expected_revision?: string }>,
): OperationInvocationRequest {
  return {
    operation_id: operationId,
    operation_version: "1",
    input_schema_version: "1",
    input,
    idempotency_key: idempotencyKey,
    ...(target
      ? {
          target: { kind: target.kind, id: target.id },
          ...(target.expected_revision !== undefined
            ? { expected_resource_revision: target.expected_revision }
            : {}),
        }
      : {}),
  };
}

function receipt(response: OperationInvocationResponse) {
  expect(response.kind).toBe("receipt");
  if (response.kind !== "receipt") throw new Error("Expected an operation receipt.");
  return response.receipt;
}

describe("Policy semantic operations", () => {
  let db: DatabaseSync;
  let store: PolicyStore;
  let registry: ReturnType<typeof createTestOperationRegistry>;
  let tick: number;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    applyPolicySchema(db);
    tick = 0;
    store = new PolicyStore(db, {
      now: () => `2026-09-04T08:00:${String(tick++).padStart(2, "0")}.000Z`,
    });
    registry = registerPolicyOperations(
      createTestOperationRegistry(new AjvOperationSchemaValidator()),
      store,
    );
  });

  afterEach(() => db.close());

  it("exposes the same exact Policy contract to every authorized client", async () => {
    const projected = await registry.project({ authority: authority() });
    expect(projected.map((item) => item.operation_id)).toEqual(OPERATION_IDS);
    expect(projected.every((item) =>
      item.required_grants.length === 1
      && item.required_grants[0] === item.operation_id
    )).toBe(true);
    expect(policyOperationDefinitions(store)).toHaveLength(OPERATION_IDS.length);

    const unavailable = await registry.project({ authority: authority(new Set()) });
    expect(unavailable.every((item) =>
      !item.availability.available
      && item.availability.refusal.code === "operation_grant_required"
    )).toBe(true);
  });

  it("manages draft, published, bound, rolled-back, and retired Policy state without another API", async () => {
    const created = receipt(await registry.invoke(
      environment(store),
      request(CREATE_POLICY_OPERATION_ID, {
        policy_id: "policy:external-effects",
        category: "operation",
        content: policy("External effects v1", "External effects are stopped."),
      }, "create-policy"),
    ));
    expect(created.state).toBe("completed");
    const first = created.result as any;

    const publishedFirst = receipt(await registry.invoke(
      environment(store),
      request(PUBLISH_POLICY_OPERATION_ID, { expected_current_revision_id: null }, "publish-v1", {
        kind: "policy_revision",
        id: first.draft.policy_revision_id,
        expected_revision: first.draft.semantic_digest,
      }),
    ));
    expect(publishedFirst.state).toBe("completed");
    const firstRevision = (publishedFirst.result as any).revision;

    const bound = receipt(await registry.invoke(
      environment(store),
      request(BIND_POLICY_OPERATION_ID, {
        subject: { kind: "workspace", id: "workspace:one" },
      }, "bind-v1", {
        kind: "policy_revision",
        id: firstRevision.policy_revision_id,
        expected_revision: firstRevision.semantic_digest,
      }),
    ));
    expect(bound.state).toBe("completed");

    const inspected = receipt(await registry.invoke(
      environment(store),
      request(INSPECT_POLICY_OPERATION_ID, {}, "inspect-policy", {
        kind: "policy",
        id: "policy:external-effects",
      }),
    ));
    expect((inspected.result as any).bindings).toHaveLength(1);

    const current = store.requirePolicy("policy:external-effects");
    const draft = receipt(await registry.invoke(
      environment(store),
      request(CREATE_POLICY_DRAFT_OPERATION_ID, {
        based_on_revision_id: firstRevision.policy_revision_id,
        content: policy("External effects draft", "Await a decision."),
      }, "create-v2", {
        kind: "policy",
        id: current.policy_id,
        expected_revision: current.updated_at,
      }),
    ));
    expect(draft.state).toBe("completed");
    const draftRevision = draft.result as any;

    const replaced = receipt(await registry.invoke(
      environment(store),
      request(REPLACE_POLICY_DRAFT_OPERATION_ID, {
        content: policy("External effects v2", "A current decision is required."),
      }, "replace-v2", {
        kind: "policy_revision",
        id: draftRevision.policy_revision_id,
        expected_revision: draftRevision.semantic_digest,
      }),
    ));
    expect(replaced.state).toBe("completed");

    const publishedSecond = receipt(await registry.invoke(
      environment(store),
      request(PUBLISH_POLICY_OPERATION_ID, {
        expected_current_revision_id: firstRevision.policy_revision_id,
      }, "publish-v2", {
        kind: "policy_revision",
        id: (replaced.result as any).policy_revision_id,
        expected_revision: (replaced.result as any).semantic_digest,
      }),
    ));
    expect(publishedSecond.state).toBe("completed");

    const beforeRollback = store.requirePolicy("policy:external-effects");
    const rolledBack = receipt(await registry.invoke(
      environment(store),
      request(ROLLBACK_POLICY_OPERATION_ID, {
        target_revision_id: firstRevision.policy_revision_id,
      }, "rollback", {
        kind: "policy",
        id: beforeRollback.policy_id,
        expected_revision: beforeRollback.updated_at,
      }),
    ));
    expect((rolledBack.result as any).current_revision_id).toBe(firstRevision.policy_revision_id);

    const binding = bound.result as any;
    const revoked = receipt(await registry.invoke(
      environment(store),
      request(REVOKE_POLICY_BINDING_OPERATION_ID, { reason: "Policy replacement." }, "revoke", {
        kind: "policy_binding",
        id: binding.policy_binding_id,
        expected_revision: binding.bound_at,
      }),
    ));
    expect((revoked.result as any).status).toBe("revoked");

    const beforeRetire = store.requirePolicy("policy:external-effects");
    const retired = receipt(await registry.invoke(
      environment(store),
      request(RETIRE_POLICY_OPERATION_ID, {}, "retire", {
        kind: "policy",
        id: beforeRetire.policy_id,
        expected_revision: beforeRetire.updated_at,
      }),
    ));
    expect((retired.result as any).status).toBe("retired");

    const beforeReactivate = store.requirePolicy("policy:external-effects");
    const reactivated = receipt(await registry.invoke(
      environment(store),
      request(REACTIVATE_POLICY_OPERATION_ID, {}, "reactivate", {
        kind: "policy",
        id: beforeReactivate.policy_id,
        expected_revision: beforeReactivate.updated_at,
      }),
    ));
    expect((reactivated.result as any).status).toBe("active");
  });
});
