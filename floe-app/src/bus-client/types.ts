/**
 * Shared substrate types for floe-app.
 *
 * Thin refs mirror wire field names from floe-bus exactly.
 * Do not add derived/computed fields here — those belong in the consuming module.
 */

// ---------------------------------------------------------------------------
// Refs (wire shapes mirroring floe-bus)
// ---------------------------------------------------------------------------

export type WorkspaceRef = {
  workspace_id: string;
  name: string;
  /** Present only in the trusted local-host projection. */
  locator?: string;
  status?: string;
  selected_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type ScopeRef = {
  scope_id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  status: "active" | "retired";
  created_at: string;
  updated_at: string;
};

export type ScopeCompositionEventNode = {
  node_id: string;
  kind: "trigger";
  label?: string;
  event_type: string;
  source?: { kind: "folder"; path: string };
};

export type ScopeCompositionActorNode = {
  node_id: string;
  kind: "actor";
  label?: string;
  endpoint_id: string;
  event_types?: string[];
  bindings?: Array<{ kind: "instructions"; text: string }>;
};

export type ScopeCompositionCommandInput = {
  name: string;
  content_key: string;
  required?: boolean;
};

export type ScopeCompositionCommandOutput = {
  name: string;
  from: "exit_code" | "passed" | "stdout" | "stderr";
};

export type ScopeCompositionCommandNode = {
  node_id: string;
  kind: "command";
  label?: string;
  endpoint_id: string;
  event_types?: string[];
  result_event_type?: string;
  command: string;
  inputs?: ScopeCompositionCommandInput[];
  outputs?: ScopeCompositionCommandOutput[];
};

export type ScopeCompositionNode =
  | ScopeCompositionEventNode
  | ScopeCompositionActorNode
  | ScopeCompositionCommandNode;

export type ScopeComposition = {
  graph_id: string;
  workspace_id: string;
  scope_id: string;
  context_id: string;
  nodes: ScopeCompositionNode[];
  created_at: string;
  updated_at: string;
};

// ---------------------------------------------------------------------------
// Canonical Scope plans and executions
// ---------------------------------------------------------------------------

export type ScopeCompositionRoutingMode = "edge" | "legacy_subscription";

export type ScopeNodePlacement = {
  node_id: string;
  kind: "event" | "actor" | "command" | "context" | "scope" | "capability" | "connector";
  label?: string;
  resource_id?: string | null;
  config?: Record<string, unknown>;
  bindings?: Array<Record<string, unknown>>;
  activation?: Record<string, unknown>;
  context_policy?: Record<string, unknown>;
};

export type ScopePort = {
  port_id: string;
  node_id: string;
  name: string;
  direction: "input" | "output";
  event_types?: string[];
  artefact_types?: string[];
  schema_ref?: string | null;
  min_count?: number;
  max_count?: number | null;
};

export type ScopeEdge = {
  edge_id: string;
  source_port_id: string;
  target_port_id: string;
  enabled?: boolean;
  priority?: number;
  policy?: Record<string, unknown>;
};

export type ScopeCompositionRevision = {
  revision_id: string;
  workspace_id: string;
  scope_id: string;
  revision_number: number;
  routing_mode: ScopeCompositionRoutingMode;
  based_on_revision_id: string | null;
  semantic_digest: string;
  created_by_endpoint_id: string | null;
  created_at: string;
  published_at: string | null;
  withdrawn_at: string | null;
  nodes: ScopeNodePlacement[];
  ports: ScopePort[];
  edges: ScopeEdge[];
};

import type { ScopeExecutionStatus, NodeExecutionStatus } from "../../../floe-bus/src/scope-execution-contract.ts";
export type { ScopeExecutionStatus, NodeExecutionStatus } from "../../../floe-bus/src/scope-execution-contract.ts";
export type ExecutionAttemptStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "outcome_unknown";

export type ScopeExecutionRecord = {
  state_revision: number;
  execution_id: string;
  workspace_id: string;
  scope_id: string;
  revision_id: string;
  cause_event_id: string | null;
  root_event_id: string | null;
  ingress_node_id: string;
  ingress_port_id: string;
  initiator_endpoint_id: string | null;
  idempotency_key: string | null;
  parent_execution_id: string | null;
  redo_of_node_execution_id: string | null;
  status: ScopeExecutionStatus;
  environment: Record<string, unknown>;
  budget: Record<string, unknown>;
  terminal: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
};

export type NodeExecutionInputRecord = {
  input_id: string;
  node_execution_id: string;
  port_id: string;
  delivery_id: string;
  event_id: string;
  artefact_version_id: string | null;
  member_key: string;
  accepted_at: string;
};

export type ExecutionAttemptRecord = {
  attempt_id: string;
  node_execution_id: string;
  ordinal: number;
  delivery_ids: string[];
  delivery_id: string | null;
  delivery_bundle_id: string | null;
  status: ExecutionAttemptStatus;
  runtime: Record<string, unknown>;
  resource_use: Record<string, unknown>;
  result: Record<string, unknown>;
  error: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export type ScopeOutputPublicationRecord = {
  publication_id: string;
  node_execution_id: string;
  port_id: string;
  event_id: string;
  idempotency_key: string;
  published_by_endpoint_id: string | null;
  created_at: string;
  /** Exact immutable outputs attached to this publication. */
  artefact_version_ids?: string[];
  outputs?: Array<{ artefact_version_id: string | null; member_key: string }>;
};

export type NodeExecutionRecord = {
  state_revision: number;
  actor_definition_revision_id?: string | null;
  node_execution_id: string;
  execution_id: string;
  revision_id: string;
  node_id: string;
  activation_key: string;
  context_id: string;
  status: NodeExecutionStatus;
  assigned_actor_ids: string[];
  missing_port_ids: string[];
  failure: Record<string, unknown>;
  created_at: string;
  activated_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  inputs: NodeExecutionInputRecord[];
  attempts: ExecutionAttemptRecord[];
  publications: ScopeOutputPublicationRecord[];
};

export type ScopeExecutionTraversalRecord = {
  traversal_id?: string;
  publication_id: string;
  edge_id: string;
  delivery_id: string;
  target_node_execution_id: string;
  created_at?: string;
};

export type ScopeExecutionProjection = {
  execution: ScopeExecutionRecord;
  /** The immutable plan pinned when the execution started. */
  revision: ScopeCompositionRevision;
  current_published_revision_id?: string | null;
  node_executions: NodeExecutionRecord[];
  traversals: ScopeExecutionTraversalRecord[];
};

export type ScopeCompositionRevisionPage = {
  published_revision_id: string | null;
  revisions: ScopeCompositionRevision[];
};

export type ScopeExecutionPage = {
  executions: ScopeExecutionRecord[];
  next_cursor: string | null;
};

// ---------------------------------------------------------------------------
// Canonical Artefacts
// ---------------------------------------------------------------------------

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type Sha256Digest = {
  algorithm: "sha256";
  value: string;
};

type ArtefactContentRefMetadata = {
  media_type?: string | null;
  size_bytes?: number | null;
};

export type ArtefactContentRef = ArtefactContentRefMetadata & (
  | { kind: "workspace-relative"; path: string; digest: Sha256Digest }
  | { kind: "content-addressed"; resolver_id: string; digest: Sha256Digest }
  | {
      kind: "external-revision";
      resolver_id: string;
      external_id: string;
      revision: string;
      digest?: Sha256Digest | null;
    }
);

export type Artefact = {
  artefact_id: string;
  workspace_id: string;
  type_ref: string;
  created_at: string;
};

export type ArtefactVersion = {
  artefact_version_id: string;
  artefact_id: string;
  ordinal: number;
  schema_ref: string | null;
  content_ref: ArtefactContentRef;
  created_at: string;
};

export type ArtefactLineage = {
  lineage_id: string;
  workspace_id: string;
  subject_version_id: string;
  relation_type: string;
  object_version_id: string;
  created_at: string;
};

export type ArtefactCollectionMember = {
  collection_version_id: string;
  member_key: string;
  member_version_id: string;
  position: number | null;
  created_at: string;
};

export type ArtefactAssociation = {
  association_id: string;
  artefact_version_id: string;
  target_kind: "event" | "context" | "scope_execution" | "node_execution" | "delivery" | "connector_receipt";
  target_id: string;
  role: "input" | "output" | "evidence" | "attachment" | "observation";
  created_at: string;
};

export type ArtefactAnnotation = {
  annotation_id: string;
  artefact_version_id: string;
  namespace: `extension:${string}`;
  key: string;
  extension_package_version_ref: string;
  schema_ref: string | null;
  value: JsonValue;
  created_at: string;
};

export type ArtefactVersionEvidence = {
  version: ArtefactVersion;
  lineage_from: ArtefactLineage[];
  lineage_to: ArtefactLineage[];
  members: ArtefactCollectionMember[];
  associations: ArtefactAssociation[];
  annotations: ArtefactAnnotation[];
};

export type InspectArtefactOperationResult = {
  artefact: Artefact;
  heads: ArtefactVersion[];
  history_complete: boolean;
  versions: ArtefactVersion[];
  selected: ArtefactVersionEvidence | null;
};

// ---------------------------------------------------------------------------
// Shared semantic operations
// ---------------------------------------------------------------------------

export type OperationResourceIdentity = { kind: string; id: string };
export type OperationResourceRef = OperationResourceIdentity & { revision?: string | null };

export type OperationRefusal = {
  code: string;
  message: string;
  retryable: boolean;
  required_action: {
    code: string;
    title: string;
    description: string;
    operation?: { operation_id: string; operation_version?: string; target?: OperationResourceIdentity | null } | null;
  } | null;
  details: Record<string, unknown>;
};

export type SemanticOperationDescriptor = {
  operation_id: string;
  operation_version: string;
  authority_boundary_kinds: Array<"workspace" | "host">;
  category: string;
  title: string;
  description: string;
  effects: {
    mode: "read" | "write";
    reversibility: "none" | "reversible" | "irreversible";
    external: boolean;
    secret_access: "none" | "reference" | "brokered";
  };
  required_grants: string[];
  interaction_constraints: Record<string, unknown>;
  target: { resource_kinds: string[]; expected_revision: "not_applicable" | "optional" | "required" };
  input: { version: string; schema: Record<string, unknown> };
  result: { version: string; schema: Record<string, unknown> };
  availability: { available: true } | { available: false; refusal: OperationRefusal };
};

export type OperationInvocationRequest = {
  operation_id: string;
  operation_version: string;
  input_schema_version: string;
  target?: OperationResourceIdentity | null;
  expected_resource_revision?: string | null;
  idempotency_key: string;
  input: unknown;
};

export type OperationInvocationReceipt = {
  receipt_id: string;
  invocation_id: string;
  operation_id: string;
  operation_version: string;
  principal_id: string;
  authority_boundary:
    | { kind: "workspace"; workspace_id: string }
    | { kind: "host"; host_id: string };
  /** Compatibility projection; canonical authority is authority_boundary. */
  workspace_id: string | null;
  target: OperationResourceRef | null;
  expected_resource_revision: string | null;
  idempotency_key: string;
  request_digest: string;
  state: "running" | "accepted" | "completed" | "refused";
  result_schema_version: string;
  result: unknown | null;
  refusal: OperationRefusal | null;
  changed_refs: OperationResourceRef[];
  progress_ref: OperationResourceRef | null;
  cancel_ref: { operation_id: string; operation_version?: string; target?: OperationResourceIdentity | null } | null;
  audit_ref: OperationResourceRef | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type OperationInvocationResponse =
  | { kind: "receipt"; replayed: boolean; receipt: OperationInvocationReceipt }
  | { kind: "conflict"; refusal: OperationRefusal; existing_receipt: OperationInvocationReceipt }
  | { kind: "rejected"; refusal: OperationRefusal };

export type ContextRef = {
  context_id: string;
  workspace_id: string;
  scope_id: string | null;
  parent_context_id: string | null;
  created_by_endpoint_id: string | null;
  created_by_principal_id?: string | null;
  created_at: string;
  updated_at?: string;
  state_revision?: number;
  lifecycle_state?: "active" | "archived" | "tombstoned";
  content_state?: "available" | "redacted" | "destroyed";
  archived_at?: string | null;
  archived_by_principal_id?: string | null;
  archive_reason?: string | null;
  restored_at?: string | null;
  restored_by_principal_id?: string | null;
  redacted_at?: string | null;
  redacted_by_principal_id?: string | null;
  redaction_reason?: string | null;
  tombstoned_at?: string | null;
  tombstoned_by_principal_id?: string | null;
  tombstone_reason?: string | null;
  last_event_at: string | null;
  activity_at?: string;
  participants: string[];
  /** Extension-owned display title (e.g. card title). Preferred over first_message_preview when present. */
  title: string | null;
  first_message_preview: string | null;
  latest_message_preview?: string | null;
  latest_message?: EventEnvelope | null;
  /** Canonical Delivery state, including explicitly requested work, projected for this Context. */
  delivery_summary?: { active_count: number; latest_state: string | null };
};

export type EndpointRef = {
  endpoint_id: string;
  workspace_id: string;
  name: string;
  agent_id: string | null;
  bridge_id: string | null;
  status: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

export type ActorDefinitionResourceRef = {
  kind: string;
  id: string;
  revision: string | null;
};

export type ActorDefinitionContent = {
  label: string;
  charter: string;
  responsibilities: Array<{
    responsibility_id: string;
    title: string;
    description: string;
  }>;
  instructions: string;
  knowledge_refs: ActorDefinitionResourceRef[];
  capability_grant_ids: string[];
  policy_refs: {
    budget: ActorDefinitionResourceRef | null;
    trust: ActorDefinitionResourceRef | null;
    approval: ActorDefinitionResourceRef | null;
  };
  escalation_rules: Array<{
    rule_id: string;
    when: string;
    action: "decline" | "delegate" | "escalate" | "signal_unowned";
    target_actor_id?: string | null;
  }>;
};

export type ActorRecord = {
  actor_id: string;
  workspace_id: string;
  status: "active" | "retired";
  current_definition_revision_id: string | null;
  created_at: string;
  updated_at: string;
  retired_at: string | null;
};

export type ActorDefinitionRevision = {
  actor_definition_revision_id: string;
  actor_id: string;
  workspace_id: string;
  revision_number: number;
  based_on_revision_id: string | null;
  semantic_digest: string;
  content: ActorDefinitionContent;
  created_by_principal_id: string;
  created_at: string;
  published_at: string | null;
  withdrawn_at: string | null;
};

export type ActorInspection = {
  actor: ActorRecord;
  current_definition: ActorDefinitionRevision | null;
  history_complete: boolean;
  revisions: ActorDefinitionRevision[];
  head_changes: unknown[];
};

export type PulseRef = {
  pulse_id: string;
  workspace_id: string;
  scope_id: string | null;
  persistence: "workspace" | "local";
  status: string;
  trigger: unknown;
  content?: unknown;
  subscribers?: PulseSubscriber[];
  next_fire_at: string | null;
  last_fired_at: string | null;
  fire_count: number;
  created_at: string;
  updated_at: string;
};

export type Watermark = {
  workspace_id: string;
  endpoint_id: string;
  cursor: string;
  updated_at: string;
};

export type DestinationSelector =
  | { kind: "endpoint"; endpoint_id: string }
  | { kind: "context"; context_id: string }
  | {
      kind: "broadcast";
      scope: "workspace";
      target: string;
      exclude_source?: boolean;
    };

export type ResponseExpectation = {
  expected: boolean;
  mode?: "open" | "thread_affine" | "correlated";
  correlation_id?: string | null;
  timeout_at?: string | null;
};

export type EventEnvelope = {
  event_id: string;
  type: string;
  workspace_id: string;
  source_endpoint_id: string | null;
  thread_id: string;
  context_id: string;
  scope_id: string | null;
  correlation_id: string | null;
  destination_json: DestinationSelector;
  content: Record<string, unknown>;
  response: ResponseExpectation;
  metadata: Record<string, unknown>;
  artefact_version_ids: string[];
  created_at: string;
};

export type PendingResponse = {
  pending_id: string;
  workspace_id: string;
  waiting_endpoint_id: string;
  source_event_id: string;
  mode: string;
  thread_id: string | null;
  correlation_id: string | null;
  timeout_at: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
};

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

/** Raw delivery_bundles row as returned by GET /v1/delivery */
export type DeliveryRow = {
  delivery_id: string;
  endpoint_id: string;
  workspace_id: string;
  trigger_event_id: string;
  events_json: string;
  state: string;
  lease_expires_at: string | null;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  claimed_at: string | null;
};

/** Hydrated delivery as returned by GET /v1/delivery/claim */
export type DeliveryBundle = {
  delivery_id: string;
  endpoint_id: string;
  workspace_id: string;
  trigger_event_id: string;
  events: EventEnvelope[];
  delivered_at: string;
};

// ---------------------------------------------------------------------------
// Runtime telemetry
// ---------------------------------------------------------------------------

/** Raw runtime_telemetry row as returned by GET /v1/runtime/telemetry */
export type TelemetryRow = {
  telemetry_id: string;
  workspace_id: string;
  endpoint_id: string;
  delivery_id: string | null;
  kind: string;
  payload_json: string;
  created_at: string;
};

// ---------------------------------------------------------------------------
// Support diagnostics
// ---------------------------------------------------------------------------

export type ContextDiagnosticEvidence = {
  schema: "floe.context-diagnostic.v1";
  generated_at: string;
  source: {
    component: "floe-bus";
    release_version: string | null;
    build_sha: string | null;
  };
  workspace: { workspace_id: string };
  context: {
    context_id: string;
    workspace_id: string;
    scope_id: string | null;
    parent_context_id: string | null;
    created_by_endpoint_id: string | null;
    created_at: string;
    title: string | null;
    participants: string[];
    endpoints: Array<Pick<EndpointRef, "endpoint_id" | "name" | "agent_id" | "bridge_id" | "status">>;
  };
  events: EventEnvelope[];
  deliveries: Array<{
    delivery_id: string;
    endpoint_id: string;
    trigger_event_id: string;
    state: string;
    lease_expires_at: string | null;
    attempt_count: number;
    last_error: string | null;
    created_at: string;
    claimed_at: string | null;
  }>;
  telemetry: Array<{
    telemetry_id: string;
    endpoint_id: string;
    delivery_id: string | null;
    kind: string;
    payload: Record<string, unknown>;
    created_at: string;
  }>;
  runtime: RuntimeStatus;
  operations: Array<{
    operation_id: string;
    operation_version: string;
    category: string;
    title: string;
    effects: {
      mode: "read" | "write";
      reversibility: "none" | "reversible" | "irreversible";
      external: boolean;
      secret_access: "none" | "reference" | "brokered";
    };
  }>;
  limits: {
    events: number;
    deliveries: number;
    telemetry: number;
    events_truncated: boolean;
    deliveries_truncated: boolean;
    telemetry_truncated: boolean;
  };
};

// ---------------------------------------------------------------------------
// Runtime bindings
// ---------------------------------------------------------------------------

export type RuntimeBindingScope = "agent" | "workspace_default" | "global_default";

export type RuntimeBindingRecord = {
  binding_key: string;
  scope: RuntimeBindingScope;
  workspace_id: string | null;
  endpoint_id: string | null;
  auth_profile: string;
  provider: string | null;
  model: string | null;
  thinking_level: string | null;
  created_at: string;
  updated_at: string;
};

export type RuntimeBindingResolution = {
  endpoint_auth_profile: string | null;
  workspace_auth_profile: string | null;
  global_auth_profile: string | null;
  endpoint_provider: string | null;
  workspace_provider: string | null;
  global_provider: string | null;
  endpoint_model: string | null;
  workspace_model: string | null;
  global_model: string | null;
  endpoint_thinking_level: string | null;
  workspace_thinking_level: string | null;
  global_thinking_level: string | null;
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export type AuthProfileRecord = {
  id: string;
  provider: string;
  model?: string;
  label?: string;
  created_at?: string;
  updated_at?: string;
};

export type AuthModelRecord = {
  id: string;
  name: string;
  provider: string;
  api: string;
  reasoning: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
};

// ---------------------------------------------------------------------------
// Saved configs
// ---------------------------------------------------------------------------

export type SavedConfigRow = {
  config_id: string;
  name: string;
  config_json: string;
  created_at: string;
  updated_at: string;
};

// ---------------------------------------------------------------------------
// Runtime status
// ---------------------------------------------------------------------------

export type RuntimeStatus = {
  bridge: {
    online: boolean;
    runtime_adapter: string | null;
    release_version?: string | null;
    build_sha?: string | null;
  };
};

export type LocalConfigStatus = {
  ok: boolean;
  config_path: string;
  home: string;
  bus: unknown;
  web: unknown;
  bridge: unknown;
};

// ---------------------------------------------------------------------------
// Endpoint resolve
// ---------------------------------------------------------------------------

export type ResolvedEndpoint = {
  endpoint_id: string;
  found: boolean;
};

// ---------------------------------------------------------------------------
// Projection types (mirror floe-bus/src/scopes/projection.ts)
// ---------------------------------------------------------------------------

export type ScopeProjectionContextRef = {
  context_id: string;
  workspace_id: string;
  scope_id: string;
  parent_context_id: string | null;
  created_by_endpoint_id: string | null;
  created_at: string;
  last_event_at: string | null;
  first_message_preview: string | null;
};

export type ScopeProjectionPulseRef = {
  pulse_id: string;
  workspace_id: string;
  scope_id: string;
  persistence: "workspace" | "local";
  status: string;
  trigger: unknown;
  next_fire_at: string | null;
  last_fired_at: string | null;
  fire_count: number;
  created_at: string;
  updated_at: string;
};

export type ScopeProjectionEventRef = {
  event_id: string;
  type: string;
  workspace_id: string;
  scope_id: string;
  context_id: string | null;
  source_endpoint_id: string | null;
  created_at: string;
};

export type ScopeProjectionActivityRef = {
  telemetry_id: string;
  workspace_id: string;
  endpoint_id: string;
  delivery_id: string;
  kind: string;
  context_id: string | null;
  event_id: string | null;
  created_at: string;
};

export type ScopeProjection = {
  workspace_id: string;
  scope_id: string;
  generated_at: string;
  refs: {
    contexts: ScopeProjectionContextRef[];
    pulses: ScopeProjectionPulseRef[];
    events: ScopeProjectionEventRef[];
    activity: ScopeProjectionActivityRef[];
  };
  relationships: {
    context_participants: Array<{ context_id: string; endpoint_id: string }>;
    pulse_subscribers: Array<{ pulse_id: string; subscriber: unknown }>;
    event_context_ownership: Array<{ event_id: string; context_id: string }>;
  };
  unsupported: Array<{ kind: string; reason: string }>;
};

// ---------------------------------------------------------------------------
// Scope projection layout (persisted renderer layout for a Scope projection)
// ---------------------------------------------------------------------------

export type ScopeProjectionLayoutNode = {
  id: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
};

export type ScopeProjectionLayoutEdge = {
  id: string;
  source: string;
  target: string;
  data?: Record<string, unknown>;
};

export type ScopeProjectionLayout = {
  workspace_id: string;
  scope_id: string;
  renderer: string;
  nodes: ScopeProjectionLayoutNode[];
  edges: ScopeProjectionLayoutEdge[];
  updated_at: string;
};

// ---------------------------------------------------------------------------
// Event trace
// ---------------------------------------------------------------------------

export type EventTrace = {
  event_id: string;
  delivery_id: string | null;
  telemetry: unknown[];
};

// ---------------------------------------------------------------------------
// Emit input (for client.emit)
// ---------------------------------------------------------------------------

export type EmitInput = {
  type: string;
  workspace_id: string;
  source_endpoint_id: string;
  destination: DestinationSelector;
  context_id?: string | null;
  scope_id?: string | null;
  current_delivery_context_id?: string | null;
  correlation_id?: string | null;
  content: Record<string, unknown>;
  response?: ResponseExpectation;
  metadata?: Record<string, unknown>;
  idempotency_key?: string | null;
};

// ---------------------------------------------------------------------------
// Pulse subscriber (for createPulse / subscribePulse / unsubscribePulse)
// ---------------------------------------------------------------------------

export type PulseSubscriber =
  | { kind: "context"; context_id: string }
  | { kind?: "endpoint"; endpoint_ref: string; context_id?: string | null };

export type PulseTrigger =
  | { type: "once"; at: string }
  | { type: "cron"; schedule: string; timezone?: string };

export type CreatePulseInput = {
  pulse_id: string;
  workspace_id: string;
  persistence?: "workspace" | "local";
  scope_id?: string | null;
  current_context_id?: string | null;
  trigger: PulseTrigger;
  content?: Record<string, unknown>;
  subscribers: PulseSubscriber[];
  created_by?: string;
};

// ---------------------------------------------------------------------------
// Stream messages (WebSocket /v1/events/stream)
// ---------------------------------------------------------------------------

export type StreamMsg = {
  cursor?: string;
  type: string;
  payload: Record<string, unknown>;
  at: string;
};

// ---------------------------------------------------------------------------
// App-level domain types
// ---------------------------------------------------------------------------

export type WaitingItem = {
  source: PendingResponse;
  eventContent: Record<string, unknown>;
  askingActor: EndpointRef;
};
