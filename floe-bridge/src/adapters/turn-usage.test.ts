import { describe, expect, it } from "vitest";
import { turnUsage } from "./turn-usage.js";

describe("turn usage labels what it measures", () => {
  it("records the runtime's summed turn figure with its model and tool call counts", () => {
    expect(turnUsage({
      inputTokens: 27_500, outputTokens: 101, cacheReadTokens: 27_000, cacheWriteTokens: 300,
      numModelCalls: 2, numToolCalls: 1, modelCalls: [{ inputTokens: 13_700 }, { inputTokens: 13_800 }],
    })).toEqual({
      measurement_scope: "turn",
      model_calls: 2,
      tool_calls: 1,
      tokens: { input: 27_500, output: 101, cache_read: 27_000, cache_write: 300 },
    });
  });

  it("labels a figure without a model call count as the last call only", () => {
    expect(turnUsage({ inputTokens: 13_800, outputTokens: 26, numToolCalls: 0 })).toEqual({
      measurement_scope: "last_model_call",
      model_calls: null,
      tool_calls: null,
      tokens: { input: 13_800, output: 26, cache_read: 0, cache_write: 0 },
    });
  });

  it("says a turn with no usage was not measured", () => {
    expect(turnUsage(null)).toEqual({ measurement_scope: "unmeasured", model_calls: null, tool_calls: null, tokens: null });
  });
});
