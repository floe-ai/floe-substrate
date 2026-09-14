import { describe, expect, it } from "vitest";
import { PiAgentCoreAdapter } from "./pi-agent-core-adapter.js";
import { SUBSTRATE_GUIDANCE } from "../runtime-core/guidance.js";
import type { DeliveryBundle } from "../bus-client.js";

const recordRuntimeTurnResult = async (input: any) => ({
  result_event: { event_id: `result:${input.delivery_id}` },
  return_event: null,
  request_resolved: false
});

const CATEGORY_PREFIX_RE = /^(user|human|agent|webhook|runtime|system|cli|web|slack|api):/;

function makeAdapter(fakeAgent: any) {
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
              contextWindow: 128000, maxTokens: 4096,
            } as any;
          }
          return undefined;
        },
        async getApiKeyForProvider() { return "test-key"; },
      } as any,
      profiles: {
        version: 1,
        profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }],
      },
    } as any,
    { agentFactory: () => fakeAgent, turnFinalizeTimeoutMs: 1_000 },
  );
}

function makeDelivery(deliveryId: string, threadId: string, text: string): DeliveryBundle {
  return {
    delivery_id: deliveryId,
    endpoint_id: "actor:workspace:test:floe",
    workspace_id: "workspace:test",
    trigger_event_id: `evt:${deliveryId}`,
    delivered_at: new Date().toISOString(),
    events: [{
      event_id: `evt:${deliveryId}`,
      type: "message",
      workspace_id: "workspace:test",
      source_endpoint_id: "actor:workspace:test:operator",
      thread_id: threadId,
      correlation_id: null,
      artefact_version_ids: [],
      destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:floe" },
      content: { text, data: {} },
      response: { expected: false },
      metadata: {},
      created_at: new Date().toISOString(),
    }],
  };
}

