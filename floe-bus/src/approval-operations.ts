import {
  ApprovalConflictError,
  ApprovalDeniedError,
  ApprovalNotFoundError,
  ApprovalStore,
  ApprovalValidationError,
  approvalReceiptStateRevision,
  type ApprovalAction,
  type ApprovalDecision,
  type ApprovalDecisionBinding,
  type ApprovalDecisionPolicyReference,
  type ApprovalDecisionPolicySnapshot,
  type ApprovalIndividualDecisionRecord,
  type ApprovalReceiptRecord,
  type ApprovalRequestRecord,
  type ApprovalRequestStatus,
} from "./approvals.js";
import {
  refusal,
  requiredAction,
  requireWorkspaceAuthorityId,
  type JsonSchema,
  type OperationExecutionContext,
  type OperationHandlerOutcome,
  type OperationRefusal,
  type SemanticOperationDefinition,
  type SemanticOperationRegistry,
} from "./operations.js";

export const LIST_APPROVALS_OPERATION_ID = "approval.list";
export const INSPECT_APPROVAL_OPERATION_ID = "approval.inspect";
export const REQUEST_APPROVAL_OPERATION_ID = "approval.request";
export const DECIDE_APPROVAL_OPERATION_ID = "approval.decide";
export const CANCEL_APPROVAL_OPERATION_ID = "approval.cancel";
export const CONFIGURE_APPROVAL_RESPONSE_OPERATION_ID = "approval.response.configure";
export const REVOKE_APPROVAL_RECEIPT_OPERATION_ID = "approval.receipt.revoke";

export interface ApprovalOperationBackend {
  readonly store: ApprovalStore;
  contextBelongsToWorkspace(contextId: string, workspaceId: string): boolean;
  /** Validates any exact Scope continuation before retaining the request. */
  createRequest(
    input: Omit<Parameters<ApprovalStore["createRequest"]>[0], "decision_policy"> & Readonly<{
      decision_policy_ref?: ApprovalDecisionPolicyReference;
    }>,
  ): ApprovalRequestRecord;
  configureResponse(input: Parameters<ApprovalStore["configureResponse"]>[0]): ApprovalRequestRecord;
  /**
   * Records the human or Actor decision Event and the ApprovalReceipt in one
   * Bus transaction. The Event is evidence of the decision; only the exact
   * returned receipt can authorise later execution.
   */
  decideRequest(input: Readonly<{
    workspace_id: string;
    approval_request_id: string;
    expected_state_revision: number;
    decision: ApprovalDecision;
    decided_by_principal_id: string;
    decision_reason: string;
    receipt_expires_at?: string;
    operation_invocation_id: string;
    supersedes_decision_id?: string | null;
  }>): Readonly<{
    request: ApprovalRequestRecord;
    receipt: ApprovalReceiptRecord | null;
    individual_decision: ApprovalIndividualDecisionRecord;
  }>;
}

type ApprovalInspection = Readonly<{
  request: ApprovalRequestRecord;
  receipt: ApprovalReceiptRecord | null;
}>;

