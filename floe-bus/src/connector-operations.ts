import {
  ConnectorIngressIdempotencyConflictError,
  ConnectorLifecycleConflictError,
  ConnectorNotFoundError,
  ConnectorOwnerMismatchError,
  ConnectorRevisionConflictError,
  ConnectorStore,
  ConnectorValidationError,
  ExternalActionStateError,
  connectorBindingStateRevision,
  externalEffectStateRevision,
  type ConnectorBindingContent,
  type ConnectorBindingRecord,
  type ConnectorBindingRevision,
  type ConnectorDefinitionContent,
  type ConnectorDefinitionRecord,
  type ConnectorDefinitionRevision,
  type ConnectorEvidenceRef,
  type ConnectorIngressVerification,
  type ConnectorOwner,
  type ConnectorSecretBinding,
  type ExternalEffectReceipt,
} from "./connectors.js";
import type { ApprovalStore } from "./approvals.js";
import {
  refusal,
  requiredAction,
  type JsonSchema,
  type OperationAuthorityBoundary,
  type OperationAuthorityContext,
  type OperationExecutionContext,
  type OperationHandlerOutcome,
  type OperationRefusal,
  type OperationResourceIdentity,
  type ResolvedOperationResource,
  type SemanticOperationDefinition,
  type SemanticOperationRegistry,
} from "./operations.js";

export const INSPECT_CONNECTOR_OPERATION_ID = "connector.inspect";
export const CONFIGURE_CONNECTOR_DEFINITION_OPERATION_ID = "connector.definition.configure";
export const BIND_CONNECTOR_OPERATION_ID = "connector.bind";
export const CONFIGURE_CONNECTOR_BINDING_OPERATION_ID = "connector.binding.configure";
export const ENABLE_CONNECTOR_BINDING_OPERATION_ID = "connector.binding.enable";
export const DISABLE_CONNECTOR_BINDING_OPERATION_ID = "connector.binding.disable";
export const ROTATE_CONNECTOR_BINDING_OPERATION_ID = "connector.binding.rotate";
export const RECORD_CONNECTOR_HEALTH_OPERATION_ID = "connector.health.record";
export const INGEST_CONNECTOR_OBSERVATION_OPERATION_ID = "connector.ingress.ingest";
export const REQUEST_CONNECTOR_ACTION_OPERATION_ID = "connector.action.request";
export const RECONCILE_CONNECTOR_ACTION_OPERATION_ID = "connector.action.reconcile";

const text: JsonSchema = { type: "string", minLength: 1 };
const nullableText: JsonSchema = { oneOf: [text, { type: "null" }] };
const sha256: JsonSchema = { type: "string", pattern: "^[a-fA-F0-9]{64}$" };
const stringArray: JsonSchema = { type: "array", items: text, uniqueItems: true };
const emptyInput: JsonSchema = { type: "object", additionalProperties: false };
const ownerSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id"],
  properties: { kind: { enum: ["workspace", "host", "deployment"] }, id: text },
};
const resourceRefSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id", "revision"],
  properties: { kind: text, id: text, revision: nullableText },
};
const refsSchema: JsonSchema = { type: "array", items: resourceRefSchema };
const invocationProvenanceSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "cause_event_id", "delivery_ids", "execution_attempt_id",
    "node_execution_id", "scope_execution_id",
  ],
  properties: {
    cause_event_id: nullableText,
    delivery_ids: stringArray,
    execution_attempt_id: nullableText,
    node_execution_id: nullableText,
    scope_execution_id: nullableText,
  },
};
const jsonSchema: JsonSchema = {
  oneOf: [
    { type: "null" },
    { type: "boolean" },
    { type: "number" },
    { type: "string" },
    { type: "array" },
    { type: "object" },
  ],
};

const credentialSlotSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["slot_id", "title", "purpose", "required"],
  properties: { slot_id: text, title: text, purpose: text, required: { type: "boolean" } },
};
const sourceInterfaceSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "interface_id", "title", "source_kind", "event_type", "payload_schema_ref",
    "observation_mode", "polling_contract_ref", "identity_scope", "verification",
    "credential_slot_ids", "required_capability_ids", "checkpoint_schema_ref",
  ],
  properties: {
    interface_id: text,
    title: text,
    source_kind: text,
    event_type: text,
    payload_schema_ref: text,
    observation_mode: { enum: ["push", "connector_poll"] },
    polling_contract_ref: nullableText,
    identity_scope: { enum: ["occurrence", "resource_revision"] },
    verification: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "verifier_ref"],
      properties: { mode: { enum: ["none", "origin", "signature"] }, verifier_ref: nullableText },
    },
    credential_slot_ids: stringArray,
    required_capability_ids: stringArray,
    checkpoint_schema_ref: nullableText,
  },
};
const actionInterfaceSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "interface_id", "title", "action_kind", "input_schema_ref", "result_schema_ref",
    "effect", "idempotency", "retry", "compensation_action_interface_id", "approval",
    "credential_slot_ids", "required_capability_ids",
  ],
  properties: {
    interface_id: text,
    title: text,
    action_kind: text,
    input_schema_ref: text,
    result_schema_ref: text,
    effect: { enum: ["none", "reversible", "irreversible"] },
    idempotency: { enum: ["required", "provider_guaranteed"] },
    retry: { enum: ["safe", "after_reconcile", "never"] },
    compensation_action_interface_id: nullableText,
    approval: {
      type: "object",
      additionalProperties: false,
      required: ["required", "policy_ref"],
      properties: { required: { type: "boolean" }, policy_ref: nullableText },
    },
    credential_slot_ids: stringArray,
    required_capability_ids: stringArray,
  },
};
export const CONNECTOR_DEFINITION_CONTENT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "label", "description", "implementation_ref", "configuration_schema_ref",
    "configuration_ui_schema_ref", "credential_slots", "source_interfaces",
    "action_interfaces", "health", "rate_limit_policy_ref",
  ],
  properties: {
    label: text,
    description: text,
    implementation_ref: resourceRefSchema,
    configuration_schema_ref: text,
    configuration_ui_schema_ref: nullableText,
    credential_slots: { type: "array", items: credentialSlotSchema },
    source_interfaces: { type: "array", items: sourceInterfaceSchema },
    action_interfaces: { type: "array", items: actionInterfaceSchema },
    health: {
      type: "object",
      additionalProperties: false,
      required: ["check_capability_id", "evidence_schema_ref"],
      properties: { check_capability_id: text, evidence_schema_ref: nullableText },
    },
    rate_limit_policy_ref: nullableText,
  },
};

const secretBindingSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["slot_id", "secret_ref_id"],
  properties: { slot_id: text, secret_ref_id: text },
};
export const CONNECTOR_BINDING_CONTENT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "external_resource", "configuration", "enabled_source_interface_ids",
    "enabled_action_interface_ids", "secret_bindings", "capability_grant_ids",
  ],
  properties: {
    external_resource: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "id", "display_name"],
      properties: { kind: text, id: text, display_name: nullableText },
    },
    configuration: jsonSchema,
    enabled_source_interface_ids: stringArray,
    enabled_action_interface_ids: stringArray,
    secret_bindings: { type: "array", items: secretBindingSchema },
    capability_grant_ids: stringArray,
  },
};

const definitionRecordSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "connector_definition_id", "owner", "status", "current_revision_id",
    "created_at", "updated_at", "retired_at",
  ],
  properties: {
    connector_definition_id: text,
    owner: ownerSchema,
    status: { enum: ["active", "retired"] },
    current_revision_id: text,
    created_at: text,
    updated_at: text,
    retired_at: nullableText,
  },
};
const definitionRevisionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "connector_definition_revision_id", "connector_definition_id", "revision_number",
    "based_on_revision_id", "semantic_digest", "content", "created_by_principal_id",
    "created_at", "published_at",
  ],
  properties: {
    connector_definition_revision_id: text,
    connector_definition_id: text,
    revision_number: { type: "integer", minimum: 1 },
    based_on_revision_id: nullableText,
    semantic_digest: sha256,
    content: CONNECTOR_DEFINITION_CONTENT_SCHEMA,
    created_by_principal_id: text,
    created_at: text,
    published_at: text,
  },
};
const bindingRecordSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "connector_binding_id", "connector_definition_id", "owner", "status", "state_version",
    "current_revision_id", "created_at", "updated_at", "enabled_at", "disabled_at", "retired_at",
  ],
  properties: {
    connector_binding_id: text,
    connector_definition_id: text,
    owner: ownerSchema,
    status: { enum: ["disabled", "enabled", "retired"] },
    state_version: { type: "integer", minimum: 1 },
    current_revision_id: text,
    created_at: text,
    updated_at: text,
    enabled_at: nullableText,
    disabled_at: nullableText,
    retired_at: nullableText,
  },
};
const bindingRevisionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "connector_binding_revision_id", "connector_binding_id", "connector_definition_revision_id",
    "revision_number", "based_on_revision_id", "semantic_digest", "content",
    "created_by_principal_id", "created_at", "published_at",
  ],
  properties: {
    connector_binding_revision_id: text,
    connector_binding_id: text,
    connector_definition_revision_id: text,
    revision_number: { type: "integer", minimum: 1 },
    based_on_revision_id: nullableText,
    semantic_digest: sha256,
    content: CONNECTOR_BINDING_CONTENT_SCHEMA,
    created_by_principal_id: text,
    created_at: text,
    published_at: text,
  },
};
const healthSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "connector_health_observation_id", "connector_binding_id", "connector_binding_revision_id",
    "owner", "status", "code", "message", "evidence_refs", "observed_at", "recorded_at",
  ],
  properties: {
    connector_health_observation_id: text,
    connector_binding_id: text,
    connector_binding_revision_id: text,
    owner: ownerSchema,
    status: { enum: ["unknown", "healthy", "degraded", "unhealthy"] },
    code: nullableText,
    message: text,
    evidence_refs: refsSchema,
    observed_at: text,
    recorded_at: text,
  },
};
const ingressVerificationSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["origin", "signature", "schema", "issues"],
  properties: {
    origin: { enum: ["verified", "failed", "not_applicable"] },
    signature: { enum: ["verified", "failed", "not_applicable"] },
    schema: { enum: ["valid", "invalid"] },
    issues: stringArray,
  },
};
const ingressReceiptSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "connector_ingress_receipt_id", "connector_binding_id", "connector_binding_revision_id",
    "owner", "source_interface_id", "deduplication_key", "idempotency_key", "external_identity",
    "external_revision", "payload_digest", "status", "normalized_event_id", "artefact_version_ids",
    "checkpoint_ref", "first_observed_at", "last_observed_at", "physical_observation_count",
  ],
  properties: {
    connector_ingress_receipt_id: text,
    connector_binding_id: text,
    connector_binding_revision_id: text,
    owner: ownerSchema,
    source_interface_id: text,
    deduplication_key: sha256,
    idempotency_key: text,
    external_identity: text,
    external_revision: nullableText,
    payload_digest: sha256,
    status: { enum: ["accepted", "materialized", "quarantined"] },
    normalized_event_id: nullableText,
    artefact_version_ids: stringArray,
    checkpoint_ref: { oneOf: [resourceRefSchema, { type: "null" }] },
    first_observed_at: text,
    last_observed_at: text,
    physical_observation_count: { type: "integer", minimum: 1 },
  },
};
const ingressObservationSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "connector_ingress_observation_id", "connector_ingress_receipt_id", "connector_binding_revision_id",
    "classification", "idempotency_key", "external_identity", "external_revision", "payload_digest",
    "verification", "evidence_refs", "observed_at", "recorded_at",
  ],
  properties: {
    connector_ingress_observation_id: text,
    connector_ingress_receipt_id: text,
    connector_binding_revision_id: text,
    classification: { enum: ["accepted", "quarantined", "duplicate", "quarantined_conflict"] },
    idempotency_key: text,
    external_identity: text,
    external_revision: nullableText,
    payload_digest: sha256,
    verification: ingressVerificationSchema,
    evidence_refs: refsSchema,
    observed_at: text,
    recorded_at: text,
  },
};
const externalEffectSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "external_effect_receipt_id", "connector_binding_id", "connector_binding_revision_id",
    "owner", "action_interface_id", "idempotency_key", "input_digest", "input_refs",
    "secret_ref_ids", "capability_grant_ids", "approval_receipt_ids", "requested_by_principal_id",
    "invocation_provenance", "status", "attempt_count", "requested_at", "updated_at", "completed_at",
  ],
  properties: {
    external_effect_receipt_id: text,
    connector_binding_id: text,
    connector_binding_revision_id: text,
    owner: ownerSchema,
    action_interface_id: text,
    idempotency_key: text,
    input_digest: sha256,
    input_refs: refsSchema,
    secret_ref_ids: stringArray,
    capability_grant_ids: stringArray,
    approval_receipt_ids: stringArray,
    requested_by_principal_id: text,
    invocation_provenance: invocationProvenanceSchema,
    status: { enum: ["requested", "running", "succeeded", "failed", "outcome_unknown"] },
    attempt_count: { type: "integer", minimum: 0 },
    requested_at: text,
    updated_at: text,
    completed_at: nullableText,
  },
};
const actionAttemptSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "external_action_attempt_id", "external_effect_receipt_id", "attempt_number", "status",
    "request_evidence_ref", "provider_response_ref", "observed_result_ref", "error_code",
    "error_message", "started_at", "completed_at",
  ],
  properties: {
    external_action_attempt_id: text,
    external_effect_receipt_id: text,
    attempt_number: { type: "integer", minimum: 1 },
    status: { enum: ["started", "succeeded", "failed", "outcome_unknown"] },
    request_evidence_ref: resourceRefSchema,
    provider_response_ref: { oneOf: [resourceRefSchema, { type: "null" }] },
    observed_result_ref: { oneOf: [resourceRefSchema, { type: "null" }] },
    error_code: nullableText,
    error_message: nullableText,
    started_at: text,
    completed_at: nullableText,
  },
};

const definitionAndRevisionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["definition", "revision"],
  properties: { definition: definitionRecordSchema, revision: definitionRevisionSchema },
};
const bindingAndRevisionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["binding", "revision"],
  properties: { binding: bindingRecordSchema, revision: bindingRevisionSchema },
};
const bindingOnlySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["binding"],
  properties: { binding: bindingRecordSchema },
};

type ConnectorInspection = {
  resource_kind: "connector_definition" | "connector_definition_revision" | "connector_binding"
    | "connector_binding_revision" | "connector_ingress_receipt" | "external_effect_receipt";
  definition: ConnectorDefinitionRecord | null;
  definition_revision: ConnectorDefinitionRevision | null;
  binding: ConnectorBindingRecord | null;
  binding_revision: ConnectorBindingRevision | null;
  health: ReturnType<ConnectorStore["currentHealth"]>;
  ingress_receipt: ReturnType<ConnectorStore["getIngressReceipt"]>;
  ingress_observations: ReturnType<ConnectorStore["listIngressObservations"]>;
  external_effect_receipt: ExternalEffectReceipt | null;
  action_attempts: ReturnType<ConnectorStore["listExternalActionAttempts"]>;
};

const inspectionResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "resource_kind", "definition", "definition_revision", "binding", "binding_revision",
    "health", "ingress_receipt", "ingress_observations", "external_effect_receipt", "action_attempts",
  ],
  properties: {
    resource_kind: { enum: [
      "connector_definition", "connector_definition_revision", "connector_binding",
      "connector_binding_revision", "connector_ingress_receipt", "external_effect_receipt",
    ] },
    definition: { oneOf: [definitionRecordSchema, { type: "null" }] },
    definition_revision: { oneOf: [definitionRevisionSchema, { type: "null" }] },
    binding: { oneOf: [bindingRecordSchema, { type: "null" }] },
    binding_revision: { oneOf: [bindingRevisionSchema, { type: "null" }] },
    health: { oneOf: [healthSchema, { type: "null" }] },
    ingress_receipt: { oneOf: [ingressReceiptSchema, { type: "null" }] },
    ingress_observations: { type: "array", items: ingressObservationSchema },
    external_effect_receipt: { oneOf: [externalEffectSchema, { type: "null" }] },
    action_attempts: { type: "array", items: actionAttemptSchema },
  },
};

function authorityOwner(authority: OperationAuthorityContext): ConnectorOwner {
  return authority.boundary.kind === "workspace"
    ? { kind: "workspace", id: authority.boundary.workspace_id }
    : { kind: "host", id: authority.boundary.host_id };
}

function auditRef(context: OperationExecutionContext) {
  return { kind: "operation_invocation", id: context.invocation_id, revision: null } as const;
}

function definitionRef(value: ConnectorDefinitionRecord) {
  return { kind: "connector_definition", id: value.connector_definition_id, revision: value.current_revision_id } as const;
}

function definitionRevisionRef(value: ConnectorDefinitionRevision) {
  return {
    kind: "connector_definition_revision",
    id: value.connector_definition_revision_id,
    revision: value.semantic_digest,
  } as const;
}

function bindingRef(value: ConnectorBindingRecord) {
  return { kind: "connector_binding", id: value.connector_binding_id, revision: connectorBindingStateRevision(value) } as const;
}

