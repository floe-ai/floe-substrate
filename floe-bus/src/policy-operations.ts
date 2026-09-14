import {
  PolicyConflictError,
  PolicyNotFoundError,
  PolicyStore,
  PolicyValidationError,
  type PolicyBindingRecord,
  type PolicyContent,
  type PolicyEvaluationRecord,
  type PolicyRecord,
  type PolicyRevisionRecord,
} from "./policies.js";
import {
  refusal,
  requireWorkspaceAuthorityId,
  requiredAction,
  type JsonSchema,
  type OperationAuthorityBoundary,
  type OperationExecutionContext,
  type OperationResourceIdentity,
  type ResolvedOperationResource,
  type SemanticOperationDefinition,
  type SemanticOperationRegistry,
} from "./operations.js";

export const LIST_POLICIES_OPERATION_ID = "policy.list";
export const INSPECT_POLICY_OPERATION_ID = "policy.inspect";
export const CREATE_POLICY_OPERATION_ID = "policy.create";
export const CREATE_POLICY_DRAFT_OPERATION_ID = "policy.draft.create";
export const REPLACE_POLICY_DRAFT_OPERATION_ID = "policy.draft.replace";
export const PUBLISH_POLICY_OPERATION_ID = "policy.publish";
export const ROLLBACK_POLICY_OPERATION_ID = "policy.rollback";
export const BIND_POLICY_OPERATION_ID = "policy.bind";
export const REVOKE_POLICY_BINDING_OPERATION_ID = "policy.binding.revoke";
export const RETIRE_POLICY_OPERATION_ID = "policy.retire";
export const REACTIVATE_POLICY_OPERATION_ID = "policy.reactivate";
export const LIST_POLICY_EVALUATIONS_OPERATION_ID = "policy.evaluation.list";
export const INSPECT_POLICY_EVALUATION_OPERATION_ID = "policy.evaluation.inspect";

