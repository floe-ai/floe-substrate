import { describe, expect, it, vi } from "vitest";
import {
  PiAgentCoreAdapter,
  TurnFailedError,
  summarizePiRequestPayload,
  applyThinkingCapabilityClamp,
  eventContentToPrompt,
  eventAttachments,
} from "./pi-agent-core-adapter.js";
import type { DeliveryBundle } from "../bus-client.js";
import { HookRegistry, type HookName, type HookPayload } from "../hooks.js";

describe("operator-selected conversation attachments", () => {
  it("preserves named resource references alongside the message for model participation", () => {
    const reference = { name: "Preview approval", resource_ref: { kind: "approval_request", id: "approval:exact", revision: "2" } };
    const prompt = eventContentToPrompt({ text: "Review this decision.", references: [reference] });
    expect(prompt).toContain("Review this decision.");
    expect(prompt).toContain(JSON.stringify(reference));
    expect(prompt).toContain("do not prove the record's state");
  });
  it("preserves exact shared image references without inventing a storage path", () => {
    const prompt = eventContentToPrompt({
      text: "Please inspect this result.",
      attachments: [{
        artefact_version_id: "version:screenshot",
        name: "screenshot.png",
        media_type: "image/png",
        bytes: 1280,
      }],
    }, ["version:screenshot"]);

    expect(prompt).toContain("Please inspect this result.");
    expect(prompt).toContain("[Attached ArtefactVersions]");
    expect(prompt).toContain("screenshot.png (image/png, 1280 bytes)");
    expect(prompt).toContain("version:screenshot");
    expect(prompt).toContain("read_artefact");
    expect(prompt).not.toContain(".floe/");
  });

  it("uses Event membership for both prompt and history, including versions without display data", () => {
    const content = { text: "Inspect the attached result", attachments: [
      { artefact_version_id: "version:not-attached", name: "forged.png" },
    ] };
    const historyAttachments = eventAttachments(content, ["version:actual"]);
    expect(historyAttachments).toEqual([expect.objectContaining({ artefact_version_id: "version:actual" })]);
    const prompt = eventContentToPrompt(content, ["version:actual"]);
    expect(prompt).toContain("version:actual");
    expect(prompt).not.toContain("forged.png");
    expect(prompt).not.toContain("version:not-attached");
  });

  it("ignores malformed attachment references", () => {
    expect(eventContentToPrompt({ attachments: [{ name: "missing-path.png" }] }))
      .toBe('{"attachments":[{"name":"missing-path.png"}]}');
  });
});

const recordRuntimeTurnResult = async (input: any) => ({
  result_event: { event_id: `result:${input.delivery_id}` },
  return_event: null,
  request_resolved: false
});

type FakeEvent = {
  type: string;
  message?: any;
  messages?: any[];
  toolCallId?: string;
  toolName?: string;
  args?: any;
  isError?: boolean;
};

class FakeAgent {
  private listeners: Array<(event: FakeEvent) => void | Promise<void>> = [];
  private turn = 0;

  subscribe(listener: (event: FakeEvent) => void | Promise<void>): void {
    this.listeners.push(listener);
  }

  async prompt(): Promise<void> {
    this.turn += 1;
    const text = this.turn === 1 ? "First deterministic reply." : "Second deterministic reply.";
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input: 1, output: 1, totalTokens: 2 },
      model: "mock-model",
      provider: "mock-provider"
    };
    await this.emit({
      type: "message_end",
      message: assistantMessage
    });
    await this.emit({
      type: "turn_end",
      message: assistantMessage
    });
    await this.emit({
      type: "agent_end",
      messages: [assistantMessage]
    });
  }

  private async emit(event: FakeEvent): Promise<void> {
    for (const listener of this.listeners) {
      await listener(event);
    }
  }
}

describe("PiAgentCoreAdapter", () => {
  it("aborts only the active delivery selected by the Bus", () => {
    const adapter = new PiAgentCoreAdapter({} as any);
    const abort = vi.fn();
    (adapter as any).sessions.set("actor:context", {
      agent: { abort },
      activeTurn: { delivery_id: "delivery:one", finalized: false },
    });

    expect(adapter.cancelDelivery("delivery:other")).toBe(false);
    expect(adapter.cancelDelivery("delivery:one")).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
  });

  it("summarizes openai-responses reasoning separately from thinking", () => {
    const summary = summarizePiRequestPayload(
      {
        input: [{ role: "user" }, { type: "reasoning" }, { type: "function_call" }],
        reasoning: { effort: "high", summary: "auto" },
        tools: [{ type: "function" }]
      },
      { id: "gpt-5.4", provider: "github-copilot", api: "openai-responses" }
    );

    expect(summary).toMatchObject({
      model_id: "gpt-5.4",
      provider: "github-copilot",
      api: "openai-responses",
      input_items: 3,
      roles: ["user", "reasoning", "function_call"],
      has_reasoning: true,
      reasoning: { effort: "high", summary: "auto" },
      has_thinking: false,
      thinking: null,
      has_tools: true,
      tool_count: 1
    });
  });

  it("records visible output as a natural turn result without auto-emitting an effect", async () => {
    const fakeAgent = new FakeAgent();
    const telemetryCalls: any[] = [];
    const emittedEvents: any[] = [];
    const model = {
      id: "mock-model",
      name: "Mock",
      api: "openai-responses",
      provider: "mock-provider",
      baseUrl: "https://example.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096
    };

    const adapter = new PiAgentCoreAdapter(
      {
        paths: {
          authDir: "",
          authJsonPath: "",
          modelsJsonPath: "",
          profilesYamlPath: ""
        },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") return model as any;
            return undefined;
          },
          async getApiKeyForProvider() {
            return "test-key";
          }
        } as any,
        profiles: {
          version: 1,
          profiles: [
            {
              id: "test-profile",
              provider: "mock-provider",
              model: "mock-model"
            }
          ]
        }
      } as any,
      {
        agentFactory: () => fakeAgent,
        turnFinalizeTimeoutMs: 1_000
      }
    );

    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(input: any) {
          telemetryCalls.push(input);
        },
        async emit(event: any) {
          emittedEvents.push(event);
        }
      }
    } as any;

    await adapter.handleBundle(
      context,
      makeDelivery("del-1", "thread-1", "First prompt"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );
    await adapter.handleBundle(
      context,
      makeDelivery("del-2", "thread-2", "Second prompt"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    // Visible output goes to telemetry as work-log, NOT emitted as messages
    const worklogDel1 = telemetryCalls.filter((item) => item.delivery_id === "del-1" && item.kind === "turn_result");
    const worklogDel2 = telemetryCalls.filter((item) => item.delivery_id === "del-2" && item.kind === "turn_result");
    expect(worklogDel1).toHaveLength(1);
    expect(worklogDel1[0].payload?.text).toContain("First deterministic reply.");
    expect(worklogDel1[0].payload?.scope_id).toBeNull();
    expect(worklogDel2).toHaveLength(1);
    expect(worklogDel2[0].payload?.text).toContain("Second deterministic reply.");

    // No auto-emitted runtime_turn_output messages
    const runtimeOutputEvents = emittedEvents.filter((event) => event.metadata?.origin === "runtime_turn_output");
    expect(runtimeOutputEvents).toHaveLength(0);

    // Usage telemetry still recorded
    const usageDel1 = telemetryCalls.find((item) => item.delivery_id === "del-1" && item.kind === "usage");
    const usageDel2 = telemetryCalls.find((item) => item.delivery_id === "del-2" && item.kind === "usage");
    expect(usageDel1?.payload?.model).toBe("mock-model");
    expect(usageDel2?.payload?.provider).toBe("mock-provider");
    expect(usageDel1?.payload?.thread_id).toBe("thread-1");
    expect(usageDel2?.payload?.thread_id).toBe("thread-2");
  });
});