describe("Substrate-direction: agents see only neutral actor refs", () => {
  it("list_endpoints output contains no endpoint_id, no actor_type, no category-prefixed ref", async () => {
    let listResult: any = null;
    const fakeAgent: any = {
      registeredTools: [] as any[],
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(l: any) { this.listeners.push(l); },
      async prompt() {
        const tool = this.registeredTools.find((t: any) => t.name === "list_endpoints");
        listResult = await tool!.execute("tc_list", {});
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" },
        });
      },
    };
    const adapter = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find() {
            return { id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
              baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000, maxTokens: 4096 } as any;
          },
          async getApiKeyForProvider() { return "test-key"; },
        } as any,
        profiles: { version: 1, profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }] },
      } as any,
      {
        agentFactory: (input) => { fakeAgent.registeredTools = input.tools ?? []; return fakeAgent; },
        turnFinalizeTimeoutMs: 1_000,
      },
    );
    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry() {},
        async emit() {},
        async listEndpoints() {
          return [
            { endpoint_id: "actor:workspace:test:floe", name: "Floe", status: "idle" },
            { endpoint_id: "actor:workspace:test:operator", name: "Operator", status: "active" },
          ];
        },
      },
    } as any;

    await adapter.handleBundle(
      context,
      makeDelivery("del-list", "thread-list", "list endpoints"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" },
    );

    expect(listResult).not.toBeNull();
    const json = listResult.content[0].text as string;
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);

    for (const ep of parsed) {
      expect(ep).not.toHaveProperty("endpoint_id");
      expect(ep).not.toHaveProperty("actor_type");
      expect(ep).toHaveProperty("ref");
      expect(ep).toHaveProperty("name");
      expect(ep).toHaveProperty("status");
      expect(CATEGORY_PREFIX_RE.test(ep.ref)).toBe(false);
    }
    // Whole serialized blob: no legacy id prefix, no actor_type literal anywhere
    expect(json).not.toContain("endpoint:");
    expect(json).not.toContain("actor_type");
  });

  it("resolve_destination accepts a neutral ref and returns no category-revealing fields", async () => {
    let resolveResult: any = null;
    let resolveTool: any = null;
    const fakeAgent: any = {
      registeredTools: [] as any[],
      listeners: [] as Array<(e: any) => void | Promise<void>>,
      subscribe(l: any) { this.listeners.push(l); },
      async prompt() {
        resolveTool = this.registeredTools.find((t: any) => t.name === "resolve_destination");
        resolveResult = await resolveTool!.execute("tc_res", { ref: "operator" });
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" },
        });
      },
    };
    const adapter = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find() {
            return { id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
              baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000, maxTokens: 4096 } as any;
          },
          async getApiKeyForProvider() { return "test-key"; },
        } as any,
        profiles: { version: 1, profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }] },
      } as any,
      {
        agentFactory: (input) => { fakeAgent.registeredTools = input.tools ?? []; return fakeAgent; },
        turnFinalizeTimeoutMs: 1_000,
      },
    );
    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry() {},
        async emit() {},
        async listEndpoints() {
          return [
            { endpoint_id: "actor:workspace:test:floe", name: "Floe", status: "idle" },
            { endpoint_id: "actor:workspace:test:operator", name: "Operator", status: "active" },
          ];
        },
        async resolveEndpoint(_ws: string, ref: string) {
          if (ref === "operator") return { endpoint_id: "actor:workspace:test:operator", found: true };
          return { endpoint_id: "", found: false };
        },
      },
    } as any;

    await adapter.handleBundle(
      context,
      makeDelivery("del-resolve", "thread-resolve", "resolve operator"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" },
    );

    expect(resolveResult).not.toBeNull();
    const json = resolveResult.content[0].text as string;
    const parsed = JSON.parse(json);
    expect(parsed).not.toHaveProperty("endpoint_id");
    expect(parsed).not.toHaveProperty("actor_type");
    expect(parsed.ref).toBe("operator");
    expect(json).not.toContain("endpoint:");
    expect(json).not.toContain("actor_type");

    // Tool description must NOT contain legacy/category examples.
    expect(resolveTool.description).not.toContain("agent:");
    expect(resolveTool.description).not.toContain("user:");
  });

  it("list_endpoints tool description does not contain category examples", async () => {
    let listTool: any = null;
    const fakeAgent: any = {
      registeredTools: [] as any[],
      listeners: [] as Array<(e: any) => void | Promise<void>>,
      subscribe(l: any) { this.listeners.push(l); },
      async prompt() {
        listTool = this.registeredTools.find((t: any) => t.name === "list_endpoints");
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" },
        });
      },
    };
    const adapter = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: { find() { return { id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider", baseUrl: "https://example.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 } as any; }, async getApiKeyForProvider() { return "test-key"; } } as any,
        profiles: { version: 1, profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }] },
      } as any,
      { agentFactory: (input) => { fakeAgent.registeredTools = input.tools ?? []; return fakeAgent; }, turnFinalizeTimeoutMs: 1_000 },
    );
    const context = { bridge_id: "bridge:test", bus: { recordRuntimeTurnResult, async appendRuntimeTelemetry() {}, async emit() {}, async listEndpoints() { return []; } } } as any;
    await adapter.handleBundle(context, makeDelivery("del-d", "thread-d", "x"), { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" });

    expect(listTool.description).not.toContain("actor_type");
    expect(listTool.description).not.toContain("agent:floe");
    expect(listTool.description).not.toContain("user:operator");
    expect(listTool.description).not.toMatch(/\bhuman\b/i);
  });

  it("emit tool accepts a neutral ref and translates to legacy endpoint_id before forwarding to bus", async () => {
    const emittedEvents: any[] = [];
    let emitTool: any = null;
    let accepted: any;
    const fakeAgent: any = {
      registeredTools: [] as any[],
      listeners: [] as Array<(e: any) => void | Promise<void>>,
      subscribe(l: any) { this.listeners.push(l); },
      async prompt() {
        emitTool = this.registeredTools.find((t: any) => t.name === "emit");
        accepted = await emitTool!.execute("tc_emit_neutral", {
          type: "message",
          destination: "operator",
          text: "Hello via neutral ref",
          references: [{ name: "Local preview approval", resource_ref: { kind: "approval_request", id: "approval:exact", revision: "2" } }],
          attachments: [
            { artefact_version_id: "artefact-version:lantern", name: "Teal Lantern" },
            { artefact_version_id: "artefact-version:scene", name: "Revised Courtyard" },
          ],
          artefact_version_ids: ["artefact-version:lantern"],
          data: { report: { schema: "example.v1" } },
          response_expected: false,
        });
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" },
        });
      },
    };
    const adapter = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: { find() { return { id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider", baseUrl: "https://example.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 } as any; }, async getApiKeyForProvider() { return "test-key"; } } as any,
        profiles: { version: 1, profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }] },
      } as any,
      { agentFactory: (input) => { fakeAgent.registeredTools = input.tools ?? []; return fakeAgent; }, turnFinalizeTimeoutMs: 1_000 },
    );
    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry() {},
        async emit(event: any) {
          emittedEvents.push(event);
          return { event_id: "event:accepted", accepted_at: "2026-09-05T00:00:00Z",
            event: { artefact_version_ids: ["artefact-version:retained-by-bus"] } };
        },
        async listEndpoints() {
          return [
            { endpoint_id: "actor:workspace:test:floe", name: "Floe", status: "idle" },
            { endpoint_id: "actor:workspace:test:operator", name: "Operator", status: "active" },
          ];
        },
        async resolveEndpoint(_ws: string, ref: string) {
          if (ref === "operator") return { endpoint_id: "actor:workspace:test:operator", found: true };
          return { endpoint_id: "", found: false };
        },
      },
    } as any;

    await adapter.handleBundle(
      context,
      makeDelivery("del-emit-neutral", "thread-emit-n", "say hi"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" },
    );

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].destination.endpoint_id).toBe("actor:workspace:test:operator");
    expect(emittedEvents[0].content.text).toBe("Hello via neutral ref");
    expect(emittedEvents[0].content.references).toEqual([{ name: "Local preview approval", resource_ref: { kind: "approval_request", id: "approval:exact", revision: "2" } }]);
    expect(emittedEvents[0].artefact_version_ids).toEqual(["artefact-version:lantern", "artefact-version:scene"]);
    expect(emittedEvents[0].content.attachments).toEqual([
      { artefact_version_id: "artefact-version:lantern", name: "Teal Lantern" },
      { artefact_version_id: "artefact-version:scene", name: "Revised Courtyard" },
    ]);
    // Confirmation comes from the retained Bus result, not the requested refs.
    expect(JSON.parse(accepted.content[0].text)).toEqual({ ok: true, event_id: "event:accepted",
      accepted_at: "2026-09-05T00:00:00Z", artefact_version_ids: ["artefact-version:retained-by-bus"] });
    expect(emittedEvents[0].content.data).toMatchObject({
      report: { schema: "example.v1" },
      origin: "pi_emit_tool",
    });

    // Description neutralised
    expect(emitTool.description).not.toContain("agent:floe");
    expect(emitTool.description).not.toContain("user:operator");
  });

  it("emit tool still accepts legacy endpoint_id form (backward compat)", async () => {
    const emittedEvents: any[] = [];
    const fakeAgent: any = {
      registeredTools: [] as any[],
      listeners: [] as Array<(e: any) => void | Promise<void>>,
      subscribe(l: any) { this.listeners.push(l); },
      async prompt() {
        const emitTool = this.registeredTools.find((t: any) => t.name === "emit");
        await emitTool!.execute("tc_emit_legacy", {
          type: "message",
          destination: "actor:workspace:test:operator",
          text: "legacy form",
          response_expected: false,
        });
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" },
        });
      },
    };
    const adapter = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: { find() { return { id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider", baseUrl: "https://example.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 } as any; }, async getApiKeyForProvider() { return "test-key"; } } as any,
        profiles: { version: 1, profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }] },
      } as any,
      { agentFactory: (input) => { fakeAgent.registeredTools = input.tools ?? []; return fakeAgent; }, turnFinalizeTimeoutMs: 1_000 },
    );
    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry() {},
        async emit(event: any) { emittedEvents.push(event); },
        async listEndpoints() { return []; },
      },
    } as any;
    await adapter.handleBundle(
      context,
      makeDelivery("del-emit-legacy", "thread-emit-l", "x"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" },
    );
    expect(emittedEvents[0].destination.endpoint_id).toBe("actor:workspace:test:operator");
  });

  it("emit tool returns clear error when neutral ref does not resolve", async () => {
    let toolResult: any = null;
    const fakeAgent: any = {
      registeredTools: [] as any[],
      listeners: [] as Array<(e: any) => void | Promise<void>>,
      subscribe(l: any) { this.listeners.push(l); },
      async prompt() {
        const emitTool = this.registeredTools.find((t: any) => t.name === "emit");
        try {
          toolResult = await emitTool!.execute("tc_emit_bad", {
            type: "message",
            destination: "nobody",
            text: "x",
            response_expected: false,
          });
        } catch (err: any) {
          toolResult = { error: String(err?.message ?? err) };
        }
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" },
        });
      },
    };
    const adapter = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: { find() { return { id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider", baseUrl: "https://example.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 } as any; }, async getApiKeyForProvider() { return "test-key"; } } as any,
        profiles: { version: 1, profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }] },
      } as any,
      { agentFactory: (input) => { fakeAgent.registeredTools = input.tools ?? []; return fakeAgent; }, turnFinalizeTimeoutMs: 1_000 },
    );
    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry() {},
        async emit() {},
        async listEndpoints() { return []; },
        async resolveEndpoint() { return { endpoint_id: "", found: false }; },
      },
    } as any;
    await adapter.handleBundle(
      context,
      makeDelivery("del-emit-bad", "thread-emit-bad", "x"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" },
    );
    expect(toolResult).not.toBeNull();
    const text = toolResult.content?.[0]?.text ?? toolResult.error ?? JSON.stringify(toolResult);
    expect(String(text).toLowerCase()).toMatch(/(unknown|not.*resolve|no.*match|nobody|destination)/);
  });

  it("delivery prompt's source/reply/participants are neutral refs only", async () => {
    let capturedPrompt = "";
    const fakeAgent: any = {
      registeredTools: [] as any[],
      listeners: [] as Array<(e: any) => void | Promise<void>>,
      subscribe(l: any) { this.listeners.push(l); },
      async prompt(message: any) {
        capturedPrompt = message?.content?.[0]?.text ?? "";
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" },
        });
      },
    };
    const adapter = makeAdapter(fakeAgent);
    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry() {},
        async emit() {},
        async listEndpoints() {
          return [
            { endpoint_id: "actor:workspace:test:floe", name: "Floe", status: "idle" },
            { endpoint_id: "actor:workspace:test:operator", name: "Operator", status: "active" },
          ];
        },
        async getContext() {
          return {
            context_id: "ctx_neutral",
            workspace_id: "workspace:test",
            parent_context_id: null,
            created_by_endpoint_id: "actor:workspace:test:operator",
            created_at: new Date().toISOString(),
            participants: [
              "actor:workspace:test:floe",
              "actor:workspace:test:operator",
            ],
          };
        },
      },
    } as any;
    const delivery = makeDelivery("del-prompt-neutral", "thread-pn", "hello");
    (delivery.events[0] as any).context_id = "ctx_neutral";
    await adapter.handleBundle(context, delivery, { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" });

    expect(capturedPrompt).toContain("[Context Envelope]");
    // No legacy id prefixes anywhere in the prompt
    expect(capturedPrompt).not.toContain("actor:workspace:test:operator");
    expect(capturedPrompt).not.toContain("actor:workspace:test:floe");
    // No category prefixes followed by colon
    expect(capturedPrompt).not.toMatch(/\b(user|agent|human|webhook|runtime):/);
    // Visible Endpoints block, if rendered, has no actor_type column
    expect(capturedPrompt).not.toContain("actor_type");
    expect(capturedPrompt).toMatch(/cause_actor:\s*operator/);
    // Strict: no `endpoint:` substring anywhere in the rendered prompt,
    // and no legacy `source_endpoint`/`reply_destination` field labels.
    expect(capturedPrompt).not.toMatch(/endpoint:/);
    expect(capturedPrompt).not.toMatch(/reply_destination/);
    expect(capturedPrompt).not.toMatch(/source_endpoint(?!_id)/);
    expect(capturedPrompt).not.toContain("participants");
  });
});