const text: JsonSchema = { type: "string", minLength: 1 };
const nullableText: JsonSchema = { oneOf: [text, { type: "null" }] };
const emptyInput: JsonSchema = { type: "object", additionalProperties: false };
const resourceRefSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id", "revision"],
  properties: { kind: text, id: text, revision: nullableText },
};
const effectsSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "reversibility", "external", "secret_access"],
  properties: {
    mode: { enum: ["read", "write"] },
    reversibility: { enum: ["none", "reversible", "irreversible"] },
    external: { type: "boolean" },
    secret_access: { enum: ["none", "reference", "brokered"] },
  },
};
const policyMatchSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    operation_ids: stringList(),
    principal_ids: stringList(),
    principal_roles: stringList(),
    interaction_modes: { type: "array", minItems: 1, uniqueItems: true, items: { enum: ["interactive", "unattended", "brokered"] } },
    target_kinds: stringList(),
    target_ids: stringList(),
    scope_ids: stringList(),
    actor_ids: stringList(),
    scope_composition_revision_ids: stringList(),
    node_placement_ids: stringList(),
    connector_binding_ids: stringList(),
    extension_installation_ids: stringList(),
    extension_package_version_ids: stringList(),
    data_classes: stringList(),
    worker_trust_levels: stringList(),
    external_effect: { type: "boolean" },
    reversibility: { enum: ["none", "reversible", "irreversible"] },
  },
};
const approversSchema: JsonSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["mode", "principal_ids", "roles"],
      properties: { mode: { const: "any" }, principal_ids: stringList(true), roles: stringList(true) },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["mode", "principal_ids"],
      properties: { mode: { const: "all_named" }, principal_ids: stringList() },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["mode", "principal_ids", "roles", "quorum"],
      properties: {
        mode: { const: "quorum" },
        principal_ids: stringList(true),
        roles: stringList(true),
        quorum: { type: "integer", minimum: 1 },
      },
    },
  ],
};
const budgetLimitSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["metric", "maximum", "window"],
  properties: {
    metric: text,
    maximum: { type: "number", minimum: 0 },
    window: { enum: ["operation", "scope_execution", "day", "month", "all_time"] },
    timezone: text,
  },
};
const policyEffectSchema: JsonSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "reason"],
      properties: { kind: { const: "deny" }, reason: text },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "reason", "approvers"],
      properties: { kind: { const: "require_approval" }, reason: text, approvers: approversSchema },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "limits"],
      properties: { kind: { const: "limit" }, limits: { type: "array", minItems: 1, items: budgetLimitSchema } },
    },
  ],
};
export const POLICY_CONTENT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "description", "rules"],
  properties: {
    label: text,
    description: text,
    rules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["rule_id", "priority", "match", "effect"],
        properties: {
          rule_id: text,
          priority: { type: "integer" },
          match: policyMatchSchema,
          effect: policyEffectSchema,
        },
      },
    },
  },
};
const policySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["policy_id", "workspace_id", "category", "status", "current_revision_id", "created_at", "updated_at", "retired_at"],
  properties: {
    policy_id: text,
    workspace_id: text,
    category: { enum: ["operation", "approval", "budget", "trust", "data", "emergency_stop"] },
    status: { enum: ["active", "retired"] },
    current_revision_id: nullableText,
    created_at: text,
    updated_at: text,
    retired_at: nullableText,
  },
};
const policyRevisionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "policy_revision_id", "policy_id", "workspace_id", "category", "revision_number",
    "based_on_revision_id", "semantic_digest", "content", "created_by_principal_id",
    "created_at", "published_at", "withdrawn_at",
  ],
  properties: {
    policy_revision_id: text,
    policy_id: text,
    workspace_id: text,
    category: policySchema.properties && (policySchema.properties as Record<string, JsonSchema>).category,
    revision_number: { type: "integer", minimum: 1 },
    based_on_revision_id: nullableText,
    semantic_digest: text,
    content: POLICY_CONTENT_SCHEMA,
    created_by_principal_id: text,
    created_at: text,
    published_at: nullableText,
    withdrawn_at: nullableText,
  },
};
const subjectSchema: JsonSchema = {
  oneOf: [
    ...["workspace", "scope", "actor", "connector_binding", "extension_installation"].map((kind) => ({
      type: "object",
      additionalProperties: false,
      required: ["kind", "id"],
      properties: { kind: { const: kind }, id: text },
    })),
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "id", "composition_revision_id"],
      properties: {
        kind: { const: "node_placement" },
        id: text,
        composition_revision_id: text,
      },
    },
  ],
};
const policyBindingSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "policy_binding_id", "workspace_id", "policy_revision_id", "subject", "status",
    "bound_by_principal_id", "bound_at", "revoked_by_principal_id", "revoked_at", "revocation_reason",
  ],
  properties: {
    policy_binding_id: text,
    workspace_id: text,
    policy_revision_id: text,
    subject: subjectSchema,
    status: { enum: ["active", "revoked"] },
    bound_by_principal_id: text,
    bound_at: text,
    revoked_by_principal_id: nullableText,
    revoked_at: nullableText,
    revocation_reason: nullableText,
  },
};
const policyEvaluationSchema: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: [
    "evaluation_id", "workspace_id", "facts", "facts_digest", "evaluated_policy_revision_ids",
    "matched_rules", "decision", "denial_reasons", "approval_requirements", "budget_limits", "evaluated_at",
  ],
  properties: {
    evaluation_id: text,
    workspace_id: text,
    facts: { oneOf: [{ type: "object" }, { type: "null" }] },
    facts_digest: text,
    evaluated_policy_revision_ids: { type: "array", items: text },
    matched_rules: { type: "array" },
    decision: { enum: ["allow", "deny", "require_approval"] },
    denial_reasons: { type: "array", items: text },
    approval_requirements: { type: "array" },
    budget_limits: { type: "array" },
    evaluated_at: text,
  },
};

function stringList(allowEmpty = false): JsonSchema {
  return { type: "array", minItems: allowEmpty ? 0 : 1, uniqueItems: true, items: text };
}

