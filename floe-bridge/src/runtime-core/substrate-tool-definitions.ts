/**
 * @invariant This module is the sole Bridge owner of shared substrate-tool
 * contracts. Runtime adapters consume these transport-neutral names,
 * descriptions, Zod schemas, inferred inputs, and presentation metadata
 * without redefining or weakening them.
 */
import { z } from "zod";
import type { BusClient } from "../bus-client.js";
import type { OperationAuthorityTurn } from "./substrate-authority.js";
import type { EmittedEventSummary, SubstrateToolIdentity, SubstrateTurnAnchor } from "./substrate-tools.js";

export type SubstrateActiveTurn = OperationAuthorityTurn & {
  workspace_id: string;
  context_id: string | null;
  workspace_locator: string | null;
};

export type SubstrateSessionHandle = {
  getBus: () => BusClient;
  getAnchor: () => SubstrateTurnAnchor | null;
  getActiveTurn: () => SubstrateActiveTurn | null;
  isDependencyRequested: () => boolean;
  markDependencyRequested: () => void;
  recordEmitted: (summary: EmittedEventSummary) => void;
  recordToolActivity: (entry: {
    name: string;
    call_id?: string;
    lifecycle?: "started" | "completed" | "failed";
    provenance?: string;
    is_error?: boolean;
    arguments?: Record<string, unknown>;
    result_type?: "success" | "failure";
    result_value?: string;
    result_code?: string;
  }) => void;
};

export const FLOE_DIRECT_TOOL_CALLBACK_PROVENANCE = "floe_direct_tool_callback";

export const FLOE_RUNTIME_TOOL_IDENTITY: SubstrateToolIdentity = {
  runtimeName: "floe-runtime",
  emitOrigin: "floe_emit_tool",
  requestOrigin: "floe_request_tool",
};

export const EMIT_INPUT_SCHEMA = z.object({
  type: z.string(),
  destination: z.string().describe("A neutral actor ref from list_endpoints, or 'current_context'."),
  text: z.string(),
  references: z.array(z.object({
    name: z.string().min(1).describe("Useful name shown on the Open button, such as Local preview approval."),
    resource_ref: z.object({
      kind: z.string().min(1),
      id: z.string().min(1),
      revision: z.union([z.string().min(1), z.null()]),
    }).describe("Exact resource reference returned by an operation. Do not infer kind or revision from an ID."),
  })).optional(),
  attachments: z.array(z.object({
    artefact_version_id: z.string().min(1).describe("Exact published ArtefactVersion to attach."),
    name: z.string().min(1).describe("Clear result name shown on the attachment button."),
  })).optional(),
  artefact_version_ids: z.array(z.string()).optional().describe("Additional exact published ArtefactVersion IDs without display names."),
  data: z.record(z.string(), z.unknown()).optional().describe("Optional structured Event data. Use only when a client or extension contract requires it."),
});
export type EmitInput = z.infer<typeof EMIT_INPUT_SCHEMA>;

export const REQUEST_INPUT_SCHEMA = z.object({
  actor: z.string().describe("A neutral actor ref from list_endpoints."),
  work: z.string().describe("The bounded work or question for that actor."),
  artefact_version_ids: z.array(z.string().min(1)).optional().describe("Exact published input versions for the actor to inspect with read_artefact."),
});
export type RequestInput = z.infer<typeof REQUEST_INPUT_SCHEMA>;

const CAPABILITY_TARGET_SCHEMA = z.object({
  kind: z.string().min(1).describe("Canonical resource kind"),
  id: z.string().min(1).describe("Canonical resource id"),
});

export const DISCOVER_CAPABILITIES_INPUT_SCHEMA = z.object({
  query: z.string().optional().describe("One or two specific keywords. Long sentences match unrelated operations."),
  operation_id: z.string().optional().describe("Exact operation_id from a search result; returns this operation's authoritative input contract."),
  include_result_schema: z.boolean().optional().describe("Include the selected operation's full result schema when building an integration. Ordinary invocation returns its result directly."),
  category: z.string().optional().describe("Optional category returned by an earlier discovery."),
  target: CAPABILITY_TARGET_SCHEMA.optional().describe("Optional selected resource used to evaluate target-specific availability. Omit until the operation's target kind is known from discovery."),
  limit: z.number().min(1).max(20).optional().describe("Maximum matching operations to return."),
});
export type DiscoverCapabilitiesInput = z.infer<typeof DISCOVER_CAPABILITIES_INPUT_SCHEMA>;

