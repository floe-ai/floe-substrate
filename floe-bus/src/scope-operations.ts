import {
  ScopeCompositionConflictError,
  ScopeCompositionImpactConflictError,
  ScopeCompositionImmutableError,
  ScopeCompositionInvalidError,
  ScopeCompositionNotFoundError,
  type ScopeCompositionContent,
  type ScopeCompositionChangeSet,
  type ScopeCompositionImpact,
  type ScopeCompositionRevision,
  type ScopeCompositionSimulation,
  type ScopeCompositionValidation,
  type PortableScopeComposition,
} from "./scope-compositions.js";
import type {
  NodeExecutionRetryResult,
  NodeExecutionJoinState,
  NodeExecutionRecord,
  ScopeExecutionPauseResult,
  ScopeExecutionResumeResult,
  ScopeExecutionRecord,
} from "./scope-executions.js";
import type { EventEnvelope } from "./store.js";
import {
  refusal,
  requireWorkspaceAuthorityId,
  requiredAction,
  type JsonSchema,
  type OperationAuthorityContext,
  type OperationEvaluationContext,
  type OperationExecutionContext,
  type OperationRefusal,
  type SemanticOperationDefinition,
  type SemanticOperationRegistry,
} from "./operations.js";
import { ScopeAlreadyExistsError, ScopeReservedIdError, type ScopeRecord } from "./scopes/store.js";

function authorityWorkspaceId(context: OperationEvaluationContext): string {
  return requireWorkspaceAuthorityId(context.authority);
}

/**
 * Scope operations are the one semantic surface used by the app, runtime, CLI,
 * and HTTP adapters. Inputs contain intent only. Authenticated authority is
 * supplied separately by the operation registry and can never be impersonated
 * through an input field.
 */

export const CREATE_SCOPE_OPERATION_ID = "scope.create";
export const LIST_SCOPES_OPERATION_ID = "scope.list";
export const CREATE_SCOPE_DRAFT_OPERATION_ID = "scope.composition.draft.create";
export const REPLACE_SCOPE_DRAFT_OPERATION_ID = "scope.composition.draft.replace";
export const PUBLISH_SCOPE_REVISION_OPERATION_ID = "scope.composition.publish";
export const VALIDATE_SCOPE_REVISION_OPERATION_ID = "scope.composition.validate";
export const SIMULATE_SCOPE_REVISION_OPERATION_ID = "scope.composition.simulate";
export const COMPARE_SCOPE_REVISIONS_OPERATION_ID = "scope.composition.compare";
export const INSPECT_SCOPE_REVISION_IMPACT_OPERATION_ID = "scope.composition.impact.inspect";
export const ROLLBACK_SCOPE_REVISION_OPERATION_ID = "scope.composition.rollback";
export const CLONE_SCOPE_REVISION_OPERATION_ID = "scope.composition.clone";
export const EXPORT_SCOPE_REVISION_OPERATION_ID = "scope.composition.export";
export const IMPORT_SCOPE_REVISION_OPERATION_ID = "scope.composition.import";
export const INSPECT_SCOPE_PLAN_OPERATION_ID = "scope.plan.inspect";
export const START_SCOPE_EXECUTION_OPERATION_ID = "scope.execution.start";
export const INSPECT_SCOPE_EXECUTION_OPERATION_ID = "scope.execution.inspect";
export const PUBLISH_SCOPE_OUTPUT_OPERATION_ID = "scope.node-output.publish";
export const STOP_SCOPE_EXECUTION_OPERATION_ID = "scope.execution.stop";
export const PAUSE_SCOPE_EXECUTION_OPERATION_ID = "scope.execution.pause";
export const RESUME_SCOPE_EXECUTION_OPERATION_ID = "scope.execution.resume";
export const RETRY_NODE_EXECUTION_OPERATION_ID = "scope.node-execution.retry";
export const REDO_SCOPE_EXECUTION_OPERATION_ID = "scope.execution.redo";

export const NO_PUBLISHED_SCOPE_REVISION = "none";

export type ScopeRecordForOperations = {
  workspace_id: string;
  scope_id: string;
  status: string;
  published_revision_id?: string | null;
};

export type ScopePlanRevisionRole =
  | "draft"
  | "current_published"
  | "historical_published"
  | "withdrawn_draft";

export type ScopePlanRevision = {
  revision: ScopeCompositionRevision;
  role: ScopePlanRevisionRole;
  pinned_execution_ids: string[];
};

export type ScopePlanInspection = {
  scope_id: string;
  current_published_revision_id: string | null;
  selected_revision_id: string;
  selected_role: ScopePlanRevisionRole;
  history_complete: boolean;
  revisions: ScopePlanRevision[];
};

export type ScopeExecutionNodeInspection = NodeExecutionRecord & {
  resource_ref: { kind: "node_execution"; id: string; revision: string };
  join_state: NodeExecutionJoinState;
  input_delivery_ids: string[];
  attempt_ids: string[];
  publication_ids: string[];
};

export type ScopeExecutionTraversalInspection = {
  publication_id: string;
  edge_id: string;
  delivery_id: string;
  target_node_execution_id: string;
};

export type ScopeExecutionInspection = {
  execution: ScopeExecutionRecord;
  pinned_revision: ScopeCompositionRevision;
  current_published_revision_id: string | null;
  pinned_revision_role: "current_published" | "historical_published";
  node_executions: ScopeExecutionNodeInspection[];
  traversals: ScopeExecutionTraversalInspection[];
  output_publications?: Array<{
    publication_id: string;
    node_execution_id: string;
    port_id: string;
    event_id: string;
    event: EventEnvelope | null;
  }>;
};

export type StartedScopeExecution = {
  execution: ScopeExecutionRecord;
  root_event_id: string;
  publication_id: string;
  delivery_ids: string[];
};

export type PublishedScopeOutput = {
  execution: ScopeExecutionRecord;
  node_execution: NodeExecutionRecord;
  event_id: string;
  publication_id: string;
  delivery_ids: string[];
};

export type ScopeExecutionStopResult = {
  execution: ScopeExecutionRecord;
  stopped: {
    pending_deliveries: number;
    active_deliveries: number;
    node_executions: number;
    workers: number;
    callbacks: number;
    connector_actions: number;
  };
  uncertain_external_effects: Array<{
    kind: string;
    id: string;
    detail: string;
  }>;
};

export type RedoScopeExecutionResult = StartedScopeExecution;

export type ScopeOperationCall = {
  authority: OperationAuthorityContext;
  /** Derived from trusted invocation provenance; never accepted in operation input. */
  cause_event_id: string | null;
  origin_scope_execution_id?: string | null;
  origin_node_execution_id?: string | null;
  invocation_id: string;
  idempotency_key: string;
  expected_resource_revision: string | null;
};

/**
 * Store-facing seam. It names semantic actions, not transport routes. The Bus
 * implementation remains responsible for transactions, routing, cancellation,
 * and audit persistence.
 */
export interface ScopeOperationBackend {
  createScope(input: { workspace_id: string; scope_id?: string; title: string; description?: string | null; call: ScopeOperationCall }): ScopeRecord;
  listScopes(workspaceId: string): ScopeRecord[];
  getScope(workspaceId: string, scopeId: string): ScopeRecordForOperations | null;
  getRevision(revisionId: string): ScopeCompositionRevision | null;
  getPublishedRevision(workspaceId: string, scopeId: string): ScopeCompositionRevision | null;
  listRevisions(workspaceId: string, scopeId: string): ScopeCompositionRevision[];
  listExecutions(workspaceId: string, scopeId: string): ScopeExecutionRecord[];
  getExecution(executionId: string): ScopeExecutionRecord | null;
  getNodeExecution(nodeExecutionId: string): NodeExecutionRecord | null;
  createDraft(input: {
    workspace_id: string;
    scope_id: string;
    based_on_revision_id: string | null;
    content: ScopeCompositionContent;
    call: ScopeOperationCall;
  }): ScopeCompositionRevision;
  replaceDraft(input: {
    revision_id: string;
    content: ScopeCompositionContent;
    expected_digest: string;
    call: ScopeOperationCall;
  }): ScopeCompositionRevision;
  validateRevision(input: {
    revision_id: string;
    call: ScopeOperationCall;
  }): { revision: ScopeCompositionRevision; validation: ScopeCompositionValidation };
  simulateRevision(input: {
    revision_id: string;
    ingress_node_id: string;
    output_port_id: string;
    call: ScopeOperationCall;
  }): ScopeCompositionSimulation;
  compareRevisions(input: {
    from_revision_id: string;
    to_revision_id: string;
    call: ScopeOperationCall;
  }): ScopeCompositionChangeSet;
  inspectRevisionImpact(input: {
    revision_id: string;
    call: ScopeOperationCall;
  }): ScopeCompositionImpact;
  publishRevision(input: {
    revision_id: string;
    expected_digest: string;
    expected_current_published_revision_id: string | null;
    expected_impact_digest: string;
    call: ScopeOperationCall;
  }): ScopeCompositionRevision;
  rollbackRevision(input: {
    target_revision_id: string;
    expected_digest: string;
    expected_current_published_revision_id: string;
    expected_impact_digest: string;
    call: ScopeOperationCall;
  }): ScopeCompositionRevision;
  cloneRevision(input: {
    source_revision_id: string;
    target_scope_id: string;
    call: ScopeOperationCall;
  }): ScopeCompositionRevision;
  exportRevision(input: {
    revision_id: string;
    call: ScopeOperationCall;
  }): PortableScopeComposition;
  importRevision(input: {
    target_workspace_id: string;
    target_scope_id: string;
    portable: PortableScopeComposition;
    call: ScopeOperationCall;
  }): ScopeCompositionRevision;
  inspectPlan(input: {
    workspace_id: string;
    scope_id: string;
    selected_revision_id: string | null;
    include_history: boolean;
    call: ScopeOperationCall;
  }): ScopePlanInspection;
  startExecution(input: {
    workspace_id: string;
    scope_id: string;
    expected_published_revision_id: string;
    ingress_node_id: string;
    output_port_id: string;
    content: Record<string, unknown>;
    artefact_version_ids: string[];
    correlation_id: string | null;
    cause_event_id: string | null;
    call: ScopeOperationCall;
  }): StartedScopeExecution;
  inspectExecution(input: {
    workspace_id: string;
    execution_id: string;
    include_outputs?: boolean;
    call: ScopeOperationCall;
  }): ScopeExecutionInspection;
  publishNodeOutput(input: {
    workspace_id: string;
    node_execution_id: string;
    port_id: string;
    event_type: string | null;
    content: Record<string, unknown>;
    lifecycle_outcome: "completed" | "waiting" | "failed";
    artefact_version_ids: string[];
    call: ScopeOperationCall;
  }): PublishedScopeOutput;
  stopExecution(input: {
    workspace_id: string;
    execution_id: string;
    reason: string | null;
    call: ScopeOperationCall;
  }): ScopeExecutionStopResult;
  pauseExecution(input: {
    workspace_id: string;
    execution_id: string;
    reason: string | null;
    call: ScopeOperationCall;
  }): ScopeExecutionPauseResult;
  resumeExecution(input: {
    workspace_id: string;
    execution_id: string;
    reason: string | null;
    call: ScopeOperationCall;
  }): ScopeExecutionResumeResult;
  retryNodeExecution(input: {
    workspace_id: string;
    node_execution_id: string;
    call: ScopeOperationCall;
  }): NodeExecutionRetryResult;
  redoExecution(input: {
    workspace_id: string;
    redo_of_node_execution_id: string;
    revision_selection: "pinned" | "current_published";
    ingress_node_id: string;
    output_port_id: string;
    content: Record<string, unknown>;
    artefact_version_ids: string[];
    correlation_id: string | null;
    cause_event_id: string | null;
    call: ScopeOperationCall;
  }): RedoScopeExecutionResult;
}