describe("SUBSTRATE_GUIDANCE — actor-neutral wording", () => {
  it("does not teach category-distinguishing examples", () => {
    expect(SUBSTRATE_GUIDANCE).not.toContain("agent:floe");
    expect(SUBSTRATE_GUIDANCE).not.toContain("user:operator");
  });

  it("contains a neutrality statement about actor categories", () => {
    expect(SUBSTRATE_GUIDANCE.toLowerCase()).toContain(
      "the substrate does not distinguish people from models or integrations",
    );
  });

  it("destination context section names neutral fields, not legacy endpoint_id types", () => {
    // The guidance may reference source_actor / reply_actor — not category prefixes.
    expect(SUBSTRATE_GUIDANCE).not.toMatch(/\bhumans see\b/i);
    expect(SUBSTRATE_GUIDANCE).not.toMatch(/\bagents see\b/i);
  });
});

describe("Integration: agent cannot cite substrate metadata to identify actor category", () => {
  it("rendered prompt + list_endpoints output contain no category-revealing strings", async () => {
    let capturedPrompt = "";
    let listResult: any = null;
    const fakeAgent: any = {
      registeredTools: [] as any[],
      listeners: [] as Array<(e: any) => void | Promise<void>>,
      subscribe(l: any) { this.listeners.push(l); },
      async prompt(message: any) {
        capturedPrompt = message?.content?.[0]?.text ?? "";
        const tool = this.registeredTools.find((t: any) => t.name === "list_endpoints");
        listResult = await tool!.execute("tc_list_int", {});
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" },
        });
      },
    };
    const adapter = makeAdapter(fakeAgent);
    // hack: also capture registered tools
    const orig = (adapter as any);
    const context = {
      bridge_id: "bridge:test",
      bus: { recordRuntimeTurnResult,
        async appendRuntimeTelemetry() {},
        async emit() {},
        async listEndpoints() {
          return [
            { endpoint_id: "actor:workspace:test:floe", name: "Floe", status: "idle" },
            { endpoint_id: "actor:workspace:test:operator", name: "Operator", status: "active" },
          ];
        },
      },
    } as any;
    // Re-build adapter with capturing factory:
    const adapter2 = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: { find() { return { id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider", baseUrl: "https://example.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 } as any; }, async getApiKeyForProvider() { return "test-key"; } } as any,
        profiles: { version: 1, profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }] },
      } as any,
      { agentFactory: (input) => { fakeAgent.registeredTools = input.tools ?? []; return fakeAgent; }, turnFinalizeTimeoutMs: 1_000 },
    );
    void orig;
    await adapter2.handleBundle(
      context,
      makeDelivery("del-int", "thread-int", "are you talking to a human or an agent?"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" },
    );

    const allAgentVisibleText = `${capturedPrompt}\n${listResult?.content?.[0]?.text ?? ""}`;
    // No leakage of category words in dynamic substrate-rendered material.
    // (User's message text is excluded from this assertion — it's user content, not substrate metadata.)
    const dynamicSubstrate = capturedPrompt.split(/\nare you talking to a human or an agent\?/)[0];
    expect(dynamicSubstrate).not.toContain("actor_type");
    expect(dynamicSubstrate).not.toMatch(/\b(human|agent):/);
    expect(dynamicSubstrate).not.toMatch(/\bactor_type\b/);
    expect(allAgentVisibleText).not.toContain("actor:workspace:test:operator");
    expect(allAgentVisibleText).not.toContain("actor:workspace:test:floe");
  });
});