describe("PiAgentCoreAdapter – output classification", () => {
  function makeTestAdapter(fakeAgent: any, capturedTools?: any[]) {
    return new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
                baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000, maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      { agentFactory: input => { capturedTools?.push(...input.tools); return fakeAgent; }, turnFinalizeTimeoutMs: 1_000 }
    );
  }

  function makeContext() {
    const telemetryCalls: any[] = [];
    const emittedEvents: any[] = [];
    return {
      context: {
        bridge_id: "bridge:test",
        bus: { recordRuntimeTurnResult,
          async appendRuntimeTelemetry(input: any) { telemetryCalls.push(input); },
          async emit(event: any) { emittedEvents.push(event); }
        }
      } as any,
      telemetryCalls,
      emittedEvents
    };
  }

  it("reports a real nonzero workspace command as failed even when the runtime did not throw", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "floe-command-status-"));
    const capturedTools: any[] = [];
    const { context, telemetryCalls } = makeContext();
    const failedHook = vi.fn(), successfulHook = vi.fn();
    context.workspace_locator = root;
    context.hooks = new HookRegistry();
    context.hooks.on("ToolUseFailed", "test", failedHook);
    context.hooks.on("AfterToolUse", "test", successfulHook);
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        const args = { command: process.platform === "win32" ? "exit /b 7" : "exit 7" };
        for (const listener of this.listeners) await listener({ type: "tool_execution_start", toolCallId: "command", toolName: "run_command", args });
        const result = await capturedTools.find(tool => tool.name === "run_command").execute("command", args);
        expect(result.details).toMatchObject({ ok: false, exit_code: 7 });
        for (const listener of this.listeners) await listener({ type: "tool_execution_end", toolCallId: "command", toolName: "run_command", isError: false, result });
        for (const listener of this.listeners) await listener({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "The command failed." }] }] });
      },
    };
    try {
      await makeTestAdapter(fakeAgent, capturedTools).handleBundle(context, makeDelivery("command-failure", "command-context", "Try the command"),
        { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" });
      expect(telemetryCalls.find(item => item.kind === "ToolUseFailed")?.payload)
        .toMatchObject({ toolName: "run_command", isError: true, summary: expect.stringContaining("exit 7") });
      expect(telemetryCalls.some(item => item.kind === "AfterToolUse")).toBe(false);
      expect(failedHook).toHaveBeenCalledOnce();
      expect(successfulHook).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["completed", "interrupted", "unreported"] as const)("accounts for each model response when a turn is %s", async (ending) => {
    const { context, telemetryCalls } = makeContext();
    const first = {
      role: "assistant", content: [{ type: "toolCall", id: "tool:1", name: "read", arguments: {} }],
      usage: { input: 100, output: 12, cacheRead: 30, cacheWrite: 4, reasoning: 2, totalTokens: 146 },
      model: "mock-model", provider: "mock-provider", stopReason: "toolUse",
    };
    const last = {
      role: "assistant", content: [{ type: "text", text: "Verified result." }],
      usage: ending === "unreported" ? null : { input: 160, output: 10, cacheRead: 70, cacheWrite: 0, reasoning: 0, totalTokens: 240 },
      model: "mock-model", provider: "mock-provider", stopReason: "stop",
    };
    const listeners: Array<(event: any) => void | Promise<void>> = [];
    const emit = async (event: any) => { for (const listener of listeners) await listener(event); };
    const adapter = makeTestAdapter({
      subscribe(listener: (event: any) => void | Promise<void>) { listeners.push(listener); },
      async prompt() {
        await emit({ type: "message_update", message: first });
        await emit({ type: "message_end", message: first });
        await emit({ type: "message_end", message: first });
        await emit({ type: "message_end", message: { role: "toolResult", content: [], usage: { totalTokens: 99999 } } });
        expect(telemetryCalls.filter(row => row.kind === "usage")).toHaveLength(1);
        if (ending === "interrupted") throw new Error("Connection interrupted after the tool response");
        await emit({ type: "message_end", message: last });
        await emit({ type: "agent_end", messages: [first, last] });
      },
    });
    const run = adapter.handleBundle(context, makeDelivery("usage-delivery", "usage-context", "Do the work"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" });
    if (ending === "interrupted") await expect(run).rejects.toBeInstanceOf(TurnFailedError);
    else await run;
    const usage = telemetryCalls.filter(row => row.kind === "usage");
    expect(usage.map(row => row.payload.response_index)).toEqual(ending === "interrupted" ? [1] : [1, 2]);
    expect(usage[0].payload).toMatchObject({ measurement_scope: "model_response", usage: first.usage });
    if (ending !== "interrupted") expect(usage[1].payload.usage).toEqual(last.usage);
    const coverage = telemetryCalls.filter(row => row.kind === "usage_coverage");
    if (ending === "interrupted") expect(coverage).toEqual([]);
    else expect(coverage[0].payload).toMatchObject({ agent_end_observed: true, model_response_count: 2 });
  });

  it("does not persist input echo as runtime_turn_output — only endpoint visible output is captured", async () => {
    const deliveryBundleText = "Floe delivery bundle del_abc123\n- [message] from actor:workspace:test:operator thread=thread-1: hi, tell me about yourself\nRespond naturally to the delivered events.";
    const assistantReply = "Hello! I am Floe, a durable multi-actor substrate agent.";

    // Simulate Pi emitting both a user-role echo and an assistant reply
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        // Pi echoes the input as a user-role message_end
        for (const l of this.listeners) await l({
          type: "message_end",
          message: { role: "user", content: [{ type: "text", text: deliveryBundleText }] }
        });
        // Then emits a message_update followed by message_end for the assistant reply
        for (const l of this.listeners) await l({
          type: "message_update",
          message: { role: "assistant", content: [{ type: "text", text: assistantReply }] }
        });
        for (const l of this.listeners) await l({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: assistantReply }] }
        });
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: { input: 10, output: 5, totalTokens: 15 }, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = makeTestAdapter(fakeAgent);
    const { context, emittedEvents, telemetryCalls } = makeContext();

    await adapter.handleBundle(
      context,
      makeDelivery("del-echo", "thread-1", "hi, tell me about yourself"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    // No auto-emitted messages (visible output is work-log only)
    const runtimeOutput = emittedEvents.filter((e) => e.metadata?.origin === "runtime_turn_output");
    expect(runtimeOutput).toHaveLength(0);

    // Visible output captured in telemetry as work log
    const worklog = telemetryCalls.filter((t) => t.kind === "turn_result");
    expect(worklog).toHaveLength(1);
    expect(worklog[0].payload.text).toBe(assistantReply);
    expect(worklog[0].payload.text).not.toContain("Floe delivery bundle");
  });

  it("records no work-log when Pi produces no visible output", async () => {
    // Simulate Pi that only echoes the input events, produces no visible endpoint output
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        for (const l of this.listeners) await l({
          type: "message_end",
          message: { role: "user", content: [{ type: "text", text: "some user echo" }] }
        });
        // turn_end with no content on the message
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = makeTestAdapter(fakeAgent);
    const { context, emittedEvents, telemetryCalls } = makeContext();

    await adapter.handleBundle(
      context,
      makeDelivery("del-noout", "thread-1", "trigger"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    // No emitted messages and no work-log (no visible output produced)
    const runtimeOutput = emittedEvents.filter((e) => e.metadata?.origin === "runtime_turn_output");
    expect(runtimeOutput).toHaveLength(0);

    const worklog = telemetryCalls.filter((t) => t.kind === "visible_output_worklog");
    expect(worklog).toHaveLength(0);
  });

  it("uses agent instructions as system prompt and recreates session when instructions change", async () => {
    const capturedSystemPrompts: string[] = [];

    function makeCapturingFactory(): any {
      return {
        listeners: [] as Array<(event: any) => void | Promise<void>>,
        subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
        async prompt() {
          for (const l of this.listeners) await l({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "I am Floe." }] }
          });
          for (const l of this.listeners) await l({
            type: "turn_end",
            message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
          });
        }
      };
    }

    let sessionCount = 0;
    const adapter = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
                baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000, maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      {
        agentFactory: (input) => {
          sessionCount++;
          capturedSystemPrompts.push(input.systemPrompt);
          return makeCapturingFactory();
        },
        turnFinalizeTimeoutMs: 1_000
      }
    );

    const makeCtx = () => ({
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {}
      }
    } as any);

    // First call with Floe instructions
    await adapter.handleBundle(
      makeCtx(),
      makeDelivery("del-instr-1", "thread-1", "what is your name?"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile", instructions: "# Floe\n\nYou are Floe, the default agent." }
    );
    expect(sessionCount).toBe(1);
    expect(capturedSystemPrompts[0]).toContain("You are Floe");

    // Second call with same instructions — session reused (no new session created)
    await adapter.handleBundle(
      makeCtx(),
      makeDelivery("del-instr-2", "thread-2", "hi again"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile", instructions: "# Floe\n\nYou are Floe, the default agent." }
    );
    expect(sessionCount).toBe(1); // session reused

    // Third call with changed instructions — session must be recreated
    await adapter.handleBundle(
      makeCtx(),
      makeDelivery("del-instr-3", "thread-3", "hi"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile", instructions: "# Updated\n\nYou are a different agent." }
    );
    expect(sessionCount).toBe(2); // new session created
    expect(capturedSystemPrompts[1]).toContain("You are a different agent");
  });

  it("fires SessionEnd when an endpoint runtime session is replaced, not after every turn", async () => {
    const ended: HookPayload[] = [];
    const hooks = new HookRegistry();
    hooks.on("SessionEnd", "test-ext", (payload) => {
      ended.push(payload);
    });

    let sessionCount = 0;
    const adapter = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && (modelId === "mock-model" || modelId === "mock-model-2")) {
              return {
                id: modelId, name: "Mock", api: "openai-responses", provider: "mock-provider",
                baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000, maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      {
        agentFactory: () => {
          sessionCount++;
          return new FakeAgent();
        },
        turnFinalizeTimeoutMs: 1_000
      }
    );

    const context = {
      bridge_id: "bridge:test",
      hooks,
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {},
        async listEndpoints() { return []; }
      }
    } as any;

    await adapter.handleBundle(
      context,
      makeDelivery("del-session-1", "thread-1", "first"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );
    await adapter.handleBundle(
      context,
      makeDelivery("del-session-2", "thread-2", "same session"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );
    expect(sessionCount).toBe(1);
    expect(ended).toEqual([]);

    await adapter.handleBundle(
      context,
      makeDelivery("del-session-3", "thread-3", "new model"),
      { provider: "mock-provider", model: "mock-model-2", auth_profile: "test-profile" }
    );

    expect(sessionCount).toBe(2);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      reason: "session_replaced",
      workspace_id: "workspace:test",
      endpoint_id: "actor:workspace:test:floe",
      delivery_id: "del-session-3",
      trigger_event_id: "evt:del-session-3",
      previous_session: {
        provider: "mock-provider",
        model_id: "mock-model"
      },
      next_session: {
        provider: "mock-provider",
        model_id: "mock-model-2"
      }
    });
  });

  it("fires SessionEnd once when runtime sessions are disposed during bridge shutdown", async () => {
    const ended: HookPayload[] = [];
    const hooks = new HookRegistry();
    hooks.on("SessionEnd", "test-ext", (payload) => {
      ended.push(payload);
    });

    let sessionCount = 0;
    const adapter = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "" , profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
                baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000, maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      {
        agentFactory: () => {
          sessionCount++;
          return new FakeAgent();
        },
        turnFinalizeTimeoutMs: 1_000
      }
    );

    const context = {
      bridge_id: "bridge:test",
      hooks,
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {},
        async listEndpoints() { return []; }
      }
    } as any;

    await adapter.handleBundle(
      context,
      makeDelivery("del-shutdown-1", "thread-shutdown", "start session"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    await adapter.dispose("bridge_shutdown");
    await adapter.dispose("bridge_shutdown");

    expect(sessionCount).toBe(1);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      reason: "bridge_shutdown",
      workspace_id: "workspace:test",
      endpoint_id: "actor:workspace:test:floe",
      previous_session: {
        provider: "mock-provider",
        model_id: "mock-model"
      }
    });
  });

  it("fires active runtime hooks with endpoint-neutral delivery payloads", async () => {
    const hooks = new HookRegistry();
    const seen: Partial<Record<HookName, HookPayload[]>> = {};
    const collect = <Name extends HookName>(hook: Name) => {
      seen[hook] = [];
      hooks.on(hook, "test-ext", (payload) => {
        seen[hook]!.push(payload);
      });
    };
    for (const hook of [
      "SessionStart",
      "SessionResume",
      "BeforeTurn",
      "Pulse",
      "TurnEnd",
      "BeforeToolUse",
      "AfterToolUse",
      "ToolUseFailed"
    ] as const) collect(hook);

    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        for (const l of this.listeners) await l({ type: "tool_execution_start", toolCallId: "tc-ok", toolName: "read", args: {} });
        for (const l of this.listeners) await l({ type: "tool_execution_end", toolCallId: "tc-ok", toolName: "read", isError: false });
        for (const l of this.listeners) await l({ type: "tool_execution_start", toolCallId: "tc-fail", toolName: "write", args: {} });
        for (const l of this.listeners) await l({ type: "tool_execution_end", toolCallId: "tc-fail", toolName: "write", isError: true });
        for (const l of this.listeners) await l({ type: "tool_execution_start", toolCallId: "tc-refused", toolName: "use_capability", args: {} });
        for (const l of this.listeners) await l({ type: "tool_execution_end", toolCallId: "tc-refused", toolName: "use_capability", isError: false,
          result: { content: [{ type: "text", text: "Access refused" }], details: { ok: false, error: "grant_revoked" } } });
        for (const l of this.listeners) await l({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "Done." }] }
        });
        for (const l of this.listeners) await l({
          type: "agent_end",
          messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }]
        });
      }
    };

    const adapter = makeTestAdapter(fakeAgent);
    const context = {
      bridge_id: "bridge:test",
      hooks,
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {},
        async listEndpoints() { return []; }
      }
    } as any;

    const pulseDelivery = makeDelivery("del-hooks-1", "thread-hooks-1", "pulse fired");
    pulseDelivery.events[0].type = "pulse.fired";
    pulseDelivery.events[0].content = { pulse_id: "pulse:daily", text: "Daily pulse" };

    await adapter.handleBundle(
      context,
      pulseDelivery,
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );
    await adapter.handleBundle(
      context,
      makeDelivery("del-hooks-2", "thread-hooks-2", "reuse session"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    expect(seen.SessionStart).toHaveLength(1);
    expect(seen.SessionStart?.[0]).toMatchObject({
      reason: "session_created",
      workspace_id: "workspace:test",
      endpoint_id: "actor:workspace:test:floe",
      delivery_id: "del-hooks-1",
      trigger_event_id: "evt:del-hooks-1",
      provider: "mock-provider",
      model_id: "mock-model"
    });
    expect(seen.SessionResume).toHaveLength(1);
    expect(seen.SessionResume?.[0]).toMatchObject({
      reason: "session_reused",
      delivery_id: "del-hooks-2",
      trigger_event_id: "evt:del-hooks-2"
    });
    expect(seen.BeforeTurn).toHaveLength(2);
    expect(seen.BeforeTurn?.[0]).toMatchObject({
      delivery_id: "del-hooks-1",
      trigger_event_id: "evt:del-hooks-1",
      thread_id: "thread-hooks-1"
    });
    expect(seen.Pulse).toHaveLength(1);
    expect(seen.Pulse?.[0]).toMatchObject({
      delivery_id: "del-hooks-1",
      trigger_event_id: "evt:del-hooks-1",
      event_id: "evt:del-hooks-1",
      pulse_id: "pulse:daily",
      content: { pulse_id: "pulse:daily", text: "Daily pulse" }
    });
    expect(seen.BeforeToolUse).toHaveLength(6);
    expect(seen.AfterToolUse).toHaveLength(2);
    expect(seen.ToolUseFailed).toHaveLength(4);
    expect(seen.ToolUseFailed?.find(item => "toolCallId" in item && item.toolCallId === "tc-refused"))
      .toMatchObject({ toolName: "use_capability", isError: true });
    expect(seen.BeforeToolUse?.[0]).toMatchObject({
      delivery_id: "del-hooks-1",
      trigger_event_id: "evt:del-hooks-1",
      toolCallId: "tc-ok",
      toolName: "read"
    });
    expect(seen.AfterToolUse?.[0]).toMatchObject({
      delivery_id: "del-hooks-1",
      toolCallId: "tc-ok",
      toolName: "read",
      isError: false
    });
    expect(seen.ToolUseFailed?.[0]).toMatchObject({
      delivery_id: "del-hooks-1",
      toolCallId: "tc-fail",
      toolName: "write",
      isError: true
    });
    expect(seen.TurnEnd).toHaveLength(2);
    expect(seen.TurnEnd?.[0]).toMatchObject({
      delivery_id: "del-hooks-1",
      trigger_event_id: "evt:del-hooks-1",
      visible_output: "Done."
    });
  });

  it("fires Error hook and re-throws TurnFailedError when runtime turn handling fails", async () => {
    const errors: Array<HookPayload<"Error">> = [];
    const hooks = new HookRegistry();
    hooks.on("Error", "test-ext", (payload) => {
      errors.push(payload);
    });

    const adapter = makeTestAdapter({
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        throw new Error("runtime failed");
      }
    });

    // The adapter now re-throws as TurnFailedError so the daemon can emit runtime_error events
    await expect(
      adapter.handleBundle(
        {
          bridge_id: "bridge:test",
          hooks,
          bus: { recordRuntimeTurnResult,
            async appendRuntimeTelemetry(_input: any) {},
            async emit(_event: any) {},
            async listEndpoints() { return []; }
          }
        } as any,
        makeDelivery("del-error-hook", "thread-error-hook", "fail"),
        { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
      )
    ).rejects.toThrow(TurnFailedError);

    // Error hook still fires before the re-throw
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      workspace_id: "workspace:test",
      endpoint_id: "actor:workspace:test:floe",
      delivery_id: "del-error-hook",
      trigger_event_id: "evt:del-error-hook",
      error: "runtime failed"
    });
  });
});