function bindingRevisionRef(value: ConnectorBindingRevision) {
  return { kind: "connector_binding_revision", id: value.connector_binding_revision_id, revision: value.semantic_digest } as const;
}

function ingressRef(id: string) {
  return { kind: "connector_ingress_receipt", id, revision: null } as const;
}

function externalEffectRef(value: ExternalEffectReceipt) {
  return {
    kind: "external_effect_receipt",
    id: value.external_effect_receipt_id,
    revision: externalEffectStateRevision(value),
  } as const;
}

/**
 * Resolves Connector operation targets inside the authenticated authority
 * boundary. BusStore can delegate to this projection instead of reproducing
 * Connector resource kinds, ownership checks, or revision rules.
 */
export function resolveConnectorOperationResource(
  store: ConnectorStore,
  authority: OperationAuthorityContext | OperationAuthorityBoundary,
  target: OperationResourceIdentity,
): ResolvedOperationResource | null {
  const boundary = "boundary" in authority ? authority.boundary : authority;
  const owner: ConnectorOwner = boundary.kind === "workspace"
    ? { kind: "workspace", id: boundary.workspace_id }
    : { kind: "host", id: boundary.host_id };
  const ownedByAuthority = (candidate: ConnectorOwner): boolean =>
    candidate.kind === owner.kind && candidate.id === owner.id;

  if (target.kind === "connector_definition") {
    const value = store.getDefinition(target.id);
    return value && ownedByAuthority(value.owner)
      ? { ref: { ...target, revision: value.current_revision_id }, state: value }
      : null;
  }
  if (target.kind === "connector_definition_revision") {
    const value = store.getDefinitionRevision(target.id);
    const parent = value ? store.getDefinition(value.connector_definition_id) : null;
    return value && parent && ownedByAuthority(parent.owner)
      ? { ref: { ...target, revision: value.semantic_digest }, state: value }
      : null;
  }
  if (target.kind === "connector_binding") {
    const value = store.getBinding(target.id);
    return value && ownedByAuthority(value.owner)
      ? { ref: { ...target, revision: connectorBindingStateRevision(value) }, state: value }
      : null;
  }
  if (target.kind === "connector_binding_revision") {
    const value = store.getBindingRevision(target.id);
    const parent = value ? store.getBinding(value.connector_binding_id) : null;
    return value && parent && ownedByAuthority(parent.owner)
      ? { ref: { ...target, revision: value.semantic_digest }, state: value }
      : null;
  }
  if (target.kind === "connector_ingress_receipt") {
    const value = store.getIngressReceipt(target.id);
    return value && ownedByAuthority(value.owner)
      ? { ref: { ...target, revision: null }, state: value }
      : null;
  }
  if (target.kind === "external_effect_receipt") {
    const value = store.getExternalEffectReceipt(target.id);
    return value && ownedByAuthority(value.owner)
      ? { ref: { ...target, revision: externalEffectStateRevision(value) }, state: value }
      : null;
  }
  return null;
}

export function connectorOperationRefusal(error: unknown): OperationRefusal {
  if (error instanceof ConnectorOwnerMismatchError || error instanceof ConnectorNotFoundError) {
    return refusal(
      "connector_not_found",
      "The requested Connector resource is not available in this authority boundary.",
      false,
      requiredAction("refresh_connectors", "Refresh Connectors", "Refresh the available Connector resources and choose one in this Workspace or host."),
    );
  }
  if (error instanceof ConnectorRevisionConflictError) {
    return refusal(
      "connector_revision_conflict",
      error.message,
      true,
      requiredAction("refresh_connector", "Refresh Connector", "Inspect the current Connector revision before retrying."),
      { expected: error.expected_revision_id, actual: error.actual_revision_id },
    );
  }
  if (error instanceof ConnectorLifecycleConflictError) {
    return refusal(
      "connector_lifecycle_blocked",
      error.message,
      true,
      requiredAction("inspect_connector", "Inspect Connector", "Inspect its current lifecycle, authority, credentials, and health."),
    );
  }
  if (error instanceof ConnectorIngressIdempotencyConflictError) {
    return refusal(
      "connector_ingress_conflict",
      error.message,
      false,
      requiredAction("inspect_quarantine", "Inspect quarantined observation", "Compare the conflicting external identity, revision, and payload evidence."),
      {
        connector_ingress_receipt_id: error.receipt.connector_ingress_receipt_id,
        connector_ingress_observation_id: error.observation.connector_ingress_observation_id,
      },
    );
  }
  if (error instanceof ExternalActionStateError) {
    return refusal(
      "external_effect_state_blocked",
      error.message,
      false,
      requiredAction("reconcile_external_effect", "Reconcile external effect", "Inspect provider evidence and reconcile any uncertain effect before retrying."),
      { external_effect_receipt_id: error.external_effect_receipt_id },
    );
  }
  if (error instanceof ConnectorValidationError) {
    return refusal(
      "connector_input_invalid",
      error.message,
      false,
      requiredAction("correct_connector_input", "Correct Connector input", "Use the exact discovered Connector contract and SecretRef references."),
    );
  }
  return refusal(
    "connector_outcome_unknown",
    "Floe could not prove whether the Connector operation completed.",
    false,
    requiredAction("inspect_connector", "Inspect Connector", "Inspect the Connector, receipts, and evidence before deciding whether retry is safe."),
  );
}

async function handled<TResult>(work: () => OperationHandlerOutcome<TResult> | Promise<OperationHandlerOutcome<TResult>>) {
  try {
    return await work();
  } catch (error) {
    return { state: "refused" as const, refusal: connectorOperationRefusal(error) };
  }
}

function exactDefinition(store: ConnectorStore, context: OperationExecutionContext) {
  return store.requireDefinitionForOwner(context.target!.ref.id, authorityOwner(context.authority));
}