export const USE_CAPABILITY_INPUT_SCHEMA = z.object({
  operation_id: z.string().min(1).describe("Exact operation_id returned by discover_capabilities."),
  operation_version: z.string().min(1).describe("Exact operation_version returned by discover_capabilities."),
  input_schema_version: z.string().min(1).describe("Exact input.version returned by discover_capabilities."),
  target: CAPABILITY_TARGET_SCHEMA.optional().describe("Target required by the discovered operation, when applicable."),
  expected_resource_revision: z.string().optional().describe("Exact target revision when the operation requires or accepts optimistic concurrency."),
  idempotency_key: z.string().optional().describe("Stable caller key. Reuse it after a timeout when the operation outcome is unknown."),
  input: z.record(z.string(), z.unknown()).describe("Input matching the exact discovered input.schema."),
});
export type UseCapabilityInput = z.infer<typeof USE_CAPABILITY_INPUT_SCHEMA>;

const PULSE_SUBSCRIBER_SCHEMA = z.union([
  z.object({
    kind: z.literal("context"),
    context_id: z.string().min(1).describe("Context that should render the pulse.fired event without waking an actor."),
  }),
  z.object({
    kind: z.literal("endpoint").optional(),
    endpoint_ref: z.string().min(1).describe("Neutral actor ref that should receive the pulse delivery as work."),
    context_id: z.string().min(1).optional().describe("Context associated with this endpoint delivery for reply/continuation."),
  }),
]);

const PULSE_CONTENT_SCHEMA = z.object({
  text: z.string().optional().describe("Text to render for context subscribers."),
  instructions: z.string().optional().describe("Instructions for endpoint subscribers to process when delivered."),
});

export const CREATE_PULSE_INPUT_SCHEMA = z.object({
  pulse_id: z.string().min(1).describe("Unique pulse identifier within the workspace."),
  trigger: z.object({
    type: z.enum(["once", "cron"]).describe("'once' for a one-off scheduled pulse, 'cron' for a recurring one."),
    at: z.string().optional().describe("ISO 8601 timestamp for one-off pulses, or relative text like '30 seconds from now'."),
    after_seconds: z.number().optional().describe("Relative one-off delay in seconds. Use 30 for '30 seconds from now'."),
    schedule: z.string().optional().describe("Cron expression for recurring pulses."),
    timezone: z.string().optional().describe("IANA timezone (default: UTC)."),
  }).describe("When the pulse fires."),
  event: z.object({
    type: z.literal("pulse.fired"),
    content: PULSE_CONTENT_SCHEMA.optional(),
  }).optional().describe("The pulse.fired event content delivered to subscribers."),
  content: PULSE_CONTENT_SCHEMA.optional().describe("Alias for event.content; prefer event.content."),
  subscribers: z.array(PULSE_SUBSCRIBER_SCHEMA).describe("Who receives the pulse: context subscribers render it, endpoint subscribers act on it."),
  persistence: z.enum(["workspace", "local"]).optional().describe("'workspace' persists into committed floe.yaml; 'local' is runtime-backed (default)."),
  scope_id: z.string().optional().describe("Optional organising Scope id. Omit unless a Scope must own the pulse."),
});
export type CreatePulseInput = z.infer<typeof CREATE_PULSE_INPUT_SCHEMA>;

export const LIST_PULSES_INPUT_SCHEMA = z.object({
  status: z.string().optional().describe("Filter by status: active, paused, cancelled, or fired."),
});
export type ListPulsesInput = z.infer<typeof LIST_PULSES_INPUT_SCHEMA>;

export const PULSE_ID_INPUT_SCHEMA = z.object({
  pulse_id: z.string().min(1).describe("The exact pulse identifier."),
});
export type PulseIdInput = z.infer<typeof PULSE_ID_INPUT_SCHEMA>;

