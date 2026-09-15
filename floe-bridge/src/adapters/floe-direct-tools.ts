import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { HostTool } from "floe-runtime/adapters/copilot";
import {
  executeEmit, executeRequest, executeDiscoverCapabilities, executeUseCapability,
  executeCreatePulse, executeListPulses, executePausePulse, executeResumePulse,
  executeCancelPulse, executeReadArtefact,
} from "../runtime-core/index.js";
import type { SubstrateToolIdentity } from "../runtime-core/index.js";
import type { SubstrateSessionHandle } from "./floe-mcp-server.js";
import {
  EMIT_INPUT_SCHEMA, REQUEST_INPUT_SCHEMA, DISCOVER_CAPABILITIES_INPUT_SCHEMA,
  USE_CAPABILITY_INPUT_SCHEMA, CREATE_PULSE_INPUT_SCHEMA, LIST_PULSES_INPUT_SCHEMA,
  PULSE_ID_INPUT_SCHEMA, READ_ARTEFACT_INPUT_SCHEMA, EMIT_DESCRIPTION,
  REQUEST_DESCRIPTION, DISCOVER_CAPABILITIES_DESCRIPTION, USE_CAPABILITY_DESCRIPTION,
  CREATE_PULSE_DESCRIPTION, LIST_PULSES_DESCRIPTION, PAUSE_PULSE_DESCRIPTION,
  RESUME_PULSE_DESCRIPTION, CANCEL_PULSE_DESCRIPTION, READ_ARTEFACT_DESCRIPTION,
} from "./floe-mcp-server.js";

const IDENTITY: SubstrateToolIdentity = {
  runtimeName: "floe-runtime",
  emitOrigin: "floe_emit_tool",
  requestOrigin: "floe_request_tool",
};

function result(value: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: Record<string, unknown> }) {
  return {
    textResultForLlm: value.content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n"),
    binaryResultsForLlm: value.content
      .filter(block => block.type === "image" && block.data && block.mimeType)
      .map(block => ({ data: block.data!, mimeType: block.mimeType! })),
    resultType: value.details.ok === false ? "failure" : "success",
  };
}

function directTool(
  name: string,
  description: string,
  schema: z.ZodRawShape,
  handle: SubstrateSessionHandle,
  execute: (params: Record<string, unknown>, handle: SubstrateSessionHandle) => Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: Record<string, unknown> }>,
): HostTool {
  return {
    name,
    description,
    parameters: zodToJsonSchema(z.object(schema), { $refStrategy: "none" }) as Record<string, unknown>,
    async handler(args: unknown, _invocation) {
      return result(await execute(z.object(schema).parse(args), handle));
    },
  };
}

export function createDirectSubstrateTools(handle: SubstrateSessionHandle): HostTool[] {
  const active = (name: string) => {
    const turn = handle.getActiveTurn();
    if (!turn) throw new Error(`${name}: no active Floe turn is running for this session.`);
    return turn;
  };
  const tools = [
    directTool("emit", EMIT_DESCRIPTION, EMIT_INPUT_SCHEMA, handle, async (params, h) => {
      const anchor = h.getAnchor();
      if (!anchor) throw new Error("emit: no active Floe turn is running for this session.");
      const outcome = await executeEmit(h.getBus(), anchor, params, IDENTITY);
      if (outcome.emitted) h.recordEmitted(outcome.emitted);
      return outcome.result;
    }),
    directTool("request", REQUEST_DESCRIPTION, REQUEST_INPUT_SCHEMA, handle, async (params, h) => {
      const anchor = h.getAnchor();
      if (!anchor) throw new Error("request: no active Floe turn is running for this session.");
      const outcome = await executeRequest(h.getBus(), anchor, params, IDENTITY, h.isDependencyRequested());
      if (outcome.dependencyRequested) h.markDependencyRequested();
      if (outcome.emitted) h.recordEmitted(outcome.emitted);
      return outcome.result;
    }),
    directTool("discover_capabilities", DISCOVER_CAPABILITIES_DESCRIPTION, DISCOVER_CAPABILITIES_INPUT_SCHEMA, handle, async (params, h) =>
      executeDiscoverCapabilities(h.getBus(), active("discover_capabilities").workspace_id, active("discover_capabilities"), params)),
    directTool("use_capability", USE_CAPABILITY_DESCRIPTION, USE_CAPABILITY_INPUT_SCHEMA, handle, async (params, h) =>
      executeUseCapability(h.getBus(), active("use_capability").workspace_id, active("use_capability"), params)),
    directTool("create_pulse", CREATE_PULSE_DESCRIPTION, CREATE_PULSE_INPUT_SCHEMA, handle, async (params, h) =>
      executeCreatePulse(h.getBus(), active("create_pulse"), params)),
    directTool("list_pulses", LIST_PULSES_DESCRIPTION, LIST_PULSES_INPUT_SCHEMA, handle, async (params, h) =>
      executeListPulses(h.getBus(), active("list_pulses"), params)),
    directTool("pause_pulse", PAUSE_PULSE_DESCRIPTION, PULSE_ID_INPUT_SCHEMA, handle, async (params, h) => {
      active("pause_pulse"); return executePausePulse(h.getBus(), params);
    }),
    directTool("resume_pulse", RESUME_PULSE_DESCRIPTION, PULSE_ID_INPUT_SCHEMA, handle, async (params, h) => {
      active("resume_pulse"); return executeResumePulse(h.getBus(), params);
    }),
    directTool("cancel_pulse", CANCEL_PULSE_DESCRIPTION, PULSE_ID_INPUT_SCHEMA, handle, async (params, h) => {
      active("cancel_pulse"); return executeCancelPulse(h.getBus(), params);
    }),
    directTool("read_artefact", READ_ARTEFACT_DESCRIPTION, READ_ARTEFACT_INPUT_SCHEMA, handle, async (params, h) =>
      executeReadArtefact(h.getBus(), active("read_artefact"), params)),
  ];
  return tools;
}
