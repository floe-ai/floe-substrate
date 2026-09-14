import {
  ActorRoleAuthorityConflictError,
  ActorRoleAuthorityNotFoundError,
  ActorRoleAuthorityStore,
  ActorRoleAuthorityValidationError,
  type ActorRoleAssignmentRecord,
  type ActorRoleAuthorityEvidence,
  type ActorRoleBoundary,
  type ActorRoleResolution,
  type ActorRoleResolutionTarget,
  type PrincipalActorBindingRecord,
} from "./actor-role-authority.js";
import {
  refusal,
  requireWorkspaceAuthorityId,
  requiredAction,
  type JsonSchema,
  type OperationEvaluationContext,
  type OperationExecutionContext,
  type OperationRefusal,
  type OperationResourceIdentity,
  type ResolvedOperationResource,
  type SemanticOperationDefinition,
  type SemanticOperationRegistry,
} from "./operations.js";

export const INSPECT_ACTOR_AUTHORITY_OPERATION_ID = "actor.authority.inspect";
export const RESOLVE_OWN_ACTOR_ROLES_OPERATION_ID = "actor.roles.resolve_current";
export const BIND_PRINCIPAL_TO_ACTOR_OPERATION_ID = "actor.principal.bind";
export const REVOKE_PRINCIPAL_ACTOR_BINDING_OPERATION_ID = "actor.principal.binding.revoke";
export const ASSIGN_ACTOR_ROLE_OPERATION_ID = "actor.role.assign";
export const REVOKE_ACTOR_ROLE_ASSIGNMENT_OPERATION_ID = "actor.role.assignment.revoke";

export type ActorAuthorityInspection = Readonly<{
  actor_id: string;
  principal_bindings: readonly PrincipalActorBindingRecord[];
  role_assignments: readonly ActorRoleAssignmentRecord[];
}>;

const text: JsonSchema = { type: "string", minLength: 1 };
const nullableText: JsonSchema = { oneOf: [text, { type: "null" }] };
const emptyInput: JsonSchema = { type: "object", additionalProperties: false };
const principalBindingSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "principal_actor_binding_id", "workspace_id", "principal_id", "actor_id", "status",
    "bound_by_principal_id", "bound_at", "evidence_refs", "revoked_by_principal_id", "revoked_at", "revocation_reason",
  ],
  properties: {
    principal_actor_binding_id: text,
    workspace_id: text,
    principal_id: text,
    actor_id: text,
    status: { enum: ["active", "revoked"] },
    bound_by_principal_id: text,
    bound_at: text,
    evidence_refs: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "id", "revision"],
        properties: { kind: text, id: text, revision: nullableText },
      },
    },
    revoked_by_principal_id: nullableText,
    revoked_at: nullableText,
    revocation_reason: nullableText,
  },
};
const roleBoundarySchema: JsonSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "workspace_id"],
      properties: { kind: { const: "workspace" }, workspace_id: text },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "scope_id"],
      properties: { kind: { const: "scope" }, scope_id: text },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "context_id"],
      properties: { kind: { const: "context" }, context_id: text },
    },
  ],
};
const managedRoleBoundarySchema: JsonSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "workspace_id"],
      properties: { kind: { const: "workspace" }, workspace_id: text },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "scope_id"],
      properties: { kind: { const: "scope" }, scope_id: text },
    },
  ],
};
const roleAssignmentSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "actor_role_assignment_id", "workspace_id", "actor_id", "role", "boundary", "status",
    "assigned_by_principal_id", "assigned_at", "revoked_by_principal_id", "revoked_at", "revocation_reason",
  ],
  properties: {
    actor_role_assignment_id: text,
    workspace_id: text,
    actor_id: text,
    role: text,
    boundary: roleBoundarySchema,
    status: { enum: ["active", "revoked"] },
    assigned_by_principal_id: text,
    assigned_at: text,
    revoked_by_principal_id: nullableText,
    revoked_at: nullableText,
    revocation_reason: nullableText,
  },
};
const evidenceSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actor_id", "role", "principal_binding_ref", "role_source_ref", "source_boundary"],
  properties: {
    actor_id: text,
    role: text,
    principal_binding_ref: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "id", "revision"],
      properties: { kind: { const: "principal_actor_binding" }, id: text, revision: text },
    },
    role_source_ref: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "id", "revision"],
      properties: {
        kind: { enum: ["actor_role_assignment", "scope_composition_revision"] },
        id: text,
        revision: text,
      },
    },
    source_boundary: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "id", "scope_composition_revision_id", "node_placement_id"],
      properties: {
        kind: { enum: ["workspace", "scope", "context", "node_placement", "node_execution"] },
        id: text,
        scope_composition_revision_id: nullableText,
        node_placement_id: nullableText,
      },
    },
  },
};
const resolutionTargetProperties: Record<string, JsonSchema> = {
  scope_id: nullableText,
  scope_composition_revision_id: nullableText,
  node_placement_id: nullableText,
  node_execution_id: nullableText,
  context_id: nullableText,
};
const resolutionTargetSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: Object.keys(resolutionTargetProperties),
  properties: resolutionTargetProperties,
};
const resolutionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "workspace_id", "principal_id", "actor_ids", "roles", "evidence",
    "resolved_target", "evidence_digest", "resolved_at",
  ],
  properties: {
    workspace_id: text,
    principal_id: text,
    actor_ids: { type: "array", items: text, uniqueItems: true },
    roles: { type: "array", items: text, uniqueItems: true },
    evidence: { type: "array", items: evidenceSchema },
    resolved_target: resolutionTargetSchema,
    evidence_digest: text,
    resolved_at: text,
  },
};

