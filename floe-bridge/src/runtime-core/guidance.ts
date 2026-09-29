/**
 * Floe Runtime Core — Substrate Guidance
 *
 * This module provides the standard substrate guidance text injected into
 * every runtime actor's instruction context. It teaches the agent
 * the actor/event/emit/turn model.
 */

import { readPromptAsset } from "../prompt-assets.js";
import { toNeutralRef } from "./neutral-ref.js";

/**
 * Standard substrate guidance for runtime actors.
 * This is appended to agent instructions before the processing cycle begins.
 */
export const SUBSTRATE_GUIDANCE = readPromptAsset("substrate-guidance.md");

/**
 * Build the complete system prompt for a runtime actor.
 *
 * Combines agent-authored instructions with substrate guidance.
 * The substrate guidance is always appended — it cannot be overridden
 * by agent instructions.
 */
export function buildSystemPrompt(agentInstructions: string): string {
  if (!agentInstructions.trim()) {
    return SUBSTRATE_GUIDANCE;
  }
  return `${agentInstructions.trim()}\n\n${SUBSTRATE_GUIDANCE}`;
}

/**
 * Render the compact causal envelope for one turn. Cold-session continuity is
 * projected separately; actor discovery remains available through tools.
 */
export function renderDestinationContext(context: {
  source_endpoint_id: string;
  current_context_id?: string | null;
  cause_event_id?: string | null;
  cause_type?: string | null;
  cause_reference?: string | null;
}): string {
  const lines = [
    `[Context Envelope]`,
    `context: ${context.current_context_id ?? "unavailable"}`,
    `cause_actor: ${toNeutralRef(context.source_endpoint_id)}`,
  ];
  if (context.cause_type) lines.push(`cause_type: ${context.cause_type}`);
  if (context.cause_event_id) lines.push(`cause_event: ${context.cause_event_id}`);
  if (context.cause_reference) lines.push(`reference: ${context.cause_reference}`);
  lines.push("history: available on demand with context_history");
  return lines.join("\n");
}