function auditRef(context: OperationExecutionContext) {
  return { kind: "operation_invocation", id: context.invocation_id, revision: null };
}

function writeEffects(reversibility: "reversible" | "irreversible" = "reversible") {
  return { mode: "write" as const, reversibility, external: false, secret_access: "none" as const };
}

function readEffects() {
  return { mode: "read" as const, reversibility: "none" as const, external: false, secret_access: "none" as const };
}

function policyRef(policy: PolicyRecord) {
  return { kind: "policy", id: policy.policy_id, revision: policy.updated_at };
}

function revisionRef(revision: PolicyRevisionRecord) {
  return { kind: "policy_revision", id: revision.policy_revision_id, revision: revision.semantic_digest };
}

function bindingRef(binding: PolicyBindingRecord) {
  return { kind: "policy_binding", id: binding.policy_binding_id, revision: binding.status === "active" ? binding.bound_at : binding.revoked_at };
}

function evaluationRef(evaluation: PolicyEvaluationRecord) {
  return { kind: "policy_evaluation", id: evaluation.evaluation_id, revision: evaluation.facts_digest };
}

function mapFailure(error: unknown) {
  if (error instanceof PolicyNotFoundError) {
    return refusal("policy_not_found", error.message, false, requiredAction("refresh_policy", "Refresh policies", "Refresh canonical Policy state."));
  }
  if (error instanceof PolicyConflictError) {
    return refusal("policy_changed", error.message, true, requiredAction("inspect_policy", "Review the latest Policy", "Inspect the current revision before retrying."));
  }
  if (error instanceof PolicyValidationError) {
    return refusal("policy_invalid", error.message, false, requiredAction("correct_policy", "Correct the Policy", "Use the exact discovered Policy schema."));
  }
  throw error;
}