export class ScopeOperationRefusalError extends Error {
  constructor(readonly refusal: OperationRefusal) {
    super(refusal.message);
    this.name = "ScopeOperationRefusalError";
  }
}

const nonEmptyString: JsonSchema = { type: "string", minLength: 1 };
const nullableString: JsonSchema = { oneOf: [nonEmptyString, { type: "null" }] };
const stringArray: JsonSchema = { type: "array", items: nonEmptyString };
const recordSchema: JsonSchema = { type: "object" };
const stoppableScopeExecutionStatuses = new Set<ScopeExecutionRecord["status"]>([
  "queued",
  "active",
  "waiting_external",
  "paused",
  "blocked",
]);

const eventContentSelectorSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["source", "path"],
  properties: {
    source: { const: "event_content" },
    path: nonEmptyString,
  },
};

const memberKeySelectorSchema: JsonSchema = {
  oneOf: [
    eventContentSelectorSchema,
    {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: { source: { const: "publication_member_key" } },
    },
  ],
};

const expectedMembershipPolicySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "collection_port_id", "member_port_id", "member_key", "match"],
  properties: {
    mode: { const: "from_collection" },
    collection_port_id: nonEmptyString,
    member_port_id: nonEmptyString,
    member_key: memberKeySelectorSchema,
    match: { enum: ["member_key", "member_key_and_version"] },
  },
};

const activationPolicySchema: JsonSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: { mode: { const: "per_delivery" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: { mode: { const: "all_required_ports" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["mode", "join_key"],
      properties: {
        mode: { const: "keyed_gather" },
        join_key: eventContentSelectorSchema,
        expected_members: expectedMembershipPolicySchema,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["mode", "graph_id"],
      properties: {
        mode: { const: "legacy_subscription" },
        graph_id: nonEmptyString,
      },
    },
  ],
};

const contextPolicySchema: JsonSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: { mode: { const: "new_per_execution" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["mode", "key_template"],
      properties: {
        mode: { const: "reuse_by_key" },
        key_template: nonEmptyString,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["mode", "context_id"],
      properties: {
        mode: { const: "fixed" },
        context_id: { ...nonEmptyString, description: "An active Context with available content in this same Workspace and Scope. An outside conversation cannot be the execution Context; communicate the result to that conversation separately." },
      },
    },
  ],
};

const nodeSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["node_id", "kind"],
  properties: {
    node_id: nonEmptyString,
    kind: { enum: ["event", "actor", "command", "context", "scope", "capability", "connector"] },
    label: nonEmptyString,
    resource_id: nullableString,
    config: {
      ...recordSchema,
      description: "Kind-owned configuration. Actor placement instructions belong in bindings; config.instructions is not injected into runtime instructions.",
    },
    bindings: {
      type: "array",
      description: "Ordered material for this placement. An instructions binding injects its text after the pinned Actor definition's instructions. Put placement-specific responsibilities and return Context references here.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "text"],
        properties: {
          kind: { const: "instructions" },
          text: { type: "string", description: "Instruction text applied to this placement's runtime turn." },
        },
      },
    },
    capability_grant_ids: stringArray,
    activation: activationPolicySchema,
    context_policy: contextPolicySchema,
  },
};

const portSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["port_id", "node_id", "name", "direction"],
  properties: {
    port_id: nonEmptyString,
    node_id: nonEmptyString,
    name: nonEmptyString,
    direction: { enum: ["input", "output"] },
    event_types: stringArray,
    artefact_types: stringArray,
    schema_ref: nullableString,
    min_count: { type: "integer", minimum: 0 },
    max_count: { oneOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
  },
};

const edgeSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["edge_id", "source_port_id", "target_port_id"],
  properties: {
    edge_id: nonEmptyString,
    source_port_id: nonEmptyString,
    target_port_id: nonEmptyString,
    enabled: { type: "boolean" },
    priority: { type: "integer" },
    policy: recordSchema,
  },
};

export const SCOPE_COMPOSITION_CONTENT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["nodes", "ports", "edges"],
  properties: {
    nodes: { type: "array", minItems: 1, items: nodeSchema },
    ports: { type: "array", items: portSchema },
    edges: { type: "array", items: edgeSchema },
  },
};

const compositionRevisionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "revision_id", "workspace_id", "scope_id", "revision_number", "routing_mode",
    "based_on_revision_id", "semantic_digest", "created_by_endpoint_id", "created_at",
    "published_at", "withdrawn_at", "nodes", "ports", "edges",
  ],
  properties: {
    revision_id: nonEmptyString,
    workspace_id: nonEmptyString,
    scope_id: nonEmptyString,
    revision_number: { type: "integer", minimum: 1 },
    routing_mode: { enum: ["edge", "legacy_subscription"] },
    based_on_revision_id: nullableString,
    semantic_digest: nonEmptyString,
    created_by_endpoint_id: nullableString,
    created_at: nonEmptyString,
    published_at: nullableString,
    withdrawn_at: nullableString,
    nodes: { type: "array", minItems: 1, items: nodeSchema },
    ports: { type: "array", items: portSchema },
    edges: { type: "array", items: edgeSchema },
  },
};

const validationSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["valid", "semantic_digest", "diagnostics"],
  properties: {
    valid: { type: "boolean" },
    semantic_digest: nullableString,
    diagnostics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "code", "message", "resource_ids"],
        properties: {
          severity: { enum: ["error", "warning"] },
          code: nonEmptyString,
          message: nonEmptyString,
          resource_ids: stringArray,
        },
      },
    },
  },
};

const idChangeSetSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["added", "removed", "changed"],
  properties: { added: stringArray, removed: stringArray, changed: stringArray },
};

const compositionChangeSetSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "from_revision_id", "to_revision_id", "from_semantic_digest", "to_semantic_digest",
    "nodes", "ports", "edges",
  ],
  properties: {
    from_revision_id: nullableString,
    to_revision_id: nonEmptyString,
    from_semantic_digest: nullableString,
    to_semantic_digest: nonEmptyString,
    nodes: idChangeSetSchema,
    ports: idChangeSetSchema,
    edges: idChangeSetSchema,
  },
};

const compositionImpactSchema: JsonSchema = {
  ...compositionChangeSetSchema,
  required: [
    ...(compositionChangeSetSchema.required as string[]),
    "impact_digest", "active_execution_ids_pinned_to_current",
    "active_execution_ids_pinned_to_target",
  ],
  properties: {
    ...(compositionChangeSetSchema.properties as Record<string, unknown>),
    impact_digest: nonEmptyString,
    active_execution_ids_pinned_to_current: stringArray,
    active_execution_ids_pinned_to_target: stringArray,
  },
};

const portableCompositionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["format", "format_version", "source", "routing_mode", "semantic_digest", "content"],
  properties: {
    format: { const: "floe.scope-composition" },
    format_version: { const: 1 },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["workspace_id", "scope_id", "revision_id", "revision_number"],
      properties: {
        workspace_id: nonEmptyString,
        scope_id: nonEmptyString,
        revision_id: nonEmptyString,
        revision_number: { type: "integer", minimum: 1 },
      },
    },
    routing_mode: { enum: ["edge", "legacy_subscription"] },
    semantic_digest: nonEmptyString,
    content: SCOPE_COMPOSITION_CONTENT_SCHEMA,
  },
};

const scopeExecutionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "execution_id", "workspace_id", "scope_id", "revision_id", "cause_event_id", "root_event_id",
    "ingress_node_id", "ingress_port_id", "initiator_endpoint_id", "idempotency_key",
    "parent_execution_id", "redo_of_node_execution_id", "state_revision", "status", "environment", "budget",
    "terminal", "created_at", "started_at", "completed_at", "cancelled_at",
  ],
  properties: {
    execution_id: nonEmptyString,
    workspace_id: nonEmptyString,
    scope_id: nonEmptyString,
    revision_id: nonEmptyString,
    cause_event_id: nullableString,
    root_event_id: nullableString,
    ingress_node_id: nonEmptyString,
    ingress_port_id: nonEmptyString,
    initiator_endpoint_id: nullableString,
    idempotency_key: nullableString,
    parent_execution_id: nullableString,
    redo_of_node_execution_id: nullableString,
    state_revision: { type: "integer", minimum: 1 },
    status: {
      enum: [
        "queued", "active", "waiting_external", "paused",
        "blocked", "completed", "failed", "cancelled", "superseded",
      ],
    },
    environment: recordSchema,
    budget: recordSchema,
    terminal: recordSchema,
    created_at: nonEmptyString,
    started_at: nullableString,
    completed_at: nullableString,
    cancelled_at: nullableString,
  },
};

const nodeExecutionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "node_execution_id", "execution_id", "revision_id", "node_id", "activation_key", "join_key",
    "context_id", "actor_definition_revision_id", "runtime_profile_revision_id",
    "actor_runtime_binding_id", "command_definition_revision_id", "command_worker_binding_id",
    "state_revision", "status", "assigned_actor_ids", "failure", "created_at",
    "activated_at", "completed_at", "cancelled_at",
  ],
  properties: {
    node_execution_id: nonEmptyString,
    execution_id: nonEmptyString,
    revision_id: nonEmptyString,
    node_id: nonEmptyString,
    activation_key: nonEmptyString,
    join_key: nullableString,
    context_id: nonEmptyString,
    actor_definition_revision_id: nullableString,
    runtime_profile_revision_id: nullableString,
    actor_runtime_binding_id: nullableString,
    command_definition_revision_id: nullableString,
    command_worker_binding_id: nullableString,
    state_revision: { type: "integer", minimum: 1 },
    status: {
      enum: [
        "collecting", "ready", "active", "waiting_external", "paused", "retrying", "blocked", "completed", "failed", "cancelled", "superseded",
      ],
    },
    assigned_actor_ids: stringArray,
    failure: recordSchema,
    created_at: nonEmptyString,
    activated_at: nullableString,
    completed_at: nullableString,
    cancelled_at: nullableString,
  },
};

const nodeExecutionInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "input_id", "node_execution_id", "port_id", "delivery_id", "event_id",
    "artefact_version_id", "member_key", "input_identity", "state",
    "supersedes_input_id", "reason", "accepted_at",
  ],
  properties: {
    input_id: nonEmptyString,
    node_execution_id: nonEmptyString,
    port_id: nonEmptyString,
    delivery_id: nonEmptyString,
    event_id: nonEmptyString,
    artefact_version_id: nullableString,
    member_key: { type: "string" },
    input_identity: nonEmptyString,
    state: { enum: ["received", "late", "superseded"] },
    supersedes_input_id: nullableString,
    reason: recordSchema,
    accepted_at: nonEmptyString,
  },
};

const nodeExecutionExpectationSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "expectation_id", "node_execution_id", "port_id", "expectation_kind",
    "expectation_key", "member_key", "expected_artefact_version_id",
    "source_artefact_version_id", "match_policy", "state", "reason",
    "created_at", "updated_at",
  ],
  properties: {
    expectation_id: nonEmptyString,
    node_execution_id: nonEmptyString,
    port_id: nonEmptyString,
    expectation_kind: { enum: ["required_port", "collection_member"] },
    expectation_key: nonEmptyString,
    member_key: nullableString,
    expected_artefact_version_id: nullableString,
    source_artefact_version_id: nullableString,
    match_policy: { enum: ["cardinality", "member_key", "member_key_and_version"] },
    state: { enum: ["expected", "failed", "superseded"] },
    reason: recordSchema,
    created_at: nonEmptyString,
    updated_at: nonEmptyString,
  },
};

const nodeExecutionMembershipSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "membership_id", "node_execution_id", "collection_port_id", "member_port_id",
    "collection_artefact_version_id", "match_policy", "state", "created_at", "superseded_at",
  ],
  properties: {
    membership_id: nonEmptyString,
    node_execution_id: nonEmptyString,
    collection_port_id: nonEmptyString,
    member_port_id: nonEmptyString,
    collection_artefact_version_id: nonEmptyString,
    match_policy: { enum: ["member_key", "member_key_and_version"] },
    state: { enum: ["active", "superseded"] },
    created_at: nonEmptyString,
    superseded_at: nullableString,
  },
};

const nodeExecutionJoinStateSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["received", "expected", "missing", "failed", "late", "superseded", "memberships", "ready"],
  properties: {
    received: { type: "array", items: nodeExecutionInputSchema },
    expected: { type: "array", items: nodeExecutionExpectationSchema },
    missing: { type: "array", items: nodeExecutionExpectationSchema },
    failed: { type: "array", items: nodeExecutionExpectationSchema },
    late: { type: "array", items: nodeExecutionInputSchema },
    superseded: {
      type: "object",
      additionalProperties: false,
      required: ["inputs", "expectations", "memberships"],
      properties: {
        inputs: { type: "array", items: nodeExecutionInputSchema },
        expectations: { type: "array", items: nodeExecutionExpectationSchema },
        memberships: { type: "array", items: nodeExecutionMembershipSchema },
      },
    },
    memberships: { type: "array", items: nodeExecutionMembershipSchema },
    ready: { type: "boolean" },
  },
};

const revisionResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["revision"],
  properties: { revision: compositionRevisionSchema },
};

const validationResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["revision", "validation"],
  properties: { revision: compositionRevisionSchema, validation: validationSchema },
};

const simulationResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "revision_id", "semantic_digest", "ingress_node_id", "output_port_id",
    "reachable_node_ids", "reachable_edge_ids", "unreachable_node_ids",
    "terminal_output_port_ids", "steps", "diagnostics",
  ],
  properties: {
    revision_id: nonEmptyString,
    semantic_digest: nonEmptyString,
    ingress_node_id: nonEmptyString,
    output_port_id: nonEmptyString,
    reachable_node_ids: stringArray,
    reachable_edge_ids: stringArray,
    unreachable_node_ids: stringArray,
    terminal_output_port_ids: stringArray,
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "depth", "edge_id", "source_node_id", "source_port_id",
          "target_node_id", "target_port_id", "activation", "context_policy",
        ],
        properties: {
          depth: { type: "integer", minimum: 1 },
          edge_id: nonEmptyString,
          source_node_id: nonEmptyString,
          source_port_id: nonEmptyString,
          target_node_id: nonEmptyString,
          target_port_id: nonEmptyString,
          activation: { oneOf: [activationPolicySchema, { type: "null" }] },
          context_policy: { oneOf: [contextPolicySchema, { type: "null" }] },
        },
      },
    },
    diagnostics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "code", "message", "resource_ids"],
        properties: {
          severity: { const: "warning" },
          code: nonEmptyString,
          message: nonEmptyString,
          resource_ids: stringArray,
        },
      },
    },
  },
};

export const CREATE_SCOPE_DRAFT_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["content"],
  properties: {
    based_on_revision_id: nullableString,
    content: SCOPE_COMPOSITION_CONTENT_SCHEMA,
  },
};

export const REPLACE_SCOPE_DRAFT_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["content"],
  properties: { content: SCOPE_COMPOSITION_CONTENT_SCHEMA },
};

export const PUBLISH_SCOPE_REVISION_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expected_current_published_revision_id", "expected_impact_digest"],
  properties: {
    expected_current_published_revision_id: nullableString,
    expected_impact_digest: nonEmptyString,
  },
};

export const VALIDATE_SCOPE_REVISION_INPUT_SCHEMA: JsonSchema = {
  type: "object", additionalProperties: false, properties: {},
};

export const SIMULATE_SCOPE_REVISION_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ingress_node_id", "output_port_id"],
  properties: { ingress_node_id: nonEmptyString, output_port_id: nonEmptyString },
};

export const COMPARE_SCOPE_REVISIONS_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["from_revision_id"],
  properties: { from_revision_id: nonEmptyString },
};

export const INSPECT_SCOPE_REVISION_IMPACT_INPUT_SCHEMA: JsonSchema = {
  type: "object", additionalProperties: false, properties: {},
};

export const ROLLBACK_SCOPE_REVISION_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expected_current_published_revision_id", "expected_impact_digest"],
  properties: {
    expected_current_published_revision_id: nonEmptyString,
    expected_impact_digest: nonEmptyString,
  },
};

export const CLONE_SCOPE_REVISION_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["target_scope_id"],
  properties: { target_scope_id: nonEmptyString },
};

export const EXPORT_SCOPE_REVISION_INPUT_SCHEMA: JsonSchema = {
  type: "object", additionalProperties: false, properties: {},
};

export const IMPORT_SCOPE_REVISION_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["portable"],
  properties: { portable: portableCompositionSchema },
};

export const INSPECT_SCOPE_PLAN_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    selected_revision_id: nonEmptyString,
    include_history: { type: "boolean" },
  },
};

export const START_SCOPE_EXECUTION_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ingress_node_id", "output_port_id", "content"],
  properties: {
    ingress_node_id: nonEmptyString,
    output_port_id: nonEmptyString,
    content: recordSchema,
    artefact_version_ids: stringArray,
    correlation_id: nullableString,
  },
};

export const INSPECT_SCOPE_EXECUTION_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    include_outputs: {
      type: "boolean",
      description: "Read the recorded output Events and exact attached ArtefactVersions, including saved verdicts. Omitted by default; request them to verify results without repeating the work or asking a collaborator to report them again.",
    },
  },
};