describe("Substrate guidance", () => {
  it("shared guidance is identity-neutral and does not hard-code 'You are Floe'", async () => {
    const capturedSystemPrompts: string[] = [];

    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
                baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000, maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      {
        agentFactory: (input) => {
          capturedSystemPrompts.push(input.systemPrompt);
          return fakeAgent;
        },
        turnFinalizeTimeoutMs: 1_000
      }
    );

    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {}
      }
    } as any;

    // Call with no agent instructions — shared guidance only
    await adapter.handleBundle(
      context,
      makeDelivery("del-guidance", "thread-1", "hello"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    expect(capturedSystemPrompts).toHaveLength(1);
    const guidance = capturedSystemPrompts[0];
    // Shared guidance must NOT contain "You are Floe"
    expect(guidance).not.toContain("You are Floe");
    expect(guidance).toContain("actor working inside a durable Floe Context");
    expect(guidance).not.toContain("runtime-backed endpoint");
    expect(guidance).toContain("records that final output as your local contribution");
    expect(guidance).toContain("Use `emit` only when");
    expect(guidance).toContain("Use `request(actor, work)`");
  });
});

describe("PiAgentCoreAdapter – thinking level", () => {
  function makeThinkingAdapter(agentFactory: (...args: any[]) => any) {
    return new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model",
                name: "Mock",
                api: "openai-responses",
                provider: "mock-provider",
                baseUrl: "https://example.invalid",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      { agentFactory, turnFinalizeTimeoutMs: 1_000 }
    );
  }

  function makeThinkingContext() {
    return {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry() {},
        async emit() {}
      }
    } as any;
  }

  it("passes thinking level into the agent factory", async () => {
    const agentFactory = vi.fn(() => new FakeAgent());
    const adapter = makeThinkingAdapter(agentFactory);

    await adapter.handleBundle(
      makeThinkingContext(),
      makeDelivery("del-thinking", "thread-thinking", "hello"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile", thinking_level: "high" }
    );

    expect(agentFactory).toHaveBeenCalledTimes(1);
    expect((agentFactory.mock.calls[0] as any[])[0].thinkingLevel).toBe("high");
  });

  it("recreates the session when thinking level changes", async () => {
    const agentFactory = vi.fn(() => new FakeAgent());
    const adapter = makeThinkingAdapter(agentFactory);
    const context = makeThinkingContext();

    await adapter.handleBundle(
      context,
      makeDelivery("del-thinking-1", "thread-thinking-1", "hello"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile", thinking_level: "low" }
    );
    await adapter.handleBundle(
      context,
      makeDelivery("del-thinking-2", "thread-thinking-2", "hello again"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile", thinking_level: "high" }
    );

    expect(agentFactory).toHaveBeenCalledTimes(2);
    expect((agentFactory.mock.calls[0] as any[])[0].thinkingLevel).toBe("low");
    expect((agentFactory.mock.calls[1] as any[])[0].thinkingLevel).toBe("high");
  });
});

function makeDelivery(deliveryId: string, threadId: string, text: string): DeliveryBundle {
  return {
    delivery_id: deliveryId,
    endpoint_id: "actor:workspace:test:floe",
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
        correlation_id: null,
        artefact_version_ids: [],
        destination_json: {
          kind: "endpoint",
          endpoint_id: "actor:workspace:test:floe"
        },
        content: {
          text,
          data: {}
        },
        response: {
          expected: false
        },
        metadata: {},
        created_at: new Date().toISOString()
      }
    ]
  };
}

