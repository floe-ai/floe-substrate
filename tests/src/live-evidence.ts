export type LiveToolCase = "emit-success" | "use-capability-denied";

export type LiveToolEvidence = {
  schema: "floe.live-tool-evidence.v1";
  case: LiveToolCase;
  captured_at: string;
  trigger: {
    event_id: string | null;
    source_endpoint_id: string | null;
  };
  runtime: {
    turn_id: string | null;
    sdk_session_id: string | null;
    offered_tool_names: string[];
    registration_acknowledgement: {
      exposed: false;
      reason: string;
    } | null;
    exposure_proof: {
      kind: "first_exact_callback";
      tool_call_id: string;
    } | null;
  };
  delivery: {
    delivery_id: string | null;
    trigger_event_id: string | null;
    final_state: string | null;
  };
  tool_call: {
    call_id: string | null;
    name: string | null;
    arguments: Record<string, unknown> | null;
    provenance: string | null;
    lifecycle: string | null;
    result_type: string | null;
    result_value: string | null;
    denial_code: string | null;
    receipt_refusal_code: string | null;
  };
  emitted_event: {
    event_id: string;
    provenance: string;
    runtime_turn_id: string;
    delivery_id: string;
    payload: unknown;
  } | null;
  turn_result: {
    event_id: string | null;
    payload: unknown;
  } | null;
  delivery_acknowledgement: {
    frame: "delivery_acknowledged";
    payload: unknown;
  } | null;
};

