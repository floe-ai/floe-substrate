import { describe, expect, it } from "vitest";
import type { ScopeExecutionRecord } from "../../bus-client/types.ts";
import { scopeExecutionStateRevision } from "./ScopeWorkView.tsx";

describe("Scope execution operation revision", () => {
  it("pins Stop to the selected execution state rather than the Scope", () => {
    const execution = {
      revision_id: "revision-7",
      state_revision: 4,
      status: "active",
      completed_at: null,
      cancelled_at: null,
    } as ScopeExecutionRecord;
    expect(scopeExecutionStateRevision(execution)).toBe("revision-7:4:active::");
  });
});