export const PUBLISH_SCOPE_OUTPUT_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["port_id", "content", "lifecycle_outcome"],
  properties: {
    port_id: nonEmptyString,
    event_type: nonEmptyString,
    content: recordSchema,
    lifecycle_outcome: {
      enum: ["completed", "waiting", "failed"],
      description: "State of this NodeExecution after publishing: completed means its assigned work is finished; waiting means this same node still needs later input to finish; failed means its work failed. This state does not grant approval for any other action. Put the business verdict and any separate unresolved decisions in content.",
    },
    artefact_version_ids: stringArray,
  },
};

export const STOP_SCOPE_EXECUTION_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { reason: nonEmptyString },
};

export const PAUSE_SCOPE_EXECUTION_INPUT_SCHEMA = STOP_SCOPE_EXECUTION_INPUT_SCHEMA;
export const RESUME_SCOPE_EXECUTION_INPUT_SCHEMA = STOP_SCOPE_EXECUTION_INPUT_SCHEMA;

export const RETRY_NODE_EXECUTION_INPUT_SCHEMA: JsonSchema = {
  type: "object", additionalProperties: false, properties: {},
};

export const REDO_SCOPE_EXECUTION_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["revision_selection", "ingress_node_id", "output_port_id", "content"],
  properties: {
    revision_selection: { enum: ["pinned", "current_published"] },
    ingress_node_id: nonEmptyString,
    output_port_id: nonEmptyString,
    content: recordSchema,
    artefact_version_ids: stringArray,
    correlation_id: nullableString,
  },
};

const startedExecutionResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["execution", "root_event_id", "publication_id", "delivery_ids"],
  properties: {
    execution: scopeExecutionSchema,
    root_event_id: nonEmptyString,
    publication_id: nonEmptyString,
    delivery_ids: stringArray,
  },
};

const publishedOutputResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["execution", "node_execution", "event_id", "publication_id", "delivery_ids"],
  properties: {
    execution: scopeExecutionSchema,
    node_execution: nodeExecutionSchema,
    event_id: nonEmptyString,
    publication_id: nonEmptyString,
    delivery_ids: stringArray,
  },
};

const planInspectionResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "scope_id", "current_published_revision_id", "selected_revision_id",
    "selected_role", "history_complete", "revisions",
  ],
  properties: {
    scope_id: nonEmptyString,
    current_published_revision_id: nullableString,
    selected_revision_id: nonEmptyString,
    selected_role: { enum: ["draft", "current_published", "historical_published", "withdrawn_draft"] },
    history_complete: { type: "boolean" },
    revisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["revision", "role", "pinned_execution_ids"],
        properties: {
          revision: compositionRevisionSchema,
          role: { enum: ["draft", "current_published", "historical_published", "withdrawn_draft"] },
          pinned_execution_ids: stringArray,
        },
      },
    },
  },
};

const nodeInspectionSchema: JsonSchema = {
  ...nodeExecutionSchema,
  required: [
    ...(nodeExecutionSchema.required as string[]),
    "resource_ref", "join_state", "input_delivery_ids", "attempt_ids", "publication_ids",
  ],
  properties: {
    ...(nodeExecutionSchema.properties as Record<string, unknown>),
    resource_ref: {
      type: "object", additionalProperties: false, required: ["kind", "id", "revision"],
      properties: { kind: { const: "node_execution" }, id: nonEmptyString, revision: nonEmptyString },
    },
    join_state: nodeExecutionJoinStateSchema,
    input_delivery_ids: stringArray,
    attempt_ids: stringArray,
    publication_ids: stringArray,
  },
};

const executionInspectionResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "execution", "pinned_revision", "current_published_revision_id",
    "pinned_revision_role", "node_executions", "traversals",
  ],
  properties: {
    execution: scopeExecutionSchema,
    pinned_revision: compositionRevisionSchema,
    current_published_revision_id: nullableString,
    pinned_revision_role: { enum: ["current_published", "historical_published"] },
    node_executions: { type: "array", items: nodeInspectionSchema },
    output_publications: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["publication_id", "node_execution_id", "port_id", "event_id", "event"],
        properties: {
          publication_id: nonEmptyString, node_execution_id: nonEmptyString,
          port_id: nonEmptyString, event_id: nonEmptyString,
          event: {
            description: "The exact retained Event; null when its content is unavailable. Ordinary Context messages and outputs from other executions are excluded.",
            oneOf: [
              { type: "null" },
              { type: "object", additionalProperties: true,
                required: ["event_id", "workspace_id", "type", "content", "artefact_version_ids"],
                properties: {
                  event_id: nonEmptyString, workspace_id: nonEmptyString, type: nonEmptyString,
                  content: { type: "object", additionalProperties: true },
                  artefact_version_ids: stringArray,
                },
              },
            ],
          },
        },
      },
    },
    traversals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["publication_id", "edge_id", "delivery_id", "target_node_execution_id"],
        properties: {
          publication_id: nonEmptyString,
          edge_id: nonEmptyString,
          delivery_id: nonEmptyString,
          target_node_execution_id: nonEmptyString,
        },
      },
    },
  },
};

const stopExecutionResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["execution", "stopped", "uncertain_external_effects"],
  properties: {
    execution: scopeExecutionSchema,
    stopped: {
      type: "object",
      additionalProperties: false,
      required: [
        "pending_deliveries", "active_deliveries", "node_executions",
        "workers", "callbacks", "connector_actions",
      ],
      properties: Object.fromEntries([
        "pending_deliveries", "active_deliveries", "node_executions",
        "workers", "callbacks", "connector_actions",
      ].map((name) => [name, { type: "integer", minimum: 0 }])),
    },
    uncertain_external_effects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "id", "detail"],
        properties: { kind: nonEmptyString, id: nonEmptyString, detail: nonEmptyString },
      },
    },
  },
};

const executionControlResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["execution", "pause_id", "node_execution_ids", "delivery_ids"],
  properties: {
    execution: scopeExecutionSchema,
    pause_id: nonEmptyString,
    node_execution_ids: stringArray,
    delivery_ids: stringArray,
  },
};

const executionAttemptSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "attempt_id", "node_execution_id", "ordinal", "delivery_ids", "delivery_id",
    "delivery_bundle_id", "actor_definition_revision_id", "runtime_profile_revision_id",
    "actor_runtime_binding_id", "command_definition_revision_id", "command_worker_binding_id",
    "status", "runtime", "resource_use", "result", "error",
    "created_at", "started_at", "completed_at",
  ],
  properties: {
    attempt_id: nonEmptyString,
    node_execution_id: nonEmptyString,
    ordinal: { type: "integer", minimum: 1 },
    delivery_ids: stringArray,
    delivery_id: nullableString,
    delivery_bundle_id: nullableString,
    actor_definition_revision_id: nullableString,
    runtime_profile_revision_id: nullableString,
    actor_runtime_binding_id: nullableString,
    command_definition_revision_id: nullableString,
    command_worker_binding_id: nullableString,
    status: { enum: ["pending", "running", "completed", "failed", "cancelled", "outcome_unknown"] },
    runtime: recordSchema,
    resource_use: recordSchema,
    result: recordSchema,
    error: recordSchema,
    created_at: nonEmptyString,
    started_at: nullableString,
    completed_at: nullableString,
  },
};

const retryNodeResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["execution", "node_execution", "previous_attempt", "delivery_ids"],
  properties: {
    execution: scopeExecutionSchema,
    node_execution: nodeExecutionSchema,
    previous_attempt: executionAttemptSchema,
    delivery_ids: stringArray,
  },
};

function operationCall(context: OperationExecutionContext): ScopeOperationCall {
  // The registry supplies authenticated provenance, separate from the target.
  const provenance = context.provenance;
  return {
    authority: context.authority,
    cause_event_id: provenance?.cause_event_id ?? null,
    origin_scope_execution_id: provenance?.scope_execution_id ?? null,
    origin_node_execution_id: provenance?.node_execution_id ?? null,
    invocation_id: context.invocation_id,
    idempotency_key: context.idempotency_key,
    expected_resource_revision: context.expected_resource_revision,
  };
}

function auditRef(context: OperationExecutionContext) {
  return { kind: "operation_invocation", id: context.invocation_id, revision: null } as const;
}

function scopeRef(scopeId: string, revisionId: string | null) {
  return { kind: "scope", id: scopeId, revision: revisionId ?? NO_PUBLISHED_SCOPE_REVISION } as const;
}

function draftRef(revision: ScopeCompositionRevision) {
  return { kind: "scope_composition_revision", id: revision.revision_id, revision: revision.semantic_digest } as const;
}

export { scopeExecutionStateRevision, nodeExecutionStateRevision } from "./scope-execution-contract.js";
import { scopeExecutionStateRevision, nodeExecutionStateRevision } from "./scope-execution-contract.js";

function inWorkspace(
  context: OperationEvaluationContext,
  workspaceId: string | undefined,
  missingCode: string,
  noun: string,
) {
  if (workspaceId === authorityWorkspaceId(context)) return { available: true as const };
  return {
    available: false as const,
    refusal: refusal(
      missingCode,
      `This ${noun} is not available in the current Workspace.`,
      false,
      requiredAction("refresh_workspace", "Refresh the Workspace", `Refresh this Workspace and select an available ${noun}.`),
    ),
  };
}

function scopeAvailability(backend: ScopeOperationBackend, context: OperationEvaluationContext) {
  const id = context.target?.ref.id;
  const scope = id ? backend.getScope(authorityWorkspaceId(context), id) : null;
  return inWorkspace(context, scope?.workspace_id, "scope_not_found", "Scope");
}