export type LiveEvidenceInputs = {
  case: LiveToolCase;
  trigger_event_id: string;
  trigger_source_endpoint_id: string;
  deliveries: unknown[];
  telemetry: unknown[];
  events: unknown[];
  bus_messages: unknown[];
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function telemetryPayload(value: unknown): UnknownRecord {
  const row = record(value);
  if (typeof row.payload_json === "string") {
    try {
      return record(JSON.parse(row.payload_json));
    } catch {
      return {};
    }
  }
  return record(row.payload);
}

function eventData(value: unknown): UnknownRecord {
  return record(record(record(value).content).data);
}

function eventOrigin(value: unknown): string | null {
  const event = record(value);
  return string(record(event.metadata).origin) ?? string(eventData(value).origin);
}

export function assembleLiveToolEvidence(input: LiveEvidenceInputs): Partial<LiveToolEvidence> {
  const delivery = input.deliveries
    .map(record)
    .find(row => row.trigger_event_id === input.trigger_event_id) ?? {};
  const deliveryId = string(delivery.delivery_id);
  const telemetry = input.telemetry
    .map(record)
    .filter(row => row.delivery_id === deliveryId);
  const triggerEvent = input.events
    .map(record)
    .find(event => event.event_id === input.trigger_event_id);
  const sdkRecord = telemetry.find(row => row.kind === "sdk_tool_evidence");
  const sdkPayload = telemetryPayload(sdkRecord);
  const calls = Array.isArray(sdkPayload.tool_calls)
    ? sdkPayload.tool_calls.map(record)
    : [];
  const toolCall = calls.length === 1 ? calls[0]! : {};
  const turnRecord = telemetry.find(row => row.kind === "turn_result");
  const turnPayload = telemetryPayload(turnRecord);
  const resultEventId = string(turnPayload.result_event_id);
  const resultEvent = input.events.map(record).find(event => event.event_id === resultEventId);
  const runtimeTurnId = string(sdkPayload.runtime_turn_id);
  const emitted = input.events.map(record).find(event =>
    eventOrigin(event) === "floe_emit_tool"
    && eventData(event).runtime_turn_id === runtimeTurnId
    && eventData(event).delivery_id === deliveryId
  );
  const acknowledgement = input.bus_messages.map(record).find(message => {
    const payload = record(message.payload);
    return message.type === "delivery_acknowledged" && payload.delivery_id === deliveryId;
  });
  const registration = record(sdkPayload.registration_acknowledgement);
  const exposure = record(sdkPayload.exposure_proof);

  return {
    schema: "floe.live-tool-evidence.v1",
    case: input.case,
    captured_at: new Date().toISOString(),
    trigger: {
      event_id: string(triggerEvent?.event_id),
      source_endpoint_id: string(triggerEvent?.source_endpoint_id),
    },
    runtime: {
      turn_id: runtimeTurnId,
      sdk_session_id: string(sdkPayload.sdk_session_id),
      offered_tool_names: Array.isArray(sdkPayload.offered_tool_names)
        ? sdkPayload.offered_tool_names.filter((name): name is string => typeof name === "string")
        : [],
      registration_acknowledgement: registration.exposed === false && typeof registration.reason === "string"
        ? { exposed: false, reason: registration.reason }
        : null,
      exposure_proof: exposure.kind === "first_exact_callback" && typeof exposure.tool_call_id === "string"
        ? { kind: "first_exact_callback", tool_call_id: exposure.tool_call_id }
        : null,
    },
    delivery: {
      delivery_id: deliveryId,
      trigger_event_id: string(delivery.trigger_event_id),
      final_state: string(delivery.state),
    },
    tool_call: {
      call_id: string(toolCall.call_id),
      name: string(toolCall.name),
      arguments: isRecord(toolCall.arguments) ? toolCall.arguments : null,
      provenance: string(toolCall.provenance),
      lifecycle: string(toolCall.lifecycle),
      result_type: string(toolCall.result_type),
      result_value: string(toolCall.result_value),
      denial_code: string(toolCall.result_code),
      receipt_refusal_code: string(turnPayload.result_refusal_code),
    },
    emitted_event:
      emitted
      && string(emitted.event_id)
      && eventOrigin(emitted)
      && string(eventData(emitted).runtime_turn_id)
      && string(eventData(emitted).delivery_id)
        ? {
            event_id: string(emitted.event_id)!,
            provenance: eventOrigin(emitted)!,
            runtime_turn_id: string(eventData(emitted).runtime_turn_id)!,
            delivery_id: string(eventData(emitted).delivery_id)!,
            payload: emitted,
          }
        : null,
    turn_result: {
      event_id: resultEventId,
      payload: resultEvent ?? null,
    },
    delivery_acknowledgement: acknowledgement ? {
      frame: "delivery_acknowledged",
      payload: acknowledgement.payload ?? null,
    } : null,
  };
}

const ALL_TOOLS = [
  "emit", "request", "discover_capabilities", "use_capability",
  "create_pulse", "list_pulses", "pause_pulse", "resume_pulse",
  "cancel_pulse", "read_artefact",
];

type CompleteLiveToolEvidence = Omit<LiveToolEvidence, "turn_result" | "delivery_acknowledgement"> & {
  turn_result: NonNullable<LiveToolEvidence["turn_result"]>;
  delivery_acknowledgement: NonNullable<LiveToolEvidence["delivery_acknowledgement"]>;
};

function isFullyFormed(evidence: Partial<LiveToolEvidence>): evidence is CompleteLiveToolEvidence {
  return !!evidence.case &&
    !!evidence.trigger &&
    !!evidence.delivery &&
    !!evidence.runtime &&
    !!evidence.tool_call &&
    !!evidence.turn_result &&
    !!evidence.delivery_acknowledgement;
}

export function assertExactLiveToolEvidence(evidence: Partial<LiveToolEvidence>): asserts evidence is LiveToolEvidence {
  const { case: caseName } = evidence;
  const fail = (message: string): never => {
    throw new Error(`Invalid ${caseName ?? "unknown"} evidence: ${message}`);
  };

  if (!isFullyFormed(evidence)) {
    throw new Error(`Invalid ${caseName ?? "unknown"} evidence: Incomplete evidence object`);
  }

  const { trigger, delivery, runtime, tool_call, turn_result, delivery_acknowledgement, emitted_event } = evidence;
  const expectedTool = caseName === "emit-success" ? "emit" : "use_capability";

  if (!trigger.event_id || !trigger.source_endpoint_id) fail("trigger identity is incomplete");
  if (!delivery.delivery_id) fail("server-created delivery ID is missing");
  if (delivery.trigger_event_id !== trigger.event_id) fail("delivery does not reference the trigger Event");
  if (delivery.final_state !== "acknowledged") fail("final durable delivery state is not acknowledged");
  if (!runtime.turn_id || !runtime.sdk_session_id) fail("runtime turn or SDK session identity is missing");

  if (
    runtime.offered_tool_names.length !== ALL_TOOLS.length ||
    ALL_TOOLS.some(tool => !runtime.offered_tool_names?.includes(tool))
  ) {
    fail("not all direct tools were offered");
  }

  if (record(delivery_acknowledgement.payload).delivery_id !== delivery.delivery_id) {
    fail("delivery acknowledgement does not reference the delivery");
  }

  if (!runtime.registration_acknowledgement || runtime.registration_acknowledgement.exposed !== false) {
    fail("the SDK registration acknowledgement limitation is not encoded");
  }
  if (!tool_call.call_id || tool_call.name !== expectedTool) fail(`expected exactly one ${expectedTool} callback`);
  if (runtime.exposure_proof?.tool_call_id !== tool_call.call_id) {
    fail("SDK exposure proof does not reference the exact tool callback");
  }
  if (tool_call.provenance !== "floe_direct_tool_callback") fail("tool callback provenance is wrong");
  if (tool_call.lifecycle !== (caseName === "emit-success" ? "completed" : "failed")) {
    fail("tool lifecycle does not match the case outcome");
  }
  if (!tool_call.arguments || Object.keys(tool_call.arguments).length === 0 || !tool_call.result_type || !tool_call.result_value) {
    fail("tool arguments or handler result is missing");
  }

  if (!turn_result.event_id || !turn_result.payload) fail("turn-result Event is missing");
  const turnResultPayload = record(turn_result.payload);
  const turnResultData = eventData(turnResultPayload);
  if (
    string(turnResultData.delivery_id) !== delivery.delivery_id
    || string(record(turnResultPayload.metadata).runtime_turn_id) !== runtime.turn_id
  ) fail("turn-result Event does not match the delivery and runtime turn");

  if (caseName === "emit-success") {
    if (tool_call.result_type !== "success" || tool_call.denial_code !== null) {
      fail("emit result is not an unambiguous success");
    }
    if (
      !emitted_event
      || emitted_event.provenance !== "floe_emit_tool"
      || emitted_event.runtime_turn_id !== runtime.turn_id
      || emitted_event.delivery_id !== delivery.delivery_id
    ) fail("emitted Event provenance or correlation is wrong");
  } else {
    if (emitted_event !== null) fail("denial case contains an allowed emit");
    const args = tool_call.arguments;
    if (!args) {
      throw new Error(`Invalid ${caseName ?? "unknown"} evidence: denial case is missing arguments`);
    }
    const input = args["input"];
    if (
      tool_call.result_type !== "failure"
      || tool_call.denial_code !== "operation_grant_required"
      || tool_call.receipt_refusal_code !== "operation_grant_required"
      || args["operation_id"] !== "command.list"
      || args["operation_version"] !== "1"
      || args["input_schema_version"] !== "1"
      || !isRecord(input) || Object.keys(input).length !== 0
    ) {
      fail("denial case is not the exact ungranted command.list@1 operation");
    }
  }
}
