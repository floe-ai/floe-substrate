/**
 * Floe Runtime Core Contract
 *
 * This module defines the Floe-native endpoint processing contract.
 * It sits between floe-bridge (the service boundary) and any runtime adapter
 * (e.g., PiRuntimeAdapter). Code above this contract should not need to know
 * the internal assumptions of any specific runtime engine.
 *
 * Stack:
 *   floe-bus
 *   → floe-bridge
 *   → floe-runtime-core contract (this module)
 *   → RuntimeAdapter implementation (e.g., PiRuntimeAdapter)
 *   → runtime engine (e.g., pi-agent-core → pi-ai)
 */

// ---------------------------------------------------------------------------
// Endpoint Processing Input
// ---------------------------------------------------------------------------

/**
 * Destination context provided to the endpoint for the current processing cycle.
 * Agents use this to reply without hard-coded endpoint ids.
 */
export type DestinationContext = {
  /** The endpoint that sent the triggering event */
  source_endpoint_id: string;
  /** Where to send a reply (defaults to source) */
  reply_destination_endpoint_id: string;
  /** The thread this delivery belongs to */
  thread_id: string;
  /** Correlation id if responding to a correlated request */
  correlation_id: string | null;
  /** Addressable destinations the endpoint is allowed to emit to, if known */
  allowed_destinations?: AllowedDestination[];
};

export type AllowedDestination = {
  endpoint_id: string;
  name: string;
};

/**
 * The complete input provided to an endpoint's processing cycle.
 * This is the Floe-native contract — runtime adapters translate this into
 * whatever their engine expects.
 */
export type EndpointProcessingInput = {
  /** Identity of the endpoint being invoked */
  endpoint_id: string;
  /** Workspace context */
  workspace_id: string;
  /** Delivered events to process */
  delivered_events: DeliveredEvent[];
  /** Thread/channel context */
  destination_context: DestinationContext;
  /** Runtime instructions (agent persona, skills, etc.) */
  instructions: string;
  /** Available tool/capability declarations */
  available_capabilities: string[];
  /** Delivery metadata for lifecycle tracking */
  delivery_id: string;
};

/**
 * A single delivered event in Floe-native form.
 * Stripped of bus-internal routing fields.
 */
export type DeliveredEvent = {
  event_id: string;
  type: string;
  source_endpoint_id: string;
  thread_id: string;
  correlation_id: string | null;
  /** Exact immutable ArtefactVersion inputs carried by the Event. */
  artefact_version_ids: string[];
  content: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
};

// ---------------------------------------------------------------------------
// Endpoint Processing Output
// ---------------------------------------------------------------------------

/** Lifecycle outcome of a processing cycle */
export type LifecycleOutcome =
  | "completed"       // Endpoint finished processing; no pending work
  | "waiting"         // Endpoint established a durable dependency
  | "error"           // Processing failed
  | "timeout";        // Processing exceeded time budget

/**
 * The result of an endpoint's processing cycle.
 */
export type EndpointProcessingOutput = {
  /** Events explicitly emitted during processing */
  emitted_events: EmittedEvent[];
  /** Non-empty natural completion to record locally in the originating Context */
  turn_result: string | null;
  /** How the processing cycle ended */
  lifecycle_outcome: LifecycleOutcome;
  /** Telemetry collected during processing */
  telemetry: TelemetryEntry[];
  /** Errors encountered */
  errors: ProcessingError[];
};

export type EmittedEvent = {
  type: string;
  destination_endpoint_id: string;
  thread_id: string;
  correlation_id?: string | null;
  content: Record<string, unknown>;
  response_expected: boolean;
};

export type TelemetryEntry = {
  kind: string;
  payload: Record<string, unknown>;
  timestamp: string;
};

export type ProcessingError = {
  code: string;
  message: string;
  recoverable: boolean;
};

// ---------------------------------------------------------------------------
// Emit Contract
// ---------------------------------------------------------------------------

/**
 * The emit operation as seen by the runtime.
 * This is the substrate publish primitive exposed to endpoints.
 */
export type EmitContract = {
  type: string;
  destination?: {
    kind: "endpoint" | "broadcast" | "context";
    endpoint_id?: string;
    scope?: "workspace";
    target?: string;
    exclude_source?: boolean;
    context_id?: string;
  };
  text: string;
  response_expected?: boolean;
  correlation_id?: string | null;
};

// ---------------------------------------------------------------------------
// Runtime Adapter (Floe-native contract)
// ---------------------------------------------------------------------------

/**
 * A runtime adapter translates between the Floe-native processing contract
 * and a specific runtime engine.
 *
 * The existing RuntimeAdapter interface in adapters/runtime-adapter.ts remains
 * the operational interface for V0. This contract documents the intended
 * semantic boundary that adapters should respect.
 */
export interface FloeRuntimeContract {
  readonly name: string;

  /**
   * Process a delivery bundle through the runtime engine.
   *
   * The adapter is responsible for:
   * 1. Translating EndpointProcessingInput into engine-native form
   * 2. Executing the processing cycle
   * 3. Capturing a local turn result, emitted events, and telemetry
   * 4. Returning EndpointProcessingOutput
   *
   * The adapter must NOT:
   * - Expose engine-internal message/role assumptions above this boundary
   * - Assume all events are human prompts
   * - Treat turn end as a message
   */
  process(input: EndpointProcessingInput): Promise<EndpointProcessingOutput>;
}

// ---------------------------------------------------------------------------
// Delivery Rendering Policy
// ---------------------------------------------------------------------------

/**
 * Controls how delivered events are rendered for the runtime engine.
 *
 * Different engines have different input models. The adapter owns rendering,
 * but the policy declares Floe-level preferences.
 */
export type DeliveryRenderingPolicy = {
  /** Include full event metadata in rendered input */
  include_metadata: boolean;
  /** Include destination context as structured preamble */
  include_destination_context: boolean;
  /** Maximum events to render (oldest trimmed first) */
  max_events?: number;
};

// ---------------------------------------------------------------------------
// Runtime Instruction Set
// ---------------------------------------------------------------------------

/**
 * The assembled instruction context for an endpoint's processing cycle.
 * Built by floe-bridge before invoking the adapter.
 */
export type RuntimeInstructionSet = {
  /** Base agent persona/instructions from .floe/agents/*.md */
  agent_instructions: string;
  /** Substrate guidance (actor/event/emit/turn semantics) */
  substrate_guidance: string;
  /** Extension-provided instruction profiles */
  extension_profiles: string[];
  /** Skill-provided context */
  skill_context: string[];
};
