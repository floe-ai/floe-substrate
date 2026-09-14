import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyActorDefinitionSchema } from "./actor-definitions.js";
import { ActorRoleAuthorityStore } from "./actor-role-authority.js";
import {
  ASSIGN_ACTOR_ROLE_OPERATION_ID,
  BIND_PRINCIPAL_TO_ACTOR_OPERATION_ID,
  INSPECT_ACTOR_AUTHORITY_OPERATION_ID,
  RESOLVE_OWN_ACTOR_ROLES_OPERATION_ID,
  REVOKE_ACTOR_ROLE_ASSIGNMENT_OPERATION_ID,
  REVOKE_PRINCIPAL_ACTOR_BINDING_OPERATION_ID,
  registerActorRoleOperations,
  resolveActorRoleAuthorityResource,
} from "./actor-role-operations.js";
import { AjvOperationSchemaValidator } from "./operation-schema-validator-ajv.js";
import { createTestOperationRegistry } from "./operation-test-fixtures.js";
import {
  type OperationAuthorityContext,
  type OperationInvocationEnvironment,
  type OperationInvocationRequest,
  type OperationInvocationResponse,
  type ResolvedOperationResource,
} from "./operations.js";
import { applyScopeSchema } from "./scopes/store.js";

const WORKSPACE = "workspace:one";
const ACTOR = "actor:reviewer";
const OPERATION_IDS = [
  INSPECT_ACTOR_AUTHORITY_OPERATION_ID,
  RESOLVE_OWN_ACTOR_ROLES_OPERATION_ID,
  BIND_PRINCIPAL_TO_ACTOR_OPERATION_ID,
  REVOKE_PRINCIPAL_ACTOR_BINDING_OPERATION_ID,
  ASSIGN_ACTOR_ROLE_OPERATION_ID,
  REVOKE_ACTOR_ROLE_ASSIGNMENT_OPERATION_ID,
] as const;

function authority(
  principalId = "principal:operator",
  grants: ReadonlySet<string> = new Set(OPERATION_IDS),
): OperationAuthorityContext & { boundary: { kind: "workspace"; workspace_id: string } } {
  return {
    principal_id: principalId,
    boundary: { kind: "workspace", workspace_id: WORKSPACE },
    grants,
    interaction: {
      mode: "interactive",
      session_id: "session:test",
      confirmed_prompts: new Set(),
      approval_refs: new Set(),
    },
  };
}

function request(
  operationId: string,
  input: unknown,
  key: string,
  options: Readonly<{
    target?: { kind: string; id: string };
    expected_revision?: string;
  }> = {},
): OperationInvocationRequest {
  return {
    operation_id: operationId,
    operation_version: "1",
    input_schema_version: "1",
    input,
    idempotency_key: key,
    ...(options.target ? { target: options.target } : {}),
    ...(options.expected_revision
      ? { expected_resource_revision: options.expected_revision }
      : {}),
  };
}

function receipt(response: OperationInvocationResponse) {
  expect(response.kind).toBe("receipt");
  if (response.kind !== "receipt") throw new Error("Expected operation receipt");
  return response.receipt;
}

