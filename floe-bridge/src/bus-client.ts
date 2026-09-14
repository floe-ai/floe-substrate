import type { WorkspaceConfigurationInventory } from "./workspace-config-inventory.js";

export type EventEnvelope = {
  event_id: string;
  type: string;
  workspace_id: string;
  scope_id?: string | null;
  /** Source endpoint that emitted the event. Null for system-originated triggers (pulse, webhook). */
  source_endpoint_id: string | null;
  thread_id: string;
  context_id?: string | null;
  correlation_id: string | null;
  destination_json: {
    kind: "endpoint" | "broadcast" | "context";
    endpoint_id?: string;
    context_id?: string;
    scope?: "workspace";
    target?:
      | "all"
      | "active"
      | "with_delivery_processor"
      | "without_delivery_processor"
      | "active_with_delivery_processor"
      | "active_without_delivery_processor";
    exclude_source?: boolean;
  };
  content: Record<string, unknown>;
  /** Exact canonical ArtefactVersions carried by this Event. */
  artefact_version_ids: string[];
  response: {
    expected: boolean;
    mode?: "open" | "thread_affine" | "correlated";
    correlation_id?: string | null;
    timeout_at?: string | null;
  };
  metadata: Record<string, unknown>;
  created_at: string;
};

export type DeliveryBundle = {
  delivery_id: string;
  /** Stable logical Delivery obligations; a joined turn can consume many. */
  stable_delivery_ids?: string[];
  endpoint_id: string;
  workspace_id: string;
  trigger_event_id: string;
  events: EventEnvelope[];
  delivered_at: string;
  scope_execution_id?: string | null;
  composition_revision_id?: string | null;
  node_execution_id?: string | null;
  target_node_id?: string | null;
  target_port_ids?: string[];
  /** The target NodeExecution's working Context, not the source Event Context. */
  context_id?: string | null;
  execution_attempt_id?: string | null;
  actor_definition_revision_id?: string | null;
  runtime_profile_revision_id?: string | null;
  actor_runtime_binding_id?: string | null;
  command_definition_revision_id?: string | null;
  command_worker_binding_id?: string | null;
  /** Exact immutable runtime choice returned by authenticated runtime preparation. */
  processing_contract?: RuntimeDispatchContract | null;
  /** Exact immutable contract from the execution's pinned composition revision. */
  node_contract?: {
    node: {
      node_id: string;
      kind: "event" | "actor" | "command" | "context" | "scope" | "capability" | "connector";
      label?: string;
      resource_id?: string | null;
      config?: Record<string, unknown>;
      bindings?: Array<{ kind: "instructions"; text: string }>;
      activation?: Record<string, unknown>;
      context_policy?: Record<string, unknown>;
    };
    input_ports: Array<{
      port_id: string;
      node_id: string;
      name: string;
      direction: "input";
      event_types?: string[];
      artefact_types?: string[];
      schema_ref?: string | null;
      min_count?: number;
      max_count?: number | null;
    }>;
    output_ports: Array<{
      port_id: string;
      node_id: string;
      name: string;
      direction: "output";
      event_types?: string[];
      artefact_types?: string[];
      schema_ref?: string | null;
      min_count?: number;
      max_count?: number | null;
    }>;
  } | null;
};

/**
 * Explicit transport migration boundary for Events written before canonical
 * ArtefactVersion references were introduced. Present identifiers are
 * validated and preserved exactly; only an absent legacy field becomes [].
 */
export function normalizeEventEnvelopeAtTransport(value: EventEnvelope): EventEnvelope {
  const ids = (value as EventEnvelope & { artefact_version_ids?: unknown }).artefact_version_ids;
  if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id.trim()))) {
    throw new Error("The Bus returned an invalid Event artefact_version_ids contract.");
  }
  return {
    ...value,
    artefact_version_ids: ids === undefined ? [] : [...ids] as string[],
  };
}

function normalizeDeliveryBundleAtTransport(bundle: DeliveryBundle): DeliveryBundle {
  return {
    ...bundle,
    events: (bundle.events ?? []).map(normalizeEventEnvelopeAtTransport),
  };
}

