/**
 * The token figure a turn records, labelled by what it actually measures.
 *
 * floe-runtime sums usage across every model call in a turn and says how many
 * calls it summed (`numModelCalls`). Only then is the figure a whole turn. A
 * usage record without that count covers the last model call alone and is
 * labelled so, never passed off as the turn.
 */
export type TurnUsage = {
  measurement_scope: "turn" | "last_model_call" | "unmeasured";
  model_calls: number | null;
  tool_calls: number | null;
  tokens: { input: number; output: number; cache_read: number; cache_write: number } | null;
};

export function turnUsage(usage: unknown): TurnUsage {
  if (!usage || typeof usage !== "object") {
    return { measurement_scope: "unmeasured", model_calls: null, tool_calls: null, tokens: null };
  }
  const record = usage as Record<string, unknown>;
  const modelCalls = count(record.numModelCalls);
  const wholeTurn = modelCalls !== null && modelCalls > 0;
  return {
    measurement_scope: wholeTurn ? "turn" : "last_model_call",
    model_calls: modelCalls,
    // Without the turn count, the SDK's per-call tool count says nothing about the turn.
    tool_calls: wholeTurn ? count(record.numToolCalls) : null,
    tokens: {
      input: tokens(record.inputTokens),
      output: tokens(record.outputTokens),
      cache_read: tokens(record.cacheReadTokens),
      cache_write: tokens(record.cacheWriteTokens),
    },
  };
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
