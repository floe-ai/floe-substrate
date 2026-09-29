import { describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "../bus-client.js";
import {
  CONTEXT_CONTINUITY_TOKEN_BUDGET,
  continuityTokenUpperBound,
  loadContextContinuity,
  renderContextContinuity,
} from "./context-continuity.js";

function event(id: string, text: string, type = "message"): EventEnvelope {
  return {
    event_id: id,
    type,
    workspace_id: "workspace:test",
    source_endpoint_id: "actor:workspace:test:operator",
    thread_id: "context:test",
    context_id: "context:test",
    correlation_id: null,
    destination_json: { kind: "context", context_id: "context:test" },
    content: type === "context.compacted" ? { summary: text } : { text },
    artefact_version_ids: [],
    response: { expected: false },
    metadata: {},
    created_at: `2026-09-30T00:00:0${id.at(-1)}.000Z`,
  };
}

describe("Context continuity projection", () => {
  it("uses a conservative UTF-8 token upper bound", () => {
    expect(continuityTokenUpperBound("plain")).toBe(5);
    expect(continuityTokenUpperBound("😀")).toBe(4);
  });

  it("excludes current Events and stops at the latest compacted summary", async () => {
    const listContextEvents = vi.fn()
      .mockResolvedValueOnce({
        events: [event("event-3", "summary", "context.compacted"), event("event-4", "after"), event("event-5", "current")],
        next_cursor: "older",
      });

    const projection = await loadContextContinuity(
      { listContextEvents } as any,
      "context:test",
      new Set(["event-5"]),
    );

    expect(listContextEvents).toHaveBeenCalledOnce();
    expect(projection.eventCount).toBe(2);
    expect(projection.compacted).toBe(true);
    expect(projection.text).toContain("summary");
    expect(projection.text).toContain("after");
    expect(projection.text).not.toContain('"text":"current"');
  });

  it("pages backward to the beginning when no compacted summary exists", async () => {
    const listContextEvents = vi.fn()
      .mockResolvedValueOnce({ events: [event("event-3", "new")], next_cursor: "older" })
      .mockResolvedValueOnce({ events: [event("event-1", "old")], next_cursor: null });

    const projection = await loadContextContinuity(
      { listContextEvents } as any,
      "context:test",
      new Set(),
    );

    expect(projection.text.indexOf('"text":"old"')).toBeLessThan(projection.text.indexOf('"text":"new"'));
    expect(listContextEvents).toHaveBeenCalledTimes(2);
  });

  it("fails instead of silently truncating an oversized canonical record", () => {
    expect(() => renderContextContinuity([
      event("event-1", "x".repeat(CONTEXT_CONTINUITY_TOKEN_BUDGET)),
    ])).toThrow(/context_continuity_too_large|Compact the Context/);
  });

  it("rejects repeated cursors instead of looping", async () => {
    const listContextEvents = vi.fn()
      .mockResolvedValueOnce({ events: [], next_cursor: "same" })
      .mockResolvedValueOnce({ events: [], next_cursor: "same" });

    await expect(loadContextContinuity(
      { listContextEvents } as any,
      "context:test",
      new Set(),
    )).rejects.toThrow(/repeated history cursor/);
  });

  it("identifies malformed canonical Events instead of skipping them", () => {
    expect(() => renderContextContinuity([
      { ...event("event-bad", "bad"), created_at: "" },
    ])).toThrow(/Event 'event-bad' is missing 'created_at'/);
  });

  it("preserves principal-authored Events that have no source endpoint", () => {
    const projection = renderContextContinuity([{
      ...event("event-person", "remember"),
      source_endpoint_id: null,
      metadata: { source_principal_id: "identity:operator" },
    }]);

    expect(projection.text).toContain('"source_endpoint_id":null');
    expect(projection.text).toContain('"source_principal_id":"identity:operator"');
  });
});
