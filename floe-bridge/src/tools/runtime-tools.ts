import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BusClient } from "../bus-client.js";
import { createCapabilityTools } from "./capability-tools.js";
import { createArtefactContentTool } from "./artefact-content-tool.js";
import { createWorkspaceTools } from "./index.js";
import { createPulseTools } from "./pulse-tools.js";
import type { ToolContext } from "./types.js";

/**
 * The Floe-owned tool catalogue shared by every model runtime.
 * Provider-native tools may supplement this catalogue, but cannot replace it.
 */
export function createRuntimeTools(input: {
  bus: BusClient;
  workspaceId: string;
  endpointId: string;
  workspaceLocator?: string;
  toolContext: Pick<ToolContext, "getActiveTurn">;
}): AgentTool[] {
  const workspaceTools = input.workspaceLocator
    ? createWorkspaceTools({ workspaceRoot: input.workspaceLocator, ...input.toolContext })
    : [];
  const pulseTools = createPulseTools(input.bus, input.workspaceId, input.workspaceLocator, input.toolContext);
  const capabilityTools = createCapabilityTools(input.bus, input.workspaceId, input.toolContext);
  const artefactContentTool = createArtefactContentTool(input.bus, input.workspaceId, input.toolContext);
  // Actor changes use discovered semantic operations and the active Delivery's
  // authority. File-authoring shortcuts are not an alternate Actor API.
  return [...pulseTools, ...capabilityTools, artefactContentTool, ...workspaceTools];
}

/** Tool membership is fixed when either runtime creates a model session. */
export function runtimeToolsFingerprint(input: {
  workspaceLocator?: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({ workspace: input.workspaceLocator ?? null }))
    .digest("hex");
}
