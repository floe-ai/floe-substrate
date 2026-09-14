import { describe, expect, it } from "vitest";
import { PiAgentCoreAdapter } from "./pi-agent-core-adapter.js";
import type { DeliveryBundle, EventEnvelope } from "../bus-client.js";

const MODEL = {
  id: "mock-model",
  name: "Mock",
  api: "openai-responses",
  provider: "mock-provider",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096
};

const AUTH = {
  paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
  authStorage: {},
  modelRegistry: {
    find: () => MODEL,
    getApiKeyForProvider: async () => "key"
  },
  profiles: { version: 1, profiles: [{ id: "profile", provider: "mock-provider", model: "mock-model" }] }
} as any;

function delivery(): DeliveryBundle {
  return {
    delivery_id: "del-affordances",
    endpoint_id: "actor:workspace:test:a",
    workspace_id: "workspace:test",
    trigger_event_id: "evt-current",
    delivered_at: new Date().toISOString(),
    scope_execution_id: "scope-execution:test",
    composition_revision_id: "scope-revision:test",
    node_execution_id: "node-execution:test",
    target_node_id: "worker-a",
    execution_attempt_id: "attempt:test",
    context_id: "ctx-current",
    events: [{
      event_id: "evt-current",
      type: "message",
      workspace_id: "workspace:test",
      source_endpoint_id: "actor:workspace:test:operator",
      thread_id: "ctx-current",
      context_id: "ctx-current",
      correlation_id: null,
      artefact_version_ids: ["version:unrequested"],
      destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:a" },
      content: { text: "Ask B only if needed." },
      response: { expected: false },
      metadata: {},
      created_at: new Date().toISOString()
    }]
  };
}