const text: JsonSchema = { type: "string", minLength: 1 };
const nullableText: JsonSchema = { oneOf: [text, { type: "null" }] };
const timestamp: JsonSchema = {
  type: "string",
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
};
const sha256: JsonSchema = { type: "string", pattern: "^[a-fA-F0-9]{64}$" };
const resourceRefSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id", "revision"],
  properties: { kind: text, id: text, revision: nullableText },
};
const approvalEffectSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "external", "reversibility", "resource_refs"],
  properties: {
    summary: text,
    external: { type: "boolean" },
    reversibility: { enum: ["none", "reversible", "irreversible"] },
    resource_refs: { type: "array", items: resourceRefSchema },
  },
};
const approvalDecisionBindingSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "scope_execution_id", "composition_revision_id", "node_execution_id",
    "node_placement_id", "node_execution_state_revision", "outcome_port_ids",
  ],
  properties: {
    scope_execution_id: text,
    composition_revision_id: text,
    node_execution_id: text,
    node_placement_id: text,
    node_execution_state_revision: { type: "integer", minimum: 1 },
    outcome_port_ids: {
      type: "object",
      additionalProperties: false,
      required: ["approved", "rejected", "changes_requested"],
      properties: {
        approved: text,
        rejected: text,
        changes_requested: text,
      },
    },
  },
};
const approvalApproverSelectorSchema: JsonSchema = {
  oneOf: [
    {
      type: "object", additionalProperties: false,
      required: ["mode", "principal_ids", "roles"],
      properties: {
        mode: { const: "any" },
        principal_ids: { type: "array", items: text, uniqueItems: true },
        roles: { type: "array", items: text, uniqueItems: true },
      },
    },
    {
      type: "object", additionalProperties: false,
      required: ["mode", "principal_ids"],
      properties: {
        mode: { const: "all_named" },
        principal_ids: { type: "array", items: text, minItems: 1, uniqueItems: true },
      },
    },
    {
      type: "object", additionalProperties: false,
      required: ["mode", "principal_ids", "roles", "quorum"],
      properties: {
        mode: { const: "quorum" },
        principal_ids: { type: "array", items: text, uniqueItems: true },
        roles: { type: "array", items: text, uniqueItems: true },
        quorum: { type: "integer", minimum: 1 },
      },
    },
  ],
};
const approvalDecisionPolicySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["source", "approvers"],
  properties: {
    source: {
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["kind", "policy_evaluation_id", "policy_revision_id", "rule_id", "facts_digest"],
          properties: {
            kind: { const: "policy_evaluation" },
            policy_evaluation_id: text,
            policy_revision_id: text,
            rule_id: text,
            facts_digest: sha256,
          },
        },
        { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { const: "legacy_any_one" } } },
        {
          type: "object", additionalProperties: false, required: ["kind", "principal_id"],
          properties: { kind: { const: "local_operator" }, principal_id: text },
        },
      ],
    },
    approvers: approvalApproverSelectorSchema,
  },
};
const approvalDecisionPolicyReferenceSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["policy_evaluation_id", "policy_revision_id", "rule_id"],
  properties: {
    policy_evaluation_id: text,
    policy_revision_id: text,
    rule_id: text,
  },
};
const approvalIndividualDecisionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "approval_decision_id", "approval_request_id", "workspace_id", "principal_id",
    "decision", "reason", "decision_event_id", "authority_grant_ids", "role_evidence",
    "supersedes_decision_id", "idempotency_key", "decided_at", "decision_set_digest",
    "resolution_after",
  ],
  properties: {
    approval_decision_id: text,
    approval_request_id: text,
    workspace_id: text,
    principal_id: text,
    decision: { enum: ["approved", "rejected", "changes_requested"] },
    reason: text,
    decision_event_id: text,
    authority_grant_ids: { type: "array", items: text, uniqueItems: true },
    role_evidence: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["role", "authority_ref"],
        properties: { role: text, authority_ref: text },
      },
    },
    supersedes_decision_id: nullableText,
    idempotency_key: text,
    decided_at: timestamp,
    decision_set_digest: sha256,
    resolution_after: { oneOf: [{ enum: ["approved", "rejected", "changes_requested"] }, { type: "null" }] },
  },
};
export const APPROVAL_ACTION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "operation_id", "authorized_principal_id", "target", "input_digest",
    "artefact_version_ids", "composition_revision_id", "node_placement_id",
    "scope_execution_id", "node_execution_id", "connector_binding_revision_id",
    "extension_package_version_id", "approval_policy_ref", "capability_grant_ids",
    "expected_effect",
  ],
  properties: {
    operation_id: text,
    authorized_principal_id: text,
    target: { oneOf: [resourceRefSchema, { type: "null" }] },
    input_digest: sha256,
    artefact_version_ids: { type: "array", items: text, uniqueItems: true },
    composition_revision_id: nullableText,
    node_placement_id: nullableText,
    scope_execution_id: nullableText,
    node_execution_id: nullableText,
    connector_binding_revision_id: nullableText,
    extension_package_version_id: nullableText,
    approval_policy_ref: { oneOf: [resourceRefSchema, { type: "null" }] },
    capability_grant_ids: { type: "array", items: text, uniqueItems: true },
    expected_effect: approvalEffectSchema,
  },
};

const approvalRequestSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "approval_request_id", "workspace_id", "action", "action_digest", "context_id", "decision_binding", "response_participant_id",
    "decision_policy", "decision_policy_digest", "decision_set_digest", "decisions", "progress",
    "requested_by_principal_id", "reason", "requested_at", "expires_at", "maximum_uses",
    "idempotency_key", "status", "decision", "state_revision", "decided_by_principal_id",
    "decision_event_id", "decision_reason", "decided_at", "resource_ref",
  ],
  properties: {
    resource_ref: resourceRefSchema,
    approval_request_id: text,
    workspace_id: text,
    action: APPROVAL_ACTION_SCHEMA,
    action_digest: sha256,
    context_id: nullableText,
    decision_binding: { oneOf: [approvalDecisionBindingSchema, { type: "null" }] },
    response_participant_id: nullableText,
    decision_policy: approvalDecisionPolicySchema,
    decision_policy_digest: sha256,
    decision_set_digest: sha256,
    decisions: { type: "array", items: approvalIndividualDecisionSchema },
    progress: {
      type: "object", additionalProperties: false,
      required: ["approvals_received", "approvals_required", "active_decision_count", "remaining_named_principal_ids", "resolution"],
      properties: {
        approvals_received: { type: "integer", minimum: 0 },
        approvals_required: { type: "integer", minimum: 1 },
        active_decision_count: { type: "integer", minimum: 0 },
        remaining_named_principal_ids: { type: "array", items: text, uniqueItems: true },
        resolution: { oneOf: [{ enum: ["approved", "rejected", "changes_requested"] }, { type: "null" }] },
      },
    },
    requested_by_principal_id: text,
    reason: text,
    requested_at: timestamp,
    expires_at: timestamp,
    maximum_uses: { type: "integer", minimum: 1 },
    idempotency_key: text,
    status: { enum: ["pending", "approved", "rejected", "cancelled", "invalidated"] },
    decision: { oneOf: [{ enum: ["approved", "rejected", "changes_requested"] }, { type: "null" }] },
    state_revision: { type: "integer", minimum: 1 },
    decided_by_principal_id: nullableText,
    decision_event_id: nullableText,
    decision_reason: nullableText,
    decided_at: { oneOf: [timestamp, { type: "null" }] },
  },
};

const approvalReceiptSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "approval_receipt_id", "approval_request_id", "workspace_id", "action",
    "action_digest", "decision_set_digest", "context_id", "requested_by_principal_id", "approved_by_principal_id",
    "decision_event_id", "issued_at", "expires_at", "maximum_uses", "use_count",
    "revoked_at", "revoked_by_principal_id", "revocation_reason", "resource_ref",
  ],
  properties: {
    resource_ref: resourceRefSchema,
    approval_receipt_id: text,
    approval_request_id: text,
    workspace_id: text,
    action: APPROVAL_ACTION_SCHEMA,
    action_digest: sha256,
    decision_set_digest: sha256,
    context_id: nullableText,
    requested_by_principal_id: text,
    approved_by_principal_id: text,
    decision_event_id: text,
    issued_at: timestamp,
    expires_at: timestamp,
    maximum_uses: { type: "integer", minimum: 1 },
    use_count: { type: "integer", minimum: 0 },
    revoked_at: { oneOf: [timestamp, { type: "null" }] },
    revoked_by_principal_id: nullableText,
    revocation_reason: nullableText,
  },
};

const inspectionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["request", "receipt"],
  properties: {
    request: approvalRequestSchema,
    receipt: { oneOf: [approvalReceiptSchema, { type: "null" }] },
  },
};

