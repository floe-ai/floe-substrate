/**
 * @invariant BusStore is the sole mutable substrate store for bus-owned records.
 * Runtime bindings, bridges, deliveries, and telemetry must be persisted and resolved here
 * with explicit precedence rules; callers must not invent parallel runtime state.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { CronExpressionParser } from "cron-parser";
import type { LocalConfig } from "./config.js";
import { resolveLocalPath } from "./config.js";
import { ContextStore, applyContextSchema, type ContextRecord } from "./contexts/store.js";
import { decodeEventCursor } from "./event-cursor.js";
import { runtimeCredentialAccessOperations } from "./credential-runtime-access-operations.js";
import { capabilityGrantOperations } from "./capability-grant-operations.js";
import {
  EndpointWatermarkStore,
  applyEndpointWatermarkSchema,
  type EndpointWatermark
} from "./endpoint-watermark-store.js";
import { resolveContext, type NotContextParticipantError } from "./contexts/resolver.js";
import {
  RESERVED_DEFAULT_SCOPE_ID,
  ScopeNotEmptyError,
  ScopeNotFoundError,
  ScopeReservedIdError,
  ScopeStore,
  applyScopeSchema,
  type ScopeRecord
} from "./scopes/store.js";
import {
  ScopeGraphNodeNotATriggerError,
  ScopeGraphNodeNotFoundError,
  ScopeGraphNotFoundError,
  ScopeGraphInvalidError,
  ScopeGraphStore,
  applyScopeGraphSchema,
  validateScopeGraphNodes,
  type ScopeGraphNode,
  type ScopeGraphRecord
} from "./scope-graphs.js";
import {
  ScopeCompositionStore,
  ScopeCompositionInvalidError,
  inspectScopeCompositionValidation as inspectScopeStructure,
  applyScopeCompositionSchema,
  type ScopeCompositionContent,
  type ScopeCompositionImpact,
  type ScopeCompositionRevision,
  type ScopeCompositionRoutingMode,
  type ScopeCompositionValidation,
  type PortableScopeComposition,
  type ScopeNodePlacement,
  type ScopePort,
} from "./scope-compositions.js";
import {
  ScopeExecutionStore,
  applyScopeExecutionSchema,
  type ExecutionAttemptRecord,
  type NodeExecutionJoinState,
  type NodeExecutionRecord,
  type NodeExecutionInputRecord,
  type OutputPublicationRecord,
  type ScopeEdgeTraversalRecord,
  type ScopeExecutionRecord,
  type ScopeExecutionPauseResult,
  type ScopeExecutionResumeResult,
  type NodeExecutionRetryResult,
} from "./scope-executions.js";
import { importLegacyScopeGraph } from "./scope-composition-migration.js";
import {
  ArtefactStore,
  ArtefactNotFoundError,
  type ArtefactVersion,
  type PublishArtefactVersionInput,
  applyArtefactSchema,
  type ArtefactAssociationRole,
} from "./artefacts.js";
import { ArtefactContentNotFoundError, resolveWorkspaceArtefactContent } from "./artefact-content-resolver.js";
import { ActorDefinitionStore, ActorDefinitionValidationError, applyActorDefinitionSchema } from "./actor-definitions.js";
import {
  CommandDefinitionStore,
  applyCommandDefinitionSchema,
  type CommandDefinitionRevision,
} from "./command-definitions.js";
import {
  registerCommandOperations,
  resolveCommandOperationResource,
} from "./command-operations.js";
import {
  CanonicalCommandRuntimeHost,
  CommandProcessingContractStore,
  CommandRuntimeContractError,
  CommandWorkerBindingStore,
  applyCommandRuntimeSchema,
  resolveCommandImplementation,
  type CommandHostResult,
  type CommandProcessingContract,
  type CommandRuntimeHost,
  type CommandWorkerBindingRecord,
} from "./command-runtime.js";
import { IsolatedCoreCommandProcessHost, CommandRuntimeHostError } from "./isolated-command-host.js";
import {
  ActorRoleAuthorityStore,
  applyActorRoleAuthoritySchema,
} from "./actor-role-authority.js";
import {
  registerActorRoleOperations,
  resolveActorRoleAuthorityResource,
} from "./actor-role-operations.js";
import { RuntimeProfileStore, applyRuntimeProfileSchema } from "./runtime-profiles.js";
import { ConnectorStore, applyConnectorSchema } from "./connectors.js";
import {
  ApprovalConflictError,
  ApprovalValidationError,
  ApprovalStore,
  approvalActionDigest,
  approvalReceiptStateRevision,
  applyApprovalSchema,
  type ApprovalDecision,
  type ApprovalDecisionBinding,
  type ApprovalDecisionPolicyReference,
  type ApprovalDecisionPolicySnapshot,
  type ApprovalIndividualDecisionRecord,
  type ApprovalReceiptRecord,
  type ApprovalRequestRecord,
} from "./approvals.js";
import {
  PolicyStore,
  applyPolicySchema,
  type PolicyEvaluationFacts,
} from "./policies.js";
import {
  registerPolicyOperations,
  resolvePolicyOperationResource,
} from "./policy-operations.js";
import { BudgetStore, applyBudgetSchema } from "./budgets.js";
import { AuditStore, applyAuditSchema } from "./audit.js";
import {
  registerBudgetOperations,
  resolveBudgetOperationResource,
} from "./budget-operations.js";
import {
  registerAuditOperations,
  resolveAuditOperationResource,
} from "./audit-operations.js";
import {
  ExtensionStore,
  applyExtensionSchema,
  type ExtensionActivationAssuranceProvider,
} from "./extensions.js";
import { applyExtensionActivationAttemptSchema } from "./extension-activation-authority.js";
import {
  applyExtensionRuntimeAuditSchema,
  CanonicalExtensionRuntime,
} from "./canonical-extension-runtime.js";
import {
  RuntimeProcessingContractResolver,
  type RuntimeDispatchContract,
  type RuntimeProcessingContract,
} from "./runtime-processing-contract.js";
import { runDatabaseUpgrade } from "./database-upgrade.js";
import { SemanticOperationRegistry, type OperationInvocationReceipt } from "./operations.js";
import { BusOperationGovernanceControlPlane } from "./operation-governance-control-plane.js";
import { AjvOperationSchemaValidator } from "./operation-schema-validator-ajv.js";
import {
  SqliteOperationInvocationLedger,
  applyOperationInvocationLedgerSchema,
} from "./operation-invocation-ledger-sqlite.js";
import {
  OperationAuthorityVerifier,
  SqliteOperationAuthoritySessionStore,
  applyOperationAuthoritySessionSchema,
} from "./operation-authority-sessions.js";
import {
  SqliteClientIdentityStore,
  applyClientIdentitySchema,
} from "./client-identity-store.js";
import {
  SqliteCapabilityGrantStore,
  applyCapabilityGrantSchema,
} from "./capability-grants.js";
import {
  CredentialBrokerService,
  SecretAccessDeniedError,
  SqliteSecretRefStore,
  WindowsCredentialBroker,
  applyCredentialBrokerSchema,
  type BrokeredSecretOperation,
  type SecretAccessRequest,
  type SecretRefRecord,
} from "./credential-broker.js";
import {
  WINDOWS_DPAPI_CREDENTIAL_BROKER_ID,
  WindowsDpapiCredentialProtector,
} from "./windows-dpapi-credential-protector.js";
import { LegacyAuthCredentialSource } from "./legacy-auth-credential-source.js";
import { CredentialIngressStore } from "./credential-ingress.js";
import {
  AttachmentIngressStore,
  type ConsumedAttachmentIngress,
} from "./attachment-ingress.js";
import { resolveWithinRoot } from "./fs/resolveWithinRoot.js";
import {
  REFRESH_CREDENTIAL_OPERATION_ID,
  RUNTIME_CREDENTIAL_PURPOSE,
  USE_CREDENTIAL_OPERATION_ID,
  registerCredentialOperations,
} from "./credential-operations.js";
import {
  SqliteTransportCredentialStore,
  applyTransportCredentialSchema,
} from "./transport-credentials.js";
import { applyTransportPushStreamSchema } from "./transport-push-stream.js";
import {
  SqliteLocalOperatorPrincipalStore,
  applyLocalOperatorPrincipalSchema,
} from "./local-operator-principals.js";
import { applyDeliveryOperationAuthoritySchema } from "./delivery-operation-authority.js";
import { registerArtefactOperations } from "./artefact-operations.js";
import { exportArtefactVersionOperation } from "./artefact-export.js";
import { registerActorDefinitionOperations } from "./actor-definition-operations.js";
import { registerRuntimeProfileOperations } from "./runtime-profile-operations.js";
import {
  registerConnectorOperations,
  resolveConnectorOperationResource,
} from "./connector-operations.js";
import {
  registerApprovalOperations,
  type ApprovalOperationBackend,
} from "./approval-operations.js";
import { BusApprovalOperationBackend } from "./approval-operation-backend.js";
import {
  registerExtensionOperations,
  resolveExtensionOperationResource,
  type ExtensionEntryPointExecution,
} from "./extension-operations.js";
import {
  ExtensionSandboxError,
  type ExtensionHostBroker,
  type JsonValue,
} from "./isolated-extension-runtime.js";
import { BusWorkspaceOperationBackend } from "./workspace-operation-backend.js";
import { registerWorkspaceOperations } from "./workspace-operations.js";
import {
  WorkspacePortabilityError,
  WorkspacePortabilityService,
  applyWorkspacePortabilitySchema,
} from "./workspace-portability.js";
import { registerWorkspacePortabilityOperations } from "./workspace-portability-operations.js";
import {
  SqliteWorkspaceIdentityStore,
  applyWorkspaceIdentityMigration,
  getOrCreateLocalHostIdentity,
  planWorkspaceIdentityMigration,
  type LocalWorkspaceProjection,
  type RemoteWorkspaceProjection,
  type WorkspaceLocatorPlatform,
} from "./workspace-identities.js";
import {
  LEGACY_WORKSPACE_MODEL_ACTOR_OPERATION_IDS_V1,
  WorkspaceConfigurationImportStore,
  applyWorkspaceConfigurationImportSchema,
  type WorkspaceConfigurationImportPolicy,
  type WorkspaceConfigurationImportResult,
  type WorkspaceConfigurationInventoryV1,
  type WorkspaceConfigurationPolicyProvider,
} from "./workspace-config-import.js";
import {
  NO_PUBLISHED_SCOPE_REVISION,
  PUBLISH_SCOPE_OUTPUT_OPERATION_ID,
  nodeExecutionStateRevision,
  registerScopeOperations,
  scopeExecutionStateRevision,
} from "./scope-operations.js";
import { BusScopeOperationBackend } from "./scope-operation-backend.js";
import { BusContextOperationBackend } from "./context-operation-backend.js";
import {
  ACTIVE_RUNTIME_DELIVERY_STATES,
  cancelRuntimeDeliveryOperation,
  type RuntimeDeliveryState,
  type RuntimeDeliveryCancellation,
} from "./runtime-delivery-operations.js";
import {
  registerContextOperations,
  resolveContextOperationResource,
} from "./context-operations.js";
import {
  sameOperationAuthorityBoundary,
  type OperationAuthorityBoundary,
  type OperationInvocationProvenance,
  type OperationResourceIdentity,
  type ResolvedOperationResource,
} from "./operations.js";

type Broadcast = (type: string, payload: Record<string, unknown>) => void;

// One projection for Context response controls and list summaries. Only recorded
// request ancestry relates work; membership and Actor identity do not.
const CONTEXT_DELIVERIES_CTE = `
  WITH RECURSIVE related(context_id, workspace_id, delivery_id) AS (
    SELECT e.context_id, d.workspace_id, d.delivery_id FROM delivery_bundles d
    JOIN events e ON e.event_id = d.trigger_event_id
    JOIN contexts c ON c.context_id = e.context_id AND c.workspace_id = d.workspace_id
    WHERE e.context_id IN (SELECT value FROM json_each(?))
    UNION
    SELECT parent.context_id, d.workspace_id, d.delivery_id FROM delivery_bundles d
    JOIN events e ON e.event_id = d.trigger_event_id
    JOIN related parent ON parent.delivery_id = json_extract(e.metadata_json, '$.request_parent_delivery_id')
    WHERE d.workspace_id = parent.workspace_id
    UNION
    SELECT parent.context_id, d.workspace_id, d.delivery_id FROM delivery_bundles d
    JOIN events e ON e.event_id = d.trigger_event_id
    JOIN events request ON request.event_id = json_extract(e.metadata_json, '$.request_event_id')
    JOIN related parent ON parent.delivery_id = json_extract(request.metadata_json, '$.request_parent_delivery_id')
    WHERE e.type = 'request.result'
      AND json_extract(e.metadata_json, '$.origin') = 'runtime_request_return'
      AND request.type = 'request'
      AND request.workspace_id = parent.workspace_id
      AND d.workspace_id = parent.workspace_id
  )
`;

export type BusStoreExtensionRuntime = Readonly<{
  assurance: ExtensionActivationAssuranceProvider;
  entry_point_execution: ExtensionEntryPointExecution;
  inspect?(): import("./canonical-extension-runtime.js").ExtensionRuntimeDescription;
  terminateAll(): void;
}>;

export type BusStoreExtensionRuntimeFactory = (input: Readonly<{
  db: DatabaseSync;
  approvals: ApprovalStore;
  broker: ExtensionHostBroker;
  workspace_root: (workspaceId: string) => string | null;
  quarantine: (input: Readonly<{
    workspace_id: string;
    extension_installation_id: string;
    extension_package_version_id: string;
    isolation_host_id: string;
    failure_code: string;
    failure_message: string;
  }>) => void;
}>) => BusStoreExtensionRuntime;

export type BusStoreOptions = Readonly<{
  workspace_configuration_policy?: WorkspaceConfigurationPolicyProvider;
  extension_runtime_factory?: BusStoreExtensionRuntimeFactory;
  /** Test seam for the real Command host interface; production always isolates execution. */
  command_runtime_host?: CommandRuntimeHost;
}>;

export const BROADCAST_TARGETS = [
  "all",
  "active",
  "with_delivery_processor",
  "without_delivery_processor",
  "active_with_delivery_processor",
  "active_without_delivery_processor"
] as const;

export type BroadcastTarget = typeof BROADCAST_TARGETS[number];

export class ContextParticipantError extends Error {
  readonly code = "E_NOT_CONTEXT_PARTICIPANT" as const;
  readonly payload: NotContextParticipantError["payload"];
  constructor(payload: NotContextParticipantError["payload"]) {
    super(payload.message);
    this.name = "ContextParticipantError";
    this.payload = payload;
  }
}

export class ContextNotFoundError extends Error {
  readonly code = "E_CONTEXT_NOT_FOUND" as const;
  constructor(readonly workspace_id: string, readonly context_id: string) {
    super(`Context not found: ${context_id}`);
    this.name = "ContextNotFoundError";
  }
}

export class ContextAnchorError extends Error {
  readonly code = "E_CONTEXT_ANCHOR_INVALID" as const;
  constructor(
    readonly workspace_id: string,
    readonly context_id: string,
    readonly reason: string
  ) {
    super(`Invalid Context anchor: ${reason}`);
    this.name = "ContextAnchorError";
  }
}

export class ScopeRequiredError extends Error {
  readonly code = "E_SCOPE_REQUIRED" as const;
  constructor(readonly workspace_id: string, readonly reason: string) {
    super(`Scope is required: ${reason}`);
    this.name = "ScopeRequiredError";
  }
}

export class ScopeRemovalBlockedError extends Error {
  readonly code = "E_SCOPE_REMOVAL_BLOCKED" as const;
  constructor(
    readonly workspace_id: string,
    readonly scope_id: string,
    readonly event_count: number,
    readonly pulse_count: number,
    readonly busy_endpoint_count = 0
  ) {
    super(
      `Scope '${scope_id}' cannot be removed safely: ${event_count} historical event(s), ${pulse_count} pulse(s), ${busy_endpoint_count} busy endpoint(s)`
    );
    this.name = "ScopeRemovalBlockedError";
  }
}

export class ScopeRetirementBlockedError extends Error {
  readonly code = "E_SCOPE_RETIREMENT_BLOCKED" as const;
  constructor(
    readonly workspace_id: string,
    readonly scope_id: string,
    readonly active_work_count: number
  ) {
    super(`Scope '${scope_id}' cannot be retired while ${active_work_count} delivery or command runtime(s) are active.`);
    this.name = "ScopeRetirementBlockedError";
  }
}

export class ScopeCompositionBlockedError extends Error {
  readonly code = "E_SCOPE_COMPOSITION_BLOCKED" as const;
  constructor(
    readonly workspace_id: string,
    readonly scope_id: string,
    readonly busy_endpoint_count: number
  ) {
    super(`Scope '${scope_id}' cannot be recomposed while ${busy_endpoint_count} command endpoint(s) are working.`);
    this.name = "ScopeCompositionBlockedError";
  }
}

export class ScopeExecutionInvalidError extends Error {
  readonly code = "E_SCOPE_EXECUTION_INVALID" as const;
  constructor(readonly reason: string) {
    super(`Invalid Scope execution: ${reason}`);
    this.name = "ScopeExecutionInvalidError";
  }
}

export class ScopeOutputAuthorityError extends Error {
  readonly code = "E_SCOPE_OUTPUT_AUTHORITY" as const;
  constructor(readonly node_execution_id: string, readonly endpoint_id: string | null) {
    super(`Endpoint '${endpoint_id ?? "unknown"}' is not authorised to publish output for NodeExecution '${node_execution_id}'.`);
    this.name = "ScopeOutputAuthorityError";
  }
}

export class ScopeRetiredError extends Error {
  readonly code = "E_SCOPE_RETIRED" as const;
  constructor(readonly workspace_id: string, readonly scope_id: string) {
    super(`Scope '${scope_id}' is retired and cannot route new work.`);
    this.name = "ScopeRetiredError";
  }
}

export class EndpointRetirementBlockedError extends Error {
  readonly code = "E_ENDPOINT_RETIREMENT_BLOCKED" as const;
  constructor(readonly endpoint_id: string, readonly status: string) {
    super(`Endpoint '${endpoint_id}' cannot be retired while its status is '${status}'.`);
    this.name = "EndpointRetirementBlockedError";
  }
}

export class ContextScopeAssignmentError extends Error {
  readonly code = "E_CONTEXT_SCOPE_ASSIGNMENT_INVALID" as const;
  constructor(
    readonly workspace_id: string,
    readonly context_id: string,
    readonly reason: string
  ) {
    super(`Context Scope assignment invalid: ${reason}`);
    this.name = "ContextScopeAssignmentError";
  }
}

export class PulseNotFoundError extends Error {
  readonly code = "E_PULSE_NOT_FOUND" as const;
  constructor(readonly pulse_id: string) {
    super(`Pulse not found: ${pulse_id}`);
    this.name = "PulseNotFoundError";
  }
}

export type DestinationSelector =
  | { kind: "endpoint"; endpoint_id: string }
  /**
   * Context-addressed emit: records the event in the context log AND delivers
   * it to every actor whose subscription in that context matches the event
   * type.  If no actor is subscribed to the event type the event is recorded
   * and delivered to no one — the natural "record-only" outcome.
   *
   * This is the single context-delivery path.  There is no separate fan-out
   * kind; routing resolves via context_subscriptions.
   */
  | { kind: "context"; context_id: string }
  | {
      kind: "broadcast";
      scope: "workspace";
      target: BroadcastTarget;
      exclude_source?: boolean;
    };

export type ResponseExpectation = {
  expected: boolean;
  mode?: "open" | "thread_affine" | "correlated";
  correlation_id?: string | null;
  timeout_at?: string | null;
};

export type EventCommand = {
  type: string;
  workspace_id: string;
  source_endpoint_id: string;
  destination: DestinationSelector;
  /**
   * Legacy field retained for storage compatibility only — no new flow reads it.
   * Resolver computes the canonical `context_id`. If omitted, `submitEvent` writes
   * the resolved context_id into this column to satisfy the existing NOT NULL constraint.
   */
  thread_id?: string;
  correlation_id?: string | null;
  content: Record<string, unknown>;
  artefact_version_ids?: string[];
  response?: ResponseExpectation;
  metadata?: Record<string, unknown>;
  idempotency_key?: string | null;
  /** Caller-supplied context_id (rule 1). When omitted, resolver decides. */
  context_id?: string | null;
  /** Caller-supplied organising Scope for newly-created contexts. Existing Context Scope remains authoritative. */
  scope_id?: string | null;
  /** Bridge passes the context_id of the delivery currently being processed (rules 2/3). */
  current_delivery_context_id?: string | null;
};

/**
 * Bus-originated trigger emission (pulse.fired, webhook ingest, etc.).
 *
 * Triggers are NOT actor-to-actor messages. Per design §3.1.6, the bus directly
 * creates a target-only context (`participants = [target_endpoint_id]`) and the
 * event's `source_endpoint_id` is `null` — never a synthetic system endpoint.
 * The participant-aware resolver (§3.1.4) does not apply.
 */
export type TriggerEventCommand = {
  type: string;
  workspace_id: string;
  target_endpoint_id: string;
  context_id?: string | null;
  scope_id?: string | null;
  content: Record<string, unknown>;
  metadata: Record<string, unknown> & { trigger_kind: "pulse" | "webhook" | string };
  correlation_id?: string | null;
  idempotency_key?: string | null;
};

export type PulseSubscriber =
  | { kind: "context"; context_id: string }
  | { kind?: "endpoint"; endpoint_ref: string; context_id?: string | null };

export type PulsePersistence = "workspace" | "local";

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
  /** Exact immutable content referenced by this Event. */
  artefact_version_ids: string[];
  created_at: string;
};

export type DeliveryBundle = {
  delivery_id: string;
  /** Stable transport obligations grouped into this claim attempt. */
  stable_delivery_ids: string[];
  endpoint_id: string;
  workspace_id: string;
  trigger_event_id: string;
  events: EventEnvelope[];
  delivered_at: string;
  scope_execution_id: string | null;
  composition_revision_id: string | null;
  node_execution_id: string | null;
  target_node_id: string | null;
  target_port_ids: string[];
  context_id: string | null;
  execution_attempt_id: string | null;
  /** Exact Actor/runtime selections fixed before the logical Delivery is first attempted. */
  actor_definition_revision_id: string | null;
  runtime_profile_revision_id: string | null;
  actor_runtime_binding_id: string | null;
  /** Exact Command meaning and distinct authenticated worker for this Delivery. */
  command_definition_revision_id: string | null;
  command_worker_binding_id: string | null;
  /** The bearer is returned only by runtime preparation and is never persisted. */
  operation_authority_session_id: string | null;
  node_contract: {
    node: ScopeNodePlacement;
    input_ports: ScopePort[];
    output_ports: ScopePort[];
  } | null;
};

export type RuntimeTurnResult = {
  result_event: EventEnvelope;
  return_event: EventEnvelope | null;
  request_resolved: boolean;
};

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

export type BridgeRecord = {
  bridge_id: string;
  status: string;
  capabilities: Record<string, unknown>;
  last_seen_at: string;
  created_at: string;
};

/**
 * Compatibility shape for trusted local Bridge/app adapters. Canonical
 * Workspace identity and host binding remain separate in storage.
 */
export type LocalWorkspaceRecord = {
  workspace_id: string;
  name: string;
  creation_kind: string;
  source_workspace_id: string | null;
  binding_id: string | null;
  locator: string | null;
  status: string;
  init_authorized: boolean;
  active_config_hash: string | null;
  selected_at: string | null;
  created_at: string;
  updated_at: string;
};

function now(): string {
  return new Date().toISOString();
}

/**
 * Inverse of workspaceConfigurationActorId: recover the source actor id (the
 * agent_id) from a canonical actor/endpoint id of the form
 * `actor:<workspace_id>:<agent_id>`. Falls back to the full id if the prefix is
 * absent so non-canonical ids degrade safely rather than throwing.
 */
function sourceActorIdFromActorId(actorId: string, workspaceId: string): string {
  const prefix = `actor:${workspaceId}:`;
  return actorId.startsWith(prefix) ? actorId.slice(prefix.length) : actorId;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function localWorkspaceRecord(projection: LocalWorkspaceProjection): LocalWorkspaceRecord {
  return {
    workspace_id: projection.workspace_id,
    name: projection.name,
    creation_kind: projection.creation_kind,
    source_workspace_id: projection.source_workspace_id,
    binding_id: projection.binding?.binding_id ?? null,
    locator: projection.binding?.locator ?? null,
    status: projection.binding?.status ?? "unbound",
    init_authorized: projection.binding?.init_authorized ?? false,
    active_config_hash: projection.binding?.active_config_hash ?? null,
    selected_at: projection.binding?.selected_at ?? null,
    created_at: projection.created_at,
    updated_at: projection.binding?.updated_at ?? projection.updated_at,
  };
}

export class BusStore {
  readonly db: DatabaseSync;
  readonly contextStore: ContextStore;
  readonly scopeStore: ScopeStore;
  readonly scopeGraphStore: ScopeGraphStore;
  readonly scopeCompositionStore: ScopeCompositionStore;
  readonly scopeExecutionStore: ScopeExecutionStore;
  readonly artefactStore: ArtefactStore;
  readonly actorDefinitionStore: ActorDefinitionStore;
  readonly commandDefinitionStore: CommandDefinitionStore;
  readonly commandWorkerBindingStore: CommandWorkerBindingStore;
  readonly commandProcessingContracts: CommandProcessingContractStore;
  readonly commandRuntimeHost: CommandRuntimeHost;
  readonly actorRoleAuthorityStore: ActorRoleAuthorityStore;
  readonly runtimeProfileStore: RuntimeProfileStore;
  readonly connectorStore: ConnectorStore;
  readonly approvalStore: ApprovalStore;
  readonly policyStore: PolicyStore;
  readonly budgetStore: BudgetStore;
  readonly auditStore: AuditStore;
  readonly extensionStore: ExtensionStore;
  readonly extensionRuntime: BusStoreExtensionRuntime;
  readonly runtimeProcessingContracts: RuntimeProcessingContractResolver;
  readonly workspaceIdentityStore: SqliteWorkspaceIdentityStore;
  readonly localHostId: string;
  readonly localOperatorPrincipalStore: SqliteLocalOperatorPrincipalStore;
  readonly localOperatorPrincipalId: string;
  readonly localWorkspacePlatform: WorkspaceLocatorPlatform;
  readonly operationInvocationLedger: SqliteOperationInvocationLedger;
  readonly capabilityGrantStore: SqliteCapabilityGrantStore;
  readonly secretRefStore: SqliteSecretRefStore;
  readonly credentialBrokerService: CredentialBrokerService;
  readonly credentialIngressStore: CredentialIngressStore;
  readonly attachmentIngressStore: AttachmentIngressStore;
  readonly transportCredentialStore: SqliteTransportCredentialStore;
  readonly operationAuthoritySessions: SqliteOperationAuthoritySessionStore;
  readonly operationAuthorityVerifier: OperationAuthorityVerifier;
  readonly clientIdentityStore: SqliteClientIdentityStore;
  readonly operationRegistry: SemanticOperationRegistry;
  readonly workspaceConfigurationImportStore: WorkspaceConfigurationImportStore;
  readonly contextOperationBackend: BusContextOperationBackend;
  readonly scopeOperationBackend: BusScopeOperationBackend;
  readonly approvalOperationBackend: BusApprovalOperationBackend;
  readonly workspaceOperationBackend: BusWorkspaceOperationBackend;
  readonly workspacePortabilityService: WorkspacePortabilityService;
  readonly endpointWatermarkStore: EndpointWatermarkStore;
  /** Broadcast function injected by the server after initialisation. */
  private broadcastFn: Broadcast | null = null;
  /** Single-shot timer scheduled to fire at the next lease expiry time (D5). */
  private leaseExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bounded once-per-process recovery; Command workers are push-driven after this scan. */
  private commandRecoveryStarted = false;
  /** Prevent deferred recovery or dispatch work from touching a closed SQLite handle. */
  private closed = false;

  constructor(configPath: string, readonly config: LocalConfig, options: BusStoreOptions = {}) {
    const dataDir = resolveLocalPath(configPath, config.home, config.bus.data_dir);
    mkdirSync(dataDir, { recursive: true });
    const databasePath = join(dataDir, "floe-bus.sqlite");
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    runDatabaseUpgrade({
      db: this.db,
      database_path: databasePath,
      migrate: () => this.migrate(),
    });
    this.localHostId = getOrCreateLocalHostIdentity(this.db).host_id;
    this.localOperatorPrincipalStore = new SqliteLocalOperatorPrincipalStore(this.db);
    this.localOperatorPrincipalId = this.localOperatorPrincipalStore.getOrCreate().principal_id;
    this.localWorkspacePlatform = process.platform === "win32" ? "windows" : "posix";
    this.workspaceIdentityStore = new SqliteWorkspaceIdentityStore(this.db);
    this.workspacePortabilityService = new WorkspacePortabilityService({
      db: this.db,
      database_path: databasePath,
      bundle_root: join(dataDir, "workspace-packages"),
      workspace_locator: (workspaceId) =>
        this.workspaceIdentityStore.getCurrentBinding(workspaceId, this.localHostId)?.locator ?? null,
      bind_workspace_locator: (workspaceId, locator) => {
        this.workspaceIdentityStore.bindLocator(workspaceId, {
          host_id: this.localHostId,
          platform: this.localWorkspacePlatform,
          locator,
          init_authorized: true,
        });
      },
    });
    this.contextStore = new ContextStore(this.db);
    this.scopeStore = new ScopeStore(this.db);
    this.scopeGraphStore = new ScopeGraphStore(this.db);
    this.scopeCompositionStore = new ScopeCompositionStore(this.db);
    this.scopeExecutionStore = new ScopeExecutionStore(this.db);
    this.artefactStore = new ArtefactStore(this.db);
    this.actorDefinitionStore = new ActorDefinitionStore(this.db, undefined, (actorId, workspaceId, grantIds) => {
      if (grantIds.length === 0) return;
      const inspection = this.capabilityGrantStore.inspectSessionGrantIds({ principal_id: actorId,
        boundary: { kind: "workspace", workspace_id: workspaceId }, grant_ids: grantIds });
      if (inspection.unavailable_grants.length > 0) {
        throw new ActorDefinitionValidationError(inspection.unavailable_grants
          .map(failure => `CapabilityGrant '${failure.grant_id}': ${failure.code}`).join("; "));
      }
    });
    this.commandDefinitionStore = new CommandDefinitionStore(this.db);
    this.commandWorkerBindingStore = new CommandWorkerBindingStore(this.db);
    this.commandProcessingContracts = new CommandProcessingContractStore(this.db);
    this.actorRoleAuthorityStore = new ActorRoleAuthorityStore(this.db);
    this.runtimeProfileStore = new RuntimeProfileStore(this.db, undefined, (binding, previous) => {
      // Imports can wrap binding changes in a larger synchronous savepoint.
      // Observe only the retained current binding after that savepoint settles.
      queueMicrotask(() => {
        if (this.closed) return;
        const current = this.runtimeProfileStore.getCurrentActorBinding(binding.actor_id);
        if (current?.actor_runtime_binding_id !== binding.actor_runtime_binding_id) return;
        // A retained binding can introduce an Actor with no Endpoint yet.
        // Notify attached Bridges independently of existing Endpoint readiness.
        this.broadcastFn?.("actor_runtime_binding_changed", {
          workspace_id: binding.workspace_id,
          actor_id: binding.actor_id,
          actor_runtime_binding_id: binding.actor_runtime_binding_id,
          endpoint_id: binding.endpoint_id,
          previous_endpoint_id: previous?.endpoint_id ?? null,
        });
        const endpointIds = new Set([binding.endpoint_id, previous?.endpoint_id]);
        for (const endpointId of endpointIds) {
          if (!endpointId) continue;
          const endpoint = this.getEndpoint(endpointId);
          if (!endpoint || endpoint.workspace_id !== binding.workspace_id || !endpoint.bridge_id
            || !["idle", "waiting", "runtime_unconfigured"].includes(endpoint.status)) continue;
          const status = this.runtimeProfileStore.getCurrentActorBindingForEndpoint(binding.workspace_id, endpointId)
            ? this.runtimeConfigurationStatus(binding.workspace_id, endpointId, endpoint.status)
            : "runtime_unconfigured";
          if (status !== endpoint.status) {
            this.updateEndpointStatus(endpointId, status, (type, payload) => this.broadcastFn?.(type, payload));
          }
        }
      });
    });
    this.connectorStore = new ConnectorStore(this.db);
    this.approvalStore = new ApprovalStore(this.db, {
      resolve_decision_authority: (input) => this.resolveApprovalDecisionAuthority(input),
      action_is_current: (input) => this.approvalActionIsCurrent(input),
    });
    this.policyStore = new PolicyStore(this.db);
    this.budgetStore = new BudgetStore(this.db);
    this.auditStore = new AuditStore(this.db);
    let extensionStore: ExtensionStore | null = null;
    const extensionBroker: ExtensionHostBroker = {
      availability: { operations: true, filesystem: false, network: false },
      invokeOperation: (input) => this.invokeBrokeredExtensionOperation(input),
      accessFilesystem: () => Promise.reject(new ExtensionSandboxError(
        "extension_filesystem_broker_unavailable",
        "Extension filesystem access must use a canonical granted operation; no filesystem broker is configured.",
      )),
      requestNetwork: () => Promise.reject(new ExtensionSandboxError(
        "extension_network_broker_unavailable",
        "Extension network access must use a canonical Connector action; no Connector broker is configured.",
      )),
    };
    const runtimeFactory = options.extension_runtime_factory
      ?? ((dependencies) => new CanonicalExtensionRuntime(dependencies));
    this.extensionRuntime = runtimeFactory({
      db: this.db,
      approvals: this.approvalStore,
      broker: extensionBroker,
      workspace_root: (workspaceId) =>
        this.workspaceIdentityStore.getCurrentBinding(workspaceId, this.localHostId)?.locator ?? null,
      quarantine: (input) => {
        if (!extensionStore) throw new Error("Extension store is not ready for quarantine evidence.");
        extensionStore.quarantineAfterHostCrash(input);
      },
    });
    extensionStore = new ExtensionStore(
      this.db,
      this.extensionRuntime.assurance,
      undefined,
      (workspaceId, extensionInstallationId) => this.workspacePortabilityService.hasUnresolvedDependency(
        workspaceId,
        "extension_runtime",
        extensionInstallationId,
      ),
    );
    this.extensionStore = extensionStore;
    this.commandRuntimeHost = options.command_runtime_host ?? new CanonicalCommandRuntimeHost(
      new IsolatedCoreCommandProcessHost(
        fileURLToPath(new URL("./isolated-command-host-process.js", import.meta.url)),
      ),
      this.extensionStore,
      this.extensionRuntime.entry_point_execution,
    );
    this.runtimeProcessingContracts = new RuntimeProcessingContractResolver({
      executions: this.scopeExecutionStore,
      compositions: this.scopeCompositionStore,
      actors: this.actorDefinitionStore,
      runtimes: this.runtimeProfileStore,
      artefacts: this.artefactStore,
      get_event: (eventId) => this.getEvent(eventId),
    });
    this.operationInvocationLedger = new SqliteOperationInvocationLedger(this.db);
    this.capabilityGrantStore = new SqliteCapabilityGrantStore(this.db);
    this.secretRefStore = new SqliteSecretRefStore(this.db);
    const credentialBrokers = process.platform === "win32"
      ? [new WindowsCredentialBroker(
          WINDOWS_DPAPI_CREDENTIAL_BROKER_ID,
          new WindowsDpapiCredentialProtector(),
        )]
      : [];
    this.credentialBrokerService = new CredentialBrokerService(
      this.secretRefStore,
      this.capabilityGrantStore,
      credentialBrokers,
    );
    this.credentialIngressStore = new CredentialIngressStore();
    this.attachmentIngressStore = new AttachmentIngressStore();
    this.transportCredentialStore = new SqliteTransportCredentialStore(this.db);
    this.operationAuthoritySessions = new SqliteOperationAuthoritySessionStore(
      this.db,
      this.capabilityGrantStore,
    );
    this.operationAuthorityVerifier = new OperationAuthorityVerifier(
      this.operationAuthoritySessions,
      this.capabilityGrantStore,
    );
    this.clientIdentityStore = new SqliteClientIdentityStore(this.db);
    let operationRegistry = registerArtefactOperations(
      new SemanticOperationRegistry(
        new AjvOperationSchemaValidator(),
        this.operationInvocationLedger,
        new BusOperationGovernanceControlPlane(this),
      ),
      this.artefactStore,
      input => this.publishArtefactVersion(input),
    );
    operationRegistry.register(exportArtefactVersionOperation(this.artefactStore,
      workspaceId => this.getWorkspaceLocator(workspaceId)));
    operationRegistry = registerActorDefinitionOperations(operationRegistry, this.actorDefinitionStore);
    for (const operation of capabilityGrantOperations({ actors: this.actorDefinitionStore,
      grants: this.capabilityGrantStore, refs: this.secretRefStore })) operationRegistry.register(operation);
    operationRegistry = registerCommandOperations(operationRegistry, this.commandDefinitionStore);
    operationRegistry = registerActorRoleOperations(operationRegistry, this.actorRoleAuthorityStore);
    this.contextOperationBackend = new BusContextOperationBackend(
      this,
      (type, payload = {}) => this.broadcastFn?.(type, payload),
    );
    operationRegistry = registerContextOperations(operationRegistry, this.contextOperationBackend);
    operationRegistry.register(cancelRuntimeDeliveryOperation({
      cancel: input => this.cancelRuntimeDelivery(input, (type, payload = {}) => this.broadcastFn?.(type, payload)),
    }));
    operationRegistry = registerRuntimeProfileOperations(operationRegistry, this.runtimeProfileStore);
    const authDir = resolveLocalPath(configPath, config.home, "./auth");
    operationRegistry = registerCredentialOperations(operationRegistry, {
      secret_refs: this.secretRefStore,
      capability_grants: this.capabilityGrantStore,
      broker: this.credentialBrokerService,
      legacy_source: new LegacyAuthCredentialSource(
        join(authDir, "profiles.yaml"),
        join(authDir, "auth.json"),
      ),
      ingress: this.credentialIngressStore,
      broker_id: WINDOWS_DPAPI_CREDENTIAL_BROKER_ID,
      expected_provider: (ref) => this.expectedCredentialProvider(ref),
      binding_changed: (ref, principalId) => this.reconcileCredentialBinding(ref, principalId),
    });
    for (const operation of runtimeCredentialAccessOperations({ actors: this.actorDefinitionStore, grants: this.capabilityGrantStore, refs: this.secretRefStore, access_revoked: (ref, principalId) => this.reconcileCredentialBinding(ref, principalId) })) operationRegistry.register(operation);
    operationRegistry = registerConnectorOperations(operationRegistry, this.connectorStore, this.approvalStore);
    this.approvalOperationBackend = new BusApprovalOperationBackend(this);
    operationRegistry = registerApprovalOperations(operationRegistry, this.approvalOperationBackend);
    operationRegistry = registerPolicyOperations(operationRegistry, this.policyStore);
    operationRegistry = registerBudgetOperations(operationRegistry, this.budgetStore);
    operationRegistry = registerAuditOperations(operationRegistry, this.auditStore);
    operationRegistry = registerExtensionOperations(
      operationRegistry,
      this.extensionStore,
      this.extensionRuntime.entry_point_execution,
    );
    this.workspaceOperationBackend = new BusWorkspaceOperationBackend(
      this,
      (type, payload = {}) => this.broadcastFn?.(type, payload),
    );
    operationRegistry = registerWorkspaceOperations(operationRegistry, this.workspaceOperationBackend);
    operationRegistry = registerWorkspacePortabilityOperations(
      operationRegistry,
      this.workspacePortabilityService,
    );
    this.scopeOperationBackend = new BusScopeOperationBackend(
      this,
      (type, payload = {}) => this.broadcastFn?.(type, payload),
    );
    this.operationRegistry = registerScopeOperations(operationRegistry, this.scopeOperationBackend);
    this.workspaceConfigurationImportStore = new WorkspaceConfigurationImportStore({
      db: this.db,
      actor_definitions: this.actorDefinitionStore,
      runtime_profiles: this.runtimeProfileStore,
      capability_grants: this.capabilityGrantStore,
      secret_refs: this.secretRefStore,
      local_host_id: this.localHostId,
      operation_registry: this.operationRegistry,
      policy_for_inventory: (workspaceId, inventory) => {
        const identity = this.workspaceIdentityStore.getIdentity(workspaceId);
        const configured = options.workspace_configuration_policy?.({
          workspace_id: workspaceId,
          creation_kind: identity?.creation_kind ?? null,
          init_authorized: this.workspaceIdentityStore.getCurrentBinding(workspaceId, this.localHostId)?.init_authorized ?? false,
          inventory,
        });
        return configured ?? legacyWorkspaceConfigurationImportPolicy(
          workspaceId,
          identity?.creation_kind ?? null,
          inventory,
        );
      },
      require_current_binding: (workspaceId, bindingId) => {
        const binding = this.workspaceIdentityStore.getCurrentBinding(workspaceId, this.localHostId);
        if (!binding || binding.binding_id !== bindingId) {
          throw new Error("Workspace binding is not current.");
        }
      },
    });
    this.endpointWatermarkStore = new EndpointWatermarkStore(this.db);
    this.importLegacyScopeCompositions();
  }

  /**
   * Inject the broadcast function so the store can drive lease-expiry requeue
   * without being handed `broadcast` on every call (D5).
   */
  setBroadcast(fn: Broadcast): void {
    if (this.closed) return;
    this.broadcastFn = fn;
    if (!this.commandRecoveryStarted) {
      this.commandRecoveryStarted = true;
      queueMicrotask(() => {
        if (!this.closed) this.recoverCanonicalCommandDeliveries(fn);
      });
    }
    // Start the lease-expiry scheduler now that we have broadcast available.
    this.scheduleNextLeaseExpiryCheck();
  }

  private async invokeBrokeredExtensionOperation(
    input: Parameters<ExtensionHostBroker["invokeOperation"]>[0],
  ): Promise<JsonValue> {
    const target = input.target ? { kind: input.target.kind, id: input.target.id } : null;
    const resolved = this.capabilityGrantStore.resolveSessionAuthority({
      principal_id: input.context.authorized_principal_id,
      boundary: { kind: "workspace", workspace_id: input.context.workspace_id },
      grant_ids: input.context.capability_grant_ids,
      interaction: {
        mode: "brokered",
        session_id: `extension:${input.context.operation_invocation_id}`,
        broker_id: "extension-host:quickjs-process:v1",
        confirmed_prompts: [],
        approval_refs: [],
      },
    }, target);
    if (resolved.unavailable_grants.length > 0) {
      throw new ExtensionSandboxError(
        "extension_capability_grant_unavailable",
        "An Extension CapabilityGrant is missing, expired, revoked, or outside this Workspace.",
      );
    }
    if (!resolved.authority.grants.has(input.operation_id)) {
      throw new ExtensionSandboxError(
        "extension_operation_grant_denied",
        "The active CapabilityGrants do not authorise this canonical operation.",
      );
    }
    const contract = this.operationRegistry.listCurrentOperationMetadata({
      interaction_mode: "brokered",
      boundary_kind: "workspace",
    }).find((item) => item.operation_id === input.operation_id);
    if (!contract) {
      throw new ExtensionSandboxError(
        "extension_operation_contract_unavailable",
        "The requested canonical operation is not available to brokered Extension execution.",
      );
    }
    const idempotency = stableHash(canonicalJson({
      parent_invocation_id: input.context.operation_invocation_id,
      extension_package_version_id: input.context.extension_package_version_id,
      permission_id: input.permission_id,
      operation_id: input.operation_id,
      target: input.target,
      input: input.input,
    }));
    const response = await this.operationRegistry.invoke({
      authority: resolved.authority,
      provenance: {
        cause_event_id: null,
        delivery_ids: [],
        execution_attempt_id: input.context.execution_attempt_id,
        node_execution_id: null,
        scope_execution_id: null,
      },
      resolve_resource: (resource) => this.resolveOperationResource(resource, resolved.authority.boundary),
    }, {
      operation_id: input.operation_id,
      operation_version: contract.operation_version,
      input_schema_version: "1",
      input: input.input,
      idempotency_key: `extension:${idempotency}`,
      ...(input.target ? {
        target: { kind: input.target.kind, id: input.target.id },
        expected_resource_revision: input.target.revision ?? undefined,
      } : {}),
    });
    if (response.kind !== "receipt" || response.receipt.state !== "completed") {
      const code = response.kind === "receipt"
        ? response.receipt.refusal?.code ?? `extension_nested_operation_${response.receipt.state}`
        : response.refusal.code;
      const message = response.kind === "receipt"
        ? response.receipt.refusal?.message ?? "The nested canonical operation did not complete synchronously."
        : response.refusal.message;
      throw new ExtensionSandboxError(code, message);
    }
    try {
      return JSON.parse(JSON.stringify(response.receipt.result ?? null)) as JsonValue;
    } catch {
      throw new ExtensionSandboxError(
        "extension_operation_result_not_json",
        "The canonical operation returned a result that cannot cross the Extension host boundary.",
      );
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.broadcastFn = null;
    if (this.leaseExpiryTimer !== null) {
      clearTimeout(this.leaseExpiryTimer);
      this.leaseExpiryTimer = null;
    }
    this.commandRuntimeHost.terminateAll();
    this.extensionRuntime.terminateAll();
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        creation_kind TEXT NOT NULL CHECK (creation_kind IN ('created', 'legacy_retained', 'copied', 'forked')),
        source_workspace_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (creation_kind IN ('created', 'legacy_retained') AND source_workspace_id IS NULL)
          OR (creation_kind IN ('copied', 'forked') AND source_workspace_id IS NOT NULL)
        )
      );

      CREATE TABLE IF NOT EXISTS bridges (
        bridge_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS endpoints (
        endpoint_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        agent_id TEXT,
        bridge_id TEXT,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        source_endpoint_id TEXT,
        thread_id TEXT NOT NULL,
        scope_id TEXT,
        correlation_id TEXT,
        destination_json TEXT NOT NULL,
        content_json TEXT NOT NULL,
        response_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        idempotency_key TEXT,
        created_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idempotency
        ON events(idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS event_queue (
        queue_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        destination_endpoint_id TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivery_id TEXT,
        lease_expires_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        delivered_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_event_queue_destination
        ON event_queue(destination_endpoint_id, state, created_at);

      CREATE TABLE IF NOT EXISTS delivery_bundles (
        delivery_id TEXT PRIMARY KEY,
        endpoint_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        trigger_event_id TEXT NOT NULL,
        events_json TEXT NOT NULL,
        state TEXT NOT NULL,
        lease_expires_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 1,
        last_error TEXT,
        created_at TEXT NOT NULL,
        claimed_at TEXT,
        operation_authority_session_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_delivery_bundles_endpoint
        ON delivery_bundles(endpoint_id, state, created_at);

      CREATE TABLE IF NOT EXISTS pending_responses (
        pending_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        waiting_endpoint_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        thread_id TEXT,
        correlation_id TEXT,
        timeout_at TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_pending_waiting_endpoint
        ON pending_responses(waiting_endpoint_id, status, created_at);

      CREATE TABLE IF NOT EXISTS runtime_telemetry (
        telemetry_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        endpoint_id TEXT NOT NULL,
        delivery_id TEXT,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS saved_configs (
        config_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_bindings (
        binding_key TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        workspace_id TEXT,
        endpoint_id TEXT,
        auth_profile TEXT NOT NULL,
        provider TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_runtime_bindings_workspace
        ON runtime_bindings(workspace_id, scope, endpoint_id);

      CREATE TABLE IF NOT EXISTS pulses (
        pulse_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        persistence TEXT NOT NULL DEFAULT 'local',
        scope_id TEXT,
        trigger_json TEXT NOT NULL,
        content_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        next_fire_at TEXT,
        last_fired_at TEXT,
        fire_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_pulses_workspace
        ON pulses(workspace_id, status);

      CREATE INDEX IF NOT EXISTS idx_pulses_next_fire
        ON pulses(status, next_fire_at);

      CREATE TABLE IF NOT EXISTS pulse_subscribers (
        pulse_id TEXT NOT NULL,
        subscriber_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (pulse_id, subscriber_json)
      );

      CREATE TABLE IF NOT EXISTS pulse_delivery_contexts (
        pulse_id TEXT NOT NULL,
        subscriber_key TEXT NOT NULL,
        context_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        endpoint_ref TEXT NOT NULL,
        endpoint_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (pulse_id, subscriber_key)
      );

      CREATE INDEX IF NOT EXISTS idx_pulse_delivery_contexts_context
        ON pulse_delivery_contexts(context_id);
    `);
    this.addColumnIfMissing("events", "destination_endpoint_id", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("events", "destination_json", "TEXT");
    this.addColumnIfMissing("events", "response_json", "TEXT");
    this.addColumnIfMissing("events", "context_id", "TEXT");
    this.addColumnIfMissing("events", "scope_id", "TEXT");
    this.relaxEventScopeColumn();
    this.addColumnIfMissing("delivery_bundles", "wait_id", "TEXT");
    this.addColumnIfMissing("delivery_bundles", "resume_reason", "TEXT NOT NULL DEFAULT 'event'");
    this.addColumnIfMissing("delivery_bundles", "stable_delivery_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("delivery_bundles", "execution_attempt_id", "TEXT");
    this.addColumnIfMissing("delivery_bundles", "actor_definition_revision_id", "TEXT");
    this.addColumnIfMissing("delivery_bundles", "runtime_profile_revision_id", "TEXT");
    this.addColumnIfMissing("delivery_bundles", "actor_runtime_binding_id", "TEXT");
    this.addColumnIfMissing("delivery_bundles", "command_definition_revision_id", "TEXT");
    this.addColumnIfMissing("delivery_bundles", "command_worker_binding_id", "TEXT");
    this.addColumnIfMissing("event_queue", "scope_execution_id", "TEXT");
    this.addColumnIfMissing("event_queue", "composition_revision_id", "TEXT");
    this.addColumnIfMissing("event_queue", "source_node_id", "TEXT");
    this.addColumnIfMissing("event_queue", "source_port_id", "TEXT");
    this.addColumnIfMissing("event_queue", "target_node_id", "TEXT");
    this.addColumnIfMissing("event_queue", "target_port_id", "TEXT");
    this.addColumnIfMissing("event_queue", "edge_id", "TEXT");
    this.addColumnIfMissing("event_queue", "node_execution_id", "TEXT");
    this.addColumnIfMissing("event_queue", "output_publication_id", "TEXT");
    this.addColumnIfMissing("event_queue", "actor_definition_revision_id", "TEXT");
    this.addColumnIfMissing("event_queue", "runtime_profile_revision_id", "TEXT");
    this.addColumnIfMissing("event_queue", "actor_runtime_binding_id", "TEXT");
    this.addColumnIfMissing("runtime_telemetry", "delivery_id", "TEXT");
    this.addColumnIfMissing("runtime_bindings", "model", "TEXT");
    this.addColumnIfMissing("runtime_bindings", "thinking_level", "TEXT");
    this.addColumnIfMissing("pulses", "persistence", "TEXT NOT NULL DEFAULT 'local'");
    this.addColumnIfMissing("pulses", "scope_id", "TEXT");
    this.relaxPulseScopeColumn();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_pulses_workspace_scope
        ON pulses(workspace_id, scope_id, status);
    `);
    applyContextSchema(this.db);
    applyScopeSchema(this.db);
    applyScopeCompositionSchema(this.db);
    applyScopeExecutionSchema(this.db);
    this.addColumnIfMissing("scope_executions", "cause_event_id", "TEXT");
    this.addColumnIfMissing("runtime_bindings", "provider", "TEXT");
    applyArtefactSchema(this.db);
    this.freezeEventArtefactReferences();
    applyActorDefinitionSchema(this.db);
    applyCommandDefinitionSchema(this.db);
    applyCommandRuntimeSchema(this.db);
    applyActorRoleAuthoritySchema(this.db);
    applyRuntimeProfileSchema(this.db);
    applyConnectorSchema(this.db);
    applyApprovalSchema(this.db);
    applyPolicySchema(this.db);
    applyBudgetSchema(this.db);
    applyAuditSchema(this.db);
    applyExtensionSchema(this.db);
    applyExtensionActivationAttemptSchema(this.db);
    applyExtensionRuntimeAuditSchema(this.db);
    applyOperationInvocationLedgerSchema(this.db);
    applyCapabilityGrantSchema(this.db);
    applyCredentialBrokerSchema(this.db);
    applyTransportCredentialSchema(this.db);
    applyTransportPushStreamSchema(this.db);
    applyLocalOperatorPrincipalSchema(this.db);
    applyOperationAuthoritySessionSchema(this.db);
    applyClientIdentitySchema(this.db);
    applyDeliveryOperationAuthoritySchema(this.db);
    applyWorkspaceConfigurationImportSchema(this.db);
    applyWorkspacePortabilitySchema(this.db);
    applyScopeGraphSchema(this.db);
    applyEndpointWatermarkSchema(this.db);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_workspace_created
        ON events(workspace_id, created_at, event_id);
    `);
    this.backfillEventDestinationJson();
    this.backfillEventResponseJson();
    this.backfillEventScopeId();
    const localHost = getOrCreateLocalHostIdentity(this.db);
    const workspaceIdentityPlan = planWorkspaceIdentityMigration(this.db, {
      host_id: localHost.host_id,
      platform: process.platform === "win32" ? "windows" : "posix",
    });
    applyWorkspaceIdentityMigration(this.db, workspaceIdentityPlan);
  }

  private importLegacyScopeCompositions(): void {
    const workspaces = this.db.prepare(`SELECT workspace_id FROM workspaces`).all() as Array<{ workspace_id: string }>;
    for (const workspace of workspaces) {
      for (const graph of this.scopeGraphStore.listScopeGraphsForWorkspace(workspace.workspace_id)) {
        if (this.scopeCompositionStore.listRevisions(workspace.workspace_id, graph.scope_id).length > 0) continue;
        importLegacyScopeGraph(this.scopeCompositionStore, graph);
      }
    }
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private relaxEventScopeColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(events)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const scope = columns.find((item) => item.name === "scope_id");
    if (scope?.notnull !== 1 && scope?.dflt_value == null) return;

    this.db.exec(`
      CREATE TABLE events_next (
        event_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        source_endpoint_id TEXT,
        destination_endpoint_id TEXT NOT NULL DEFAULT '',
        thread_id TEXT NOT NULL,
        context_id TEXT,
        scope_id TEXT,
        correlation_id TEXT,
        destination_json TEXT,
        content_json TEXT NOT NULL,
        response_json TEXT,
        metadata_json TEXT NOT NULL,
        idempotency_key TEXT,
        created_at TEXT NOT NULL
      );

      INSERT INTO events_next (
        event_id, type, workspace_id, source_endpoint_id, destination_endpoint_id, thread_id, context_id,
        scope_id, correlation_id, destination_json, content_json, response_json, metadata_json, idempotency_key, created_at
      )
      SELECT
        event_id,
        type,
        workspace_id,
        source_endpoint_id,
        COALESCE(destination_endpoint_id, ''),
        thread_id,
        context_id,
        NULLIF(scope_id, 'default'),
        correlation_id,
        destination_json,
        content_json,
        response_json,
        metadata_json,
        idempotency_key,
        created_at
      FROM events;

      DROP TABLE events;
      ALTER TABLE events_next RENAME TO events;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idempotency
        ON events(idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);
  }

  private relaxPulseScopeColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(pulses)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const scope = columns.find((item) => item.name === "scope_id");
    if (scope?.notnull !== 1 && scope?.dflt_value == null) return;

    this.db.exec(`
      CREATE TABLE pulses_next (
        pulse_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        persistence TEXT NOT NULL DEFAULT 'local',
        scope_id TEXT,
        trigger_json TEXT NOT NULL,
        content_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        next_fire_at TEXT,
        last_fired_at TEXT,
        fire_count INTEGER NOT NULL DEFAULT 0
      );

      INSERT INTO pulses_next (
        pulse_id, workspace_id, persistence, scope_id, trigger_json, content_json, status,
        created_by, created_at, updated_at, next_fire_at, last_fired_at, fire_count
      )
      SELECT
        pulse_id,
        workspace_id,
        persistence,
        NULLIF(scope_id, 'default'),
        trigger_json,
        content_json,
        status,
        created_by,
        created_at,
        updated_at,
        next_fire_at,
        last_fired_at,
        fire_count
      FROM pulses;

      DROP TABLE pulses;
      ALTER TABLE pulses_next RENAME TO pulses;

      CREATE INDEX IF NOT EXISTS idx_pulses_workspace
        ON pulses(workspace_id, status);

      CREATE INDEX IF NOT EXISTS idx_pulses_next_fire
        ON pulses(status, next_fire_at);

      CREATE INDEX IF NOT EXISTS idx_pulses_workspace_scope
        ON pulses(workspace_id, scope_id, status);
    `);
  }

  private backfillEventDestinationJson(): void {
    this.db.exec(`
      UPDATE events
      SET destination_json = json_object('kind','endpoint','endpoint_id',destination_endpoint_id)
      WHERE (destination_json IS NULL OR destination_json = '')
        AND destination_endpoint_id IS NOT NULL
    `);
  }

  private backfillEventResponseJson(): void {
    this.db.exec(`
      UPDATE events
      SET response_json = '{"expected":false,"mode":"open","correlation_id":null,"timeout_at":null}'
      WHERE response_json IS NULL OR response_json = ''
    `);
  }

  private backfillEventScopeId(): void {
    this.db.exec(`
      UPDATE events
      SET scope_id = (
        SELECT contexts.scope_id
        FROM contexts
        WHERE contexts.context_id = events.context_id
      )
      WHERE context_id IS NOT NULL
    `);
  }

  listWorkspaces(): LocalWorkspaceRecord[] {
    return this.workspaceIdentityStore.listLocalProjections(this.localHostId).map(localWorkspaceRecord);
  }

  listRemoteWorkspaces(): RemoteWorkspaceProjection[] {
    return this.workspaceIdentityStore.listRemoteProjections(this.localHostId);
  }

  registerWorkspace(
    input: { locator: string; name?: string; init_authorized?: boolean },
    broadcast: Broadcast,
  ): LocalWorkspaceRecord {
    let identity = this.workspaceIdentityStore.resolveWorkspaceByLocator(
      this.localHostId,
      this.localWorkspacePlatform,
      input.locator,
    );
    if (identity) {
      if (input.name?.trim()) {
        identity = this.workspaceIdentityStore.updateWorkspaceName(identity.workspace_id, input.name);
      }
      const binding = this.workspaceIdentityStore.getCurrentBinding(identity.workspace_id, this.localHostId);
      if (binding && input.init_authorized && !binding.init_authorized) {
        this.workspaceIdentityStore.updateCurrentBinding({
          workspace_id: identity.workspace_id,
          host_id: this.localHostId,
          expected_binding_id: binding.binding_id,
          init_authorized: true,
        });
      }
    } else {
      const name = input.name?.trim() || input.locator.split(/[\\/]/).filter(Boolean).at(-1) || "Workspace";
      identity = this.workspaceIdentityStore.createWorkspace({
        name,
        binding: {
          host_id: this.localHostId,
          platform: this.localWorkspacePlatform,
          locator: input.locator,
          init_authorized: input.init_authorized,
        },
      });
    }
    const workspace = this.requireLocalWorkspace(identity.workspace_id);
    const remoteWorkspace = this.workspaceIdentityStore.getRemoteProjection(identity.workspace_id, this.localHostId);
    broadcast("workspace_registered", { workspace: remoteWorkspace });
    broadcast("workspace_attachment_requested", { workspace_id: identity.workspace_id });
    return workspace;
  }

  selectWorkspace(workspaceId: string, broadcast: Broadcast): LocalWorkspaceRecord {
    this.workspaceIdentityStore.selectLocalWorkspace(workspaceId, this.localHostId);
    const workspace = this.requireLocalWorkspace(workspaceId);
    broadcast("workspace_selected", {
      workspace: this.workspaceIdentityStore.getRemoteProjection(workspaceId, this.localHostId),
    });
    broadcast("workspace_attachment_requested", { workspace_id: workspaceId });
    return workspace;
  }

  getWorkspace(workspaceId: string): LocalWorkspaceRecord | null {
    const projection = this.workspaceIdentityStore.getLocalProjection(workspaceId, this.localHostId);
    return projection ? localWorkspaceRecord(projection) : null;
  }

  getRemoteWorkspace(workspaceId: string): RemoteWorkspaceProjection | null {
    return this.workspaceIdentityStore.getRemoteProjection(workspaceId, this.localHostId);
  }

  getWorkspaceLocator(workspaceId: string): string | null {
    return this.workspaceIdentityStore.getCurrentBinding(workspaceId, this.localHostId)?.locator ?? null;
  }

  rebindWorkspace(input: {
    workspace_id: string;
    locator: string;
    expected_binding_id: string;
    init_authorized?: boolean;
  }, broadcast: Broadcast): LocalWorkspaceRecord {
    this.workspaceIdentityStore.rebindLocator({
      workspace_id: input.workspace_id,
      host_id: this.localHostId,
      platform: this.localWorkspacePlatform,
      locator: input.locator,
      expected_binding_id: input.expected_binding_id,
      init_authorized: input.init_authorized,
    });
    const workspace = this.requireLocalWorkspace(input.workspace_id);
    broadcast("workspace_rebound", {
      workspace: this.workspaceIdentityStore.getRemoteProjection(input.workspace_id, this.localHostId),
    });
    broadcast("workspace_attachment_requested", { workspace_id: input.workspace_id });
    return workspace;
  }

  restoreWorkspaceIdentity(input: {
    snapshot: Parameters<SqliteWorkspaceIdentityStore["restoreWorkspace"]>[0]["snapshot"];
    locator: string;
    init_authorized?: boolean;
  }, broadcast: Broadcast): LocalWorkspaceRecord {
    const identity = this.workspaceIdentityStore.restoreWorkspace({
      snapshot: input.snapshot,
      binding: {
        host_id: this.localHostId,
        platform: this.localWorkspacePlatform,
        locator: input.locator,
        init_authorized: input.init_authorized,
      },
    });
    const workspace = this.requireLocalWorkspace(identity.workspace_id);
    broadcast("workspace_restored", {
      workspace: this.workspaceIdentityStore.getRemoteProjection(identity.workspace_id, this.localHostId),
    });
    broadcast("workspace_attachment_requested", { workspace_id: identity.workspace_id });
    return workspace;
  }

  deriveWorkspaceIdentity(input: {
    source_workspace_id: string;
    kind: "copied" | "forked";
    name: string;
    locator: string;
    init_authorized?: boolean;
  }, broadcast: Broadcast): LocalWorkspaceRecord {
    const identity = this.workspaceIdentityStore.createDerivedWorkspace({
      source_workspace_id: input.source_workspace_id,
      kind: input.kind,
      name: input.name,
      binding: {
        host_id: this.localHostId,
        platform: this.localWorkspacePlatform,
        locator: input.locator,
        init_authorized: input.init_authorized,
      },
    });
    const workspace = this.requireLocalWorkspace(identity.workspace_id);
    broadcast(input.kind === "copied" ? "workspace_copy_identity_created" : "workspace_fork_identity_created", {
      workspace: this.workspaceIdentityStore.getRemoteProjection(identity.workspace_id, this.localHostId),
      source_workspace_id: input.source_workspace_id,
    });
    broadcast("workspace_attachment_requested", { workspace_id: identity.workspace_id });
    return workspace;
  }

  private requireLocalWorkspace(workspaceId: string): LocalWorkspaceRecord {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Unknown workspace_id: ${workspaceId}`);
    return workspace;
  }

  listScopes(workspaceId: string): ScopeRecord[] {
    return this.scopeStore.listScopes(workspaceId);
  }

  getScope(workspaceId: string, scopeId: string): ScopeRecord | null {
    return this.scopeStore.getScope(workspaceId, scopeId);
  }

  createScope(input: {
    workspace_id: string;
    scope_id?: string;
    title: string;
    description?: string | null;
  }, broadcast: Broadcast): ScopeRecord {
    const scope = this.scopeStore.createScope(input);
    broadcast("scope_created", { scope });
    return scope;
  }

  updateScope(input: {
    workspace_id: string;
    scope_id: string;
    title?: string;
    description?: string | null;
  }, broadcast: Broadcast): ScopeRecord | null {
    const scope = this.scopeStore.updateScope(input);
    if (scope) broadcast("scope_updated", { scope });
    return scope;
  }

  deleteScope(workspaceId: string, scopeId: string, broadcast: Broadcast): void {
    const scope = this.scopeStore.getScope(workspaceId, scopeId);
    if (!scope) {
      throw new ScopeNotFoundError(workspaceId, scopeId);
    }
    if (scopeId === RESERVED_DEFAULT_SCOPE_ID) {
      throw new ScopeReservedIdError(workspaceId, scopeId);
    }
    const contextCount = this.contextStore.listContextsForScope(workspaceId, scopeId).length;
    const pulseCount = this.listPulses({ workspace_id: workspaceId, scope_id: scopeId }).length;
    if (contextCount > 0 || pulseCount > 0) {
      throw new ScopeNotEmptyError(workspaceId, scopeId, contextCount, pulseCount);
    }
    this.scopeStore.deleteScope(workspaceId, scopeId);
    broadcast("scope_deleted", { workspace_id: workspaceId, scope_id: scopeId });
  }

  /**
   * Removes a Scope that has never recorded work. This is deliberately stricter
   * than destructive Context deletion: authored routing and empty Contexts are
   * discarded, while any historical Event or Pulse blocks the operation.
   */
  removeUnusedScope(workspaceId: string, scopeId: string, broadcast: Broadcast): {
    ok: true;
    workspace_id: string;
    scope_id: string;
    graph_count: number;
    context_count: number;
  } {
    const scope = this.scopeStore.getScope(workspaceId, scopeId);
    if (!scope) throw new ScopeNotFoundError(workspaceId, scopeId);
    if (scopeId === RESERVED_DEFAULT_SCOPE_ID) throw new ScopeReservedIdError(workspaceId, scopeId);

    const contexts = this.contextStore.listContextsForScope(workspaceId, scopeId);
    const eventCount = Number((this.db.prepare(`
      SELECT count(*) AS count
      FROM events e
      JOIN contexts c ON c.context_id = e.context_id
      WHERE c.workspace_id = ? AND c.scope_id = ?
    `).get(workspaceId, scopeId) as { count: number }).count);
    const pulses = this.listPulses({ workspace_id: workspaceId, scope_id: scopeId });
    if (eventCount > 0 || pulses.length > 0) {
      throw new ScopeRemovalBlockedError(workspaceId, scopeId, eventCount, pulses.length);
    }

    const graphs = this.scopeGraphStore.listScopeGraphs(workspaceId, scopeId);
    const commandEndpointIds = Array.from(new Set(graphs.flatMap((graph) =>
      graph.nodes
        .filter((node): node is Extract<ScopeGraphNode, { kind: "command" }> => node.kind === "command")
        .map((node) => node.endpoint_id)
    )));
    const removableEndpointStatuses = new Set(["idle", "offline", "error", "runtime_unconfigured", "retired"]);
    const busyCommandEndpointCount = commandEndpointIds.filter((endpointId) => {
      const endpoint = this.getEndpoint(endpointId);
      return endpoint && !removableEndpointStatuses.has(String(endpoint.status));
    }).length;
    if (busyCommandEndpointCount > 0) {
      throw new ScopeRemovalBlockedError(workspaceId, scopeId, eventCount, pulses.length, busyCommandEndpointCount);
    }

    this.transaction(() => {
      for (const assignment of this.actorRoleAuthorityStore.listRoleAssignments(workspaceId, {
        boundary: { kind: "scope", scope_id: scopeId },
      })) {
        this.actorRoleAuthorityStore.revokeRoleAssignment({
          workspace_id: workspaceId,
          actor_role_assignment_id: assignment.actor_role_assignment_id,
          revoked_by_principal_id: "system:unused-scope-removal",
          reason: "Unused Scope removed",
        });
      }
      for (const context of contexts) {
        for (const participant of this.contextStore.getContextParticipantRecords(context.context_id)) {
          if (!participant.actor_role_assignment_id) continue;
          this.actorRoleAuthorityStore.revokeRoleAssignment({
            workspace_id: workspaceId,
            actor_role_assignment_id: participant.actor_role_assignment_id,
            revoked_by_principal_id: "system:unused-scope-removal",
            reason: "Unused Scope Context removed",
          });
        }
        this.db.prepare("UPDATE contexts SET parent_context_id = NULL WHERE parent_context_id = ?").run(context.context_id);
        this.db.prepare("DELETE FROM context_subscriptions WHERE context_id = ?").run(context.context_id);
        this.db.prepare("DELETE FROM context_participants WHERE context_id = ?").run(context.context_id);
        this.db.prepare("DELETE FROM contexts WHERE context_id = ?").run(context.context_id);
      }
      this.db.prepare("DELETE FROM scope_graphs WHERE workspace_id = ? AND scope_id = ?").run(workspaceId, scopeId);
      for (const endpointId of commandEndpointIds) {
        this.db.prepare("DELETE FROM event_queue WHERE destination_endpoint_id = ?").run(endpointId);
        this.db.prepare("DELETE FROM runtime_bindings WHERE endpoint_id = ?").run(endpointId);
        this.db.prepare("DELETE FROM endpoint_watermarks WHERE endpoint_id = ?").run(endpointId);
        this.db.prepare("DELETE FROM endpoints WHERE endpoint_id = ?").run(endpointId);
      }
      this.scopeStore.deleteScope(workspaceId, scopeId);
    });

    for (const context of contexts) {
      broadcast("context_deleted", {
        ok: true,
        context_id: context.context_id,
        workspace_id: workspaceId,
        events_deleted: 0,
        delivery_bundles_deleted: 0,
        pulse_subscribers_deleted: 0,
      });
    }
    for (const graph of graphs) {
      broadcast("scope_graph_deleted", {
        workspace_id: workspaceId,
        scope_id: scopeId,
        graph_id: graph.graph_id,
      });
    }
    for (const endpointId of commandEndpointIds) {
      broadcast("endpoint_deleted", { endpoint_id: endpointId });
    }
    broadcast("scope_deleted", { workspace_id: workspaceId, scope_id: scopeId });
    return {
      ok: true,
      workspace_id: workspaceId,
      scope_id: scopeId,
      graph_count: graphs.length,
      context_count: contexts.length,
    };
  }

  listScopeGraphs(workspaceId: string, scopeId: string): ScopeGraphRecord[] {
    return this.scopeGraphStore.listScopeGraphs(workspaceId, scopeId);
  }

  /** Current compositions across active Scopes — used by the bridge at attach time. */
  listScopeGraphsForWorkspace(workspaceId: string): ScopeGraphRecord[] {
    return this.scopeStore.listScopes(workspaceId)
      .filter((scope) => scope.status === "active")
      .flatMap((scope) => {
        const current = this.scopeGraphStore.getScopeGraphForScope(workspaceId, scope.scope_id);
        return current ? [current] : [];
      });
  }

  getScopeGraph(workspaceId: string, graphId: string): ScopeGraphRecord | null {
    return this.scopeGraphStore.getScopeGraph(workspaceId, graphId);
  }

  getScopeGraphForScope(workspaceId: string, scopeId: string): ScopeGraphRecord | null {
    return this.scopeGraphStore.getScopeGraphForScope(workspaceId, scopeId);
  }

  createScopeCompositionDraft(input: {
    workspace_id: string;
    scope_id: string;
    routing_mode?: ScopeCompositionRoutingMode;
    based_on_revision_id?: string | null;
    created_by_endpoint_id?: string | null;
    content: ScopeCompositionContent;
  }, broadcast: Broadcast): ScopeCompositionRevision {
    if (!this.scopeStore.getScope(input.workspace_id, input.scope_id)) {
      throw new ScopeNotFoundError(input.workspace_id, input.scope_id);
    }
    const revision = this.scopeCompositionStore.createDraft(input);
    broadcast("scope_composition_draft_created", { revision });
    return revision;
  }

  replaceScopeCompositionDraft(
    revisionId: string,
    content: ScopeCompositionContent,
    broadcast: Broadcast,
    expectedDigest?: string,
  ): ScopeCompositionRevision {
    const revision = this.scopeCompositionStore.replaceDraft(revisionId, content, expectedDigest);
    broadcast("scope_composition_draft_updated", { revision });
    return revision;
  }

  publishScopeComposition(input: {
    revision_id: string;
    expected_published_revision_id?: string | null;
    expected_impact_digest?: string;
  }, broadcast: Broadcast): ScopeCompositionRevision {
    const draft = this.scopeCompositionStore.getRevision(input.revision_id);
    if (!draft) throw new ScopeExecutionInvalidError(`Scope composition revision '${input.revision_id}' does not exist`);
    this.validateFixedScopeContexts(draft);
    this.validateCommandPlacementsForPublication(draft);
    const revision = this.scopeCompositionStore.publishDraft(input);
    broadcast("scope_composition_published", { revision });
    const scope = this.scopeStore.getScope(revision.workspace_id, revision.scope_id);
    if (scope) broadcast("scope_updated", { scope });
    return revision;
  }

  assessScopeCompositionImpact(revisionId: string): ScopeCompositionImpact {
    return this.scopeCompositionStore.assessImpact(revisionId);
  }

  inspectScopeCompositionValidation(revision: ScopeCompositionRevision): ScopeCompositionValidation {
    const structural = inspectScopeStructure(revision, revision.routing_mode);
    if (!structural.valid) return structural;
    try {
      this.validateFixedScopeContexts(revision);
      return structural;
    } catch (error) {
      if (!(error instanceof ScopeCompositionInvalidError)) throw error;
      return { valid: false, semantic_digest: null, diagnostics: [{
        severity: "error", code: error.code, message: error.message, resource_ids: [],
      }] };
    }
  }

  private fixedScopeContextAvailable(revision: ScopeCompositionRevision, contextId: string): boolean {
    const context = this.contextStore.getContext(contextId);
    return !!context && context.workspace_id === revision.workspace_id && context.scope_id === revision.scope_id
      && context.lifecycle_state === "active" && context.content_state === "available";
  }

  private validateFixedScopeContexts(revision: ScopeCompositionRevision): void {
    for (const node of revision.nodes) {
      if (node.context_policy?.mode === "fixed" && !this.fixedScopeContextAvailable(revision, node.context_policy.context_id)) {
        throw new ScopeCompositionInvalidError(`fixed Context '${node.context_policy.context_id}' for node '${node.node_id}' is unavailable in this Scope`);
      }
    }
  }

  rollbackScopeComposition(input: {
    target_revision_id: string;
    expected_published_revision_id: string;
    expected_impact_digest: string;
  }, broadcast: Broadcast): ScopeCompositionRevision {
    const target = this.scopeCompositionStore.getRevision(input.target_revision_id);
    if (!target) throw new ScopeExecutionInvalidError(`Scope composition revision '${input.target_revision_id}' does not exist`);
    this.validateFixedScopeContexts(target);
    this.validateCommandPlacementsForPublication(target);
    const revision = this.scopeCompositionStore.rollbackPublishedRevision(input);
    broadcast("scope_composition_rolled_back", { revision });
    const scope = this.scopeStore.getScope(revision.workspace_id, revision.scope_id);
    if (scope) broadcast("scope_updated", { scope });
    return revision;
  }

  cloneScopeCompositionRevision(input: {
    source_revision_id: string;
    target_workspace_id: string;
    target_scope_id: string;
    created_by_endpoint_id?: string | null;
  }, broadcast: Broadcast): ScopeCompositionRevision {
    const revision = this.scopeCompositionStore.cloneRevision(input);
    broadcast("scope_composition_draft_created", { revision });
    return revision;
  }

  exportScopeCompositionRevision(revisionId: string): PortableScopeComposition {
    return this.scopeCompositionStore.exportRevision(revisionId);
  }

  importScopeCompositionRevision(input: {
    target_workspace_id: string;
    target_scope_id: string;
    portable: PortableScopeComposition;
    created_by_endpoint_id?: string | null;
  }, broadcast: Broadcast): ScopeCompositionRevision {
    const revision = this.scopeCompositionStore.importRevision(input);
    broadcast("scope_composition_draft_created", { revision });
    return revision;
  }

  getScopeCompositionRevision(revisionId: string): ScopeCompositionRevision | null {
    return this.scopeCompositionStore.getRevision(revisionId);
  }

  getPublishedScopeComposition(workspaceId: string, scopeId: string): ScopeCompositionRevision | null {
    return this.scopeCompositionStore.getPublishedRevision(workspaceId, scopeId);
  }

  listScopeCompositionRevisions(workspaceId: string, scopeId: string): ScopeCompositionRevision[] {
    return this.scopeCompositionStore.listRevisions(workspaceId, scopeId);
  }

  /**
   * Starts one causally coherent Scope execution from the current published
   * revision. The root occurrence is one Event; explicit Edges create stable
   * Delivery obligations. Context subscriptions are not consulted.
   */
  startScopeExecution(input: {
    workspace_id: string;
    scope_id: string;
    ingress_node_id: string;
    output_port_id: string;
    content: Record<string, unknown>;
    artefact_version_ids?: string[];
    cause_event_id?: string | null;
    initiator_endpoint_id?: string | null;
    idempotency_key?: string | null;
    correlation_id?: string | null;
    revision_id?: string | null;
    redo_of_node_execution_id?: string | null;
  }, broadcast: Broadcast): {
    execution: ScopeExecutionRecord;
    root_event: EventEnvelope;
    publication: OutputPublicationRecord;
    delivery_ids: string[];
  } {
    const scope = this.scopeStore.getScope(input.workspace_id, input.scope_id);
    if (!scope) throw new ScopeNotFoundError(input.workspace_id, input.scope_id);
    if (scope.status === "retired") throw new ScopeRetiredError(input.workspace_id, input.scope_id);
    const revision = input.revision_id
      ? this.scopeCompositionStore.getRevision(input.revision_id)
      : this.scopeCompositionStore.getPublishedRevision(input.workspace_id, input.scope_id);
    if (!revision) throw new ScopeExecutionInvalidError(`Scope '${input.scope_id}' has no published composition revision`);
    if (revision.workspace_id !== input.workspace_id || revision.scope_id !== input.scope_id
      || !revision.published_at || revision.withdrawn_at) {
      throw new ScopeExecutionInvalidError(
        `revision '${revision.revision_id}' is not a retained published revision for Scope '${input.scope_id}'`,
      );
    }
    if (revision.routing_mode !== "edge") {
      throw new ScopeExecutionInvalidError(`revision '${revision.revision_id}' uses legacy routing and cannot start through the Edge execution API`);
    }
    const ingressNode = revision.nodes.find((node) => node.node_id === input.ingress_node_id);
    if (!ingressNode || ingressNode.kind !== "event") {
      throw new ScopeExecutionInvalidError(`ingress node '${input.ingress_node_id}' is not an Event placement in the published revision`);
    }
    const outputPort = revision.ports.find((port) =>
      port.port_id === input.output_port_id
      && port.node_id === ingressNode.node_id
      && port.direction === "output"
    );
    if (!outputPort) {
      throw new ScopeExecutionInvalidError(`output Port '${input.output_port_id}' does not belong to ingress node '${input.ingress_node_id}'`);
    }
    const artefactVersionIds = this.requireArtefactVersionsForPort(
      input.workspace_id,
      outputPort,
      input.artefact_version_ids ?? [],
    );
    if (input.cause_event_id) {
      const cause = this.db.prepare(`SELECT workspace_id FROM events WHERE event_id = ?`).get(input.cause_event_id) as { workspace_id: string } | undefined;
      if (!cause || cause.workspace_id !== input.workspace_id) {
        throw new ScopeExecutionInvalidError(`cause Event '${input.cause_event_id}' is unavailable in this Workspace`);
      }
    }

    const existingExecution = input.idempotency_key
      ? this.db.prepare(`
          SELECT execution_id FROM scope_executions
          WHERE workspace_id = ? AND scope_id = ? AND idempotency_key = ?
        `).get(input.workspace_id, input.scope_id, input.idempotency_key) as { execution_id: string } | undefined
      : undefined;
    if (existingExecution) {
      const execution = this.scopeExecutionStore.getExecution(existingExecution.execution_id) as ScopeExecutionRecord;
      if (execution.revision_id !== revision.revision_id
        || execution.redo_of_node_execution_id !== (input.redo_of_node_execution_id ?? null)) {
        throw new ScopeExecutionInvalidError(
          `idempotency key '${input.idempotency_key}' belongs to a different Scope execution branch`,
        );
      }
      const publication = this.db.prepare(`
        SELECT p.* FROM scope_output_publications p
        JOIN node_executions n ON n.node_execution_id = p.node_execution_id
        WHERE n.execution_id = ? AND n.node_id = ? AND p.port_id = ?
        ORDER BY p.created_at ASC LIMIT 1
      `).get(execution.execution_id, input.ingress_node_id, input.output_port_id) as any;
      const event = publication
        ? this.db.prepare(`SELECT * FROM events WHERE event_id = ?`).get(publication.event_id) as any
        : null;
      return {
        execution,
        root_event: event ? this.rowToEvent(event) : this.rowToEvent(this.db.prepare(`SELECT * FROM events WHERE event_id = ?`).get(execution.root_event_id) as any),
        publication: publication as OutputPublicationRecord,
        delivery_ids: publication
          ? (this.db.prepare(`SELECT delivery_id FROM scope_edge_traversals WHERE publication_id = ? ORDER BY created_at ASC`).all(publication.publication_id) as Array<{ delivery_id: string }>).map((row) => row.delivery_id)
          : [],
      };
    }

    const recorded = this.transaction(() => {
      const execution = input.redo_of_node_execution_id
        ? this.scopeExecutionStore.createRedoExecution({
            redo_of_node_execution_id: input.redo_of_node_execution_id,
            revision_id: revision.revision_id,
            cause_event_id: input.cause_event_id ?? null,
            ingress_node_id: ingressNode.node_id,
            ingress_port_id: outputPort.port_id,
            initiator_endpoint_id: input.initiator_endpoint_id ?? null,
            idempotency_key: input.idempotency_key ?? null,
            environment: { composition_digest: revision.semantic_digest },
          })
        : this.scopeExecutionStore.createExecution({
            workspace_id: input.workspace_id,
            scope_id: input.scope_id,
            revision_id: revision.revision_id,
            cause_event_id: input.cause_event_id ?? null,
            ingress_node_id: ingressNode.node_id,
            ingress_port_id: outputPort.port_id,
            initiator_endpoint_id: input.initiator_endpoint_id ?? null,
            idempotency_key: input.idempotency_key ?? null,
            environment: { composition_digest: revision.semantic_digest },
          });
      const contextId = this.resolveExecutionContext(
        revision,
        ingressNode,
        execution.execution_id,
        `ingress:${execution.execution_id}`,
        input.initiator_endpoint_id ?? null,
        input.content,
      );
      const nodeExecution = this.scopeExecutionStore.createOrGetNodeExecution({
        execution_id: execution.execution_id,
        revision_id: revision.revision_id,
        node_id: ingressNode.node_id,
        activation_key: `ingress:${execution.execution_id}`,
        context_id: contextId,
        status: "completed",
      });
      const eventType = outputPort.event_types?.find((value) => value !== "*")
        ?? String(ingressNode.config?.["event_type"] ?? "scope.ingress");
      const rootEvent = this.insertEvent({
        type: eventType,
        workspace_id: input.workspace_id,
        source_endpoint_id: null,
        destination: { kind: "context", context_id: contextId },
        thread_id: contextId,
        correlation_id: input.correlation_id ?? null,
        content: input.content,
        artefact_version_ids: artefactVersionIds,
        artefact_role: "attachment",
        metadata: {
          origin: "scope_ingress",
          scope_execution_id: execution.execution_id,
          composition_revision_id: revision.revision_id,
          node_execution_id: nodeExecution.node_execution_id,
          node_id: ingressNode.node_id,
          output_port_id: outputPort.port_id,
        },
        idempotency_key: input.idempotency_key ? `scope-ingress-event:${input.workspace_id}:${input.scope_id}:${input.idempotency_key}` : null,
      }, this.normalizeResponse({ expected: false }), contextId);
      this.scopeExecutionStore.setRootEvent(execution.execution_id, rootEvent.event_id);
      const publication = this.scopeExecutionStore.createPublication({
        node_execution_id: nodeExecution.node_execution_id,
        port_id: outputPort.port_id,
        event_id: rootEvent.event_id,
        idempotency_key: `scope-ingress-publication:${execution.execution_id}:${outputPort.port_id}`,
        published_by_endpoint_id: input.initiator_endpoint_id ?? null,
        artefact_versions: artefactVersionIds.map((artefact_version_id) => ({ artefact_version_id })),
      });
      this.associateArtefactVersions(artefactVersionIds, [
        { kind: "scope_execution", id: execution.execution_id, role: "input" },
        { kind: "node_execution", id: nodeExecution.node_execution_id, role: "output" },
      ]);
      const deliveryIds = this.routeScopePublication(revision, execution, nodeExecution, outputPort, publication, rootEvent);
      this.reconcileScopeExecutionStatus(execution.execution_id);
      return {
        execution: this.scopeExecutionStore.getExecution(execution.execution_id) as ScopeExecutionRecord,
        root_event: rootEvent,
        publication,
        delivery_ids: deliveryIds,
      };
    });
    broadcast("scope_execution_started", {
      execution: recorded.execution,
      root_event: recorded.root_event,
      publication: recorded.publication,
      delivery_ids: recorded.delivery_ids,
    });
    this.broadcastEventSubmission(recorded.root_event, broadcast);
    return recorded;
  }

  /**
   * Publishes one named outcome for a NodeExecution. The Bus validates the
   * pinned Port and publishing Endpoint, records the Event without Context
   * fan-out, then creates downstream Deliveries from stored Edges.
   */
  publishScopeNodeOutput(input: {
    workspace_id: string;
    node_execution_id: string;
    port_id: string;
    publisher_endpoint_id: string | null;
    publisher_principal_id?: string;
    event_type?: string;
    content: Record<string, unknown>;
    idempotency_key: string;
    lifecycle_outcome: "completed" | "waiting" | "failed";
    artefact_version_ids?: string[];
  }, broadcast: Broadcast): {
    execution: ScopeExecutionRecord;
    node_execution: NodeExecutionRecord;
    event: EventEnvelope;
    publication: OutputPublicationRecord;
    delivery_ids: string[];
  } {
    const duplicate = this.scopeExecutionStore.getPublicationByIdempotencyKey(input.idempotency_key);
    if (duplicate) {
      const nodeExecution = this.scopeExecutionStore.getNodeExecution(duplicate.node_execution_id) as NodeExecutionRecord;
      const execution = this.scopeExecutionStore.getExecution(nodeExecution.execution_id) as ScopeExecutionRecord;
      const eventRow = this.db.prepare(`SELECT * FROM events WHERE event_id = ?`).get(duplicate.event_id) as any;
      return {
        execution,
        node_execution: nodeExecution,
        event: this.rowToEvent(eventRow),
        publication: duplicate,
        delivery_ids: (this.db.prepare(`SELECT delivery_id FROM scope_edge_traversals WHERE publication_id = ? ORDER BY created_at ASC`).all(duplicate.publication_id) as Array<{ delivery_id: string }>).map((row) => row.delivery_id),
      };
    }
    const nodeExecution = this.scopeExecutionStore.getNodeExecution(input.node_execution_id);
    if (!nodeExecution) throw new ScopeExecutionInvalidError(`NodeExecution '${input.node_execution_id}' does not exist`);
    const execution = this.scopeExecutionStore.getExecution(nodeExecution.execution_id);
    if (!execution || execution.workspace_id !== input.workspace_id) {
      throw new ScopeExecutionInvalidError(`NodeExecution '${input.node_execution_id}' is not in Workspace '${input.workspace_id}'`);
    }
    if (["cancelled", "completed", "failed", "superseded"].includes(nodeExecution.status)) {
      throw new ScopeExecutionInvalidError(`NodeExecution '${input.node_execution_id}' is already ${nodeExecution.status}`);
    }
    if (["cancelled", "completed", "failed", "superseded"].includes(execution.status)) {
      throw new ScopeExecutionInvalidError(`ScopeExecution '${execution.execution_id}' is already ${execution.status}`);
    }
    const revision = this.scopeCompositionStore.getRevision(execution.revision_id);
    if (!revision || revision.routing_mode !== "edge") {
      throw new ScopeExecutionInvalidError(`pinned composition revision '${execution.revision_id}' is unavailable for Edge routing`);
    }
    const node = revision.nodes.find((candidate) => candidate.node_id === nodeExecution.node_id);
    if (!node) throw new ScopeExecutionInvalidError(`pinned node '${nodeExecution.node_id}' is unavailable`);
    let publisherEndpointId = input.publisher_endpoint_id;
    if (node.kind === "command") {
      if (!nodeExecution.command_worker_binding_id) {
        throw new ScopeOutputAuthorityError(nodeExecution.node_execution_id, input.publisher_endpoint_id);
      }
      const worker = this.commandWorkerBindingStore.require(nodeExecution.command_worker_binding_id);
      if (worker.worker_principal_id !== input.publisher_endpoint_id
        || worker.workspace_id !== execution.workspace_id
        || worker.status !== "available") {
        throw new ScopeOutputAuthorityError(nodeExecution.node_execution_id, input.publisher_endpoint_id);
      }
      publisherEndpointId = worker.worker_endpoint_id;
    } else if (node.resource_id && node.resource_id !== input.publisher_endpoint_id) {
      throw new ScopeOutputAuthorityError(nodeExecution.node_execution_id, input.publisher_endpoint_id);
    }
    const port = revision.ports.find((candidate) =>
      candidate.port_id === input.port_id
      && candidate.node_id === node.node_id
      && candidate.direction === "output"
    );
    if (!port) throw new ScopeExecutionInvalidError(`output Port '${input.port_id}' does not belong to NodeExecution '${input.node_execution_id}'`);
    const eventType = input.event_type ?? port.event_types?.find((value) => value !== "*") ?? "scope.output";
    if (port.event_types?.length && !port.event_types.includes("*") && !port.event_types.includes(eventType)) {
      throw new ScopeExecutionInvalidError(`Event type '${eventType}' is not accepted by output Port '${port.port_id}'`);
    }
    const artefactVersionIds = this.requireArtefactVersionsForPort(
      execution.workspace_id,
      port,
      input.artefact_version_ids ?? [],
    );

    const recorded = this.transaction(() => {
      const event = this.insertEvent({
        type: eventType,
        workspace_id: execution.workspace_id,
        source_endpoint_id: publisherEndpointId,
        destination: { kind: "context", context_id: nodeExecution.context_id },
        thread_id: nodeExecution.context_id,
        correlation_id: execution.execution_id,
        content: input.content,
        artefact_version_ids: artefactVersionIds,
        artefact_role: "output",
        metadata: {
          origin: "scope_output",
          ...(input.publisher_principal_id ? { source_principal_id: input.publisher_principal_id } : {}),
          scope_execution_id: execution.execution_id,
          composition_revision_id: revision.revision_id,
          node_execution_id: nodeExecution.node_execution_id,
          node_id: node.node_id,
          output_port_id: port.port_id,
          artefact_version_ids: artefactVersionIds,
        },
        idempotency_key: `scope-output-event:${input.idempotency_key}`,
      }, this.normalizeResponse({ expected: false }), nodeExecution.context_id);
      const publication = this.scopeExecutionStore.createPublication({
        node_execution_id: nodeExecution.node_execution_id,
        port_id: port.port_id,
        event_id: event.event_id,
        idempotency_key: input.idempotency_key,
        published_by_endpoint_id: publisherEndpointId,
        artefact_versions: artefactVersionIds.map((artefact_version_id) => ({ artefact_version_id })),
      });
      this.associateArtefactVersions(artefactVersionIds, [
        { kind: "scope_execution", id: execution.execution_id, role: "output" },
        { kind: "node_execution", id: nodeExecution.node_execution_id, role: "output" },
      ]);
      const deliveryIds = this.routeScopePublication(revision, execution, nodeExecution, port, publication, event);
      this.scopeExecutionStore.setNodeExecutionStatus(
        nodeExecution.node_execution_id,
        input.lifecycle_outcome === "completed"
          ? "completed"
          : input.lifecycle_outcome === "waiting"
            ? "waiting_external"
            : "failed",
        input.lifecycle_outcome === "failed" ? { output_event_id: event.event_id } : {},
      );
      this.reconcileScopeExecutionStatus(execution.execution_id);
      return {
        execution: this.scopeExecutionStore.getExecution(execution.execution_id) as ScopeExecutionRecord,
        node_execution: this.scopeExecutionStore.getNodeExecution(nodeExecution.node_execution_id) as NodeExecutionRecord,
        event,
        publication,
        delivery_ids: deliveryIds,
      };
    });
    broadcast("scope_output_published", recorded);
    this.broadcastEventSubmission(recorded.event, broadcast);
    return recorded;
  }

  getScopeExecution(executionId: string): ScopeExecutionRecord | null {
    return this.scopeExecutionStore.getExecution(executionId);
  }

  listScopeExecutions(workspaceId: string, scopeId: string): ScopeExecutionRecord[] {
    return this.scopeExecutionStore.listExecutions(workspaceId, scopeId);
  }

  listScopeExecutionsPage(input: {
    workspace_id: string;
    scope_id?: string;
    caused_by_context_id?: string;
    limit?: number;
    before?: { created_at: string; execution_id: string };
  }): ScopeExecutionRecord[] {
    return this.scopeExecutionStore.listExecutionsPage({
      ...input,
      // HTTP pages expose at most 200 records and read one extra row to prove
      // whether a continuation cursor is required.
      limit: Math.min(Math.max(input.limit ?? 50, 1), 201),
    });
  }

  getScopeExecutionProjection(executionId: string): {
    execution: ScopeExecutionRecord;
    revision: ScopeCompositionRevision;
    node_executions: Array<NodeExecutionRecord & {
      inputs: NodeExecutionInputRecord[];
      join_state: NodeExecutionJoinState;
      attempts: ExecutionAttemptRecord[];
      publications: OutputPublicationRecord[];
    }>;
    traversals: ScopeEdgeTraversalRecord[];
  } | null {
    const execution = this.scopeExecutionStore.getExecution(executionId);
    if (!execution) return null;
    const revision = this.scopeCompositionStore.getRevision(execution.revision_id);
    if (!revision) return null;
    const nodeExecutions = this.scopeExecutionStore.listNodeExecutions(executionId).map((node) => ({
      ...node,
      inputs: this.scopeExecutionStore.listInputs(node.node_execution_id),
      join_state: this.scopeExecutionStore.getJoinState(node.node_execution_id),
      attempts: this.scopeExecutionStore.listAttempts(node.node_execution_id),
      publications: this.scopeExecutionStore.listPublications(node.node_execution_id),
    }));
    return {
      execution,
      revision,
      node_executions: nodeExecutions,
      traversals: this.scopeExecutionStore.listTraversals(executionId),
    };
  }

  pauseScopeExecution(input: {
    workspace_id: string;
    execution_id: string;
    reason?: string | null;
  }, broadcast: Broadcast): ScopeExecutionPauseResult {
    const execution = this.scopeExecutionStore.getExecution(input.execution_id);
    if (!execution || execution.workspace_id !== input.workspace_id) {
      throw new ScopeExecutionInvalidError(
        `ScopeExecution '${input.execution_id}' is unavailable in Workspace '${input.workspace_id}'`,
      );
    }
    const result = this.scopeExecutionStore.pauseExecution({
      execution_id: input.execution_id,
      reason: input.reason,
    });
    broadcast("scope_execution_paused", result);
    this.scheduleNextLeaseExpiryCheck();
    return result;
  }

  resumeScopeExecution(input: {
    workspace_id: string;
    execution_id: string;
    reason?: string | null;
  }, broadcast: Broadcast): ScopeExecutionResumeResult {
    const execution = this.scopeExecutionStore.getExecution(input.execution_id);
    if (!execution || execution.workspace_id !== input.workspace_id) {
      throw new ScopeExecutionInvalidError(
        `ScopeExecution '${input.execution_id}' is unavailable in Workspace '${input.workspace_id}'`,
      );
    }
    const result = this.scopeExecutionStore.resumeExecution({
      execution_id: input.execution_id,
      reason: input.reason,
    });
    broadcast("scope_execution_resumed", result);
    for (const node of this.scopeExecutionStore.listNodeExecutions(input.execution_id)) {
      if (node.status !== "ready" && node.status !== "retrying") continue;
      const revision = this.scopeCompositionStore.getRevision(node.revision_id);
      const endpointId = revision ? this.executionEndpointId(revision, node) : null;
      if (!endpointId) continue;
      this.db.prepare(`
        UPDATE endpoints
        SET status = CASE WHEN status IN ('active', 'runtime_unconfigured') THEN status ELSE 'queued' END,
            updated_at = ?
        WHERE endpoint_id = ?
      `).run(now(), endpointId);
      this.tryCreateDeliveryForEndpoint(endpointId, broadcast);
    }
    this.scheduleNextLeaseExpiryCheck();
    return result;
  }

  retryScopeNodeExecution(input: {
    workspace_id: string;
    node_execution_id: string;
  }, broadcast: Broadcast): NodeExecutionRetryResult {
    const node = this.scopeExecutionStore.getNodeExecution(input.node_execution_id);
    const execution = node ? this.scopeExecutionStore.getExecution(node.execution_id) : null;
    if (!node || !execution || execution.workspace_id !== input.workspace_id) {
      throw new ScopeExecutionInvalidError(
        `NodeExecution '${input.node_execution_id}' is unavailable in Workspace '${input.workspace_id}'`,
      );
    }
    const result = this.scopeExecutionStore.retryNodeExecution(input.node_execution_id);
    const revision = this.scopeCompositionStore.getRevision(node.revision_id);
    const endpointId = revision ? this.executionEndpointId(revision, result.node_execution) : null;
    if (endpointId) {
      this.db.prepare(`
        UPDATE endpoints
        SET status = CASE WHEN status IN ('active', 'runtime_unconfigured') THEN status ELSE 'queued' END,
            updated_at = ?
        WHERE endpoint_id = ?
      `).run(now(), endpointId);
    }
    broadcast("node_execution_retry_requested", result);
    if (endpointId) this.tryCreateDeliveryForEndpoint(endpointId, broadcast);
    this.scheduleNextLeaseExpiryCheck();
    return result;
  }

  private executionEndpointId(
    revision: ScopeCompositionRevision,
    nodeExecution: NodeExecutionRecord,
  ): string | null {
    const placement = revision.nodes.find((candidate) => candidate.node_id === nodeExecution.node_id);
    if (!placement?.resource_id) return null;
    if (placement.kind !== "command") return placement.resource_id;
    if (!nodeExecution.command_worker_binding_id) return null;
    const worker = this.commandWorkerBindingStore.get(nodeExecution.command_worker_binding_id);
    return worker?.workspace_id === revision.workspace_id && worker.status === "available"
      ? worker.worker_endpoint_id
      : null;
  }

  /**
   * Stops one canonical execution without deleting any plan, Event, Delivery,
   * attempt, Context, or output evidence. Work already handed to a Bridge is
   * cancelled best-effort and reported as outcome-unknown because the Bus
   * cannot prove which external effects completed before cancellation arrived.
   */
  stopScopeExecution(input: {
    workspace_id: string;
    execution_id: string;
    reason?: string | null;
    operation_invocation_id?: string | null;
  }, broadcast: Broadcast): {
    execution: ScopeExecutionRecord;
    stopped: {
      pending_deliveries: number;
      active_deliveries: number;
      node_executions: number;
      workers: number;
      callbacks: number;
      connector_actions: number;
    };
    uncertain_external_effects: Array<{ kind: string; id: string; detail: string }>;
  } {
    const execution = this.scopeExecutionStore.getExecution(input.execution_id);
    if (!execution || execution.workspace_id !== input.workspace_id) {
      throw new ScopeExecutionInvalidError(
        `ScopeExecution '${input.execution_id}' is unavailable in Workspace '${input.workspace_id}'`,
      );
    }
    if (!["queued", "active", "waiting_external", "waiting_human", "paused", "blocked"].includes(execution.status)) {
      throw new ScopeExecutionInvalidError(`ScopeExecution '${input.execution_id}' is already ${execution.status}`);
    }

    const queueRows = this.db.prepare(`
      SELECT q.queue_id, q.delivery_id, q.destination_endpoint_id, q.node_execution_id, q.state
      FROM event_queue q
      WHERE q.workspace_id = ? AND q.scope_execution_id = ?
        AND q.state IN ('held', 'queued', 'reserved', 'delivered_to_bridge', 'injected_to_runtime')
      ORDER BY q.created_at ASC, q.queue_id ASC
    `).all(input.workspace_id, input.execution_id) as Array<{
      queue_id: string;
      delivery_id: string | null;
      destination_endpoint_id: string;
      node_execution_id: string | null;
      state: string;
    }>;
    const bundleIds = [...new Set(queueRows.map((row) => row.delivery_id).filter((id): id is string => Boolean(id)))];
    const bundleRows = bundleIds.length === 0
      ? []
      : this.db.prepare(`
          SELECT delivery_id, endpoint_id, state
          FROM delivery_bundles
          WHERE delivery_id IN (${bundleIds.map(() => "?").join(", ")})
            AND state IN ('reserved', 'delivered_to_bridge', 'injected_to_runtime')
          ORDER BY created_at ASC, delivery_id ASC
        `).all(...bundleIds) as Array<{ delivery_id: string; endpoint_id: string; state: string }>;
    const externallyOwnedBundles = bundleRows.filter((row) => {
      if (row.state === "delivered_to_bridge") return true;
      if (row.state !== "injected_to_runtime") return false;
      const commandAttempt = this.scopeExecutionStore.getAttemptForBundle(row.delivery_id);
      return !commandAttempt?.command_definition_revision_id
        || this.commandDefinitionHasExternalEffects(commandAttempt.command_definition_revision_id);
    });
    const runningAttempts = this.db.prepare(`
      SELECT ea.attempt_id, ea.delivery_bundle_id, ea.status,
        ea.command_definition_revision_id, n.node_execution_id, n.node_id
      FROM execution_attempts ea
      JOIN node_executions n ON n.node_execution_id = ea.node_execution_id
      WHERE n.execution_id = ? AND ea.status IN ('pending', 'running')
      ORDER BY ea.created_at ASC, ea.attempt_id ASC
    `).all(input.execution_id) as Array<{
      attempt_id: string;
      delivery_bundle_id: string | null;
      status: "pending" | "running";
      command_definition_revision_id: string | null;
      node_execution_id: string;
      node_id: string;
    }>;
    for (const attempt of runningAttempts) {
      if (attempt.command_definition_revision_id) this.commandRuntimeHost.cancel(attempt.attempt_id);
    }
    const callbackRows = this.db.prepare(`
      SELECT pr.pending_id
      FROM pending_responses pr
      JOIN events source ON source.event_id = pr.source_event_id
      WHERE pr.workspace_id = ? AND pr.status = 'pending'
        AND json_extract(source.metadata_json, '$.scope_execution_id') = ?
      ORDER BY pr.created_at ASC, pr.pending_id ASC
    `).all(input.workspace_id, input.execution_id) as Array<{ pending_id: string }>;
    const nodes = this.scopeExecutionStore.listNodeExecutions(input.execution_id);
    const stoppableNodes = nodes.filter((node) => [
      "collecting", "ready", "active", "waiting_external", "waiting_human", "paused", "retrying", "blocked",
    ].includes(node.status));
    const revision = this.scopeCompositionStore.getRevision(execution.revision_id);
    const connectorNodeIds = new Set(
      (revision?.nodes ?? []).filter((node) => node.kind === "connector").map((node) => node.node_id),
    );
    const uncertainNodeIds = new Set(runningAttempts
      .filter((attempt) => (attempt.status === "running"
          && (!attempt.command_definition_revision_id
            || this.commandDefinitionHasExternalEffects(attempt.command_definition_revision_id)))
        || (attempt.delivery_bundle_id
          && externallyOwnedBundles.some((bundle) => bundle.delivery_id === attempt.delivery_bundle_id)))
      .map((attempt) => attempt.node_execution_id));
    const uncertainExternalEffects: Array<{ kind: string; id: string; detail: string }> = [];
    const reportedBundles = new Set<string>();
    for (const bundle of externallyOwnedBundles) {
      reportedBundles.add(bundle.delivery_id);
      uncertainExternalEffects.push({
        kind: "runtime_delivery",
        id: bundle.delivery_id,
        detail: bundle.state === "injected_to_runtime"
          ? "Cancellation was requested after runtime execution began; prior external effects cannot be proven absent."
          : "The Bridge owned this Delivery when cancellation was requested; whether execution began is unknown.",
      });
    }
    for (const attempt of runningAttempts) {
      if (attempt.status !== "running") continue;
      if (attempt.command_definition_revision_id
        && !this.commandDefinitionHasExternalEffects(attempt.command_definition_revision_id)) continue;
      if (attempt.delivery_bundle_id && reportedBundles.has(attempt.delivery_bundle_id)) continue;
      uncertainExternalEffects.push({
        kind: "execution_attempt",
        id: attempt.attempt_id,
        detail: "The execution attempt had started; prior external effects cannot be proven absent.",
      });
    }

    const timestamp = now();
    const reason = input.reason?.trim() || "Scope execution stopped";
    const terminal = {
      reason,
      operation_invocation_id: input.operation_invocation_id ?? null,
      uncertain_external_effects: uncertainExternalEffects,
    };
    const stoppedExecution = this.transaction(() => {
      this.db.prepare(`
        UPDATE event_queue
        SET state = 'cancelled', lease_expires_at = NULL, last_error = ?
        WHERE workspace_id = ? AND scope_execution_id = ?
          AND state IN ('held', 'queued', 'reserved', 'delivered_to_bridge', 'injected_to_runtime')
      `).run(reason, input.workspace_id, input.execution_id);
      this.db.prepare(`
        UPDATE delivery_bundles
        SET state = 'cancelled', lease_expires_at = NULL, last_error = ?
        WHERE delivery_id IN (
          SELECT DISTINCT delivery_id FROM event_queue
          WHERE workspace_id = ? AND scope_execution_id = ? AND delivery_id IS NOT NULL
        ) AND state IN ('reserved', 'delivered_to_bridge', 'injected_to_runtime')
      `).run(reason, input.workspace_id, input.execution_id);
      for (const attempt of runningAttempts) {
        const outcomeUnknown = attempt.status === "running"
          && (!attempt.command_definition_revision_id
            || this.commandDefinitionHasExternalEffects(attempt.command_definition_revision_id));
        this.scopeExecutionStore.finishAttempt({
          attempt_id: attempt.attempt_id,
          status: outcomeUnknown ? "outcome_unknown" : "cancelled",
          error: outcomeUnknown
            ? {
                code: "stopped_outcome_unknown",
                message: reason,
                safe_to_retry_automatically: false,
              }
            : { code: "stopped_before_runtime", message: reason },
        });
      }
      for (const node of stoppableNodes) {
        this.scopeExecutionStore.setNodeExecutionStatus(
          node.node_execution_id,
          "cancelled",
          uncertainNodeIds.has(node.node_execution_id)
            ? {
                code: "stopped_outcome_unknown",
                message: reason,
                safe_to_retry_automatically: false,
              }
            : {},
        );
      }
      if (callbackRows.length > 0) {
        this.db.prepare(`
          UPDATE pending_responses
          SET status = 'cancelled', resolved_at = ?
          WHERE pending_id IN (${callbackRows.map(() => "?").join(", ")}) AND status = 'pending'
        `).run(timestamp, ...callbackRows.map((row) => row.pending_id));
      }
      return this.scopeExecutionStore.setExecutionStatus(input.execution_id, "cancelled", terminal);
    });

    for (const bundle of bundleRows) {
      broadcast("delivery_cancel_requested", {
        workspace_id: input.workspace_id,
        scope_execution_id: input.execution_id,
        delivery_id: bundle.delivery_id,
        endpoint_id: bundle.endpoint_id,
      });
      broadcast("delivery_cancelled", {
        workspace_id: input.workspace_id,
        scope_execution_id: input.execution_id,
        delivery_id: bundle.delivery_id,
        endpoint_id: bundle.endpoint_id,
        outcome_unknown: externallyOwnedBundles.some((candidate) => candidate.delivery_id === bundle.delivery_id),
      });
    }
    for (const endpointId of new Set(bundleRows.map((row) => row.endpoint_id))) {
      this.reportTurnEnd(endpointId, broadcast);
    }
    this.scheduleNextLeaseExpiryCheck();

    const result = {
      execution: stoppedExecution,
      stopped: {
        pending_deliveries: queueRows.filter((row) => row.state === "held" || row.state === "queued").length,
        active_deliveries: queueRows.filter((row) =>
          row.state === "reserved"
          || row.state === "delivered_to_bridge"
          || row.state === "injected_to_runtime"
        ).length,
        node_executions: stoppableNodes.length,
        workers: new Set(bundleRows.map((row) => row.endpoint_id)).size,
        callbacks: callbackRows.length,
        connector_actions: runningAttempts.filter((attempt) =>
          attempt.status === "running" && connectorNodeIds.has(attempt.node_id)
        ).length,
      },
      uncertain_external_effects: uncertainExternalEffects,
    };
    broadcast("scope_execution_stopped", result);
    return result;
  }

  private commandDefinitionHasExternalEffects(revisionId: string): boolean {
    return this.commandDefinitionStore.getRevision(revisionId)?.content.side_effects
      .some((effect) => effect.external) ?? true;
  }

  configureApprovalResponse(
    input: Parameters<ApprovalOperationBackend["configureResponse"]>[0],
  ): ApprovalRequestRecord {
    const request = this.transaction(() => {
      const current = this.approvalStore.requireRequestForWorkspace(input.approval_request_id, input.workspace_id);
      if (input.response_participant_id !== null
        && !this.approvalResponseParticipantAvailable(current, input.response_participant_id)) {
        throw new ApprovalValidationError("response_participant_id must identify an addressable participant in this approval's active Context");
      }
      return this.approvalStore.configureResponse(input);
    });
    this.broadcastFn?.("approval_response_configured", { request });
    return request;
  }

  private approvalResponseParticipantAvailable(request: ApprovalRequestRecord, participantId: string): boolean {
    if (request.context_id === null) return false;
    const context = this.contextStore.getContext(request.context_id);
    const endpoint = this.getEndpoint(participantId);
    return Boolean(context?.workspace_id === request.workspace_id && context.lifecycle_state === "active"
      && endpoint?.workspace_id === request.workspace_id && endpoint.status !== "retired"
      && this.contextStore.isParticipant(request.context_id, participantId));
  }

  /** Safe replay identity only. Inputs and tool traces remain outside public Context. */
  private approvalAwaitingOperation(request: ApprovalRequestRecord): Record<string, unknown> | null {
    const row = this.db.prepare(`SELECT receipt_json FROM operation_invocation_ledger
      WHERE boundary_kind = 'workspace' AND boundary_id = ? AND principal_id = ?
        AND operation_id = ? AND state = 'awaiting_approval'
        AND EXISTS (SELECT 1 FROM json_each(receipt_json, '$.governance.approval_request_ids') WHERE value = ?)
      LIMIT 1`).get(request.workspace_id, request.action.authorized_principal_id,
        request.action.operation_id, request.approval_request_id) as { receipt_json: string } | undefined;
    if (!row) return null;
    const receipt = parseJson<OperationInvocationReceipt>(row.receipt_json);
    return { invocation_id: receipt.invocation_id, operation_id: receipt.operation_id,
      operation_version: receipt.operation_version, target: receipt.target,
      expected_resource_revision: receipt.expected_resource_revision, idempotency_key: receipt.idempotency_key };
  }

  /**
   * Retains an ApprovalRequest only after an optional Scope continuation is
   * proven to name the exact waiting NodeExecution and its pinned output Ports.
   */
  createApprovalRequest(
    input: Parameters<ApprovalOperationBackend["createRequest"]>[0],
  ): ApprovalRequestRecord {
    return this.transaction(() => {
      const context = input.context_id === null ? null : this.contextStore.getContext(input.context_id);
      if (input.context_id !== null && (
        !context
        || context.workspace_id !== input.workspace_id
        || context.lifecycle_state !== "active"
      )) {
        throw new ApprovalValidationError(
          "context_id must identify an active inspectable Context in this Workspace",
        );
      }
      if (input.decision_binding && input.context_id === null) {
        throw new ApprovalValidationError("a Scope-bound approval requires its exact active Context");
      }
      if (!input.decision_binding && (input.action.scope_execution_id || input.action.node_execution_id) && input.context_id === null) {
        throw new ApprovalValidationError(
          "an execution-bound approval requires its exact active Context",
        );
      }
      if (!input.decision_binding && input.action.node_execution_id) {
        const nodeExecution = this.scopeExecutionStore.getNodeExecution(input.action.node_execution_id);
        const execution = nodeExecution
          ? this.scopeExecutionStore.getExecution(nodeExecution.execution_id)
          : null;
        if (
          !nodeExecution
          || !execution
          || execution.workspace_id !== input.workspace_id
          || nodeExecution.context_id !== input.context_id
          || (input.action.scope_execution_id !== null
            && input.action.scope_execution_id !== execution.execution_id)
          || (input.action.composition_revision_id !== null
            && input.action.composition_revision_id !== nodeExecution.revision_id)
          || (input.action.node_placement_id !== null
            && input.action.node_placement_id !== nodeExecution.node_id)
        ) {
          throw new ApprovalValidationError(
            "action execution references must identify the exact NodeExecution and its active Context",
          );
        }
      } else if (!input.decision_binding && input.action.scope_execution_id) {
        const execution = this.scopeExecutionStore.getExecution(input.action.scope_execution_id);
        const causeEventId = execution?.cause_event_id ?? execution?.root_event_id ?? null;
        const causeEvent = causeEventId ? this.getEvent(causeEventId) : null;
        if (
          !execution
          || execution.workspace_id !== input.workspace_id
          || !causeEvent?.context_id
          || causeEvent.context_id !== input.context_id
          || (input.action.composition_revision_id !== null
            && input.action.composition_revision_id !== execution.revision_id)
        ) {
          throw new ApprovalValidationError(
            "action ScopeExecution reference must identify its exact active causal Context",
          );
        }
      }
      if (input.decision_binding) {
        const continuation = this.validateApprovalDecisionBinding({
          workspace_id: input.workspace_id,
          context_id: input.context_id!,
          binding: input.decision_binding,
          artefact_version_ids: input.action.artefact_version_ids,
        });
        const exactActionReferences: Array<[string, string | null, string]> = [
          ["composition_revision_id", input.action.composition_revision_id, continuation.revision.revision_id],
          ["scope_execution_id", input.action.scope_execution_id, continuation.execution.execution_id],
          ["node_execution_id", input.action.node_execution_id, continuation.node_execution.node_execution_id],
          ["node_placement_id", input.action.node_placement_id, continuation.node_execution.node_id],
        ];
        for (const [field, claimed, exact] of exactActionReferences) {
          if (claimed !== null && claimed !== exact) {
            throw new ApprovalValidationError(
              `action.${field} conflicts with the exact decision_binding ${field}`,
            );
          }
        }
      }
      const decisionPolicy = this.resolveApprovalDecisionPolicy({
        workspace_id: input.workspace_id,
        action: input.action,
        context_id: input.context_id,
        decision_binding: input.decision_binding ?? null,
        decision_policy_ref: input.decision_policy_ref,
      });
      const { decision_policy_ref: _decisionPolicyRef, ...requestInput } = input;
      return this.approvalStore.createRequest({
        ...requestInput,
        decision_policy: decisionPolicy,
      });
    });
  }

  /** Resolve one immutable approval requirement; request input never supplies approver identities or roles. */
  private resolveApprovalDecisionPolicy(input: Readonly<{
    workspace_id: string;
    action: import("./approvals.js").ApprovalAction;
    context_id: string | null;
    decision_binding: ApprovalDecisionBinding | null;
    decision_policy_ref?: ApprovalDecisionPolicyReference;
  }>): ApprovalDecisionPolicySnapshot {
    if (!input.decision_policy_ref) {
      if (input.decision_binding) {
        throw new ApprovalValidationError(
          "a Scope approval gate must select one exact requirement from a canonical Policy evaluation",
        );
      }
      if (!input.action.connector_binding_revision_id && !input.action.extension_package_version_id) {
        throw new ApprovalValidationError(
          "an approval without a canonical Policy requirement is limited to a direct Connector or Extension action",
        );
      }
      return {
        source: { kind: "local_operator", principal_id: this.localOperatorPrincipalId },
        approvers: { mode: "any", principal_ids: [this.localOperatorPrincipalId], roles: [] },
      };
    }

    const reference = input.decision_policy_ref;
    const evaluation = this.policyStore.getEvaluation(reference.policy_evaluation_id);
    if (!evaluation || evaluation.workspace_id !== input.workspace_id || !evaluation.facts) {
      throw new ApprovalValidationError("decision_policy_ref must identify a retained Policy evaluation with exact facts in this Workspace");
    }
    const requirement = evaluation.approval_requirements.find((candidate) =>
      candidate.policy_revision_id === reference.policy_revision_id
      && candidate.rule_id === reference.rule_id
    );
    if (!requirement || evaluation.decision !== "require_approval") {
      throw new ApprovalValidationError("decision_policy_ref does not identify an approval requirement from that Policy evaluation");
    }
    if (!this.approvalPolicyFactsMatchAction(
      evaluation.facts,
      input.action,
      input.context_id,
      input.decision_binding,
    )) {
      throw new ApprovalValidationError("the Policy evaluation facts do not describe this exact approval action and Scope binding");
    }
    const currentFacts = this.withCanonicalPolicyPrincipalRoles(
      evaluation.facts,
      input.context_id,
      input.decision_binding,
    );
    if (canonicalJson(currentFacts) !== canonicalJson(evaluation.facts)) {
      throw new ApprovalValidationError("the retained Policy evaluation used principal roles that are not current canonical role authority");
    }
    const current = this.policyStore.evaluate(currentFacts);
    if (canonicalJson({
      decision: current.decision,
      evaluated_policy_revision_ids: current.evaluated_policy_revision_ids,
      denial_reasons: current.denial_reasons,
      approval_requirements: current.approval_requirements,
      budget_limits: current.budget_limits,
    }) !== canonicalJson({
      decision: evaluation.decision,
      evaluated_policy_revision_ids: evaluation.evaluated_policy_revision_ids,
      denial_reasons: evaluation.denial_reasons,
      approval_requirements: evaluation.approval_requirements,
      budget_limits: evaluation.budget_limits,
    })) {
      throw new ApprovalValidationError("the retained Policy evaluation is no longer the exact current decision");
    }
    const currentRequirement = current.approval_requirements.find((candidate) =>
      candidate.policy_revision_id === reference.policy_revision_id
      && candidate.rule_id === reference.rule_id
    );
    if (!currentRequirement || canonicalJson(currentRequirement.approvers) !== canonicalJson(requirement.approvers)) {
      throw new ApprovalValidationError("the selected Policy approval requirement is no longer current");
    }
    return {
      source: {
        kind: "policy_evaluation",
        policy_evaluation_id: evaluation.evaluation_id,
        policy_revision_id: requirement.policy_revision_id,
        rule_id: requirement.rule_id,
        facts_digest: evaluation.facts_digest,
      },
      approvers: requirement.approvers,
    };
  }

  private approvalPolicyFactsMatchAction(
    facts: PolicyEvaluationFacts,
    action: import("./approvals.js").ApprovalAction,
    contextId: string | null,
    binding: ApprovalDecisionBinding | null,
  ): boolean {
    const executionId = binding?.scope_execution_id ?? action.scope_execution_id;
    const execution = executionId ? this.scopeExecutionStore.getExecution(executionId) : null;
    const revisionId = binding?.composition_revision_id ?? action.composition_revision_id;
    const nodeId = binding?.node_placement_id ?? action.node_placement_id;
    const revision = revisionId ? this.scopeCompositionStore.getRevision(revisionId) : null;
    const placement = revision && nodeId
      ? revision.nodes.find((candidate) => candidate.node_id === nodeId) ?? null
      : null;
    const connectorRevision = action.connector_binding_revision_id
      ? this.connectorStore.getBindingRevision(action.connector_binding_revision_id)
      : null;
    const targetActorRevision = action.target?.kind === "actor_definition_revision"
      ? this.actorDefinitionStore.getRevision(action.target.id)
      : null;
    const expectedScopeId = execution?.scope_id
      ?? revision?.scope_id
      ?? (action.target?.kind === "scope" ? action.target.id : null);
    const expectedActorId = placement?.kind === "actor"
      ? placement.resource_id ?? null
      : targetActorRevision?.actor_id
        ?? (["actor", "actor_definition"].includes(action.target?.kind ?? "") ? action.target!.id : null);
    const expectedConnectorBindingId = connectorRevision?.connector_binding_id
      ?? (action.target?.kind === "connector_binding" ? action.target.id : null);
    const expectedExtensionInstallationId = action.target?.kind === "extension_installation"
      ? action.target.id
      : null;
    return (!execution || execution.workspace_id === facts.workspace_id)
      && facts.principal_id === action.authorized_principal_id
      && facts.operation_id === action.operation_id
      && canonicalJson(facts.target) === canonicalJson(action.target)
      && facts.effects.external === action.expected_effect.external
      && facts.effects.reversibility === action.expected_effect.reversibility
      && facts.scope_id === expectedScopeId
      && facts.scope_composition_revision_id === (revisionId ?? null)
      && facts.node_placement_id === (nodeId ?? null)
      && facts.actor_id === expectedActorId
      && facts.connector_binding_id === expectedConnectorBindingId
      && facts.extension_installation_id === expectedExtensionInstallationId
      && facts.extension_package_version_id === action.extension_package_version_id
      && (!binding || binding.node_execution_id === action.node_execution_id);
  }

  private withCanonicalPolicyPrincipalRoles(
    facts: PolicyEvaluationFacts,
    contextId: string | null,
    binding: ApprovalDecisionBinding | null,
  ): PolicyEvaluationFacts {
    if (facts.workspace_id === null || facts.authority_boundary.kind !== "workspace") {
      throw new ApprovalValidationError("approval Policy facts must use this exact Workspace authority");
    }
    const execution = binding
      ? this.scopeExecutionStore.getExecution(binding.scope_execution_id)
      : null;
    const resolution = this.actorRoleAuthorityStore.resolveCurrent({
      workspace_id: facts.workspace_id,
      principal_id: facts.principal_id,
      target: {
        scope_id: execution?.scope_id ?? facts.scope_id,
        scope_composition_revision_id: binding?.composition_revision_id ?? facts.scope_composition_revision_id,
        node_placement_id: binding?.node_placement_id ?? facts.node_placement_id,
        node_execution_id: binding?.node_execution_id ?? null,
        context_id: contextId,
      },
    });
    return {
      ...facts,
      principal_roles: resolution.roles,
      actor_role_evidence: resolution.evidence,
    };
  }

  private approvalActionIsCurrent(input: Readonly<{
    workspace_id: string;
    approval_request_id: string;
    action: import("./approvals.js").ApprovalAction;
    decision_policy: ApprovalDecisionPolicySnapshot;
    context_id: string | null;
    decision_binding: ApprovalDecisionBinding | null;
  }>): boolean {
    if (input.decision_policy.source.kind === "legacy_any_one") return true;
    if (input.decision_policy.source.kind === "local_operator") {
      return input.decision_policy.source.principal_id === this.localOperatorPrincipalId
        && input.decision_binding === null
        && Boolean(input.action.connector_binding_revision_id || input.action.extension_package_version_id);
    }
    const source = input.decision_policy.source;
    const evaluation = this.policyStore.getEvaluation(source.policy_evaluation_id);
    if (
      !evaluation
      || evaluation.workspace_id !== input.workspace_id
      || !evaluation.facts
      || evaluation.facts_digest !== source.facts_digest
      || !this.approvalPolicyFactsMatchAction(
        evaluation.facts,
        input.action,
        input.context_id,
        input.decision_binding,
      )
    ) return false;
    const canonicalFacts = this.withCanonicalPolicyPrincipalRoles(
      evaluation.facts,
      input.context_id,
      input.decision_binding,
    );
    if (canonicalJson(canonicalFacts) !== canonicalJson(evaluation.facts)) return false;
    const originalRequirement = evaluation.approval_requirements.find((candidate) =>
      candidate.policy_revision_id === source.policy_revision_id
      && candidate.rule_id === source.rule_id
    );
    if (!originalRequirement
      || canonicalJson(originalRequirement.approvers) !== canonicalJson(input.decision_policy.approvers)) {
      return false;
    }
    const current = this.policyStore.evaluate(canonicalFacts);
    if (current.decision !== "require_approval") return false;
    if (canonicalJson({
      evaluated_policy_revision_ids: current.evaluated_policy_revision_ids,
      denial_reasons: current.denial_reasons,
      approval_requirements: current.approval_requirements,
      budget_limits: current.budget_limits,
    }) !== canonicalJson({
      evaluated_policy_revision_ids: evaluation.evaluated_policy_revision_ids,
      denial_reasons: evaluation.denial_reasons,
      approval_requirements: evaluation.approval_requirements,
      budget_limits: evaluation.budget_limits,
    })) return false;
    const currentRequirement = current.approval_requirements.find((candidate) =>
      candidate.policy_revision_id === source.policy_revision_id
      && candidate.rule_id === source.rule_id
    );
    return Boolean(
      currentRequirement
      && canonicalJson(currentRequirement.approvers) === canonicalJson(input.decision_policy.approvers),
    );
  }

  private resolveApprovalDecisionAuthority(input: Readonly<{
    workspace_id: string;
    principal_id: string;
    approval_request_id: string;
    context_id: string | null;
    decision_binding: ApprovalDecisionBinding | null;
  }>): Readonly<{
    authority_grant_ids: readonly string[];
    role_evidence: readonly import("./approvals.js").ApprovalRoleEvidence[];
  }> {
    const grants = this.capabilityGrantStore.listActiveGrantsForPrincipalBoundary(
      input.principal_id,
      { kind: "workspace", workspace_id: input.workspace_id },
    ).filter((grant) =>
      grant.operation_ids.includes("approval.decide")
      && (
        grant.targets.length === 0
        || grant.targets.some((target) =>
          target.kind === "approval_request"
          && (target.id === null || target.id === input.approval_request_id)
        )
      )
    );
    const execution = input.decision_binding
      ? this.scopeExecutionStore.getExecution(input.decision_binding.scope_execution_id)
      : null;
    const resolution = this.actorRoleAuthorityStore.resolveCurrent({
      workspace_id: input.workspace_id,
      principal_id: input.principal_id,
      target: {
        scope_id: execution?.scope_id ?? null,
        scope_composition_revision_id: input.decision_binding?.composition_revision_id ?? null,
        node_placement_id: input.decision_binding?.node_placement_id ?? null,
        node_execution_id: input.decision_binding?.node_execution_id ?? null,
        context_id: input.context_id,
      },
    });
    const validation = this.actorRoleAuthorityStore.validateResolutionEvidence(
      resolution,
      { require_current: true },
    );
    return {
      authority_grant_ids: grants.map((grant) => grant.grant_id).sort(),
      role_evidence: validation.valid
        ? resolution.evidence.map((evidence) => ({
            role: evidence.role,
            authority_ref: canonicalJson({
              actor_id: evidence.actor_id,
              principal_binding_ref: evidence.principal_binding_ref,
              role_source_ref: evidence.role_source_ref,
              source_boundary: evidence.source_boundary,
            }),
          }))
          .sort((left, right) => `${left.role}\0${left.authority_ref}`.localeCompare(`${right.role}\0${right.authority_ref}`))
        : [],
    };
  }

  /**
   * Atomically records the decision Event and ApprovalReceipt. When the request
   * is bound to a waiting NodeExecution, that same Event is published through
   * the selected output Port and every stored Edge is traversed once.
   */
  decideApprovalRequest(
    input: Parameters<ApprovalOperationBackend["decideRequest"]>[0],
  ): Readonly<{
    request: ApprovalRequestRecord;
    receipt: ApprovalReceiptRecord | null;
    individual_decision: ApprovalIndividualDecisionRecord;
  }> {
    const beforeDecision = this.approvalStore.requireRequestForWorkspace(
      input.approval_request_id,
      input.workspace_id,
    );
    if (beforeDecision.status === "pending") {
      if (beforeDecision.decision_binding) {
        try {
          this.validateApprovalDecisionBinding({
            workspace_id: input.workspace_id,
            context_id: beforeDecision.context_id!,
            binding: beforeDecision.decision_binding,
            artefact_version_ids: beforeDecision.action.artefact_version_ids,
          });
        } catch (error) {
          if (!(error instanceof ApprovalValidationError)) throw error;
          const invalidated = this.approvalStore.invalidateRequest({
            workspace_id: input.workspace_id,
            approval_request_id: beforeDecision.approval_request_id,
            expected_state_revision: beforeDecision.state_revision,
            invalidated_by_principal_id: "system:approval-validity",
            reason: error.reason,
          });
          throw new ApprovalConflictError(
            invalidated.approval_request_id,
            "its exact Scope decision binding is no longer current",
          );
        }
      }
      const validity = this.approvalStore.refreshRequestValidity({
        workspace_id: input.workspace_id,
        approval_request_id: beforeDecision.approval_request_id,
        invalidated_by_principal_id: "system:approval-validity",
      });
      if (validity.invalidated) {
        throw new ApprovalConflictError(
          validity.request.approval_request_id,
          "its exact action, evidence, authority, or Policy is no longer current",
        );
      }
    }
    const eventIdempotencyKey = `approval-decision:${input.operation_invocation_id}`;
    const publicationIdempotencyKey = `approval-decision-publication:${input.approval_request_id}`;
    const recorded = this.transaction(() => {
      const request = this.approvalStore.requireRequestForWorkspace(
        input.approval_request_id,
        input.workspace_id,
      );

      const supersededIds = new Set(request.decisions
        .map((decision) => decision.supersedes_decision_id)
        .filter((decisionId): decisionId is string => decisionId !== null));
      const activeDecision = request.decisions.find((decision) =>
        decision.principal_id === input.decided_by_principal_id
        && !supersededIds.has(decision.approval_decision_id)
      ) ?? null;
      const idempotentDecision = request.decisions.find((decision) =>
        decision.principal_id === input.decided_by_principal_id
        && decision.idempotency_key === input.operation_invocation_id
      ) ?? null;
      const replayDecision = idempotentDecision
        ?? (
          !input.supersedes_decision_id
          && activeDecision?.decision === input.decision
          && activeDecision.reason === input.decision_reason
            ? activeDecision
            : null
        );

      // A transport retry or an identical duplicate vote reuses the exact
      // retained decision Event. It never creates another Event or route.
      if (replayDecision) {
        if (
          replayDecision.decision !== input.decision
          || replayDecision.reason !== input.decision_reason
          || replayDecision.supersedes_decision_id !== (input.supersedes_decision_id ?? null)
        ) {
          throw new Error("The approval decision invocation conflicts with retained decision evidence.");
        }
        const existingEvent = request.context_id === null
          ? null
          : this.getEvent(replayDecision.decision_event_id);
        if (request.context_id === null
          ? replayDecision.decision_event_id !== `approval-record:${eventIdempotencyKey}`
          : (
              !existingEvent
              || existingEvent.workspace_id !== input.workspace_id
              || existingEvent.context_id !== request.context_id
              || !sameTextLists(existingEvent.artefact_version_ids, request.action.artefact_version_ids)
            )) {
          throw new Error("The retained approval decision Event is missing or conflicts with its exact evidence.");
        }
        const receipt = this.approvalStore.getReceiptForRequest(request.approval_request_id);
        if (
          (request.decision === "approved" && (!receipt || receipt.decision_event_id !== request.decision_event_id))
          || (request.decision !== "approved" && receipt)
        ) {
          throw new Error("The retained approval decision has conflicting receipt evidence.");
        }
        const terminalReplay = replayDecision.resolution_after !== null
          && request.decision_event_id === replayDecision.decision_event_id;
        const publication = request.decision_binding && terminalReplay
          ? this.scopeExecutionStore.getPublicationByIdempotencyKey(publicationIdempotencyKey)
          : null;
        if (request.decision_binding && terminalReplay && (
          !publication
          || publication.event_id !== existingEvent!.event_id
          || publication.node_execution_id !== request.decision_binding.node_execution_id
          || publication.port_id !== request.decision_binding.outcome_port_ids[replayDecision.resolution_after!]
        )) {
          throw new Error("The retained approval decision has incomplete or conflicting Scope continuation evidence.");
        }
        return {
          event: existingEvent,
          result: { request, receipt, individual_decision: replayDecision },
          publication,
          delivery_ids: publication
            ? (this.db.prepare(`
                SELECT delivery_id FROM scope_edge_traversals
                WHERE publication_id = ? ORDER BY created_at ASC, traversal_id ASC
              `).all(publication.publication_id) as Array<{ delivery_id: string }>).map((row) => row.delivery_id)
            : [],
          replayed: true as const,
        };
      }

      const context = request.context_id === null ? null : this.contextStore.getContext(request.context_id);
      if (request.context_id !== null && (
        !context
        || context.workspace_id !== input.workspace_id
        || context.lifecycle_state !== "active"
      )) {
        throw new Error("The approval Context is not active in this Workspace.");
      }

      const existingRow = this.db.prepare("SELECT * FROM events WHERE idempotency_key = ?")
        .get(eventIdempotencyKey) as any;
      if (existingRow) {
        throw new Error("The decision invocation idempotency key is already attached to different retained evidence.");
      }

      const continuation = request.decision_binding
        ? this.validateApprovalDecisionBinding({
            workspace_id: input.workspace_id,
            context_id: request.context_id!,
            binding: request.decision_binding,
            artefact_version_ids: request.action.artefact_version_ids,
          })
        : null;
      const candidatePort = continuation?.ports[input.decision] ?? null;
      const eventType = candidatePort?.event_types?.find((candidate) => candidate !== "*")
        ?? "approval.decision";

      const event = request.context_id === null
        ? null
        : this.insertEvent({
            type: eventType,
            workspace_id: input.workspace_id,
            source_endpoint_id: null,
            destination: { kind: "context", context_id: request.context_id },
            correlation_id: request.approval_request_id,
            content: {
              approval_request_id: request.approval_request_id,
              decision: input.decision,
              reason: input.decision_reason,
              action_digest: request.action_digest,
              decision_policy_digest: request.decision_policy_digest,
              action: request.action,
              decision_binding: request.decision_binding,
              response_participant_id: request.response_participant_id,
              awaiting_operation: this.approvalAwaitingOperation(request),
              supersedes_decision_id: input.supersedes_decision_id ?? null,
            },
            artefact_version_ids: [...request.action.artefact_version_ids],
            artefact_role: "evidence",
            metadata: {
              source_principal_id: input.decided_by_principal_id,
              semantic_operation_id: "approval.decide",
              operation_invocation_id: input.operation_invocation_id,
              ...(continuation
                ? {
                    origin: "scope_approval_decision",
                    scope_execution_id: continuation.execution.execution_id,
                    composition_revision_id: continuation.revision.revision_id,
                    node_execution_id: continuation.node_execution.node_execution_id,
                    node_id: continuation.node_execution.node_id,
                    candidate_output_port_id: candidatePort!.port_id,
                  }
                : { origin: "approval_decision" }),
            },
            idempotency_key: eventIdempotencyKey,
          }, this.normalizeResponse({ expected: false }), request.context_id);
      if (request.context_id !== null) {
        this.associateArtefactVersions(request.action.artefact_version_ids, [{
          kind: "context",
          id: request.context_id,
          role: "evidence",
        }]);
      }
      const result = this.approvalStore.decideRequest({
        workspace_id: input.workspace_id,
        approval_request_id: request.approval_request_id,
        expected_state_revision: input.expected_state_revision,
        decision: input.decision,
        decided_by_principal_id: input.decided_by_principal_id,
        decision_event_id: event?.event_id ?? `approval-record:${eventIdempotencyKey}`,
        decision_reason: input.decision_reason,
        ...(input.receipt_expires_at ? { receipt_expires_at: input.receipt_expires_at } : {}),
        ...(input.supersedes_decision_id ? { supersedes_decision_id: input.supersedes_decision_id } : {}),
        idempotency_key: input.operation_invocation_id,
      });
      let publication: OutputPublicationRecord | null = null;
      let deliveryIds: string[] = [];
      const resolution = result.individual_decision.resolution_after;
      const selectedPort = resolution ? continuation?.ports[resolution] ?? null : null;
      if (resolution && event && request.response_participant_id) {
        if (this.approvalResponseParticipantAvailable(request, request.response_participant_id)) {
          // The decision and its delivery obligation commit together. Replay
          // returns the retained decision above instead of queuing another turn.
          this.queueEvent(event.event_id, request.workspace_id, request.response_participant_id);
        } else {
          // Losing a recipient must not prevent a legitimate decision. Preserve
          // the suppressed response in the decision's evidence for inspection.
          event.metadata.response_suppressed_reason = "recipient_unavailable";
          this.db.prepare("UPDATE events SET metadata_json = ? WHERE event_id = ?")
            .run(json(event.metadata), event.event_id);
        }
      }
      if (continuation && selectedPort && resolution) {
        publication = this.scopeExecutionStore.createPublication({
          node_execution_id: continuation.node_execution.node_execution_id,
          port_id: selectedPort.port_id,
          event_id: event!.event_id,
          idempotency_key: publicationIdempotencyKey,
          published_by_endpoint_id: null,
          artefact_versions: request.action.artefact_version_ids.map((artefact_version_id) => ({ artefact_version_id })),
        });
        this.associateArtefactVersions(request.action.artefact_version_ids, [
          { kind: "scope_execution", id: continuation.execution.execution_id, role: "output" },
          { kind: "node_execution", id: continuation.node_execution.node_execution_id, role: "output" },
        ]);
        deliveryIds = this.routeScopePublication(
          continuation.revision,
          continuation.execution,
          continuation.node_execution,
          selectedPort,
          publication,
          event!,
        );
        this.scopeExecutionStore.setNodeExecutionStatus(
          continuation.node_execution.node_execution_id,
          "completed",
        );
        this.reconcileScopeExecutionStatus(continuation.execution.execution_id);
      }
      return { event, result, publication, delivery_ids: deliveryIds, replayed: false as const };
    });

    if (!recorded.replayed && this.broadcastFn) {
      if (recorded.event) this.broadcastEventSubmission(recorded.event, this.broadcastFn);
      if (recorded.publication && recorded.result.request.decision_binding) {
        const nodeExecution = this.scopeExecutionStore.getNodeExecution(
          recorded.result.request.decision_binding.node_execution_id,
        ) as NodeExecutionRecord;
        const execution = this.scopeExecutionStore.getExecution(nodeExecution.execution_id) as ScopeExecutionRecord;
        this.broadcastFn("scope_output_published", {
          execution,
          node_execution: nodeExecution,
          event: recorded.event!,
          publication: recorded.publication,
          delivery_ids: recorded.delivery_ids,
        });
      }
      this.broadcastFn("approval_decision_recorded", {
        request: recorded.result.request,
        receipt: recorded.result.receipt,
        individual_decision: recorded.result.individual_decision,
      });
      if (recorded.result.individual_decision.resolution_after !== null) {
        this.broadcastFn("approval_decided", {
          request: recorded.result.request,
          receipt: recorded.result.receipt,
          individual_decision: recorded.result.individual_decision,
        });
      }
    }
    return recorded.result;
  }

  /** Resolve a semantic operation target inside its verified authority boundary. */
  resolveOperationResource(
    target: OperationResourceIdentity,
    boundary: OperationAuthorityBoundary,
  ): ResolvedOperationResource | null {
    if (target.kind === "workspace") {
      if (boundary.kind === "workspace" && target.id !== boundary.workspace_id) return null;
      const workspace = this.workspaceIdentityStore.getIdentity(target.id);
      return workspace
        ? { ref: { ...target, revision: workspace.updated_at }, state: this.getRemoteWorkspace(target.id) }
        : null;
    }
    const connector = resolveConnectorOperationResource(this.connectorStore, boundary, target);
    if (connector) return connector;
    const command = resolveCommandOperationResource(this.commandDefinitionStore, target, boundary);
    if (command) return command;
    if (target.kind === "secret_ref") {
      const ref = this.secretRefStore.getSecretRef(target.id);
      const visible = ref && (ref.owner.kind === "host" || sameOperationAuthorityBoundary(ref.owner, boundary));
      return visible
        ? {
            ref: { ...target, revision: credentialReferenceRevision(ref) },
            state: publicCredentialReference(ref),
          }
        : null;
    }
    if (boundary.kind !== "workspace") return null;
    const workspaceId = boundary.workspace_id;
    if (target.kind === "runtime_delivery") {
      const delivery = this.getRuntimeDelivery(target.id);
      return delivery?.workspace_id === workspaceId
        ? { ref: { ...target, revision: delivery.state }, state: delivery }
        : null;
    }
    if (target.kind === "approval_request") {
      const request = this.approvalStore.getRequest(target.id);
      return request?.workspace_id === workspaceId
        ? { ref: { ...target, revision: String(request.state_revision) }, state: request }
        : null;
    }
    if (target.kind === "approval_receipt") {
      const receipt = this.approvalStore.getReceipt(target.id);
      return receipt?.workspace_id === workspaceId
        ? { ref: { ...target, revision: approvalReceiptStateRevision(receipt) }, state: receipt }
        : null;
    }
    const extension = resolveExtensionOperationResource(this.extensionStore, boundary, target);
    if (extension) return extension;
    const policy = resolvePolicyOperationResource(this.policyStore, boundary, target);
    if (policy) return policy;
    const budget = resolveBudgetOperationResource(this.budgetStore, boundary, target);
    if (budget) return budget;
    const audit = resolveAuditOperationResource(this.auditStore, boundary, target);
    if (audit) return audit;
    const context = resolveContextOperationResource(this.contextStore, workspaceId, target);
    if (context) return context;
    const actorRoleAuthority = resolveActorRoleAuthorityResource(
      this.actorRoleAuthorityStore,
      workspaceId,
      target,
    );
    if (actorRoleAuthority) return actorRoleAuthority;
    if (target.kind === "scope") {
      const scope = this.scopeStore.getScope(workspaceId, target.id);
      if (!scope) return null;
      return {
        ref: {
          ...target,
          revision: scope.published_revision_id ?? NO_PUBLISHED_SCOPE_REVISION,
        },
        state: scope,
      };
    }
    if (target.kind === "scope_composition_revision") {
      const revision = this.scopeCompositionStore.getRevision(target.id);
      return revision?.workspace_id === workspaceId
        ? { ref: { ...target, revision: revision.semantic_digest }, state: revision }
        : null;
    }
    if (target.kind === "scope_execution") {
      const execution = this.scopeExecutionStore.getExecution(target.id);
      return execution?.workspace_id === workspaceId
        ? { ref: { ...target, revision: scopeExecutionStateRevision(execution) }, state: execution }
        : null;
    }
    if (target.kind === "node_execution") {
      const node = this.scopeExecutionStore.getNodeExecution(target.id);
      const execution = node ? this.scopeExecutionStore.getExecution(node.execution_id) : null;
      return node && execution?.workspace_id === workspaceId
        ? { ref: { ...target, revision: nodeExecutionStateRevision(node) }, state: node }
        : null;
    }
    if (target.kind === "artefact") {
      const artefact = this.artefactStore.getArtefact(target.id);
      return artefact?.workspace_id === workspaceId
        // Artefacts can have several branch heads, so core must not invent a
        // singular mutable "current version" revision.
        ? { ref: { ...target, revision: null }, state: artefact }
        : null;
    }
    if (target.kind === "artefact_version") {
      const version = this.artefactStore.getVersion(target.id);
      const artefact = version ? this.artefactStore.getArtefact(version.artefact_id) : null;
      return version && artefact?.workspace_id === workspaceId
        ? { ref: { ...target, revision: version.artefact_version_id }, state: version }
        : null;
    }
    if (target.kind === "actor") {
      const actor = this.actorDefinitionStore.getActor(target.id);
      return actor?.workspace_id === workspaceId
        ? { ref: { ...target, revision: actor.current_definition_revision_id }, state: actor }
        : null;
    }
    if (target.kind === "actor_definition_revision") {
      const revision = this.actorDefinitionStore.getRevision(target.id);
      const actor = revision ? this.actorDefinitionStore.getActor(revision.actor_id) : null;
      return revision && actor?.workspace_id === workspaceId
        ? { ref: { ...target, revision: revision.semantic_digest }, state: revision }
        : null;
    }
    if (target.kind === "runtime_profile") {
      const profile = this.runtimeProfileStore.getProfile(target.id);
      return profile?.owner.kind === "workspace" && profile.owner.id === workspaceId
        ? { ref: { ...target, revision: profile.current_revision_id }, state: profile }
        : null;
    }
    if (target.kind === "runtime_profile_revision") {
      const revision = this.runtimeProfileStore.getRevision(target.id);
      const profile = revision ? this.runtimeProfileStore.getProfile(revision.runtime_profile_id) : null;
      return revision && profile?.owner.kind === "workspace" && profile.owner.id === workspaceId
        ? { ref: { ...target, revision: revision.semantic_digest }, state: revision }
        : null;
    }
    if (target.kind === "actor_runtime_binding") {
      let binding = null;
      try {
        binding = this.runtimeProfileStore.requireActorBinding(target.id);
      } catch {
        return null;
      }
      return binding.workspace_id === workspaceId
        ? { ref: { ...target, revision: binding.actor_runtime_binding_id }, state: binding }
        : null;
    }
    if (target.kind === "operation_invocation") {
      const receipt = this.operationInvocationLedger.getByInvocationId(target.id);
      return receipt && sameOperationAuthorityBoundary(receipt.authority_boundary, boundary)
        ? { ref: { ...target, revision: receipt.updated_at }, state: receipt }
        : null;
    }
    return null;
  }

  /**
   * Point-of-use credential boundary for one already-injected Delivery. Secret
   * bytes exist only inside the trusted callback and are never projected.
   */
  async withRuntimeCredential<Result>(input: Readonly<{
    bridge_id: string;
    delivery_id: string;
    secret_ref_id: string;
    operation_id: typeof USE_CREDENTIAL_OPERATION_ID;
    operation: BrokeredSecretOperation<Result>;
  }>): Promise<Result>;
  async withRuntimeCredential(input: Readonly<{
    bridge_id: string;
    delivery_id: string;
    secret_ref_id: string;
    operation_id: typeof REFRESH_CREDENTIAL_OPERATION_ID;
    refresh: (material: Readonly<Uint8Array>) => Promise<Uint8Array> | Uint8Array;
  }>): Promise<SecretRefRecord>;
  async withRuntimeCredential<Result>(input: Readonly<{
    bridge_id: string;
    delivery_id: string;
    secret_ref_id: string;
    operation_id: typeof USE_CREDENTIAL_OPERATION_ID | typeof REFRESH_CREDENTIAL_OPERATION_ID;
    operation?: BrokeredSecretOperation<Result>;
    refresh?: (material: Readonly<Uint8Array>) => Promise<Uint8Array> | Uint8Array;
  }>): Promise<Result | SecretRefRecord> {
    const row = this.db.prepare("SELECT * FROM delivery_bundles WHERE delivery_id = ?")
      .get(input.delivery_id) as any;
    if (!row || String(row.state) !== "injected_to_runtime") {
      throw new Error("The credential is available only to an active isolated runtime Delivery.");
    }
    const endpoint = this.getEndpoint(String(row.endpoint_id)) as { bridge_id?: string | null } | null;
    if (endpoint?.bridge_id !== input.bridge_id) {
      throw new Error("The authenticated Bridge does not own this runtime Delivery.");
    }
    const delivery = this.rowToDelivery(row);
    const contract = delivery.node_execution_id
      ? (delivery.execution_attempt_id
          ? this.getRuntimeProcessingContract(delivery.execution_attempt_id)
          : null)
      : this.resolveDirectRuntimeProcessingContract(delivery);
    if (!contract || !contract.runtime.profile.content.secret_ref_ids.includes(input.secret_ref_id)) {
      throw new Error("The credential is not pinned by this runtime Delivery.");
    }
    const ref = this.secretRefStore.getSecretRef(input.secret_ref_id);
    if (!ref) throw new Error("The credential pinned by this runtime Delivery is unavailable.");
    const request = this.runtimeCredentialRequest(
      ref,
      contract.workspace_id,
      contract.operation_authority.principal_id,
      contract.operation_authority.capability_grant_ids,
      input.operation_id,
    );
    if (input.operation_id === REFRESH_CREDENTIAL_OPERATION_ID) {
      if (!input.refresh) throw new Error("A credential refresh callback is required.");
      const changed = await this.credentialBrokerService.refreshSecretRef(request, input.refresh);
      this.reconcileCredentialBinding(changed, contract.operation_authority.principal_id);
      return changed;
    }
    if (!input.operation) throw new Error("A credential use callback is required.");
    return this.credentialBrokerService.useSecret(request, input.operation);
  }

  private runtimeCredentialRequest(
    ref: SecretRefRecord,
    workspaceId: string,
    principalId: string,
    grantIds: readonly string[],
    operationId: typeof USE_CREDENTIAL_OPERATION_ID | typeof REFRESH_CREDENTIAL_OPERATION_ID,
  ): SecretAccessRequest {
    const activeIds = new Set(this.capabilityGrantStore.inspectSessionGrantIds({
      principal_id: principalId,
      boundary: { kind: "workspace", workspace_id: workspaceId },
      grant_ids: grantIds,
    }).active_grants.map(grant => grant.grant_id));
    const grantId = grantIds.find((candidateId) => {
      const grant = this.capabilityGrantStore.getGrant(candidateId);
      const constraint = this.secretRefStore.getGrantConstraint(candidateId);
      return Boolean(
        grant
        && activeIds.has(candidateId)
        && grant.principal_id === principalId
        && grant.boundary.kind === "workspace"
        && grant.boundary.workspace_id === workspaceId
        && grant.operation_ids.includes(operationId)
        && grant.targets.some((target) => target.kind === "secret_ref" && target.id === ref.secret_ref_id)
        && grant.targets.some((target) => target.kind === ref.resource.kind && target.id === ref.resource.id)
        && constraint?.authority_boundary.kind === "workspace"
        && constraint.authority_boundary.workspace_id === workspaceId
        && constraint.secret_ref_id === ref.secret_ref_id
        && constraint.purposes.includes(RUNTIME_CREDENTIAL_PURPOSE),
      );
    });
    if (!grantId) throw new SecretAccessDeniedError("grant_constraint_not_found");
    return {
      secret_ref_id: ref.secret_ref_id,
      grant_id: grantId,
      principal_id: principalId,
      authority_boundary: { kind: "workspace", workspace_id: workspaceId },
      resource: ref.resource,
      purpose: RUNTIME_CREDENTIAL_PURPOSE,
      operation_id: operationId,
    };
  }

  private expectedCredentialProvider(ref: SecretRefRecord): string | null {
    if (ref.resource.kind === "provider_account") return ref.resource.id;
    if (ref.resource.kind !== "runtime_profile") return null;
    const profile = this.runtimeProfileStore.getProfile(ref.resource.id);
    const revision = profile?.current_revision_id
      ? this.runtimeProfileStore.getRevision(profile.current_revision_id)
      : null;
    const provider = revision?.content.configuration.provider;
    return typeof provider === "string" && provider.trim() ? provider.trim() : null;
  }

  private reconcileCredentialBinding(ref: SecretRefRecord, principalId: string): void {
    const workspaceIds = ref.owner.kind === "workspace"
      ? [ref.owner.workspace_id]
      : (this.db.prepare(`SELECT DISTINCT workspace_id FROM actor_runtime_bindings ORDER BY workspace_id`)
          .all() as Array<{ workspace_id: string }>).map((row) => String(row.workspace_id));
    for (const workspaceId of workspaceIds) for (const actor of this.actorDefinitionStore.listActors(workspaceId)) {
      const binding = this.runtimeProfileStore.getCurrentActorBinding(actor.actor_id);
      if (!binding || binding.status === "disabled") continue;
      const revision = this.runtimeProfileStore.getRevision(binding.runtime_profile_revision_id);
      const definition = actor.current_definition_revision_id
        ? this.actorDefinitionStore.getRevision(actor.current_definition_revision_id)
        : null;
      if (!revision || !definition) continue;
      if (!revision.content.secret_ref_ids.includes(ref.secret_ref_id)) continue;
      const credentialRefs = revision.content.secret_ref_ids
        .map((secretRefId) => this.secretRefStore.getSecretRef(secretRefId));
      const credentialsResolved = credentialRefs.length > 0
        && credentialRefs.every((candidate) => candidate?.resolution === "resolved");
      const authorityResolved = credentialRefs.length > 0
        && credentialRefs.every((candidate) => candidate !== null && this.hasRuntimeCredentialAuthority(
          definition.content.capability_grant_ids,
          candidate,
          workspaceId,
          actor.actor_id,
        ));
      const reasons = binding.unresolved_reasons.filter((reason) =>
        reason !== "runtime_credential_unresolved"
        && reason !== "runtime_credential_authority_unresolved");
      if (!credentialsResolved) reasons.push("runtime_credential_unresolved");
      else if (!authorityResolved) reasons.push("runtime_credential_authority_unresolved");
      const normalizedReasons = [...new Set(reasons)].sort((left, right) => left.localeCompare(right));
      const status = normalizedReasons.length > 0 ? "unresolved" as const : "resolved" as const;
      if (binding.status === status && sameTextLists(binding.unresolved_reasons, normalizedReasons)) continue;
      this.runtimeProfileStore.bindActor({
        actor_id: actor.actor_id,
        runtime_profile_revision_id: binding.runtime_profile_revision_id,
        endpoint_id: binding.endpoint_id,
        status,
        unresolved_reasons: normalizedReasons,
        expected_current_binding_id: binding.actor_runtime_binding_id,
        created_by_principal_id: principalId,
      });
    }
  }

  private hasRuntimeCredentialAuthority(
    grantIds: readonly string[],
    ref: SecretRefRecord,
    workspaceId: string,
    principalId: string,
  ): boolean {
    try {
      for (const operationId of [USE_CREDENTIAL_OPERATION_ID, REFRESH_CREDENTIAL_OPERATION_ID] as const) {
        this.runtimeCredentialRequest(ref, workspaceId, principalId, grantIds, operationId);
      }
      return true;
    } catch { return false; }
  }

  /**
   * Publication is the authority boundary for a Command placement. A plan may
   * name only the stable Command; publication resolves and validates its exact
   * current definition and the host-local authenticated worker that can run it.
   */
  private validateCommandPlacementsForPublication(revision: ScopeCompositionRevision): void {
    if (revision.routing_mode !== "edge") return;
    const registeredBrokeredOperations = new Set(this.operationRegistry.listCurrentOperationIds({
      interaction_mode: "brokered",
      boundary_kind: "workspace",
    }));
    for (const node of revision.nodes.filter((candidate) => candidate.kind === "command")) {
      if (!node.resource_id) {
        throw new ScopeExecutionInvalidError(`Command node '${node.node_id}' has no stable Command identity`);
      }
      const command = this.commandDefinitionStore.getCommand(node.resource_id);
      if (!command || command.status !== "active" || !command.current_revision_id) {
        throw new ScopeExecutionInvalidError(
          `Command node '${node.node_id}' does not reference an active published Command`,
        );
      }
      if (command.owner.kind === "workspace" && command.owner.id !== revision.workspace_id) {
        throw new ScopeExecutionInvalidError(
          `Command '${command.command_id}' belongs to another Workspace`,
        );
      }
      if (command.owner.kind === "host" && command.owner.id !== this.localHostId) {
        throw new ScopeExecutionInvalidError(
          `Command '${command.command_id}' belongs to another host`,
        );
      }
      const definition = this.commandDefinitionStore.getRevision(command.current_revision_id);
      if (!definition || definition.command_id !== command.command_id || !definition.published_at
        || definition.withdrawn_at !== null) {
        throw new ScopeExecutionInvalidError(
          `Command '${command.command_id}' has no usable current definition`,
        );
      }
      if (command.owner.kind === "extension_package_version"
        && (command.owner.id !== definition.content.implementation_ref.id
          || definition.content.implementation_ref.kind !== "extension_package_version")) {
        throw new ScopeExecutionInvalidError(
          `Extension-owned Command '${command.command_id}' must use its owning exact Extension package`,
        );
      }
      resolveCommandImplementation(definition, revision.workspace_id, this.extensionStore);
      const worker = this.commandWorkerBindingStore.ensureDefault(revision.workspace_id, this.localHostId);
      if (worker.status !== "available") {
        throw new ScopeExecutionInvalidError(`Command worker '${worker.command_worker_binding_id}' is unavailable`);
      }
      this.validateCommandPortContract(node, "input", definition, revision.ports);
      this.validateCommandPortContract(node, "output", definition, revision.ports);

      const grantIds = node.capability_grant_ids ?? [];
      const inspection = this.capabilityGrantStore.inspectSessionGrantIds({
        principal_id: worker.worker_principal_id,
        boundary: { kind: "workspace", workspace_id: revision.workspace_id },
        grant_ids: grantIds,
      });
      if (inspection.unavailable_grants.length > 0) {
        throw new ScopeExecutionInvalidError(
          `Command node '${node.node_id}' references an unavailable CapabilityGrant`,
        );
      }
      for (const permission of definition.content.permissions) {
        if (!registeredBrokeredOperations.has(permission.operation_id)) {
          throw new ScopeExecutionInvalidError(
            `Command permission '${permission.permission_id}' references unavailable operation '${permission.operation_id}'`,
          );
        }
        if (!inspection.active_grants.some((grant) => grant.operation_ids.includes(permission.operation_id))) {
          throw new ScopeExecutionInvalidError(
            `Command node '${node.node_id}' has no active CapabilityGrant for '${permission.operation_id}'`,
          );
        }
      }
    }
  }

  private validateCommandPortContract(
    node: ScopeNodePlacement,
    direction: "input" | "output",
    definition: CommandDefinitionRevision,
    allPorts: readonly ScopePort[],
  ): void {
    const contract = definition.content[direction].schema as Record<string, unknown>;
    if (contract.type !== "object" || !contract.properties || typeof contract.properties !== "object"
      || Array.isArray(contract.properties)) {
      throw new ScopeExecutionInvalidError(
        `Command '${definition.command_id}' ${direction} contract must be an object with named properties`,
      );
    }
    const properties = contract.properties as Record<string, unknown>;
    const propertyNames = Object.keys(properties).sort();
    const ports = allPorts.filter((port) => port.node_id === node.node_id && port.direction === direction);
    const portNames = ports.map((port) => port.name).sort();
    if (JSON.stringify(propertyNames) !== JSON.stringify(portNames)) {
      throw new ScopeExecutionInvalidError(
        `Command node '${node.node_id}' ${direction} Ports must exactly match its published Command contract`,
      );
    }
    const required = new Set(Array.isArray(contract.required)
      ? contract.required.filter((value): value is string => typeof value === "string")
      : []);
    for (const port of ports) {
      const property = properties[port.name];
      if (!property || typeof property !== "object" || Array.isArray(property)) {
        throw new ScopeExecutionInvalidError(
          `Command node '${node.node_id}' Port '${port.name}' has no usable contract`,
        );
      }
      const schemaRef = (property as Record<string, unknown>).$ref;
      if (port.schema_ref && schemaRef !== port.schema_ref) {
        throw new ScopeExecutionInvalidError(
          `Command node '${node.node_id}' Port '${port.name}' does not match schema '${port.schema_ref}'`,
        );
      }
      if (direction === "input" && required.has(port.name) !== ((port.min_count ?? 0) > 0)) {
        throw new ScopeExecutionInvalidError(
          `Command node '${node.node_id}' Port '${port.name}' requiredness differs from its Command contract`,
        );
      }
    }
  }

  private routeScopePublication(
    revision: ScopeCompositionRevision,
    execution: ScopeExecutionRecord,
    sourceNodeExecution: NodeExecutionRecord,
    sourcePort: ScopePort,
    publication: OutputPublicationRecord,
    event: EventEnvelope,
  ): string[] {
    const deliveryIds: string[] = [];
    const edges = revision.edges
      .filter((edge) => edge.enabled !== false && edge.source_port_id === sourcePort.port_id)
      .sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0));
    for (const edge of edges) {
      const traversed = this.db.prepare(`
        SELECT delivery_id FROM scope_edge_traversals WHERE publication_id = ? AND edge_id = ?
      `).get(publication.publication_id, edge.edge_id) as { delivery_id: string } | undefined;
      if (traversed) {
        deliveryIds.push(traversed.delivery_id);
        continue;
      }
      const targetPort = revision.ports.find((port) => port.port_id === edge.target_port_id);
      const targetNode = targetPort
        ? revision.nodes.find((node) => node.node_id === targetPort.node_id)
        : null;
      if (!targetPort || !targetNode || targetPort.direction !== "input") {
        throw new ScopeExecutionInvalidError(`Edge '${edge.edge_id}' has no valid target input Port`);
      }
      if (!targetNode.resource_id || (targetNode.kind !== "actor" && targetNode.kind !== "command")) {
        throw new ScopeExecutionInvalidError(`Edge '${edge.edge_id}' targets '${targetNode.node_id}', which is not an executable Actor or Command placement`);
      }
      const activation = targetNode.activation;
      if (!activation || activation.mode === "legacy_subscription") {
        throw new ScopeExecutionInvalidError(`Node '${targetNode.node_id}' has no canonical activation policy`);
      }
      let joinKey: string | null = null;
      if (activation.mode === "keyed_gather") {
        const value = this.readContentKey(event.content, activation.join_key.path);
        if (value === null || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")) {
          throw new ScopeExecutionInvalidError(
            `Node '${targetNode.node_id}' requires a scalar join key at '${activation.join_key.path}'`,
          );
        }
        joinKey = String(value);
      }
      const activationKey = activation.mode === "per_delivery"
        ? `per-delivery:${publication.publication_id}:${edge.edge_id}`
        : activation.mode === "all_required_ports"
          ? `all-required:${execution.execution_id}:${targetNode.node_id}`
          : `keyed-gather:${createHash("sha256").update(joinKey as string).digest("hex")}`;
      const existingNodeExecution = this.scopeExecutionStore.findNodeExecution(
        execution.execution_id,
        targetNode.node_id,
        activationKey,
      );
      const commandBinding = targetNode.kind === "command"
        ? this.resolveCommandPlacementBinding(
            revision,
            targetNode,
            existingNodeExecution,
          )
        : null;
      const destinationEndpointId = targetNode.kind === "command"
        ? commandBinding!.worker.worker_endpoint_id
        : targetNode.resource_id;
      const contextId = existingNodeExecution?.context_id ?? this.resolveExecutionContext(
        revision,
        targetNode,
        execution.execution_id,
        activationKey,
        destinationEndpointId,
        event.content,
      );
      const inputPorts = revision.ports.filter((port) =>
        port.node_id === targetNode.node_id && port.direction === "input"
      );
      const targetNodeExecution = this.scopeExecutionStore.createOrGetNodeExecution({
        execution_id: execution.execution_id,
        revision_id: revision.revision_id,
        node_id: targetNode.node_id,
        activation_key: activationKey,
        join_key: joinKey,
        context_id: contextId,
        status: "collecting",
        assigned_actor_ids: targetNode.kind === "actor" ? [targetNode.resource_id] : [],
        command_definition_revision_id: commandBinding?.definition.command_definition_revision_id,
        command_worker_binding_id: commandBinding?.worker.command_worker_binding_id,
      });
      if (activation.mode !== "per_delivery") {
        this.scopeExecutionStore.initializeRequiredPortExpectations(
          targetNodeExecution.node_execution_id,
          inputPorts,
        );
      }
      const queueId = this.queueEvent(event.event_id, execution.workspace_id, destinationEndpointId, {
        state: "held",
        scope_execution_id: execution.execution_id,
        composition_revision_id: revision.revision_id,
        source_node_id: sourceNodeExecution.node_id,
        source_port_id: sourcePort.port_id,
        target_node_id: targetNode.node_id,
        target_port_id: targetPort.port_id,
        edge_id: edge.edge_id,
        node_execution_id: targetNodeExecution.node_execution_id,
        output_publication_id: publication.publication_id,
      });
      const before = this.scopeExecutionStore.getNodeExecution(targetNodeExecution.node_execution_id) as NodeExecutionRecord;
      const expectedMembership = activation.mode === "keyed_gather"
        ? activation.expected_members
        : undefined;
      const isDynamicMemberPort = expectedMembership?.member_port_id === targetPort.port_id;
      const isCollectionPort = expectedMembership?.collection_port_id === targetPort.port_id;
      const carriedOutputs = publication.outputs.length > 0
        ? publication.outputs
        : [{ artefact_version_id: null, member_key: "" }];
      if ((isDynamicMemberPort || isCollectionPort) && carriedOutputs.every((output) => !output.artefact_version_id)) {
        throw new ScopeExecutionInvalidError(
          `Port '${targetPort.port_id}' requires an exact ArtefactVersion for dynamic membership`,
        );
      }
      const acceptedInputs: NodeExecutionInputRecord[] = [];
      for (const output of carriedOutputs) {
        let memberKey = output.member_key;
        if (isDynamicMemberPort && !memberKey && expectedMembership?.member_key.source === "event_content") {
          const selected = this.readContentKey(event.content, expectedMembership.member_key.path);
          memberKey = selected === null ? "" : String(selected);
        }
        if (isDynamicMemberPort && !memberKey) {
          throw new ScopeExecutionInvalidError(
            `Port '${targetPort.port_id}' requires a stable member key`,
          );
        }
        const receivedCount = this.scopeExecutionStore.listReceivedInputs(targetNodeExecution.node_execution_id)
          .filter((item) => item.port_id === targetPort.port_id).length;
        const pastCardinality = targetPort.max_count !== null
          && targetPort.max_count !== undefined
          && receivedCount >= targetPort.max_count;
        const state = before.status === "collecting" && !pastCardinality ? "received" : "late";
        acceptedInputs.push(this.scopeExecutionStore.acceptInput({
          node_execution_id: targetNodeExecution.node_execution_id,
          port_id: targetPort.port_id,
          delivery_id: queueId,
          event_id: event.event_id,
          artefact_version_id: output.artefact_version_id,
          member_key: memberKey,
          state,
          ...(state === "late"
            ? { reason: { code: pastCardinality ? "port_cardinality_satisfied" : "activation_already_started" } }
            : {}),
        }));
      }
      const receivedFromThisDelivery = acceptedInputs.filter((item) =>
        item.delivery_id === queueId && item.state === "received"
      );
      if (isCollectionPort && receivedFromThisDelivery.length > 0) {
        if (receivedFromThisDelivery.length !== 1 || !receivedFromThisDelivery[0]?.artefact_version_id) {
          throw new ScopeExecutionInvalidError(
            `Port '${targetPort.port_id}' must receive exactly one collection ArtefactVersion`,
          );
        }
        const collectionVersionId = receivedFromThisDelivery[0].artefact_version_id;
        const collectionVersion = this.artefactStore.getVersion(collectionVersionId);
        const collection = collectionVersion ? this.artefactStore.getArtefact(collectionVersion.artefact_id) : null;
        if (!collectionVersion || !collection || collection.workspace_id !== execution.workspace_id
          || collection.type_ref !== "core:collection") {
          throw new ScopeExecutionInvalidError(
            `ArtefactVersion '${collectionVersionId}' is not an exact core:collection in this Workspace`,
          );
        }
        this.scopeExecutionStore.registerExpectedMembership({
          node_execution_id: targetNodeExecution.node_execution_id,
          collection_port_id: expectedMembership!.collection_port_id,
          member_port_id: expectedMembership!.member_port_id,
          collection_artefact_version_id: collectionVersionId,
          match_policy: expectedMembership!.match,
          members: this.artefactStore.listCollectionMembers(collectionVersionId),
        });
      }
      this.scopeExecutionStore.recordTraversal({
        publication_id: publication.publication_id,
        edge_id: edge.edge_id,
        delivery_id: queueId,
        target_node_execution_id: targetNodeExecution.node_execution_id,
      });
      const joinState = this.scopeExecutionStore.getJoinState(targetNodeExecution.node_execution_id);
      const ready = activation.mode === "per_delivery"
        ? receivedFromThisDelivery.length > 0
        : joinState.ready;
      if (ready) {
        const current = this.scopeExecutionStore.getNodeExecution(targetNodeExecution.node_execution_id);
        if (current?.status === "collecting") {
          this.scopeExecutionStore.setNodeExecutionStatus(targetNodeExecution.node_execution_id, "ready");
          this.db.prepare(`
            UPDATE event_queue SET state = 'queued'
            WHERE node_execution_id = ? AND state = 'held'
          `).run(targetNodeExecution.node_execution_id);
          this.db.prepare(`
            UPDATE endpoints
            SET status = CASE WHEN status IN ('active', 'runtime_unconfigured') THEN status ELSE 'queued' END,
                updated_at = ?
            WHERE endpoint_id = ?
          `).run(now(), destinationEndpointId);
        }
      }
      if (receivedFromThisDelivery.length === 0) {
        this.db.prepare(`
          UPDATE event_queue SET state = 'cancelled', last_error = ?
          WHERE queue_id = ? AND state = 'held'
        `).run("duplicate or late input did not alter the NodeExecution", queueId);
      }
      deliveryIds.push(queueId);
    }
    return deliveryIds;
  }

  private resolveCommandPlacementBinding(
    revision: ScopeCompositionRevision,
    node: ScopeNodePlacement,
    existing: NodeExecutionRecord | null,
  ): {
    definition: CommandDefinitionRevision;
    worker: CommandWorkerBindingRecord;
  } {
    if (node.kind !== "command" || !node.resource_id) {
      throw new ScopeExecutionInvalidError(`Node '${node.node_id}' is not a bound Command placement`);
    }
    const worker = existing?.command_worker_binding_id
      ? this.commandWorkerBindingStore.require(existing.command_worker_binding_id)
      : this.commandWorkerBindingStore.ensureDefault(revision.workspace_id, this.localHostId);
    const definition = existing?.command_definition_revision_id
      ? this.commandDefinitionStore.getRevision(existing.command_definition_revision_id)
      : (() => {
          const command = this.commandDefinitionStore.getCommand(node.resource_id as string);
          return command?.status === "active" && command.current_revision_id
            ? this.commandDefinitionStore.getRevision(command.current_revision_id)
            : null;
        })();
    if (!definition || definition.command_id !== node.resource_id || !definition.published_at
      || definition.withdrawn_at !== null) {
      throw new ScopeExecutionInvalidError(
        `Command node '${node.node_id}' has no retained published definition`,
      );
    }
    if (worker.workspace_id !== revision.workspace_id || worker.status !== "available") {
      throw new ScopeExecutionInvalidError(
        `Command worker '${worker.command_worker_binding_id}' is unavailable in this Workspace`,
      );
    }
    resolveCommandImplementation(definition, revision.workspace_id, this.extensionStore);
    return { definition, worker };
  }

  private resolveExecutionContext(
    revision: ScopeCompositionRevision,
    node: ScopeNodePlacement,
    executionId: string,
    activationKey: string,
    createdByEndpointId: string | null,
    content: Record<string, unknown>,
  ): string {
    const policy = node.context_policy;
    if (!policy) {
      throw new ScopeExecutionInvalidError(`node '${node.node_id}' has no Context policy`);
    }
    // A Command is stable executable meaning, not an Endpoint or a Context
    // participant. Its authenticated worker may create the Context without
    // impersonating the Command identity.
    const participants = node.kind === "actor" && node.resource_id ? [node.resource_id] : [];
    if (policy.mode === "fixed") {
      const contextId = policy.context_id;
      if (!this.fixedScopeContextAvailable(revision, contextId)) {
        throw new ScopeExecutionInvalidError(`fixed Context '${contextId}' for node '${node.node_id}' is unavailable in this Scope`);
      }
      for (const endpointId of participants) this.contextStore.addParticipant(contextId, endpointId);
      return contextId;
    }
    const bindingKey = policy.mode === "reuse_by_key"
      ? policy.key_template
        .replaceAll("{{scope_execution_id}}", executionId)
        .replaceAll("{{node_id}}", node.node_id)
        .replaceAll("{{activation_key}}", activationKey)
        .replace(/\{\{content\.([^}]+)\}\}/g, (_match, key: string) => String(this.readContentKey(content, key) ?? ""))
      : `node-execution:${executionId}:${node.node_id}:${activationKey}`;
    if (!bindingKey.trim()) {
      throw new ScopeExecutionInvalidError(`Context key for node '${node.node_id}' resolved to empty text`);
    }
    const existing = this.db.prepare(`
      SELECT context_id FROM node_context_bindings
      WHERE workspace_id = ? AND scope_id = ? AND node_id = ? AND binding_key = ?
    `).get(revision.workspace_id, revision.scope_id, node.node_id, bindingKey) as { context_id: string } | undefined;
    if (existing) {
      const context = this.contextStore.getContext(existing.context_id);
      if (!context || context.lifecycle_state !== "active" || context.content_state !== "available") {
        throw new ScopeExecutionInvalidError(
          `resolved Context '${existing.context_id}' for node '${node.node_id}' is unavailable`,
        );
      }
      for (const endpointId of participants) this.contextStore.addParticipant(existing.context_id, endpointId);
      return existing.context_id;
    }
    const contextId = this.contextStore.createContext({
      workspace_id: revision.workspace_id,
      scope_id: revision.scope_id,
      created_by_endpoint_id: createdByEndpointId,
      participants,
      title: node.label ?? node.node_id,
    });
    this.db.prepare(`
      INSERT INTO node_context_bindings (workspace_id, scope_id, node_id, binding_key, context_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(revision.workspace_id, revision.scope_id, node.node_id, bindingKey, contextId, now());
    return contextId;
  }

  private readContentKey(content: Record<string, unknown>, path: string): unknown | null {
    let current: unknown = content;
    for (const segment of path.split(".").filter(Boolean)) {
      if (!current || typeof current !== "object" || !(segment in current)) return null;
      current = (current as Record<string, unknown>)[segment];
    }
    return current ?? null;
  }

  /** Legacy mutable graphs are import evidence only for Command nodes. */
  createScopeGraph(input: {
    workspace_id: string;
    scope_id: string;
    created_by_endpoint_id?: string | null;
    nodes: ScopeGraphNode[];
  }, broadcast: Broadcast): ScopeGraphRecord {
    validateScopeGraphNodes(input.nodes);

    const existing = this.scopeGraphStore.getScopeGraphForScope(input.workspace_id, input.scope_id);
    if (input.nodes.some((node) => node.kind === "command")
      || existing?.nodes.some((node) => node.kind === "command")) {
      throw new ScopeGraphInvalidError(
        "Legacy graph Command nodes are non-executable evidence. Publish a canonical Scope composition that references a stable Command.",
      );
    }
    if (existing) {
      const subscriptions = input.nodes
        .filter((node): node is Extract<ScopeGraphNode, { kind: "actor" }> => node.kind === "actor")
        .map((node) => ({ endpoint_id: node.endpoint_id, event_types: node.event_types ?? ["*"] }));
      const timestamp = now();
      this.transaction(() => {
        this.db.prepare("DELETE FROM context_subscriptions WHERE context_id = ?").run(existing.context_id);
        const insertParticipant = this.db.prepare(
          "INSERT OR IGNORE INTO context_participants (context_id, endpoint_id, joined_at) VALUES (?, ?, ?)"
        );
        const insertSubscription = this.db.prepare(`
          INSERT INTO context_subscriptions (context_id, endpoint_id, event_types, subscribed_at)
          VALUES (?, ?, ?, ?)
        `);
        for (const subscription of subscriptions) {
          insertParticipant.run(existing.context_id, subscription.endpoint_id, timestamp);
          insertSubscription.run(
            existing.context_id,
            subscription.endpoint_id,
            JSON.stringify(subscription.event_types),
            timestamp
          );
        }
        this.scopeGraphStore.updateScopeGraph({
          workspace_id: input.workspace_id,
          graph_id: existing.graph_id,
          nodes: input.nodes,
        });
        this.scopeStore.setScopeStatus(input.workspace_id, input.scope_id, "active");
      });
      const graph = this.scopeGraphStore.getScopeGraph(input.workspace_id, existing.graph_id) as ScopeGraphRecord;
      broadcast("scope_graph_updated", { graph });
      const scope = this.scopeStore.getScope(input.workspace_id, input.scope_id);
      if (scope) broadcast("scope_updated", { scope });
      return graph;
    }

    const contextId = this.contextStore.createContext({
      workspace_id: input.workspace_id,
      scope_id: input.scope_id,
      created_by_endpoint_id: input.created_by_endpoint_id ?? null,
      participants: []
    });

    for (const node of input.nodes) {
      if (node.kind !== "actor") continue;
      this.contextStore.applyContextSubscriptions(contextId, [
        { endpoint_id: node.endpoint_id, event_types: node.event_types ?? ["*"] }
      ]);
    }

    const graph = this.scopeGraphStore.insertScopeGraph({
      workspace_id: input.workspace_id,
      scope_id: input.scope_id,
      context_id: contextId,
      nodes: input.nodes
    });
    broadcast("scope_graph_created", { graph });
    return graph;
  }

  retireScope(workspaceId: string, scopeId: string, broadcast: Broadcast): {
    ok: true;
    workspace_id: string;
    scope_id: string;
    status: "retired";
    cancelled_delivery_count: number;
    cancelled_queue_count: number;
    cancelled_pulse_count: number;
  } {
    const scope = this.scopeStore.getScope(workspaceId, scopeId);
    if (!scope) throw new ScopeNotFoundError(workspaceId, scopeId);
    if (scope.status === "retired") {
      return {
        ok: true,
        workspace_id: workspaceId,
        scope_id: scopeId,
        status: "retired",
        cancelled_delivery_count: 0,
        cancelled_queue_count: 0,
        cancelled_pulse_count: 0,
      };
    }
    const graphs = this.scopeGraphStore.listScopeGraphs(workspaceId, scopeId);
    const commandEndpointIds = Array.from(new Set(graphs.flatMap((graph) => graph.nodes
      .filter((node): node is Extract<ScopeGraphNode, { kind: "command" }> => node.kind === "command")
      .map((node) => node.endpoint_id))));
    const contextIds = graphs.map((graph) => graph.context_id);
    const activeDeliveries = contextIds.length === 0 ? [] : this.db.prepare(`
      SELECT DISTINCT d.*
      FROM delivery_bundles d
      JOIN events e ON e.event_id = d.trigger_event_id
      WHERE e.context_id IN (${contextIds.map(() => "?").join(", ")})
        AND d.state IN ('reserved', 'delivered_to_bridge', 'injected_to_runtime')
    `).all(...contextIds) as any[];

    const timestamp = now();
    let cancelledQueueCount = 0;
    let cancelledPulseCount = 0;
    this.transaction(() => {
      if (contextIds.length > 0) {
        cancelledQueueCount = Number((this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM event_queue q
          JOIN events e ON e.event_id = q.event_id
          WHERE e.context_id IN (${contextIds.map(() => "?").join(", ")})
            AND q.state IN ('queued', 'reserved', 'delivered_to_bridge', 'injected_to_runtime')
        `).get(...contextIds) as { count: number }).count);
        this.db.prepare(`
          UPDATE event_queue
          SET state = 'cancelled', lease_expires_at = NULL,
              last_error = 'Scope stopped by operator'
          WHERE event_id IN (
            SELECT event_id FROM events
            WHERE context_id IN (${contextIds.map(() => "?").join(", ")})
          ) AND state IN ('queued', 'reserved', 'delivered_to_bridge', 'injected_to_runtime')
        `).run(...contextIds);
        this.db.prepare(`
          UPDATE pending_responses
          SET status = 'cancelled', resolved_at = ?
          WHERE source_event_id IN (
            SELECT event_id FROM events
            WHERE context_id IN (${contextIds.map(() => "?").join(", ")})
          ) AND status = 'pending'
        `).run(timestamp, ...contextIds);
      }
      for (const delivery of activeDeliveries) {
        this.db.prepare(`
          UPDATE delivery_bundles
          SET state = 'cancelled', lease_expires_at = NULL,
              last_error = 'Scope stopped by operator'
          WHERE delivery_id = ?
        `).run(delivery.delivery_id);
      }
      cancelledPulseCount = Number((this.db.prepare(`
        SELECT COUNT(*) AS count FROM pulses
        WHERE workspace_id = ? AND scope_id = ? AND status IN ('active', 'paused')
      `).get(workspaceId, scopeId) as { count: number }).count);
      this.db.prepare(`
        UPDATE pulses SET status = 'cancelled', next_fire_at = NULL, updated_at = ?
        WHERE workspace_id = ? AND scope_id = ? AND status IN ('active', 'paused')
      `).run(timestamp, workspaceId, scopeId);
      for (const graph of graphs) {
        this.db.prepare("DELETE FROM context_subscriptions WHERE context_id = ?").run(graph.context_id);
      }
      for (const endpointId of commandEndpointIds) {
        this.db.prepare("DELETE FROM runtime_bindings WHERE endpoint_id = ?").run(endpointId);
        this.db.prepare(`
          UPDATE endpoints SET bridge_id = NULL, status = 'retired', updated_at = ?
          WHERE endpoint_id = ?
        `).run(timestamp, endpointId);
      }
      this.scopeStore.setScopeStatus(workspaceId, scopeId, "retired");
    });
    const retired = this.scopeStore.getScope(workspaceId, scopeId);
    for (const delivery of activeDeliveries) {
      broadcast("delivery_cancel_requested", {
        workspace_id: workspaceId,
        scope_id: scopeId,
        delivery_id: delivery.delivery_id,
        endpoint_id: delivery.endpoint_id,
      });
      broadcast("delivery_cancelled", {
        workspace_id: workspaceId,
        scope_id: scopeId,
        delivery_id: delivery.delivery_id,
        endpoint_id: delivery.endpoint_id,
      });
    }
    const commandEndpointSet = new Set(commandEndpointIds);
    for (const endpointId of new Set(activeDeliveries.map((delivery) => String(delivery.endpoint_id)))) {
      if (!commandEndpointSet.has(endpointId)) this.reportTurnEnd(endpointId, broadcast);
    }
    const currentContextId = graphs.at(-1)?.context_id;
    if (currentContextId) {
      this.appendContextEvent({
        type: "work.stopped",
        workspace_id: workspaceId,
        context_id: currentContextId,
        content: {
          text: "This work was stopped. No queued or active delivery will be resumed automatically.",
          scope_id: scopeId,
          cancelled_delivery_count: activeDeliveries.length,
          cancelled_queue_count: cancelledQueueCount,
          cancelled_pulse_count: cancelledPulseCount,
        },
        metadata: { origin: "scope_retirement", terminal: true },
        idempotency_key: `scope-stopped:${workspaceId}:${scopeId}`,
      }, broadcast);
    }
    broadcast("scope_retired", {
      scope: retired,
      cancelled_delivery_count: activeDeliveries.length,
      cancelled_queue_count: cancelledQueueCount,
      cancelled_pulse_count: cancelledPulseCount,
    });
    for (const endpointId of commandEndpointIds) {
      const endpoint = this.getEndpoint(endpointId);
      if (endpoint) broadcast("endpoint_retired", { endpoint });
    }
    return {
      ok: true,
      workspace_id: workspaceId,
      scope_id: scopeId,
      status: "retired",
      cancelled_delivery_count: activeDeliveries.length,
      cancelled_queue_count: cancelledQueueCount,
      cancelled_pulse_count: cancelledPulseCount,
    };
  }

  /**
   * Fires a trigger node: emits into the graph's Context once per endpoint
   * whose EXISTING context subscription (ContextStore.getContextSubscriptions)
   * matches the trigger's event type, via emitTriggerEvent — the same
   * bus-originated wake primitive pulse firing already uses. There is no
   * separate edge table to walk; the Context's own subscription state decides
   * who wakes, exactly as it would for any other Context.
   */
  fireScopeGraphTrigger(input: {
    workspace_id: string;
    graph_id: string;
    node_id: string;
    content: Record<string, unknown>;
    correlation_id?: string | null;
    idempotency_key?: string | null;
  }, broadcast: Broadcast): EventEnvelope[] {
    const graph = this.scopeGraphStore.getScopeGraph(input.workspace_id, input.graph_id);
    if (!graph) throw new ScopeGraphNotFoundError(input.workspace_id, input.graph_id);
    const scope = this.scopeStore.getScope(input.workspace_id, graph.scope_id);
    if (scope?.status === "retired") throw new ScopeRetiredError(input.workspace_id, graph.scope_id);

    const node = graph.nodes.find((candidate) => candidate.node_id === input.node_id);
    if (!node) throw new ScopeGraphNodeNotFoundError(input.graph_id, input.node_id);
    if (node.kind !== "trigger") throw new ScopeGraphNodeNotATriggerError(input.graph_id, input.node_id);

    const legacyCommandEndpoints = new Set(graph.nodes
      .filter((candidate): candidate is Extract<ScopeGraphNode, { kind: "command" }> => candidate.kind === "command")
      .map((candidate) => candidate.endpoint_id));
    const subscriptions = this.contextStore.getContextSubscriptions(graph.context_id)
      .filter((subscription) => !legacyCommandEndpoints.has(subscription.endpoint_id))
      .filter((subscription) => subscription.event_types.includes("*") || subscription.event_types.includes(node.event_type));
    const triggerFireId = input.idempotency_key
      ? `trigger_fire_${stableHash(input.idempotency_key).slice(0, 32)}`
      : `trigger_fire_${randomUUID()}`;

    return subscriptions.map((subscription) =>
      this.emitTriggerEvent(
        {
          type: node.event_type,
          workspace_id: input.workspace_id,
          target_endpoint_id: subscription.endpoint_id,
          context_id: graph.context_id,
          correlation_id: input.correlation_id ?? null,
          content: input.content,
          metadata: {
            trigger_kind: "scope_graph",
            graph_id: input.graph_id,
            node_id: input.node_id,
            trigger_fire_id: triggerFireId
          },
          idempotency_key: input.idempotency_key
            ? `${input.idempotency_key}:${subscription.endpoint_id}`
            : null
        },
        broadcast
      )
    );
  }

  private validateScopeId(workspaceId: string, scopeId: string): string {
    if (!this.scopeStore.getScope(workspaceId, scopeId)) {
      throw new ScopeNotFoundError(workspaceId, scopeId);
    }
    return scopeId;
  }

  private requireScopeId(workspaceId: string, scopeId: string | null | undefined, reason: string): string {
    if (!scopeId) throw new ScopeRequiredError(workspaceId, reason);
    return this.validateScopeId(workspaceId, scopeId);
  }

  private getContextAnchor(workspaceId: string, contextId: string): ContextRecord {
    const context = this.contextStore.getContext(contextId);
    if (!context || context.workspace_id !== workspaceId) {
      throw new ContextNotFoundError(workspaceId, contextId);
    }
    return context;
  }

  private requireEndpointContextAnchor(workspaceId: string, contextId: string, endpointId: string): ContextRecord {
    const context = this.getContextAnchor(workspaceId, contextId);
    if (!context.scope_id && !this.contextStore.isParticipant(contextId, endpointId)) {
      throw new ContextAnchorError(
        workspaceId,
        contextId,
        "unscoped endpoint delivery Context must include the target endpoint as a participant"
      );
    }
    return context;
  }

  private validatePulseSubscriberAnchor(input: {
    workspace_id: string;
    pulse_scope_id: string | null;
    subscriber: PulseSubscriber;
    allow_missing_generated_scope?: boolean;
  }): { creates_generated_delivery_context: boolean; anchor_scope_id: string | null } {
    const { workspace_id: workspaceId, pulse_scope_id: pulseScopeId, subscriber } = input;
    if (subscriber.kind === "context") {
      return {
        creates_generated_delivery_context: false,
        anchor_scope_id: this.getContextAnchor(workspaceId, subscriber.context_id).scope_id
      };
    }

    if (subscriber.context_id) {
      const endpointId = this.resolveSubscriberEndpointId(workspaceId, subscriber.endpoint_ref);
      return {
        creates_generated_delivery_context: false,
        anchor_scope_id: this.requireEndpointContextAnchor(workspaceId, subscriber.context_id, endpointId).scope_id
      };
    }

    if (!pulseScopeId && !input.allow_missing_generated_scope) {
      throw new ScopeRequiredError(
        workspaceId,
        "pulse must be configured with a Scope before adding generated endpoint delivery"
      );
    }

    return { creates_generated_delivery_context: true, anchor_scope_id: null };
  }

  listRuntimeBindings(workspaceId?: string): RuntimeBindingRecord[] {
    const rows = workspaceId
      ? this.db.prepare("SELECT * FROM runtime_bindings WHERE workspace_id = ? OR scope = 'global_default' ORDER BY scope, endpoint_id").all(workspaceId) as any[]
      : this.db.prepare("SELECT * FROM runtime_bindings ORDER BY scope, workspace_id, endpoint_id").all() as any[];
    return rows.map((row) => this.rowToRuntimeBinding(row));
  }

  getRuntimeBindingResolution(workspaceId: string, endpointId: string): {
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
  } {
    const endpoint = this.db.prepare(`
      SELECT auth_profile, provider, model, thinking_level
      FROM runtime_bindings
      WHERE scope = 'agent' AND workspace_id = ? AND endpoint_id = ?
      LIMIT 1
    `).get(workspaceId, endpointId) as { auth_profile: string; provider: string | null; model: string | null; thinking_level: string | null } | undefined;
    const workspace = this.db.prepare(`
      SELECT auth_profile, provider, model, thinking_level
      FROM runtime_bindings
      WHERE scope = 'workspace_default' AND workspace_id = ?
      LIMIT 1
    `).get(workspaceId) as { auth_profile: string; provider: string | null; model: string | null; thinking_level: string | null } | undefined;
    const global = this.db.prepare(`
      SELECT auth_profile, provider, model, thinking_level
      FROM runtime_bindings
      WHERE scope = 'global_default'
      LIMIT 1
    `).get() as { auth_profile: string; provider: string | null; model: string | null; thinking_level: string | null } | undefined;
    return {
      endpoint_auth_profile: endpoint?.auth_profile ?? null,
      workspace_auth_profile: workspace?.auth_profile ?? null,
      global_auth_profile: global?.auth_profile ?? null,
      endpoint_provider: endpoint?.provider ?? null,
      workspace_provider: workspace?.provider ?? null,
      global_provider: global?.provider ?? null,
      endpoint_model: endpoint?.model ?? null,
      workspace_model: workspace?.model ?? null,
      global_model: global?.model ?? null,
      endpoint_thinking_level: endpoint?.thinking_level ?? null,
      workspace_thinking_level: workspace?.thinking_level ?? null,
      global_thinking_level: global?.thinking_level ?? null
    };
  }

  upsertRuntimeBinding(input: {
    scope: RuntimeBindingScope;
    workspace_id?: string | null;
    endpoint_id?: string | null;
    auth_profile: string;
    provider: string;
    model?: string | null;
    thinking_level?: string | null;
  }, broadcast: Broadcast): RuntimeBindingRecord {
    const timestamp = now();
    const bindingKey = runtimeBindingKey(input.scope, input.workspace_id ?? null, input.endpoint_id ?? null);
    this.db.prepare(`
      INSERT INTO runtime_bindings (
        binding_key, scope, workspace_id, endpoint_id, auth_profile, provider, model, thinking_level, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(binding_key) DO UPDATE SET
        auth_profile = excluded.auth_profile,
        provider = excluded.provider,
        model = excluded.model,
        thinking_level = excluded.thinking_level,
        updated_at = excluded.updated_at
    `).run(
      bindingKey,
      input.scope,
      input.workspace_id ?? null,
      input.endpoint_id ?? null,
      input.auth_profile,
      input.provider,
      input.model ?? null,
      input.thinking_level ?? null,
      timestamp,
      timestamp
    );
    const row = this.db.prepare("SELECT * FROM runtime_bindings WHERE binding_key = ?").get(bindingKey) as any;
    const binding = this.rowToRuntimeBinding(row);
    broadcast("runtime_binding_updated", { binding });
    return binding;
  }

  clearRuntimeBinding(input: {
    scope: RuntimeBindingScope;
    workspace_id?: string | null;
    endpoint_id?: string | null;
  }, broadcast: Broadcast): { ok: true; binding_key: string } {
    const bindingKey = runtimeBindingKey(input.scope, input.workspace_id ?? null, input.endpoint_id ?? null);
    this.db.prepare("DELETE FROM runtime_bindings WHERE binding_key = ?").run(bindingKey);
    broadcast("runtime_binding_cleared", { binding_key: bindingKey });
    return { ok: true, binding_key: bindingKey };
  }

  listBridges(): BridgeRecord[] {
    const rows = this.db.prepare("SELECT * FROM bridges ORDER BY created_at, bridge_id").all() as any[];
    return rows.map((row) => ({
      bridge_id: String(row.bridge_id),
      status: String(row.status),
      capabilities: parseJson<Record<string, unknown>>(String(row.capabilities_json ?? "{}")),
      last_seen_at: String(row.last_seen_at),
      created_at: String(row.created_at)
    }));
  }

  deleteWorkspace(workspaceId: string, options: { delete_locator?: boolean }, broadcast: Broadcast): {
    ok: true;
    workspace_id: string;
    locator: string;
    locator_deleted: boolean;
  } {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Unknown workspace_id: ${workspaceId}`);
    const locator = String(workspace.locator ?? "");
    const deleteLocator = !!options.delete_locator;
    let locatorDeleted = false;
    if (deleteLocator && locator) locatorDeleted = deleteWorkspaceLocator(locator);
    this.transaction(() => {
      this.db.prepare("DELETE FROM event_queue WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM delivery_bundles WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM pending_responses WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM runtime_telemetry WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM events WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM pulse_delivery_contexts WHERE workspace_id = ?").run(workspaceId);
      // Scope graphs intentionally have no foreign key to the workspace table.
      // Remove them explicitly so re-registering the same locator cannot
      // resurrect obsolete command endpoints from an orphaned composition.
      this.db.prepare("DELETE FROM scope_graphs WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare(`
        DELETE FROM context_participants
        WHERE context_id IN (SELECT context_id FROM contexts WHERE workspace_id = ?)
      `).run(workspaceId);
      this.db.prepare("DELETE FROM actor_role_assignments WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM principal_actor_bindings WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM contexts WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM scopes WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM endpoints WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM runtime_bindings WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM workspace_locator_bindings WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM workspaces WHERE workspace_id = ?").run(workspaceId);
    });
    const payload = {
      workspace_id: workspaceId,
      delete_locator: deleteLocator,
      locator_deleted: locatorDeleted
    };
    broadcast("workspace_deleted", payload);
    return { ok: true, workspace_id: workspaceId, locator, locator_deleted: locatorDeleted };
  }

  assignContextScope(input: {
    workspace_id: string;
    context_id: string;
    scope_id: string;
    assigned_by?: string | null;
    reason?: string | null;
  }, broadcast: Broadcast): {
    ok: true;
    context: ContextRecord & { participants: string[] };
    audit_event: EventEnvelope;
  } {
    const result = this.transaction(() => {
      const context = this.getContextAnchor(input.workspace_id, input.context_id);
      const scopeId = this.validateScopeId(input.workspace_id, input.scope_id);
      const participants = this.contextStore.getContextParticipants(input.context_id);
      if (context.scope_id) {
        throw new ContextScopeAssignmentError(input.workspace_id, input.context_id, "context_already_scoped");
      }
      if (participants.length === 0) {
        throw new ContextScopeAssignmentError(input.workspace_id, input.context_id, "orphan_context");
      }

      const updated = this.contextStore.setContextScope(input.context_id, scopeId);
      if (!updated) throw new ContextNotFoundError(input.workspace_id, input.context_id);

      const auditEvent = this.insertEvent(
        {
          type: "context.scope_assigned",
          workspace_id: input.workspace_id,
          source_endpoint_id: null,
          destination: { kind: "context", context_id: input.context_id },
          thread_id: undefined,
          correlation_id: null,
          content: {},
          metadata: {
            previous_scope_id: context.scope_id,
            scope_id: scopeId,
            ...(input.assigned_by ? { assigned_by: input.assigned_by } : {}),
            ...(input.reason ? { reason: input.reason } : {})
          },
          idempotency_key: null
        },
        this.normalizeResponse({ expected: false }),
        input.context_id
      );

      return {
        ok: true as const,
        context: { ...updated, participants },
        audit_event: auditEvent
      };
    });

    broadcast("context_scope_assigned", {
      context: result.context,
      audit_event: result.audit_event
    });
    this.broadcastEventSubmission(result.audit_event, broadcast);
    return result;
  }

  registerBridge(input: { bridge_id: string; capabilities?: Record<string, unknown> }, broadcast: Broadcast): unknown {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO bridges (bridge_id, status, capabilities_json, last_seen_at, created_at)
      VALUES (?, 'online', ?, ?, ?)
      ON CONFLICT(bridge_id) DO UPDATE SET
        status = 'online',
        capabilities_json = excluded.capabilities_json,
        last_seen_at = excluded.last_seen_at
    `).run(input.bridge_id, json(input.capabilities ?? {}), timestamp, timestamp);
    const bridge = this.db.prepare("SELECT * FROM bridges WHERE bridge_id = ?").get(input.bridge_id);
    broadcast("bridge_registered", { bridge });
    // Runtime sessions are process-local and intentionally ephemeral. A fresh
    // bridge registration cannot still own a turn injected by the previous
    // process with the same bridge id. Settle those turns without replaying
    // work that may already have changed the workspace.
    const abandoned = this.db.prepare(`
      SELECT db.*
      FROM delivery_bundles db
      JOIN endpoints e ON e.endpoint_id = db.endpoint_id
      WHERE e.bridge_id = ? AND db.state = 'injected_to_runtime'
      ORDER BY db.created_at ASC
    `).all(input.bridge_id) as any[];
    for (const delivery of abandoned) {
      this.failUnknownRuntimeDelivery(
        delivery,
        "runtime process restarted before reporting a durable completion",
        broadcast
      );
    }
    return bridge;
  }

  reportBridgeLiveness(bridgeId: string): void {
    this.db.prepare("UPDATE bridges SET status = 'online', last_seen_at = ? WHERE bridge_id = ?").run(now(), bridgeId);
  }

  registerEndpoint(input: {
    endpoint_id: string;
    workspace_id: string;
    name: string;
    agent_id?: string | null;
    bridge_id?: string | null;
    status?: string;
    metadata?: Record<string, unknown>;
  }, broadcast: Broadcast): unknown {
    const timestamp = now();
    const existing = input.bridge_id ? this.getEndpoint(input.endpoint_id) : undefined;
    const requestedStatus = input.status ?? "idle";
    // Rediscovery refreshes attachment, not the outcome of existing work.
    // A runtime must use its explicit transition to resume or recover work.
    const reportedStatus = existing?.bridge_id === input.bridge_id
      && existing?.workspace_id === input.workspace_id
      && ["idle", "runtime_unconfigured"].includes(requestedStatus)
      && ["active", "waiting", "error", "retired"].includes(existing.status)
      ? existing.status : requestedStatus;
    const status = input.bridge_id && ["idle", "waiting", "runtime_unconfigured"].includes(reportedStatus)
      ? this.runtimeConfigurationStatus(input.workspace_id, input.endpoint_id, reportedStatus)
      : reportedStatus;
    this.db.prepare(`
      INSERT INTO endpoints (
        endpoint_id, workspace_id, name, agent_id, bridge_id, status,
        metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        name = excluded.name,
        agent_id = excluded.agent_id,
        bridge_id = excluded.bridge_id,
        status = excluded.status,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      input.endpoint_id,
      input.workspace_id,
      input.name,
      input.agent_id ?? null,
      input.bridge_id ?? null,
      status,
      json(input.metadata ?? {}),
      timestamp,
      timestamp
    );
    const endpoint = this.getEndpoint(input.endpoint_id);
    broadcast("endpoint_registered", { endpoint });
    this.tryCreateDeliveryForEndpoint(input.endpoint_id, broadcast);
    return endpoint;
  }

  private runtimeConfigurationStatus(workspaceId: string, endpointId: string, fallback: string): string {
    const binding = this.runtimeProfileStore.getCurrentActorBindingForEndpoint(workspaceId, endpointId);
    if (!binding) return fallback;
    const actor = this.actorDefinitionStore.getActor(binding.actor_id);
    if (binding.status !== "resolved" || actor?.status !== "active") return "runtime_unconfigured";
    return fallback === "runtime_unconfigured" ? "idle" : fallback;
  }

  listEndpoints(workspaceId?: string): unknown[] {
    if (workspaceId) return this.db.prepare("SELECT * FROM endpoints WHERE workspace_id = ? ORDER BY name").all(workspaceId);
    return this.db.prepare("SELECT * FROM endpoints ORDER BY workspace_id, name").all();
  }

  /** Host attachment is a projection of current canonical bindings, never an import receipt. */
  listRuntimeEndpoints(workspaceId: string) {
    return this.actorDefinitionStore.listActors(workspaceId).flatMap(actor => {
      const binding = this.runtimeProfileStore.getCurrentActorBinding(actor.actor_id);
      if (!binding?.endpoint_id || binding.workspace_id !== workspaceId || binding.status === "disabled") return [];
      const endpoint = this.getEndpoint(binding.endpoint_id);
      if (endpoint?.status === "retired" || (endpoint && endpoint.workspace_id !== workspaceId)) return [];
      const definition = actor.current_definition_revision_id
        ? this.actorDefinitionStore.getRevision(actor.current_definition_revision_id) : null;
      const profile = this.runtimeProfileStore.getRevision(binding.runtime_profile_revision_id);
      if (!definition?.published_at || definition.withdrawn_at || !profile?.published_at || profile.withdrawn_at
        || this.runtimeProfileStore.getProfile(profile.runtime_profile_id)?.status !== "active") return [];
      return [{
        endpoint_id: binding.endpoint_id,
        actor_id: actor.actor_id,
        name: definition.content.label,
        // The agent_id is the source actor id, i.e. the segment after the
        // `actor:<workspace_id>:` prefix that actorId/endpointId are built from
        // (workspaceConfigurationActorId). The endpoint record's own agent_id
        // is null until a Bridge first registers it, and the Bridge sources that
        // value from this very projection — so fall back to the canonical
        // identity here to break that chicken-and-egg and keep work-log paths
        // populated for every runtime adapter.
        agent_id: endpoint?.agent_id ?? sourceActorIdFromActorId(actor.actor_id, workspaceId),
        adapter_id: profile.content.adapter_id,
        actor_definition_revision_id: definition.actor_definition_revision_id,
        runtime_profile_revision_id: profile.runtime_profile_revision_id,
        actor_runtime_binding_id: binding.actor_runtime_binding_id,
        runtime_status: binding.status,
        unresolved_reasons: binding.unresolved_reasons,
      }];
    });
  }

  getEndpoint(endpointId: string): any {
    return this.db.prepare("SELECT * FROM endpoints WHERE endpoint_id = ?").get(endpointId) as any;
  }

  deleteEndpoint(endpointId: string, broadcast: Broadcast): { ok: true; endpoint_id: string } {
    const endpoint = this.getEndpoint(endpointId);
    if (!endpoint) throw new Error(`Endpoint not found: ${endpointId}`);
    this.db.prepare("DELETE FROM event_queue WHERE destination_endpoint_id = ?").run(endpointId);
    this.db.prepare("DELETE FROM endpoints WHERE endpoint_id = ?").run(endpointId);
    broadcast("endpoint_deleted", { endpoint_id: endpointId });
    return { ok: true, endpoint_id: endpointId };
  }

  /**
   * Makes an Endpoint permanently inert without erasing its identity from
   * historical Contexts and Events. Workspace configuration must also stop
   * declaring the Endpoint, otherwise a later registration intentionally
   * reactivates it.
   */
  retireEndpoint(endpointId: string, broadcast: Broadcast): { ok: true; endpoint_id: string; status: "retired" } {
    const endpoint = this.getEndpoint(endpointId);
    if (!endpoint) throw new Error(`Endpoint not found: ${endpointId}`);
    const status = String(endpoint.status);
    if (!new Set(["idle", "offline", "error", "runtime_unconfigured", "retired"]).has(status)) {
      throw new EndpointRetirementBlockedError(endpointId, status);
    }

    this.transaction(() => {
      this.db.prepare("DELETE FROM context_subscriptions WHERE endpoint_id = ?").run(endpointId);
      this.db.prepare("DELETE FROM runtime_bindings WHERE endpoint_id = ?").run(endpointId);
      this.db.prepare(`
        UPDATE endpoints
        SET bridge_id = NULL, status = 'retired', updated_at = ?
        WHERE endpoint_id = ?
      `).run(now(), endpointId);
    });
    const retired = this.getEndpoint(endpointId);
    broadcast("endpoint_retired", { endpoint: retired });
    return { ok: true, endpoint_id: endpointId, status: "retired" };
  }

  updateEndpointStatus(endpointId: string, status: string, broadcast: Broadcast): unknown {
    this.db.prepare("UPDATE endpoints SET status = ?, updated_at = ? WHERE endpoint_id = ?").run(status, now(), endpointId);
    const endpoint = this.getEndpoint(endpointId);
    broadcast("status_changed", { endpoint });
    if (status === "idle" || status === "waiting") this.tryCreateDeliveryForEndpoint(endpointId, broadcast);
    return endpoint;
  }

  reportAttachment(input: {
    workspace_id: string;
    binding_id: string;
    status: string;
    bridge_id: string;
    config_hash?: string | null;
    error_code?: string | null;
    validation?: unknown;
  }, broadcast: Broadcast): unknown {
    this.updateAttachmentWithoutConfiguration(input.workspace_id, input.binding_id, input.status);
    const workspace = this.requireLocalWorkspace(input.workspace_id);
    broadcast("workspace_attachment_result", {
      workspace: this.workspaceIdentityStore.getRemoteProjection(input.workspace_id, this.localHostId),
      bridge_id: input.bridge_id,
      error_code: input.error_code ?? null,
      validation: input.validation ?? null
    });
    return workspace;
  }

  submitEvent(command: EventCommand, broadcast: Broadcast): { event: EventEnvelope; deliveries_created: number } {
    const response = this.normalizeResponse(command.response);
    const event = this.transaction(() => {
      if (command.idempotency_key) {
        const existing = this.db.prepare("SELECT * FROM events WHERE idempotency_key = ?").get(command.idempotency_key) as any;
        if (existing) return this.rowToEvent(existing);
      }
      const explicitScopeId = command.scope_id ? this.validateScopeId(command.workspace_id, command.scope_id) : null;

      const resolution = resolveContext(
        {
          source_endpoint_id: command.source_endpoint_id,
          destination: command.destination,
          supplied_context_id: command.context_id ?? null,
          current_delivery_context_id: command.current_delivery_context_id ?? null,
          // thread_id from the caller IS the current delivery thread — used as
          // parent when Rule 3 opens a side thread inside the current context.
          workspace_id: command.workspace_id
        },
        this.contextStore
      );
      if ("error" in resolution) throw new ContextParticipantError(resolution.payload);
      if (resolution.created) {
        this.contextStore.createContext({
          workspace_id: command.workspace_id,
          scope_id: explicitScopeId,
          created_by_endpoint_id: command.source_endpoint_id,
          participants: resolution.participants ?? [command.source_endpoint_id],
          context_id: resolution.context_id,
          parent_context_id: resolution.parent_context_id ?? null
        });
              }
      const resolvedContextId = resolution.context_id;

      const inserted = this.insertEvent(
        {
          type: command.type,
          workspace_id: command.workspace_id,
          source_endpoint_id: command.source_endpoint_id,
          destination: command.destination,
          thread_id: command.thread_id,
          correlation_id: command.correlation_id ?? null,
          content: command.content,
          artefact_version_ids: command.artefact_version_ids,
          metadata: command.metadata ?? {},
          idempotency_key: command.idempotency_key ?? null
        },
        response,
        resolvedContextId
      );
      const destinationEndpointIds = this.resolveDestinations(inserted);
      for (const destinationEndpointId of destinationEndpointIds) this.queueEvent(inserted.event_id, inserted.workspace_id, destinationEndpointId);
      if (inserted.response.expected) this.createPendingResponse(inserted);
      this.resolvePendingResponsesForIncoming(inserted);
      return inserted;
    });

    return this.broadcastEventSubmission(event, broadcast);
  }

  /**
   * Authenticated principal communication inside one existing Context. The
   * principal is recorded as provenance rather than impersonating an Actor
   * endpoint. This reuses the same Event insert, destination resolution,
   * durable queue, and push path as other direct Event communication.
   */
  submitPrincipalContextCommunication(command: {
    type: string;
    workspace_id: string;
    context_id: string;
    principal_id: string;
    recipient_endpoint_id: string | null;
    content: Readonly<Record<string, unknown>>;
    artefact_version_ids: readonly string[];
    attachment_ingress_ids: readonly string[];
    response_expected: boolean;
    idempotency_key: string;
    provenance: OperationInvocationProvenance;
  }, broadcast: Broadcast): {
    event: EventEnvelope;
    deliveries_created: number;
    attached_artefact_version_ids: string[];
  } {
    const existing = this.db.prepare("SELECT * FROM events WHERE idempotency_key = ?")
      .get(command.idempotency_key) as any;
    if (existing) {
      const event = this.rowToEvent(existing);
      if (
        event.workspace_id !== command.workspace_id
        || event.context_id !== command.context_id
        || event.source_endpoint_id !== null
        || event.metadata.source_principal_id !== command.principal_id
        || event.metadata.semantic_operation_id !== "context.communication.emit"
      ) {
        throw new Error("The message retry does not identify communication by this principal in this Context.");
      }
      return {
        ...this.broadcastEventSubmission(event, broadcast),
        attached_artefact_version_ids: this.eventArtefactVersionIds(event.event_id),
      };
    }

    const context = this.contextStore.getContext(command.context_id);
    if (
      !context
      || context.workspace_id !== command.workspace_id
      || context.lifecycle_state !== "active"
    ) {
      throw new Error(`Context is not active in this Workspace: ${command.context_id}`);
    }
    if (
      command.recipient_endpoint_id
      && !this.contextStore.isParticipant(command.context_id, command.recipient_endpoint_id)
    ) {
      throw new Error(
        `Recipient '${command.recipient_endpoint_id}' is not a participant in Context '${command.context_id}'.`,
      );
    }
    if (command.attachment_ingress_ids.length > 0 && Object.hasOwn(command.content, "attachments")) {
      throw new Error("Attachment display data is produced by Floe from the exact uploaded ArtefactVersions.");
    }

    const committed = this.attachmentIngressStore.commitMany({
      ingress_session_ids: command.attachment_ingress_ids,
      workspace_id: command.workspace_id,
      context_id: command.context_id,
      principal_id: command.principal_id,
    }, (ingresses) => {
      const createdContentPaths: string[] = [];
      let event: EventEnvelope;
      try {
        event = this.transaction(() => {
          const createdVersions = ingresses.map((ingress) => {
            const artefact = this.artefactStore.createArtefact({
              workspace_id: command.workspace_id,
              type_ref: attachmentTypeRef(ingress.media_type),
              idempotency_key: `attachment-ingress:${ingress.ingress_session_id}:artefact`,
            });
            return this.artefactStore.publishVersion({
              artefact_id: artefact.artefact_id,
              idempotency_key: `attachment-ingress:${ingress.ingress_session_id}:version`,
              content_ref: {
                kind: "workspace-relative",
                path: contextAttachmentContentPath(ingress.digest.value),
                digest: ingress.digest,
                media_type: ingress.media_type,
                size_bytes: ingress.size_bytes,
              },
            });
          });
          const artefactVersionIds = [
            ...command.artefact_version_ids,
            ...createdVersions.map(version => version.artefact_version_id),
          ];
          if (new Set(artefactVersionIds).size !== artefactVersionIds.length) {
            throw new Error("A Context message cannot attach the same ArtefactVersion more than once.");
          }
          const content = {
            ...command.content,
            ...(createdVersions.length > 0 ? {
              attachments: createdVersions.map((version, index) => ({
                artefact_version_id: version.artefact_version_id,
                name: ingresses[index]!.name,
                media_type: ingresses[index]!.media_type,
                bytes: ingresses[index]!.size_bytes,
              })),
            } : {}),
          };
          const inserted = this.insertEvent({
            type: command.type,
            workspace_id: command.workspace_id,
            source_endpoint_id: null,
            destination: command.recipient_endpoint_id
              ? { kind: "endpoint", endpoint_id: command.recipient_endpoint_id }
              : { kind: "context", context_id: command.context_id },
            correlation_id: null,
            content,
            artefact_version_ids: artefactVersionIds,
            artefact_role: "attachment",
            metadata: {
              source_principal_id: command.principal_id,
              semantic_operation_id: "context.communication.emit",
              cause_event_id: command.provenance.cause_event_id,
              delivery_ids: [...command.provenance.delivery_ids],
              execution_attempt_id: command.provenance.execution_attempt_id,
              node_execution_id: command.provenance.node_execution_id,
              scope_execution_id: command.provenance.scope_execution_id,
            },
            idempotency_key: command.idempotency_key,
          }, this.normalizeResponse({ expected: command.response_expected }), command.context_id);
          this.associateArtefactVersions(artefactVersionIds, [{
            kind: "context",
            id: command.context_id,
            role: "attachment",
          }]);

          for (const endpointId of this.resolveDestinations(inserted)) {
            this.queueEvent(inserted.event_id, inserted.workspace_id, endpointId);
          }
          // Validate and insert every reference before publishing bytes. A later
          // write or transaction failure removes only content created here.
          for (const ingress of ingresses) {
            const createdPath = this.persistContextAttachmentContent(command.workspace_id, ingress);
            if (createdPath) createdContentPaths.push(createdPath);
          }
          // A principal has no Actor endpoint to block while awaiting a response.
          // The Event still records response.expected for the recipient and client.
          return inserted;
        });
      } catch (error) {
        for (const path of createdContentPaths) rmSync(path, { force: true });
        throw error;
      }
      return {
        event,
        attached_artefact_version_ids: this.eventArtefactVersionIds(event.event_id),
      };
    });
    return {
      ...this.broadcastEventSubmission(committed.event, broadcast),
      attached_artefact_version_ids: committed.attached_artefact_version_ids,
    };
  }

  /**
   * Bus-originated trigger emission (design §3.1.6).
   *
   * Always creates a fresh, target-only context (`participants = [target_endpoint_id]`).
   * The event row's `source_endpoint_id` is `null` — never a synthetic
   * `system:*` or `webhook:*` endpoint, never added to the participant set.
   * The resolver participant-aware rule is intentionally bypassed: triggers
   * are not actor-to-actor messages.
   */
  emitTriggerEvent(command: TriggerEventCommand, broadcast: Broadcast): EventEnvelope {
    const event = this.transaction(() => {
      if (command.idempotency_key) {
        const existing = this.db.prepare("SELECT * FROM events WHERE idempotency_key = ?").get(command.idempotency_key) as any;
        if (existing) return this.rowToEvent(existing);
      }
      if (command.scope_id) this.validateScopeId(command.workspace_id, command.scope_id);

      let contextId: string;
      if (command.context_id) {
        this.requireEndpointContextAnchor(command.workspace_id, command.context_id, command.target_endpoint_id);
        contextId = command.context_id;
      } else {
        const scopeId = this.requireScopeId(command.workspace_id, command.scope_id, "trigger event creates an operational Context");
        contextId = this.contextStore.createContext({
          workspace_id: command.workspace_id,
          scope_id: scopeId,
          created_by_endpoint_id: command.target_endpoint_id,
          participants: [command.target_endpoint_id]
        });
      }

      const inserted = this.insertEvent(
        {
          type: command.type,
          workspace_id: command.workspace_id,
          source_endpoint_id: null,
          destination: { kind: "endpoint", endpoint_id: command.target_endpoint_id },
          thread_id: undefined,
          correlation_id: command.correlation_id ?? null,
          content: command.content,
          metadata: command.metadata,
          idempotency_key: command.idempotency_key ?? null
        },
        this.normalizeResponse({ expected: false }),
        contextId
      );
      const destinationEndpointIds = this.resolveDestinations(inserted);
      for (const destinationEndpointId of destinationEndpointIds) this.queueEvent(inserted.event_id, inserted.workspace_id, destinationEndpointId);
      // No pending-response: triggers do not expect a reply.
      // No resolvePendingResponsesForIncoming: trigger has no source actor.
      return inserted;
    });

    return this.broadcastEventSubmission(event, broadcast).event;
  }

  appendContextEvent(command: {
    type: string;
    workspace_id: string;
    context_id: string;
    content: Record<string, unknown>;
    metadata: Record<string, unknown>;
    correlation_id?: string | null;
    idempotency_key?: string | null;
  }, broadcast: Broadcast): EventEnvelope {
    const event = this.transaction(() => {
      if (command.idempotency_key) {
        const existing = this.db.prepare("SELECT * FROM events WHERE idempotency_key = ?").get(command.idempotency_key) as any;
        if (existing) return this.rowToEvent(existing);
      }

      const context = this.contextStore.getContext(command.context_id);
      if (!context || context.workspace_id !== command.workspace_id) {
        throw new Error(`Context not found for pulse subscriber: ${command.context_id}`);
      }

      return this.insertEvent(
        {
          type: command.type,
          workspace_id: command.workspace_id,
          source_endpoint_id: null,
          destination: { kind: "context", context_id: command.context_id },
          thread_id: undefined,
          correlation_id: command.correlation_id ?? null,
          content: command.content,
          metadata: command.metadata,
          idempotency_key: command.idempotency_key ?? null
        },
        this.normalizeResponse({ expected: false }),
        command.context_id
      );
    });

    return this.broadcastEventSubmission(event, broadcast).event;
  }

  /** Resolve one existing runtime reservation without exposing private inputs. */
  getRuntimeDelivery(deliveryId: string): RuntimeDeliveryState | null {
    return this.db.prepare(`
      SELECT d.delivery_id, d.workspace_id, d.endpoint_id, d.state,
        e.context_id, (SELECT q.scope_execution_id FROM event_queue q
          WHERE q.delivery_id = d.delivery_id AND q.scope_execution_id IS NOT NULL LIMIT 1) AS scope_execution_id
      FROM delivery_bundles d JOIN events e ON e.event_id = d.trigger_event_id
      WHERE d.delivery_id = ?
    `).get(deliveryId) as unknown as RuntimeDeliveryState ?? null;
  }

  cancelRuntimeDelivery(input: {
    workspace_id: string; delivery_id: string; principal_id: string; invocation_id: string;
  }, broadcast: Broadcast): RuntimeDeliveryCancellation {
    let notice: EventEnvelope | null = null;
    const result = this.transaction(() => {
      const delivery = this.getRuntimeDelivery(input.delivery_id);
      if (!delivery || delivery.workspace_id !== input.workspace_id) throw new Error("Runtime response is unavailable in this Workspace.");
      if (delivery.scope_execution_id) throw new Error("Use scope.execution.stop for this runtime response.");
      const outcomeUnknown = ["delivered_to_bridge", "injected_to_runtime"].includes(delivery.state);
      if (!ACTIVE_RUNTIME_DELIVERY_STATES.has(delivery.state)) {
        return { delivery_id: delivery.delivery_id, state: delivery.state, cancelled: false, outcome_unknown: delivery.state === "cancelled" };
      }
      const completed = this.db.prepare(`SELECT e.event_id FROM events e JOIN delivery_bundles d
        ON e.idempotency_key = 'runtime-turn-result:' || d.endpoint_id || ':' || d.trigger_event_id
        WHERE d.delivery_id = ?`).get(delivery.delivery_id);
      if (completed) return { delivery_id: delivery.delivery_id, state: "completed", cancelled: false, outcome_unknown: false };
      const reason = "Response stopped";
      this.db.prepare(`UPDATE event_queue SET state = 'cancelled', lease_expires_at = NULL, last_error = ?
        WHERE delivery_id = ? AND state IN ('reserved', 'delivered_to_bridge', 'injected_to_runtime')`).run(reason, delivery.delivery_id);
      // Terminal state also revokes the runtime's operation authority through
      // the existing delivery-authority trigger, before cancellation is pushed.
      this.db.prepare(`UPDATE delivery_bundles SET state = 'cancelled', lease_expires_at = NULL, last_error = ?
        WHERE delivery_id = ?`).run(reason, delivery.delivery_id);
      // A returned dependency resumes the original requested work. Stopping
      // that continuation must close its exact inbound wait as well.
      this.db.prepare(`UPDATE pending_responses SET status = 'cancelled', resolved_at = ?
        WHERE workspace_id = ? AND status = 'pending' AND source_event_id IN (
          SELECT event_id FROM event_queue WHERE delivery_id = ?
          UNION
          SELECT request.event_id FROM event_queue queued
          JOIN events trigger ON trigger.event_id = queued.event_id
          JOIN events request ON request.event_id = json_extract(trigger.metadata_json, '$.request_continuation_event_id')
          WHERE queued.delivery_id = ? AND trigger.type = 'request.result'
            AND json_extract(trigger.metadata_json, '$.origin') = 'runtime_request_return'
            AND request.type = 'request' AND request.workspace_id = ?
            AND json_extract(request.destination_json, '$.kind') = 'endpoint'
            AND json_extract(request.destination_json, '$.endpoint_id') = ?
        )`).run(now(), delivery.workspace_id, delivery.delivery_id, delivery.delivery_id,
          delivery.workspace_id, delivery.endpoint_id);
      notice = this.insertEvent({
        type: "message", workspace_id: delivery.workspace_id, source_endpoint_id: null, correlation_id: null,
        destination: { kind: "context", context_id: delivery.context_id },
        content: { text: outcomeUnknown
          ? "This response was stopped. Changes already made remain. Review them before asking Floe to continue."
          : "This response was stopped before it reached the runtime." },
        metadata: { origin: "runtime_delivery_cancellation", delivery_id: delivery.delivery_id,
          source_principal_id: input.principal_id, operation_invocation_id: input.invocation_id,
          outcome_unknown: outcomeUnknown, terminal: true },
        idempotency_key: `runtime-delivery-cancelled:${delivery.delivery_id}`,
      }, this.normalizeResponse({ expected: false }), delivery.context_id);
      return { delivery_id: delivery.delivery_id, state: "cancelled", cancelled: true, outcome_unknown: outcomeUnknown };
    });
    if (result.cancelled) {
      const delivery = this.getRuntimeDelivery(input.delivery_id)!;
      const payload = { workspace_id: delivery.workspace_id, context_id: delivery.context_id,
        delivery_id: delivery.delivery_id, endpoint_id: delivery.endpoint_id, outcome_unknown: result.outcome_unknown };
      broadcast("delivery_cancel_requested", payload);
      broadcast("delivery_cancelled", payload);
      if (notice) this.broadcastEventSubmission(notice, broadcast);
      this.reportTurnEnd(delivery.endpoint_id, broadcast);
      this.scheduleNextLeaseExpiryCheck();
    }
    return result;
  }

  /**
   * Record one runtime delivery's public conclusion without routing it. When
   * the delivery was caused by an exact correlated request to this endpoint,
   * also enqueue a compact return event in the requester's original Context.
   */
  recordRuntimeTurnResult(input: {
    delivery_id: string;
    outcome: "completed" | "failed";
    text: string;
    metadata?: Record<string, unknown>;
  }, broadcast: Broadcast): RuntimeTurnResult {
    const recorded = this.transaction(() => {
      const delivery = this.db.prepare("SELECT * FROM delivery_bundles WHERE delivery_id = ?")
        .get(input.delivery_id) as any;
      if (!delivery) throw new Error(`Unknown delivery_id: ${input.delivery_id}`);
      const canonicalAttempt = delivery.execution_attempt_id
        ? this.scopeExecutionStore.getAttempt(String(delivery.execution_attempt_id))
        : this.scopeExecutionStore.getAttemptForBundle(String(delivery.delivery_id));
      const canonicalNode = canonicalAttempt
        ? this.scopeExecutionStore.getNodeExecution(canonicalAttempt.node_execution_id)
        : null;
      // Direct deliveries retain their historical endpoint + trigger key so a
      // pre-injection transport retry cannot duplicate the public conclusion.
      // Canonical graph work is keyed by its exact ExecutionAttempt. Two
      // placements may legitimately bind the same Actor and receive the same
      // source Event; endpoint + trigger would collapse those distinct results.
      const invocationKey = canonicalAttempt
        ? `attempt:${canonicalAttempt.attempt_id}`
        : canonicalNode
          ? `node:${canonicalNode.node_execution_id}:delivery:${delivery.delivery_id}`
          : `${delivery.endpoint_id}:${delivery.trigger_event_id}`;
      const resultIdempotencyKey = `runtime-turn-result:${invocationKey}`;
      const returnIdempotencyKey = `runtime-request-return:${invocationKey}`;
      const existing = this.db.prepare("SELECT * FROM events WHERE idempotency_key = ?")
        .get(resultIdempotencyKey) as any;
      if (existing) {
        const returnExisting = this.db.prepare("SELECT * FROM events WHERE idempotency_key = ?")
          .get(returnIdempotencyKey) as any;
        return {
          result_event: this.rowToEvent(existing),
          return_event: returnExisting ? this.rowToEvent(returnExisting) : null,
          request_resolved: !!returnExisting,
          created: false
        };
      }

      // A cancelled turn may still unwind after its last tool call or stream
      // event. It cannot create a new public completion or correlated return.
      if (delivery.state === "cancelled") throw new Error("Runtime response was cancelled; a late result cannot complete it.");

      const triggerRow = this.db.prepare("SELECT * FROM events WHERE event_id = ?")
        .get(delivery.trigger_event_id) as any;
      if (!triggerRow) throw new Error(`Unknown trigger_event_id: ${delivery.trigger_event_id}`);
      const trigger = this.rowToEvent(triggerRow);
      if (trigger.workspace_id !== delivery.workspace_id) {
        throw new Error(`Delivery workspace does not match trigger workspace: ${input.delivery_id}`);
      }
      const resultContextId = canonicalNode?.context_id ?? trigger.context_id;
      const context = this.contextStore.getContext(resultContextId);
      if (!context || context.workspace_id !== trigger.workspace_id) {
        throw new Error(`Context not found for runtime result: ${resultContextId}`);
      }

      const resultEvent = this.insertEvent(
        {
          type: "message",
          workspace_id: trigger.workspace_id,
          source_endpoint_id: delivery.endpoint_id,
          destination: { kind: "context", context_id: resultContextId },
          thread_id: resultContextId,
          correlation_id: trigger.correlation_id,
          content: {
            text: input.text,
            data: {
              origin: "runtime_turn_result",
              outcome: input.outcome,
              delivery_id: input.delivery_id,
              cause_event_id: trigger.event_id,
              scope_execution_id: canonicalNode?.execution_id ?? null,
              composition_revision_id: canonicalNode?.revision_id ?? null,
              node_execution_id: canonicalNode?.node_execution_id ?? null,
              execution_attempt_id: canonicalAttempt?.attempt_id ?? null
            }
          },
          metadata: {
            ...(input.metadata ?? {}),
            origin: "runtime_turn_result",
            outcome: input.outcome,
            delivery_id: input.delivery_id,
            cause_event_id: trigger.event_id,
            scope_execution_id: canonicalNode?.execution_id ?? null,
            composition_revision_id: canonicalNode?.revision_id ?? null,
            node_execution_id: canonicalNode?.node_execution_id ?? null,
            execution_attempt_id: canonicalAttempt?.attempt_id ?? null
          },
          idempotency_key: resultIdempotencyKey
        },
        this.normalizeResponse({ expected: false }),
        resultContextId
      );

      const continuationRequestEventId =
        trigger.type === "request"
          ? trigger.event_id
          : trigger.type === "request.result" && typeof trigger.metadata?.request_continuation_event_id === "string"
            ? trigger.metadata.request_continuation_event_id
            : null;
      const pending = continuationRequestEventId ? this.db.prepare(`
        SELECT * FROM pending_responses
        WHERE source_event_id = ? AND status = 'pending'
        LIMIT 1
      `).get(continuationRequestEventId) as any : null;
      const requestRow = continuationRequestEventId
        ? this.db.prepare("SELECT * FROM events WHERE event_id = ?").get(continuationRequestEventId) as any
        : null;
      const requestEvent = requestRow ? this.rowToEvent(requestRow) : null;
      const requestedDestination = requestEvent?.destination_json.kind === "endpoint"
        ? requestEvent.destination_json.endpoint_id
        : null;

      // If this exact processing cycle established a child request, its public
      // completion is interim. Keep any inbound request suspended until the child
      // result resumes this actor and it completes again.
      const childRequestRows = this.db.prepare(`
        SELECT pr.*, e.metadata_json
        FROM pending_responses pr
        JOIN events e ON e.event_id = pr.source_event_id
        WHERE pr.waiting_endpoint_id = ?
      `).all(delivery.endpoint_id) as any[];
      const madeChildRequest = childRequestRows.some((row) => {
        const metadata = parseJson<Record<string, unknown>>(row.metadata_json);
        return metadata.request_parent_delivery_id === input.delivery_id;
      });
      if (
        madeChildRequest
        && canonicalNode
        && !["completed", "failed", "cancelled"].includes(canonicalNode.status)
      ) {
        this.scopeExecutionStore.setNodeExecutionStatus(canonicalNode.node_execution_id, "waiting_external", {
          code: "actor_request_pending",
          delivery_id: input.delivery_id,
        });
      }
      const isExactRequest =
        !!pending &&
        !!requestEvent &&
        !madeChildRequest &&
        requestEvent.type === "request" &&
        requestEvent.response.expected === true &&
        requestEvent.response.mode === "correlated" &&
        !!pending.correlation_id &&
        pending.correlation_id === requestEvent.correlation_id &&
        requestedDestination === delivery.endpoint_id;

      let returnEvent: EventEnvelope | null = null;
      if (isExactRequest) {
        const configuredReturnContext = typeof requestEvent!.metadata?.request_return_context_id === "string"
          ? requestEvent!.metadata.request_return_context_id
          : null;
        const returnContextId = configuredReturnContext &&
          this.contextStore.getContext(configuredReturnContext)?.workspace_id === trigger.workspace_id &&
          this.contextStore.isParticipant(configuredReturnContext, pending.waiting_endpoint_id)
          ? configuredReturnContext
          : trigger.context_id;
        const requestMetadata = requestEvent!.metadata ?? {};
        const parentNodeExecutionId = typeof requestMetadata.request_parent_node_execution_id === "string"
          ? requestMetadata.request_parent_node_execution_id
          : null;
        const parentNodeExecution = parentNodeExecutionId
          ? this.scopeExecutionStore.getNodeExecution(parentNodeExecutionId)
          : null;
        const parentExecution = parentNodeExecution
          ? this.scopeExecutionStore.getExecution(parentNodeExecution.execution_id)
          : null;
        const requestedScopeExecutionId = typeof requestMetadata.request_parent_scope_execution_id === "string"
          ? requestMetadata.request_parent_scope_execution_id
          : null;
        const requestedRevisionId = typeof requestMetadata.request_parent_composition_revision_id === "string"
          ? requestMetadata.request_parent_composition_revision_id
          : null;
        const requestedTargetNodeId = typeof requestMetadata.request_parent_target_node_id === "string"
          ? requestMetadata.request_parent_target_node_id
          : null;
        const hasCanonicalContinuation = parentNodeExecutionId !== null;
        const canonicalContinuationValid = Boolean(
          parentNodeExecution
          && parentExecution
          && requestedScopeExecutionId === parentNodeExecution.execution_id
          && requestedRevisionId === parentNodeExecution.revision_id
          && requestedTargetNodeId === parentNodeExecution.node_id
          && parentExecution.workspace_id === trigger.workspace_id
          && parentNodeExecution.context_id === returnContextId
          && parentNodeExecution.assigned_actor_ids.includes(pending.waiting_endpoint_id)
          && !["completed", "failed", "cancelled"].includes(parentNodeExecution.status),
        );
        const continuationSuppressedReason = hasCanonicalContinuation && !canonicalContinuationValid
          ? "canonical_parent_unavailable_or_terminal"
          : null;

        returnEvent = this.insertEvent(
          {
            type: "request.result",
            workspace_id: trigger.workspace_id,
            source_endpoint_id: null,
            destination: { kind: "endpoint", endpoint_id: pending.waiting_endpoint_id },
            thread_id: returnContextId,
            correlation_id: pending.correlation_id,
            content: {
              text: input.text,
              data: {
                outcome: input.outcome,
                request_event_id: requestEvent!.event_id,
                result_event_id: resultEvent.event_id,
                responding_endpoint_id: delivery.endpoint_id,
                result_context_id: resultContextId
              }
            },
            metadata: {
              origin: "runtime_request_return",
              outcome: input.outcome,
              request_event_id: requestEvent!.event_id,
              result_event_id: resultEvent.event_id,
              responding_endpoint_id: delivery.endpoint_id,
              result_context_id: resultContextId,
              scope_execution_id: canonicalContinuationValid ? parentNodeExecution!.execution_id : null,
              composition_revision_id: canonicalContinuationValid ? parentNodeExecution!.revision_id : null,
              node_execution_id: canonicalContinuationValid ? parentNodeExecution!.node_execution_id : null,
              continuation_suppressed_reason: continuationSuppressedReason,
              request_continuation_event_id:
                typeof requestEvent!.metadata?.request_continuation_event_id === "string"
                  ? requestEvent!.metadata.request_continuation_event_id
                  : null
            },
            idempotency_key: returnIdempotencyKey
          },
          this.normalizeResponse({ expected: false }),
          returnContextId
        );
        if (!hasCanonicalContinuation || canonicalContinuationValid) {
          this.queueEvent(
            returnEvent.event_id,
            returnEvent.workspace_id,
            pending.waiting_endpoint_id,
            canonicalContinuationValid
              ? {
                  scope_execution_id: parentNodeExecution!.execution_id,
                  composition_revision_id: parentNodeExecution!.revision_id,
                  source_node_id: null,
                  source_port_id: null,
                  target_node_id: parentNodeExecution!.node_id,
                  target_port_id: null,
                  edge_id: null,
                  node_execution_id: parentNodeExecution!.node_execution_id,
                  output_publication_id: null,
                }
              : undefined,
          );
        }
        this.db.prepare("UPDATE pending_responses SET status = 'resolved', resolved_at = ? WHERE pending_id = ?")
          .run(now(), pending.pending_id);
      } else {
        const directPending = this.db.prepare(`
          SELECT * FROM pending_responses
          WHERE source_event_id = ? AND status = 'pending'
          LIMIT 1
        `).get(trigger.event_id) as any;
        if (directPending && trigger.type !== "request") {
          // Human/client sends may ask for a response. A local result satisfies
          // that wait without routing a reply or waking another actor.
          this.db.prepare("UPDATE pending_responses SET status = 'resolved', resolved_at = ? WHERE pending_id = ?")
            .run(now(), directPending.pending_id);
        }
      }

      return {
        result_event: resultEvent,
        return_event: returnEvent,
        request_resolved: isExactRequest,
        created: true
      };
    });

    if (recorded.created) {
      this.broadcastEventSubmission(recorded.result_event, broadcast);
      if (recorded.return_event) this.broadcastEventSubmission(recorded.return_event, broadcast);
    }
    return {
      result_event: recorded.result_event,
      return_event: recorded.return_event,
      request_resolved: recorded.request_resolved
    };
  }

  private broadcastEventSubmission(event: EventEnvelope, broadcast: Broadcast): { event: EventEnvelope; deliveries_created: number } {
    const resolved = this.db.prepare(`
      SELECT destination_endpoint_id
      FROM event_queue
      WHERE event_id = ?
    `).all(event.event_id) as Array<{ destination_endpoint_id: string }>;
    broadcast("event_submitted", { event });
    broadcast("destination_selector_resolved", {
      event_id: event.event_id,
      destinations: resolved.map((row) => row.destination_endpoint_id)
    });
    for (const row of resolved) {
      broadcast("delivery_created", { event_id: event.event_id, destination_endpoint_id: row.destination_endpoint_id });
      const delivery = this.tryCreateDeliveryForEndpoint(row.destination_endpoint_id, broadcast);
      if (!delivery) this.signalIfRuntimeUnconfigured(event, row.destination_endpoint_id, broadcast);
    }
    return { event, deliveries_created: resolved.length };
  }

  /**
   * A message routed to an endpoint with no bound auth profile produces no delivery
   * (see tryCreateDeliveryForEndpoint). Without a signal the message vanishes silently.
   * Emit visible runtime telemetry so the operator sees that a profile must be selected.
   */
  private signalIfRuntimeUnconfigured(event: EventEnvelope, endpointId: string, broadcast: Broadcast): void {
    const endpoint = this.getEndpoint(endpointId);
    if (!endpoint || String(endpoint.status) !== "runtime_unconfigured") return;
    this.appendRuntimeTelemetry({
      workspace_id: endpoint.workspace_id,
      endpoint_id: endpointId,
      kind: "runtime_unconfigured",
      payload: {
        code: "runtime_unconfigured",
        trigger_event_id: event.event_id,
        message:
          "No auth profile is bound to this agent/workspace, so the message was accepted but not delivered. " +
          "Connect a model provider in Floe Settings and select it for this workspace to enable replies."
      }
    }, broadcast);
  }

  reportTurnEnd(endpointId: string, broadcast: Broadcast): unknown {
    const current = this.getEndpoint(endpointId);
    if (current?.status === "runtime_unconfigured") {
      broadcast("turn_end_observed", { endpoint_id: endpointId, status: "runtime_unconfigured" });
      return current;
    }
    const openPending = this.db.prepare(`
      SELECT count(*) AS c
      FROM pending_responses
      WHERE waiting_endpoint_id = ? AND status = 'pending'
    `).get(endpointId) as { c: number };
    const queued = this.db.prepare(`
      SELECT count(*) AS c
      FROM event_queue
      WHERE destination_endpoint_id = ? AND state IN ('queued', 'reserved', 'delivered_to_bridge', 'injected_to_runtime')
    `).get(endpointId) as { c: number };
    const status = openPending.c > 0 ? "waiting" : queued.c > 0 ? "queued" : "idle";
    const endpoint = this.updateEndpointStatus(endpointId, status, broadcast);
    if (status === "queued") this.tryCreateDeliveryForEndpoint(endpointId, broadcast);
    broadcast("turn_end_observed", { endpoint_id: endpointId, status });
    return this.getEndpoint(endpointId) ?? endpoint;
  }

  claimDeliveries(bridgeId: string, limit: number, broadcast: Broadcast): DeliveryBundle[] {
    const rows = this.db.prepare(`
      SELECT db.*
      FROM delivery_bundles db
      JOIN endpoints e ON e.endpoint_id = db.endpoint_id
      WHERE db.state = 'reserved' AND e.bridge_id = ?
        AND NOT EXISTS (
          SELECT 1
          FROM workspace_restore_holds hold
          WHERE hold.workspace_id = db.workspace_id AND hold.state = 'held'
        )
      ORDER BY db.created_at ASC
      LIMIT ?
    `).all(bridgeId, limit) as any[];
    const claimedAt = now();
    for (const row of rows) {
      this.db.prepare("UPDATE delivery_bundles SET state = 'delivered_to_bridge', claimed_at = ? WHERE delivery_id = ?")
        .run(claimedAt, row.delivery_id);
      this.db.prepare("UPDATE event_queue SET state = 'delivered_to_bridge' WHERE delivery_id = ? AND state = 'reserved'")
        .run(row.delivery_id);
      broadcast("delivery_reserved", { delivery_id: row.delivery_id, endpoint_id: row.endpoint_id });
      broadcast("delivery_delivered_to_bridge", { delivery_id: row.delivery_id, bridge_id: bridgeId });
    }
    return rows.map((row) => this.rowToDelivery(row));
  }

  prepareRuntimeDelivery(input: {
    bridge_id: string;
    delivery_id: string;
  }, broadcast: Broadcast): {
    delivery: DeliveryBundle;
    processing_contract: RuntimeDispatchContract;
    operation_authority_session: Readonly<{
      authority_session_id: string;
      bearer_token: string;
      expires_at: string;
    }>;
  } {
    let prepared!: {
      delivery: DeliveryBundle;
      processing_contract: RuntimeDispatchContract;
      operation_authority_session: Readonly<{
        authority_session_id: string;
        bearer_token: string;
        expires_at: string;
      }>;
    };
    let claimedFromPush = false;
    this.transaction(() => {
      const delivery = this.db.prepare("SELECT * FROM delivery_bundles WHERE delivery_id = ?")
        .get(input.delivery_id) as any;
      if (!delivery) throw new Error(`Unknown delivery_id: ${input.delivery_id}`);
      const isPushedReservation = delivery.state === "reserved";
      const isInitialPreparation = isPushedReservation || delivery.state === "delivered_to_bridge";
      const isAuthorityRenewal = delivery.state === "injected_to_runtime";
      if (!isInitialPreparation && !isAuthorityRenewal) {
        throw new Error(`Delivery '${input.delivery_id}' is '${delivery.state}' and cannot be prepared for runtime processing.`);
      }
      const endpoint = this.getEndpoint(String(delivery.endpoint_id)) as { bridge_id?: string | null } | null;
      if (endpoint?.bridge_id !== input.bridge_id) {
        throw new Error(`Bridge '${input.bridge_id}' does not own Delivery '${input.delivery_id}'.`);
      }

      // A pushed bundle has not taken the HTTP claim path. Claim it in the same
      // transaction as preparation so a refused contract cannot strand the work.
      if (isPushedReservation) {
        const claimedAt = now();
        const claimed = this.db.prepare(`
          UPDATE delivery_bundles SET state = 'delivered_to_bridge', claimed_at = ?
          WHERE delivery_id = ? AND state = 'reserved' AND lease_expires_at > ?
            AND NOT EXISTS (
              SELECT 1 FROM workspace_restore_holds hold
              WHERE hold.workspace_id = delivery_bundles.workspace_id AND hold.state = 'held'
            )
        `).run(claimedAt, input.delivery_id, claimedAt);
        if (Number(claimed.changes) !== 1) {
          throw new Error(`Delivery '${input.delivery_id}' reservation expired or its Workspace is held for restoration.`);
        }
        this.db.prepare(`
          UPDATE event_queue SET state = 'delivered_to_bridge'
          WHERE delivery_id = ? AND state = 'reserved'
        `).run(input.delivery_id);
        claimedFromPush = true;
      }

      const canonical = this.rowToDelivery(delivery);
      if (isAuthorityRenewal && !canonical.operation_authority_session_id) {
        throw new Error(
          `Injected Delivery '${input.delivery_id}' has no prepared runtime authority to renew.`,
        );
      }
      let processingContract: RuntimeDispatchContract;
      let executionAttemptId: string | null = canonical.execution_attempt_id;
      if (canonical.node_execution_id) {
        if (isAuthorityRenewal) {
          if (!executionAttemptId) {
            throw new Error(
              `Injected scoped Delivery '${input.delivery_id}' has no ExecutionAttempt to renew.`,
            );
          }
          processingContract = this.getRuntimeProcessingContract(executionAttemptId);
        } else {
          const attempt = this.scopeExecutionStore.startAttempt({
            node_execution_id: canonical.node_execution_id,
            delivery_ids: canonical.stable_delivery_ids,
            delivery_bundle_id: canonical.delivery_id,
            runtime: {
              bridge_id: input.bridge_id,
              endpoint_id: canonical.endpoint_id,
              composition_revision_id: canonical.composition_revision_id,
              target_node_id: canonical.target_node_id,
            },
            status: "pending",
          });
          executionAttemptId = attempt.attempt_id;
          processingContract = this.getRuntimeProcessingContract(attempt.attempt_id);
        }
      } else {
        processingContract = this.resolveDirectRuntimeProcessingContract(canonical);
      }

      this.actorRoleAuthorityStore.ensureTrustedRuntimeSelfBinding({
        workspace_id: processingContract.workspace_id,
        actor_runtime_binding_id: processingContract.runtime.binding.actor_runtime_binding_id,
        actor_definition_revision_id:
          processingContract.actor.definition.actor_definition_revision_id,
      });

      if (canonical.operation_authority_session_id) {
        this.operationAuthoritySessions.revokeSession(canonical.operation_authority_session_id);
      }
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      const issued = this.operationAuthoritySessions.issueSession({
        principal_id: processingContract.operation_authority.principal_id,
        workspace_id: processingContract.workspace_id,
        grant_ids: processingContract.operation_authority.capability_grant_ids,
        interaction: {
          mode: "unattended",
          session_id: `runtime:${canonical.delivery_id}`,
        },
        provenance: {
          cause_event_id: canonical.trigger_event_id,
          delivery_ids: canonical.stable_delivery_ids,
          execution_attempt_id: executionAttemptId,
          node_execution_id: canonical.node_execution_id,
          scope_execution_id: canonical.scope_execution_id,
        },
        expires_at: expiresAt,
      });
      const updated = isInitialPreparation
        ? this.db.prepare(`
            UPDATE delivery_bundles
            SET execution_attempt_id = ?, operation_authority_session_id = ?
            WHERE delivery_id = ?
              AND state = 'delivered_to_bridge'
              AND operation_authority_session_id IS ?
          `).run(
            executionAttemptId,
            issued.session.authority_session_id,
            input.delivery_id,
            canonical.operation_authority_session_id,
          )
        : this.db.prepare(`
            UPDATE delivery_bundles
            SET operation_authority_session_id = ?
            WHERE delivery_id = ?
              AND state = 'injected_to_runtime'
              AND execution_attempt_id IS ?
              AND operation_authority_session_id IS ?
          `).run(
            issued.session.authority_session_id,
            input.delivery_id,
            executionAttemptId,
            canonical.operation_authority_session_id,
          );
      if (Number(updated.changes) !== 1) {
        throw new Error(`Delivery '${input.delivery_id}' changed while runtime authority was being issued.`);
      }
      const updatedDelivery = this.db.prepare("SELECT * FROM delivery_bundles WHERE delivery_id = ?")
        .get(input.delivery_id) as any;
      prepared = {
        delivery: this.rowToDelivery(updatedDelivery),
        processing_contract: processingContract,
        operation_authority_session: {
          authority_session_id: issued.session.authority_session_id,
          bearer_token: issued.bearer_token,
          expires_at: issued.session.expires_at,
        },
      };
    });
    if (claimedFromPush) {
      broadcast("delivery_reserved", { delivery_id: input.delivery_id, endpoint_id: prepared.delivery.endpoint_id });
      broadcast("delivery_delivered_to_bridge", { delivery_id: input.delivery_id, bridge_id: input.bridge_id });
    }
    broadcast("delivery_runtime_prepared", {
      bridge_id: input.bridge_id,
      delivery_id: input.delivery_id,
      execution_attempt_id: prepared.processing_contract.contract_kind === "scope_node"
        ? prepared.processing_contract.execution_attempt.attempt_id
        : null,
      node_execution_id: prepared.processing_contract.contract_kind === "scope_node"
        ? prepared.processing_contract.node_execution.node_execution_id
        : null,
    });
    return prepared;
  }

  reportDeliveryStatus(input: {
    bridge_id: string;
    delivery_id: string;
    state: "injected_to_runtime" | "acknowledged" | "failed" | "dead_lettered" | "deferred";
    error?: string | null;
  }, broadcast: Broadcast): unknown {
    const delivery = this.db.prepare("SELECT * FROM delivery_bundles WHERE delivery_id = ?").get(input.delivery_id) as any;
    if (!delivery) throw new Error(`Unknown delivery_id: ${input.delivery_id}`);
    // Ignore late callbacks after another owner has settled this delivery.
    if (["acknowledged", "dead_lettered", "failed", "deferred", "cancelled"].includes(String(delivery.state))) {
      return delivery;
    }

    if (input.state === "deferred") {
      const preparedAttempt = delivery.execution_attempt_id
        ? this.scopeExecutionStore.getAttempt(String(delivery.execution_attempt_id))
        : null;
      this.transaction(() => {
        // The Bridge can discover a setup failure after injection, when the
        // credential broker first becomes available. It reports deferred only
        // before the model turn starts; failures during work remain terminal.
        if (preparedAttempt && ["pending", "running"].includes(preparedAttempt.status)) {
          const failure = {
            code: "runtime_preparation_deferred",
            message: input.error ?? "runtime preparation was deferred",
            safe_to_retry: true,
          };
          this.scopeExecutionStore.finishAttempt({
            attempt_id: preparedAttempt.attempt_id,
            status: "failed",
            error: failure,
          });
          const node = this.scopeExecutionStore.setNodeExecutionStatus(
            preparedAttempt.node_execution_id,
            "blocked",
            failure,
          );
          this.reconcileScopeExecutionStatus(node.execution_id);
        }
        this.db.prepare("UPDATE delivery_bundles SET state = 'deferred', lease_expires_at = NULL, last_error = ? WHERE delivery_id = ?")
          .run(input.error ?? null, input.delivery_id);
        this.db.prepare(`
          UPDATE event_queue
          SET state = ?,
              delivery_id = NULL,
              lease_expires_at = NULL,
              last_error = ?
          WHERE delivery_id = ?
        `).run(preparedAttempt ? "held" : "queued", input.error ?? null, input.delivery_id);
        this.db.prepare(`
          UPDATE endpoints
          SET status = CASE WHEN bridge_id IS NOT NULL THEN 'runtime_unconfigured' ELSE status END,
              updated_at = ?
          WHERE endpoint_id = ?
        `).run(now(), delivery.endpoint_id);
      });
      const endpoint = this.getEndpoint(delivery.endpoint_id);
      broadcast("delivery_deferred", {
        bridge_id: input.bridge_id,
        delivery_id: input.delivery_id,
        error: input.error ?? null
      });
      broadcast("status_changed", { endpoint });
      this.scheduleNextLeaseExpiryCheck();
      return this.db.prepare("SELECT * FROM delivery_bundles WHERE delivery_id = ?").get(input.delivery_id);
    }

    if (input.state === "failed") {
      if (delivery.state === "injected_to_runtime") {
        return this.failInjectedRuntimeDelivery(
          delivery,
          input.error ?? "runtime reported a terminal failure after work began",
          broadcast,
        );
      }
      const attempts = Number(delivery.attempt_count ?? 1);
      const queueState = attempts >= 3 ? "dead_lettered" : "queued";
      const bundleState = attempts >= 3 ? "dead_lettered" : "failed";
      this.db.prepare("UPDATE delivery_bundles SET state = ?, lease_expires_at = NULL, last_error = ? WHERE delivery_id = ?")
        .run(bundleState, input.error ?? null, input.delivery_id);
      this.db.prepare(`
        UPDATE event_queue
        SET state = ?, delivery_id = CASE WHEN ? = 'queued' THEN NULL ELSE delivery_id END,
            lease_expires_at = NULL, last_error = ?
        WHERE delivery_id = ?
      `).run(queueState, queueState, input.error ?? null, input.delivery_id);
      broadcast(bundleState === "dead_lettered" ? "delivery_dead_lettered" : "delivery_failed", {
        bridge_id: input.bridge_id,
        delivery_id: input.delivery_id,
        error: input.error ?? null
      });
      this.scheduleNextLeaseExpiryCheck();
      return this.db.prepare("SELECT * FROM delivery_bundles WHERE delivery_id = ?").get(input.delivery_id);
    }

    if (input.state === "dead_lettered") {
      this.db.prepare("UPDATE delivery_bundles SET state = 'dead_lettered', lease_expires_at = NULL, last_error = ? WHERE delivery_id = ?")
        .run(input.error ?? null, input.delivery_id);
      this.db.prepare(`
        UPDATE event_queue
        SET state = 'dead_lettered', lease_expires_at = NULL, last_error = ?
        WHERE delivery_id = ?
      `).run(input.error ?? null, input.delivery_id);
      this.finishCanonicalAttempt(delivery, "failed", input.error ?? "delivery was dead-lettered");
      broadcast("delivery_dead_lettered", {
        bridge_id: input.bridge_id,
        delivery_id: input.delivery_id,
        error: input.error ?? null
      });
      this.scheduleNextLeaseExpiryCheck();
      return this.db.prepare("SELECT * FROM delivery_bundles WHERE delivery_id = ?").get(input.delivery_id);
    }

    const leaseExpiresAt = input.state === "injected_to_runtime" ? this.runtimeTurnLeaseExpiresAt() : null;
    this.transaction(() => {
      if (input.state === "injected_to_runtime") {
        const canonical = this.rowToDelivery(delivery);
        if (canonical.node_execution_id) {
          const attempt = this.scopeExecutionStore.startAttempt({
            node_execution_id: canonical.node_execution_id,
            delivery_ids: canonical.stable_delivery_ids,
            delivery_bundle_id: canonical.delivery_id,
            runtime: {
              bridge_id: input.bridge_id,
              endpoint_id: canonical.endpoint_id,
              composition_revision_id: canonical.composition_revision_id,
              target_node_id: canonical.target_node_id,
            },
          });
          const runningAttempt = this.scopeExecutionStore.beginAttempt({
            attempt_id: attempt.attempt_id,
          });
          this.db.prepare(`
            UPDATE delivery_bundles SET execution_attempt_id = ? WHERE delivery_id = ?
          `).run(runningAttempt.attempt_id, input.delivery_id);
        }
      }
      this.db.prepare("UPDATE delivery_bundles SET state = ?, lease_expires_at = ?, last_error = NULL WHERE delivery_id = ?")
        .run(input.state, leaseExpiresAt, input.delivery_id);
      this.db.prepare("UPDATE event_queue SET state = ?, lease_expires_at = ?, last_error = NULL WHERE delivery_id = ?")
        .run(input.state, leaseExpiresAt, input.delivery_id);
      if (input.state === "acknowledged") {
        this.db.prepare("UPDATE event_queue SET delivered_at = ? WHERE delivery_id = ?").run(now(), input.delivery_id);
        this.finishCanonicalAttempt(delivery, "completed", null);
      }
    });
    broadcast(`delivery_${input.state}`, {
      bridge_id: input.bridge_id,
      delivery_id: input.delivery_id
    });
    this.scheduleNextLeaseExpiryCheck();
    return this.db.prepare("SELECT * FROM delivery_bundles WHERE delivery_id = ?")
      .get(input.delivery_id) as any;
  }

  appendRuntimeTelemetry(input: {
    workspace_id: string;
    endpoint_id: string;
    delivery_id?: string | null;
    kind: string;
    payload: Record<string, unknown>;
  }, broadcast: Broadcast): unknown {
    const telemetry = {
      telemetry_id: `tel_${randomUUID()}`,
      workspace_id: input.workspace_id,
      endpoint_id: input.endpoint_id,
      delivery_id: input.delivery_id ?? null,
      kind: input.kind,
      payload_json: json(input.payload),
      created_at: now()
    };
    this.db.prepare(`
      INSERT INTO runtime_telemetry (
        telemetry_id, workspace_id, endpoint_id, delivery_id, kind, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      telemetry.telemetry_id,
      telemetry.workspace_id,
      telemetry.endpoint_id,
      telemetry.delivery_id,
      telemetry.kind,
      telemetry.payload_json,
      telemetry.created_at
    );
    if (telemetry.delivery_id) {
      this.renewRuntimeDeliveryLease(telemetry.delivery_id, broadcast);
    }
    broadcast("runtime_telemetry", { telemetry: { ...telemetry, payload: input.payload } });
    return telemetry;
  }

  listRuntimeTelemetry(filters: { workspace_id?: string; delivery_id?: string; limit?: number }): unknown[] {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const conditions: string[] = [];
    const params: any[] = [];
    if (filters.workspace_id) {
      conditions.push("workspace_id = ?");
      params.push(filters.workspace_id);
    }
    if (filters.delivery_id) {
      conditions.push("delivery_id = ?");
      params.push(filters.delivery_id);
    }
    let sql = "SELECT * FROM runtime_telemetry";
    if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ");
    // Newest first for the LIMIT, then reverse so the caller gets chronological order.
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    return (this.db.prepare(sql).all(...params)).reverse();
  }

  /**
   * Read-only diagnostic projection for the runtime work caused by Events in
   * one Context. Keeping this join in the Bus avoids making clients reverse
   * engineer delivery ownership from raw JSON bundles.
   */
  listContextDeliveries(filters: {
    workspace_id: string;
    context_id: string;
    limit?: number;
  }): unknown[] {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    return (this.db.prepare(`
      SELECT db.*
      FROM delivery_bundles db
      JOIN events trigger_event ON trigger_event.event_id = db.trigger_event_id
      WHERE db.workspace_id = ? AND trigger_event.context_id = ?
      ORDER BY db.created_at DESC, db.delivery_id DESC
      LIMIT ?
    `).all(filters.workspace_id, filters.context_id, limit) as unknown[]).reverse();
  }

  /** Return bounded telemetry for a known set of deliveries, chronologically. */
  listDeliveryTelemetry(filters: {
    workspace_id: string;
    delivery_ids: string[];
    exclude_kinds?: string[];
    limit?: number;
  }): unknown[] {
    const deliveryIds = Array.from(new Set(filters.delivery_ids.filter(Boolean)));
    if (deliveryIds.length === 0) return [];
    const excludedKinds = Array.from(new Set((filters.exclude_kinds ?? []).filter(Boolean)));
    const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
    const placeholders = deliveryIds.map(() => "?").join(", ");
    const excludedPlaceholders = excludedKinds.map(() => "?").join(", ");
    const excludedClause = excludedKinds.length > 0
      ? `AND kind NOT IN (${excludedPlaceholders})`
      : "";
    return (this.db.prepare(`
      SELECT *
      FROM runtime_telemetry
      WHERE workspace_id = ? AND delivery_id IN (${placeholders})
        ${excludedClause}
      ORDER BY created_at DESC, telemetry_id DESC
      LIMIT ?
    `).all(filters.workspace_id, ...deliveryIds, ...excludedKinds, limit) as unknown[]).reverse();
  }

  getEvent(eventId: string): EventEnvelope | null {
    const row = this.db.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId) as any;
    return row ? this.rowToEvent(row) : null;
  }

  /**
   * Exact provider-neutral input for one running canonical NodeExecution
   * attempt. Bridge/runtime code consumes this projection instead of resolving
   * whichever Actor definition or runtime profile happens to be current later.
   */
  getRuntimeProcessingContract(attemptId: string): RuntimeProcessingContract {
    return this.runtimeProcessingContracts.resolve(attemptId);
  }

  /**
   * The work that produced an Event: the runtime trace of the turn that emitted it.
   * Emitted events carry their producing turn as `metadata.delivery_id`; telemetry is
   * keyed by `delivery_id`. System-originated events (pulse.fired, webhook ingest) have
   * no producing turn — `delivery_id` is null and the trace is empty. Returns null only
   * when the Event itself does not exist. Work-log prose is not served here: it lives as
   * committed files retrievable by an actor, not through the bus.
   */
  getEventTrace(eventId: string): { event_id: string; delivery_id: string | null; telemetry: unknown[] } | null {
    const event = this.getEvent(eventId);
    if (!event) return null;
    const deliveryId = typeof event.metadata?.delivery_id === "string" ? event.metadata.delivery_id : null;
    const telemetry = deliveryId
      ? this.listRuntimeTelemetry({ workspace_id: event.workspace_id, delivery_id: deliveryId })
      : [];
    return { event_id: eventId, delivery_id: deliveryId, telemetry };
  }

  listEvents(filters: {
    workspace_id?: string;
    thread_id?: string;
    context_id?: string;
    scope_id?: string;
    type?: string;
    since?: string;
    before?: string;
    direction?: "forward" | "backward";
    limit?: number;
  }): EventEnvelope[] {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const conditions: string[] = [];
    const params: any[] = [];
    if (filters.context_id) {
      conditions.push("context_id = ?");
      params.push(filters.context_id);
    }
    if (filters.workspace_id) {
      conditions.push("workspace_id = ?");
      params.push(filters.workspace_id);
    }
    if (filters.thread_id) {
      conditions.push("thread_id = ?");
      params.push(filters.thread_id);
    }
    if (filters.scope_id) {
      conditions.push("scope_id = ?");
      params.push(filters.scope_id);
    }
    if (filters.type) {
      conditions.push("type = ?");
      params.push(filters.type);
    }
    if (filters.since) {
      const cursor = decodeEventCursor(filters.since);
      // Strictly after the cursor in (created_at, event_id) order. The event_id
      // tie-break is what makes same-instant Events safe to page past.
      conditions.push("(created_at > ? OR (created_at = ? AND event_id > ?))");
      params.push(cursor.created_at, cursor.created_at, cursor.event_id);
    }
    if (filters.before) {
      const cursor = decodeEventCursor(filters.before);
      // Strictly before the cursor in the same total Event order. Backward
      // history reads are returned chronologically after the bounded SQL page
      // is selected, so clients can prepend without reordering their stream.
      conditions.push("(created_at < ? OR (created_at = ? AND event_id < ?))");
      params.push(cursor.created_at, cursor.created_at, cursor.event_id);
    }
    let sql = "SELECT * FROM events";
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    const backward = filters.direction === "backward";
    sql += backward
      ? " ORDER BY created_at DESC, event_id DESC LIMIT ?"
      : " ORDER BY created_at ASC, event_id ASC LIMIT ?";
    params.push(limit);
    const events = (this.db.prepare(sql).all(...params) as any[]).map((row) => this.rowToEvent(row));
    return backward ? events.reverse() : events;
  }

  getEndpointWatermark(workspaceId: string, endpointId: string): EndpointWatermark | null {
    return this.endpointWatermarkStore.get(workspaceId, endpointId);
  }

  setEndpointWatermark(workspaceId: string, endpointId: string, cursor: string): EndpointWatermark {
    return this.endpointWatermarkStore.set(workspaceId, endpointId, cursor);
  }

  listDeliveries(filters: { workspace_id?: string; context_id?: string; limit?: number }): unknown[] {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    if (filters.context_id) {
      const context = this.contextStore.getContext(filters.context_id);
      if (!context || (filters.workspace_id && context.workspace_id !== filters.workspace_id)) return [];
      return this.db.prepare(`
        ${CONTEXT_DELIVERIES_CTE}
        SELECT d.* FROM delivery_bundles d JOIN related r ON r.delivery_id = d.delivery_id
        ORDER BY CASE WHEN d.state IN ('reserved', 'delivered_to_bridge', 'injected_to_runtime') THEN 0 ELSE 1 END,
          d.created_at DESC, d.delivery_id DESC
        LIMIT ?
      `).all(JSON.stringify([filters.context_id]), limit);
    }
    if (filters.workspace_id) {
      return this.db.prepare(`
        SELECT * FROM delivery_bundles
        WHERE workspace_id = ?
        ORDER BY created_at ASC
        LIMIT ?
      `).all(filters.workspace_id, limit);
    }
    return this.db.prepare("SELECT * FROM delivery_bundles ORDER BY created_at ASC LIMIT ?").all(limit);
  }

  getContextDeliverySummaries(contextIds: readonly string[]): Map<string, { active_count: number; latest_state: string | null }> {
    if (contextIds.length === 0) return new Map();
    const rows = this.db.prepare(`
      ${CONTEXT_DELIVERIES_CTE}, ranked AS (
        SELECT r.context_id, d.state,
          ROW_NUMBER() OVER (PARTITION BY r.context_id ORDER BY d.created_at DESC, d.delivery_id DESC) AS position
        FROM related r JOIN delivery_bundles d ON d.delivery_id = r.delivery_id
      )
      SELECT context_id,
        SUM(CASE WHEN state IN ('reserved', 'delivered_to_bridge', 'injected_to_runtime') THEN 1 ELSE 0 END) AS active_count,
        MAX(CASE WHEN position = 1 THEN state END) AS latest_state
      FROM ranked GROUP BY context_id
    `).all(JSON.stringify([...new Set(contextIds)])) as Array<{ context_id: string; active_count: number; latest_state: string }>;
    return new Map(rows.map(({ context_id, ...summary }) => [context_id, summary]));
  }

  listPendingResponses(filters: { workspace_id?: string; waiting_endpoint_id?: string; limit?: number }): unknown[] {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (filters.workspace_id) {
      clauses.push("workspace_id = ?");
      args.push(filters.workspace_id);
    }
    if (filters.waiting_endpoint_id) {
      clauses.push("waiting_endpoint_id = ?");
      args.push(filters.waiting_endpoint_id);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    args.push(limit);
    return this.db.prepare(
      `SELECT * FROM pending_responses ${where} ORDER BY created_at ASC LIMIT ?`,
    ).all(...args);
  }

  listConfigs(): unknown[] {
    return this.db.prepare("SELECT * FROM saved_configs ORDER BY updated_at DESC").all();
  }

  createConfig(input: { name: string; config: Record<string, unknown> }, broadcast: Broadcast): unknown {
    const timestamp = now();
    const configId = `cfg_${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO saved_configs (config_id, name, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(configId, input.name, json(input.config), timestamp, timestamp);
    const record = this.db.prepare("SELECT * FROM saved_configs WHERE config_id = ?").get(configId);
    broadcast("saved_config_created", { config: record });
    return record;
  }

  requestConfigSnapshot(workspaceId: string, broadcast: Broadcast): { ok: true } {
    broadcast("config_snapshot_requested", { workspace_id: workspaceId });
    return { ok: true };
  }

  importWorkspaceConfiguration(
    workspaceId: string,
    bindingId: string,
    inventory: WorkspaceConfigurationInventoryV1 | unknown,
    broadcast: Broadcast,
  ): Readonly<{
    import_result: WorkspaceConfigurationImportResult;
    workspace: LocalWorkspaceRecord;
  }> {
    const importResult = this.transaction(() => {
      const result = this.workspaceConfigurationImportStore.import(workspaceId, inventory);
      if (result.receipt.outcome === "applied") {
        // Only an applied canonical import receipt may advance the active disk
        // configuration. Attachment callbacks report health but cannot claim
        // that unimported files are active.
        this.workspaceIdentityStore.updateCurrentBinding({
          workspace_id: workspaceId,
          host_id: this.localHostId,
          expected_binding_id: bindingId,
          active_config_hash: result.receipt.config_hash,
        });
      }
      return result;
    });
    const workspace = this.requireLocalWorkspace(workspaceId);
    broadcast("workspace_configuration_imported", {
      workspace: this.workspaceIdentityStore.getRemoteProjection(workspaceId, this.localHostId),
      receipt: importResult.receipt,
      replayed: importResult.replayed,
    });
    return { import_result: importResult, workspace };
  }

  /**
   * Attachment health never establishes canonical configuration state. The
   * active hash is owned by importWorkspaceConfiguration and its receipt.
   */
  private updateAttachmentWithoutConfiguration(
    workspaceId: string,
    bindingId: string,
    status: string,
  ): void {
      this.workspaceIdentityStore.updateCurrentBinding({
        workspace_id: workspaceId,
        host_id: this.localHostId,
        expected_binding_id: bindingId,
        status,
      });
  }

  requestApplyConfig(workspaceId: string, configId: string | null, broadcast: Broadcast): { ok: true } {
    broadcast("config_apply_requested", { workspace_id: workspaceId, config_id: configId });
    return { ok: true };
  }

  ingestWebhook(
    workspaceId: string,
    routeId: string,
    body: Record<string, unknown>,
    broadcast: Broadcast,
    configuredScopeId?: string | null
  ): EventEnvelope {
    const destination = this.db.prepare(`
      SELECT endpoint_id FROM endpoints
      WHERE workspace_id = ? AND bridge_id IS NOT NULL
      ORDER BY created_at ASC LIMIT 1
    `).get(workspaceId) as any;
    if (!destination) throw new Error("No agent endpoint is registered for this workspace");
    const scopeId = this.requireScopeId(workspaceId, configuredScopeId, "webhook route must be configured with a Scope");
    // Per design §3.1.6: webhook ingest is a non-actor trigger. Bus creates a
    // target-only context and emits with source_endpoint_id = null.
    return this.emitTriggerEvent(
      {
        type: "webhook_received",
        workspace_id: workspaceId,
        target_endpoint_id: destination.endpoint_id,
        scope_id: scopeId,
        correlation_id: typeof body.correlation_id === "string" ? body.correlation_id : null,
        content: {
          text: typeof body.text === "string" ? body.text : `Webhook ${routeId} received`,
          data: body
        },
        metadata: { trigger_kind: "webhook", route_id: routeId }
      },
      broadcast
    );
  }

  // ---------------------------------------------------------------------------
  // Pulse CRUD
  // ---------------------------------------------------------------------------

  createPulse(input: {
    pulse_id: string;
    workspace_id: string;
    persistence?: PulsePersistence;
    scope_id?: string | null;
    current_context_id?: string | null;
    trigger: { type: string; at?: string; schedule?: string; timezone?: string };
    content: Record<string, unknown>;
    subscribers: PulseSubscriber[];
    created_by?: string;
  }, broadcast: Broadcast): unknown {
    if (this.workspacePortabilityService.isRestoreHeld(input.workspace_id)) {
      throw new WorkspacePortabilityError(
        "workspace_restore_held",
        "This restored Workspace is held while local bindings are reconnected.",
        { workspace_id: input.workspace_id },
      );
    }
    const timestamp = now();
    const nextFireAt = this.calculateNextFireAt(input.trigger);
    const currentContext = input.current_context_id
      ? this.getContextAnchor(input.workspace_id, input.current_context_id)
      : null;
    let scopeId: string | null = input.scope_id
      ? this.validateScopeId(input.workspace_id, input.scope_id)
      : currentContext?.scope_id ?? null;
    let createsGeneratedDeliveryContext = false;
    const explicitAnchorScopes = new Set<string>();
    const subscribersToValidate = new Map<string, PulseSubscriber>();
    for (const subscriber of this.getPulseSubscribers(input.pulse_id)) {
      subscribersToValidate.set(json(subscriber), subscriber);
    }
    for (const subscriber of input.subscribers) {
      subscribersToValidate.set(json(subscriber), subscriber);
    }

    for (const subscriber of subscribersToValidate.values()) {
      const anchor = this.validatePulseSubscriberAnchor({
        workspace_id: input.workspace_id,
        pulse_scope_id: scopeId,
        subscriber,
        allow_missing_generated_scope: true
      });
      if (anchor.creates_generated_delivery_context) createsGeneratedDeliveryContext = true;
      if (anchor.anchor_scope_id) explicitAnchorScopes.add(anchor.anchor_scope_id);
    }

    if (!scopeId && !createsGeneratedDeliveryContext && explicitAnchorScopes.size === 1) {
      scopeId = [...explicitAnchorScopes][0];
    }

    if (createsGeneratedDeliveryContext && !scopeId) {
      throw new ScopeRequiredError(
        input.workspace_id,
        "pulse must be configured with a Scope or scoped current Context"
      );
    }

    if (!scopeId && subscribersToValidate.size === 0) {
      throw new ScopeRequiredError(
        input.workspace_id,
        "pulse must be configured with a Scope or explicit Context anchor"
      );
    }
    this.db.prepare(`
      INSERT INTO pulses (pulse_id, workspace_id, persistence, scope_id, trigger_json, content_json, status, created_by, created_at, updated_at, next_fire_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
      ON CONFLICT(pulse_id) DO UPDATE SET
        trigger_json = excluded.trigger_json,
        content_json = excluded.content_json,
        persistence = excluded.persistence,
        scope_id = excluded.scope_id,
        updated_at = excluded.updated_at,
        next_fire_at = excluded.next_fire_at,
        status = CASE WHEN pulses.status = 'cancelled' THEN pulses.status ELSE excluded.status END
    `).run(
      input.pulse_id,
      input.workspace_id,
      input.persistence ?? "local",
      scopeId,
      json(input.trigger),
      json(input.content),
      input.created_by ?? null,
      timestamp,
      timestamp,
      nextFireAt
    );
    // Upsert subscribers
    for (const subscriber of input.subscribers) {
      this.db.prepare(`
        INSERT OR IGNORE INTO pulse_subscribers (pulse_id, subscriber_json, created_at)
        VALUES (?, ?, ?)
      `).run(input.pulse_id, json(subscriber), timestamp);
    }
    const pulse = this.getPulse(input.pulse_id);
    broadcast("pulse_created", { pulse });
    return pulse;
  }

  getPulse(pulseId: string): unknown {
    const row = this.db.prepare("SELECT * FROM pulses WHERE pulse_id = ?").get(pulseId) as any;
    if (!row) return null;
    return this.rowToPulse(row);
  }

  listPulses(filters: { workspace_id?: string; status?: string; scope_id?: string }): unknown[] {
    let query = "SELECT * FROM pulses WHERE 1=1";
    const params: string[] = [];
    if (filters.workspace_id) {
      query += " AND workspace_id = ?";
      params.push(filters.workspace_id);
    }
    if (filters.status) {
      query += " AND status = ?";
      params.push(filters.status);
    }
    if (filters.scope_id) {
      query += " AND scope_id = ?";
      params.push(filters.scope_id);
    }
    query += " ORDER BY created_at DESC";
    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map((row) => this.rowToPulse(row));
  }

  getPulseSubscribers(pulseId: string): PulseSubscriber[] {
    const rows = this.db.prepare("SELECT subscriber_json FROM pulse_subscribers WHERE pulse_id = ?")
      .all(pulseId) as Array<{ subscriber_json: string }>;
    return rows.map((row) => parseJson<PulseSubscriber>(row.subscriber_json));
  }

  getOrCreatePulseDeliveryContext(input: {
    pulse_id: string;
    workspace_id: string;
    scope_id: string;
    subscriber: Extract<PulseSubscriber, { endpoint_ref: string }>;
    endpoint_id: string;
  }): string {
    if (!input.scope_id) {
      throw new ScopeRequiredError(input.workspace_id, "generated pulse delivery Context requires Scope");
    }
    const subscriberKey = this.pulseDeliverySubscriberKey(input.subscriber);
    const contextId = `ctx_pulse_${stableHash(`${input.workspace_id}\0${input.pulse_id}\0${subscriberKey}`).slice(0, 32)}`;
    const timestamp = now();
    return this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT context_id
        FROM pulse_delivery_contexts
        WHERE pulse_id = ? AND subscriber_key = ?
      `).get(input.pulse_id, subscriberKey) as { context_id: string } | undefined;
      const mappedContextId = existing?.context_id ?? contextId;
      const existingContext = this.contextStore.getContext(mappedContextId);
      if (!existing) {
        this.db.prepare(`
          INSERT INTO pulse_delivery_contexts (
            pulse_id, subscriber_key, context_id, workspace_id, endpoint_ref, endpoint_id, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.pulse_id,
          subscriberKey,
          mappedContextId,
          input.workspace_id,
          input.subscriber.endpoint_ref,
          input.endpoint_id,
          timestamp,
          timestamp
        );
      } else {
        this.db.prepare(`
          UPDATE pulse_delivery_contexts
          SET endpoint_ref = ?, endpoint_id = ?, workspace_id = ?, updated_at = ?
          WHERE pulse_id = ? AND subscriber_key = ?
        `).run(input.subscriber.endpoint_ref, input.endpoint_id, input.workspace_id, timestamp, input.pulse_id, subscriberKey);
      }
      if (existingContext && existingContext.workspace_id === input.workspace_id) return mappedContextId;
      this.contextStore.createContext({
        workspace_id: input.workspace_id,
        scope_id: input.scope_id,
        created_by_endpoint_id: input.endpoint_id,
        participants: [input.endpoint_id],
        context_id: mappedContextId
      });
      return mappedContextId;
    });
  }

  updatePulseStatus(pulseId: string, status: string, broadcast: Broadcast): unknown {
    if (status === "active") {
      const pulse = this.db.prepare("SELECT workspace_id FROM pulses WHERE pulse_id = ?")
        .get(pulseId) as { workspace_id: string } | undefined;
      if (pulse && this.workspacePortabilityService.isRestoreHeld(pulse.workspace_id)) {
        throw new WorkspacePortabilityError(
          "workspace_restore_held",
          "This restored Workspace is held while local bindings are reconnected.",
          { workspace_id: pulse.workspace_id, pulse_id: pulseId },
        );
      }
    }
    const timestamp = now();
    this.db.prepare("UPDATE pulses SET status = ?, updated_at = ? WHERE pulse_id = ?")
      .run(status, timestamp, pulseId);
    const pulse = this.getPulse(pulseId);
    broadcast(`pulse_${status}`, { pulse });
    return pulse;
  }

  addPulseSubscriber(pulseId: string, subscriber: PulseSubscriber): void {
    const pulse = this.db.prepare("SELECT workspace_id, scope_id FROM pulses WHERE pulse_id = ?")
      .get(pulseId) as { workspace_id: string; scope_id: string | null } | undefined;
    if (!pulse) throw new PulseNotFoundError(pulseId);
    this.validatePulseSubscriberAnchor({
      workspace_id: pulse.workspace_id,
      pulse_scope_id: pulse.scope_id,
      subscriber
    });
    this.db.prepare(`
      INSERT OR IGNORE INTO pulse_subscribers (pulse_id, subscriber_json, created_at)
      VALUES (?, ?, ?)
    `).run(pulseId, json(subscriber), now());
  }

  removePulseSubscriber(pulseId: string, subscriber: PulseSubscriber): void {
    this.db.prepare("DELETE FROM pulse_subscribers WHERE pulse_id = ? AND subscriber_json = ?")
      .run(pulseId, json(subscriber));
  }

  recordPulseFired(pulseId: string, nextFireAt: string | null): void {
    const timestamp = now();
    const status = nextFireAt ? "active" : "completed";
    this.db.prepare(`
      UPDATE pulses
      SET last_fired_at = ?, fire_count = fire_count + 1, next_fire_at = ?, status = ?, updated_at = ?
      WHERE pulse_id = ?
    `).run(timestamp, nextFireAt, status, timestamp, pulseId);
  }

  getActivePulsesForScheduler(): Array<{
    pulse_id: string;
    workspace_id: string;
    trigger: { type: string; at?: string; schedule?: string; timezone?: string };
    content: Record<string, unknown>;
    next_fire_at: string | null;
  }> {
    const rows = this.db.prepare(`
      SELECT pulse_id, workspace_id, trigger_json, content_json, next_fire_at
      FROM pulses
      WHERE status = 'active' AND next_fire_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM workspace_restore_holds hold
          WHERE hold.workspace_id = pulses.workspace_id AND hold.state = 'held'
        )
      ORDER BY next_fire_at ASC
    `).all() as any[];
    return rows.map((row) => ({
      pulse_id: row.pulse_id,
      workspace_id: row.workspace_id,
      trigger: parseJson<{ type: string; at?: string; schedule?: string; timezone?: string }>(row.trigger_json),
      content: parseJson<Record<string, unknown>>(row.content_json),
      next_fire_at: row.next_fire_at
    }));
  }

  resolveSubscriberEndpointId(workspaceId: string, endpointRef: string): string {
    // Strip legacy type prefix (agent:/human:/user:) from endpoint refs
    const bareId = endpointRef.replace(/^(agent|human|user):/, "");
    const fullId = `actor:${workspaceId}:${bareId}`;
    const endpoint = this.db.prepare("SELECT endpoint_id FROM endpoints WHERE endpoint_id = ?").get(fullId) as any;
    if (endpoint) return endpoint.endpoint_id;
    // Try with the ref as-is (for refs that don't have a type prefix)
    const fullIdRaw = `actor:${workspaceId}:${endpointRef}`;
    const endpointRaw = this.db.prepare("SELECT endpoint_id FROM endpoints WHERE endpoint_id = ?").get(fullIdRaw) as any;
    if (endpointRaw) return endpointRaw.endpoint_id;
    // Try direct match
    const direct = this.db.prepare("SELECT endpoint_id FROM endpoints WHERE endpoint_id = ?").get(endpointRef) as any;
    if (direct) return direct.endpoint_id;
    return fullId;
  }

  calculateNextFireAt(trigger: { type: string; at?: string; schedule?: string; timezone?: string }, fromDate?: Date): string | null {
    if (trigger.type === "once" && trigger.at) {
      return new Date(trigger.at).toISOString();
    }
    if (trigger.type === "cron" && trigger.schedule) {
      try {
        const options: { currentDate?: Date; tz?: string } = {};
        if (fromDate) options.currentDate = fromDate;
        if (trigger.timezone) options.tz = trigger.timezone;
        const expr = CronExpressionParser.parse(trigger.schedule, options);
        const next = expr.next();
        return next.toDate().toISOString();
      } catch {
        return null;
      }
    }
    return null;
  }

  private rowToPulse(row: any): Record<string, unknown> {
    return {
      pulse_id: row.pulse_id,
      workspace_id: row.workspace_id,
      persistence: row.persistence,
      scope_id: row.scope_id,
      trigger: parseJson<unknown>(row.trigger_json),
      content: parseJson<unknown>(row.content_json),
      subscribers: this.getPulseSubscribers(row.pulse_id),
      status: row.status,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      next_fire_at: row.next_fire_at,
      last_fired_at: row.last_fired_at,
      fire_count: row.fire_count
    };
  }

  private normalizeResponse(response?: ResponseExpectation): ResponseExpectation {
    return {
      expected: !!response?.expected,
      mode: response?.mode ?? "open",
      correlation_id: response?.correlation_id ?? null,
      timeout_at: response?.timeout_at ?? null
    };
  }

  private contextScopeId(contextId: string): string | null {
    return this.contextStore.getContext(contextId)?.scope_id ?? null;
  }

  private pulseDeliverySubscriberKey(subscriber: Extract<PulseSubscriber, { endpoint_ref: string }>): string {
    return stableHash(canonicalJson({
      kind: "endpoint",
      endpoint_ref: subscriber.endpoint_ref,
      context_id: null
    }));
  }

  private validateApprovalDecisionBinding(input: {
    workspace_id: string;
    context_id: string;
    binding: ApprovalDecisionBinding;
    artefact_version_ids: readonly string[];
  }): {
    execution: ScopeExecutionRecord;
    node_execution: NodeExecutionRecord;
    revision: ScopeCompositionRevision;
    ports: Record<ApprovalDecision, ScopePort>;
  } {
    const binding = input.binding;
    if (input.artefact_version_ids.length === 0) {
      throw new ApprovalValidationError(
        "a Scope decision binding requires at least one exact ArtefactVersion as decision evidence",
      );
    }
    const nodeExecution = this.scopeExecutionStore.getNodeExecution(binding.node_execution_id);
    const execution = nodeExecution
      ? this.scopeExecutionStore.getExecution(nodeExecution.execution_id)
      : null;
    if (!nodeExecution || !execution || execution.workspace_id !== input.workspace_id) {
      throw new ApprovalValidationError(
        `decision_binding.node_execution_id must identify a NodeExecution in Workspace '${input.workspace_id}'`,
      );
    }
    if (nodeExecution.status !== "waiting_human") {
      throw new ApprovalValidationError(
        `NodeExecution '${nodeExecution.node_execution_id}' is '${nodeExecution.status}', not waiting_human`,
      );
    }
    if (nodeExecution.state_revision !== binding.node_execution_state_revision) {
      throw new ApprovalValidationError(
        `NodeExecution '${nodeExecution.node_execution_id}' changed after the decision binding was prepared`,
      );
    }
    if (nodeExecution.context_id !== input.context_id) {
      throw new ApprovalValidationError(
        `decision_binding.node_execution_id must use the ApprovalRequest Context '${input.context_id}'`,
      );
    }
    if (execution.execution_id !== binding.scope_execution_id) {
      throw new ApprovalValidationError(
        "decision_binding.scope_execution_id does not own the bound NodeExecution",
      );
    }
    if (["completed", "failed", "cancelled", "superseded"].includes(execution.status)) {
      throw new ApprovalValidationError(
        `ScopeExecution '${execution.execution_id}' is already ${execution.status}`,
      );
    }
    if (
      execution.revision_id !== binding.composition_revision_id
      || nodeExecution.revision_id !== binding.composition_revision_id
    ) {
      throw new ApprovalValidationError(
        "decision_binding.composition_revision_id is not the ScopeExecution's pinned revision",
      );
    }
    if (nodeExecution.node_id !== binding.node_placement_id) {
      throw new ApprovalValidationError(
        "decision_binding.node_placement_id does not own the bound NodeExecution",
      );
    }
    const revision = this.scopeCompositionStore.getRevision(binding.composition_revision_id);
    const placement = revision?.nodes.find((candidate) => candidate.node_id === binding.node_placement_id);
    if (
      !revision
      || revision.workspace_id !== input.workspace_id
      || revision.scope_id !== execution.scope_id
      || revision.routing_mode !== "edge"
      || !revision.published_at
      || !placement
    ) {
      throw new ApprovalValidationError(
        "decision_binding must name a retained published NodePlacement on the pinned Edge-routed revision",
      );
    }
    const decisions: ApprovalDecision[] = ["approved", "rejected", "changes_requested"];
    const ports = {} as Record<ApprovalDecision, ScopePort>;
    for (const decision of decisions) {
      const portId = binding.outcome_port_ids[decision];
      const port = revision.ports.find((candidate) =>
        candidate.port_id === portId
        && candidate.node_id === placement.node_id
        && candidate.direction === "output"
      );
      if (!port) {
        throw new ApprovalValidationError(
          `decision_binding.outcome_port_ids.${decision} must identify an output Port owned by NodePlacement '${placement.node_id}'`,
        );
      }
      if (!revision.edges.some((edge) => edge.enabled !== false && edge.source_port_id === port.port_id)) {
        throw new ApprovalValidationError(
          `decision_binding.outcome_port_ids.${decision} has no enabled stored Edge route`,
        );
      }
      ports[decision] = port;
    }
    for (const port of new Map(Object.values(ports).map((candidate) => [candidate.port_id, candidate])).values()) {
      try {
        this.requireArtefactVersionsForPort(input.workspace_id, port, input.artefact_version_ids);
      } catch (error) {
        if (error instanceof ScopeExecutionInvalidError) {
          throw new ApprovalValidationError(error.reason);
        }
        throw error;
      }
    }
    return { execution, node_execution: nodeExecution, revision, ports };
  }

  private requireArtefactVersionsForPort(
    workspaceId: string,
    port: ScopePort,
    requestedIds: readonly string[],
  ): string[] {
    const ids = [...requestedIds];
    if (new Set(ids).size !== ids.length) {
      throw new ScopeExecutionInvalidError(`Port '${port.port_id}' received a duplicate ArtefactVersion reference`);
    }
    const minimum = port.min_count ?? 0;
    const maximum = port.max_count === undefined ? 1 : port.max_count;
    if (ids.length < minimum) {
      throw new ScopeExecutionInvalidError(
        `Port '${port.port_id}' requires at least ${minimum} ArtefactVersion reference${minimum === 1 ? "" : "s"}`,
      );
    }
    if (maximum !== null && ids.length > maximum) {
      throw new ScopeExecutionInvalidError(
        `Port '${port.port_id}' accepts at most ${maximum} ArtefactVersion reference${maximum === 1 ? "" : "s"}`,
      );
    }
    const acceptedTypes = new Set(port.artefact_types ?? []);
    for (const versionId of ids) {
      const version = this.artefactStore.getVersion(versionId);
      const artefact = version ? this.artefactStore.getArtefact(version.artefact_id) : null;
      if (!version || !artefact || artefact.workspace_id !== workspaceId) {
        throw new ScopeExecutionInvalidError(
          `ArtefactVersion '${versionId}' is unavailable in Workspace '${workspaceId}'`,
        );
      }
      if (acceptedTypes.size > 0 && !acceptedTypes.has("*") && !acceptedTypes.has(artefact.type_ref)) {
        throw new ScopeExecutionInvalidError(
          `ArtefactVersion '${versionId}' has type '${artefact.type_ref}', which Port '${port.port_id}' does not accept`,
        );
      }
    }
    return ids;
  }

  private associateArtefactVersions(
    artefactVersionIds: readonly string[],
    targets: ReadonlyArray<{
      kind: "event" | "context" | "scope_execution" | "node_execution" | "delivery" | "connector_receipt";
      id: string;
      role: ArtefactAssociationRole;
    }>,
  ): void {
    for (const target of targets) {
      for (const versionId of artefactVersionIds) {
        this.artefactStore.associateVersion({
          artefact_version_id: versionId,
          target_kind: target.kind,
          target_id: target.id,
          role: target.role,
          idempotency_key: `canonical:${target.kind}:${target.id}:${target.role}:${versionId}`,
        });
      }
    }
  }

  private eventArtefactVersionIds(eventId: string): string[] {
    const row = this.db.prepare("SELECT artefact_version_ids_json FROM events WHERE event_id = ?")
      .get(eventId) as { artefact_version_ids_json: string } | undefined;
    return row ? parseJson<string[]>(row.artefact_version_ids_json) : [];
  }

  private freezeEventArtefactReferences(): void {
    const columns = this.db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
    if (columns.some(column => column.name === "artefact_version_ids_json")) return;
    this.db.exec("ALTER TABLE events ADD COLUMN artefact_version_ids_json TEXT NOT NULL DEFAULT '[]'");
    // Earlier builds projected every association as an Event attachment. Preserve
    // that visible history once, explicitly labelled as an upgrade snapshot: it
    // cannot establish which references were present when the Event was emitted.
    const associations = this.db.prepare(`
      SELECT artefact_version_id FROM artefact_associations
      WHERE target_kind = 'event' AND target_id = ?
      ORDER BY created_at ASC, association_id ASC
    `);
    const update = this.db.prepare(`
      UPDATE events SET artefact_version_ids_json = ?, metadata_json = ? WHERE event_id = ?
    `);
    const events = this.db.prepare("SELECT event_id, metadata_json FROM events").all() as Array<{
      event_id: string; metadata_json: string;
    }>;
    for (const event of events) {
      const ids = (associations.all(event.event_id) as Array<{ artefact_version_id: string }>)
        .map(row => row.artefact_version_id);
      update.run(json([...new Set(ids)]), json({
        ...parseJson<Record<string, unknown>>(event.metadata_json),
        artefact_reference_basis: "legacy_projection_at_schema_12",
      }), event.event_id);
    }
  }

  private publishArtefactVersion(input: PublishArtefactVersionInput): ArtefactVersion {
    if (input.content_ref.kind !== "workspace-relative") return this.artefactStore.publishVersion(input);
    const artefact = this.artefactStore.getArtefact(input.artefact_id);
    if (!artefact) throw new ArtefactNotFoundError(input.artefact_id);
    const workspaceLocator = this.getWorkspaceLocator(artefact.workspace_id);
    if (!workspaceLocator) throw new ArtefactContentNotFoundError();
    const content = resolveWorkspaceArtefactContent({
      workspace_locator: workspaceLocator,
      content_ref: input.content_ref,
    });
    let createdPath: string | null = null;
    try {
      return this.transaction(() => {
        const version = this.artefactStore.publishVersion({
          ...input,
          content_ref: {
            ...input.content_ref,
            kind: "workspace-relative",
            path: contextAttachmentContentPath(content.digest.value),
            digest: content.digest,
            size_bytes: content.size_bytes,
          },
        });
        createdPath = this.persistContextAttachmentContent(artefact.workspace_id, content);
        return version;
      });
    } catch (error) {
      if (createdPath) rmSync(createdPath, { force: true });
      throw error;
    }
  }

  private persistContextAttachmentContent(
    workspaceId: string,
    ingress: Pick<ConsumedAttachmentIngress, "digest" | "size_bytes" | "bytes">,
  ): string | null {
    const workspaceRoot = this.getWorkspaceLocator(workspaceId);
    if (!workspaceRoot) {
      throw new Error(`Workspace '${workspaceId}' has no local content binding.`);
    }
    const relativePath = contextAttachmentContentPath(ingress.digest.value);
    const destination = resolveWithinRoot(workspaceRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });

    if (existsSync(destination)) {
      assertAttachmentContentMatches(destination, ingress);
      return null;
    }

    const temporary = `${destination}.upload-${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, ingress.bytes, { flag: "wx" });
      renameSync(temporary, destination);
    } catch (error) {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
      if (existsSync(destination)) {
        assertAttachmentContentMatches(destination, ingress);
        return null;
      }
      throw error;
    }
    try {
      assertAttachmentContentMatches(destination, ingress);
      return destination;
    } catch (error) {
      rmSync(destination, { force: true });
      throw error;
    }
  }

  private insertEvent(
    input: {
      type: string;
      workspace_id: string;
      source_endpoint_id: string | null;
      destination: DestinationSelector;
      thread_id?: string;
      correlation_id: string | null;
      content: Record<string, unknown>;
      metadata: Record<string, unknown>;
      artefact_version_ids?: string[];
      artefact_role?: ArtefactAssociationRole;
      idempotency_key: string | null;
    },
    response: ResponseExpectation,
    contextId: string
  ): EventEnvelope {
    const destinationEndpointId =
      input.destination.kind === "endpoint"
        ? input.destination.endpoint_id
        : input.destination.kind === "context"
        ? `context:${input.destination.context_id}`
        : `broadcast:${input.destination.scope}:${input.destination.target}`;
    // Legacy thread_id storage: write the resolved context_id so the existing
    // NOT NULL column is satisfied. No new flow reads thread_id.
    const threadIdForStorage = input.thread_id && input.thread_id.length > 0 ? input.thread_id : contextId;
    const artefactVersionIds = [...(input.artefact_version_ids ?? [])];
    if (new Set(artefactVersionIds).size !== artefactVersionIds.length) {
      throw new Error("An Event cannot reference the same ArtefactVersion more than once.");
    }
    for (const versionId of artefactVersionIds) {
      const version = this.artefactStore.getVersion(versionId);
      const artefact = version ? this.artefactStore.getArtefact(version.artefact_id) : null;
      if (!version || !artefact || artefact.workspace_id !== input.workspace_id) {
        throw new Error(`Event ArtefactVersion '${versionId}' is unavailable in this Workspace.`);
      }
    }
    const envelope: EventEnvelope = {
      event_id: `evt_${randomUUID()}`,
      type: input.type,
      workspace_id: input.workspace_id,
      source_endpoint_id: input.source_endpoint_id,
      thread_id: threadIdForStorage,
      context_id: contextId,
      scope_id: this.contextScopeId(contextId),
      correlation_id: input.correlation_id ?? null,
      destination_json: input.destination,
      content: input.content,
      response,
      metadata: input.metadata ?? {},
      artefact_version_ids: artefactVersionIds,
      created_at: now()
    };
    this.db.prepare(`
      INSERT INTO events (
        event_id, type, workspace_id, source_endpoint_id, destination_endpoint_id, thread_id, context_id, correlation_id,
        scope_id, destination_json, content_json, response_json, metadata_json, idempotency_key, created_at,
        artefact_version_ids_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      envelope.event_id,
      envelope.type,
      envelope.workspace_id,
      envelope.source_endpoint_id,
      destinationEndpointId,
      envelope.thread_id,
      envelope.context_id,
      envelope.correlation_id,
      envelope.scope_id,
      json(envelope.destination_json),
      json(envelope.content),
      json(envelope.response),
      json(envelope.metadata),
      input.idempotency_key ?? null,
      envelope.created_at,
      json(artefactVersionIds)
    );
    this.associateArtefactVersions(artefactVersionIds, [{
      kind: "event",
      id: envelope.event_id,
      role: input.artefact_role ?? "attachment",
    }]);
    return envelope;
  }

  private resolveDestinations(event: EventEnvelope): string[] {
    const destination = event.destination_json;
    if (destination.kind === "endpoint") {
      const endpoint = this.getEndpoint(destination.endpoint_id);
      return endpoint?.status === "retired" ? [] : [destination.endpoint_id];
    }
    // Single context-delivery path: record + route to subscribed actors.
    // Actors subscribed to the event type (or "*") are delivered;
    // a context with no matching subscriptions naturally yields zero deliveries.
    if (destination.kind === "context") {
      const subs = this.contextStore.getContextSubscriptions(destination.context_id);
      const eventType = event.type;
      return subs
        .filter((sub) => sub.event_types.includes("*") || sub.event_types.includes(eventType))
        .map((sub) => sub.endpoint_id)
        .filter((endpointId) => this.getEndpoint(endpointId)?.status !== "retired");
    }
    const target = destination.target;
    const query = `
      SELECT endpoint_id
      FROM endpoints
      WHERE workspace_id = ?
        AND status <> 'retired'
        AND (
          (? = 'all')
          OR (? = 'active' AND status = 'active')
          OR (? = 'with_delivery_processor' AND bridge_id IS NOT NULL)
          OR (? = 'without_delivery_processor' AND bridge_id IS NULL)
          OR (? = 'active_with_delivery_processor' AND bridge_id IS NOT NULL AND status = 'active')
          OR (? = 'active_without_delivery_processor' AND bridge_id IS NULL AND status = 'active')
        )
    `;
    const rows = this.db.prepare(query).all(
      event.workspace_id,
      target,
      target,
      target,
      target,
      target,
      target
    ) as Array<{ endpoint_id: string }>;
    return rows
      .map((row) => row.endpoint_id)
      .filter((endpointId) => !(destination.exclude_source && endpointId === event.source_endpoint_id));
  }

  private queueEvent(
    eventId: string,
    workspaceId: string,
    destinationEndpointId: string,
    route?: {
      state?: "held" | "queued";
      scope_execution_id: string;
      composition_revision_id: string;
      source_node_id: string | null;
      source_port_id: string | null;
      target_node_id: string;
      target_port_id: string | null;
      edge_id: string | null;
      node_execution_id: string;
      output_publication_id: string | null;
    },
  ): string {
    const queueId = `q_${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO event_queue (
        queue_id, event_id, workspace_id, destination_endpoint_id, state, created_at,
        scope_execution_id, composition_revision_id, source_node_id, source_port_id,
        target_node_id, target_port_id, edge_id, node_execution_id, output_publication_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      queueId,
      eventId,
      workspaceId,
      destinationEndpointId,
      route?.state ?? "queued",
      now(),
      route?.scope_execution_id ?? null,
      route?.composition_revision_id ?? null,
      route?.source_node_id ?? null,
      route?.source_port_id ?? null,
      route?.target_node_id ?? null,
      route?.target_port_id ?? null,
      route?.edge_id ?? null,
      route?.node_execution_id ?? null,
      route?.output_publication_id ?? null,
    );
    if ((route?.state ?? "queued") === "queued") {
      this.db.prepare(`
        UPDATE endpoints
        SET status = CASE WHEN status IN ('active', 'runtime_unconfigured') THEN status ELSE 'queued' END,
            updated_at = ?
        WHERE endpoint_id = ?
      `).run(now(), destinationEndpointId);
    }
    return queueId;
  }

  private createPendingResponse(event: EventEnvelope): void {
    const pending = {
      pending_id: `pr_${randomUUID()}`,
      workspace_id: event.workspace_id,
      waiting_endpoint_id: event.source_endpoint_id,
      source_event_id: event.event_id,
      mode: event.response.mode ?? "open",
      thread_id: event.thread_id,
      correlation_id: event.response.correlation_id ?? event.correlation_id,
      timeout_at: event.response.timeout_at ?? null,
      status: "pending",
      created_at: now(),
      resolved_at: null as string | null
    };
    this.db.prepare(`
      INSERT INTO pending_responses (
        pending_id, workspace_id, waiting_endpoint_id, source_event_id, mode, thread_id,
        correlation_id, timeout_at, status, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pending.pending_id,
      pending.workspace_id,
      pending.waiting_endpoint_id,
      pending.source_event_id,
      pending.mode,
      pending.thread_id,
      pending.correlation_id,
      pending.timeout_at,
      pending.status,
      pending.created_at,
      pending.resolved_at
    );
  }

  private resolvePendingResponsesForIncoming(incoming: EventEnvelope): void {
    const rows = this.db.prepare(`
      SELECT pr.*, e.destination_json AS request_destination_json
      FROM pending_responses pr
      JOIN events e ON e.event_id = pr.source_event_id
      WHERE pr.waiting_endpoint_id = ? AND pr.status = 'pending'
      ORDER BY pr.created_at ASC
    `).all(incoming.destination_json.kind === "endpoint" ? incoming.destination_json.endpoint_id : "") as any[];
    for (const pending of rows) {
      if (pending.mode === "thread_affine" && pending.thread_id !== incoming.thread_id) continue;
      if (pending.mode === "correlated") {
        const incomingCorrelation = incoming.correlation_id ?? null;
        if (!pending.correlation_id || incomingCorrelation !== pending.correlation_id) continue;
        const requestedDestination = parseJson<DestinationSelector>(pending.request_destination_json);
        if (
          requestedDestination.kind !== "endpoint" ||
          incoming.source_endpoint_id !== requestedDestination.endpoint_id
        ) continue;
      }
      this.db.prepare("UPDATE pending_responses SET status = 'resolved', resolved_at = ? WHERE pending_id = ?")
        .run(now(), pending.pending_id);
    }
  }

  private tryCreateDeliveryForEndpoint(endpointId: string, broadcast: Broadcast): DeliveryBundle | null {
    const endpoint = this.getEndpoint(endpointId);
    const commandWorker = this.commandWorkerBindingStore.getByEndpoint(endpointId);
    if (!endpoint || (!endpoint.bridge_id && !commandWorker)) return null;
    if (commandWorker && (commandWorker.status !== "available"
      || commandWorker.workspace_id !== endpoint.workspace_id)) return null;
    const restoreHold = this.db.prepare(`
      SELECT 1 AS held FROM workspace_restore_holds WHERE workspace_id = ? AND state = 'held'
    `).get(endpoint.workspace_id);
    if (restoreHold) return null;
    if (endpoint.status === "active" || endpoint.status === "error" || endpoint.status === "runtime_unconfigured") return null;

    const firstQueued = this.db.prepare(`
      SELECT q.*, e.*
      FROM event_queue q
      JOIN events e ON e.event_id = q.event_id
      WHERE q.destination_endpoint_id = ?
        AND q.state = 'queued'
      ORDER BY q.created_at ASC
      LIMIT 1
    `).get(endpointId) as any;
    const queuedRows = !firstQueued
      ? []
      : firstQueued.node_execution_id
        ? this.db.prepare(`
            SELECT q.*, e.*
            FROM event_queue q
            JOIN events e ON e.event_id = q.event_id
            WHERE q.destination_endpoint_id = ?
              AND q.node_execution_id = ?
              AND q.state = 'queued'
            ORDER BY q.created_at ASC
          `).all(endpointId, firstQueued.node_execution_id) as any[]
        : [firstQueued];
    if (queuedRows.length === 0) return null;

    const deliveredAt = now();
    const deliveryId = `del_${randomUUID()}`;
    const leaseExpiresAt = this.deliveryLeaseExpiresAt();
    const deliveryAttempt = Math.max(...queuedRows.map((row) => Number(row.attempt_count ?? 0) + 1));
    const runtimePins = this.resolveDeliveryRuntimePins(firstQueued, endpointId, endpoint.workspace_id);
    for (const row of queuedRows) {
      this.db.prepare(`
        UPDATE event_queue
        SET state = 'reserved',
          delivery_id = ?,
          lease_expires_at = ?,
          attempt_count = attempt_count + 1,
          last_error = NULL,
          actor_definition_revision_id = ?,
          runtime_profile_revision_id = ?,
          actor_runtime_binding_id = ?
        WHERE queue_id = ? AND state = 'queued'
      `).run(
        deliveryId,
        leaseExpiresAt,
        runtimePins.actor_definition_revision_id,
        runtimePins.runtime_profile_revision_id,
        runtimePins.actor_runtime_binding_id,
        row.queue_id,
      );
    }
    const events = queuedRows.map((row) => this.rowToEvent(row));
    const deliveryContextId = firstQueued.node_execution_id
      ? this.scopeExecutionStore.getNodeExecution(String(firstQueued.node_execution_id))?.context_id ?? null
      : events[0]?.context_id ?? null;
    const bundle: DeliveryBundle = {
      delivery_id: deliveryId,
      stable_delivery_ids: queuedRows.map((row) => String(row.queue_id)),
      endpoint_id: endpointId,
      workspace_id: endpoint.workspace_id,
      trigger_event_id: events[0].event_id,
      events,
      delivered_at: deliveredAt,
      scope_execution_id: firstQueued.scope_execution_id ?? null,
      composition_revision_id: firstQueued.composition_revision_id ?? null,
      node_execution_id: firstQueued.node_execution_id ?? null,
      target_node_id: firstQueued.target_node_id ?? null,
      target_port_ids: queuedRows.map((row) => String(row.target_port_id ?? "")).filter(Boolean),
      context_id: deliveryContextId,
      execution_attempt_id: null,
      ...runtimePins,
      operation_authority_session_id: null,
      node_contract: this.resolveDeliveryNodeContract(
        firstQueued.composition_revision_id ?? null,
        firstQueued.target_node_id ?? null,
      ),
    };
    this.db.prepare(`
      INSERT INTO delivery_bundles (
        delivery_id, wait_id, endpoint_id, workspace_id, resume_reason, trigger_event_id,
        events_json, stable_delivery_ids_json, state, lease_expires_at, attempt_count, created_at,
        actor_definition_revision_id, runtime_profile_revision_id, actor_runtime_binding_id,
        command_definition_revision_id, command_worker_binding_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bundle.delivery_id,
      null,
      bundle.endpoint_id,
      bundle.workspace_id,
      "event",
      bundle.trigger_event_id,
      json(bundle.events),
      json(bundle.stable_delivery_ids),
      leaseExpiresAt,
      deliveryAttempt,
      bundle.delivered_at,
      bundle.actor_definition_revision_id,
      bundle.runtime_profile_revision_id,
      bundle.actor_runtime_binding_id,
      bundle.command_definition_revision_id,
      bundle.command_worker_binding_id,
    );
    this.db.prepare("UPDATE endpoints SET status = 'active', updated_at = ? WHERE endpoint_id = ?")
      .run(now(), endpointId);
    broadcast("delivery_bundle_available", { delivery: bundle });
    if (commandWorker) {
      queueMicrotask(() => {
        if (!this.closed) void this.executeCanonicalCommandDelivery(bundle.delivery_id, broadcast);
      });
    }
    // Schedule the lease-expiry check so this bundle's lease is covered (D5).
    this.scheduleNextLeaseExpiryCheck();
    return bundle;
  }

  /**
   * Executes one reserved Command Delivery inside the native Command host. The
   * existing Delivery/NodeExecution/ExecutionAttempt ledger remains the only
   * queue and lifecycle record; the host receives one immutable persisted
   * processing contract and can return values only for the pinned output Ports.
   */
  private async executeCanonicalCommandDelivery(deliveryId: string, broadcast: Broadcast): Promise<void> {
    if (this.closed) return;
    let deliveryRow = this.db.prepare(`SELECT * FROM delivery_bundles WHERE delivery_id = ?`)
      .get(deliveryId) as any;
    if (!deliveryRow || deliveryRow.state !== "reserved") return;
    let canonical = this.rowToDelivery(deliveryRow);
    if (!canonical.node_execution_id || !canonical.composition_revision_id
      || !canonical.command_definition_revision_id || !canonical.command_worker_binding_id) {
      this.failCommandDelivery(
        deliveryRow,
        "failed",
        "command_delivery_contract_incomplete",
        "The Command Delivery has no exact Command execution pins.",
        broadcast,
      );
      return;
    }
    const nodeExecution = this.scopeExecutionStore.getNodeExecution(canonical.node_execution_id);
    const scopeExecution = nodeExecution
      ? this.scopeExecutionStore.getExecution(nodeExecution.execution_id)
      : null;
    const revision = this.scopeCompositionStore.getRevision(canonical.composition_revision_id);
    const placement = revision?.nodes.find((node) => node.node_id === canonical.target_node_id);
    const definition = this.commandDefinitionStore.getRevision(canonical.command_definition_revision_id);
    const command = definition ? this.commandDefinitionStore.getCommand(definition.command_id) : null;
    const worker = this.commandWorkerBindingStore.get(canonical.command_worker_binding_id);
    if (!nodeExecution || !scopeExecution || !revision || !placement || placement.kind !== "command"
      || !definition || !command || !worker
      || scopeExecution.workspace_id !== canonical.workspace_id
      || nodeExecution.command_definition_revision_id !== definition.command_definition_revision_id
      || nodeExecution.command_worker_binding_id !== worker.command_worker_binding_id
      || worker.worker_endpoint_id !== canonical.endpoint_id
      || worker.worker_principal_id === command.command_id) {
      this.failCommandDelivery(
        deliveryRow,
        "failed",
        "command_delivery_identity_invalid",
        "The Command Delivery does not match its pinned Command, worker, or execution identity.",
        broadcast,
      );
      return;
    }

    let attempt: ExecutionAttemptRecord;
    try {
      attempt = this.scopeExecutionStore.startAttempt({
        node_execution_id: nodeExecution.node_execution_id,
        delivery_ids: canonical.stable_delivery_ids,
        delivery_bundle_id: canonical.delivery_id,
        status: "pending",
        runtime: {
          host_kind: "isolated_command_host",
          host_id: worker.host_id,
          worker_endpoint_id: worker.worker_endpoint_id,
          command_definition_revision_id: definition.command_definition_revision_id,
        },
      });
      if (attempt.status === "pending") {
        attempt = this.scopeExecutionStore.beginAttempt({
          attempt_id: attempt.attempt_id,
          runtime: { started_by: "native_command_dispatch" },
        });
      }
      const leaseExpiresAt = new Date(Date.now() + definition.content.timeout_ms + 5_000).toISOString();
      this.transaction(() => {
        this.db.prepare(`
          UPDATE delivery_bundles
          SET state = 'injected_to_runtime', execution_attempt_id = ?, lease_expires_at = ?, last_error = NULL
          WHERE delivery_id = ? AND state = 'reserved'
        `).run(attempt.attempt_id, leaseExpiresAt, canonical.delivery_id);
        this.db.prepare(`
          UPDATE event_queue SET state = 'injected_to_runtime', lease_expires_at = ?, last_error = NULL
          WHERE delivery_id = ? AND state = 'reserved'
        `).run(leaseExpiresAt, canonical.delivery_id);
      });
      deliveryRow = this.db.prepare(`SELECT * FROM delivery_bundles WHERE delivery_id = ?`)
        .get(deliveryId) as any;
      canonical = this.rowToDelivery(deliveryRow);

      const inputEvidence = this.commandInputEvidence(nodeExecution, revision);
      const args = this.commandArguments(inputEvidence, revision, placement);
      const validator = new AjvOperationSchemaValidator();
      const inputValidation = validator.validate(definition.content.input.schema, args);
      if (!inputValidation.valid) {
        throw new CommandRuntimeContractError(
          `input did not match Command definition '${definition.command_definition_revision_id}'`,
        );
      }
      const outputGrantId = this.ensureCommandOutputGrant(
        worker,
        nodeExecution,
        definition,
        new Date(Date.now() + definition.content.timeout_ms + 60_000).toISOString(),
      );
      const timeoutAt = new Date(Date.now() + definition.content.timeout_ms).toISOString();
      const contract = this.commandProcessingContracts.persist({
        contract_kind: "command_node",
        contract_version: 1,
        processing_contract_id: `command_processing_${attempt.attempt_id}`,
        workspace_id: canonical.workspace_id,
        scope_execution: scopeExecution,
        node_execution: nodeExecution,
        execution_attempt: attempt,
        placement,
        command: { identity: command, definition },
        worker,
        context: {
          context_id: nodeExecution.context_id,
          inspect_operation_id: "context.inspect",
        },
        operation_authority: {
          principal_id: worker.worker_principal_id,
          capability_grant_ids: [...new Set([...(placement.capability_grant_ids ?? []), outputGrantId])].sort(),
        },
        arguments: args,
        input: inputEvidence,
        outputs: {
          publish_operation_id: PUBLISH_SCOPE_OUTPUT_OPERATION_ID,
          ports: revision.ports.filter((port) =>
            port.node_id === placement.node_id && port.direction === "output"
          ),
        },
        idempotency_key: this.commandIdempotencyKey(nodeExecution, definition, inputEvidence),
        timeout_at: timeoutAt,
      });
      const implementation = resolveCommandImplementation(definition, canonical.workspace_id, this.extensionStore);
      const invocation = { definition, implementation, contract } as const;
      if (!this.commandRuntimeHost.supports(invocation)) {
        throw new CommandRuntimeContractError("the isolated Command host cannot run this exact implementation");
      }
      broadcast("command_execution_started", {
        delivery_id: canonical.delivery_id,
        node_execution_id: nodeExecution.node_execution_id,
        attempt_id: attempt.attempt_id,
        command_id: command.command_id,
        command_definition_revision_id: definition.command_definition_revision_id,
        worker_endpoint_id: worker.worker_endpoint_id,
      });
      const result = await this.commandRuntimeHost.invoke(invocation);
      await this.acceptCommandHostResult({
        result,
        contract,
        definition,
        worker,
        node_execution: nodeExecution,
        scope_execution: scopeExecution,
        revision,
        delivery: canonical,
        broadcast,
      });
      this.scopeExecutionStore.finishAttempt({
        attempt_id: attempt.attempt_id,
        status: "completed",
        resource_use: { ...(result.resource_use ?? {}) },
        result: {
          output_port_ids: Object.keys(result.outputs).sort(),
          external_effect_receipt_ids: [...(result.external_effect_receipt_ids ?? [])],
          evidence_refs: [...(result.evidence_refs ?? [])],
        },
      });
      this.transaction(() => {
        this.db.prepare(`
          UPDATE delivery_bundles
          SET state = 'acknowledged', lease_expires_at = NULL, last_error = NULL
          WHERE delivery_id = ?
        `).run(canonical.delivery_id);
        this.db.prepare(`
          UPDATE event_queue
          SET state = 'acknowledged', lease_expires_at = NULL, delivered_at = ?, last_error = NULL
          WHERE delivery_id = ?
        `).run(now(), canonical.delivery_id);
      });
      broadcast("delivery_acknowledged", {
        delivery_id: canonical.delivery_id,
        endpoint_id: canonical.endpoint_id,
      });
      broadcast("command_execution_completed", {
        delivery_id: canonical.delivery_id,
        node_execution_id: nodeExecution.node_execution_id,
        attempt_id: attempt.attempt_id,
      });
      this.updateEndpointStatus(canonical.endpoint_id, "idle", broadcast);
    } catch (error) {
      if (this.closed) return;
      const current = this.db.prepare(`SELECT * FROM delivery_bundles WHERE delivery_id = ?`)
        .get(deliveryId) as any;
      if (!current || ["acknowledged", "cancelled", "dead_lettered"].includes(current.state)) return;
      const code = typeof (error as { code?: unknown }).code === "string"
        ? String((error as { code: string }).code)
        : "command_execution_failed";
      const message = error instanceof Error ? error.message : String(error);
      const external = definition.content.side_effects.some((effect) => effect.external);
      const status = code === "command_cancelled"
        ? "cancelled" as const
        : external
          ? "outcome_unknown" as const
          : "failed" as const;
      this.failCommandDelivery(current, status, code, message, broadcast);
    }
  }

  private commandInputEvidence(
    nodeExecution: NodeExecutionRecord,
    revision: ScopeCompositionRevision,
  ): CommandProcessingContract["input"] {
    const portNames = new Map(revision.ports
      .filter((port) => port.node_id === nodeExecution.node_id && port.direction === "input")
      .map((port) => [port.port_id, port.name]));
    const grouped: Record<string, Array<CommandProcessingContract["input"][string][number]>> = {};
    for (const input of this.scopeExecutionStore.listReceivedInputs(nodeExecution.node_execution_id)) {
      const portName = portNames.get(input.port_id);
      if (!portName) {
        throw new CommandRuntimeContractError(`input '${input.input_id}' references an unknown pinned Port`);
      }
      const event = this.getEvent(input.event_id);
      if (!event) throw new CommandRuntimeContractError(`input Event '${input.event_id}' is unavailable`);
      (grouped[portName] ??= []).push({
        input_id: input.input_id,
        delivery_id: input.delivery_id,
        member_key: input.member_key,
        event: {
          event_id: event.event_id,
          type: event.type,
          content: event.content,
          artefact_version_ids: event.artefact_version_ids,
        },
        artefact_version_id: input.artefact_version_id,
      });
    }
    return grouped;
  }

  private commandArguments(
    evidence: CommandProcessingContract["input"],
    revision: ScopeCompositionRevision,
    placement: ScopeNodePlacement,
  ): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    for (const port of revision.ports.filter((candidate) =>
      candidate.node_id === placement.node_id && candidate.direction === "input"
    )) {
      const inputs = evidence[port.name] ?? [];
      const values = inputs.map((input) => Object.prototype.hasOwnProperty.call(input.event.content, port.name)
        ? input.event.content[port.name]
        : input.event.content);
      if (values.length === 0) continue;
      args[port.name] = port.max_count === 1 || port.max_count === undefined ? values[0] : values;
    }
    return args;
  }

  private commandIdempotencyKey(
    nodeExecution: NodeExecutionRecord,
    definition: CommandDefinitionRevision,
    input: CommandProcessingContract["input"],
  ): string {
    const inputIdentities = Object.values(input).flat()
      .map((item) => `${item.input_id}:${item.event.event_id}:${item.artefact_version_id ?? "none"}`)
      .sort();
    return `command:${createHash("sha256").update(canonicalJson({
      node_execution_id: nodeExecution.node_execution_id,
      command_definition_revision_id: definition.command_definition_revision_id,
      input_identities: inputIdentities,
    })).digest("hex")}`;
  }

  private ensureCommandOutputGrant(
    worker: CommandWorkerBindingRecord,
    nodeExecution: NodeExecutionRecord,
    definition: CommandDefinitionRevision,
    expiresAt: string,
  ): string {
    const grantId = `capgrant_command_output_${createHash("sha256")
      .update(nodeExecution.node_execution_id)
      .digest("hex").slice(0, 32)}`;
    const existing = this.capabilityGrantStore.getGrant(grantId);
    if (existing) {
      const inspection = this.capabilityGrantStore.inspectSessionGrantIds({
        principal_id: worker.worker_principal_id,
        boundary: { kind: "workspace", workspace_id: worker.workspace_id },
        grant_ids: [grantId],
      });
      if (inspection.unavailable_grants.length > 0
        || !existing.operation_ids.includes(PUBLISH_SCOPE_OUTPUT_OPERATION_ID)
        || !existing.targets.some((target) =>
          target.kind === "node_execution" && target.id === nodeExecution.node_execution_id
        )) {
        throw new CommandRuntimeContractError("the exact Command output grant is unavailable");
      }
      return grantId;
    }
    return this.capabilityGrantStore.issueGrant({
      grant_id: grantId,
      principal_id: worker.worker_principal_id,
      boundary: { kind: "workspace", workspace_id: worker.workspace_id },
      operation_ids: [PUBLISH_SCOPE_OUTPUT_OPERATION_ID],
      targets: [{ kind: "node_execution", id: nodeExecution.node_execution_id }],
      expires_at: expiresAt,
      issuer_id: `command-runtime:${worker.host_id}`,
      evidence: [{
        kind: "command_definition_revision",
        ref: definition.command_definition_revision_id,
      }],
    }).grant_id;
  }

  private async acceptCommandHostResult(input: Readonly<{
    result: CommandHostResult;
    contract: CommandProcessingContract;
    definition: CommandDefinitionRevision;
    worker: CommandWorkerBindingRecord;
    node_execution: NodeExecutionRecord;
    scope_execution: ScopeExecutionRecord;
    revision: ScopeCompositionRevision;
    delivery: DeliveryBundle;
    broadcast: Broadcast;
  }>): Promise<void> {
    const ports = input.contract.outputs.ports;
    const portsByName = new Map(ports.map((port) => [port.name, port]));
    for (const name of Object.keys(input.result.outputs)) {
      if (!portsByName.has(name)) {
        throw new CommandRuntimeContractError(`the host returned undeclared output Port '${name}'`);
      }
    }
    const aggregate: Record<string, unknown> = {};
    const publications: Array<{ port: ScopePort; value: CommandHostResult["outputs"][string][number] }> = [];
    for (const port of ports) {
      const values = input.result.outputs[port.name] ?? [];
      if (values.length > 0) {
        const semanticValues = values.map((value) => value.value ?? value.content);
        aggregate[port.name] = semanticValues.length === 1 ? semanticValues[0] : semanticValues;
        for (const value of values) publications.push({ port, value });
      }
    }
    const validation = new AjvOperationSchemaValidator().validate(input.definition.content.output.schema, aggregate);
    if (!validation.valid) {
      throw new CommandRuntimeContractError(
        `output did not match Command definition '${input.definition.command_definition_revision_id}'`,
      );
    }
    this.validateCommandExternalReceipts(input.definition, input.result, input.scope_execution.workspace_id,
      input.node_execution.node_execution_id, input.contract.execution_attempt.attempt_id);

    for (let index = 0; index < publications.length; index += 1) {
      const publication = publications[index]!;
      const currentNode = this.scopeExecutionStore.getNodeExecution(input.node_execution.node_execution_id);
      if (!currentNode) throw new CommandRuntimeContractError("the NodeExecution disappeared before output publication");
      const authority = this.capabilityGrantStore.resolveSessionAuthority({
        principal_id: input.worker.worker_principal_id,
        boundary: { kind: "workspace", workspace_id: input.scope_execution.workspace_id },
        grant_ids: input.contract.operation_authority.capability_grant_ids,
        interaction: {
          mode: "brokered",
          session_id: `command:${input.contract.execution_attempt.attempt_id}`,
          broker_id: "native-command-host:v1",
          confirmed_prompts: [],
          approval_refs: [],
        },
      }, { kind: "node_execution", id: currentNode.node_execution_id });
      if (authority.unavailable_grants.length > 0
        || !authority.authority.grants.has(PUBLISH_SCOPE_OUTPUT_OPERATION_ID)) {
        throw new CommandRuntimeContractError("the Command output authority is no longer active");
      }
      const response = await this.operationRegistry.invoke({
        authority: authority.authority,
        provenance: {
          cause_event_id: input.delivery.trigger_event_id,
          delivery_ids: input.delivery.stable_delivery_ids,
          execution_attempt_id: input.contract.execution_attempt.attempt_id,
          node_execution_id: currentNode.node_execution_id,
          scope_execution_id: input.scope_execution.execution_id,
        },
        resolve_resource: (target) => this.resolveOperationResource(target, authority.authority.boundary),
      }, {
        operation_id: PUBLISH_SCOPE_OUTPUT_OPERATION_ID,
        operation_version: "1",
        input_schema_version: "1",
        target: { kind: "node_execution", id: currentNode.node_execution_id },
        expected_resource_revision: nodeExecutionStateRevision(currentNode),
        idempotency_key: `command-output:${input.contract.execution_attempt.attempt_id}:${publication.port.port_id}:${index}`,
        input: {
          port_id: publication.port.port_id,
          ...(publication.value.event_type ? { event_type: publication.value.event_type } : {}),
          content: publication.value.content,
          lifecycle_outcome: index === publications.length - 1 ? "completed" : "waiting",
          artefact_version_ids: [...(publication.value.artefact_version_ids ?? [])],
        },
      });
      if (response.kind !== "receipt" || response.receipt.state !== "completed") {
        throw new CommandRuntimeContractError(
          response.kind === "receipt"
            ? `output publication stopped in state '${response.receipt.state}': ${response.receipt.refusal?.code ?? "unknown"} ${response.receipt.refusal?.message ?? ""}`.trim()
            : response.refusal.message,
        );
      }
    }
    if (publications.length === 0) {
      const missingRequired = ports.filter((port) => (port.min_count ?? 0) > 0);
      if (missingRequired.length > 0) {
        throw new CommandRuntimeContractError("the Command returned no required output");
      }
      this.scopeExecutionStore.setNodeExecutionStatus(input.node_execution.node_execution_id, "completed");
      this.reconcileScopeExecutionStatus(input.scope_execution.execution_id);
    }
  }

  private validateCommandExternalReceipts(
    definition: CommandDefinitionRevision,
    result: CommandHostResult,
    workspaceId: string,
    nodeExecutionId: string,
    attemptId: string,
  ): void {
    const externalEffects = definition.content.side_effects.filter((effect) => effect.external);
    const receiptIds = [...new Set(result.external_effect_receipt_ids ?? [])];
    if (externalEffects.length === 0 && receiptIds.length > 0) {
      throw new CommandRuntimeContractError("a Command with no declared external effect returned an external receipt");
    }
    if (externalEffects.length > 0 && receiptIds.length < externalEffects.length) {
      throw new CommandRuntimeContractError("the Command did not return exact receipts for every external effect");
    }
    for (const receiptId of receiptIds) {
      const receipt = this.connectorStore.getExternalEffectReceipt(receiptId);
      if (!receipt || receipt.owner.kind !== "workspace" || receipt.owner.id !== workspaceId
        || receipt.status !== "succeeded"
        || receipt.invocation_provenance.node_execution_id !== nodeExecutionId
        || receipt.invocation_provenance.execution_attempt_id !== attemptId) {
        throw new CommandRuntimeContractError(
          `external effect receipt '${receiptId}' is not a proven result of this exact attempt`,
        );
      }
    }
  }

  private failCommandDelivery(
    row: any,
    attemptStatus: "failed" | "cancelled" | "outcome_unknown",
    code: string,
    message: string,
    broadcast: Broadcast,
  ): void {
    this.transaction(() => {
      this.db.prepare(`
        UPDATE delivery_bundles
        SET state = ?, lease_expires_at = NULL, last_error = ?
        WHERE delivery_id = ? AND state NOT IN ('acknowledged', 'cancelled', 'dead_lettered')
      `).run(attemptStatus === "cancelled" ? "cancelled" : "dead_lettered", message, row.delivery_id);
      this.db.prepare(`
        UPDATE event_queue
        SET state = ?, lease_expires_at = NULL, last_error = ?
        WHERE delivery_id = ? AND state NOT IN ('acknowledged', 'cancelled', 'dead_lettered')
      `).run(attemptStatus === "cancelled" ? "cancelled" : "dead_lettered", message, row.delivery_id);
      const attempt = row.execution_attempt_id
        ? this.scopeExecutionStore.getAttempt(String(row.execution_attempt_id))
        : this.scopeExecutionStore.getAttemptForBundle(String(row.delivery_id));
      if (attempt && ["pending", "running"].includes(attempt.status)) {
        this.scopeExecutionStore.finishAttempt({
          attempt_id: attempt.attempt_id,
          status: attemptStatus,
          error: {
            code,
            message,
            safe_to_retry_automatically: attemptStatus === "failed",
          },
        });
        const node = this.scopeExecutionStore.getNodeExecution(attempt.node_execution_id);
        if (node && !["completed", "cancelled", "failed", "superseded"].includes(node.status)) {
          this.scopeExecutionStore.setNodeExecutionStatus(
            node.node_execution_id,
            attemptStatus === "cancelled" ? "cancelled" : "failed",
            { code, message, outcome_unknown: attemptStatus === "outcome_unknown" },
          );
          if (attemptStatus !== "cancelled") {
            const execution = this.scopeExecutionStore.getExecution(node.execution_id);
            if (execution && !["completed", "failed", "cancelled", "superseded"].includes(execution.status)) {
              this.scopeExecutionStore.setExecutionStatus(execution.execution_id, "failed", {
                node_execution_id: node.node_execution_id,
                attempt_id: attempt.attempt_id,
                outcome_unknown: attemptStatus === "outcome_unknown",
              });
            }
          } else {
            this.reconcileScopeExecutionStatus(node.execution_id);
          }
        }
      }
      this.db.prepare(`UPDATE endpoints SET status = ?, updated_at = ? WHERE endpoint_id = ?`)
        .run(attemptStatus === "cancelled" ? "idle" : "error", now(), row.endpoint_id);
    });
    broadcast(attemptStatus === "cancelled" ? "delivery_cancelled" : "delivery_dead_lettered", {
      delivery_id: row.delivery_id,
      endpoint_id: row.endpoint_id,
      error: message,
      code,
      outcome_unknown: attemptStatus === "outcome_unknown",
    });
    broadcast("command_execution_failed", {
      delivery_id: row.delivery_id,
      endpoint_id: row.endpoint_id,
      code,
      error: message,
      outcome_unknown: attemptStatus === "outcome_unknown",
    });
    this.scheduleNextLeaseExpiryCheck();
  }

  /**
   * One bounded startup pass. Reserved work was never started and can resume.
   * A lost non-external attempt is failed then retried with the same logical
   * idempotency key and exact Command pin. A lost external attempt remains
   * outcome-unknown and is never replayed automatically.
   */
  private recoverCanonicalCommandDeliveries(broadcast: Broadcast): void {
    if (this.closed) return;
    const rows = this.db.prepare(`
      SELECT db.* FROM delivery_bundles db
      JOIN command_worker_bindings worker ON worker.worker_endpoint_id = db.endpoint_id
      WHERE db.state IN ('reserved', 'injected_to_runtime')
      ORDER BY db.created_at, db.delivery_id
      LIMIT 100
    `).all() as any[];
    for (const row of rows) {
      if (row.state === "reserved") {
        void this.executeCanonicalCommandDelivery(String(row.delivery_id), broadcast);
        continue;
      }
      const attempt = this.scopeExecutionStore.getAttemptForBundle(String(row.delivery_id));
      const external = attempt?.command_definition_revision_id
        ? this.commandDefinitionHasExternalEffects(attempt.command_definition_revision_id)
        : true;
      this.failCommandDelivery(
        row,
        external ? "outcome_unknown" : "failed",
        "command_worker_restarted",
        external
          ? "The Command worker restarted after an external effect may have begun. The attempt was not replayed."
          : "The Command worker restarted before reporting completion.",
        broadcast,
      );
      if (!external && attempt) {
        try {
          this.retryScopeNodeExecution({
            workspace_id: row.workspace_id,
            node_execution_id: attempt.node_execution_id,
          }, broadcast);
        } catch (error) {
          broadcast("command_recovery_blocked", {
            delivery_id: row.delivery_id,
            node_execution_id: attempt.node_execution_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  private resolveDeliveryRuntimePins(
    queued: any,
    endpointId: string,
    workspaceId: string,
  ): {
    actor_definition_revision_id: string | null;
    runtime_profile_revision_id: string | null;
    actor_runtime_binding_id: string | null;
    command_definition_revision_id: string | null;
    command_worker_binding_id: string | null;
  } {
    const existing = {
      actor_definition_revision_id: queued.actor_definition_revision_id ?? null,
      runtime_profile_revision_id: queued.runtime_profile_revision_id ?? null,
      actor_runtime_binding_id: queued.actor_runtime_binding_id ?? null,
      command_definition_revision_id: null as string | null,
      command_worker_binding_id: null as string | null,
    };
    const existingActorCount = [
      existing.actor_definition_revision_id,
      existing.runtime_profile_revision_id,
      existing.actor_runtime_binding_id,
    ].filter(Boolean).length;
    if (existingActorCount === 3) return existing;
    if (existingActorCount !== 0) {
      throw new Error(`Queued Delivery for '${endpointId}' has incomplete Actor/runtime pins.`);
    }

    if (queued.node_execution_id) {
      const node = this.scopeExecutionStore.getNodeExecution(String(queued.node_execution_id));
      if (!node) throw new Error(`NodeExecution '${queued.node_execution_id}' does not exist.`);
      return {
        actor_definition_revision_id: node.actor_definition_revision_id,
        runtime_profile_revision_id: node.runtime_profile_revision_id,
        actor_runtime_binding_id: node.actor_runtime_binding_id,
        command_definition_revision_id: node.command_definition_revision_id,
        command_worker_binding_id: node.command_worker_binding_id,
      };
    }

    const binding = this.runtimeProfileStore.getCurrentActorBindingForEndpoint(workspaceId, endpointId)
      ?? this.runtimeProfileStore.getCurrentActorBinding(endpointId);
    if (!binding || binding.workspace_id !== workspaceId || binding.status !== "resolved") {
      return existing;
    }
    const actor = this.actorDefinitionStore.getActor(binding.actor_id);
    const definition = actor?.current_definition_revision_id
      ? this.actorDefinitionStore.getRevision(actor.current_definition_revision_id)
      : null;
    const profile = this.runtimeProfileStore.getRevision(binding.runtime_profile_revision_id);
    if (!actor || actor.workspace_id !== workspaceId || actor.status !== "active"
      || !definition?.published_at || definition.withdrawn_at
      || !profile?.published_at || profile.withdrawn_at) {
      return existing;
    }
    return {
      actor_definition_revision_id: definition.actor_definition_revision_id,
      runtime_profile_revision_id: profile.runtime_profile_revision_id,
      actor_runtime_binding_id: binding.actor_runtime_binding_id,
      command_definition_revision_id: null,
      command_worker_binding_id: null,
    };
  }

  private deliveryLeaseExpiresAt(): string {
    return new Date(Date.now() + 30_000).toISOString();
  }

  /**
   * Once a bridge has injected a delivery, the lease covers the runtime turn,
   * not merely transport to the bridge. Official provider turns can take
   * minutes; the longest in-process runtime timeout is ten minutes.
   */
  private runtimeTurnLeaseExpiresAt(): string {
    return new Date(Date.now() + 15 * 60_000).toISOString();
  }

  /**
   * Runtime activity is the ownership signal. Renew from pushed telemetry
   * rather than adding a polling heartbeat to the substrate.
   */
  private renewRuntimeDeliveryLease(deliveryId: string, broadcast: Broadcast): void {
    const delivery = this.db.prepare("SELECT state FROM delivery_bundles WHERE delivery_id = ?")
      .get(deliveryId) as { state: string } | undefined;
    if (delivery?.state !== "injected_to_runtime") return;
    const leaseExpiresAt = this.runtimeTurnLeaseExpiresAt();
    this.db.prepare("UPDATE delivery_bundles SET lease_expires_at = ? WHERE delivery_id = ? AND state = 'injected_to_runtime'")
      .run(leaseExpiresAt, deliveryId);
    this.db.prepare("UPDATE event_queue SET lease_expires_at = ? WHERE delivery_id = ? AND state = 'injected_to_runtime'")
      .run(leaseExpiresAt, deliveryId);
    broadcast("delivery_lease_renewed", { delivery_id: deliveryId, lease_expires_at: leaseExpiresAt });
    this.scheduleNextLeaseExpiryCheck();
  }

  /**
   * Once a turn has entered a runtime it may have produced effects. Losing its
   * owner is therefore an ambiguous terminal failure, never a retry signal.
   */
  private failUnknownRuntimeDelivery(delivery: any, reason: string, broadcast: Broadcast): void {
    const current = this.db.prepare("SELECT * FROM delivery_bundles WHERE delivery_id = ?")
      .get(delivery.delivery_id) as any;
    if (!current || current.state !== "injected_to_runtime") return;

    this.transaction(() => {
      this.db.prepare(`
        UPDATE delivery_bundles
        SET state = 'dead_lettered', lease_expires_at = NULL, last_error = ?
        WHERE delivery_id = ? AND state = 'injected_to_runtime'
      `).run(reason, current.delivery_id);
      this.db.prepare(`
        UPDATE event_queue
        SET state = 'dead_lettered', lease_expires_at = NULL, last_error = ?
        WHERE delivery_id = ?
      `).run(reason, current.delivery_id);
      this.db.prepare("UPDATE endpoints SET status = 'error', updated_at = ? WHERE endpoint_id = ?")
        .run(now(), current.endpoint_id);
      this.finishCanonicalAttempt(current, "outcome_unknown", reason);
    });

    broadcast("delivery_dead_lettered", {
      delivery_id: current.delivery_id,
      endpoint_id: current.endpoint_id,
      error: reason,
      outcome_unknown: true
    });
    broadcast("status_changed", { endpoint: this.getEndpoint(current.endpoint_id) });
    this.recordRuntimeTurnResult({
      delivery_id: current.delivery_id,
      outcome: "failed",
      text: "Work stopped because its runtime session ended before Floe received a durable completion. It was not retried automatically because the turn may already have changed the workspace. Review the recorded work before retrying.",
      metadata: {
        origin: "runtime_ownership_lost",
        reason,
        outcome_unknown: true,
        safe_to_retry_automatically: false
      }
    }, broadcast);
  }

  private requeueExpiredDeliveryLeases(broadcast: Broadcast): void {
    const timestamp = now();
    const expired = this.db.prepare(`
      SELECT * FROM delivery_bundles
      WHERE state IN ('reserved', 'delivered_to_bridge', 'injected_to_runtime')
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= ?
      LIMIT 100
    `).all(timestamp) as any[];
    for (const row of expired) {
      if (row.state === "injected_to_runtime") {
        const commandWorker = this.commandWorkerBindingStore.getByEndpoint(String(row.endpoint_id));
        if (commandWorker) {
          const attempt = this.scopeExecutionStore.getAttemptForBundle(String(row.delivery_id));
          if (attempt) this.commandRuntimeHost.cancel(attempt.attempt_id);
          const external = attempt?.command_definition_revision_id
            ? this.commandDefinitionHasExternalEffects(attempt.command_definition_revision_id)
            : true;
          this.failCommandDelivery(
            row,
            external ? "outcome_unknown" : "failed",
            "command_delivery_lease_expired",
            external
              ? "The Command stopped reporting after an external effect may have begun. It was not replayed."
              : "The isolated Command worker stopped reporting before completion.",
            broadcast,
          );
          if (!external && attempt) {
            try {
              this.retryScopeNodeExecution({
                workspace_id: row.workspace_id,
                node_execution_id: attempt.node_execution_id,
              }, broadcast);
            } catch (error) {
              broadcast("command_recovery_blocked", {
                delivery_id: row.delivery_id,
                node_execution_id: attempt.node_execution_id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          continue;
        }
        this.failUnknownRuntimeDelivery(row, "runtime turn stopped reporting activity before its lease expired", broadcast);
        continue;
      }
      const attempts = Number(row.attempt_count ?? 1);
      const queueState = attempts >= 3 ? "dead_lettered" : "queued";
      const bundleState = attempts >= 3 ? "dead_lettered" : "failed";
      this.db.prepare("UPDATE delivery_bundles SET state = ?, last_error = ? WHERE delivery_id = ?")
        .run(bundleState, "delivery lease expired", row.delivery_id);
      this.db.prepare(`
        UPDATE event_queue
        SET state = ?, delivery_id = CASE WHEN ? = 'queued' THEN NULL ELSE delivery_id END,
          lease_expires_at = NULL, last_error = ?
        WHERE delivery_id = ?
      `).run(queueState, queueState, "delivery lease expired", row.delivery_id);
      broadcast(bundleState === "dead_lettered" ? "delivery_dead_lettered" : "delivery_failed", {
        delivery_id: row.delivery_id,
        error: "delivery lease expired"
      });
      if (queueState === "queued") {
        // Reset the endpoint to idle so the requeued events are immediately re-delivered.
        // updateEndpointStatus("idle") internally calls tryCreateDeliveryForEndpoint.
        this.updateEndpointStatus(row.endpoint_id, "idle", broadcast);
      }
    }
    // After requeue, reschedule for any remaining active leases.
    this.scheduleNextLeaseExpiryCheck();
  }

  /**
   * Schedule a single-shot timer to fire at the earliest active lease-expiry time.
   * When the timer fires it calls requeueExpiredDeliveryLeases and reschedules.
   * This is NOT a recurring poll — it fires exactly once at the next deadline (D5).
   */
  private scheduleNextLeaseExpiryCheck(): void {
    // Clear any existing timer before rescheduLing.
    if (this.leaseExpiryTimer !== null) {
      clearTimeout(this.leaseExpiryTimer);
      this.leaseExpiryTimer = null;
    }
    if (!this.broadcastFn) return; // broadcast not yet injected

    const row = this.db.prepare(`
      SELECT MIN(lease_expires_at) AS next_expiry
      FROM delivery_bundles
      WHERE state IN ('reserved', 'delivered_to_bridge', 'injected_to_runtime')
        AND lease_expires_at IS NOT NULL
    `).get() as { next_expiry: string | null };

    if (!row.next_expiry) return; // no active leases — nothing to schedule

    const delay = Math.max(0, Date.parse(row.next_expiry) - Date.now());
    const broadcast = this.broadcastFn;
    this.leaseExpiryTimer = setTimeout(() => {
      this.leaseExpiryTimer = null;
      this.requeueExpiredDeliveryLeases(broadcast);
      // requeueExpiredDeliveryLeases calls scheduleNextLeaseExpiryCheck() at the end
    }, delay);
  }

  private rowToEvent(row: any): EventEnvelope {
    return {
      event_id: row.event_id,
      type: row.type,
      workspace_id: row.workspace_id,
      source_endpoint_id: row.source_endpoint_id,
      thread_id: row.thread_id,
      context_id: row.context_id ?? row.thread_id,
      scope_id: row.scope_id ?? null,
      correlation_id: row.correlation_id ?? null,
      destination_json: parseJson<DestinationSelector>(row.destination_json),
      content: parseJson<Record<string, unknown>>(row.content_json),
      response: parseJson<ResponseExpectation>(row.response_json),
      metadata: parseJson<Record<string, unknown>>(row.metadata_json),
      artefact_version_ids: parseJson<string[]>(row.artefact_version_ids_json),
      created_at: row.created_at
    };
  }

  private rowToDelivery(row: any): DeliveryBundle {
    const events = parseJson<EventEnvelope[]>(row.events_json);
    const stableDeliveryIds = parseJson<string[]>(row.stable_delivery_ids_json ?? "[]");
    const firstStable = stableDeliveryIds.length > 0
      ? this.db.prepare(`SELECT * FROM event_queue WHERE queue_id = ?`).get(stableDeliveryIds[0]) as any
      : null;
    const nodeExecutionId = firstStable?.node_execution_id ?? null;
    const contextId = nodeExecutionId
      ? this.scopeExecutionStore.getNodeExecution(String(nodeExecutionId))?.context_id ?? null
      : events[0]?.context_id ?? null;
    const actorDefinitionRevisionId = row.actor_definition_revision_id
      ?? firstStable?.actor_definition_revision_id
      ?? null;
    const runtimeProfileRevisionId = row.runtime_profile_revision_id
      ?? firstStable?.runtime_profile_revision_id
      ?? null;
    const actorRuntimeBindingId = row.actor_runtime_binding_id
      ?? firstStable?.actor_runtime_binding_id
      ?? null;
    return {
      delivery_id: row.delivery_id,
      stable_delivery_ids: stableDeliveryIds,
      endpoint_id: row.endpoint_id,
      workspace_id: row.workspace_id,
      trigger_event_id: row.trigger_event_id,
      events,
      delivered_at: row.created_at,
      scope_execution_id: firstStable?.scope_execution_id ?? null,
      composition_revision_id: firstStable?.composition_revision_id ?? null,
      node_execution_id: nodeExecutionId,
      target_node_id: firstStable?.target_node_id ?? null,
      target_port_ids: stableDeliveryIds
        .map((id) => this.db.prepare(`SELECT target_port_id FROM event_queue WHERE queue_id = ?`).get(id) as any)
        .map((item) => String(item?.target_port_id ?? ""))
        .filter(Boolean),
      context_id: contextId,
      execution_attempt_id: row.execution_attempt_id ?? null,
      actor_definition_revision_id: actorDefinitionRevisionId,
      runtime_profile_revision_id: runtimeProfileRevisionId,
      actor_runtime_binding_id: actorRuntimeBindingId,
      command_definition_revision_id: row.command_definition_revision_id
        ?? (nodeExecutionId
          ? this.scopeExecutionStore.getNodeExecution(String(nodeExecutionId))?.command_definition_revision_id ?? null
          : null),
      command_worker_binding_id: row.command_worker_binding_id
        ?? (nodeExecutionId
          ? this.scopeExecutionStore.getNodeExecution(String(nodeExecutionId))?.command_worker_binding_id ?? null
          : null),
      operation_authority_session_id: row.operation_authority_session_id ?? null,
      node_contract: this.resolveDeliveryNodeContract(
        firstStable?.composition_revision_id ?? null,
        firstStable?.target_node_id ?? null,
      ),
    };
  }

  private resolveDirectRuntimeProcessingContract(delivery: DeliveryBundle): RuntimeDispatchContract {
    if (delivery.node_execution_id) {
      throw new Error(`Delivery '${delivery.delivery_id}' is not direct Context work.`);
    }
    if (!delivery.context_id
      || !delivery.actor_definition_revision_id
      || !delivery.runtime_profile_revision_id
      || !delivery.actor_runtime_binding_id) {
      throw new Error(`Delivery '${delivery.delivery_id}' has incomplete direct Actor/runtime pins.`);
    }
    return this.runtimeProcessingContracts.resolveDirect({
      delivery_id: delivery.delivery_id,
      stable_delivery_ids: delivery.stable_delivery_ids,
      endpoint_id: delivery.endpoint_id,
      workspace_id: delivery.workspace_id,
      context_id: delivery.context_id,
      actor_definition_revision_id: delivery.actor_definition_revision_id,
      runtime_profile_revision_id: delivery.runtime_profile_revision_id,
      actor_runtime_binding_id: delivery.actor_runtime_binding_id,
      events: delivery.events,
    });
  }

  private resolveDeliveryNodeContract(
    revisionId: string | null,
    nodeId: string | null,
  ): DeliveryBundle["node_contract"] {
    if (!revisionId || !nodeId) return null;
    const revision = this.scopeCompositionStore.getRevision(revisionId);
    const node = revision?.nodes.find((candidate) => candidate.node_id === nodeId);
    if (!revision || !node) return null;
    return {
      node,
      input_ports: revision.ports.filter((port) => port.node_id === nodeId && port.direction === "input"),
      output_ports: revision.ports.filter((port) => port.node_id === nodeId && port.direction === "output"),
    };
  }

  private failInjectedRuntimeDelivery(delivery: any, reason: string, broadcast: Broadcast): unknown {
    this.transaction(() => {
      this.db.prepare(`
        UPDATE delivery_bundles
        SET state = 'failed', lease_expires_at = NULL, last_error = ?
        WHERE delivery_id = ? AND state = 'injected_to_runtime'
      `).run(reason, delivery.delivery_id);
      this.db.prepare(`
        UPDATE event_queue
        SET state = 'dead_lettered', lease_expires_at = NULL, last_error = ?
        WHERE delivery_id = ?
      `).run(reason, delivery.delivery_id);
      this.finishCanonicalAttempt(delivery, "failed", reason);
      this.db.prepare("UPDATE endpoints SET status = 'error', updated_at = ? WHERE endpoint_id = ?")
        .run(now(), delivery.endpoint_id);
    });
    broadcast("delivery_failed", {
      delivery_id: delivery.delivery_id,
      endpoint_id: delivery.endpoint_id,
      error: reason,
      safe_to_retry_automatically: false,
    });
    broadcast("status_changed", { endpoint: this.getEndpoint(delivery.endpoint_id) });
    this.scheduleNextLeaseExpiryCheck();
    return this.db.prepare("SELECT * FROM delivery_bundles WHERE delivery_id = ?").get(delivery.delivery_id);
  }

  private finishCanonicalAttempt(
    delivery: any,
    status: "completed" | "failed" | "cancelled" | "outcome_unknown",
    reason: string | null,
  ): void {
    const attemptId = delivery.execution_attempt_id
      ?? this.scopeExecutionStore.getAttemptForBundle(String(delivery.delivery_id))?.attempt_id
      ?? null;
    if (!attemptId) return;
    const attempt = this.scopeExecutionStore.getAttempt(String(attemptId));
    if (!attempt || !["pending", "running"].includes(attempt.status)) return;
    this.scopeExecutionStore.finishAttempt({
      attempt_id: attempt.attempt_id,
      status,
      ...(reason ? { error: { message: reason } } : {}),
    });
    const node = this.scopeExecutionStore.getNodeExecution(attempt.node_execution_id);
    if (!node) return;
    if (status === "failed" || status === "outcome_unknown") {
      this.scopeExecutionStore.setNodeExecutionStatus(node.node_execution_id, "failed", {
        code: status === "outcome_unknown" ? "runtime_outcome_unknown" : "runtime_failed",
        message: reason,
        safe_to_retry_automatically: false,
      });
      this.scopeExecutionStore.setExecutionStatus(node.execution_id, "failed", {
        node_execution_id: node.node_execution_id,
        attempt_id: attempt.attempt_id,
        outcome_unknown: status === "outcome_unknown",
      });
      return;
    }
    if (status === "cancelled") {
      this.scopeExecutionStore.setNodeExecutionStatus(node.node_execution_id, "cancelled");
      this.reconcileScopeExecutionStatus(node.execution_id);
      return;
    }
    this.settleCanonicalNodeAfterAttempt(node);
    this.reconcileScopeExecutionStatus(node.execution_id);
  }

  private settleCanonicalNodeAfterAttempt(node: NodeExecutionRecord): void {
    const current = this.scopeExecutionStore.getNodeExecution(node.node_execution_id);
    if (!current || ["completed", "failed", "cancelled", "waiting_external", "waiting_human"].includes(current.status)) return;
    const revision = this.scopeCompositionStore.getRevision(current.revision_id);
    if (!revision) {
      this.scopeExecutionStore.setNodeExecutionStatus(current.node_execution_id, "failed", {
        code: "pinned_composition_missing",
      });
      return;
    }
    const outputPorts = revision.ports.filter((port) => port.node_id === current.node_id && port.direction === "output");
    const published = new Set((this.db.prepare(`
      SELECT port_id FROM scope_output_publications WHERE node_execution_id = ?
    `).all(current.node_execution_id) as Array<{ port_id: string }>).map((item) => String(item.port_id)));
    const missingRequired = outputPorts
      .filter((port) => (port.min_count ?? 0) > 0 && !published.has(port.port_id))
      .map((port) => port.port_id);
    if (missingRequired.length > 0) {
      this.scopeExecutionStore.setNodeExecutionStatus(current.node_execution_id, "waiting_external", {
        code: "required_output_not_published",
        required_port_ids: missingRequired,
      });
      return;
    }
    this.scopeExecutionStore.setNodeExecutionStatus(current.node_execution_id, "completed");
  }

  private reconcileScopeExecutionStatus(executionId: string): void {
    const execution = this.scopeExecutionStore.getExecution(executionId);
    if (!execution || ["completed", "failed", "cancelled", "superseded"].includes(execution.status)) return;
    const nodes = this.scopeExecutionStore.listNodeExecutions(executionId);
    if (nodes.some((node) => node.status === "failed")) {
      this.scopeExecutionStore.setExecutionStatus(executionId, "failed");
      return;
    }
    if (nodes.some((node) => node.status === "blocked")) {
      this.scopeExecutionStore.setExecutionStatus(executionId, "blocked");
      return;
    }
    if (nodes.some((node) => node.status === "waiting_human")) {
      this.scopeExecutionStore.setExecutionStatus(executionId, "waiting_human");
      return;
    }
    if (nodes.some((node) => ["collecting", "waiting_external"].includes(node.status))) {
      this.scopeExecutionStore.setExecutionStatus(executionId, "waiting_external");
      return;
    }
    if (nodes.some((node) => ["ready", "active", "retrying", "paused"].includes(node.status))) {
      this.scopeExecutionStore.setExecutionStatus(
        executionId,
        nodes.every((node) => node.status === "paused" || ["completed", "cancelled", "superseded"].includes(node.status))
          ? "paused"
          : "active",
      );
      return;
    }
    this.scopeExecutionStore.setExecutionStatus(executionId, "completed");
  }

  private rowToRuntimeBinding(row: any): RuntimeBindingRecord {
    return {
      binding_key: String(row.binding_key),
      scope: row.scope as RuntimeBindingScope,
      workspace_id: row.workspace_id ?? null,
      endpoint_id: row.endpoint_id ?? null,
      auth_profile: String(row.auth_profile),
      provider: row.provider == null ? null : String(row.provider),
      model: row.model ?? null,
      thinking_level: row.thinking_level ?? null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    };
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

/**
 * A verified legacy-retained Workspace gave every file-backed model Actor the
 * same Floe-owned runtime tools. Preserve that exact class of authority only
 * during the canonical cutover. New/copied/forked Workspaces get no implicit
 * grant. This list is closed, renewable in bounded windows, and revocable:
 * Registry growth cannot expand it and non-model Actors remain unresolved.
 */
function legacyWorkspaceConfigurationImportPolicy(
  workspaceId: string,
  creationKind: "created" | "legacy_retained" | "copied" | "forked" | null,
  inventory: WorkspaceConfigurationInventoryV1,
): WorkspaceConfigurationImportPolicy {
  const actorOperationAuthority = creationKind === "legacy_retained"
    ? inventory.actors
        .filter((actor) => actor.runtime.backing_kind === "model")
        .map((actor) => ({
          source_actor_id: actor.source_actor_id,
          operation_ids: [...LEGACY_WORKSPACE_MODEL_ACTOR_OPERATION_IDS_V1],
        }))
    : [];
  const now = new Date();
  const renewalWindow = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const expiresAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 4, 1)).toISOString();
  const instanceDigest = createHash("sha256").update(JSON.stringify({
    policy: "legacy-workspace-model-actor-authority-v1",
    workspace_id: workspaceId,
    creation_kind: creationKind,
    renewal_window: renewalWindow,
    actor_operation_authority: actorOperationAuthority,
  })).digest("hex").slice(0, 24);
  return {
    policy_revision: `legacy-workspace-model-actor-authority-v1:${renewalWindow}:${instanceDigest}`,
    actor_operation_authority: actorOperationAuthority,
    expires_at: expiresAt,
    issuer_id: "policy:legacy-workspace-model-actor-authority:v1",
    import_principal_id: "system:workspace-configuration-import",
  };
}

function runtimeBindingKey(scope: RuntimeBindingScope, workspaceId: string | null, endpointId: string | null): string {
  if (scope === "global_default") return "runtime:global:default";
  if (!workspaceId) throw new Error(`workspace_id is required for scope '${scope}'`);
  if (scope === "workspace_default") return `runtime:${workspaceId}:default`;
  if (!endpointId) throw new Error("endpoint_id is required for scope 'agent'");
  return `runtime:${workspaceId}:endpoint:${endpointId}`;
}

function credentialReferenceRevision(ref: SecretRefRecord): string {
  return `generation:${ref.generation}:${ref.resolution}`;
}

function publicCredentialReference(ref: SecretRefRecord): Omit<SecretRefRecord, "binding"> {
  const { binding: _binding, ...publicState } = ref;
  return publicState;
}

function sameTextLists(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function contextAttachmentContentPath(digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Attachment digest is invalid.");
  return `.floe/content/sha256/${digest}`;
}

function attachmentTypeRef(mediaType: string): string {
  if (mediaType.startsWith("image/")) return "core:image";
  if (mediaType === "text/markdown") return "core:markdown";
  if (mediaType === "application/json") return "core:json";
  if (mediaType.startsWith("text/")) return "core:text";
  return "core:file";
}

function assertAttachmentContentMatches(
  path: string,
  ingress: Pick<ConsumedAttachmentIngress, "digest" | "size_bytes">,
): void {
  const bytes = readFileSync(path);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== ingress.size_bytes || digest !== ingress.digest.value) {
    throw new Error(`Stored attachment content does not match digest '${ingress.digest.value}'.`);
  }
}

function deleteWorkspaceLocator(locator: string): boolean {
  const resolved = resolve(locator);
  if (!existsSync(resolved)) return false;
  const root = parse(resolved).root;
  if (resolved === root) {
    throw new Error(`Refusing to delete root path '${resolved}'.`);
  }
  rmSync(resolved, { recursive: true, force: true });
  return true;
}