export function policyOperationDefinitions(store: PolicyStore): readonly SemanticOperationDefinition[] {
  const operations: SemanticOperationDefinition[] = [
    {
      operation_id: LIST_POLICIES_OPERATION_ID,
      operation_version: "1",
      authority_boundary_kinds: ["workspace"],
      category: "policies",
      title: "List policies",
      description: "List canonical Policies and exact active bindings in this Workspace.",
      effects: readEffects(),
      required_grants: [LIST_POLICIES_OPERATION_ID],
      interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
      target: { resource_kinds: [], expected_revision: "not_applicable" },
      input: {
        version: "1",
        schema: {
          type: "object", additionalProperties: false,
          properties: { include_retired: { type: "boolean" }, include_revoked_bindings: { type: "boolean" } },
        },
      },
      result: {
        version: "1",
        schema: {
          type: "object", additionalProperties: false, required: ["policies", "bindings"],
          properties: { policies: { type: "array", items: policySchema }, bindings: { type: "array", items: policyBindingSchema } },
        },
      },
      handler: (context, input: unknown) => {
        const value = input as { include_retired?: boolean; include_revoked_bindings?: boolean };
        const workspaceId = requireWorkspaceAuthorityId(context.authority);
        return {
          state: "completed",
          result: {
            policies: store.listPolicies(workspaceId, { include_retired: value.include_retired }),
            bindings: store.listBindings(workspaceId, { include_revoked: value.include_revoked_bindings }),
          },
          audit_ref: auditRef(context),
        };
      },
    },
    {
      operation_id: INSPECT_POLICY_OPERATION_ID,
      operation_version: "1",
      authority_boundary_kinds: ["workspace"],
      category: "policies",
      title: "Inspect policy",
      description: "Inspect a Policy, its immutable revisions, and exact bindings.",
      effects: readEffects(),
      required_grants: [INSPECT_POLICY_OPERATION_ID],
      interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
      target: { resource_kinds: ["policy"], expected_revision: "not_applicable" },
      input: { version: "1", schema: emptyInput },
      result: {
        version: "1",
        schema: {
          type: "object", additionalProperties: false, required: ["policy", "revisions", "bindings"],
          properties: {
            policy: policySchema,
            revisions: { type: "array", items: policyRevisionSchema },
            bindings: { type: "array", items: policyBindingSchema },
          },
        },
      },
      handler: (context) => {
        const workspaceId = requireWorkspaceAuthorityId(context.authority);
        const policy = store.requirePolicyForWorkspace(context.target!.ref.id, workspaceId);
        const revisionIds = new Set(store.listRevisions(policy.policy_id).map((revision) => revision.policy_revision_id));
        return {
          state: "completed",
          result: {
            policy,
            revisions: store.listRevisions(policy.policy_id),
            bindings: store.listBindings(workspaceId, { include_revoked: true }).filter((binding) => revisionIds.has(binding.policy_revision_id)),
          },
          audit_ref: auditRef(context),
        };
      },
    },
    createPolicyDefinition(store),
    createDraftDefinition(store),
    replaceDraftDefinition(store),
    publishDefinition(store),
    rollbackDefinition(store),
    bindDefinition(store),
    revokeBindingDefinition(store),
    lifecycleDefinition(store, "retire"),
    lifecycleDefinition(store, "reactivate"),
    {
      operation_id: LIST_POLICY_EVALUATIONS_OPERATION_ID,
      operation_version: "1",
      authority_boundary_kinds: ["workspace"],
      category: "policies",
      title: "List policy decisions",
      description: "List retained deterministic Policy decisions and their exact revisions.",
      effects: readEffects(),
      required_grants: [LIST_POLICY_EVALUATIONS_OPERATION_ID],
      interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
      target: { resource_kinds: [], expected_revision: "not_applicable" },
      input: {
        version: "1",
        schema: { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 500 } } },
      },
      result: {
        version: "1",
        schema: { type: "object", additionalProperties: false, required: ["evaluations"], properties: { evaluations: { type: "array", items: policyEvaluationSchema } } },
      },
      handler: (context, input: unknown) => ({
        state: "completed",
        result: { evaluations: store.listEvaluations(requireWorkspaceAuthorityId(context.authority), (input as { limit?: number }).limit) },
        audit_ref: auditRef(context),
      }),
    },
    {
      operation_id: INSPECT_POLICY_EVALUATION_OPERATION_ID,
      operation_version: "1",
      authority_boundary_kinds: ["workspace"],
      category: "policies",
      title: "Inspect policy decision",
      description: "Inspect one retained Policy decision and the exact rules that produced it.",
      effects: readEffects(),
      required_grants: [INSPECT_POLICY_EVALUATION_OPERATION_ID],
      interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
      target: { resource_kinds: ["policy_evaluation"], expected_revision: "not_applicable" },
      input: { version: "1", schema: emptyInput },
      result: { version: "1", schema: policyEvaluationSchema },
      handler: (context) => {
        const workspaceId = requireWorkspaceAuthorityId(context.authority);
        const evaluation = store.getEvaluation(context.target!.ref.id);
        if (!evaluation || evaluation.workspace_id !== workspaceId) throw new PolicyNotFoundError("revision", context.target!.ref.id);
        return { state: "completed", result: evaluation, audit_ref: auditRef(context) };
      },
    },
  ];
  return operations;
}