function exactBinding(store: ConnectorStore, context: OperationExecutionContext) {
  return store.requireBindingForOwner(context.target!.ref.id, authorityOwner(context.authority));
}

function definitionForRevision(store: ConnectorStore, revisionId: string, owner: ConnectorOwner) {
  return store.requireDefinitionRevisionForOwner(revisionId, owner);
}

export function inspectConnectorOperation(store: ConnectorStore): SemanticOperationDefinition<Record<string, never>, ConnectorInspection> {
  return {
    operation_id: INSPECT_CONNECTOR_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace", "host"],
    category: "connectors",
    title: "Inspect Connector",
    description: "Inspect one exact Connector definition, binding, ingress receipt, or external-effect receipt and its retained evidence.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [INSPECT_CONNECTOR_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: {
      resource_kinds: [
        "connector_definition", "connector_definition_revision", "connector_binding",
        "connector_binding_revision", "connector_ingress_receipt", "external_effect_receipt",
      ],
      expected_revision: "not_applicable",
    },
    input: { version: "1", schema: emptyInput },
    result: { version: "1", schema: inspectionResultSchema },
    handler: (context) => handled(() => {
      const owner = authorityOwner(context.authority);
      const kind = context.target!.ref.kind as ConnectorInspection["resource_kind"];
      const empty = {
        definition: null,
        definition_revision: null,
        binding: null,
        binding_revision: null,
        health: null,
        ingress_receipt: null,
        ingress_observations: [],
        external_effect_receipt: null,
        action_attempts: [],
      };
      let result: ConnectorInspection;
      if (kind === "connector_definition") {
        const definition = store.requireDefinitionForOwner(context.target!.ref.id, owner);
        result = {
          ...empty,
          resource_kind: kind,
          definition,
          definition_revision: store.requireDefinitionRevisionForOwner(definition.current_revision_id, owner),
        };
      } else if (kind === "connector_definition_revision") {
        const definitionRevision = store.requireDefinitionRevisionForOwner(context.target!.ref.id, owner);
        result = {
          ...empty,
          resource_kind: kind,
          definition: store.requireDefinitionForOwner(definitionRevision.connector_definition_id, owner),
          definition_revision: definitionRevision,
        };
      } else if (kind === "connector_binding" || kind === "connector_binding_revision") {
        const bindingRevision = kind === "connector_binding_revision"
          ? store.requireBindingRevisionForOwner(context.target!.ref.id, owner)
          : null;
        const binding = bindingRevision
          ? store.requireBindingForOwner(bindingRevision.connector_binding_id, owner)
          : store.requireBindingForOwner(context.target!.ref.id, owner);
        result = {
          ...empty,
          resource_kind: kind,
          binding,
          binding_revision: bindingRevision ?? store.requireBindingRevisionForOwner(binding.current_revision_id, owner),
          health: store.currentHealth(binding.connector_binding_id, owner),
        };
      } else if (kind === "connector_ingress_receipt") {
        const ingressReceipt = store.requireIngressReceiptForOwner(context.target!.ref.id, owner);
        result = {
          ...empty,
          resource_kind: kind,
          ingress_receipt: ingressReceipt,
          ingress_observations: store.listIngressObservations(ingressReceipt.connector_ingress_receipt_id, owner),
        };
      } else {
        const externalEffectReceipt = store.requireExternalEffectReceiptForOwner(context.target!.ref.id, owner);
        result = {
          ...empty,
          resource_kind: "external_effect_receipt",
          external_effect_receipt: externalEffectReceipt,
          action_attempts: store.listExternalActionAttempts(externalEffectReceipt.external_effect_receipt_id, owner),
        };
      }
      return { state: "completed" as const, result, audit_ref: auditRef(context) };
    }),
  };
}

