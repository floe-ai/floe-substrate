import { zodToJsonSchema } from "zod-to-json-schema";
import type { z } from "zod";
import type { HostTool } from "floe-runtime/adapters/copilot";
import {
  executeEmit, executeRequest, executeDiscoverCapabilities, executeUseCapability,
  executeCreatePulse, executeListPulses, executePausePulse, executeResumePulse,
  executeCancelPulse, executeReadArtefact,
} from "../runtime-core/index.js";
import {
  FLOE_RUNTIME_TOOL_IDENTITY,
  SUBSTRATE_TOOL_DEFINITIONS,
  type SubstrateSessionHandle,
} from "../runtime-core/substrate-tool-definitions.js";

/**
 * @invariant Direct SDK tools consume the canonical, transport-neutral Bridge
 * tool definitions. Every call resolves its Bus and live turn at invocation
 * time, preserving Bridge authority and active-turn state across SDK calls.
 */

function result(value: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: Record<string, unknown> }) {
  return {
    textResultForLlm: value.content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n"),
    binaryResultsForLlm: value.content
      .filter(block => block.type === "image" && block.data && block.mimeType)
      .map(block => ({ data: block.data!, mimeType: block.mimeType! })),
    resultType: value.details.ok === false ? "failure" : "success",
  };
}

function resultCode(value: { details: Record<string, unknown> }): string | undefined {
  const refusal = value.details.refusal;
  if (refusal && typeof refusal === "object" && typeof (refusal as { code?: unknown }).code === "string") {
    return (refusal as { code: string }).code;
  }
  return undefined;
}

function directTool(
  name: string,
  description: string,
  schema: z.ZodTypeAny,
  handle: SubstrateSessionHandle,
  execute: (params: Record<string, unknown>, handle: SubstrateSessionHandle) => Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: Record<string, unknown> }>,
): HostTool {
  return {
    name,
    description,
    parameters: zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>,
    // The handler is the Bridge's authority boundary: it resolves the active
    // delivery and invokes the Bus with Bridge-only or delivery-scoped authority.
    skipPermission: true,
    async handler(args: unknown, invocation) {
      const callId = invocation.toolCallId;
      const normalizedArgs = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
      handle.recordToolActivity({ name, call_id: callId, arguments: normalizedArgs });
      try {
        const execution = await execute(schema.parse(args) as Record<string, unknown>, handle);
        const toolResult = result(execution);
        handle.recordToolActivity({
          name,
          call_id: callId,
          is_error: toolResult.resultType === "failure",
          result_code: resultCode(execution),
        });
        return toolResult;
      } catch (error) {
        handle.recordToolActivity({ name, call_id: callId, is_error: true });
        throw error;
      }
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
    directTool(SUBSTRATE_TOOL_DEFINITIONS.emit.name, SUBSTRATE_TOOL_DEFINITIONS.emit.description, SUBSTRATE_TOOL_DEFINITIONS.emit.inputSchema, handle, async (params, h) => {
      const anchor = h.getAnchor();
      if (!anchor) throw new Error("emit: no active Floe turn is running for this session.");
      const outcome = await executeEmit(h.getBus(), anchor, params, FLOE_RUNTIME_TOOL_IDENTITY);
      if (outcome.emitted) h.recordEmitted(outcome.emitted);
      return outcome.result;
    }),
    directTool(SUBSTRATE_TOOL_DEFINITIONS.request.name, SUBSTRATE_TOOL_DEFINITIONS.request.description, SUBSTRATE_TOOL_DEFINITIONS.request.inputSchema, handle, async (params, h) => {
      const anchor = h.getAnchor();
      if (!anchor) throw new Error("request: no active Floe turn is running for this session.");
      const outcome = await executeRequest(h.getBus(), anchor, params, FLOE_RUNTIME_TOOL_IDENTITY, h.isDependencyRequested());
      if (outcome.dependencyRequested) h.markDependencyRequested();
      if (outcome.emitted) h.recordEmitted(outcome.emitted);
      return outcome.result;
    }),
    directTool(SUBSTRATE_TOOL_DEFINITIONS.discoverCapabilities.name, SUBSTRATE_TOOL_DEFINITIONS.discoverCapabilities.description, SUBSTRATE_TOOL_DEFINITIONS.discoverCapabilities.inputSchema, handle, async (params, h) =>
      executeDiscoverCapabilities(h.getBus(), active("discover_capabilities").workspace_id, active("discover_capabilities"), params)),
    directTool(SUBSTRATE_TOOL_DEFINITIONS.useCapability.name, SUBSTRATE_TOOL_DEFINITIONS.useCapability.description, SUBSTRATE_TOOL_DEFINITIONS.useCapability.inputSchema, handle, async (params, h) =>
      executeUseCapability(h.getBus(), active("use_capability").workspace_id, active("use_capability"), params)),
    directTool(SUBSTRATE_TOOL_DEFINITIONS.createPulse.name, SUBSTRATE_TOOL_DEFINITIONS.createPulse.description, SUBSTRATE_TOOL_DEFINITIONS.createPulse.inputSchema, handle, async (params, h) =>
      executeCreatePulse(h.getBus(), active("create_pulse"), params)),
    directTool(SUBSTRATE_TOOL_DEFINITIONS.listPulses.name, SUBSTRATE_TOOL_DEFINITIONS.listPulses.description, SUBSTRATE_TOOL_DEFINITIONS.listPulses.inputSchema, handle, async (params, h) =>
      executeListPulses(h.getBus(), active("list_pulses"), params)),
    directTool(SUBSTRATE_TOOL_DEFINITIONS.pausePulse.name, SUBSTRATE_TOOL_DEFINITIONS.pausePulse.description, SUBSTRATE_TOOL_DEFINITIONS.pausePulse.inputSchema, handle, async (params, h) => {
      active("pause_pulse"); return executePausePulse(h.getBus(), params);
    }),
    directTool(SUBSTRATE_TOOL_DEFINITIONS.resumePulse.name, SUBSTRATE_TOOL_DEFINITIONS.resumePulse.description, SUBSTRATE_TOOL_DEFINITIONS.resumePulse.inputSchema, handle, async (params, h) => {
      active("resume_pulse"); return executeResumePulse(h.getBus(), params);
    }),
    directTool(SUBSTRATE_TOOL_DEFINITIONS.cancelPulse.name, SUBSTRATE_TOOL_DEFINITIONS.cancelPulse.description, SUBSTRATE_TOOL_DEFINITIONS.cancelPulse.inputSchema, handle, async (params, h) => {
      active("cancel_pulse"); return executeCancelPulse(h.getBus(), params);
    }),
    directTool(SUBSTRATE_TOOL_DEFINITIONS.readArtefact.name, SUBSTRATE_TOOL_DEFINITIONS.readArtefact.description, SUBSTRATE_TOOL_DEFINITIONS.readArtefact.inputSchema, handle, async (params, h) =>
      executeReadArtefact(h.getBus(), active("read_artefact"), params)),
  ];
  return tools;
}
