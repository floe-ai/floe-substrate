/**
 * Session isolation tests — fm/floe-ctx-session-iso
 *
 * Verifies:
 *  1. Two contexts for one agent produce two independent sessions (C-1)
 *  2. A session built for context A contains nothing from context B (C-1)
 *  3. Cold and warm turns do not prepay Context history
 *  4. Provider-private message history is reset before every delivery
 *  5. Reply still lands in the origin context (D-B invariant survives rekey)
 *
 * No live LLM calls — all tests use fixtures and doubles.
 */
import { describe, expect, it } from "vitest";
import { PiAgentCoreAdapter } from "./pi-agent-core-adapter.js";
import type { DeliveryBundle, EventEnvelope } from "../bus-client.js";

const recordRuntimeTurnResult = async (input: any) => ({
  result_event: { event_id: `result:${input.delivery_id}` },
  return_event: null,
  request_resolved: false
});

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const MOCK_MODEL = {
  id: "mock-model",
  name: "Mock",
  api: "openai-responses",
  provider: "mock-provider",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} as const;

const MOCK_AUTH = {
  paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
  authStorage: {} as any,
  modelRegistry: {
    find(provider: string, modelId: string) {
      if (provider === "mock-provider" && modelId === "mock-model") return MOCK_MODEL as any;
      return undefined;
    },
    async getApiKeyForProvider() {
      return "test-key";
    },
  } as any,
  profiles: {
    version: 1,
    profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }],
  },
} as any;