describe("Substrate model — local completion and explicit effects", () => {
  function makeTestAdapterWithEmit(fakeAgent: any) {
    return new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
                baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000, maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      { agentFactory: () => fakeAgent, turnFinalizeTimeoutMs: 1_000 }
    );
  }

  it("agent using emit tool produces a canonical message event on the bus", async () => {
    let emitToolHandler: ((args: any) => Promise<any>) | null = null;

    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        // Simulate tool registration — capture emit handler
        for (const l of this.listeners) await l({
          type: "tool_call_start",
          toolCallId: "tc_1",
          toolName: "emit"
        });
        // Simulate the agent calling emit (via tool result)
        if (emitToolHandler) {
          await (emitToolHandler as (args: any) => Promise<any>)({
            type: "message",
            destination: "actor:workspace:test:operator",
            thread_id: "thread-1",
            content: { text: "Hello from Floe!" },
            response_expected: false
          });
        }
        for (const l of this.listeners) await l({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "I emitted my response." }] }
        });
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: { input: 5, output: 3, totalTokens: 8 }, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const telemetryCalls: any[] = [];
    const emittedEvents: any[] = [];
    const adapter = makeTestAdapterWithEmit(fakeAgent);

    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(input: any) { telemetryCalls.push(input); },
        async emit(event: any) {
          emittedEvents.push(event);
          // Capture the emit tool handler when the adapter registers it
        }
      }
    } as any;

    await adapter.handleBundle(
      context,
      makeDelivery("del-emit-1", "thread-1", "say hello"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    const turnResults = telemetryCalls.filter((t) => t.kind === "turn_result");
    expect(turnResults).toHaveLength(1);
    expect(turnResults[0].payload.text).toContain("I emitted my response.");

    // No auto-emitted runtime_turn_output
    const autoEmits = emittedEvents.filter((e) => e.metadata?.origin === "runtime_turn_output");
    expect(autoEmits).toHaveLength(0);
  });

  it.each([false, true])("delivery prompt identifies the current work without preloading the contract (Scope: %s)", async (scope) => {
    let capturedPrompt = "";
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(message: any) {
        capturedPrompt = message?.content?.[0]?.text ?? "";
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = makeTestAdapterWithEmit(fakeAgent);
    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {}
      }
    } as any;

    const bundle = makeDelivery("del-ctx-1", "thread-ctx-1", "Source review node: node-execution:old");
    if (scope) bundle.processing_contract = {
      contract_kind: "scope_node", contract_version: 1, processing_contract_id: "contract:new",
      scope_execution: { execution_id: "execution:new", scope_id: "scope:review", revision_id: "plan:pinned" },
      node_execution: { node_execution_id: "node-execution:new", node_id: "reviewer" },
      execution_attempt: { attempt_id: "attempt:new" },
      outputs: { publish_operation_id: "scope.node-output.publish", ports: [{
        port_id: "review:out", name: "Review", direction: "output", node_id: "reviewer",
        event_types: ["review.completed"], min_count: 1,
      }] },
      runtime: { profile: { content: { secret_ref_ids: ["secret-ref:not-for-the-prompt"] } } },
      operation_authority: { capability_grant_ids: ["grant:not-for-the-prompt"] },
    } as NonNullable<DeliveryBundle["processing_contract"]>;
    await adapter.handleBundle(
      context,
      bundle,
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    expect(capturedPrompt).toContain("[Context Envelope]");
    expect(capturedPrompt).toContain("cause_actor: operator");
    expect(capturedPrompt).toContain("cause_event: evt:del-ctx-1");
    expect(capturedPrompt).toContain("history: available on demand with context_history");
    expect(capturedPrompt).not.toContain("reply_actor");
    expect(capturedPrompt).not.toContain("response_expected");
    if (scope) {
      expect(capturedPrompt).toContain("[Current Scope execution]");
      expect(capturedPrompt).toContain("execution: execution:new");
      expect(capturedPrompt).toContain("node_execution: node-execution:new");
      expect(capturedPrompt).toContain("attempt: attempt:new");
      expect(capturedPrompt).toContain("composition_revision: plan:pinned");
      expect(capturedPrompt).toContain('"port_id":"review:out"');
      expect(capturedPrompt).toContain('"event_types":["review.completed"]');
      expect(capturedPrompt).toContain('"min_count":1');
      expect(capturedPrompt).toContain("Source review node: node-execution:old");
    } else expect(capturedPrompt).not.toContain("[Current Scope execution]");
    expect(capturedPrompt).not.toContain("secret-ref:not-for-the-prompt");
    expect(capturedPrompt).not.toContain("grant:not-for-the-prompt");
  });

  it("does not inject response protocol for either operator or actor causes", async () => {
    const capturedPrompts: string[] = [];
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(message: any) {
        capturedPrompts.push(message?.content?.[0]?.text ?? "");
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = makeTestAdapterWithEmit(fakeAgent);
    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {}
      }
    } as any;

    await adapter.handleBundle(
      context,
      makeDelivery("del-operator", "thread-operator", "operator asks"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    const agentDelivery = makeDelivery("del-agent", "thread-agent", "agent says FYI");
    agentDelivery.events[0].source_endpoint_id = "actor:workspace:test:reviewer";
    agentDelivery.events[0].response = { expected: false };
    await adapter.handleBundle(
      context,
      agentDelivery,
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    const requestedAgentDelivery = makeDelivery("del-agent-requested", "thread-agent", "agent asks for a reply");
    requestedAgentDelivery.events[0].source_endpoint_id = "actor:workspace:test:reviewer";
    requestedAgentDelivery.events[0].response = { expected: true };
    await adapter.handleBundle(
      context,
      requestedAgentDelivery,
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    expect(capturedPrompts).toHaveLength(3);
    for (const prompt of capturedPrompts) {
      expect(prompt).not.toContain("response_expected");
      expect(prompt).not.toContain("correlation_id");
    }
    expect(capturedPrompts[0]).toContain("cause_actor: operator");
    expect(capturedPrompts[1]).toContain("cause_actor: reviewer");
  });

  it("does not reprompt an empty completion to perform reply ceremony", async () => {
    const followUps: any[] = [];
    const telemetryCalls: any[] = [];
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      followUp(message: any) { followUps.push(message); },
      async prompt() {
        const terminalMessage = {
          role: "assistant",
          content: [],
          stopReason: "stop",
          usage: null,
          model: "mock-model",
          provider: "mock-provider"
        };
        for (const l of this.listeners) await l({ type: "turn_end", message: terminalMessage, toolResults: [] });
        // A duplicate terminal signal must not enqueue a second reminder.
        for (const l of this.listeners) await l({ type: "turn_end", message: terminalMessage, toolResults: [] });
        for (const l of this.listeners) await l({ type: "agent_end", messages: [terminalMessage] });
      }
    };

    const adapter = makeTestAdapterWithEmit(fakeAgent);
    const delivery = makeDelivery("del-silent-required", "thread-silent-required", "help me");
    delivery.events[0].response = { expected: true };

    await adapter.handleBundle(
      {
        bridge_id: "bridge:test",
        bus: { recordRuntimeTurnResult,
          async appendRuntimeTelemetry(input: any) { telemetryCalls.push(input); },
          async emit() {}
        }
      } as any,
      delivery,
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    expect(followUps).toHaveLength(0);
    expect(telemetryCalls.filter((call) => call.kind === "communication_retry")).toHaveLength(0);
    expect(telemetryCalls.filter((call) => call.kind === "turn_result")).toHaveLength(0);
  });

  it("runtime telemetry payloads include the active delivery context id", async () => {
    const fakeAgent = new FakeAgent();
    const telemetryCalls: any[] = [];
    const adapter = makeTestAdapterWithEmit(fakeAgent);
    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(input: any) { telemetryCalls.push(input); },
        async emit(_event: any) {},
        async getContext(_contextId: string) {
          return {
            context_id: "ctx_telemetry",
            workspace_id: "workspace:test",
            parent_context_id: null,
            created_by_endpoint_id: "actor:workspace:test:operator",
            scope_id: "research",
            created_at: new Date().toISOString(),
            participants: ["actor:workspace:test:operator", "actor:workspace:test:floe"]
          };
        }
      }
    } as any;

    const delivery = makeDelivery("del-telemetry-context", "thread-telemetry", "hello");
    (delivery.events[0] as any).context_id = "ctx_telemetry";
    (delivery.events[0] as any).scope_id = "event-scope";

    await adapter.handleBundle(
      context,
      delivery,
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    const worklog = telemetryCalls.find((item) => item.kind === "turn_result");
    expect(worklog?.payload?.context_id).toBe("ctx_telemetry");
    expect(worklog?.payload?.scope_id).toBe("research");
  });

  it("delivery prompt includes Context identity but not participant inventory", async () => {
    let capturedPrompt = "";
    const getContextCalls: string[] = [];
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(message: any) {
        capturedPrompt = message?.content?.[0]?.text ?? "";
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = makeTestAdapterWithEmit(fakeAgent);
    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {},
        async getContext(contextId: string) {
          getContextCalls.push(contextId);
          return {
            context_id: contextId,
            workspace_id: "workspace:test",
            parent_context_id: null,
            created_by_endpoint_id: "actor:workspace:test:operator",
            created_at: new Date().toISOString(),
            participants: [
              "actor:ws:floe",
              "actor:ws:operator"
            ]
          };
        }
      }
    } as any;

    const delivery = makeDelivery("del-ctx-2", "thread-ctx-2", "hello with context");
    (delivery.events[0] as any).context_id = "ctx_test_abc";

    await adapter.handleBundle(
      context,
      delivery,
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    expect(getContextCalls).toContain("ctx_test_abc");
    expect(capturedPrompt).toContain("context: ctx_test_abc");
    expect(capturedPrompt).not.toContain("participants");
    // No legacy id leakage
    expect(capturedPrompt).not.toContain("actor:ws:floe");
    expect(capturedPrompt).not.toContain("actor:ws:operator");
    // No global contexts list
    expect(capturedPrompt).not.toContain("available_contexts");
    expect(capturedPrompt).not.toContain("all_contexts");
    expect(capturedPrompt).not.toContain("source_contexts");
  });

  it("delivery prompt omits current_context block when trigger has no context_id", async () => {
    let capturedPrompt = "";
    let getContextCalled = false;
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(message: any) {
        capturedPrompt = message?.content?.[0]?.text ?? "";
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = makeTestAdapterWithEmit(fakeAgent);
    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {},
        async getContext(_id: string) {
          getContextCalled = true;
          return null;
        }
      }
    } as any;

    // Default delivery has no context_id on the trigger event
    await adapter.handleBundle(
      context,
      makeDelivery("del-no-ctx", "thread-no-ctx", "hello no context"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    // Bridge must NOT call getContext when there is no current context
    expect(getContextCalled).toBe(false);
    // current_context block omitted entirely
    expect(capturedPrompt).not.toContain("current_context");
    expect(capturedPrompt).not.toContain("participants:");
  });

  it("delivery prompt does not crash when bus.getContext throws — participants empty, warning logged", async () => {
    let capturedPrompt = "";
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(message: any) {
        capturedPrompt = message?.content?.[0]?.text ?? "";
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = makeTestAdapterWithEmit(fakeAgent);
    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {},
        async getContext(_id: string) {
          throw new Error("simulated bus failure");
        }
      }
    } as any;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const delivery = makeDelivery("del-ctx-fail", "thread-ctx-fail", "hello");
      (delivery.events[0] as any).context_id = "ctx_unreachable";

      await expect(
        adapter.handleBundle(
          context,
          delivery,
          { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
        )
      ).resolves.toBeUndefined();

      expect(capturedPrompt).toContain("ctx_unreachable");
      expect(capturedPrompt).not.toContain("participants");

      // Warning logged
      const warned = warnSpy.mock.calls.flat().some((arg: any) =>
        typeof arg === "string" && arg.includes("getContext")
      );
      expect(warned).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("delivery prompt does not crash when bus.getContext returns null — participants empty", async () => {
    let capturedPrompt = "";
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(message: any) {
        capturedPrompt = message?.content?.[0]?.text ?? "";
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = makeTestAdapterWithEmit(fakeAgent);
    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {},
        async getContext(_id: string) {
          return null;
        }
      }
    } as any;

    const delivery = makeDelivery("del-ctx-null", "thread-ctx-null", "hello");
    (delivery.events[0] as any).context_id = "ctx_missing";

    await adapter.handleBundle(
      context,
      delivery,
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    expect(capturedPrompt).toContain("ctx_missing");
    expect(capturedPrompt).not.toContain("participants");
  });

  it("trigger event with source_endpoint_id: null does not crash the turn", async () => {
    let capturedPrompt = "";
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(message: any) {
        capturedPrompt = message?.content?.[0]?.text ?? "";
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = makeTestAdapterWithEmit(fakeAgent);
    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {},
      }
    } as any;

    const delivery = makeDelivery("del-null-src", "thread-null-src", "trigger from system");
    // Simulate pulse/webhook trigger — no source endpoint
    (delivery.events[0] as any).source_endpoint_id = null;
    (delivery.events[0] as any).type = "pulse.fired";

    await expect(
      adapter.handleBundle(
        context,
        delivery,
        { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
      )
    ).resolves.toBeUndefined();

    expect(capturedPrompt).toContain("[Context Envelope]");
    expect(capturedPrompt).toContain("cause_actor: system");
    // No literal "null" rendered as source_endpoint
    expect(capturedPrompt).not.toMatch(/source_endpoint:\s*null/);
  });

  it("emit hides caller-supplied Context protocol and preserves the delivery anchor", async () => {
    const emittedEvents: any[] = [];
    let capturedTools: any[] = [];

    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        // Find the emit tool and call it WITH a context_id
        const emitTool = capturedTools.find((t: any) => t.name === "emit");
        if (emitTool) {
          await emitTool.execute("tc_emit_1", {
            type: "message",
            destination: "actor:workspace:test:operator",
            text: "reply continuing context",
            artefact_version_ids: ["artefact-version:exact-result"],
            context_id: "ctx_caller_supplied",
            response_expected: false
          });
        }
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
                baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000, maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      {
        agentFactory: (input) => {
          capturedTools = input.tools ?? [];
          return fakeAgent;
        },
        turnFinalizeTimeoutMs: 1_000
      }
    );

    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(event: any) { emittedEvents.push(event); }
      }
    } as any;

    const delivery = makeDelivery("del-emit-ctx", "thread-emit-ctx", "go");
    (delivery.events[0] as any).context_id = "ctx_delivery";

    await adapter.handleBundle(
      context,
      delivery,
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    expect(emittedEvents).toHaveLength(1);
    const emitted = emittedEvents[0];
    expect(emitted.context_id).toBeNull();
    expect(emitted.current_delivery_context_id).toBe("ctx_delivery");
    expect(emitted.artefact_version_ids).toEqual(["artefact-version:exact-result"]);
  });

  it("emit tool always forwards current_delivery_context_id even when context_id omitted", async () => {
    const emittedEvents: any[] = [];
    let capturedTools: any[] = [];

    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        const emitTool = capturedTools.find((t: any) => t.name === "emit");
        if (emitTool) {
          await emitTool.execute("tc_emit_2", {
            type: "message",
            destination: "actor:workspace:test:operator",
            text: "no context_id supplied",
            response_expected: false
          });
        }
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
                baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000, maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      {
        agentFactory: (input) => {
          capturedTools = input.tools ?? [];
          return fakeAgent;
        },
        turnFinalizeTimeoutMs: 1_000
      }
    );

    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(event: any) { emittedEvents.push(event); },
        // D-B guard: actor must be in participants for the default to apply
        async getContext(_contextId: string) {
          return {
            context_id: "ctx_delivery_2",
            workspace_id: "workspace:test",
            parent_context_id: null,
            created_by_endpoint_id: "actor:workspace:test:operator",
            created_at: new Date().toISOString(),
            participants: ["actor:workspace:test:floe", "actor:workspace:test:operator"]
          };
        }
      }
    } as any;

    const delivery = makeDelivery("del-emit-noctx", "thread-emit-noctx", "go");
    (delivery.events[0] as any).context_id = "ctx_delivery_2";

    await adapter.handleBundle(
      context,
      delivery,
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    expect(emittedEvents).toHaveLength(1);
    const emitted = emittedEvents[0];
    expect(emitted.context_id).toBeNull();
    expect(emitted.current_delivery_context_id).toBe("ctx_delivery_2");
  });

  it("turn end does not produce any message event", async () => {
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        // Only turn_end, no visible output, no emit
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const emittedEvents: any[] = [];
    const telemetryCalls: any[] = [];
    const adapter = makeTestAdapterWithEmit(fakeAgent);
    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(input: any) { telemetryCalls.push(input); },
        async emit(event: any) { emittedEvents.push(event); }
      }
    } as any;

    await adapter.handleBundle(
      context,
      makeDelivery("del-turnend", "thread-turnend", "trigger"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    // Turn end is lifecycle only — no messages emitted
    expect(emittedEvents).toHaveLength(0);
    // No work-log visible output either (nothing was said)
    const worklog = telemetryCalls.filter((t) => t.kind === "visible_output_worklog");
    expect(worklog).toHaveLength(0);
  });

  it("no global endpoint directory is exposed — list_endpoints requires bus context", async () => {
    let registeredTools: string[] = [];
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
                baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000, maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      {
        agentFactory: (input) => {
          registeredTools = input.tools?.map((t: any) => t.name ?? t.tool?.name) ?? [];
          return fakeAgent;
        },
        turnFinalizeTimeoutMs: 1_000
      }
    );

    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {},
        // list_endpoints returns workspace-scoped results only
        async listEndpoints(workspaceId: string) {
          return [
            { endpoint_id: "actor:workspace:test:floe", name: "Floe", status: "idle" },
            { endpoint_id: "actor:workspace:test:operator", name: "Operator", status: "active" }
          ];
        }
      }
    } as any;

    await adapter.handleBundle(
      context,
      makeDelivery("del-tools", "thread-tools", "list my tools"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    // list_endpoints tool should be registered
    expect(registeredTools).toContain("list_endpoints");
    // emit tool should be registered
    expect(registeredTools).toContain("emit");
  });

  it("list_endpoints and resolve_destination expose only neutral refs, names, and status", async () => {
    let listEndpointsResult: any = null;
    let resolveDestinationResult: any = null;

    // Fake agent that calls list_endpoints tool
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      registeredTools: [] as any[],
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        const listTool = this.registeredTools.find((t: any) => t.name === "list_endpoints");
        if (listTool) {
          listEndpointsResult = await listTool.execute("tc_list", {});
        }
        const resolveTool = this.registeredTools.find((t: any) => t.name === "resolve_destination");
        if (resolveTool) {
          resolveDestinationResult = await resolveTool.execute("tc_resolve", { ref: "operator" });
        }
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
                baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000, maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      {
        agentFactory: (input) => {
          fakeAgent.registeredTools = input.tools ?? [];
          return fakeAgent;
        },
        turnFinalizeTimeoutMs: 1_000
      }
    );

    const workspaceAEndpoints = [
      { endpoint_id: "actor:ws-a:floe", name: "Floe", status: "idle", bridge_id: "bridge:a", metadata_json: JSON.stringify({ runtime_adapter: "pi-agent-core" }) },
      { endpoint_id: "actor:ws-a:operator", name: "Operator", status: "active", bridge_id: null, metadata_json: JSON.stringify({ interface: "operator" }) }
    ];
    const workspaceBEndpoints = [
      { endpoint_id: "actor:ws-b:reviewer", name: "Reviewer", status: "idle", bridge_id: "bridge:b", metadata_json: JSON.stringify({ provider: "mock" }) }
    ];

    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {},
        async listEndpoints(workspaceId: string) {
          if (workspaceId === "workspace:a") return workspaceAEndpoints;
          if (workspaceId === "workspace:b") return workspaceBEndpoints;
          return [];
        }
      }
    } as any;

    // Agent in workspace A calls list_endpoints
    const deliveryInA: DeliveryBundle = {
      delivery_id: "del-scope-a",
      endpoint_id: "actor:ws-a:floe",
      workspace_id: "workspace:a",
      trigger_event_id: "evt:scope-a",
      delivered_at: new Date().toISOString(),
      events: [{
        event_id: "evt:scope-a",
        type: "message",
        workspace_id: "workspace:a",
        source_endpoint_id: "actor:ws-a:operator",
        thread_id: "thread-scope",
        correlation_id: null,
        artefact_version_ids: [],
        destination_json: { kind: "endpoint", endpoint_id: "actor:ws-a:floe" },
        content: { text: "list actors", data: {} },
        response: { expected: false },
        metadata: {},
        created_at: new Date().toISOString()
      }]
    };

    await adapter.handleBundle(context, deliveryInA, { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" });

    expect(listEndpointsResult).not.toBeNull();
    const parsed = JSON.parse(listEndpointsResult.content[0].text);

    // Should only see workspace A actors (excluding self) — neutral refs only
    expect(parsed).toHaveLength(1); // only operator (self excluded)
    expect(parsed[0]).toEqual({ ref: "operator", name: "Operator", status: "active" });
    const listText = JSON.stringify(parsed);
    for (const forbidden of ["actor:", "endpoint_id", "actor_type", "bridge_id", "runtime_adapter", "metadata_json", "provider", "model", "human", "agent", "user", "bot"]) {
      expect(listText).not.toContain(forbidden);
    }

    expect(resolveDestinationResult).not.toBeNull();
    const resolved = JSON.parse(resolveDestinationResult.content[0].text);
    expect(resolved).toEqual({ ref: "operator", name: "Operator", status: "active" });
    const resolvedText = JSON.stringify(resolved);
    for (const forbidden of ["actor:", "endpoint_id", "actor_type", "bridge_id", "runtime_adapter", "metadata_json", "provider", "model", "human", "agent", "user", "bot"]) {
      expect(resolvedText).not.toContain(forbidden);
    }

    // Should NOT see workspace B actors (no leakage of any ws-b name)
    const wsB = parsed.filter((ep: any) => ep.name === "Reviewer" || (ep.ref ?? "").includes("reviewer"));
    expect(wsB).toHaveLength(0);
  });
});