function workspaceId(context: OperationEvaluationContext): string {
  return requireWorkspaceAuthorityId(context.authority);
}

function auditRef(context: OperationExecutionContext) {
  return { kind: "operation_invocation", id: context.invocation_id, revision: null } as const;
}

function actorAvailability(store: ActorRoleAuthorityStore, context: OperationEvaluationContext) {
  const actorId = context.target?.ref.id;
  const actor = actorId ? store.db.prepare(`
    SELECT actor_id FROM actors WHERE workspace_id = ? AND actor_id = ?
  `).get(workspaceId(context), actorId) : undefined;
  return actor
    ? { available: true as const }
    : {
        available: false as const,
        refusal: refusal("actor_not_found", "The selected Actor is not available in this Workspace.", false, null),
      };
}

function roleAuthorityAvailability(
  store: ActorRoleAuthorityStore,
  context: OperationEvaluationContext,
  kind: "principal_binding" | "role_assignment",
) {
  const id = context.target?.ref.id ?? "";
  const value = kind === "principal_binding"
    ? store.getPrincipalBinding(id)
    : store.getRoleAssignment(id);
  return value?.workspace_id === workspaceId(context)
    ? { available: true as const }
    : {
        available: false as const,
        refusal: refusal("actor_role_authority_not_found", "The selected authority record is not available in this Workspace.", false, null),
      };
}

function handle<TResult>(fn: () => TResult): TResult | { state: "refused"; refusal: OperationRefusal } {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ActorRoleAuthorityNotFoundError) {
      return { state: "refused", refusal: refusal("actor_role_authority_not_found", error.message, false, null) };
    }
    if (error instanceof ActorRoleAuthorityConflictError) {
      return {
        state: "refused",
        refusal: refusal(
          "actor_role_authority_conflict",
          error.message,
          true,
          requiredAction("refresh_authority", "Refresh authority", "Refresh the retained authority state before trying again."),
        ),
      };
    }
    if (error instanceof ActorRoleAuthorityValidationError) {
      return { state: "refused", refusal: refusal("actor_role_authority_invalid", error.message, false, null) };
    }
    throw error;
  }
}

function expectedRevision(context: OperationExecutionContext): string {
  if (!context.expected_resource_revision) {
    throw new ActorRoleAuthorityValidationError("the exact authority record revision is required");
  }
  return context.expected_resource_revision;
}