function revisionAvailability(backend: ScopeOperationBackend, context: OperationEvaluationContext, draftOnly: boolean) {
  const id = context.target?.ref.id;
  const revision = id ? backend.getRevision(id) : null;
  const workspace = inWorkspace(
    context,
    revision?.workspace_id,
    "scope_revision_not_found",
    "Scope composition revision",
  );
  if (!workspace.available || !revision || !draftOnly) return workspace;
  if (!revision.published_at && !revision.withdrawn_at) return workspace;
  return {
    available: false as const,
    refusal: refusal(
      revision.published_at ? "scope_revision_immutable" : "scope_revision_withdrawn",
      revision.published_at
        ? "Published Scope composition revisions are immutable."
        : "This draft has been withdrawn and cannot be changed or published.",
      false,
      requiredAction(
        "create_new_draft",
        "Create a new draft",
        "Create a new revision based on the intended retained revision.",
      ),
    ),
  };
}

function executionAvailability(backend: ScopeOperationBackend, context: OperationEvaluationContext) {
  const id = context.target?.ref.id;
  const execution = id ? backend.getExecution(id) : null;
  return inWorkspace(context, execution?.workspace_id, "scope_execution_not_found", "Scope execution");
}

function nodeExecutionAvailability(backend: ScopeOperationBackend, context: OperationEvaluationContext) {
  const id = context.target?.ref.id;
  const node = id ? backend.getNodeExecution(id) : null;
  const execution = node ? backend.getExecution(node.execution_id) : null;
  return inWorkspace(context, execution?.workspace_id, "node_execution_not_found", "Node execution");
}

function operationRefusal(error: unknown): OperationRefusal {
  if (error instanceof ScopeOperationRefusalError) return error.refusal;
  if (error instanceof ScopeAlreadyExistsError) return refusal("scope_already_exists", error.message, false,
    requiredAction("inspect_scope", "Use the existing Scope", "List Scopes to find the existing work, or choose a different identity."));
  if (error instanceof ScopeReservedIdError) return refusal("scope_id_reserved", error.message, false,
    requiredAction("choose_scope_id", "Choose another Scope identity", "Omit scope_id to let Floe assign one, or choose an unreserved identity."));
  if (error instanceof ScopeCompositionConflictError) {
    return refusal(
      "scope_revision_conflict",
      error.message,
      true,
      requiredAction("refresh_scope_plan", "Refresh the plan", "Inspect the current plan and retry against its exact revision."),
      {
        expected_revision: error.expected_revision_id,
        current_revision: error.actual_revision_id,
      },
    );
  }
  if (error instanceof ScopeCompositionImpactConflictError) {
    return refusal(
      "scope_composition_impact_conflict",
      error.message,
      true,
      requiredAction(
        "inspect_scope_impact",
        "Review current impact",
        "Inspect the current plan impact and approve that exact impact before retrying.",
      ),
      {
        expected_impact_digest: error.expected_impact_digest,
        current_impact_digest: error.actual_impact_digest,
      },
    );
  }
  if (error instanceof ScopeCompositionImmutableError) {
    return refusal(
      "scope_revision_immutable",
      "Published Scope composition revisions are immutable.",
      false,
      requiredAction("create_new_draft", "Create a new draft", "Create a new revision based on the retained published revision."),
    );
  }
  if (error instanceof ScopeCompositionNotFoundError) {
    return refusal(
      "scope_revision_not_found",
      error.message,
      false,
      requiredAction("refresh_scope_plan", "Refresh the plan", "Inspect retained revisions and select an available revision."),
    );
  }
  if (error instanceof ScopeCompositionInvalidError) {
    return refusal(
      "scope_composition_invalid",
      error.message,
      false,
      requiredAction("correct_scope_plan", "Correct the plan", "Use the discovered Port and Edge contract to correct this composition."),
    );
  }
  const coded = error as { code?: unknown; message?: unknown };
  if (typeof coded?.code === "string" && coded.code.startsWith("E_SCOPE")) {
    return refusal(
      coded.code.toLowerCase(),
      typeof coded.message === "string" ? coded.message : "The Scope operation was refused.",
      false,
      requiredAction("inspect_scope", "Inspect current state", "Inspect the current plan and execution before retrying."),
    );
  }
  return refusal(
    "scope_operation_outcome_unknown",
    "Floe could not prove that the Scope operation completed.",
    false,
    requiredAction("inspect_scope", "Inspect current state", "Inspect the plan, execution, and operation receipt before deciding whether a retry is safe."),
  );
}

async function handle<T>(work: () => T | Promise<T>) {
  try {
    return await work();
  } catch (error) {
    return { state: "refused" as const, refusal: operationRefusal(error) };
  }
}

const scopeRecordSchema: JsonSchema = {
  type: "object", additionalProperties: false,
  required: ["workspace_id", "scope_id", "title", "description", "status", "published_revision_id", "created_at", "updated_at"],
  properties: {
    workspace_id: { type: "string" }, scope_id: { type: "string" }, title: { type: "string" },
    description: { type: ["string", "null"] }, status: { enum: ["active", "retired"] },
    published_revision_id: { type: ["string", "null"] }, created_at: { type: "string" }, updated_at: { type: "string" },
  },
};

export function createScopeOperation(backend: ScopeOperationBackend): SemanticOperationDefinition<{
  scope_id?: string; title: string; description?: string | null;
}, { scope: ScopeRecord }> {
  return {
    operation_id: CREATE_SCOPE_OPERATION_ID, operation_version: "1", authority_boundary_kinds: ["workspace"],
    category: "scopes", title: "Create Scope",
    description: "Create a named Scope in this Workspace. It starts without a plan or execution; compose those only when the work needs them.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [CREATE_SCOPE_OPERATION_ID], interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    input: { version: "1", schema: { type: "object", additionalProperties: false, required: ["title"], properties: {
      scope_id: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, description: { type: ["string", "null"] },
    } } },
    result: { version: "1", schema: { type: "object", additionalProperties: false, required: ["scope"], properties: { scope: scopeRecordSchema } } },
    handler: (context, input) => handle(() => {
      const scope = backend.createScope({ ...input, workspace_id: authorityWorkspaceId(context), call: operationCall(context) });
      return { state: "completed" as const, result: { scope }, changed_refs: [{ kind: "scope", id: scope.scope_id }], audit_ref: auditRef(context) };
    }),
  };
}

export function listScopesOperation(backend: ScopeOperationBackend): SemanticOperationDefinition<Record<string, never>, { scopes: ScopeRecord[] }> {
  return {
    operation_id: LIST_SCOPES_OPERATION_ID, operation_version: "1", authority_boundary_kinds: ["workspace"],
    category: "scopes", title: "List Scopes", description: "Find existing Scopes in this Workspace with their identity, status and current plan revision.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [LIST_SCOPES_OPERATION_ID], interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    input: { version: "1", schema: { type: "object", additionalProperties: false } },
    result: { version: "1", schema: { type: "object", additionalProperties: false, required: ["scopes"], properties: { scopes: { type: "array", items: scopeRecordSchema } } } },
    handler: context => handle(() => ({ state: "completed" as const, result: { scopes: backend.listScopes(authorityWorkspaceId(context)) }, audit_ref: auditRef(context) })),
  };
}

export type CreateScopeDraftInput = {
  based_on_revision_id?: string | null;
  content: ScopeCompositionContent;
};