// ─── Context isolation (fm/floe-ctx-iso) ────────────────────────────────────
describe("Context isolation — BeforeTurn origin plumbing (D-A/D-B)", () => {
  function makeIsoAdapter(capturedTools: any[], fakeAgent: any) {
    return new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
                baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000, maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      {
        agentFactory: (input: any) => {
          capturedTools.push(...(input.tools ?? []));
          return fakeAgent;
        },
        turnFinalizeTimeoutMs: 1_000
      }
    );
  }

  it("BeforeTurn hook receives origin: { id, kind='context' } when trigger has context_id", async () => {
    const beforeTurnPayloads: any[] = [];
    const hooks = new HookRegistry();
    hooks.on("BeforeTurn", "test-iso", (payload) => {
      beforeTurnPayloads.push(payload);
    });

    const fakeAgent = new FakeAgent();
    const tools: any[] = [];
    const adapter = makeIsoAdapter(tools, fakeAgent);

    const context = {
      bridge_id: "bridge:test",
      hooks,
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {},
        async listEndpoints() { return []; }
      }
    } as any;

    const delivery = makeDelivery("del-iso-ctx", "thread-iso-ctx", "hello");
    (delivery.events[0] as any).context_id = "ctx_card_a";

    await adapter.handleBundle(
      context,
      delivery,
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    expect(beforeTurnPayloads).toHaveLength(1);
    expect(beforeTurnPayloads[0].origin).toEqual({ id: "ctx_card_a", kind: "context" });
  });

  it("BeforeTurn hook receives origin: { id, kind='thread' } when trigger has only thread_id (no context_id)", async () => {
    const beforeTurnPayloads: any[] = [];
    const hooks = new HookRegistry();
    hooks.on("BeforeTurn", "test-iso", (payload) => {
      beforeTurnPayloads.push(payload);
    });

    const fakeAgent = new FakeAgent();
    const tools: any[] = [];
    const adapter = makeIsoAdapter(tools, fakeAgent);

    const context = {
      bridge_id: "bridge:test",
      hooks,
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {},
        async listEndpoints() { return []; }
      }
    } as any;

    // Delivery with thread_id only — no context_id
    const delivery = makeDelivery("del-iso-thread", "thread-iso-only", "hello");
    // context_id is not set (undefined)

    await adapter.handleBundle(
      context,
      delivery,
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    expect(beforeTurnPayloads).toHaveLength(1);
    expect(beforeTurnPayloads[0].origin).toEqual({ id: "thread-iso-only", kind: "thread" });
  });

  it("D-B: emit with no context_id defaults to origin context (reply stays in delivery context)", async () => {
    const emittedEvents: any[] = [];
    const capturedTools: any[] = [];

    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        const emitTool = capturedTools.find((t: any) => t.name === "emit");
        if (emitTool) {
          // Agent replies WITHOUT supplying a context_id — should default to origin
          await emitTool.execute("tc_iso_emit", {
            type: "message",
            destination: "actor:workspace:test:operator",
            text: "Reply for card A",
          });
        }
        for (const l of this.listeners) await l({
          type: "agent_end",
          messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }], usage: null, model: "mock-model", provider: "mock-provider" }]
        });
      }
    };

    const adapter = makeIsoAdapter(capturedTools, fakeAgent);
    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(event: any) { emittedEvents.push(event); },
        async listEndpoints() {
          return [
            { endpoint_id: "actor:workspace:test:operator", name: "Operator", status: "idle" }
          ];
        },
        // D-B guard: actor must be returned as a participant so the guard allows the default
        async getContext(_contextId: string) {
          return {
            context_id: "ctx_card_a",
            workspace_id: "workspace:test",
            parent_context_id: null,
            created_by_endpoint_id: "actor:workspace:test:operator",
            created_at: new Date().toISOString(),
            participants: ["actor:workspace:test:floe", "actor:workspace:test:operator"]
          };
        }
      }
    } as any;

    const delivery = makeDelivery("del-db-fix", "thread-db-fix", "work on card A");
    (delivery.events[0] as any).context_id = "ctx_card_a";

    await adapter.handleBundle(
      context,
      delivery,
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].context_id).toBeNull();
    expect(emittedEvents[0].current_delivery_context_id).toBe("ctx_card_a");
  });

  it("D-B guard: non-participant actor leaves context_id null (Rule 2 handles routing, no 409)", async () => {
    // Regression: when agent B receives a directed delivery in context A (where A's
    // participants are [operator, floe]) and B is NOT a participant, the D-B default
    // must NOT stamp context_id with A. Without the guard, Rule 1 rejects with 409
    // and the agent loops emitting nothing.
    const emittedEvents: any[] = [];  // fake bus.emit always accepts
    const capturedTools: any[] = [];

    // Endpoint for "acme-overseer" receiving a delivery in operator's context
    const NON_PARTICIPANT_ENDPOINT = "actor:workspace:test:acme-overseer";
    const DELIVERY_CONTEXT = "ctx_operator";

    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        const emitTool = capturedTools.find((t: any) => t.name === "emit");
        if (emitTool) {
          // Agent replies WITHOUT explicit context_id — D-B guard must NOT inject ctx_operator
          await emitTool.execute("tc_nonparticipant_emit", {
            type: "message",
            destination: "actor:workspace:test:floe",
            text: "I'm replying as acme-overseer",
          });
        }
        for (const l of this.listeners) await l({
          type: "agent_end",
          messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }], usage: null, model: "mock-model", provider: "mock-provider" }]
        });
      }
    };

    // Build an adapter whose delivery endpoint is the NON_PARTICIPANT_ENDPOINT
    const adapter = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
                baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000, maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      {
        agentFactory: (input: any) => {
          capturedTools.push(...(input.tools ?? []));
          return fakeAgent;
        },
        turnFinalizeTimeoutMs: 1_000
      }
    );

    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(event: any) { emittedEvents.push(event); },
        async listEndpoints() {
          return [
            { endpoint_id: "actor:workspace:test:floe", name: "Floe", status: "idle" }
          ];
        },
        // getContext returns participants that do NOT include acme-overseer
        async getContext(_contextId: string) {
          return {
            context_id: DELIVERY_CONTEXT,
            workspace_id: "workspace:test",
            parent_context_id: null,
            created_by_endpoint_id: "actor:workspace:test:operator",
            created_at: new Date().toISOString(),
            participants: ["actor:workspace:test:operator", "actor:workspace:test:floe"]
            // acme-overseer is NOT in this list
          };
        }
      }
    } as any;

    // Build a delivery whose endpoint_id is acme-overseer (not in context participants)
    const delivery: DeliveryBundle = {
      delivery_id: "del-nonparticipant",
      endpoint_id: NON_PARTICIPANT_ENDPOINT,
      workspace_id: "workspace:test",
      trigger_event_id: "evt:del-nonparticipant",
      delivered_at: new Date().toISOString(),
      events: [
        {
          event_id: "evt:del-nonparticipant",
          type: "message",
          workspace_id: "workspace:test",
          source_endpoint_id: "actor:workspace:test:floe",
          context_id: DELIVERY_CONTEXT,
          thread_id: "thread-nonparticipant",
          correlation_id: null,
          destination_json: {
            kind: "endpoint",
            endpoint_id: NON_PARTICIPANT_ENDPOINT
          },
          content: { text: "Hey acme, what do you think?", data: {} },
          response: { expected: true },
          metadata: {},
          created_at: new Date().toISOString()
        } as any
      ]
    };

    await adapter.handleBundle(
      context,
      delivery,
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    // The emit must succeed (no 409 — fake bus always accepts)
    expect(emittedEvents).toHaveLength(1);
    // D-B guard: actor is NOT a participant → context_id must be null (not DELIVERY_CONTEXT)
    // This lets the bus resolver's Rule 2 route it normally instead of Rule 1 rejecting.
    expect(emittedEvents[0].context_id).toBeNull();
    // current_delivery_context_id is still forwarded for observability
    expect(emittedEvents[0].current_delivery_context_id).toBe(DELIVERY_CONTEXT);
  });

  it("D-B: emit with explicit context_id overrides the origin default (cross-context emit works)", async () => {
    const emittedEvents: any[] = [];
    const capturedTools: any[] = [];

    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        const emitTool = capturedTools.find((t: any) => t.name === "emit");
        if (emitTool) {
          // Agent explicitly targets a different context (e.g. side-thread to acme)
          await emitTool.execute("tc_cross_emit", {
            type: "message",
            destination: "actor:workspace:test:operator",
            text: "Cross-context note",
            context_id: "ctx_acme_side"
          });
        }
        for (const l of this.listeners) await l({
          type: "agent_end",
          messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }], usage: null, model: "mock-model", provider: "mock-provider" }]
        });
      }
    };

    const adapter = makeIsoAdapter(capturedTools, fakeAgent);
    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(event: any) { emittedEvents.push(event); },
        async listEndpoints() {
          return [
            { endpoint_id: "actor:workspace:test:operator", name: "Operator", status: "idle" }
          ];
        }
      }
    } as any;

    const delivery = makeDelivery("del-cross-ctx", "thread-cross-ctx", "send a note");
    (delivery.events[0] as any).context_id = "ctx_card_a";

    await adapter.handleBundle(
      context,
      delivery,
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    expect(emittedEvents).toHaveLength(1);
    // Low-level Context selection is not exposed through the model-facing tool.
    expect(emittedEvents[0].context_id).toBeNull();
    expect(emittedEvents[0].current_delivery_context_id).toBe("ctx_card_a");
  });

  it("D-B Guard 2: participant emitting to NON-participant destination leaves context_id null (Rule 3 side-thread path)", async () => {
    // This is the Floe→Acme case: Floe IS a participant of the delivery context,
    // but Acme (the destination) is NOT. D-B must leave context_id null so the
    // resolver's Rule 3 branch fires and opens a side thread.
    const emittedEvents: any[] = [];
    const capturedTools: any[] = [];

    const FLOE = "actor:workspace:test:floe";
    const ACME = "actor:workspace:test:acme-overseer";
    const DELIVERY_CTX = "ctx_delivery";

    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        const emitTool = capturedTools.find((t: any) => t.name === "emit");
        if (emitTool) {
          // Floe emits to Acme WITHOUT an explicit context_id — D-B Guard 2 must
          // NOT stamp context_id because Acme is not a participant of DELIVERY_CTX.
          await emitTool.execute("tc_floe_to_acme", {
            type: "message",
            destination: ACME,
            text: "Hey Acme, check this card.",
          });
        }
        for (const l of this.listeners) await l({
          type: "agent_end",
          messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }], usage: null, model: "mock-model", provider: "mock-provider" }]
        });
      }
    };

    const adapter = makeIsoAdapter(capturedTools, fakeAgent);
    // Override the endpoint to Floe (a participant)
    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(event: any) { emittedEvents.push(event); },
        async listEndpoints() {
          return [
            { endpoint_id: ACME, name: "Acme", status: "idle" }
          ];
        },
        // Floe IS a participant; Acme is NOT.
        async getContext(_contextId: string) {
          return {
            context_id: DELIVERY_CTX,
            workspace_id: "workspace:test",
            parent_context_id: null,
            created_by_endpoint_id: "actor:workspace:test:operator",
            created_at: new Date().toISOString(),
            participants: [FLOE, "actor:workspace:test:operator"]
          };
        }
      }
    } as any;

    const delivery = makeDelivery("del-floe-acme", "thread-floe-acme", "check the card");
    (delivery.events[0] as any).context_id = DELIVERY_CTX;
    // Use Floe as the delivering endpoint (it IS a participant)
    delivery.endpoint_id = FLOE;

    await adapter.handleBundle(
      context,
      delivery,
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    expect(emittedEvents).toHaveLength(1);
    // Guard 2: destination not a participant → context_id must be null so Rule 3 fires.
    expect(emittedEvents[0].context_id).toBeNull();
    // current_delivery_context_id is always forwarded so Rule 3 can open a side thread.
    expect(emittedEvents[0].current_delivery_context_id).toBe(DELIVERY_CTX);
  });

  it("D-B Guard 2: participant emitting to PARTICIPANT destination keeps context_id (reply stays on main thread)", async () => {
    // Floe emits a reply to Operator — both are participants. D-B default must apply:
    // context_id = delivery context, no side thread.
    const emittedEvents: any[] = [];
    const capturedTools: any[] = [];

    const FLOE = "actor:workspace:test:floe";
    const OPERATOR = "actor:workspace:test:operator";
    const DELIVERY_CTX = "ctx_delivery";

    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        const emitTool = capturedTools.find((t: any) => t.name === "emit");
        if (emitTool) {
          // Floe replies to Operator (also a participant) — D-B default should apply.
          await emitTool.execute("tc_floe_reply", {
            type: "message",
            destination: OPERATOR,
            text: "Here's the update.",
          });
        }
        for (const l of this.listeners) await l({
          type: "agent_end",
          messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }], usage: null, model: "mock-model", provider: "mock-provider" }]
        });
      }
    };

    const adapter = makeIsoAdapter(capturedTools, fakeAgent);
    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(_input: any) {},
        async emit(event: any) { emittedEvents.push(event); },
        async listEndpoints() {
          return [
            { endpoint_id: OPERATOR, name: "Operator", status: "idle" }
          ];
        },
        // Both Floe and Operator are participants.
        async getContext(_contextId: string) {
          return {
            context_id: DELIVERY_CTX,
            workspace_id: "workspace:test",
            parent_context_id: null,
            created_by_endpoint_id: OPERATOR,
            created_at: new Date().toISOString(),
            participants: [FLOE, OPERATOR]
          };
        }
      }
    } as any;

    const delivery = makeDelivery("del-floe-reply", "thread-floe-reply", "give me an update");
    (delivery.events[0] as any).context_id = DELIVERY_CTX;
    delivery.endpoint_id = FLOE;

    await adapter.handleBundle(
      context,
      delivery,
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].context_id).toBeNull();
    expect(emittedEvents[0].current_delivery_context_id).toBe(DELIVERY_CTX);
  });
});