const MOCK_RUNTIME_CONFIG = { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" };

function makeDeliveryWithContext(
  deliveryId: string,
  threadId: string,
  contextId: string | null,
  text: string,
  endpointId = "actor:workspace:test:floe"
): DeliveryBundle {
  return {
    delivery_id: deliveryId,
    endpoint_id: endpointId,
    workspace_id: "workspace:test",
    trigger_event_id: `evt:${deliveryId}`,
    delivered_at: new Date().toISOString(),
    events: [
      {
        event_id: `evt:${deliveryId}`,
        type: "message",
        workspace_id: "workspace:test",
        source_endpoint_id: "actor:workspace:test:operator",
        thread_id: threadId,
        context_id: contextId,
        correlation_id: null,
        artefact_version_ids: [],
        destination_json: { kind: "endpoint", endpoint_id: endpointId },
        content: { text, data: {} },
        response: { expected: false },
        metadata: {},
        created_at: new Date().toISOString(),
      } as EventEnvelope,
    ],
  };
}

/** A fake agent that records every prompt text it receives. */
class RecordingAgent {
  readonly promptsReceived: string[] = [];
  resetCount = 0;
  private listeners: Array<(event: any) => void | Promise<void>> = [];

  subscribe(listener: (event: any) => void | Promise<void>): void {
    this.listeners.push(listener);
  }

  reset(): void {
    this.resetCount += 1;
  }

  async prompt(message: any): Promise<void> {
    const text = message?.content?.[0]?.text ?? "";
    this.promptsReceived.push(text);
    const assistantMsg = {
      role: "assistant",
      content: [{ type: "text", text: "ack" }],
      usage: { input: 1, output: 1, totalTokens: 2 },
      model: "mock-model",
      provider: "mock-provider",
    };
    for (const l of this.listeners) {
      await l({ type: "message_end", message: assistantMsg });
      await l({ type: "turn_end", message: assistantMsg });
      await l({ type: "agent_end", messages: [assistantMsg] });
    }
  }
}

/** Minimal bus context that tracks listContextEvents calls. */
function makeBusWith(contextEventMap: Map<string, { events: EventEnvelope[]; next_cursor: string | null }>) {
  return {
    recordRuntimeTurnResult,
    async appendRuntimeTelemetry(_input: any) {},
    async emit(_event: any) {},
    async getContext(contextId: string) {
      return {
        context_id: contextId,
        workspace_id: "workspace:test",
        parent_context_id: null,
        created_by_endpoint_id: null,
        scope_id: null,
        created_at: new Date().toISOString(),
        participants: ["actor:workspace:test:operator", "actor:workspace:test:floe"],
      };
    },
    async listContextEvents(contextId: string, since?: string | null) {
      const entry = contextEventMap.get(contextId);
      if (!entry) return { events: [], next_cursor: null };
      // Simulate "since" cursor filtering: if since is provided, return subset
      // In real tests we just return the configured events for simplicity
      return { events: entry.events, next_cursor: entry.next_cursor };
    },
    async listEndpoints() { return []; },
  };
}

function makeMockContext(bus: ReturnType<typeof makeBusWith>): any {
  return { bridge_id: "bridge:test", bus } as any;
}

// ---------------------------------------------------------------------------
// C-1: Session isolation — one session per (endpoint, context)
// ---------------------------------------------------------------------------

describe("C-1: Session key per (agent, context)", () => {
  it("replaces Delivery-scoped credential authority when reusing a session", async () => {
    const model = { ...MOCK_MODEL, provider: "openai", id: "gpt-5.4-mini" } as any;
    const authRuntime = {
      ...MOCK_AUTH,
      modelRegistry: {
        find(provider: string, modelId: string) {
          return provider === "openai" && modelId === "gpt-5.4-mini" ? model : undefined;
        },
      },
    } as any;
    const agent = new RecordingAgent();
    let runtimeKey: (() => Promise<string>) | undefined;
    const adapter = new PiAgentCoreAdapter(authRuntime, {
      agentFactory: (input) => {
        runtimeKey = input.getApiKey;
        return agent;
      },
      turnFinalizeTimeoutMs: 1_000,
    });
    const bus = makeBusWith(new Map());
    const credentialStore = (key: string) => ({
      async read(providerId: string) {
        if (providerId !== "openai") throw new Error("wrong provider");
        return { type: "api_key" as const, key };
      },
      async list() { return [{ providerId: "openai", type: "api_key" as const }]; },
      async modify(_providerId: string, fn: any) {
        return fn({ type: "api_key", key });
      },
      async delete() {},
    });
    const runtimeConfig = { provider: "openai", model: "gpt-5.4-mini" };
    const firstContext = { ...makeMockContext(bus), credential_store: credentialStore("delivery-key-a") };
    const secondContext = { ...makeMockContext(bus), credential_store: credentialStore("delivery-key-b") };

    await adapter.handleBundle(
      firstContext,
      makeDeliveryWithContext("del-key-a", "thread", "ctx_key", "first"),
      runtimeConfig,
    );
    await expect(runtimeKey?.()).resolves.toBe("delivery-key-a");

    await adapter.handleBundle(
      secondContext,
      makeDeliveryWithContext("del-key-b", "thread", "ctx_key", "second"),
      runtimeConfig,
    );
    expect(agent.promptsReceived).toHaveLength(2);
    await expect(runtimeKey?.()).resolves.toBe("delivery-key-b");
  });

  it("uses the target NodeExecution Context even when the source Event belongs to another Context", async () => {
    const agentInstances: RecordingAgent[] = [];
    const contextLookups: string[] = [];
    const telemetry: any[] = [];
    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: () => {
        const agent = new RecordingAgent();
        agentInstances.push(agent);
        return agent;
      },
      turnFinalizeTimeoutMs: 1_000,
    });
    const base = makeBusWith(new Map());
    const bus = {
      ...base,
      async getContext(contextId: string) {
        contextLookups.push(contextId);
        return {
          context_id: contextId,
          workspace_id: "workspace:test",
          parent_context_id: null,
          created_by_endpoint_id: null,
          scope_id: "pipeline",
          created_at: new Date().toISOString(),
          participants: ["actor:workspace:test:floe"],
        };
      },
      async appendRuntimeTelemetry(input: any) { telemetry.push(input); },
    };
    const first = makeDeliveryWithContext("del-node-1", "source-thread-1", "ctx_source_1", "first input");
    first.context_id = "ctx_node_execution";
    first.node_execution_id = "node_execution_1";
    const second = makeDeliveryWithContext("del-node-2", "source-thread-2", "ctx_source_2", "second input");
    second.context_id = "ctx_node_execution";
    second.node_execution_id = "node_execution_2";

    await adapter.handleBundle(makeMockContext(bus as any), first, MOCK_RUNTIME_CONFIG);
    await adapter.handleBundle(makeMockContext(bus as any), second, MOCK_RUNTIME_CONFIG);

    expect(agentInstances).toHaveLength(1);
    expect(contextLookups).toEqual(["ctx_node_execution", "ctx_node_execution"]);
    expect(telemetry.length).toBeGreaterThan(0);
    expect(telemetry.every((entry) => entry.payload.context_id === "ctx_node_execution")).toBe(true);
    expect(telemetry.some((entry) => entry.payload.thread_id === "ctx_node_execution")).toBe(true);
    expect(JSON.stringify(telemetry)).not.toContain("ctx_source_1");
    expect(JSON.stringify(telemetry)).not.toContain("ctx_source_2");
  });

  it("two contexts for one agent produce two independent agent instances", async () => {
    const agentInstances: RecordingAgent[] = [];
    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: () => {
        const a = new RecordingAgent();
        agentInstances.push(a);
        return a;
      },
      turnFinalizeTimeoutMs: 1_000,
    });

    const bus = makeBusWith(new Map([
      ["ctx_card_A", { events: [], next_cursor: null }],
      ["ctx_card_B", { events: [], next_cursor: null }],
    ]));
    const context = makeMockContext(bus);

    // Deliver to context A
    await adapter.handleBundle(
      context,
      makeDeliveryWithContext("del-A1", "thread-A", "ctx_card_A", "work on card A"),
      MOCK_RUNTIME_CONFIG
    );

    // Deliver to context B (same endpoint, different context)
    await adapter.handleBundle(
      context,
      makeDeliveryWithContext("del-B1", "thread-B", "ctx_card_B", "work on card B"),
      MOCK_RUNTIME_CONFIG
    );

    // Two distinct agent instances created
    expect(agentInstances).toHaveLength(2);
    expect(agentInstances[0]).not.toBe(agentInstances[1]);
  });

  it("same context reuses the same agent instance on second delivery", async () => {
    const agentInstances: RecordingAgent[] = [];
    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: () => {
        const a = new RecordingAgent();
        agentInstances.push(a);
        return a;
      },
      turnFinalizeTimeoutMs: 1_000,
    });

    const bus = makeBusWith(new Map([
      ["ctx_card_A", { events: [], next_cursor: null }],
    ]));
    const context = makeMockContext(bus);

    await adapter.handleBundle(
      context,
      makeDeliveryWithContext("del-A1", "thread-A", "ctx_card_A", "first turn"),
      MOCK_RUNTIME_CONFIG
    );
    await adapter.handleBundle(
      context,
      makeDeliveryWithContext("del-A2", "thread-A", "ctx_card_A", "second turn"),
      MOCK_RUNTIME_CONFIG
    );

    // Only one agent instance (session reused for same context)
    expect(agentInstances).toHaveLength(1);
    // Provider-private messages are cleared before both turns; continuity is
    // durable Context state retrieved on demand, not hidden session history.
    expect(agentInstances[0].resetCount).toBe(2);
  });

  it("a session for context A sees no prompts from deliveries to context B", async () => {
    const agentInstances: RecordingAgent[] = [];
    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: () => {
        const a = new RecordingAgent();
        agentInstances.push(a);
        return a;
      },
      turnFinalizeTimeoutMs: 1_000,
    });

    const bus = makeBusWith(new Map([
      ["ctx_card_A", { events: [], next_cursor: null }],
      ["ctx_card_B", { events: [], next_cursor: null }],
    ]));
    const context = makeMockContext(bus);

    await adapter.handleBundle(
      context,
      makeDeliveryWithContext("del-A1", "thread-A", "ctx_card_A", "secret info about card A"),
      MOCK_RUNTIME_CONFIG
    );

    await adapter.handleBundle(
      context,
      makeDeliveryWithContext("del-B1", "thread-B", "ctx_card_B", "card B message"),
      MOCK_RUNTIME_CONFIG
    );

    // Two sessions, two agents
    expect(agentInstances).toHaveLength(2);

    const agentA = agentInstances[0];
    const agentB = agentInstances[1];

    // Agent B received NO prompts from agent A's session
    for (const p of agentB.promptsReceived) {
      expect(p).not.toContain("secret info about card A");
    }

    // Agent A received NO prompts from agent B's session
    for (const p of agentA.promptsReceived) {
      expect(p).not.toContain("card B message");
    }
  });

  it("no-context deliveries (context_id=null) use ':no-context' key and are isolated from context deliveries", async () => {
    const agentInstances: RecordingAgent[] = [];
    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: () => {
        const a = new RecordingAgent();
        agentInstances.push(a);
        return a;
      },
      turnFinalizeTimeoutMs: 1_000,
    });

    const bus = makeBusWith(new Map([
      ["ctx_card_A", { events: [], next_cursor: null }],
    ]));
    const context = makeMockContext(bus);

    // No-context delivery
    await adapter.handleBundle(
      context,
      makeDeliveryWithContext("del-noCtx", "thread-nc", null, "no context message"),
      MOCK_RUNTIME_CONFIG
    );

    // Context delivery
    await adapter.handleBundle(
      context,
      makeDeliveryWithContext("del-ctx", "thread-ctx", "ctx_card_A", "context message"),
      MOCK_RUNTIME_CONFIG
    );

    // Two distinct sessions
    expect(agentInstances).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// C-2/C-3: Thread-slice injection and cursor advance