function createPolicyDefinition(store: PolicyStore): SemanticOperationDefinition {
  return {
    operation_id: CREATE_POLICY_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "policies",
    title: "Create policy",
    description: "Create one stable Policy and its first draft revision.",
    effects: writeEffects(),
    required_grants: [CREATE_POLICY_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    input: {
      version: "1",
      schema: {
        type: "object", additionalProperties: false, required: ["category", "content"],
        properties: {
          policy_id: text,
          category: (policySchema.properties as Record<string, JsonSchema>).category,
          content: POLICY_CONTENT_SCHEMA,
        },
      },
    },
    result: {
      version: "1",
      schema: { type: "object", additionalProperties: false, required: ["policy", "draft"], properties: { policy: policySchema, draft: policyRevisionSchema } },
    },
    handler: (context, input: unknown) => {
      try {
        const value = input as { policy_id?: string; category: Parameters<PolicyStore["createPolicy"]>[0]["category"]; content: PolicyContent };
        const result = store.createPolicy({
          workspace_id: requireWorkspaceAuthorityId(context.authority),
          ...(value.policy_id ? { policy_id: value.policy_id } : {}),
          category: value.category,
          content: value.content,
          created_by_principal_id: context.authority.principal_id,
        });
        return { state: "completed", result, changed_refs: [policyRef(result.policy), revisionRef(result.draft)], audit_ref: auditRef(context) };
      } catch (error) {
        return { state: "refused", refusal: mapFailure(error) };
      }
    },
  };
}

function createDraftDefinition(store: PolicyStore): SemanticOperationDefinition {
  return {
    operation_id: CREATE_POLICY_DRAFT_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "policies",
    title: "Create policy draft",
    description: "Create a new draft based on the exact published Policy revision.",
    effects: writeEffects(),
    required_grants: [CREATE_POLICY_DRAFT_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["policy"], expected_revision: "required" },
    input: {
      version: "1",
      schema: { type: "object", additionalProperties: false, required: ["based_on_revision_id", "content"], properties: { based_on_revision_id: nullableText, content: POLICY_CONTENT_SCHEMA } },
    },
    result: { version: "1", schema: policyRevisionSchema },
    handler: (context, input: unknown) => {
      try {
        const value = input as { based_on_revision_id: string | null; content: PolicyContent };
        const revision = store.createDraft({
          workspace_id: requireWorkspaceAuthorityId(context.authority),
          policy_id: context.target!.ref.id,
          based_on_revision_id: value.based_on_revision_id,
          content: value.content,
          created_by_principal_id: context.authority.principal_id,
        });
        return { state: "completed", result: revision, changed_refs: [revisionRef(revision)], audit_ref: auditRef(context) };
      } catch (error) {
        return { state: "refused", refusal: mapFailure(error) };
      }
    },
  };
}

function replaceDraftDefinition(store: PolicyStore): SemanticOperationDefinition {
  return {
    operation_id: REPLACE_POLICY_DRAFT_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "policies",
    title: "Replace policy draft",
    description: "Replace an unpublished Policy draft using its exact semantic digest.",
    effects: writeEffects(),
    required_grants: [REPLACE_POLICY_DRAFT_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["policy_revision"], expected_revision: "required" },
    input: { version: "1", schema: { type: "object", additionalProperties: false, required: ["content"], properties: { content: POLICY_CONTENT_SCHEMA } } },
    result: { version: "1", schema: policyRevisionSchema },
    handler: (context, input: unknown) => {
      try {
        const revision = store.replaceDraft({
          workspace_id: requireWorkspaceAuthorityId(context.authority),
          policy_revision_id: context.target!.ref.id,
          expected_semantic_digest: context.expected_resource_revision!,
          content: (input as { content: PolicyContent }).content,
        });
        return { state: "completed", result: revision, changed_refs: [revisionRef(revision)], audit_ref: auditRef(context) };
      } catch (error) {
        return { state: "refused", refusal: mapFailure(error) };
      }
    },
  };
}

function publishDefinition(store: PolicyStore): SemanticOperationDefinition {
  return {
    operation_id: PUBLISH_POLICY_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "policies",
    title: "Publish policy",
    description: "Publish an immutable Policy revision and make it the current head.",
    effects: writeEffects(),
    required_grants: [PUBLISH_POLICY_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["policy_revision"], expected_revision: "required" },
    input: { version: "1", schema: { type: "object", additionalProperties: false, required: ["expected_current_revision_id"], properties: { expected_current_revision_id: nullableText } } },
    result: { version: "1", schema: { type: "object", additionalProperties: false, required: ["policy", "revision"], properties: { policy: policySchema, revision: policyRevisionSchema } } },
    handler: (context, input: unknown) => {
      try {
        const selected = store.requireRevision(context.target!.ref.id);
        if (selected.semantic_digest !== context.expected_resource_revision) throw new PolicyConflictError(selected.policy_id, "the draft changed before publication");
        const result = store.publishRevision({
          workspace_id: requireWorkspaceAuthorityId(context.authority),
          policy_revision_id: selected.policy_revision_id,
          expected_current_revision_id: (input as { expected_current_revision_id: string | null }).expected_current_revision_id,
        });
        return { state: "completed", result, changed_refs: [policyRef(result.policy), revisionRef(result.revision)], audit_ref: auditRef(context) };
      } catch (error) {
        return { state: "refused", refusal: mapFailure(error) };
      }
    },
  };
}

function rollbackDefinition(store: PolicyStore): SemanticOperationDefinition {
  return {
    operation_id: ROLLBACK_POLICY_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "policies",
    title: "Roll back policy",
    description: "Point a Policy back to one retained published revision without rewriting history.",
    effects: writeEffects(),
    required_grants: [ROLLBACK_POLICY_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["policy"], expected_revision: "required" },
    input: { version: "1", schema: { type: "object", additionalProperties: false, required: ["target_revision_id"], properties: { target_revision_id: text } } },
    result: { version: "1", schema: policySchema },
    handler: (context, input: unknown) => {
      try {
        const policy = store.rollback({
          workspace_id: requireWorkspaceAuthorityId(context.authority),
          policy_id: context.target!.ref.id,
          target_revision_id: (input as { target_revision_id: string }).target_revision_id,
          expected_current_revision_id: currentRevisionFromPolicyTarget(context),
        });
        return { state: "completed", result: policy, changed_refs: [policyRef(policy)], audit_ref: auditRef(context) };
      } catch (error) {
        return { state: "refused", refusal: mapFailure(error) };
      }
    },
  };
}

function bindDefinition(store: PolicyStore): SemanticOperationDefinition {
  return {
    operation_id: BIND_POLICY_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "policies",
    title: "Bind policy",
    description: "Apply one exact published Policy revision to a canonical subject.",
    effects: writeEffects(),
    required_grants: [BIND_POLICY_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["policy_revision"], expected_revision: "required" },
    input: { version: "1", schema: { type: "object", additionalProperties: false, required: ["subject"], properties: { policy_binding_id: text, subject: subjectSchema } } },
    result: { version: "1", schema: policyBindingSchema },
    handler: (context, input: unknown) => {
      try {
        const revision = store.requireRevision(context.target!.ref.id);
        if (revision.semantic_digest !== context.expected_resource_revision) throw new PolicyConflictError(revision.policy_id, "the selected revision changed");
        const value = input as { policy_binding_id?: string; subject: Parameters<PolicyStore["bindRevision"]>[0]["subject"] };
        const binding = store.bindRevision({
          workspace_id: requireWorkspaceAuthorityId(context.authority),
          policy_revision_id: revision.policy_revision_id,
          subject: value.subject,
          bound_by_principal_id: context.authority.principal_id,
          ...(value.policy_binding_id ? { policy_binding_id: value.policy_binding_id } : {}),
        });
        return { state: "completed", result: binding, changed_refs: [bindingRef(binding)], audit_ref: auditRef(context) };
      } catch (error) {
        return { state: "refused", refusal: mapFailure(error) };
      }
    },
  };
}

function revokeBindingDefinition(store: PolicyStore): SemanticOperationDefinition {
  return {
    operation_id: REVOKE_POLICY_BINDING_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "policies",
    title: "Revoke policy binding",
    description: "Stop applying one exact Policy binding while retaining its history.",
    effects: writeEffects(),
    required_grants: [REVOKE_POLICY_BINDING_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["policy_binding"], expected_revision: "required" },
    input: { version: "1", schema: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: text } } },
    result: { version: "1", schema: policyBindingSchema },
    handler: (context, input: unknown) => {
      try {
        const current = store.requireBinding(context.target!.ref.id);
        if (bindingRef(current).revision !== context.expected_resource_revision) throw new PolicyConflictError(current.policy_revision_id, "the binding changed");
        const binding = store.revokeBinding({
          workspace_id: requireWorkspaceAuthorityId(context.authority),
          policy_binding_id: current.policy_binding_id,
          revoked_by_principal_id: context.authority.principal_id,
          reason: (input as { reason: string }).reason,
        });
        return { state: "completed", result: binding, changed_refs: [bindingRef(binding)], audit_ref: auditRef(context) };
      } catch (error) {
        return { state: "refused", refusal: mapFailure(error) };
      }
    },
  };
}