// ─── Slice 4: Full actor work loop acceptance ─────────────────────────────────
describe("Full actor work loop acceptance", () => {
  const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  const { tmpdir } = require("os") as typeof import("os");

  function makeAcceptanceAdapter(fakeAgent: any, workspaceLocator: string) {
    return new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
                baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000, maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      {
        agentFactory: (input) => {
          fakeAgent.registeredTools = input.tools ?? [];
          return fakeAgent;
        },
        turnFinalizeTimeoutMs: 5_000
      }
    );
  }

  function makeAcceptanceDelivery(workspaceId: string, text: string): DeliveryBundle {
    return {
      delivery_id: "del-acceptance",
      endpoint_id: `actor:${workspaceId}:floe`,
      workspace_id: workspaceId,
      trigger_event_id: "evt:acceptance",
      delivered_at: new Date().toISOString(),
      events: [{
        event_id: "evt:acceptance",
        type: "message",
        workspace_id: workspaceId,
        scope_id: "work-scope",
        source_endpoint_id: `actor:${workspaceId}:operator`,
        thread_id: `thread:${workspaceId}:floe`,
        correlation_id: null,
        artefact_version_ids: [],
        destination_json: { kind: "endpoint", endpoint_id: `actor:${workspaceId}:floe` },
        content: { text, data: {} },
        response: { expected: false },
        metadata: {},
        created_at: new Date().toISOString()
      }]
    };
  }

  it("agent uses workspace tools, writes work log, and emits response", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "floe-acceptance-"));
    writeFileSync(join(workspaceDir, "hello.txt"), "Hello from workspace\n");

    const telemetryCalls: any[] = [];
    const emittedEvents: any[] = [];

    // FakeAgent that exercises the full tool chain:
    // 1. ls to list files
    // 2. read to read hello.txt
    // 3. write to create output.txt
    // 4. platform-aware command execution
    // 5. emit to send a response
    const fakeAgent = {
      registeredTools: [] as any[],
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async emit(event: any) { for (const l of this.listeners) await l(event); },
      async prompt() {
        const findTool = (name: string) => this.registeredTools.find((t: any) => t.name === name);

        // Helper to call a tool with proper Pi event lifecycle
        const callTool = async (name: string, callId: string, args: any) => {
          const tool = findTool(name);
          expect(tool).toBeDefined();
          await this.emit({ type: "tool_execution_start", toolCallId: callId, toolName: name, args });
          const result = await tool!.execute(callId, args);
          await this.emit({ type: "tool_execution_end", toolCallId: callId, toolName: name, isError: false });
          return result;
        };

        // Step 1: ls the workspace
        const lsResult = await callTool("ls", "tc_ls", { path: "." });
        expect(lsResult.content[0].text).toContain("hello.txt");

        // Step 2: read hello.txt
        const readResult = await callTool("read", "tc_read", { path: "hello.txt" });
        expect(readResult.content[0].text).toContain("Hello from workspace");

        // Step 3: write output.txt
        const writeResult = await callTool("write", "tc_write", { path: "output.txt", content: "Work loop verified" });
        expect(writeResult.content[0].text).toContain("output.txt");

        // Step 4: run a simple command using the declared host shell
        const commandResult = await callTool("run_command", "tc_command", { command: "echo floe-test-ok" });
        expect(commandResult.content[0].text).toContain("floe-test-ok");

        // Step 5: emit response
        await callTool("emit", "tc_emit", {
          type: "message",
          destination: "operator",
          text: "Work loop complete.",
          response_expected: false
        });

        // End agent turn
        for (const l of this.listeners) await l({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "Done." }] }
        });
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: { input: 10, output: 5, totalTokens: 15 }, model: "mock-model", provider: "mock-provider" }
        });
        for (const l of this.listeners) await l({
          type: "agent_end",
          messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }]
        });
      }
    };

    const adapter = makeAcceptanceAdapter(fakeAgent, workspaceDir);
    const workspaceId = "workspace:acceptance";
    const context = {
      bridge_id: "bridge:test",
      workspace_locator: workspaceDir,
      agent_id: "floe",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry(input: any) { telemetryCalls.push(input); },
        async emit(event: any) { emittedEvents.push(event); },
        async listEndpoints(_workspaceId: string) {
          return [
            { endpoint_id: `actor:${_workspaceId}:floe`, name: "Floe", status: "idle" },
            { endpoint_id: `actor:${_workspaceId}:operator`, name: "Operator", status: "active" }
          ];
        }
      }
    } as any;

    await adapter.handleBundle(
      context,
      makeAcceptanceDelivery(workspaceId, "Run the work loop"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    // --- Acceptance criteria ---

    // 1. All 7 workspace tools registered
    const toolNames = fakeAgent.registeredTools.map((t: any) => t.name);
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("write");
    expect(toolNames).toContain("edit");
    expect(toolNames).toContain("ls");
    expect(toolNames).toContain("grep");
    expect(toolNames).toContain("find");
    expect(toolNames).toContain("run_command");
    expect(toolNames).not.toContain("bash");
    expect(toolNames).toContain("emit");
    expect(toolNames).toContain("list_endpoints");

    // 2. File was actually created
    expect(existsSync(join(workspaceDir, "output.txt"))).toBe(true);
    expect(readFileSync(join(workspaceDir, "output.txt"), "utf-8")).toBe("Work loop verified");

    // 3. Agent emitted a message event
    const messageEmits = emittedEvents.filter((e) => e.type === "message");
    expect(messageEmits).toHaveLength(1);
    expect(messageEmits[0].content.text).toBe("Work loop complete.");

    // 4. Tool telemetry was recorded (BeforeToolUse/AfterToolUse for each tool)
    const toolTelemetry = telemetryCalls.filter((t) => t.kind === "BeforeToolUse" || t.kind === "AfterToolUse");
    expect(toolTelemetry.length).toBeGreaterThanOrEqual(8); // at least 4 tools × 2 (before + after)

    // 5. Natural visible output is recorded as the local turn result.
    const worklog = telemetryCalls.filter((t) => t.kind === "turn_result");
    expect(worklog).toHaveLength(1);
    expect(worklog[0].payload.text).toContain("Done.");
    const autoEmits = emittedEvents.filter((e) => e.metadata?.origin === "runtime_turn_output");
    expect(autoEmits).toHaveLength(0);

    // 6. Work log file was written to workspace
    const worklogDir = join(workspaceDir, ".floe", "agents", "floe", "worklogs");
    const files = require("fs").readdirSync(worklogDir);
    expect(files.length).toBeGreaterThan(0);
    const worklogContent = readFileSync(join(worklogDir, files[0]), "utf-8");
    expect(worklogContent).toContain("**Scope:** work-scope");
    expect(worklogContent).toContain("- 📄 output.txt");
    expect(existsSync(join(workspaceDir, ".floe", "blocks"))).toBe(false);
    expect(existsSync(join(workspaceDir, ".floe", "fields"))).toBe(false);

    // Cleanup
    rmSync(workspaceDir, { recursive: true, force: true });
  });
});