// ---------------------------------------------------------------------------

describe("Context economy: history is available but not injected", () => {
  it("cold start includes only the causal envelope and current input", async () => {
    const capturedPrompts: string[] = [];
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(message: any) {
        capturedPrompts.push(message?.content?.[0]?.text ?? "");
        const assistantMsg = { role: "assistant", content: [{ type: "text", text: "ack" }],
          usage: { input: 1, output: 1, totalTokens: 2 }, model: "mock-model", provider: "mock-provider" };
        for (const l of this.listeners) {
          await l({ type: "turn_end", message: assistantMsg });
          await l({ type: "agent_end", messages: [assistantMsg] });
        }
      },
    };

    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: () => fakeAgent,
      turnFinalizeTimeoutMs: 1_000,
    });

    // Provide historical thread events for this context
    const historicalEvents: EventEnvelope[] = [
      {
        event_id: "evt_hist_1",
        type: "message",
        workspace_id: "workspace:test",
        source_endpoint_id: "actor:workspace:test:operator",
        thread_id: "thread-ctx-C",
        context_id: "ctx_card_C",
        correlation_id: null,
        artefact_version_ids: [],
        destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:floe" },
        content: { text: "history message from operator" },
        response: { expected: false },
        metadata: {},
        created_at: "2024-01-01T00:00:00.000Z",
      } as EventEnvelope,
    ];

    const bus = makeBusWith(new Map([
      ["ctx_card_C", { events: historicalEvents, next_cursor: "cursor_after_hist" }],
    ]));
    const context = makeMockContext(bus);

    // This is a cold start: no session object exists yet.
    const triggerDelivery = makeDeliveryWithContext(
      "del-C1", "thread-ctx-C", "ctx_card_C", "new trigger message"
    );

    await adapter.handleBundle(context, triggerDelivery, MOCK_RUNTIME_CONFIG);

    // Historical Context content is not prepaid into the model input.
    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0];
    expect(prompt).toContain("[Context Envelope]");
    expect(prompt).toContain("history: available on demand with context_history");
    expect(prompt).not.toContain("history message from operator");
    expect(prompt).toContain("new trigger message");
  });

  it("warm continuation still does not fetch or inject Context history", async () => {
    const capturedPrompts: string[] = [];
    let listContextEventsCallCount = 0;
    let lastSince: string | null | undefined = undefined;

    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(message: any) {
        capturedPrompts.push(message?.content?.[0]?.text ?? "");
        const assistantMsg = { role: "assistant", content: [{ type: "text", text: "ack" }],
          usage: { input: 1, output: 1, totalTokens: 2 }, model: "mock-model", provider: "mock-provider" };
        for (const l of this.listeners) {
          await l({ type: "turn_end", message: assistantMsg });
          await l({ type: "agent_end", messages: [assistantMsg] });
        }
      },
    };

    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: () => fakeAgent,
      turnFinalizeTimeoutMs: 1_000,
    });

    const contextId = "ctx_card_D";
    const firstTurnEvents: EventEnvelope[] = [
      {
        event_id: "evt_hist_old",
        type: "message",
        workspace_id: "workspace:test",
        source_endpoint_id: "actor:workspace:test:operator",
        thread_id: "thread-D",
        context_id: contextId,
        correlation_id: null,
        artefact_version_ids: [],
        destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:floe" },
        content: { text: "old history message" },
        response: { expected: false },
        metadata: {},
        created_at: "2024-01-01T00:00:00.000Z",
      } as EventEnvelope,
    ];
    const secondTurnEvents: EventEnvelope[] = [
      {
        event_id: "evt_hist_new",
        type: "message",
        workspace_id: "workspace:test",
        source_endpoint_id: "actor:workspace:test:operator",
        thread_id: "thread-D",
        context_id: contextId,
        correlation_id: null,
        artefact_version_ids: [],
        destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:floe" },
        content: { text: "delta-only message" },
        response: { expected: false },
        metadata: {},
        created_at: "2024-01-02T00:00:00.000Z",
      } as EventEnvelope,
    ];

    // Custom bus that tracks calls and returns different results per turn
    let turnCount = 0;
    const bus = { recordRuntimeTurnResult,
      async appendRuntimeTelemetry(_input: any) {},
      async emit(_event: any) {},
      async getContext(contextId: string) {
        return {
          context_id: contextId, workspace_id: "workspace:test",
          parent_context_id: null, created_by_endpoint_id: null,
          scope_id: null, created_at: new Date().toISOString(),
          participants: [],
        };
      },
      async listContextEvents(ctxId: string, since?: string | null) {
        listContextEventsCallCount++;
        lastSince = since;
        if (turnCount === 0) {
          return { events: firstTurnEvents, next_cursor: "cursor_after_first" };
        } else {
          return { events: secondTurnEvents, next_cursor: "cursor_after_second" };
        }
      },
      async listEndpoints() { return []; },
    };
    const context = { bridge_id: "bridge:test", bus } as any;

    // Turn 1: cold start
    await adapter.handleBundle(
      context,
      makeDeliveryWithContext("del-D1", "thread-D", contextId, "first trigger"),
      MOCK_RUNTIME_CONFIG
    );
    turnCount++; // Advance for second turn

    // Turn 2: warm continue
    await adapter.handleBundle(
      context,
      makeDeliveryWithContext("del-D2", "thread-D", contextId, "second trigger"),
      MOCK_RUNTIME_CONFIG
    );

    // Two prompts sent to the agent
    expect(capturedPrompts).toHaveLength(2);

    expect(listContextEventsCallCount).toBe(0);
    expect(lastSince).toBeUndefined();
    expect(capturedPrompts[0]).not.toContain("old history message");
    expect(capturedPrompts[1]).not.toContain("delta-only message");
    expect(capturedPrompts[0]).toContain("first trigger");
    expect(capturedPrompts[1]).toContain("second trigger");
  });

  it("a failed turn also performs no automatic history fetch", async () => {
    const listContextEventsCursors: Array<string | null | undefined> = [];

    let turnAttempt = 0;
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(_message: any) {
        turnAttempt++;
        if (turnAttempt === 1) {
          // First turn: simulate agent_end with stop_reason=error → turn fails
          for (const l of this.listeners) {
            await l({
              type: "agent_end",
              messages: [{
                role: "assistant",
                content: [{ type: "text", text: "" }],
                stopReason: "error",
                errorMessage: "400 Bad Request",
                usage: null, model: "mock-model", provider: "mock-provider",
              }],
            });
          }
        } else {
          // Second turn: success
          const assistantMsg = { role: "assistant", content: [{ type: "text", text: "ack" }],
            usage: { input: 1, output: 1, totalTokens: 2 }, model: "mock-model", provider: "mock-provider" };
          for (const l of this.listeners) {
            await l({ type: "turn_end", message: assistantMsg });
            await l({ type: "agent_end", messages: [assistantMsg] });
          }
        }
      },
    };

    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: () => fakeAgent,
      turnFinalizeTimeoutMs: 1_000,
    });

    const bus = { recordRuntimeTurnResult,
      async appendRuntimeTelemetry(_input: any) {},
      async emit(_event: any) {},
      async getContext(contextId: string) {
        return { context_id: contextId, workspace_id: "workspace:test",
          parent_context_id: null, created_by_endpoint_id: null,
          scope_id: null, created_at: new Date().toISOString(), participants: [] };
      },
      async listContextEvents(_ctxId: string, since?: string | null) {
        listContextEventsCursors.push(since ?? null);
        return { events: [], next_cursor: "cursor_after_fetch" };
      },
      async listEndpoints() { return []; },
    };
    const context = { bridge_id: "bridge:test", bus } as any;

    // Turn 1: fails with 400 — session is invalidated and deleted
    try {
      await adapter.handleBundle(
        context,
        makeDeliveryWithContext("del-E1", "thread-E", "ctx_card_E", "first"),
        MOCK_RUNTIME_CONFIG
      );
    } catch {
      // expected failure
    }

    // Turn 2: new session (prior session deleted on 400 error)
    // A fresh session = cold start again = cursor should be null
    try {
      await adapter.handleBundle(
        context,
        makeDeliveryWithContext("del-E2", "thread-E", "ctx_card_E", "retry"),
        MOCK_RUNTIME_CONFIG
      );
    } catch {
      // may or may not fail depending on the 400 handling
    }

    expect(listContextEventsCursors).toHaveLength(0);
  });

  it("includes the current trigger once while excluding older events", async () => {
    const capturedPrompts: string[] = [];

    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(message: any) {
        capturedPrompts.push(message?.content?.[0]?.text ?? "");
        const assistantMsg = { role: "assistant", content: [{ type: "text", text: "ack" }],
          usage: { input: 1, output: 1, totalTokens: 2 }, model: "mock-model", provider: "mock-provider" };
        for (const l of this.listeners) {
          await l({ type: "turn_end", message: assistantMsg });
          await l({ type: "agent_end", messages: [assistantMsg] });
        }
      },
    };

    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: () => fakeAgent,
      turnFinalizeTimeoutMs: 1_000,
    });

    const contextId = "ctx_card_F";
    const triggerDelivery = makeDeliveryWithContext(
      "del-F1", "thread-F", contextId, "the trigger text"
    );
    const triggerEventId = triggerDelivery.events[0].event_id;

    // Bus returns the trigger event ALSO in the context events (as would happen in reality)
    const bus = { recordRuntimeTurnResult,
      async appendRuntimeTelemetry(_input: any) {},
      async emit(_event: any) {},
      async getContext(contextId: string) {
        return { context_id: contextId, workspace_id: "workspace:test",
          parent_context_id: null, created_by_endpoint_id: null,
          scope_id: null, created_at: new Date().toISOString(), participants: [] };
      },
      async listContextEvents(_ctxId: string) {
        return {
          events: [
            {
              event_id: "evt_hist_1",
              type: "message",
              workspace_id: "workspace:test",
              source_endpoint_id: "actor:workspace:test:operator",
              thread_id: "thread-F",
              context_id: contextId,
              correlation_id: null,
              artefact_version_ids: [],
              destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:floe" },
              content: { text: "historical message" },
              response: { expected: false },
              metadata: {},
              created_at: "2024-01-01T00:00:00.000Z",
            } as EventEnvelope,
            // The trigger event is also in the thread
            {
              ...triggerDelivery.events[0],
              event_id: triggerEventId,
            },
          ],
          next_cursor: "cursor_F",
        };
      },
      async listEndpoints() { return []; },
    };
    const context = { bridge_id: "bridge:test", bus } as any;

    await adapter.handleBundle(context, triggerDelivery, MOCK_RUNTIME_CONFIG);

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0];

    expect(prompt).not.toContain("historical message");
    const occurrences = (prompt.match(/the trigger text/g) || []).length;
    expect(occurrences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// D-B invariant: reply still lands in origin context
// ---------------------------------------------------------------------------

describe("Explicit emit routing", () => {
  it("lets the bus resolve an actor destination from the current delivery Context", async () => {
    let emitToolFn: ((callId: string, params: any) => Promise<any>) | null = null;
    const emittedEvents: any[] = [];
    const fakeAgent = {
      tools: [] as any[],
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(_message: any) {
        // Use the emit tool to reply — without specifying context_id
        if (emitToolFn) {
          await emitToolFn("tc_emit", {
            type: "message",
            destination: "operator",
            text: "reply without explicit context_id",
          });
        }
        const assistantMsg = { role: "assistant", content: [{ type: "text", text: "ack" }],
          usage: { input: 1, output: 1, totalTokens: 2 }, model: "mock-model", provider: "mock-provider" };
        for (const l of this.listeners) {
          await l({ type: "turn_end", message: assistantMsg });
          await l({ type: "agent_end", messages: [assistantMsg] });
        }
      },
    };

    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: (input) => {
        // Capture the emit tool
        const emitTool = input.tools.find((t: any) => t.name === "emit");
        if (emitTool) emitToolFn = emitTool.execute;
        return fakeAgent as any;
      },
      turnFinalizeTimeoutMs: 1_000,
    });

    const bus = { recordRuntimeTurnResult,
      async appendRuntimeTelemetry(_input: any) {},
      async emit(event: any) { emittedEvents.push(event); },
      async getContext(contextId: string) {
        return { context_id: contextId, workspace_id: "workspace:test",
          parent_context_id: null, created_by_endpoint_id: null,
          scope_id: null, created_at: new Date().toISOString(),
          participants: ["actor:workspace:test:operator", "actor:workspace:test:floe"] };
      },
      async listContextEvents(_ctxId: string) {
        return { events: [], next_cursor: null };
      },
      async listEndpoints(workspaceId: string) {
        return [
          { endpoint_id: "actor:workspace:test:operator", name: "operator", status: "idle" },
        ];
      },
    };
    const context = { bridge_id: "bridge:test", bus } as any;

    await adapter.handleBundle(
      context,
      makeDeliveryWithContext("del-G1", "thread-G", "ctx_origin_G", "message from operator"),
      MOCK_RUNTIME_CONFIG
    );

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].context_id).toBeNull();
    expect(emittedEvents[0].current_delivery_context_id).toBe("ctx_origin_G");
  });
});