export function configureConnectorDefinitionOperation(
  store: ConnectorStore,
): SemanticOperationDefinition<{ content: ConnectorDefinitionContent }, { definition: ConnectorDefinitionRecord; revision: ConnectorDefinitionRevision }> {
  return {
    operation_id: CONFIGURE_CONNECTOR_DEFINITION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace", "host"],
    category: "connectors",
    title: "Configure Connector definition",
    description: "Publish a new immutable revision of a ConnectorDefinition owned by this authority boundary.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [CONFIGURE_CONNECTOR_DEFINITION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["connector_definition"], expected_revision: "required" },
    input: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["content"],
        properties: { content: CONNECTOR_DEFINITION_CONTENT_SCHEMA },
      },
    },
    result: { version: "1", schema: definitionAndRevisionSchema },
    handler: (context, input) => handled(() => {
      const current = exactDefinition(store, context);
      const result = store.reviseDefinition({
        connector_definition_id: current.connector_definition_id,
        owner: authorityOwner(context.authority),
        expected_current_revision_id: current.current_revision_id,
        content: input.content,
        changed_by_principal_id: context.authority.principal_id,
      });
      return {
        state: "completed" as const,
        result,
        changed_refs: [definitionRef(result.definition), definitionRevisionRef(result.revision)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function bindConnectorOperation(
  store: ConnectorStore,
): SemanticOperationDefinition<{
  connector_binding_id?: string;
  content: ConnectorBindingContent;
}, { binding: ConnectorBindingRecord; revision: ConnectorBindingRevision }> {
  return {
    operation_id: BIND_CONNECTOR_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace", "host"],
    category: "connectors",
    title: "Bind Connector",
    description: "Create a disabled ConnectorBinding for one exact ConnectorDefinition revision without exposing credential values.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "reference" },
    required_grants: [BIND_CONNECTOR_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["connector_definition_revision"], expected_revision: "not_applicable" },
    input: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["content"],
        properties: { connector_binding_id: text, content: CONNECTOR_BINDING_CONTENT_SCHEMA },
      },
    },
    result: { version: "1", schema: bindingAndRevisionSchema },
    handler: (context, input) => handled(() => {
      const owner = authorityOwner(context.authority);
      const definitionRevision = definitionForRevision(store, context.target!.ref.id, owner);
      const result = store.createBinding({
        ...(input.connector_binding_id ? { connector_binding_id: input.connector_binding_id } : {}),
        connector_definition_revision_id: definitionRevision.connector_definition_revision_id,
        owner,
        content: input.content,
        created_by_principal_id: context.authority.principal_id,
      });
      return {
        state: "completed" as const,
        result,
        changed_refs: [bindingRef(result.binding), bindingRevisionRef(result.revision)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function configureConnectorBindingOperation(
  store: ConnectorStore,
): SemanticOperationDefinition<{
  connector_definition_revision_id?: string;
  content: ConnectorBindingContent;
}, { binding: ConnectorBindingRecord; revision: ConnectorBindingRevision }> {
  return {
    operation_id: CONFIGURE_CONNECTOR_BINDING_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace", "host"],
    category: "connectors",
    title: "Configure Connector binding",
    description: "Publish a new immutable ConnectorBinding configuration revision.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "reference" },
    required_grants: [CONFIGURE_CONNECTOR_BINDING_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["connector_binding"], expected_revision: "required" },
    input: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["content"],
        properties: {
          connector_definition_revision_id: text,
          content: CONNECTOR_BINDING_CONTENT_SCHEMA,
        },
      },
    },
    result: { version: "1", schema: bindingAndRevisionSchema },
    handler: (context, input) => handled(() => {
      const binding = exactBinding(store, context);
      const result = store.reviseBinding({
        connector_binding_id: binding.connector_binding_id,
        owner: authorityOwner(context.authority),
        expected_current_revision_id: binding.current_revision_id,
        ...(input.connector_definition_revision_id
          ? { connector_definition_revision_id: input.connector_definition_revision_id }
          : {}),
        content: input.content,
        changed_by_principal_id: context.authority.principal_id,
      });
      return {
        state: "completed" as const,
        result,
        changed_refs: [bindingRef(result.binding), bindingRevisionRef(result.revision)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

function bindingLifecycleOperation(
  store: ConnectorStore,
  input: {
    operation_id: string;
    title: string;
    description: string;
    status: "enabled" | "disabled";
  },
): SemanticOperationDefinition<Record<string, never>, { binding: ConnectorBindingRecord }> {
  return {
    operation_id: input.operation_id,
    operation_version: "1",
    authority_boundary_kinds: ["workspace", "host"],
    category: "connectors",
    title: input.title,
    description: input.description,
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "reference" },
    required_grants: [input.operation_id],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["connector_binding"], expected_revision: "required" },
    input: { version: "1", schema: emptyInput },
    result: { version: "1", schema: bindingOnlySchema },
    handler: (context) => handled(() => {
      const binding = exactBinding(store, context);
      const changed = store.setBindingStatus({
        connector_binding_id: binding.connector_binding_id,
        owner: authorityOwner(context.authority),
        status: input.status,
        expected_state_revision: connectorBindingStateRevision(binding),
      });
      return {
        state: "completed" as const,
        result: { binding: changed },
        changed_refs: [bindingRef(changed)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function enableConnectorBindingOperation(store: ConnectorStore) {
  return bindingLifecycleOperation(store, {
    operation_id: ENABLE_CONNECTOR_BINDING_OPERATION_ID,
    title: "Enable Connector",
    description: "Enable an exactly configured ConnectorBinding after its SecretRef and CapabilityGrant requirements resolve.",
    status: "enabled",
  });
}

export function disableConnectorBindingOperation(store: ConnectorStore) {
  return bindingLifecycleOperation(store, {
    operation_id: DISABLE_CONNECTOR_BINDING_OPERATION_ID,
    title: "Disable Connector",
    description: "Stop new ingress and external action requests for this ConnectorBinding without deleting evidence.",
    status: "disabled",
  });
}

export function rotateConnectorBindingOperation(
  store: ConnectorStore,
): SemanticOperationDefinition<{ secret_bindings: readonly ConnectorSecretBinding[] }, { binding: ConnectorBindingRecord; revision: ConnectorBindingRevision }> {
  return {
    operation_id: ROTATE_CONNECTOR_BINDING_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace", "host"],
    category: "connectors",
    title: "Rotate Connector credential references",
    description: "Publish a new binding revision containing replacement SecretRef bindings; reusable credential values stay in the broker.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "reference" },
    required_grants: [ROTATE_CONNECTOR_BINDING_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "brokered"], broker: {
      broker_id: "credential-broker",
      purpose: "Select verified SecretRefs without exposing reusable credential values.",
    } },
    target: { resource_kinds: ["connector_binding"], expected_revision: "required" },
    input: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["secret_bindings"],
        properties: { secret_bindings: { type: "array", items: secretBindingSchema } },
      },
    },
    result: { version: "1", schema: bindingAndRevisionSchema },
    handler: (context, input) => handled(() => {
      const binding = exactBinding(store, context);
      const result = store.rotateBindingSecrets({
        connector_binding_id: binding.connector_binding_id,
        owner: authorityOwner(context.authority),
        expected_current_revision_id: binding.current_revision_id,
        secret_bindings: input.secret_bindings,
        changed_by_principal_id: context.authority.principal_id,
      });
      return {
        state: "completed" as const,
        result,
        changed_refs: [bindingRef(result.binding), bindingRevisionRef(result.revision)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function recordConnectorHealthOperation(
  store: ConnectorStore,
): SemanticOperationDefinition<{
  status: "unknown" | "healthy" | "degraded" | "unhealthy";
  code?: string | null;
  message: string;
  evidence_refs?: readonly ConnectorEvidenceRef[];
  observed_at: string;
}, { health: NonNullable<ReturnType<ConnectorStore["currentHealth"]>> }> {
  return {
    operation_id: RECORD_CONNECTOR_HEALTH_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace", "host"],
    category: "connectors",
    title: "Record Connector health",
    description: "Record a Connector worker's health observation and exact evidence without running a core liveness loop.",
    effects: {
      mode: "write",
      reversibility: "none",
      external: false,
      secret_access: "none",
      allowed_during_restore_hold: true,
    },
    required_grants: [RECORD_CONNECTOR_HEALTH_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["unattended", "interactive"] },
    target: { resource_kinds: ["connector_binding"], expected_revision: "required" },
    input: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["status", "message", "observed_at"],
        properties: {
          status: { enum: ["unknown", "healthy", "degraded", "unhealthy"] },
          code: nullableText,
          message: text,
          evidence_refs: refsSchema,
          observed_at: text,
        },
      },
    },
    result: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["health"],
        properties: { health: healthSchema },
      },
    },
    handler: (context, input) => handled(() => {
      const binding = exactBinding(store, context);
      const health = store.recordHealth({
        connector_binding_id: binding.connector_binding_id,
        connector_binding_revision_id: binding.current_revision_id,
        owner: authorityOwner(context.authority),
        status: input.status,
        ...(input.code !== undefined ? { code: input.code } : {}),
        message: input.message,
        ...(input.evidence_refs ? { evidence_refs: input.evidence_refs } : {}),
        observed_at: input.observed_at,
      });
      return {
        state: "completed" as const,
        result: { health },
        changed_refs: [{ kind: "connector_health_observation", id: health.connector_health_observation_id, revision: null }],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function ingestConnectorObservationOperation(
  store: ConnectorStore,
): SemanticOperationDefinition<{
  source_interface_id: string;
  external_identity: string;
  external_revision?: string | null;
  payload_digest: string;
  verification: ConnectorIngressVerification;
  evidence_refs?: readonly ConnectorEvidenceRef[];
  checkpoint_ref?: ConnectorEvidenceRef | null;
  observed_at: string;
}, { replayed: boolean; receipt: ReturnType<ConnectorStore["recordIngress"]>["receipt"]; observation: ReturnType<ConnectorStore["recordIngress"]>["observation"] }> {
  return {
    operation_id: INGEST_CONNECTOR_OBSERVATION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace", "host"],
    category: "connectors",
    title: "Ingest Connector observation",
    description: "Record and deduplicate one verified external observation; payload bytes and reusable credentials remain outside the operation input.",
    effects: { mode: "write", reversibility: "none", external: false, secret_access: "reference" },
    required_grants: [INGEST_CONNECTOR_OBSERVATION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["unattended"] },
    target: { resource_kinds: ["connector_binding"], expected_revision: "required" },
    input: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: [
          "source_interface_id", "external_identity", "payload_digest", "verification", "observed_at",
        ],
        properties: {
          source_interface_id: text,
          external_identity: text,
          external_revision: nullableText,
          payload_digest: sha256,
          verification: ingressVerificationSchema,
          evidence_refs: refsSchema,
          checkpoint_ref: { oneOf: [resourceRefSchema, { type: "null" }] },
          observed_at: text,
        },
      },
    },
    result: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["replayed", "receipt", "observation"],
        properties: {
          replayed: { type: "boolean" },
          receipt: ingressReceiptSchema,
          observation: ingressObservationSchema,
        },
      },
    },
    handler: (context, input) => handled(() => {
      const binding = exactBinding(store, context);
      const result = store.recordIngress({
        connector_binding_id: binding.connector_binding_id,
        connector_binding_revision_id: binding.current_revision_id,
        owner: authorityOwner(context.authority),
        source_interface_id: input.source_interface_id,
        idempotency_key: context.idempotency_key,
        external_identity: input.external_identity,
        ...(input.external_revision !== undefined ? { external_revision: input.external_revision } : {}),
        payload_digest: input.payload_digest,
        verification: input.verification,
        ...(input.evidence_refs ? { evidence_refs: input.evidence_refs } : {}),
        ...(input.checkpoint_ref !== undefined ? { checkpoint_ref: input.checkpoint_ref } : {}),
        observed_at: input.observed_at,
      });
      return {
        state: "completed" as const,
        result,
        changed_refs: [ingressRef(result.receipt.connector_ingress_receipt_id)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function requestConnectorActionOperation(
  store: ConnectorStore,
  approvals: ApprovalStore,
): SemanticOperationDefinition<{
  action_interface_id: string;
  input_digest: string;
  input_refs?: readonly ConnectorEvidenceRef[];
  approval_receipt_ids?: readonly string[];
}, { external_effect: ExternalEffectReceipt }> {
  return {
    operation_id: REQUEST_CONNECTOR_ACTION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace", "host"],
    category: "connectors",
    title: "Request external Connector action",
    description: "Request one idempotent external action against exact inputs, credential references, grants, and approval evidence.",
    effects: { mode: "write", reversibility: "irreversible", external: true, secret_access: "brokered" },
    required_grants: [REQUEST_CONNECTOR_ACTION_OPERATION_ID],
    interaction_constraints: {
      allowed_modes: ["interactive", "unattended"],
      confirmation: {
        required: true,
        prompt_id: "connector.external-action.confirm",
        title: "Confirm external action",
        description: "Confirm that Floe may request the described effect outside this Workspace.",
      },
    },
    target: { resource_kinds: ["connector_binding"], expected_revision: "required" },
    input: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["action_interface_id", "input_digest"],
        properties: {
          action_interface_id: text,
          input_digest: sha256,
          input_refs: refsSchema,
          approval_receipt_ids: stringArray,
        },
      },
    },
    result: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["external_effect"],
        properties: { external_effect: externalEffectSchema },
      },
    },
    handler: (context, input) => handled<{ external_effect: ExternalEffectReceipt }>(() => {
      const owner = authorityOwner(context.authority);
      const binding = exactBinding(store, context);
      const action = store.getActionInterfaceForBinding(binding.connector_binding_id, owner, input.action_interface_id);
      const approvalReceiptIds = input.approval_receipt_ids ?? [];
      if (action.approval.required && approvalReceiptIds.length === 0) {
        return {
          state: "refused" as const,
          refusal: refusal(
            "connector_action_approval_required",
            "This external action requires a canonical ApprovalReceipt bound to its exact inputs and execution.",
            true,
            requiredAction("approve_connector_action", "Approve external action", "Review the exact inputs and expected external effect before approving."),
            { policy_ref: action.approval.policy_ref },
          ),
        };
      }
      if (!action.approval.required && approvalReceiptIds.length > 0) {
        throw new ConnectorValidationError("this external action does not accept ApprovalReceipt references");
      }
      if (action.approval.required) {
        if (owner.kind !== "workspace") {
          throw new ConnectorValidationError("approval-gated Connector actions require Workspace authority");
        }
        for (const approvalReceiptId of approvalReceiptIds) {
          const approvalReceipt = approvals.getReceipt(approvalReceiptId);
          if (!approvalReceipt || approvalReceipt.workspace_id !== owner.id) {
            throw new ConnectorValidationError("approval_receipt_ids must identify canonical receipts in this Workspace");
          }
        }
      }
      const requested = store.requestExternalAction({
        connector_binding_id: binding.connector_binding_id,
        connector_binding_revision_id: binding.current_revision_id,
        owner,
        action_interface_id: input.action_interface_id,
        idempotency_key: context.idempotency_key,
        input_digest: input.input_digest,
        ...(input.input_refs ? { input_refs: input.input_refs } : {}),
        approval_receipt_ids: approvalReceiptIds,
        requested_by_principal_id: context.authority.principal_id,
        invocation_provenance: context.provenance,
      });
      return {
        state: "accepted" as const,
        result: { external_effect: requested.receipt },
        changed_refs: [externalEffectRef(requested.receipt)],
        progress_ref: externalEffectRef(requested.receipt),
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function reconcileConnectorActionOperation(
  store: ConnectorStore,
): SemanticOperationDefinition<{
  outcome: "succeeded" | "failed" | "outcome_unknown";
  evidence_ref: ConnectorEvidenceRef;
}, { external_effect: ExternalEffectReceipt; reconciliation: {
  external_action_reconciliation_id: string;
  external_effect_receipt_id: string;
  outcome: "succeeded" | "failed" | "outcome_unknown";
  evidence_ref: ConnectorEvidenceRef;
  reconciled_by_principal_id: string;
  reconciled_at: string;
} }> {
  const reconciliationSchema: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: [
      "external_action_reconciliation_id", "external_effect_receipt_id", "outcome",
      "evidence_ref", "reconciled_by_principal_id", "reconciled_at",
    ],
    properties: {
      external_action_reconciliation_id: text,
      external_effect_receipt_id: text,
      outcome: { enum: ["succeeded", "failed", "outcome_unknown"] },
      evidence_ref: resourceRefSchema,
      reconciled_by_principal_id: text,
      reconciled_at: text,
    },
  };
  return {
    operation_id: RECONCILE_CONNECTOR_ACTION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace", "host"],
    category: "connectors",
    title: "Reconcile external Connector effect",
    description: "Record provider evidence that resolves, disproves, or leaves uncertain a prior external effect.",
    effects: { mode: "write", reversibility: "none", external: true, secret_access: "brokered" },
    required_grants: [RECONCILE_CONNECTOR_ACTION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["unattended", "interactive"] },
    target: { resource_kinds: ["external_effect_receipt"], expected_revision: "required" },
    input: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["outcome", "evidence_ref"],
        properties: {
          outcome: { enum: ["succeeded", "failed", "outcome_unknown"] },
          evidence_ref: resourceRefSchema,
        },
      },
    },
    result: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["external_effect", "reconciliation"],
        properties: { external_effect: externalEffectSchema, reconciliation: reconciliationSchema },
      },
    },
    handler: (context, input) => handled(() => {
      const owner = authorityOwner(context.authority);
      const receipt = store.requireExternalEffectReceiptForOwner(context.target!.ref.id, owner);
      const result = store.reconcileExternalAction({
        external_effect_receipt_id: receipt.external_effect_receipt_id,
        owner,
        outcome: input.outcome,
        evidence_ref: input.evidence_ref,
        reconciled_by_principal_id: context.authority.principal_id,
      });
      return {
        state: "completed" as const,
        result: { external_effect: result.receipt, reconciliation: result.reconciliation },
        changed_refs: [externalEffectRef(result.receipt), {
          kind: "external_action_reconciliation",
          id: result.reconciliation.external_action_reconciliation_id,
          revision: null,
        }],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function connectorOperationDefinitions(
  store: ConnectorStore,
  approvals: ApprovalStore,
): Array<SemanticOperationDefinition<any, any>> {
  return [
    inspectConnectorOperation(store),
    configureConnectorDefinitionOperation(store),
    bindConnectorOperation(store),
    configureConnectorBindingOperation(store),
    enableConnectorBindingOperation(store),
    disableConnectorBindingOperation(store),
    rotateConnectorBindingOperation(store),
    recordConnectorHealthOperation(store),
    ingestConnectorObservationOperation(store),
    requestConnectorActionOperation(store, approvals),
    reconcileConnectorActionOperation(store),
  ];
}

export function registerConnectorOperations<T extends SemanticOperationRegistry>(
  registry: T,
  store: ConnectorStore,
  approvals: ApprovalStore,
): T {
  for (const operation of connectorOperationDefinitions(store, approvals)) registry.register(operation);
  return registry;
}