const interactionModes = ["interactive", "unattended", "brokered"] as const;

function requestRef(request: ApprovalRequestRecord) {
  return {
    kind: "approval_request",
    id: request.approval_request_id,
    revision: String(request.state_revision),
  };
}

function receiptRef(receipt: ApprovalReceiptRecord) {
  return {
    kind: "approval_receipt",
    id: receipt.approval_receipt_id,
    revision: approvalReceiptStateRevision(receipt),
  };
}

function projectRequest(request: ApprovalRequestRecord) {
  return { ...request, resource_ref: requestRef(request) };
}

function projectReceipt(receipt: ApprovalReceiptRecord | null) {
  return receipt ? { ...receipt, resource_ref: receiptRef(receipt) } : null;
}

function auditRef(context: OperationExecutionContext) {
  return { kind: "operation_invocation", id: context.invocation_id, revision: null };
}

function stateRevision(context: OperationExecutionContext): number {
  const revision = Number(context.expected_resource_revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new ApprovalValidationError("expected_resource_revision must be the inspected ApprovalRequest state revision");
  }
  return revision;
}

const decisionResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["request", "receipt", "individual_decision"],
  properties: {
    request: approvalRequestSchema,
    receipt: { oneOf: [approvalReceiptSchema, { type: "null" }] },
    individual_decision: approvalIndividualDecisionSchema,
  },
};

function operationRefusal(error: unknown): OperationRefusal {
  if (error instanceof ApprovalNotFoundError) {
    return refusal(
      "approval_not_found",
      error.message,
      false,
      requiredAction("inspect_approvals", "Inspect approvals", "Refresh the approval inbox and use an exact retained reference."),
    );
  }
  if (error instanceof ApprovalConflictError) {
    return refusal(
      "approval_changed",
      error.message,
      true,
      requiredAction("inspect_approval", "Inspect approval", "Inspect the current decision and state revision before acting."),
    );
  }
  if (error instanceof ApprovalValidationError) {
    return refusal(
      "approval_invalid",
      error.message,
      false,
      requiredAction("correct_approval", "Correct approval", "Use the discovered approval contract and exact immutable references."),
    );
  }
  if (error instanceof ApprovalDeniedError) {
    return refusal(
      error.denial_code,
      error.message,
      false,
      requiredAction("request_new_approval", "Request new approval", "The current receipt cannot authorise this exact action."),
    );
  }
  return refusal(
    "approval_outcome_unknown",
    "Floe could not prove whether the approval operation completed.",
    false,
    requiredAction("inspect_approval", "Inspect approval", "Inspect retained approval state before attempting another decision."),
  );
}

async function handled<TResult>(
  work: () => OperationHandlerOutcome<TResult> | Promise<OperationHandlerOutcome<TResult>>,
): Promise<OperationHandlerOutcome<TResult>> {
  try {
    return await work();
  } catch (error) {
    return { state: "refused", refusal: operationRefusal(error) };
  }
}

function requireRequestInWorkspace(backend: ApprovalOperationBackend, id: string, workspaceId: string) {
  return backend.store.requireRequestForWorkspace(id, workspaceId);
}

function requireReceiptInWorkspace(backend: ApprovalOperationBackend, id: string, workspaceId: string) {
  return backend.store.requireReceiptForWorkspace(id, workspaceId);
}