type RuntimeActorContract = {
  actor_id: string;
  definition: {
    actor_definition_revision_id: string;
    actor_id: string;
    workspace_id: string;
    content: {
      instructions: string;
      capability_grant_ids: string[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
};

type RuntimeProfileContract = {
  binding: {
    actor_runtime_binding_id: string;
    actor_id: string;
    workspace_id: string;
    runtime_profile_revision_id: string;
    endpoint_id: string | null;
    [key: string]: unknown;
  };
  profile: {
    runtime_profile_revision_id: string;
    runtime_profile_id: string;
    content: {
      adapter_id: string;
      configuration: Record<string, unknown>;
      secret_ref_ids: string[];
      resource_policy: Record<string, unknown>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
};

type RuntimeAuthorityContract = {
  principal_id: string;
  capability_grant_ids: string[];
  authority_session_required: true;
};

export type RuntimeProcessingContract = {
  contract_kind: "scope_node";
  contract_version: 1;
  processing_contract_id: string;
  workspace_id: string;
  scope_execution: {
    execution_id: string;
    scope_id: string;
    revision_id: string;
  };
  node_execution: {
    node_execution_id: string;
    node_id: string;
    context_id: string;
    actor_definition_revision_id: string;
    runtime_profile_revision_id: string;
    actor_runtime_binding_id: string;
  };
  execution_attempt: {
    attempt_id: string;
    node_execution_id: string;
    actor_definition_revision_id: string;
    runtime_profile_revision_id: string;
    actor_runtime_binding_id: string;
    status: "pending" | "running";
  };
  placement: {
    node_id: string;
    kind: "actor";
    resource_id: string;
    bindings?: Array<{ kind: "instructions"; text: string }>;
    config?: Record<string, unknown>;
    activation?: Record<string, unknown>;
    context_policy?: Record<string, unknown>;
  };
  context: {
    context_id: string;
    inspect_operation_id: "context.inspect";
  };
  actor: RuntimeActorContract;
  runtime: RuntimeProfileContract;
  operation_authority: RuntimeAuthorityContract;
  inputs: Array<{
    input_id: string;
    port: {
      port_id: string;
      node_id: string;
      name: string;
      direction: "input";
      event_types?: string[];
      artefact_types?: string[];
      schema_ref?: string | null;
    };
    delivery_id: string;
    member_key: string;
    event: EventEnvelope;
    artefact: Record<string, unknown> | null;
  }>;
  outputs: {
    publish_operation_id: "scope.node-output.publish";
    ports: Array<{
      port_id: string;
      node_id: string;
      name: string;
      direction: "output";
      event_types?: string[];
      artefact_types?: string[];
      schema_ref?: string | null;
      min_count?: number;
      max_count?: number | null;
    }>;
  };
};

export type DirectRuntimeProcessingContract = {
  contract_kind: "direct_context";
  contract_version: 1;
  processing_contract_id: string;
  workspace_id: string;
  delivery: {
    delivery_id: string;
    stable_delivery_ids: string[];
    endpoint_id: string;
    context_id: string;
  };
  context: {
    context_id: string;
    inspect_operation_id: "context.inspect";
  };
  actor: RuntimeActorContract;
  runtime: RuntimeProfileContract;
  operation_authority: RuntimeAuthorityContract;
  events: Array<{
    event_id: string;
    type: string;
    workspace_id: string;
    context_id: string;
    content: Record<string, unknown>;
    metadata: Record<string, unknown>;
    created_at: string;
    [key: string]: unknown;
  }>;
  outputs: {
    publish_operation_id: null;
    ports: [];
  };
};

export type RuntimeDispatchContract = RuntimeProcessingContract | DirectRuntimeProcessingContract;

/**
 * Ephemeral authority issued only to the authenticated Bridge while it is
 * preparing one Delivery. The bearer is never part of a Delivery/Event
 * projection and must not be persisted by the Bridge.
 */
export type RuntimeOperationAuthoritySession = {
  authority_session_id: string;
  bearer_token: string;
  expires_at: string;
};

export type PreparedRuntimeDelivery = {
  delivery: {
    state: string;
    execution_attempt_id?: string | null;
  };
  processing_contract: RuntimeDispatchContract;
  operation_authority_session: RuntimeOperationAuthoritySession;
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
  target: {
    resource_kinds: string[];
    expected_revision: "not_applicable" | "optional" | "required";
  };
  input: { version: string; schema: Record<string, unknown> };
  result: { version: string; schema: Record<string, unknown> };
  availability:
    | { available: true }
    | { available: false; refusal: OperationRefusal };
};

export type OperationRefusal = {
  code: string;
  message: string;
  retryable: boolean;
  required_action: Record<string, unknown> | null;
  details: Record<string, unknown>;
};

export type OperationInvocationReceipt = {
  receipt_id: string;
  invocation_id: string;
  operation_id: string;
  operation_version: string;
  state: "running" | "awaiting_approval" | "accepted" | "completed" | "refused" | "outcome_unknown";
  result: unknown | null;
  refusal: OperationRefusal | null;
  changed_refs: Array<Record<string, unknown>>;
  progress_ref: Record<string, unknown> | null;
  cancel_ref: Record<string, unknown> | null;
  audit_ref: Record<string, unknown> | null;
  governance: {
    policy_evaluation_id: string | null;
    approval_request_ids: readonly string[];
    approval_receipt_ids: readonly string[];
    budget_reservation_id: string | null;
  };
  [key: string]: unknown;
};

export type OperationInvocationResponse =
  | { kind: "receipt"; replayed: boolean; receipt: OperationInvocationReceipt }
  | { kind: "conflict"; refusal: OperationRefusal; existing_receipt: OperationInvocationReceipt }
  | { kind: "rejected"; refusal: OperationRefusal };

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

export type EventCommand = Omit<EventEnvelope, "event_id" | "created_at" | "metadata" | "correlation_id" | "destination_json" | "response" | "context_id"> & {
  destination: EventEnvelope["destination_json"];
  correlation_id?: string | null;
  response?: EventEnvelope["response"];
  metadata?: Record<string, unknown>;
  idempotency_key?: string | null;
  /** Caller-supplied context the event belongs to (rule 1). When omitted, the bus resolver decides. */
  context_id?: string | null;
  /** The context_id of the delivery currently being processed. Bridge always sets this from the active turn. */
  current_delivery_context_id?: string | null;
};

export type BridgeTransportAuthorityState =
  | Readonly<{ status: "available"; audience: "bridge_service" }>
  | Readonly<{
      status: "unavailable";
      reason: "credential_missing" | "credential_not_accepted" | "insecure_transport";
    }>;

export type BridgeTransportAuthority = Readonly<{
  audience: "bridge_service";
  bearer_token: string;
}>;

export type LocalWorkspaceLocatorBinding = Readonly<{
  binding_id: string;
  workspace_id: string;
  host_id: string;
  platform: "windows" | "posix";
  locator: string;
  normalized_locator: string;
  state: "current" | "superseded";
  status: string;
  init_authorized: boolean;
  active_config_hash: string | null;
  selected_at: string | null;
  bound_at: string;
  updated_at: string;
  superseded_at: string | null;
  superseded_by_binding_id: string | null;
}>;

export type LocalWorkspaceProjection = Readonly<{
  workspace_id: string;
  name: string;
  creation_kind: "created" | "legacy_retained" | "copied" | "forked";
  source_workspace_id: string | null;
  created_at: string;
  updated_at: string;
  binding: LocalWorkspaceLocatorBinding | null;
  [key: string]: unknown;
}>;

export type RuntimeEndpointProjection = Readonly<{
  endpoint_id: string;
  actor_id: string;
  name: string;
  agent_id: string | null;
  adapter_id: string;
  actor_definition_revision_id: string;
  runtime_profile_revision_id: string;
  actor_runtime_binding_id: string;
  runtime_status: "resolved" | "unresolved";
  unresolved_reasons: readonly string[];
}>;

export type WorkspaceConfigurationImportResponse = Readonly<{
  import_result: Readonly<{
    replayed: boolean;
    receipt: Readonly<{
      import_receipt_id: string;
      workspace_id: string;
      binding_id: string;
      config_hash: string;
      outcome: "applied" | "refused";
      imported_actors: readonly Readonly<{
        source_actor_id: string;
        actor_id: string;
        actor_definition_revision_id: string;
        capability_grant_id: string | null;
        runtime_profile_id: string;
        runtime_profile_revision_id: string;
        actor_runtime_binding_id: string;
        runtime_status: "resolved" | "unresolved" | "disabled";
        unresolved_reasons: readonly string[];
        secret_ref_ids: readonly string[];
      }>[];
      refusal: Readonly<{
        code: string;
        message: string;
        retryable: boolean;
      }> | null;
    }>;
  }>;
  workspace: unknown;
}>;

/**
 * An unavailable Bridge is an authority state, not a transient network error.
 * Callers can surface this without exposing the rejected credential or relying
 * on loopback as an implicit grant.
 */
export class BridgeTransportUnavailableError extends Error {
  readonly code = "bridge_transport_unavailable";

  constructor(readonly reason: "credential_missing" | "credential_not_accepted" | "insecure_transport") {
    super(
      reason === "credential_missing"
        ? "The Bridge service credential is unavailable."
        : reason === "credential_not_accepted"
          ? "The Bridge service credential was not accepted."
          : "The Bridge service credential cannot be sent over an insecure transport.",
    );
    this.name = "BridgeTransportUnavailableError";
  }
}

export class BusClient {
  #authorityStateValue: BridgeTransportAuthorityState;
  #bearerToken: string | null;

  constructor(
    readonly baseUrl: string,
    authority?: BridgeTransportAuthority | null,
  ) {
    const token = authority?.audience === "bridge_service"
      ? authority.bearer_token.trim()
      : "";
    const secureTransport = isCredentialTransportSecure(baseUrl);
    this.#bearerToken = secureTransport ? token || null : null;
    this.#authorityStateValue = !secureTransport
      ? { status: "unavailable", reason: "insecure_transport" }
      : this.#bearerToken
        ? { status: "available", audience: "bridge_service" }
        : { status: "unavailable", reason: "credential_missing" };
  }

  get authorityState(): BridgeTransportAuthorityState {
    return this.#authorityStateValue;
  }

  requireAuthority(): void {
    if (this.#authorityStateValue.status === "unavailable") {
      throw new BridgeTransportUnavailableError(this.#authorityStateValue.reason);
    }
  }

  markAuthorityUnavailable(
    reason: "credential_missing" | "credential_not_accepted" | "insecure_transport",
  ): void {
    this.#bearerToken = null;
    this.#authorityStateValue = { status: "unavailable", reason };
  }

  async health(): Promise<unknown> {
    const path = "/health";
    const response = await fetch(`${this.baseUrl}${path}`);
    if (!response.ok) throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
    return response.json();
  }

  async registerBridge(capabilities: Record<string, unknown>): Promise<void> {
    await this.post("/v1/bridges/register", { capabilities });
  }

  async reportBridgeLiveness(): Promise<void> {
    await this.post("/v1/bridges/liveness", {});
  }

  async listWorkspaces(): Promise<LocalWorkspaceProjection[]> {
    const result = await this.get("/v1/bridge/workspace-bindings") as { workspaces: LocalWorkspaceProjection[] };
    return result.workspaces;
  }

  async discoverOperations(
    workspaceId: string,
    operationAuthorityBearer: string,
    input: {
      query?: string;
      category?: string;
      target?: { kind: string; id: string } | null;
    } = {},
  ): Promise<{ operations: SemanticOperationDescriptor[] }> {
    const params = new URLSearchParams();
    if (input.query) params.set("query", input.query);
    if (input.category) params.set("category", input.category);
    if (input.target) {
      params.set("target_kind", input.target.kind);
      params.set("target_id", input.target.id);
    }
    const suffix = params.size > 0 ? `?${params}` : "";
    return this.getWithBearer(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations${suffix}`,
      operationAuthorityBearer,
    ) as Promise<{ operations: SemanticOperationDescriptor[] }>;
  }

  /** The same authenticated, digest-checked exact-content read used by clients. */
  async readArtefactVersionContent(workspaceId: string, versionId: string, bearerToken: string): Promise<{
    bytes: Buffer;
    media_type: string;
  }> {
    const maximumBytes = 20 * 1024 * 1024;
    const path = `/v1/workspaces/${encodeURIComponent(workspaceId)}/artefact-versions/${encodeURIComponent(versionId)}/content`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: this.operationAuthorityHeaders(bearerToken), redirect: "error",
    });
    if (!response.ok) throw new Error(`Artefact content read failed: ${response.status} ${await response.text()}`);
    if (response.headers.get("x-floe-artefact-version-id") !== versionId) {
      await response.body?.cancel();
      throw new Error("The content response did not identify the requested ArtefactVersion.");
    }
    if (Number(response.headers.get("content-length")) > maximumBytes) {
      await response.body?.cancel();
      throw new Error("Artefact content exceeds the 20MB model-input limit.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("The ArtefactVersion has no readable content.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maximumBytes) {
          await reader.cancel();
          throw new Error("Artefact content exceeds the 20MB model-input limit.");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    return {
      bytes: Buffer.concat(chunks),
      media_type: (response.headers.get("content-type") ?? "application/octet-stream").split(";", 1)[0]!.trim().toLowerCase(),
    };
  }

  async invokeOperation(
    workspaceId: string,
    operationAuthorityBearer: string,
    request: {
      operation_id: string;
      operation_version: string;
      input_schema_version: string;
      target?: { kind: string; id: string } | null;
      expected_resource_revision?: string | null;
      idempotency_key: string;
      input: unknown;
    },
  ): Promise<OperationInvocationResponse> {
    return this.postWithBearer(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations/invoke`,
      request,
      operationAuthorityBearer,
    ) as Promise<OperationInvocationResponse>;
  }

  async listConfigs(): Promise<any[]> {
    const result = await this.get("/v1/configs") as { configs: any[] };
    return result.configs;
  }

  async listEndpoints(workspaceId: string): Promise<any[]> {
    const result = await this.get(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`) as { endpoints: any[] };
    return result.endpoints;
  }

  async listRuntimeEndpoints(workspaceId: string, bindingId: string): Promise<RuntimeEndpointProjection[]> {
    const result = await this.get(
      `/v1/bridge/workspaces/${encodeURIComponent(workspaceId)}/runtime-endpoints?binding_id=${encodeURIComponent(bindingId)}`,
    ) as { endpoints: RuntimeEndpointProjection[] };
    return result.endpoints;
  }

  /**
   * Fetch a context by id. Returns null when the bus reports 404. Throws on other non-2xx
   * responses or network errors — callers are expected to catch and degrade gracefully
   * (the bridge falls back to an empty participants list and logs a warning).
   */
  async getContext(contextId: string): Promise<{
    context_id: string;
    workspace_id: string;
    parent_context_id: string | null;
    created_by_endpoint_id: string | null;
    scope_id?: string | null;
    created_at: string;
    participants: string[];
  } | null> {
    const path = `/v1/contexts/${encodeURIComponent(contextId)}`;
    const response = await fetch(`${this.baseUrl}${path}`, { headers: this.authorizedHeaders() });
    if (response.status === 404) return null;
    if (!response.ok) throw await this.responseError("GET", path, response);
    return response.json() as Promise<{
      context_id: string;
      workspace_id: string;
      parent_context_id: string | null;
      created_by_endpoint_id: string | null;
      scope_id?: string | null;
      created_at: string;
      participants: string[];
    }>;
  }

  async registerEndpoint(input: Record<string, unknown>): Promise<void> {
    await this.post("/v1/endpoints/register", input);
  }

  async updateEndpointStatus(endpointId: string, status: string): Promise<void> {
    await this.post(`/v1/endpoints/${encodeURIComponent(endpointId)}/status`, { status });
  }

  async retireEndpoint(endpointId: string): Promise<{ ok: true; endpoint_id: string; status: "retired" }> {
    return this.post(`/v1/endpoints/${encodeURIComponent(endpointId)}/retire`, {}) as Promise<{
      ok: true;
      endpoint_id: string;
      status: "retired";
    }>;
  }

  async reportAttachment(workspaceId: string, input: {
    binding_id: string;
    status: string;
    config_hash?: string | null;
    error_code?: string | null;
    validation?: unknown;
  }): Promise<void> {
    await this.post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/attachment-result`, input);
  }

  async importWorkspaceConfiguration(
    workspaceId: string,
    inventory: WorkspaceConfigurationInventory,
  ): Promise<WorkspaceConfigurationImportResponse> {
    return this.post(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/import-config`,
      inventory,
    ) as Promise<WorkspaceConfigurationImportResponse>;
  }

  async claimDeliveries(): Promise<DeliveryBundle[]> {
    const result = await this.get("/v1/delivery/claim?limit=10") as { deliveries: DeliveryBundle[] };
    return (result.deliveries ?? []).map(normalizeDeliveryBundleAtTransport);
  }

  async reportDeliveryStatus(
    deliveryId: string,
    state: "injected_to_runtime" | "acknowledged" | "failed" | "dead_lettered" | "deferred",
    error?: string
  ): Promise<{
    state: string;
    attempt_count?: number;
    execution_attempt_id?: string | null;
    processing_contract?: RuntimeProcessingContract;
  }> {
    const result = await this.post(`/v1/delivery/${encodeURIComponent(deliveryId)}/status`, {
      state,
      error: error ?? null
    }) as { delivery: {
      state: string;
      attempt_count?: number;
      execution_attempt_id?: string | null;
      processing_contract?: RuntimeProcessingContract;
    } };
    return result.delivery;
  }

  async prepareRuntimeDelivery(deliveryId: string): Promise<PreparedRuntimeDelivery> {
    return this.post(
      `/v1/delivery/${encodeURIComponent(deliveryId)}/runtime-prepare`,
      {},
    ) as Promise<PreparedRuntimeDelivery>;
  }

  async readRuntimeCredential(deliveryId: string, secretRefId: string): Promise<Uint8Array> {
    const path = `/v1/delivery/${encodeURIComponent(deliveryId)}/runtime-credentials/${encodeURIComponent(secretRefId)}`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: this.authorizedHeaders({ accept: "application/octet-stream" }),
      cache: "no-store",
    });
    if (!response.ok) throw await this.responseError("GET", path, response);
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > 1024 * 1024) {
      throw new Error("The runtime credential response exceeded its bounded transport contract.");
    }
    const material = new Uint8Array(await response.arrayBuffer());
    if (material.byteLength === 0 || material.byteLength > 1024 * 1024) {
      material.fill(0);
      throw new Error("The runtime credential response was invalid.");
    }
    return material;
  }

  async replaceRuntimeCredential(
    deliveryId: string,
    secretRefId: string,
    material: Uint8Array,
  ): Promise<void> {
    if (!(material instanceof Uint8Array) || material.byteLength === 0 || material.byteLength > 1024 * 1024) {
      throw new Error("The refreshed runtime credential is invalid.");
    }
    const path = `/v1/delivery/${encodeURIComponent(deliveryId)}/runtime-credentials/${encodeURIComponent(secretRefId)}`;
    // `fetch` accepts an ArrayBuffer as a body in every runtime supported by the
    // Bridge. Slice the exact view so adjacent bytes from a pooled Buffer can
    // never cross this private transport boundary.
    const body = material.buffer.slice(
      material.byteOffset,
      material.byteOffset + material.byteLength,
    ) as ArrayBuffer;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "PUT",
      headers: this.authorizedHeaders({ "content-type": "application/octet-stream" }),
      body,
    });
    if (!response.ok) throw await this.responseError("PUT", path, response);
  }

  async emit(event: EventCommand): Promise<{
    event_id: string;
    accepted_at: string;
    event: EventEnvelope;
  }> {
    return this.post("/v1/events/emit", event) as Promise<{
      event_id: string;
      accepted_at: string;
      event: EventEnvelope;
    }>;
  }

  async reportTurnEnd(endpointId: string): Promise<void> {
    await this.post(`/v1/endpoints/${encodeURIComponent(endpointId)}/turn-end`, {});
  }

  async appendRuntimeTelemetry(input: {
    workspace_id: string;
    endpoint_id: string;
    delivery_id?: string | null;
    kind: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.post("/v1/runtime/telemetry", input);
  }

  async recordRuntimeTurnResult(input: {
    delivery_id: string;
    outcome: "completed" | "failed";
    text: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    result_event: EventEnvelope;
    return_event: EventEnvelope | null;
    request_resolved: boolean;
  }> {
    const result = await this.post("/v1/runtime/turn-result", input) as {
      result_event: EventEnvelope;
      return_event: EventEnvelope | null;
      request_resolved: boolean;
    };
    return {
      ...result,
      result_event: normalizeEventEnvelopeAtTransport(result.result_event),
      return_event: result.return_event ? normalizeEventEnvelopeAtTransport(result.return_event) : null,
    };
  }

  async resolveRuntimeBinding(workspaceId: string, endpointId: string): Promise<RuntimeBindingResolution> {
    return this.get(`/v1/runtime/bindings/resolve?workspace_id=${encodeURIComponent(workspaceId)}&endpoint_id=${encodeURIComponent(endpointId)}`) as Promise<RuntimeBindingResolution>;
  }

  async createPulse(input: {
    pulse_id: string;
    workspace_id: string;
    persistence?: "workspace" | "local";
    scope_id?: string | null;
    current_context_id?: string | null;
    trigger: { type: string; at?: string; schedule?: string; timezone?: string };
    event?: { type: "pulse.fired"; content: Record<string, unknown> };
    content?: Record<string, unknown>;
    subscribers: Array<
      | { kind: "context"; context_id: string }
      | { kind?: "endpoint"; endpoint_ref: string; context_id?: string | null }
    >;
    created_by?: string;
  }): Promise<unknown> {
    return this.post("/v1/pulses", input);
  }

  async listPulses(filters: { workspace_id?: string; status?: string; scope_id?: string }): Promise<{ pulses: unknown[] }> {
    const params = new URLSearchParams();
    if (filters.workspace_id) params.set("workspace_id", filters.workspace_id);
    if (filters.status) params.set("status", filters.status);
    if (filters.scope_id) params.set("scope_id", filters.scope_id);
    return this.get(`/v1/pulses?${params}`) as Promise<{ pulses: unknown[] }>;
  }

  async pausePulse(pulseId: string): Promise<unknown> {
    return this.post(`/v1/pulses/${encodeURIComponent(pulseId)}/pause`, {});
  }

  async resumePulse(pulseId: string): Promise<unknown> {
    return this.post(`/v1/pulses/${encodeURIComponent(pulseId)}/resume`, {});
  }

  async cancelPulse(pulseId: string): Promise<unknown> {
    return this.post(`/v1/pulses/${encodeURIComponent(pulseId)}/cancel`, {});
  }

  /** Retained legacy graphs used for remaining Event-source and Actor instruction bindings. */
  async listScopeGraphsForWorkspace(workspaceId: string): Promise<{ graphs: any[] }> {
    return this.get(`/v1/workspaces/${encodeURIComponent(workspaceId)}/graphs`) as Promise<{ graphs: any[] }>;
  }

  /**
   * Fires an existing Scope Graph trigger node — no new wake mechanism, just
   * the same `fireScopeGraphTrigger` emit path a manual trigger fire would
   * use. A world-facing doorway (e.g. a watched folder) passes arrival facts
   * (channel, locator, observed_at, raw_reference) as ordinary `content` —
   * there is no separate origin envelope; the shape of `content` is exactly
   * what the receiving node's own config decides to make of it.
   */
  async fireScopeGraphTriggerNode(
    workspaceId: string,
    graphId: string,
    nodeId: string,
    input: {
      content?: Record<string, unknown>;
      correlation_id?: string | null;
      idempotency_key?: string | null;
    } = {}
  ): Promise<{ events: EventEnvelope[] }> {
    const result = await this.post(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/graphs/${encodeURIComponent(graphId)}/nodes/${encodeURIComponent(nodeId)}/fire`,
      input
    ) as { events: EventEnvelope[] };
    return { events: (result.events ?? []).map(normalizeEventEnvelopeAtTransport) };
  }

  async requestConfigSnapshot(workspaceId: string): Promise<unknown> {
    return this.post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/config-snapshot`, {});
  }

  /**
   * Create a new context in the bus.
   * Supports optional scope_id (for card-as-context) and title.
   */
  async createContext(input: {
    workspace_id: string;
    scope_id?: string | null;
    participants?: string[];
    created_by_endpoint_id?: string | null;
    title?: string | null;
    parent_context_id?: string | null;
  }): Promise<string> {
    const result = await this.post(
      `/v1/workspaces/${encodeURIComponent(input.workspace_id)}/contexts`,
      {
        participants: input.participants ?? [],
        scope_id: input.scope_id ?? null,
        created_by_endpoint_id: input.created_by_endpoint_id ?? null,
        title: input.title ?? null,
        parent_context_id: input.parent_context_id ?? null,
      }
    ) as { context: { context_id: string } };
    return result.context.context_id;
  }

  /**
   * List all contexts for a specific scope in a workspace.
   * Uses the server-side indexed query (idx_contexts_workspace_scope).
   */
  async listContextsForScope(workspaceId: string, scopeId: string): Promise<Array<{
    context_id: string;
    workspace_id: string;
    scope_id: string | null;
    created_at: string;
    title: string | null;
    participants: string[];
  }>> {
    const url = `/v1/workspaces/${encodeURIComponent(workspaceId)}/contexts?scope_id=${encodeURIComponent(scopeId)}`;
    const result = await this.get(url) as { contexts: any[] };
    return result.contexts;
  }

  /**
   * Add an endpoint as a participant in a context (idempotent).
   * Returns whether the participant was newly added.
   */
  async addParticipant(
    contextId: string,
    endpointId: string
  ): Promise<{ added: boolean }> {
    const result = await this.post(
      `/v1/contexts/${encodeURIComponent(contextId)}/participants`,
      { endpoint_id: endpointId }
    ) as { ok: boolean; context_id: string; endpoint_id: string; added: boolean };
    return { added: result.added };
  }

  /**
   * Remove an endpoint from a context's participant list (idempotent).
   * Returns whether the participant was removed.
   */
  async removeParticipant(
    contextId: string,
    endpointId: string
  ): Promise<{ removed: boolean }> {
    const result = await this._delete(
      `/v1/contexts/${encodeURIComponent(contextId)}/participants/${encodeURIComponent(endpointId)}`
    ) as { ok: boolean; context_id: string; endpoint_id: string; removed: boolean };
    return { removed: result.removed };
  }

  /**
   * Subscribe an endpoint to event types in a context (UPSERT, idempotent).
   * eventTypes defaults to ["*"] (all events).
   * Pass [] to create a silent watcher — still a participant, never woken.
   */
  async subscribeToContext(
    contextId: string,
    endpointId: string,
    eventTypes: string[] = ["*"]
  ): Promise<void> {
    await this.post(
      `/v1/contexts/${encodeURIComponent(contextId)}/subscriptions`,
      { endpoint_id: endpointId, event_types: eventTypes }
    );
  }

  /**
   * Remove an endpoint's subscription from a context entirely.
   * Does NOT remove the endpoint from participants.
   */
  async unsubscribeFromContext(
    contextId: string,
    endpointId: string
  ): Promise<void> {
    await this._delete(
      `/v1/contexts/${encodeURIComponent(contextId)}/subscriptions/${encodeURIComponent(endpointId)}`
    );
  }

  /**
   * Batch-apply participant + subscription changes in one atomic call.
   *
   * - `entries`: each endpoint is added as a participant AND gets its subscription
   *   upserted with the given `event_types`. Pass `[]` to create a silent watcher.
   * - `participantsOnly`: endpoints added as participants with no subscription change.
   *
   * Maps to `POST /v1/contexts/:id/subscriptions:batch`.
   */
  async applyContextSubscriptions(
    contextId: string,
    entries: Array<{ endpoint_id: string; event_types: string[] }>,
    participantsOnly: string[] = []
  ): Promise<void> {
    await this.post(
      `/v1/contexts/${encodeURIComponent(contextId)}/subscriptions:batch`,
      { entries, participants_only: participantsOnly }
    );
  }

  /**
   * List all subscriptions for a context.
   */
  async listContextSubscriptions(
    contextId: string
  ): Promise<Array<{ endpoint_id: string; event_types: string[]; subscribed_at: string }>> {
    const result = await this.get(
      `/v1/contexts/${encodeURIComponent(contextId)}/subscriptions`
    ) as { subscriptions: Array<{ endpoint_id: string; event_types: string[]; subscribed_at: string }> };
    return result.subscriptions;
  }

  /**
   * List events for a context in either direction from an optional cursor.
   * Returns a chronological page and the Bus cursor for that direction. Runtime actors use
   * this deliberately through the Context-history tool; it is not prompt injection.
   */
  async listContextEvents(
    contextId: string,
    cursor?: string | null,
    limit?: number,
    direction: "forward" | "backward" = "forward",
  ): Promise<{ events: EventEnvelope[]; next_cursor: string | null }> {
    const params = new URLSearchParams({ context_id: contextId, direction });
    if (cursor) params.set(direction === "backward" ? "before" : "since", cursor);
    if (limit != null) params.set("limit", String(limit));
    const result = await this.get(`/v1/events?${params}`) as { events: EventEnvelope[]; next_cursor: string | null; previous_cursor?: string | null };
    return {
      events: (result.events ?? []).map(normalizeEventEnvelopeAtTransport),
      next_cursor: (direction === "backward" ? result.previous_cursor : result.next_cursor) ?? null,
    };
  }

  /**
   * List child contexts whose parent_context_id equals contextId.
   * Used for epic→card links.
   */
  async listChildContexts(
    contextId: string
  ): Promise<Array<{ context_id: string; workspace_id: string; scope_id: string | null; created_at: string; title: string | null; participants: string[] }>> {
    const result = await this.get(
      `/v1/contexts/${encodeURIComponent(contextId)}/children`
    ) as { contexts: Array<{ context_id: string; workspace_id: string; scope_id: string | null; created_at: string; title: string | null; participants: string[] }> };
    return result.contexts;
  }

  // ---------------------------------------------------------------------------
  private async _delete(path: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: this.authorizedHeaders(),
    });
    if (!response.ok) throw await this.responseError("DELETE", path, response);
    return response.json();
  }

  private async get(path: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, { headers: this.authorizedHeaders() });
    if (!response.ok) throw await this.responseError("GET", path, response);
    return response.json();
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.authorizedHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(body)
    });
    if (!response.ok) throw await this.responseError("POST", path, response);
    return response.json();
  }

  private async getWithBearer(path: string, bearerToken: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: this.operationAuthorityHeaders(bearerToken),
    });
    if (!response.ok) {
      throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
    }
    return response.json();
  }

  private async postWithBearer(path: string, body: unknown, bearerToken: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.operationAuthorityHeaders(bearerToken, { "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`POST ${path} failed: ${response.status} ${await response.text()}`);
    }
    return response.json();
  }

  private operationAuthorityHeaders(
    bearerToken: string,
    additional: Record<string, string> = {},
  ): Record<string, string> {
    const token = bearerToken.trim();
    if (!token) throw new Error("The active Delivery has no operation authority session.");
    if (!isCredentialTransportSecure(this.baseUrl)) {
      throw new Error("Operation authority cannot cross an insecure transport.");
    }
    return {
      ...additional,
      authorization: `Bearer ${token}`,
    };
  }

  private authorizedHeaders(additional: Record<string, string> = {}): Record<string, string> {
    this.requireAuthority();
    return {
      ...additional,
      authorization: `Bearer ${this.#bearerToken}`,
    };
  }

  private async responseError(
    method: string,
    path: string,
    response: Pick<Response, "status" | "text">,
  ): Promise<Error> {
    if (response.status === 401) {
      // A 401 also means this route requires a different credential audience.
      // One refused watcher/operation must not poison the shared Bridge client.
      // Verify once against an existing Bridge-only read before discarding its
      // credential. This is failure-triggered, not a recurring liveness check.
      const bridgeReadPath = "/v1/bridge/workspace-bindings";
      let bridgeRejected = path === bridgeReadPath;
      if (!bridgeRejected && this.#bearerToken) {
        try {
          const probe = await fetch(`${this.baseUrl}${bridgeReadPath}`, {
            headers: this.authorizedHeaders(), signal: AbortSignal.timeout(5_000),
          });
          bridgeRejected = probe.status === 401;
          await probe.body?.cancel();
        } catch {
          // A network failure cannot establish that a credential is invalid.
          // The original operation remains refused; no authority is widened.
        }
      }
      if (bridgeRejected) {
        this.markAuthorityUnavailable("credential_not_accepted");
        return new BridgeTransportUnavailableError("credential_not_accepted");
      }
    }
    return new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
  }
}

/** Credentials may cross TLS, or a loopback-only cleartext transport. */
export function isCredentialTransportSecure(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "wss:") return true;
    if (url.protocol !== "http:" && url.protocol !== "ws:") return false;
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}
