export { SUBSTRATE_GUIDANCE, buildSystemPrompt, renderDestinationContext } from "./guidance.js";
export { deliveryToPrompt, eventContentToPrompt, eventAttachments } from "./delivery-prompt.js";
export type { EventAttachment } from "./delivery-prompt.js";
export { renderHookInjections } from "./hook-injections.js";
export { toNeutralRef, fromNeutralRef, toNeutralEndpoint } from "./neutral-ref.js";
export type { NeutralEndpoint } from "./neutral-ref.js";
export { appendWorkLog } from "./worklog.js";
export type { WorkLogEntry, WorkLogEvent, WorkLogToolEntry, WorkLogEmitEntry } from "./worklog.js";
export type {
  DestinationContext,
  AllowedDestination,
  EndpointProcessingInput,
  DeliveredEvent,
  LifecycleOutcome,
  EndpointProcessingOutput,
  EmittedEvent,
  TelemetryEntry,
  ProcessingError,
  EmitContract,
  FloeRuntimeContract,
  DeliveryRenderingPolicy,
  RuntimeInstructionSet,
} from "./types.js";