export const READ_ARTEFACT_INPUT_SCHEMA = z.object({
  artefact_version_id: z.string().min(1).describe("Exact immutable ArtefactVersion identity to read."),
  offset: z.number().int().min(0).optional().describe("Text offset (UTF-16 units), starting at 0. Use the previous page's next_offset to continue."),
  limit: z.number().int().min(1).max(16_000).optional().describe("Maximum text units to return (default 16,000). Smaller for a focused inspection."),
});
export type ReadArtefactInput = z.infer<typeof READ_ARTEFACT_INPUT_SCHEMA>;

export const SUBSTRATE_TOOL_DEFINITIONS = {
  emit: {
    name: "emit",
    title: "Emit Floe Event",
    description: "Deliberately publish an event that should cause or communicate something beyond your local turn result. Use attachments for named, openable saved results and references for named links to records returned by discovered operations, such as a saved approval. A reference is navigation, not proof of approval or authority. The returned Event reference confirms acceptance and its exact attachments. Your normal final answer is already recorded in the current Context. Use 'current_context' as the destination only when you intentionally want Context subscription/effect semantics.",
    inputSchema: EMIT_INPUT_SCHEMA,
  },
  request: {
    name: "request",
    title: "Request Actor Work",
    description: "Ask one actor for work whose result you need before continuing. Attach the exact published ArtefactVersion IDs when the work concerns saved inputs. Floe stores the dependency, ends this processing cycle normally, and resumes you when that actor completes or fails. The return path is automatic.",
    inputSchema: REQUEST_INPUT_SCHEMA,
  },
  discoverCapabilities: {
    name: "discover_capabilities",
    title: "Discover Capabilities",
    description: "Find current Bus operations for a concrete need. Search returns short summaries. Pass an operation_id from a summary to load its exact input contract before using it. Reuse a discovered contract within this turn; rediscover after a version or authority refusal.",
    inputSchema: DISCOVER_CAPABILITIES_INPUT_SCHEMA,
  },
  useCapability: {
    name: "use_capability",
    title: "Use Capability",
    description: "Invoke one Bus semantic operation using the exact operation and input-schema versions returned by discover_capabilities. Authority and causal provenance come from the active Delivery, not from this input.",
    inputSchema: USE_CAPABILITY_INPUT_SCHEMA,
  },
  createPulse: {
    name: "create_pulse",
    title: "Create Pulse",
    description: "Create a scheduled pulse that fires canonical pulse.fired events to its subscribers. Use trigger.type 'once' with trigger.at (or trigger.after_seconds) for a one-off, or 'cron' with trigger.schedule for recurring. Use a context subscriber to render a reminder in a conversation; use an endpoint subscriber to wake an actor. Use persistence 'workspace' to persist into committed floe.yaml, or 'local' (default) for a runtime-backed pulse.",
    inputSchema: CREATE_PULSE_INPUT_SCHEMA,
  },
  listPulses: {
    name: "list_pulses",
    title: "List Pulses",
    description: "List pulses registered for this workspace. Optionally filter by status (active, paused, cancelled, fired).",
    inputSchema: LIST_PULSES_INPUT_SCHEMA,
  },
  pausePulse: {
    name: "pause_pulse",
    title: "Pause Pulse",
    description: "Pause an active pulse. It stops firing until resumed.",
    inputSchema: PULSE_ID_INPUT_SCHEMA,
  },
  resumePulse: {
    name: "resume_pulse",
    title: "Resume Pulse",
    description: "Resume a paused pulse. Cron pulses recompute their next fire from now.",
    inputSchema: PULSE_ID_INPUT_SCHEMA,
  },
  cancelPulse: {
    name: "cancel_pulse",
    title: "Cancel Pulse",
    description: "Permanently cancel a pulse. This cannot be undone.",
    inputSchema: PULSE_ID_INPUT_SCHEMA,
  },
  readArtefact: {
    name: "read_artefact",
    title: "Read Shared Content",
    description: "Read one exact ArtefactVersion shared into your work. Images enter your model context for visual inspection. Text returns a bounded page; use next_offset to read the remainder without rereading a mutable workspace file. Uses your active Delivery authority and verifies the saved content, up to 20MB.",
    inputSchema: READ_ARTEFACT_INPUT_SCHEMA,
  },
} as const;