function lifecycleDefinition(store: PolicyStore, action: "retire" | "reactivate"): SemanticOperationDefinition {
  const operationId = action === "retire" ? RETIRE_POLICY_OPERATION_ID : REACTIVATE_POLICY_OPERATION_ID;
  return {
    operation_id: operationId,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "policies",
    title: action === "retire" ? "Retire policy" : "Reactivate policy",
    description: action === "retire"
      ? "Retire an unbound Policy while preserving every revision and decision."
      : "Make a retained Policy available for explicit binding again.",
    effects: writeEffects(),
    required_grants: [operationId],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["policy"], expected_revision: "required" },
    input: { version: "1", schema: emptyInput },
    result: { version: "1", schema: policySchema },
    handler: (context) => {
      try {
        const current = store.requirePolicy(context.target!.ref.id);
        if (current.updated_at !== context.expected_resource_revision) throw new PolicyConflictError(current.policy_id, "the Policy changed");
        const policy = action === "retire"
          ? store.retirePolicy({ workspace_id: requireWorkspaceAuthorityId(context.authority), policy_id: current.policy_id })
          : store.reactivatePolicy({ workspace_id: requireWorkspaceAuthorityId(context.authority), policy_id: current.policy_id });
        return { state: "completed", result: policy, changed_refs: [policyRef(policy)], audit_ref: auditRef(context) };
      } catch (error) {
        return { state: "refused", refusal: mapFailure(error) };
      }
    },
  };
}