describe("Actor role authority semantic operations", () => {
  let db: DatabaseSync;
  let store: ActorRoleAuthorityStore;
  let registry: ReturnType<typeof createTestOperationRegistry>;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    applyActorDefinitionSchema(db);
    applyScopeSchema(db);
    db.prepare(`
      INSERT INTO actors (
        actor_id, workspace_id, status, current_definition_revision_id,
        created_at, updated_at, retired_at
      ) VALUES (?, ?, 'active', NULL, '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z', NULL)
    `).run(ACTOR, WORKSPACE);
    store = new ActorRoleAuthorityStore(db, { now: () => "2026-09-04T01:00:00.000Z" });
    registry = registerActorRoleOperations(
      createTestOperationRegistry(new AjvOperationSchemaValidator()),
      store,
    );
  });

  afterEach(() => db.close());

  function environment(auth = authority()): OperationInvocationEnvironment {
    return {
      authority: auth,
      resolve_resource: async (target): Promise<ResolvedOperationResource | null> => {
        if (target.kind === "actor") {
          const actor = db.prepare(`
            SELECT * FROM actors WHERE workspace_id = ? AND actor_id = ?
          `).get(WORKSPACE, target.id);
          return actor ? { ref: { ...target, revision: null }, state: actor } : null;
        }
        return resolveActorRoleAuthorityResource(store, WORKSPACE, target);
      },
      now: () => "2026-09-04T02:00:00.000Z",
    };
  }

  it("discovers one management contract and requires each exact grant", async () => {
    const descriptors = await registry.project({ authority: authority() });
    expect(descriptors.map((item) => item.operation_id)).toEqual(OPERATION_IDS);
    expect(descriptors.every((item) =>
      item.required_grants.length === 1 && item.required_grants[0] === item.operation_id
    )).toBe(true);

    const denied = await registry.project({ authority: authority("principal:operator", new Set()) });
    expect(denied.every((item) =>
      !item.availability.available
      && item.availability.refusal.code === "operation_grant_required"
    )).toBe(true);
  });

  it("binds identity, assigns a role, resolves only the authenticated principal, and retains revocation", async () => {
    const bound = receipt(await registry.invoke(
      environment(),
      request(
        BIND_PRINCIPAL_TO_ACTOR_OPERATION_ID,
        { principal_id: "principal:reviewer", principal_actor_binding_id: "binding:reviewer" },
        "bind-reviewer",
        { target: { kind: "actor", id: ACTOR } },
      ),
    ));
    expect(bound.state).toBe("completed");

    const assigned = receipt(await registry.invoke(
      environment(),
      request(
        ASSIGN_ACTOR_ROLE_OPERATION_ID,
        {
          role: "approver",
          boundary: { kind: "workspace", workspace_id: WORKSPACE },
          actor_role_assignment_id: "assignment:approver",
        },
        "assign-approver",
        { target: { kind: "actor", id: ACTOR } },
      ),
    ));
    expect(assigned.state).toBe("completed");

    const resolved = receipt(await registry.invoke(
      environment(authority("principal:reviewer")),
      request(RESOLVE_OWN_ACTOR_ROLES_OPERATION_ID, {}, "resolve-reviewer"),
    ));
    expect(resolved.result).toMatchObject({
      principal_id: "principal:reviewer",
      actor_ids: [ACTOR],
      roles: ["approver"],
    });

    const claimed = receipt(await registry.invoke(
      environment(authority("principal:attacker")),
      request(
        RESOLVE_OWN_ACTOR_ROLES_OPERATION_ID,
        { principal_id: "principal:reviewer" },
        "claim-reviewer",
      ),
    ));
    expect(claimed).toMatchObject({
      state: "refused",
      refusal: { code: "operation_input_invalid" },
    });

    const assignment = (assigned.result as any).assignment;
    const revoked = receipt(await registry.invoke(
      environment(),
      request(
        REVOKE_ACTOR_ROLE_ASSIGNMENT_OPERATION_ID,
        { reason: "Responsibility changed" },
        "revoke-approver",
        {
          target: { kind: "actor_role_assignment", id: assignment.actor_role_assignment_id },
          expected_revision: `assigned:${assignment.assigned_at}`,
        },
      ),
    ));
    expect((revoked.result as any).assignment).toMatchObject({ status: "revoked" });
    expect(store.listRoleAssignments(WORKSPACE, {
      actor_id: ACTOR,
      include_revoked: true,
    })).toHaveLength(1);
  });

  it("keeps Context roles on the canonical Context participant operation", async () => {
    const attempted = receipt(await registry.invoke(
      environment(),
      request(
        ASSIGN_ACTOR_ROLE_OPERATION_ID,
        {
          role: "approver",
          boundary: { kind: "context", context_id: "context:claimed" },
        },
        "assign-context-role-outside-participation",
        { target: { kind: "actor", id: ACTOR } },
      ),
    ));
    expect(attempted).toMatchObject({
      state: "refused",
      refusal: { code: "operation_input_invalid" },
    });
    expect(store.listRoleAssignments(WORKSPACE, { actor_id: ACTOR })).toEqual([]);
  });

  it("inspects active or complete retained authority for one Actor", async () => {
    store.bindPrincipal({
      workspace_id: WORKSPACE,
      principal_id: "principal:reviewer",
      actor_id: ACTOR,
      bound_by_principal_id: "principal:operator",
      evidence_refs: [{ kind: "operation_invocation", id: "invocation:bind-reviewer", revision: null }],
      principal_actor_binding_id: "binding:reviewer",
    });
    store.assignRole({
      workspace_id: WORKSPACE,
      actor_id: ACTOR,
      role: "approver",
      boundary: { kind: "workspace", workspace_id: WORKSPACE },
      assigned_by_principal_id: "principal:operator",
      actor_role_assignment_id: "assignment:approver",
    });
    store.revokePrincipalBinding({
      workspace_id: WORKSPACE,
      principal_actor_binding_id: "binding:reviewer",
      revoked_by_principal_id: "principal:operator",
      reason: "Login rotated",
    });

    const active = receipt(await registry.invoke(
      environment(),
      request(
        INSPECT_ACTOR_AUTHORITY_OPERATION_ID,
        {},
        "inspect-active",
        { target: { kind: "actor", id: ACTOR } },
      ),
    ));
    expect((active.result as any).principal_bindings).toEqual([]);
    const history = receipt(await registry.invoke(
      environment(),
      request(
        INSPECT_ACTOR_AUTHORITY_OPERATION_ID,
        { include_history: true },
        "inspect-history",
        { target: { kind: "actor", id: ACTOR } },
      ),
    ));
    expect((history.result as any).principal_bindings).toHaveLength(1);
    expect((history.result as any).role_assignments).toHaveLength(1);
  });
});