describe("model-facing runtime affordances", () => {
  it.each([
    { scenario: "long-pages", direction: "backward" },
    { scenario: "large-event", direction: "backward" },
    { scenario: "long-pages", direction: "forward" },
    { scenario: "large-event", direction: "forward" },
  ] as const)("keeps bounded $direction history parseable and pageable for $scenario", async ({ scenario, direction }) => {
    let tools: any[] = [];
    const calls: Array<{ contextId: string; cursor: string | null; limit: number; direction: string }> = [];
    const pages: any[] = [];
    const events = Array.from({ length: scenario === "long-pages" ? 25 : 2 }, (_, index) => ({
      ...delivery().events[0], event_id: `event-${index}`,
      content: scenario === "long-pages" ? { text: `${index}: ${"history ".repeat(410)}` }
        : index === 0 ? { text: "Large structured contribution", data: { details: "x".repeat(40_000) } }
          : { text: "The next contribution must remain readable." },
      artefact_version_ids: [],
    }));
    const agent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      reset() {},
      async prompt() {
        let cursor: string | null = null;
        for (let pageNumber = 0; pageNumber < 30; pageNumber++) {
          const result = await tools.find(tool => tool.name === "context_history").execute(`page-${pageNumber}`, {
            cursor, limit: 25, ...(pageNumber === 0 && direction === "backward" ? {} : { direction }),
          });
          const text = result.content[0].text;
          expect(text.length).toBeLessThanOrEqual(16_000);
          const page = JSON.parse(text);
          expect(page.direction).toBe(direction);
          expect(result.details.direction).toBe(direction);
          expect(result.details.next_cursor).toBe(page.next_cursor);
          pages.push(page);
          if (!page.next_cursor) break;
          expect(page.next_cursor).not.toBe(cursor);
          cursor = page.next_cursor;
        }
        const assistant = { role: "assistant", content: [], stopReason: "stop", usage: null, model: "mock-model", provider: "mock-provider" };
        for (const listener of this.listeners) await listener({ type: "agent_end", messages: [assistant] });
      },
    };
    const adapter = new PiAgentCoreAdapter(AUTH, {
      agentFactory: input => { tools = input.tools; return agent; }, turnFinalizeTimeoutMs: 1_000,
    });
    await adapter.handleBundle({ bridge_id: "bridge:test", bus: {
      async appendRuntimeTelemetry() {},
      async recordRuntimeTurnResult() { throw new Error("No response was emitted"); },
      async listContextEvents(contextId: string, cursor: string | null, limit: number, readDirection: string) {
        calls.push({ contextId, cursor, limit, direction: readDirection });
        expect(readDirection).toBe(direction);
        // Tokens are owned by the server; the Bridge must return them unchanged.
        const boundary = cursor === null ? (direction === "backward" ? events.length : 0)
          : Number(cursor.replace("opaque-next-", ""));
        expect(Number.isInteger(boundary)).toBe(true);
        const start = direction === "backward" ? Math.max(0, boundary - limit) : boundary;
        const selected = events.slice(start, direction === "backward" ? boundary : start + limit);
        return { events: selected, next_cursor: selected.length === limit
          ? `opaque-next-${direction === "backward" ? start : start + selected.length}` : null };
      },
    } } as any, delivery(), { provider: "mock-provider", model: "mock-model", auth_profile: "profile" });
    const chronological = (direction === "backward" ? [...pages].reverse() : pages).flatMap(page => page.events);
    expect(chronological.map((event: any) => event.event_id)).toEqual(events.map(event => event.event_id));
    if (direction === "backward") expect(pages[0].events.at(-1).event_id).toBe(events.at(-1)!.event_id);
    else expect(pages[0].events[0].event_id).toBe(events[0]!.event_id);
    expect(calls.every(call => call.contextId === "ctx-current")).toBe(true);
    if (scenario === "long-pages") {
      expect(chronological.map((event: any) => event.text)).toEqual(events.map(event => event.content.text));
    } else {
      expect(chronological[0]).toMatchObject({ event_id: "event-0", text: "Large structured contribution", omitted_fields: ["data"] });
      expect(chronological.at(-1).text).toBe("The next contribution must remain readable.");
    }
  });

  it.each([{ versions: undefined }, { versions: ["version:brief", "version:game", "version:brief"] }])(
    "retrieves history deliberately and pins requested inputs ($versions)", async ({ versions }) => {
    let tools: any[] = [];
    let capturedPrompt = "";
    let historyResult: any;
    let requestResult: any;
    let secondRequestResult: any;
    const emitted: any[] = [];
    const telemetry: any[] = [];
    const historyCalls: any[] = [];
    const oldEvent: EventEnvelope = {
      event_id: "evt-old",
      type: "message",
      workspace_id: "workspace:test",
      source_endpoint_id: "actor:workspace:test:operator",
      thread_id: "ctx-current",
      context_id: "ctx-current",
      correlation_id: null,
      artefact_version_ids: [],
      destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:a" },
      content: { text: "The older fact is cobalt.", references: [{name:"Saved approval",resource_ref:{kind:"approval_request",id:"approval:retained",revision:"3"}}] },
      response: { expected: false },
      metadata: {},
      created_at: "2026-08-20T00:00:00.000Z"
    };
    const agent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      reset() {},
      async prompt(message: any) {
        capturedPrompt = message.content[0].text;
        historyResult = await tools.find((tool) => tool.name === "context_history")
          .execute("tc-history", { limit: 2 });
        await expect(tools.find((tool) => tool.name === "request").execute("tc-refused", {
          actor: "b", work: "Inspect an unavailable saved input.", artefact_version_ids: ["version:unavailable"],
        })).rejects.toThrow("Saved input unavailable");
        requestResult = await tools.find((tool) => tool.name === "request")
          .execute("tc-request", { actor: "b", work: "Return the colour fact.", artefact_version_ids: versions });
        secondRequestResult = await tools.find((tool) => tool.name === "request")
          .execute("tc-request-2", { actor: "b", work: "Do unrelated work too." });
        const assistant = { role: "assistant", content: [], stopReason: "stop", usage: null, model: "mock-model", provider: "mock-provider" };
        for (const listener of this.listeners) {
          await listener({ type: "agent_end", messages: [assistant] });
        }
      }
    };
    const adapter = new PiAgentCoreAdapter(AUTH, {
      agentFactory: (input) => {
        tools = input.tools;
        return agent;
      },
      turnFinalizeTimeoutMs: 1_000
    });
    const bus = {
      async appendRuntimeTelemetry(input: any) { telemetry.push(input); },
      async recordRuntimeTurnResult() { throw new Error("empty output must not record a result"); },
      async getContext(contextId: string) {
        return { context_id: contextId, workspace_id: "workspace:test", parent_context_id: null, created_by_endpoint_id: null, scope_id: null, created_at: new Date().toISOString(), participants: [] };
      },
      async listContextEvents(contextId: string, cursor: string | null, limit: number, direction: string) {
        historyCalls.push({ contextId, cursor, limit, direction });
        return { events: [oldEvent], next_cursor: "cursor-next" };
      },
      async listEndpoints() {
        return [
          { endpoint_id: "actor:workspace:test:a", name: "A", status: "active" },
          { endpoint_id: "actor:workspace:test:b", name: "B", status: "idle" }
        ];
      },
      async emit(event: any) {
        if (event.artefact_version_ids.includes("version:unavailable")) throw new Error("Saved input unavailable");
        emitted.push(event);
        return { event_id: "evt-request", event: { artefact_version_ids: event.artefact_version_ids } };
      }
    };

    await adapter.handleBundle(
      { bridge_id: "bridge:test", bus } as any,
      delivery(),
      { provider: "mock-provider", model: "mock-model", auth_profile: "profile" }
    );

    expect(capturedPrompt).toContain("Ask B only if needed.");
    expect(capturedPrompt).toContain("version:unrequested");
    expect(capturedPrompt).not.toContain("The older fact is cobalt.");
    expect(capturedPrompt).not.toContain("actor:workspace:test:b");
    expect(capturedPrompt).not.toContain("correlation_id");
    expect(historyCalls).toEqual([{ contextId: "ctx-current", cursor: null, limit: 2, direction: "backward" }]);
    expect(historyResult.content[0].text).toContain("The older fact is cobalt.");
    expect(JSON.parse(historyResult.content[0].text).events[0].references).toEqual(oldEvent.content.references);
    expect(telemetry).toContainEqual(expect.objectContaining({
      kind: "context_history_retrieval",
      payload: expect.objectContaining({ returned_events: 1 })
    }));

    expect(requestResult.content[0].text).not.toMatch(/req_[a-f0-9-]+/);
    expect(secondRequestResult).toMatchObject({
      content: [{ text: expect.stringContaining("already has a pending actor dependency") }],
      details: { ok: false, error: "dependency_already_requested" }
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "request",
      source_endpoint_id: "actor:workspace:test:a",
      destination: { kind: "endpoint", endpoint_id: "actor:workspace:test:b" },
      context_id: null,
      current_delivery_context_id: "ctx-current",
      content: { text: "Return the colour fact." },
      response: { expected: true, mode: "correlated" },
      metadata: {
        origin: "pi_request_tool",
        request_return_context_id: "ctx-current",
        request_parent_delivery_id: "del-affordances",
        request_parent_scope_execution_id: "scope-execution:test",
        request_parent_composition_revision_id: "scope-revision:test",
        request_parent_node_execution_id: "node-execution:test",
        request_parent_target_node_id: "worker-a",
        request_parent_execution_attempt_id: "attempt:test",
        request_continuation_event_id: null
      }
    });
    expect(emitted[0].correlation_id).toMatch(/^req_/);
    expect(emitted[0].response.correlation_id).toBe(emitted[0].correlation_id);
    expect(emitted[0].artefact_version_ids).toEqual([...new Set(versions ?? [])]);
    expect(requestResult.details).toMatchObject({
      event_id: "evt-request", artefact_version_ids: [...new Set(versions ?? [])],
    });
  });
});