function currentRevisionFromPolicyTarget(context: OperationExecutionContext): string {
  const state = context.target?.state as PolicyRecord | undefined;
  if (!state?.current_revision_id) throw new PolicyConflictError(context.target?.ref.id ?? "unknown", "there is no published revision to roll back");
  return state.current_revision_id;
}

export function registerPolicyOperations(registry: SemanticOperationRegistry, store: PolicyStore): SemanticOperationRegistry {
  for (const definition of policyOperationDefinitions(store)) registry.register(definition);
  return registry;
}

export function resolvePolicyOperationResource(
  store: PolicyStore,
  boundary: OperationAuthorityBoundary,
  target: OperationResourceIdentity,
): ResolvedOperationResource | null {
  if (boundary.kind !== "workspace") return null;
  if (target.kind === "policy") {
    const policy = store.getPolicy(target.id);
    return policy?.workspace_id === boundary.workspace_id ? { ref: policyRef(policy), state: policy } : null;
  }
  if (target.kind === "policy_revision") {
    const revision = store.getRevision(target.id);
    return revision?.workspace_id === boundary.workspace_id ? { ref: revisionRef(revision), state: revision } : null;
  }
  if (target.kind === "policy_binding") {
    const binding = store.getBinding(target.id);
    return binding?.workspace_id === boundary.workspace_id ? { ref: bindingRef(binding), state: binding } : null;
  }
  if (target.kind === "policy_evaluation") {
    const evaluation = store.getEvaluation(target.id);
    return evaluation?.workspace_id === boundary.workspace_id ? { ref: evaluationRef(evaluation), state: evaluation } : null;
  }
  return null;
}

export const POLICY_OPERATION_SCHEMAS = Object.freeze({
  content: POLICY_CONTENT_SCHEMA,
  policy: policySchema,
  revision: policyRevisionSchema,
  binding: policyBindingSchema,
  evaluation: policyEvaluationSchema,
  resource_ref: resourceRefSchema,
  effects: effectsSchema,
});