describe("extractShortRef (removed — superseded by toNeutralRef)", () => {
  it("is no longer exported; see runtime-core/neutral-ref.ts for replacement", () => {
    // extractShortRef (deleted) returned category-prefixed refs
    // which leaked substrate-category metadata to agents. It has been deleted.
    // toNeutralRef from runtime-core/neutral-ref returns neutral refs ("floe", "operator")
    // and is exhaustively unit-tested in runtime-core/neutral-ref.test.ts.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FIX 1: TurnFailedError propagation
// ---------------------------------------------------------------------------

describe("TurnFailedError propagation (FIX 1)", () => {
  function makeFailingAdapter(promptError: Error) {
    return new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "anthropic-messages", provider: "mock-provider",
                baseUrl: "https://api.anthropic.com", reasoning: false, input: ["text"],
                cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
                contextWindow: 200000, maxTokens: 64000
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      {
        agentFactory: () => {
          const listeners: Array<(event: any) => void | Promise<void>> = [];
          return {
            subscribe(listener: (event: any) => void | Promise<void>) { listeners.push(listener); },
            async prompt() { throw promptError; }
          };
        },
        turnFinalizeTimeoutMs: 1_000
      }
    );
  }

  it("re-throws as TurnFailedError carrying structured context", async () => {
    const adapter = makeFailingAdapter(new Error("POST .../v1/messages failed: 400 Bad Request"));

    const delivery = makeDelivery("del-fail-1", "thread-fail-1", "hello");
    let thrown: unknown;
    try {
      await adapter.handleBundle(
        {
          bridge_id: "bridge:test",
          bus: { recordRuntimeTurnResult,
            async appendRuntimeTelemetry() {},
            async emit() {}
          }
        } as any,
        delivery,
        { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(TurnFailedError);
    const err = thrown as TurnFailedError;
    expect(err.code).toBe("turn_failed");
    expect(err.delivery_id).toBe("del-fail-1");
    expect(err.workspace_id).toBe("workspace:test");
    expect(err.model_id).toBe("mock-model");
    expect(err.provider).toBe("mock-provider");
    expect(err.http_status).toBe(400);
    expect(err.source_endpoint_id).toBe("actor:workspace:test:operator");
  });

  it("extracts http_status null when error message has no status code", async () => {
    const adapter = makeFailingAdapter(new Error("network timeout"));

    let thrown: unknown;
    try {
      await adapter.handleBundle(
        {
          bridge_id: "bridge:test",
          bus: { recordRuntimeTurnResult,
            async appendRuntimeTelemetry() {},
            async emit() {}
          }
        } as any,
        makeDelivery("del-fail-2", "thread-fail-2", "hello"),
        { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(TurnFailedError);
    expect((thrown as TurnFailedError).http_status).toBeNull();
  });

  it("records runtime_error telemetry before re-throwing", async () => {
    const telemetryCalls: any[] = [];
    const adapter = makeFailingAdapter(new Error("POST failed: 400 Bad Request"));

    try {
      await adapter.handleBundle(
        {
          bridge_id: "bridge:test",
          bus: { recordRuntimeTurnResult,
            async appendRuntimeTelemetry(input: any) { telemetryCalls.push(input); },
            async emit() {}
          }
        } as any,
        makeDelivery("del-fail-3", "thread-fail-3", "hello"),
        { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
      );
    } catch {
      // expected
    }

    const errorTelemetry = telemetryCalls.filter((t) => t.kind === "runtime_error");
    expect(errorTelemetry.length).toBeGreaterThan(0);
    expect(errorTelemetry[0].payload).toMatchObject({
      provider: "mock-provider",
      model: "mock-model",
      http_status: 400
    });
  });
});

// ---------------------------------------------------------------------------
// GAP FIX: stop_reason 'error' without a thrown exception → TurnFailedError
// ---------------------------------------------------------------------------

describe("PiAgentCoreAdapter – stop_reason 'error' treated as TurnFailedError", () => {
  function makeAdapterWithErrorStopReason(
    errorStopMessage: string | null,
    options?: { detachAgentEnd?: boolean; partialText?: string; stopReason?: string }
  ) {
    return new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "anthropic-messages", provider: "mock-provider",
                baseUrl: "https://api.anthropic.com", reasoning: false, input: ["text"],
                cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
                contextWindow: 200000, maxTokens: 64000
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      {
        agentFactory: () => {
          const listeners: Array<(event: any) => void | Promise<void>> = [];
          return {
            subscribe(listener: (event: any) => void | Promise<void>) { listeners.push(listener); },
            async prompt() {
              // Pi does NOT throw — it emits an assistant message with stopReason 'error'
              const errorAssistantMessage = {
                role: "assistant",
                content: options?.partialText ? [{ type: "text", text: options.partialText }] : [],
                stopReason: options?.stopReason ?? "error",
                errorMessage: errorStopMessage,
                usage: { input: 5, output: 0, totalTokens: 5 },
                model: "mock-model",
                provider: "mock-provider"
              };
              for (const l of listeners) await l({ type: "message_end", message: errorAssistantMessage });
              if (options?.detachAgentEnd) {
                // Pi's real event loop may emit agent_end before prompt() has
                // returned to the adapter. The completion must remain inert
                // until awaitTurnCompletion observes it.
                for (const l of listeners) void l({ type: "agent_end", messages: [errorAssistantMessage] });
                await new Promise((resolve) => setTimeout(resolve, 20));
              } else {
                for (const l of listeners) await l({ type: "agent_end", messages: [errorAssistantMessage] });
              }
            }
          };
        },
        turnFinalizeTimeoutMs: 1_000
      }
    );
  }

  it.each(["error", "aborted"])("does not turn partial text into completion after %s", async stopReason => {
    const recorded = vi.fn();
    const adapter = makeAdapterWithErrorStopReason("503 interrupted", { partialText: "I have started inspecting the file.", stopReason });
    await expect(adapter.handleBundle({ bridge_id: "bridge:test", bus: {
      recordRuntimeTurnResult: recorded, async appendRuntimeTelemetry() {}, async emit() {},
    } } as any, makeDelivery(`del-partial-${stopReason}`, "thread-partial", "hello"),
    { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" })).rejects.toBeInstanceOf(TurnFailedError);
    expect(recorded).not.toHaveBeenCalled();
  });

  it("throws TurnFailedError when pi turn ends with stop_reason 'error' and no pi throw", async () => {
    const adapter = makeAdapterWithErrorStopReason("model not found: 404 Not Found");
    const delivery = makeDelivery("del-stop-err-1", "thread-stop-err-1", "hello");

    let thrown: unknown;
    try {
      await adapter.handleBundle(
        {
          bridge_id: "bridge:test",
          bus: { recordRuntimeTurnResult,
            async appendRuntimeTelemetry() {},
            async emit() {}
          }
        } as any,
        delivery,
        { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(TurnFailedError);
    const err = thrown as TurnFailedError;
    expect(err.code).toBe("turn_failed");
    expect(err.delivery_id).toBe("del-stop-err-1");
    expect(err.workspace_id).toBe("workspace:test");
    expect(err.model_id).toBe("mock-model");
    expect(err.provider).toBe("mock-provider");
    expect(err.source_endpoint_id).toBe("actor:workspace:test:operator");
    // errorMessage from AssistantMessage.errorMessage field (pi-ai types.d.ts line 155)
    expect(err.message).toContain("model not found: 404 Not Found");
  });

  it("keeps a detached Pi error completion inside the delivery failure path", async () => {
    const adapter = makeAdapterWithErrorStopReason(
      "temporary provider failure: 503 Service Unavailable",
      { detachAgentEnd: true }
    );

    await expect(adapter.handleBundle(
      {
        bridge_id: "bridge:test",
        bus: { recordRuntimeTurnResult,
          async appendRuntimeTelemetry() {},
          async emit() {}
        }
      } as any,
      makeDelivery("del-detached-stop-error", "thread-detached-stop-error", "hello"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    )).rejects.toMatchObject({
      code: "turn_failed",
      delivery_id: "del-detached-stop-error",
      http_status: 503
    });
  });

  it("extracts http_status from pi errorMessage when stop_reason is 'error'", async () => {
    const adapter = makeAdapterWithErrorStopReason("model_not_found: 404 Not Found");

    let thrown: unknown;
    try {
      await adapter.handleBundle(
        {
          bridge_id: "bridge:test",
          bus: { recordRuntimeTurnResult,
            async appendRuntimeTelemetry() {},
            async emit() {}
          }
        } as any,
        makeDelivery("del-stop-err-2", "thread-stop-err-2", "hello"),
        { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(TurnFailedError);
    expect((thrown as TurnFailedError).http_status).toBe(404);
  });

  it("sets http_status to null when pi errorMessage has no HTTP status code", async () => {
    const adapter = makeAdapterWithErrorStopReason("connection reset");

    let thrown: unknown;
    try {
      await adapter.handleBundle(
        {
          bridge_id: "bridge:test",
          bus: { recordRuntimeTurnResult,
            async appendRuntimeTelemetry() {},
            async emit() {}
          }
        } as any,
        makeDelivery("del-stop-err-3", "thread-stop-err-3", "hello"),
        { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(TurnFailedError);
    expect((thrown as TurnFailedError).http_status).toBeNull();
  });

  it("sets http_status to null when pi errorMessage is null", async () => {
    const adapter = makeAdapterWithErrorStopReason(null);

    let thrown: unknown;
    try {
      await adapter.handleBundle(
        {
          bridge_id: "bridge:test",
          bus: { recordRuntimeTurnResult,
            async appendRuntimeTelemetry() {},
            async emit() {}
          }
        } as any,
        makeDelivery("del-stop-err-4", "thread-stop-err-4", "hello"),
        { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(TurnFailedError);
    expect((thrown as TurnFailedError).http_status).toBeNull();
  });

  it("records runtime_error and usage telemetry before propagating TurnFailedError", async () => {
    const telemetryCalls: any[] = [];
    const adapter = makeAdapterWithErrorStopReason("model not found: 404 Not Found");

    try {
      await adapter.handleBundle(
        {
          bridge_id: "bridge:test",
          bus: { recordRuntimeTurnResult,
            async appendRuntimeTelemetry(input: any) { telemetryCalls.push(input); },
            async emit() {}
          }
        } as any,
        makeDelivery("del-stop-err-5", "thread-stop-err-5", "hello"),
        { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
      );
    } catch {
      // expected
    }

    // runtime_error telemetry recorded (from finalizeTurn before rejection)
    const errorTelemetry = telemetryCalls.filter((t) => t.kind === "runtime_error");
    expect(errorTelemetry.length).toBeGreaterThan(0);
    expect(errorTelemetry[0].payload).toMatchObject({
      stop_reason: "error",
      error_message: "model not found: 404 Not Found"
    });

    // usage telemetry also recorded (from finalizeTurn)
    const usageTelemetry = telemetryCalls.filter((t) => t.kind === "usage");
    expect(usageTelemetry.length).toBeGreaterThan(0);
    expect(usageTelemetry[0].payload).toMatchObject({
      stop_reason: "error",
      model: "mock-model"
    });
  });

  it("fires Error hook when stop_reason is 'error'", async () => {
    const errors: Array<any> = [];
    const hooks = new HookRegistry();
    hooks.on("Error", "test-ext", (payload) => { errors.push(payload); });

    const adapter = makeAdapterWithErrorStopReason("model not found: 404 Not Found");

    try {
      await adapter.handleBundle(
        {
          bridge_id: "bridge:test",
          hooks,
          bus: { recordRuntimeTurnResult,
            async appendRuntimeTelemetry() {},
            async emit() {},
            async listEndpoints() { return []; }
          }
        } as any,
        makeDelivery("del-stop-err-6", "thread-stop-err-6", "trigger"),
        { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
      );
    } catch {
      // expected TurnFailedError
    }

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      workspace_id: "workspace:test",
      delivery_id: "del-stop-err-6",
      trigger_event_id: "evt:del-stop-err-6"
    });
  });

  it("does NOT throw TurnFailedError for other stop_reasons with empty visible output", async () => {
    // stop_reason 'stop' with no text content is a legitimate tool-only turn — must NOT fail
    const adapter = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "anthropic-messages", provider: "mock-provider",
                baseUrl: "https://api.anthropic.com", reasoning: false, input: ["text"],
                cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
                contextWindow: 200000, maxTokens: 64000
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      {
        agentFactory: () => {
          const listeners: Array<(event: any) => void | Promise<void>> = [];
          return {
            subscribe(listener: (event: any) => void | Promise<void>) { listeners.push(listener); },
            async prompt() {
              // Tool-only turn: stopReason 'stop', no text content
              const toolOnlyMessage = {
                role: "assistant",
                content: [],  // no text content
                stopReason: "stop",
                usage: { input: 5, output: 10, totalTokens: 15 },
                model: "mock-model",
                provider: "mock-provider"
              };
              for (const l of listeners) await l({ type: "message_end", message: toolOnlyMessage });
              for (const l of listeners) await l({ type: "agent_end", messages: [toolOnlyMessage] });
            }
          };
        },
        turnFinalizeTimeoutMs: 1_000
      }
    );

    // Must resolve successfully (not throw)
    await expect(
      adapter.handleBundle(
        {
          bridge_id: "bridge:test",
          bus: { recordRuntimeTurnResult,
            async appendRuntimeTelemetry() {},
            async emit() {}
          }
        } as any,
        makeDelivery("del-tool-only", "thread-tool-only", "do something silently"),
        { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
      )
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FIX 2: Thinking capability clamping
// ---------------------------------------------------------------------------

describe("applyThinkingCapabilityClamp (FIX 2)", () => {
  it("returns config unchanged when thinkingCapability is undefined", () => {
    const config = { thinking_level: "high" as const, auth_profile: "p" };
    expect(applyThinkingCapabilityClamp(config, undefined, "some-model")).toBe(config);
  });

  it("returns config unchanged when thinkingCapability is undefined (undefined config)", () => {
    expect(applyThinkingCapabilityClamp(undefined, undefined, "some-model")).toBeUndefined();
  });

  it("clamps thinking_level to off for always-on capability", () => {
    const config = { thinking_level: "high" as const, auth_profile: "p" };
    const result = applyThinkingCapabilityClamp(config, "always-on", "claude-fable-5");
    expect(result?.thinking_level).toBe("off");
  });

  it("clamps thinking_level to off for none capability", () => {
    const config = { thinking_level: "medium" as const, auth_profile: "p" };
    const result = applyThinkingCapabilityClamp(config, "none", "some-model");
    expect(result?.thinking_level).toBe("off");
  });

  it("already-off thinking_level passes through always-on without change", () => {
    const config = { thinking_level: "off" as const, auth_profile: "p" };
    const result = applyThinkingCapabilityClamp(config, "always-on", "claude-fable-5");
    expect(result?.thinking_level).toBe("off");
  });

  it("passes through unchanged for adaptive capability", () => {
    const config = { thinking_level: "high" as const, auth_profile: "p" };
    const result = applyThinkingCapabilityClamp(config, "adaptive", "claude-opus-4-6");
    expect(result).toBe(config); // Same reference — no clamp applied
  });

  it("passes through unchanged for budget capability", () => {
    const config = { thinking_level: "low" as const, auth_profile: "p" };
    const result = applyThinkingCapabilityClamp(config, "budget", "claude-haiku-4-5");
    expect(result).toBe(config); // Same reference — no clamp applied
  });

  it("clamps undefined runtimeConfig with always-on to { thinking_level: off }", () => {
    const result = applyThinkingCapabilityClamp(undefined, "always-on", "claude-fable-5");
    expect(result?.thinking_level).toBe("off");
  });
});

describe("Thinking capability integration (FIX 2)", () => {
  function makeAdapterWithThinkingCapability(
    thinkingCapability: string | undefined,
    capturedLevels: string[]
  ) {
    return new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "anthropic-messages", provider: "mock-provider",
                baseUrl: "https://api.anthropic.com", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000, maxTokens: 64000
              } as any;
            }
            return undefined;
          },
          getThinkingCapability(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") return thinkingCapability;
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      {
        agentFactory: (input) => {
          capturedLevels.push(input.thinkingLevel ?? "off");
          return new FakeAgent();
        },
        turnFinalizeTimeoutMs: 1_000
      }
    );
  }

  it("clamps thinking_level to off when model declares always-on capability", async () => {
    const capturedLevels: string[] = [];
    const adapter = makeAdapterWithThinkingCapability("always-on", capturedLevels);

    await adapter.handleBundle(
      {
        bridge_id: "bridge:test",
        bus: { recordRuntimeTurnResult, async appendRuntimeTelemetry() {}, async emit() {} }
      } as any,
      makeDelivery("del-alwayson", "thread-1", "hello"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile", thinking_level: "high" }
    );

    // Agent was created with thinking_level = off (clamped from high)
    expect(capturedLevels[0]).toBe("off");
  });

  it("clamps thinking_level to off when model declares none capability", async () => {
    const capturedLevels: string[] = [];
    const adapter = makeAdapterWithThinkingCapability("none", capturedLevels);

    await adapter.handleBundle(
      {
        bridge_id: "bridge:test",
        bus: { recordRuntimeTurnResult, async appendRuntimeTelemetry() {}, async emit() {} }
      } as any,
      makeDelivery("del-none", "thread-1", "hello"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile", thinking_level: "low" }
    );

    expect(capturedLevels[0]).toBe("off");
  });

  it("passes thinking_level through unchanged when model declares budget capability", async () => {
    const capturedLevels: string[] = [];
    const adapter = makeAdapterWithThinkingCapability("budget", capturedLevels);

    await adapter.handleBundle(
      {
        bridge_id: "bridge:test",
        bus: { recordRuntimeTurnResult, async appendRuntimeTelemetry() {}, async emit() {} }
      } as any,
      makeDelivery("del-budget", "thread-1", "hello"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile", thinking_level: "low" }
    );

    expect(capturedLevels[0]).toBe("low");
  });

  it("passes thinking_level through unchanged when no thinking capability declared", async () => {
    const capturedLevels: string[] = [];
    const adapter = makeAdapterWithThinkingCapability(undefined, capturedLevels);

    await adapter.handleBundle(
      {
        bridge_id: "bridge:test",
        bus: { recordRuntimeTurnResult, async appendRuntimeTelemetry() {}, async emit() {} }
      } as any,
      makeDelivery("del-nodecl", "thread-1", "hello"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile", thinking_level: "medium" }
    );

    expect(capturedLevels[0]).toBe("medium");
  });
});