export function actorRoleOperationDefinitions(
  store: ActorRoleAuthorityStore,
): SemanticOperationDefinition<any, any>[] {
  const inspect: SemanticOperationDefinition<{ include_history?: boolean }, ActorAuthorityInspection> = {
    operation_id: INSPECT_ACTOR_AUTHORITY_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "actors",
    title: "Inspect Actor authority",
    description: "Inspect which authenticated principals may back an Actor and which retained roles that Actor holds.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [INSPECT_ACTOR_AUTHORITY_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["actor"], expected_revision: "not_applicable" },
    input: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { include_history: { type: "boolean" } },
      },
    },
    result: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["actor_id", "principal_bindings", "role_assignments"],
        properties: {
          actor_id: text,
          principal_bindings: { type: "array", items: principalBindingSchema },
          role_assignments: { type: "array", items: roleAssignmentSchema },
        },
      },
    },
    availability: (context) => actorAvailability(store, context),
    handler: (context, input) => ({
      state: "completed",
      result: {
        actor_id: context.target!.ref.id,
        principal_bindings: store.listPrincipalBindings(workspaceId(context), {
          actor_id: context.target!.ref.id,
          include_revoked: input.include_history === true,
        }),
        role_assignments: store.listRoleAssignments(workspaceId(context), {
          actor_id: context.target!.ref.id,
          include_revoked: input.include_history === true,
        }),
      },
      audit_ref: auditRef(context),
    }),
  };

  const resolveOwn: SemanticOperationDefinition<ActorRoleResolutionTarget, ActorRoleResolution> = {
    operation_id: RESOLVE_OWN_ACTOR_ROLES_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "actors",
    title: "Resolve current Actor roles",
    description: "Resolve the authenticated principal's current roles from retained principal, Actor, Scope, Context, and execution evidence.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [RESOLVE_OWN_ACTOR_ROLES_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    input: {
      version: "1",
      schema: { type: "object", additionalProperties: false, properties: resolutionTargetProperties },
    },
    result: { version: "1", schema: resolutionSchema },
    handler: (context, input) => handle(() => ({
      state: "completed" as const,
      result: store.resolveCurrent({
        workspace_id: workspaceId(context),
        principal_id: context.authority.principal_id,
        target: input,
      }),
      audit_ref: auditRef(context),
    })),
  };

  const bindPrincipal: SemanticOperationDefinition<{
    principal_id: string;
    principal_actor_binding_id?: string;
  }, { binding: PrincipalActorBindingRecord }> = {
    operation_id: BIND_PRINCIPAL_TO_ACTOR_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "actors",
    title: "Bind principal to Actor",
    description: "Bind an authenticated principal identity to one stable Actor identity without granting operations or changing Actor backing semantics.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [BIND_PRINCIPAL_TO_ACTOR_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["actor"], expected_revision: "not_applicable" },
    input: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["principal_id"],
        properties: { principal_id: text, principal_actor_binding_id: text },
      },
    },
    result: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["binding"],
        properties: { binding: principalBindingSchema },
      },
    },
    availability: (context) => actorAvailability(store, context),
    handler: (context, input) => handle(() => {
      const binding = store.bindPrincipal({
        workspace_id: workspaceId(context),
        principal_id: input.principal_id,
        actor_id: context.target!.ref.id,
        bound_by_principal_id: context.authority.principal_id,
        evidence_refs: [{
          kind: "operation_invocation",
          id: context.invocation_id,
          revision: null,
        }],
        ...(input.principal_actor_binding_id
          ? { principal_actor_binding_id: input.principal_actor_binding_id }
          : {}),
      });
      return {
        state: "completed" as const,
        result: { binding },
        changed_refs: [{
          kind: "principal_actor_binding",
          id: binding.principal_actor_binding_id,
          revision: `bound:${binding.bound_at}`,
        }],
        audit_ref: auditRef(context),
      };
    }),
  };

  const revokePrincipal: SemanticOperationDefinition<{ reason: string }, { binding: PrincipalActorBindingRecord }> = {
    operation_id: REVOKE_PRINCIPAL_ACTOR_BINDING_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "actors",
    title: "Revoke principal Actor binding",
    description: "Permanently revoke one principal-to-Actor identity link while retaining its complete evidence.",
    effects: { mode: "write", reversibility: "irreversible", external: false, secret_access: "none" },
    required_grants: [REVOKE_PRINCIPAL_ACTOR_BINDING_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["principal_actor_binding"], expected_revision: "required" },
    input: {
      version: "1",
      schema: {
        type: "object", additionalProperties: false, required: ["reason"], properties: { reason: text },
      },
    },
    result: {
      version: "1",
      schema: {
        type: "object", additionalProperties: false, required: ["binding"], properties: { binding: principalBindingSchema },
      },
    },
    availability: (context) => roleAuthorityAvailability(store, context, "principal_binding"),
    handler: (context, input) => handle(() => {
      const current = store.requirePrincipalBinding(context.target!.ref.id);
      if (`bound:${current.bound_at}` !== expectedRevision(context) || current.status !== "active") {
        throw new ActorRoleAuthorityConflictError("the principal-to-Actor binding is no longer at the selected active revision");
      }
      const binding = store.revokePrincipalBinding({
        workspace_id: workspaceId(context),
        principal_actor_binding_id: current.principal_actor_binding_id,
        revoked_by_principal_id: context.authority.principal_id,
        reason: input.reason,
      });
      return {
        state: "completed" as const,
        result: { binding },
        changed_refs: [{ kind: "principal_actor_binding", id: binding.principal_actor_binding_id, revision: `bound:${binding.bound_at}` }],
        audit_ref: auditRef(context),
      };
    }),
  };

  const assignRole: SemanticOperationDefinition<{
    role: string;
    boundary: Exclude<ActorRoleBoundary, { kind: "context" }>;
    actor_role_assignment_id?: string;
  }, { assignment: ActorRoleAssignmentRecord }> = {
    operation_id: ASSIGN_ACTOR_ROLE_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "actors",
    title: "Assign Actor role",
    description: "Assign one explicit role to an Actor at a Workspace or Scope boundary. Context roles are changed through Context participation so collaboration and authority cannot diverge. This never creates routing.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [ASSIGN_ACTOR_ROLE_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["actor"], expected_revision: "not_applicable" },
    input: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["role", "boundary"],
        properties: { role: text, boundary: managedRoleBoundarySchema, actor_role_assignment_id: text },
      },
    },
    result: {
      version: "1",
      schema: {
        type: "object", additionalProperties: false, required: ["assignment"], properties: { assignment: roleAssignmentSchema },
      },
    },
    availability: (context) => actorAvailability(store, context),
    handler: (context, input) => handle(() => {
      const assignment = store.assignRole({
        workspace_id: workspaceId(context),
        actor_id: context.target!.ref.id,
        role: input.role,
        boundary: input.boundary,
        assigned_by_principal_id: context.authority.principal_id,
        ...(input.actor_role_assignment_id
          ? { actor_role_assignment_id: input.actor_role_assignment_id }
          : {}),
      });
      return {
        state: "completed" as const,
        result: { assignment },
        changed_refs: [{
          kind: "actor_role_assignment",
          id: assignment.actor_role_assignment_id,
          revision: `assigned:${assignment.assigned_at}`,
        }],
        audit_ref: auditRef(context),
      };
    }),
  };

  const revokeRole: SemanticOperationDefinition<{ reason: string }, { assignment: ActorRoleAssignmentRecord }> = {
    operation_id: REVOKE_ACTOR_ROLE_ASSIGNMENT_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "actors",
    title: "Revoke Actor role assignment",
    description: "Permanently revoke one Actor role assignment while retaining the exact authority history.",
    effects: { mode: "write", reversibility: "irreversible", external: false, secret_access: "none" },
    required_grants: [REVOKE_ACTOR_ROLE_ASSIGNMENT_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["actor_role_assignment"], expected_revision: "required" },
    input: {
      version: "1",
      schema: {
        type: "object", additionalProperties: false, required: ["reason"], properties: { reason: text },
      },
    },
    result: {
      version: "1",
      schema: {
        type: "object", additionalProperties: false, required: ["assignment"], properties: { assignment: roleAssignmentSchema },
      },
    },
    availability: (context) => roleAuthorityAvailability(store, context, "role_assignment"),
    handler: (context, input) => handle(() => {
      const current = store.requireRoleAssignment(context.target!.ref.id);
      if (`assigned:${current.assigned_at}` !== expectedRevision(context) || current.status !== "active") {
        throw new ActorRoleAuthorityConflictError("the Actor role assignment is no longer at the selected active revision");
      }
      const assignment = store.revokeRoleAssignment({
        workspace_id: workspaceId(context),
        actor_role_assignment_id: current.actor_role_assignment_id,
        revoked_by_principal_id: context.authority.principal_id,
        reason: input.reason,
      });
      return {
        state: "completed" as const,
        result: { assignment },
        changed_refs: [{
          kind: "actor_role_assignment",
          id: assignment.actor_role_assignment_id,
          revision: `assigned:${assignment.assigned_at}`,
        }],
        audit_ref: auditRef(context),
      };
    }),
  };

  return [inspect, resolveOwn, bindPrincipal, revokePrincipal, assignRole, revokeRole];
}

export function registerActorRoleOperations(
  registry: SemanticOperationRegistry,
  store: ActorRoleAuthorityStore,
): SemanticOperationRegistry {
  for (const definition of actorRoleOperationDefinitions(store)) registry.register(definition);
  return registry;
}

export function resolveActorRoleAuthorityResource(
  store: ActorRoleAuthorityStore,
  workspaceId: string,
  target: OperationResourceIdentity,
): ResolvedOperationResource | null {
  if (target.kind === "principal_actor_binding") {
    const binding = store.getPrincipalBinding(target.id);
    return binding?.workspace_id === workspaceId
      ? {
          ref: {
            ...target,
            revision: `bound:${binding.bound_at}`,
          },
          state: binding,
        }
      : null;
  }
  if (target.kind === "actor_role_assignment") {
    const assignment = store.getRoleAssignment(target.id);
    return assignment?.workspace_id === workspaceId
      ? {
          ref: {
            ...target,
            revision: `assigned:${assignment.assigned_at}`,
          },
          state: assignment,
        }
      : null;
  }
  return null;
}

// Exported for Approval evidence schemas without introducing a parallel shape.
export type { ActorRoleAuthorityEvidence };