export function listApprovalsOperation(
  backend: ApprovalOperationBackend,
): SemanticOperationDefinition<{
  status?: ApprovalRequestStatus;
  include_expired?: boolean;
  attention_only?: boolean;
  limit?: number;
}, { requests: readonly ApprovalRequestRecord[] }> {
  return {
    operation_id: LIST_APPROVALS_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "approvals",
    title: "List approvals",
    description: "List approval requests from canonical state, including the operator attention queue.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [LIST_APPROVALS_OPERATION_ID],
    interaction_constraints: { allowed_modes: interactionModes },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    input: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { enum: ["pending", "approved", "rejected", "cancelled", "invalidated"] },
          include_expired: { type: "boolean" },
          attention_only: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
      },
    },
    result: {
      version: "3",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["requests"],
        properties: { requests: { type: "array", items: approvalRequestSchema } },
      },
    },
    handler: (context, input) => handled(() => ({
      state: "completed",
      result: {
        requests: (input.attention_only
          ? backend.store.listAttention(requireWorkspaceAuthorityId(context.authority), input.limit)
          : backend.store.listRequests(requireWorkspaceAuthorityId(context.authority), {
              ...(input.status ? { status: input.status } : {}),
              ...(input.include_expired === undefined ? {} : { include_expired: input.include_expired }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            })).map(projectRequest),
      },
      audit_ref: auditRef(context),
    })),
  };
}

export function inspectApprovalOperation(
  backend: ApprovalOperationBackend,
): SemanticOperationDefinition<Record<string, never>, ApprovalInspection> {
  return {
    operation_id: INSPECT_APPROVAL_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "approvals",
    title: "Inspect approval",
    description: "Inspect one exact ApprovalRequest or ApprovalReceipt and its bound action.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [INSPECT_APPROVAL_OPERATION_ID],
    interaction_constraints: { allowed_modes: interactionModes },
    target: { resource_kinds: ["approval_request", "approval_receipt"], expected_revision: "not_applicable" },
    input: { version: "1", schema: { type: "object", additionalProperties: false } },
    result: { version: "3", schema: inspectionSchema },
    handler: (context) => handled(() => {
      const workspaceId = requireWorkspaceAuthorityId(context.authority);
      if (context.target!.ref.kind === "approval_request") {
        const request = requireRequestInWorkspace(backend, context.target!.ref.id, workspaceId);
        const receipt = backend.store.getReceiptForRequest(request.approval_request_id);
        return { state: "completed", result: { request: projectRequest(request), receipt: projectReceipt(receipt) }, audit_ref: auditRef(context) };
      }
      const receipt = requireReceiptInWorkspace(backend, context.target!.ref.id, workspaceId);
      const request = requireRequestInWorkspace(backend, receipt.approval_request_id, workspaceId);
      return { state: "completed", result: { request: projectRequest(request), receipt: projectReceipt(receipt) }, audit_ref: auditRef(context) };
    }),
  };
}

