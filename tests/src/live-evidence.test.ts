import { describe, expect, it } from "vitest";
import {
  assertExactLiveToolEvidence,
  type LiveToolEvidence,
} from "./live-evidence.js";

const ALL_TOOLS = [
  "emit", "request", "discover_capabilities", "use_capability",
  "create_pulse", "list_pulses", "pause_pulse", "resume_pulse",
  "cancel_pulse", "read_artefact",
];

function valid(caseName: LiveToolEvidence["case"] = "emit-success"): LiveToolEvidence {
  const denied = caseName === "use-capability-denied";
  return {
    schema: "floe.live-tool-evidence.v1",
    case: caseName,
    captured_at: "2026-01-01T00:00:00.000Z",
    trigger: { event_id: "evt_trigger", source_endpoint_id: "actor:operator" },
    runtime: {
      turn_id: "rt_1",
      sdk_session_id: "sdk_1",
      offered_tool_names: [...ALL_TOOLS],
      registration_acknowledgement: {
        exposed: false,
        reason: "copilot_sdk_does_not_expose_tool_registration_acknowledgement",
      },
      exposure_proof: { kind: "first_exact_callback", tool_call_id: "call_1" },
    },
    delivery: {
      delivery_id: "del_1",
      trigger_event_id: "evt_trigger",
      final_state: "acknowledged",
    },
    tool_call: {
      call_id: "call_1",
      name: denied ? "use_capability" : "emit",
      arguments: denied
        ? {
            operation_id: "command.list",
            operation_version: "1",
            input_schema_version: "1",
            input: {},
          }
        : { type: "message", destination: "current_context", text: "live direct-tool success" },
      provenance: "floe_direct_tool_callback",
      lifecycle: denied ? "failed" : "completed",
      result_type: denied ? "failure" : "success",
      result_value: denied ? "not granted" : `{"event_id":"evt_emit"}`,
      denial_code: denied ? "operation_grant_required" : null,
      receipt_refusal_code: denied ? "operation_grant_required" : null,
    },
    emitted_event: denied ? null : {
      event_id: "evt_emit",
      provenance: "floe_emit_tool",
      runtime_turn_id: "rt_1",
      delivery_id: "del_1",
      payload: { event_id: "evt_emit" },
    },
    turn_result: {
      event_id: "evt_result",
      payload: {
        event_id: "evt_result",
        content: { data: { delivery_id: "del_1" } },
        metadata: { runtime_turn_id: "rt_1" },
      },
    },
    delivery_acknowledgement: {
      frame: "delivery_acknowledged",
      payload: { delivery_id: "del_1" },
    },
  };
}

function invalid(
  mutator: (evidence: LiveToolEvidence) => void,
  caseName?: LiveToolEvidence["case"],
): void {
  const evidence = valid(caseName);
  mutator(evidence);
  expect(() => assertExactLiveToolEvidence(evidence)).toThrow(/Invalid/);
}

describe("exact live tool evidence", () => {
  it("accepts separate exact success and denial cases", () => {
    expect(() => assertExactLiveToolEvidence(valid())).not.toThrow();
    expect(() => assertExactLiveToolEvidence(valid("use-capability-denied"))).not.toThrow();
  });

  it("rejects matching Actor text without an exact tool callback", () => {
    invalid(evidence => {
      evidence.tool_call.call_id = null;
      evidence.tool_call.result_value = "live direct-tool success";
    });
  });

  it("rejects incomplete or different tool offerings", () => {
    invalid(evidence => { evidence.runtime.offered_tool_names = ["emit"]; });
    invalid(evidence => { evidence.runtime.offered_tool_names = [...ALL_TOOLS, "extra_tool"]; });
    invalid(evidence => { evidence.runtime.offered_tool_names = [...ALL_TOOLS.slice(1), "another_tool"]; });
  });

  it("rejects mismatched delivery and trigger IDs", () => {
    invalid(evidence => { evidence.delivery.trigger_event_id = "evt_other"; });
    invalid(evidence => {
      if (evidence.emitted_event) evidence.emitted_event.delivery_id = "del_other";
    });
    invalid(evidence => {
      evidence.turn_result = {
        event_id: "evt_result",
        payload: {
          event_id: "evt_result",
          content: { data: { delivery_id: "del_1" } },
          metadata: { runtime_turn_id: "rt_other" },
        },
      };
    });
  });

  it("rejects mismatched acknowledgement delivery ID", () => {
    invalid(evidence => {
      evidence.delivery_acknowledgement = {
        frame: "delivery_acknowledged",
        payload: { delivery_id: "del_other" },
      };
    });
  });

  it("rejects wrong model-visible refusal", () => {
    invalid(evidence => {
      evidence.tool_call.receipt_refusal_code = "some_other_code";
    }, "use-capability-denied");
  });

  it("rejects wrong provenance and mixed allowed/denied calls", () => {
    invalid(evidence => { evidence.tool_call.provenance = "actor_authored_text"; });
    invalid(evidence => {
      evidence.emitted_event = {
        event_id: "evt_emit",
        provenance: "floe_emit_tool",
        runtime_turn_id: "rt_1",
        delivery_id: "del_1",
        payload: {},
      };
    }, "use-capability-denied");
  });

  it("rejects missing acknowledgement and final durable state", () => {
    invalid(evidence => { evidence.delivery_acknowledgement = null; });
    invalid(evidence => { evidence.delivery.final_state = "injected_to_runtime"; });
  });

  it("rejects every denial code other than operation_grant_required", () => {
    invalid(evidence => { evidence.tool_call.denial_code = "operation_version_not_found"; }, "use-capability-denied");
    invalid(evidence => { evidence.tool_call.denial_code = "operation_input_invalid"; }, "use-capability-denied");
    invalid(evidence => { evidence.tool_call.denial_code = null; }, "use-capability-denied");
    invalid(evidence => { evidence.tool_call.receipt_refusal_code = null; }, "use-capability-denied");
  });

  it("rejects an exposure proof for a different callback", () => {
    invalid(evidence => {
      evidence.runtime.exposure_proof = { kind: "first_exact_callback", tool_call_id: "call_other" };
    });
  });

  it("rejects if required fields are null or empty", () => {
    invalid(evidence => { evidence.trigger.event_id = null; });
    invalid(evidence => { evidence.delivery.delivery_id = ""; });
    invalid(evidence => { evidence.runtime.turn_id = null; });
  });

  it("rejects if tool call arguments are missing", () => {
    invalid(evidence => { evidence.tool_call.arguments = null; });
    invalid(evidence => { evidence.tool_call.arguments = {}; });
  });

  it("rejects a denial whose operation is not the exact ungranted command.list@1", () => {
    invalid(evidence => {
      evidence.tool_call.arguments = {
        operation_id: "command.other",
        operation_version: "1",
        input_schema_version: "1",
        input: {},
      };
    }, "use-capability-denied");
    invalid(evidence => {
      evidence.tool_call.arguments = {
        operation_id: "command.list",
        operation_version: "2",
        input_schema_version: "1",
        input: {},
      };
    }, "use-capability-denied");
    invalid(evidence => {
      evidence.tool_call.arguments = {
        operation_id: "command.list",
        operation_version: "1",
        input_schema_version: "1",
        input: { unexpected: true },
      };
    }, "use-capability-denied");
  });
});