export function createScopeDraftOperation(
  backend: ScopeOperationBackend,
): SemanticOperationDefinition<CreateScopeDraftInput, { revision: ScopeCompositionRevision }> {
  return {
    operation_id: CREATE_SCOPE_DRAFT_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "scope-plan",
    title: "Create Scope plan draft",
    description: "Create an immutable-revision draft from the current or an explicitly selected retained plan.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [CREATE_SCOPE_DRAFT_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["scope"], expected_revision: "required" },
    input: { version: "1", schema: CREATE_SCOPE_DRAFT_INPUT_SCHEMA },
    result: { version: "1", schema: revisionResultSchema },
    availability: (context) => scopeAvailability(backend, context),
    handler: (context, input) => handle(() => {
      const revision = backend.createDraft({
        workspace_id: authorityWorkspaceId(context),
        scope_id: context.target!.ref.id,
        based_on_revision_id: input.based_on_revision_id === undefined
          ? (context.expected_resource_revision === NO_PUBLISHED_SCOPE_REVISION ? null : context.expected_resource_revision)
          : input.based_on_revision_id,
        content: input.content,
        call: operationCall(context),
      });
      return {
        state: "completed" as const,
        result: { revision },
        changed_refs: [scopeRef(revision.scope_id, context.expected_resource_revision), draftRef(revision)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export type ReplaceScopeDraftInput = { content: ScopeCompositionContent };

export function replaceScopeDraftOperation(
  backend: ScopeOperationBackend,
): SemanticOperationDefinition<ReplaceScopeDraftInput, { revision: ScopeCompositionRevision }> {
  return {
    operation_id: REPLACE_SCOPE_DRAFT_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "scope-plan",
    title: "Replace Scope plan draft",
    description: "Replace only an unpublished draft while preserving every published and pinned revision.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [REPLACE_SCOPE_DRAFT_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["scope_composition_revision"], expected_revision: "required" },
    input: { version: "1", schema: REPLACE_SCOPE_DRAFT_INPUT_SCHEMA },
    result: { version: "1", schema: revisionResultSchema },
    availability: (context) => revisionAvailability(backend, context, true),
    handler: (context, input) => handle(() => {
      const revision = backend.replaceDraft({
        revision_id: context.target!.ref.id,
        content: input.content,
        expected_digest: context.expected_resource_revision!,
        call: operationCall(context),
      });
      return {
        state: "completed" as const,
        result: { revision },
        changed_refs: [draftRef(revision)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function validateScopeRevisionOperation(
  backend: ScopeOperationBackend,
): SemanticOperationDefinition<Record<string, never>, {
  revision: ScopeCompositionRevision;
  validation: ScopeCompositionValidation;
}> {
  return {
    operation_id: VALIDATE_SCOPE_REVISION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "scope-plan",
    title: "Validate Scope plan revision",
    description: "Validate an exact draft or retained revision without publishing it or starting work.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [VALIDATE_SCOPE_REVISION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["scope_composition_revision"], expected_revision: "required" },
    input: { version: "1", schema: VALIDATE_SCOPE_REVISION_INPUT_SCHEMA },
    result: { version: "1", schema: validationResultSchema },
    availability: (context) => revisionAvailability(backend, context, false),
    handler: (context) => handle(() => ({
      state: "completed" as const,
      result: backend.validateRevision({
        revision_id: context.target!.ref.id,
        call: operationCall(context),
      }),
      audit_ref: auditRef(context),
    })),
  };
}

export type SimulateScopeRevisionInput = { ingress_node_id: string; output_port_id: string };

export function simulateScopeRevisionOperation(
  backend: ScopeOperationBackend,
): SemanticOperationDefinition<SimulateScopeRevisionInput, ScopeCompositionSimulation> {
  return {
    operation_id: SIMULATE_SCOPE_REVISION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "scope-plan",
    title: "Simulate Scope plan revision",
    description: "Trace deterministic stored Edge reachability from one ingress without creating Events, Deliveries, Contexts, or executions.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [SIMULATE_SCOPE_REVISION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["scope_composition_revision"], expected_revision: "required" },
    input: { version: "1", schema: SIMULATE_SCOPE_REVISION_INPUT_SCHEMA },
    result: { version: "1", schema: simulationResultSchema },
    availability: (context) => revisionAvailability(backend, context, false),
    handler: (context, input) => handle(() => ({
      state: "completed" as const,
      result: backend.simulateRevision({
        revision_id: context.target!.ref.id,
        ingress_node_id: input.ingress_node_id,
        output_port_id: input.output_port_id,
        call: operationCall(context),
      }),
      audit_ref: auditRef(context),
    })),
  };
}

export type CompareScopeRevisionsInput = { from_revision_id: string };

export function compareScopeRevisionsOperation(
  backend: ScopeOperationBackend,
): SemanticOperationDefinition<CompareScopeRevisionsInput, ScopeCompositionChangeSet> {
  return {
    operation_id: COMPARE_SCOPE_REVISIONS_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "scope-plan",
    title: "Compare Scope plan revisions",
    description: "Compare exact stored Nodes, Ports, and Edges between two retained revisions of one Scope.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [COMPARE_SCOPE_REVISIONS_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["scope_composition_revision"], expected_revision: "required" },
    input: { version: "1", schema: COMPARE_SCOPE_REVISIONS_INPUT_SCHEMA },
    result: { version: "1", schema: compositionChangeSetSchema },
    availability: (context) => revisionAvailability(backend, context, false),
    handler: (context, input) => handle(() => ({
      state: "completed" as const,
      result: backend.compareRevisions({
        from_revision_id: input.from_revision_id,
        to_revision_id: context.target!.ref.id,
        call: operationCall(context),
      }),
      audit_ref: auditRef(context),
    })),
  };
}

export function inspectScopeRevisionImpactOperation(
  backend: ScopeOperationBackend,
): SemanticOperationDefinition<Record<string, never>, ScopeCompositionImpact> {
  return {
    operation_id: INSPECT_SCOPE_REVISION_IMPACT_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "scope-plan",
    title: "Inspect Scope plan impact",
    description: "Inspect the exact design change and active revision pins that publishing or rolling back would preserve.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [INSPECT_SCOPE_REVISION_IMPACT_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["scope_composition_revision"], expected_revision: "required" },
    input: { version: "1", schema: INSPECT_SCOPE_REVISION_IMPACT_INPUT_SCHEMA },
    result: { version: "1", schema: compositionImpactSchema },
    availability: (context) => revisionAvailability(backend, context, false),
    handler: (context) => handle(() => ({
      state: "completed" as const,
      result: backend.inspectRevisionImpact({
        revision_id: context.target!.ref.id,
        call: operationCall(context),
      }),
      audit_ref: auditRef(context),
    })),
  };
}

export type PublishScopeRevisionInput = {
  expected_current_published_revision_id: string | null;
  expected_impact_digest: string;
};

export function publishScopeRevisionOperation(
  backend: ScopeOperationBackend,
): SemanticOperationDefinition<PublishScopeRevisionInput, { revision: ScopeCompositionRevision }> {
  return {
    operation_id: PUBLISH_SCOPE_REVISION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "scope-plan",
    title: "Publish Scope plan revision",
    description: "Make one draft the current plan while retaining the previous plan for pinned executions and history.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [PUBLISH_SCOPE_REVISION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["scope_composition_revision"], expected_revision: "required" },
    input: { version: "1", schema: PUBLISH_SCOPE_REVISION_INPUT_SCHEMA },
    result: { version: "1", schema: revisionResultSchema },
    availability: (context) => revisionAvailability(backend, context, true),
    handler: (context, input) => handle(() => {
      const revision = backend.publishRevision({
        revision_id: context.target!.ref.id,
        expected_digest: context.expected_resource_revision!,
        expected_current_published_revision_id: input.expected_current_published_revision_id,
        expected_impact_digest: input.expected_impact_digest,
        call: operationCall(context),
      });
      return {
        state: "completed" as const,
        result: { revision },
        changed_refs: [scopeRef(revision.scope_id, revision.revision_id), draftRef(revision)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export type RollbackScopeRevisionInput = {
  expected_current_published_revision_id: string;
  expected_impact_digest: string;
};

export function rollbackScopeRevisionOperation(
  backend: ScopeOperationBackend,
): SemanticOperationDefinition<RollbackScopeRevisionInput, { revision: ScopeCompositionRevision }> {
  return {
    operation_id: ROLLBACK_SCOPE_REVISION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "scope-plan",
    title: "Roll back Scope plan",
    description: "Make an exact retained published revision current again while active executions remain pinned to their original revision.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [ROLLBACK_SCOPE_REVISION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["scope_composition_revision"], expected_revision: "required" },
    input: { version: "1", schema: ROLLBACK_SCOPE_REVISION_INPUT_SCHEMA },
    result: { version: "1", schema: revisionResultSchema },
    availability: (context) => revisionAvailability(backend, context, false),
    handler: (context, input) => handle(() => {
      const revision = backend.rollbackRevision({
        target_revision_id: context.target!.ref.id,
        expected_digest: context.expected_resource_revision!,
        expected_current_published_revision_id: input.expected_current_published_revision_id,
        expected_impact_digest: input.expected_impact_digest,
        call: operationCall(context),
      });
      return {
        state: "completed" as const,
        result: { revision },
        changed_refs: [scopeRef(revision.scope_id, revision.revision_id)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export type CloneScopeRevisionInput = { target_scope_id: string };

export function cloneScopeRevisionOperation(
  backend: ScopeOperationBackend,
): SemanticOperationDefinition<CloneScopeRevisionInput, { revision: ScopeCompositionRevision }> {
  return {
    operation_id: CLONE_SCOPE_REVISION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "scope-plan",
    title: "Clone Scope plan revision",
    description: "Create a new draft in another Scope from one exact retained revision.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [CLONE_SCOPE_REVISION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["scope_composition_revision"], expected_revision: "required" },
    input: { version: "1", schema: CLONE_SCOPE_REVISION_INPUT_SCHEMA },
    result: { version: "1", schema: revisionResultSchema },
    availability: (context) => revisionAvailability(backend, context, false),
    handler: (context, input) => handle(() => {
      const revision = backend.cloneRevision({
        source_revision_id: context.target!.ref.id,
        target_scope_id: input.target_scope_id,
        call: operationCall(context),
      });
      return {
        state: "completed" as const,
        result: { revision },
        changed_refs: [draftRef(revision)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function exportScopeRevisionOperation(
  backend: ScopeOperationBackend,
): SemanticOperationDefinition<Record<string, never>, PortableScopeComposition> {
  return {
    operation_id: EXPORT_SCOPE_REVISION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "scope-plan",
    title: "Export Scope plan revision",
    description: "Export one exact composition as a reusable portable value without creating a new substrate primitive.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [EXPORT_SCOPE_REVISION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["scope_composition_revision"], expected_revision: "required" },
    input: { version: "1", schema: EXPORT_SCOPE_REVISION_INPUT_SCHEMA },
    result: { version: "1", schema: portableCompositionSchema },
    availability: (context) => revisionAvailability(backend, context, false),
    handler: (context) => handle(() => ({
      state: "completed" as const,
      result: backend.exportRevision({ revision_id: context.target!.ref.id, call: operationCall(context) }),
      audit_ref: auditRef(context),
    })),
  };
}

export type ImportScopeRevisionInput = { portable: PortableScopeComposition };

export function importScopeRevisionOperation(
  backend: ScopeOperationBackend,
): SemanticOperationDefinition<ImportScopeRevisionInput, { revision: ScopeCompositionRevision }> {
  return {
    operation_id: IMPORT_SCOPE_REVISION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "scope-plan",
    title: "Import Scope plan revision",
    description: "Validate a portable composition and create a new draft in the selected Scope.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [IMPORT_SCOPE_REVISION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["scope"], expected_revision: "required" },
    input: { version: "1", schema: IMPORT_SCOPE_REVISION_INPUT_SCHEMA },
    result: { version: "1", schema: revisionResultSchema },
    availability: (context) => scopeAvailability(backend, context),
    handler: (context, input) => handle(() => {
      const revision = backend.importRevision({
        target_workspace_id: authorityWorkspaceId(context),
        target_scope_id: context.target!.ref.id,
        portable: input.portable,
        call: operationCall(context),
      });
      return {
        state: "completed" as const,
        result: { revision },
        changed_refs: [draftRef(revision)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export type InspectScopePlanInput = { selected_revision_id?: string; include_history?: boolean };

export function inspectScopePlanOperation(
  backend: ScopeOperationBackend,
): SemanticOperationDefinition<InspectScopePlanInput, ScopePlanInspection> {
  return {
    operation_id: INSPECT_SCOPE_PLAN_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "scope-plan",
    title: "Inspect Scope plan",
    description: "Inspect the draft, current published, pinned, and historical plan revisions without inferring topology from Context subscriptions.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [INSPECT_SCOPE_PLAN_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["scope"], expected_revision: "not_applicable" },
    input: { version: "1", schema: INSPECT_SCOPE_PLAN_INPUT_SCHEMA },
    result: { version: "1", schema: planInspectionResultSchema },
    availability: (context) => scopeAvailability(backend, context),
    handler: (context, input) => handle(() => ({
      state: "completed" as const,
      result: backend.inspectPlan({
        workspace_id: authorityWorkspaceId(context),
        scope_id: context.target!.ref.id,
        selected_revision_id: input.selected_revision_id ?? null,
        include_history: input.include_history === true,
        call: operationCall(context),
      }),
      audit_ref: auditRef(context),
    })),
  };
}

export type StartScopeExecutionInput = {
  ingress_node_id: string;
  output_port_id: string;
  content: Record<string, unknown>;
  artefact_version_ids?: string[];
  correlation_id?: string | null;
};

export function startScopeExecutionOperation(
  backend: ScopeOperationBackend,
): SemanticOperationDefinition<StartScopeExecutionInput, StartedScopeExecution> {
  return {
    operation_id: START_SCOPE_EXECUTION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "scope-execution",
    title: "Start Scope execution",
    description: "Start work from an Event output Port and pin the current published plan for the whole execution.",
    effects: { mode: "write", reversibility: "irreversible", external: false, secret_access: "none" },
    required_grants: [START_SCOPE_EXECUTION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["scope"], expected_revision: "required" },
    input: { version: "1", schema: START_SCOPE_EXECUTION_INPUT_SCHEMA },
    result: { version: "1", schema: startedExecutionResultSchema },
    availability: (context) => {
      const available = scopeAvailability(backend, context);
      if (!available.available) return available;
      const scopeId = context.target!.ref.id;
      const revision = backend.getPublishedRevision(authorityWorkspaceId(context), scopeId);
      if (revision?.routing_mode === "edge") return { available: true as const };
      return {
        available: false as const,
        refusal: refusal(
          revision ? "scope_plan_uses_legacy_routing" : "scope_plan_not_published",
          revision
            ? "The current Scope plan does not use stored Edges."
            : "This Scope has no current published plan.",
          false,
          requiredAction("publish_edge_plan", "Publish a plan", "Publish a validated Scope composition with explicit stored Ports and Edges."),
        ),
      };
    },
    handler: (context, input) => handle(() => {
      const result = backend.startExecution({
        workspace_id: authorityWorkspaceId(context),
        scope_id: context.target!.ref.id,
        expected_published_revision_id: context.expected_resource_revision!,
        ingress_node_id: input.ingress_node_id,
        output_port_id: input.output_port_id,
        content: input.content,
        artefact_version_ids: input.artefact_version_ids ?? [],
        correlation_id: input.correlation_id ?? null,
        cause_event_id: operationCall(context).cause_event_id,
        call: operationCall(context),
      });
      if (result.execution.revision_id !== context.expected_resource_revision) {
        throw new ScopeOperationRefusalError(refusal(
          "scope_execution_revision_not_pinned",
          "The execution did not pin the exact published revision requested by this operation.",
          false,
          requiredAction("inspect_scope_execution", "Inspect the execution", "Inspect retained execution evidence before starting any replacement work."),
        ));
      }
      return {
        state: "accepted" as const,
        result,
        changed_refs: [
          { kind: "scope_execution", id: result.execution.execution_id, revision: scopeExecutionStateRevision(result.execution) },
          ...result.delivery_ids.map((id) => ({ kind: "delivery", id, revision: null })),
        ],
        progress_ref: { kind: "scope_execution", id: result.execution.execution_id, revision: scopeExecutionStateRevision(result.execution) },
        cancel_ref: stoppableScopeExecutionStatuses.has(result.execution.status)
          ? {
              operation_id: STOP_SCOPE_EXECUTION_OPERATION_ID,
              operation_version: "1",
              target: { kind: "scope_execution", id: result.execution.execution_id },
            }
          : null,
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function inspectScopeExecutionOperation(
  backend: ScopeOperationBackend,
): SemanticOperationDefinition<{ include_outputs?: boolean }, ScopeExecutionInspection> {
  return {
    operation_id: INSPECT_SCOPE_EXECUTION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "scope-execution",
    title: "Inspect Scope execution",
    description: "Inspect an execution through its pinned plan, Node executions, Contexts, attempts, outputs, and exact Edge traversals. Request include_outputs to read saved output Events, verdict content and attached ArtefactVersions. Each Node's resource_ref supplies its exact current revision for mutations; state_revision is only a counter.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [INSPECT_SCOPE_EXECUTION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["scope_execution"], expected_revision: "not_applicable" },
    input: { version: "1", schema: INSPECT_SCOPE_EXECUTION_INPUT_SCHEMA },
    result: { version: "1", schema: executionInspectionResultSchema },
    availability: (context) => executionAvailability(backend, context),
    handler: (context, input) => handle(() => ({
      state: "completed" as const,
      result: backend.inspectExecution({
        workspace_id: authorityWorkspaceId(context),
        execution_id: context.target!.ref.id,
        include_outputs: input.include_outputs,
        call: operationCall(context),
      }),
      audit_ref: auditRef(context),
    })),
  };
}

export type PublishScopeOutputInput = {
  port_id: string;
  event_type?: string;
  content: Record<string, unknown>;
  lifecycle_outcome: "completed" | "waiting" | "failed";
  artefact_version_ids?: string[];
};

export function publishScopeOutputOperation(
  backend: ScopeOperationBackend,
): SemanticOperationDefinition<PublishScopeOutputInput, PublishedScopeOutput> {
  return {
    operation_id: PUBLISH_SCOPE_OUTPUT_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "scope-execution",
    title: "Publish Node output",
    description: "Publish one Node execution output through its pinned output Port and traverse only stored Edges in that revision.",
    effects: { mode: "write", reversibility: "irreversible", external: false, secret_access: "none" },
    required_grants: [PUBLISH_SCOPE_OUTPUT_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended", "brokered"] },
    target: { resource_kinds: ["node_execution"], expected_revision: "required" },
    input: { version: "1", schema: PUBLISH_SCOPE_OUTPUT_INPUT_SCHEMA },
    result: { version: "1", schema: publishedOutputResultSchema },
    availability: (context) => nodeExecutionAvailability(backend, context),
    handler: (context, input) => handle(() => {
      const result = backend.publishNodeOutput({
        workspace_id: authorityWorkspaceId(context),
        node_execution_id: context.target!.ref.id,
        port_id: input.port_id,
        event_type: input.event_type ?? null,
        content: input.content,
        lifecycle_outcome: input.lifecycle_outcome,
        artefact_version_ids: input.artefact_version_ids ?? [],
        call: operationCall(context),
      });
      return {
        state: "completed" as const,
        result,
        changed_refs: [
          { kind: "node_execution", id: result.node_execution.node_execution_id, revision: nodeExecutionStateRevision(result.node_execution) },
          { kind: "scope_execution", id: result.execution.execution_id, revision: scopeExecutionStateRevision(result.execution) },
          { kind: "scope_output_publication", id: result.publication_id, revision: null },
          ...result.delivery_ids.map((id) => ({ kind: "delivery", id, revision: null })),
        ],
        progress_ref: { kind: "scope_execution", id: result.execution.execution_id, revision: scopeExecutionStateRevision(result.execution) },
        cancel_ref: stoppableScopeExecutionStatuses.has(result.execution.status)
          ? {
              operation_id: STOP_SCOPE_EXECUTION_OPERATION_ID,
              operation_version: "1",
              target: { kind: "scope_execution", id: result.execution.execution_id },
            }
          : null,
        audit_ref: auditRef(context),
      };
    }),
  };
}

export type PauseScopeExecutionInput = { reason?: string };

export function pauseScopeExecutionOperation(
  backend: ScopeOperationBackend,
): SemanticOperationDefinition<PauseScopeExecutionInput, ScopeExecutionPauseResult> {
  return {
    operation_id: PAUSE_SCOPE_EXECUTION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "scope-execution",
    title: "Pause Scope execution",
    description: "Pause queued work at a durable scheduling boundary without changing the pinned plan or execution evidence.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [PAUSE_SCOPE_EXECUTION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["scope_execution"], expected_revision: "required" },
    input: { version: "1", schema: PAUSE_SCOPE_EXECUTION_INPUT_SCHEMA },
    result: { version: "1", schema: executionControlResultSchema },
    availability: (context) => {
      const available = executionAvailability(backend, context);
      if (!available.available) return available;
      const execution = backend.getExecution(context.target!.ref.id);
      return execution && ["queued", "active", "waiting_external", "blocked"].includes(execution.status)
        ? { available: true as const }
        : {
            available: false as const,
            refusal: refusal(
              "scope_execution_not_pauseable",
              `This Scope execution is ${execution?.status ?? "unavailable"} and cannot be paused.`,
              false,
              requiredAction("inspect_scope_execution", "Inspect execution", "Inspect its current scheduling and runtime ownership state."),
            ),
          };
    },
    handler: (context, input) => handle(() => {
      const result = backend.pauseExecution({
        workspace_id: authorityWorkspaceId(context),
        execution_id: context.target!.ref.id,
        reason: input.reason ?? null,
        call: operationCall(context),
      });
      return {
        state: "completed" as const,
        result,
        changed_refs: [{
          kind: "scope_execution", id: result.execution.execution_id,
          revision: scopeExecutionStateRevision(result.execution),
        }],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export type ResumeScopeExecutionInput = { reason?: string };

export function resumeScopeExecutionOperation(
  backend: ScopeOperationBackend,
): SemanticOperationDefinition<ResumeScopeExecutionInput, ScopeExecutionResumeResult> {
  return {
    operation_id: RESUME_SCOPE_EXECUTION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "scope-execution",
    title: "Resume Scope execution",
    description: "Resume the exact queued Deliveries and Node states retained by a durable pause.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [RESUME_SCOPE_EXECUTION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["scope_execution"], expected_revision: "required" },
    input: { version: "1", schema: RESUME_SCOPE_EXECUTION_INPUT_SCHEMA },
    result: { version: "1", schema: executionControlResultSchema },
    availability: (context) => {
      const available = executionAvailability(backend, context);
      if (!available.available) return available;
      const execution = backend.getExecution(context.target!.ref.id);
      return execution?.status === "paused"
        ? { available: true as const }
        : {
            available: false as const,
            refusal: refusal(
              "scope_execution_not_paused",
              `This Scope execution is ${execution?.status ?? "unavailable"}, not paused.`,
              false,
              requiredAction("inspect_scope_execution", "Inspect execution", "Inspect its current execution state."),
            ),
          };
    },
    handler: (context, input) => handle(() => {
      const result = backend.resumeExecution({
        workspace_id: authorityWorkspaceId(context),
        execution_id: context.target!.ref.id,
        reason: input.reason ?? null,
        call: operationCall(context),
      });
      return {
        state: "accepted" as const,
        result,
        changed_refs: [{
          kind: "scope_execution", id: result.execution.execution_id,
          revision: scopeExecutionStateRevision(result.execution),
        }],
        progress_ref: {
          kind: "scope_execution", id: result.execution.execution_id,
          revision: scopeExecutionStateRevision(result.execution),
        },
        cancel_ref: {
          operation_id: STOP_SCOPE_EXECUTION_OPERATION_ID,
          operation_version: "1",
          target: { kind: "scope_execution", id: result.execution.execution_id },
        },
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function retryNodeExecutionOperation(
  backend: ScopeOperationBackend,
): SemanticOperationDefinition<Record<string, never>, NodeExecutionRetryResult> {
  return {
    operation_id: RETRY_NODE_EXECUTION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "scope-execution",
    title: "Retry Node execution",
    description: "Retry the same logical Node execution with its exact Context, plan revision, inputs, and Actor/runtime pins.",
    effects: { mode: "write", reversibility: "irreversible", external: false, secret_access: "none" },
    required_grants: [RETRY_NODE_EXECUTION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["node_execution"], expected_revision: "required" },
    input: { version: "1", schema: RETRY_NODE_EXECUTION_INPUT_SCHEMA },
    result: { version: "1", schema: retryNodeResultSchema },
    availability: (context) => {
      const available = nodeExecutionAvailability(backend, context);
      if (!available.available) return available;
      const node = backend.getNodeExecution(context.target!.ref.id);
      return node && (node.status === "failed" || node.status === "blocked")
        ? { available: true as const }
        : {
            available: false as const,
            refusal: refusal(
              "node_execution_not_retryable",
              `This Node execution is ${node?.status ?? "unavailable"} and cannot be retried in place.`,
              false,
              requiredAction("redo_node_execution", "Redo as a new branch", "Create an explicit new execution branch when the logical Node execution cannot be retried."),
            ),
          };
    },
    handler: (context) => handle(() => {
      const result = backend.retryNodeExecution({
        workspace_id: authorityWorkspaceId(context),
        node_execution_id: context.target!.ref.id,
        call: operationCall(context),
      });
      return {
        state: "accepted" as const,
        result,
        changed_refs: [
          {
            kind: "node_execution", id: result.node_execution.node_execution_id,
            revision: nodeExecutionStateRevision(result.node_execution),
          },
          {
            kind: "scope_execution", id: result.execution.execution_id,
            revision: scopeExecutionStateRevision(result.execution),
          },
        ],
        progress_ref: {
          kind: "scope_execution", id: result.execution.execution_id,
          revision: scopeExecutionStateRevision(result.execution),
        },
        audit_ref: auditRef(context),
      };
    }),
  };
}

export type RedoScopeExecutionInput = {
  revision_selection: "pinned" | "current_published";
  ingress_node_id: string;
  output_port_id: string;
  content: Record<string, unknown>;
  artefact_version_ids?: string[];
  correlation_id?: string | null;
};

export function redoScopeExecutionOperation(
  backend: ScopeOperationBackend,
): SemanticOperationDefinition<RedoScopeExecutionInput, RedoScopeExecutionResult> {
  return {
    operation_id: REDO_SCOPE_EXECUTION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "scope-execution",
    title: "Redo Node execution as a new branch",
    description: "Create a new Scope execution branch using either the source execution's pinned plan or the current published plan.",
    effects: { mode: "write", reversibility: "irreversible", external: false, secret_access: "none" },
    required_grants: [REDO_SCOPE_EXECUTION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["node_execution"], expected_revision: "required" },
    input: { version: "1", schema: REDO_SCOPE_EXECUTION_INPUT_SCHEMA },
    result: { version: "1", schema: startedExecutionResultSchema },
    availability: (context) => nodeExecutionAvailability(backend, context),
    handler: (context, input) => handle(() => {
      const result = backend.redoExecution({
        workspace_id: authorityWorkspaceId(context),
        redo_of_node_execution_id: context.target!.ref.id,
        revision_selection: input.revision_selection,
        ingress_node_id: input.ingress_node_id,
        output_port_id: input.output_port_id,
        content: input.content,
        artefact_version_ids: input.artefact_version_ids ?? [],
        correlation_id: input.correlation_id ?? null,
        cause_event_id: operationCall(context).cause_event_id,
        call: operationCall(context),
      });
      return {
        state: "accepted" as const,
        result,
        changed_refs: [
          {
            kind: "scope_execution", id: result.execution.execution_id,
            revision: scopeExecutionStateRevision(result.execution),
          },
          ...result.delivery_ids.map((id) => ({ kind: "delivery", id, revision: null })),
        ],
        progress_ref: {
          kind: "scope_execution", id: result.execution.execution_id,
          revision: scopeExecutionStateRevision(result.execution),
        },
        cancel_ref: stoppableScopeExecutionStatuses.has(result.execution.status)
          ? {
              operation_id: STOP_SCOPE_EXECUTION_OPERATION_ID,
              operation_version: "1",
              target: { kind: "scope_execution", id: result.execution.execution_id },
            }
          : null,
        audit_ref: auditRef(context),
      };
    }),
  };
}

export type StopScopeExecutionInput = { reason?: string };

export function stopScopeExecutionOperation(
  backend: ScopeOperationBackend,
): SemanticOperationDefinition<StopScopeExecutionInput, ScopeExecutionStopResult> {
  return {
    operation_id: STOP_SCOPE_EXECUTION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "scope-execution",
    title: "Stop Scope execution",
    description: "Stop pending and active work while retaining execution evidence and identifying any uncertain external effect.",
    effects: { mode: "write", reversibility: "irreversible", external: true, secret_access: "none" },
    required_grants: [STOP_SCOPE_EXECUTION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["scope_execution"], expected_revision: "required" },
    input: { version: "1", schema: STOP_SCOPE_EXECUTION_INPUT_SCHEMA },
    result: { version: "1", schema: stopExecutionResultSchema },
    availability: (context) => {
      const available = executionAvailability(backend, context);
      if (!available.available) return available;
      const execution = backend.getExecution(context.target!.ref.id);
      if (execution && stoppableScopeExecutionStatuses.has(execution.status)) {
        return { available: true as const };
      }
      return {
        available: false as const,
        refusal: refusal(
          "scope_execution_terminal",
          `This Scope execution is already ${execution?.status ?? "unavailable"}.`,
          false,
          requiredAction("inspect_scope_execution", "Inspect execution", "Open the retained execution evidence."),
        ),
      };
    },
    handler: (context, input) => handle(() => {
      const result = backend.stopExecution({
        workspace_id: authorityWorkspaceId(context),
        execution_id: context.target!.ref.id,
        reason: input.reason ?? null,
        call: operationCall(context),
      });
      return {
        state: "completed" as const,
        result,
        changed_refs: [
          { kind: "scope_execution", id: result.execution.execution_id, revision: scopeExecutionStateRevision(result.execution) },
        ],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function scopeOperationDefinitions(backend: ScopeOperationBackend): SemanticOperationDefinition<any, any>[] {
  return [
    createScopeOperation(backend),
    listScopesOperation(backend),
    createScopeDraftOperation(backend),
    replaceScopeDraftOperation(backend),
    validateScopeRevisionOperation(backend),
    simulateScopeRevisionOperation(backend),
    compareScopeRevisionsOperation(backend),
    inspectScopeRevisionImpactOperation(backend),
    publishScopeRevisionOperation(backend),
    rollbackScopeRevisionOperation(backend),
    cloneScopeRevisionOperation(backend),
    exportScopeRevisionOperation(backend),
    importScopeRevisionOperation(backend),
    inspectScopePlanOperation(backend),
    startScopeExecutionOperation(backend),
    inspectScopeExecutionOperation(backend),
    publishScopeOutputOperation(backend),
    pauseScopeExecutionOperation(backend),
    resumeScopeExecutionOperation(backend),
    retryNodeExecutionOperation(backend),
    redoScopeExecutionOperation(backend),
    stopScopeExecutionOperation(backend),
  ];
}

export function registerScopeOperations<T extends SemanticOperationRegistry>(
  registry: T,
  backend: ScopeOperationBackend,
): T {
  for (const definition of scopeOperationDefinitions(backend)) registry.register(definition);
  return registry;
}