export function requestApprovalOperation(
  backend: ApprovalOperationBackend,
): SemanticOperationDefinition<{
  action: ApprovalAction;
  context_id?: string | null;
  decision_binding?: ApprovalDecisionBinding | null;
  decision_policy_ref?: ApprovalDecisionPolicyReference;
  reason: string;
  expires_at: string;
  maximum_uses?: number;
}, { request: ApprovalRequestRecord }> {
  return {
    operation_id: REQUEST_APPROVAL_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "approvals",
    title: "Request approval",
    description: "Request a decision for one exact action, input set, effect, policy, and authorised principal.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [REQUEST_APPROVAL_OPERATION_ID],
    interaction_constraints: { allowed_modes: interactionModes },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    input: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["action", "reason", "expires_at"],
        properties: {
          action: APPROVAL_ACTION_SCHEMA,
          context_id: { oneOf: [text, { type: "null" }] },
          decision_binding: { oneOf: [approvalDecisionBindingSchema, { type: "null" }] },
          decision_policy_ref: approvalDecisionPolicyReferenceSchema,
          reason: text,
          expires_at: timestamp,
          maximum_uses: { type: "integer", minimum: 1 },
        },
      },
    },
    result: {
      version: "3",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["request"],
        properties: { request: approvalRequestSchema },
      },
    },
    handler: (context, input) => handled(() => {
      const workspaceId = requireWorkspaceAuthorityId(context.authority);
      if (input.context_id != null && !backend.contextBelongsToWorkspace(input.context_id, workspaceId)) {
        throw new ApprovalValidationError("context_id must identify an inspectable Context in this Workspace");
      }
      if (input.decision_binding && input.context_id == null) {
        throw new ApprovalValidationError("a Scope-bound approval requires its exact active Context");
      }
      const request = backend.createRequest({
        workspace_id: workspaceId,
        action: input.action,
        context_id: input.context_id ?? null,
        ...(input.decision_binding === undefined ? {} : { decision_binding: input.decision_binding }),
        ...(input.decision_policy_ref === undefined ? {} : { decision_policy_ref: input.decision_policy_ref }),
        requested_by_principal_id: context.authority.principal_id,
        reason: input.reason,
        expires_at: input.expires_at,
        ...(input.maximum_uses === undefined ? {} : { maximum_uses: input.maximum_uses }),
        idempotency_key: context.idempotency_key,
      });
      return {
        state: "completed",
        result: { request: projectRequest(request) },
        changed_refs: [requestRef(request)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function decideApprovalOperation(
  backend: ApprovalOperationBackend,
): SemanticOperationDefinition<{
  decision: ApprovalDecision;
  reason: string;
  receipt_expires_at?: string;
  supersedes_decision_id?: string;
}, {
  request: ApprovalRequestRecord;
  receipt: ApprovalReceiptRecord | null;
  individual_decision: ApprovalIndividualDecisionRecord;
}> {
  return {
    operation_id: DECIDE_APPROVAL_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "approvals",
    title: "Decide approval",
    description: "Append an approved, rejected, or changes-requested decision; the request stays pending until its immutable decision policy resolves.",
    effects: { mode: "write", reversibility: "irreversible", external: false, secret_access: "none" },
    required_grants: [DECIDE_APPROVAL_OPERATION_ID],
    interaction_constraints: { allowed_modes: interactionModes },
    // Individual decisions append concurrently. The immutable request action,
    // policy, and current authority are revalidated by the Bus; a mutable
    // request-state revision would incorrectly make concurrent votes stale.
    target: { resource_kinds: ["approval_request"], expected_revision: "not_applicable" },
    input: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["decision", "reason"],
        properties: {
          decision: { enum: ["approved", "rejected", "changes_requested"] },
          reason: text,
          receipt_expires_at: timestamp,
          supersedes_decision_id: text,
        },
      },
    },
    result: { version: "3", schema: decisionResultSchema },
    handler: (context, input) => handled(() => {
      const workspaceId = requireWorkspaceAuthorityId(context.authority);
      const request = requireRequestInWorkspace(backend, context.target!.ref.id, workspaceId);
      const result = backend.decideRequest({
        workspace_id: workspaceId,
        approval_request_id: context.target!.ref.id,
        expected_state_revision: request.state_revision,
        decision: input.decision,
        decided_by_principal_id: context.authority.principal_id,
        decision_reason: input.reason,
        ...(input.receipt_expires_at ? { receipt_expires_at: input.receipt_expires_at } : {}),
        ...(input.supersedes_decision_id ? { supersedes_decision_id: input.supersedes_decision_id } : {}),
        operation_invocation_id: context.invocation_id,
      });
      return {
        state: "completed",
        result: { ...result, request: projectRequest(result.request), receipt: projectReceipt(result.receipt) },
        changed_refs: [requestRef(result.request), ...(result.receipt ? [receiptRef(result.receipt)] : [])],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function configureApprovalResponseOperation(
  backend: ApprovalOperationBackend,
): SemanticOperationDefinition<{ response_participant_id: string | null }, { request: ApprovalRequestRecord }> {
  return {
    operation_id: CONFIGURE_APPROVAL_RESPONSE_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "approvals",
    title: "Choose decision response",
    description: "Deliver the resolved decision to an existing participant in this approval's Context. Use null to remove the recipient. Preserves the exact action and approval policy; the recipient decides what to do with the result. Does not execute the approved operation.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [CONFIGURE_APPROVAL_RESPONSE_OPERATION_ID],
    interaction_constraints: { allowed_modes: interactionModes },
    target: { resource_kinds: ["approval_request"], expected_revision: "required" },
    input: { version: "1", schema: { type: "object", additionalProperties: false,
      required: ["response_participant_id"], properties: { response_participant_id: nullableText } } },
    result: { version: "3", schema: { type: "object", additionalProperties: false,
      required: ["request"], properties: { request: approvalRequestSchema } } },
    handler: (context, input) => handled(() => {
      const request = backend.configureResponse({
        workspace_id: requireWorkspaceAuthorityId(context.authority),
        approval_request_id: context.target!.ref.id,
        expected_state_revision: stateRevision(context),
        response_participant_id: input.response_participant_id,
      });
      return { state: "completed", result: { request: projectRequest(request) },
        changed_refs: [requestRef(request)], audit_ref: auditRef(context) };
    }),
  };
}

export function cancelApprovalOperation(
  backend: ApprovalOperationBackend,
): SemanticOperationDefinition<{ reason: string }, { request: ApprovalRequestRecord }> {
  return {
    operation_id: CANCEL_APPROVAL_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "approvals",
    title: "Cancel approval request",
    description: "Cancel a still-pending approval request without erasing its history.",
    effects: { mode: "write", reversibility: "irreversible", external: false, secret_access: "none" },
    required_grants: [CANCEL_APPROVAL_OPERATION_ID],
    interaction_constraints: { allowed_modes: interactionModes },
    target: { resource_kinds: ["approval_request"], expected_revision: "required" },
    input: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["reason"],
        properties: { reason: text },
      },
    },
    result: {
      version: "3",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["request"],
        properties: { request: approvalRequestSchema },
      },
    },
    handler: (context, input) => handled(() => {
      const request = backend.store.cancelRequest({
        workspace_id: requireWorkspaceAuthorityId(context.authority),
        approval_request_id: context.target!.ref.id,
        expected_state_revision: stateRevision(context),
        cancelled_by_principal_id: context.authority.principal_id,
        reason: input.reason,
      });
      return {
        state: "completed",
        result: { request: projectRequest(request) },
        changed_refs: [requestRef(request)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function revokeApprovalReceiptOperation(
  backend: ApprovalOperationBackend,
): SemanticOperationDefinition<{ reason: string }, { receipt: ApprovalReceiptRecord }> {
  return {
    operation_id: REVOKE_APPROVAL_RECEIPT_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "approvals",
    title: "Revoke approval receipt",
    description: "Revoke unused authority for an approved action without rewriting its decision history.",
    effects: { mode: "write", reversibility: "irreversible", external: false, secret_access: "none" },
    required_grants: [REVOKE_APPROVAL_RECEIPT_OPERATION_ID],
    interaction_constraints: { allowed_modes: interactionModes },
    target: { resource_kinds: ["approval_receipt"], expected_revision: "required" },
    input: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["reason"],
        properties: { reason: text },
      },
    },
    result: {
      version: "2",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["receipt"],
        properties: { receipt: approvalReceiptSchema },
      },
    },
    handler: (context, input) => handled(() => {
      const receipt = backend.store.revokeReceipt({
        workspace_id: requireWorkspaceAuthorityId(context.authority),
        approval_receipt_id: context.target!.ref.id,
        revoked_by_principal_id: context.authority.principal_id,
        reason: input.reason,
      });
      return {
        state: "completed",
        result: { receipt: projectReceipt(receipt)! },
        changed_refs: [receiptRef(receipt)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function approvalOperationDefinitions(
  backend: ApprovalOperationBackend,
): Array<SemanticOperationDefinition<any, any>> {
  return [
    listApprovalsOperation(backend),
    inspectApprovalOperation(backend),
    requestApprovalOperation(backend),
    decideApprovalOperation(backend),
    configureApprovalResponseOperation(backend),
    cancelApprovalOperation(backend),
    revokeApprovalReceiptOperation(backend),
  ];
}

export function registerApprovalOperations<T extends SemanticOperationRegistry>(
  registry: T,
  backend: ApprovalOperationBackend,
): T {
  for (const operation of approvalOperationDefinitions(backend)) registry.register(operation);
  return registry;
}
