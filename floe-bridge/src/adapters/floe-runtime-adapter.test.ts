import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { CopilotSession } from "@github/copilot-sdk";
import { CopilotRuntime } from "floe-runtime/adapters/copilot";
import { FloeRuntimeAdapter } from "./floe-runtime-adapter.js";
import { createDirectSubstrateTools } from "./floe-direct-tools.js";

class FakeRuntime extends EventEmitter {
  readonly runs: any[] = [];
  readonly interrupt = vi.fn(async (_sessionId: string) => {});
  readonly quiesce = vi.fn(async (sessionId: string) => { await this.interrupt(sessionId); });
  readonly close = vi.fn(async () => {});
  readonly setModel = vi.fn(async () => {});
  constructor(private readonly failure?: Error) { super(); }
  capabilities() { return { directTools: true }; }
  async run(...args: any[]) {
    this.runs.push(args);
    await args[3]?.("sdk-session");
    if (this.failure) throw this.failure;
    return { text: "done", sessionId: "sdk-session", stopReason: "idle", usage: null, elapsedMs: 1 };
  }
}

function bundle(id = "delivery-1") {
  return {
    delivery_id: id, endpoint_id: "actor:workspace:test:worker", workspace_id: "workspace:test",
    context_id: "context:test", events: [{ event_id: "event-1", type: "message", context_id: "context:test", source_endpoint_id: "actor:workspace:test:operator", content: { text: "Do work" } }],
  } as any;
}

function context() {
  return {
    bridge_id: "bridge:test",
    bus: {
      async getContext() { return null; },
      async recordRuntimeTurnResult() { return { request_resolved: false, result_event: { event_id: "result-1" } }; },
      async appendRuntimeTelemetry() {},
    },
  } as any;
}

describe("FloeRuntimeAdapter SDK route", () => {
  it("passes the first requested model through to SDK session creation", async () => {
    let createdConfig: Record<string, unknown> | undefined;
    const session = {
      sessionId: "sdk-session",
      on(handler: (event: unknown) => void) {
        queueMicrotask(() => {
          handler({ type: "assistant.message", data: { content: "done", finishReason: "end_turn" } });
          handler({ type: "session.idle", data: {} });
        });
        return () => {};
      },
      async send() {},
      async disconnect() {},
      async setModel() {
        throw new Error("initial model must not be changed after session creation");
      },
    };
    const client = {
      async start() {},
      async createSession(config: Record<string, unknown>) {
        createdConfig = config;
        return session;
      },
      async stop() { return []; },
    };
    const runtime = new CopilotRuntime({ client: client as any });
    const adapter = new FloeRuntimeAdapter({ runtimeFactory: () => runtime });

    await adapter.handleBundle(context(), bundle(), { model: "creation-model" } as any);

    expect(createdConfig).toMatchObject({ model: "creation-model" });
  });

  it("separates first-session system instructions, forwards model selection, and reuses the SDK session", async () => {
    const runtime = new FakeRuntime();
    const ctx = context();
    const record = vi.fn(async () => ({ request_resolved: false, result_event: { event_id: "result-1" } }));
    ctx.bus.recordRuntimeTurnResult = record;
    const adapter = new FloeRuntimeAdapter({ runtimeFactory: () => runtime as any });
    await adapter.handleBundle(ctx, bundle(), { model: "dynamic-model", instructions: "Floe instructions" } as any);
    await adapter.handleBundle(ctx, bundle("delivery-2"), { model: "dynamic-model", instructions: "Floe instructions" } as any);
    await adapter.handleBundle(ctx, bundle("delivery-3"), { model: "newly-listed-model", instructions: "Floe instructions" } as any);

    const [first, second, third] = runtime.runs;
    expect(first[1].prompt).not.toContain("Floe instructions");
    expect(first[4]).toMatchObject({ model: "dynamic-model", systemMessage: { mode: "append", content: expect.stringContaining("Floe instructions") } });
    expect(first[4].tools.map((tool: any) => tool.name)).toContain("use_capability");
    expect(second[4].systemMessage).toBeUndefined();
    expect(second[5]).toMatchObject({ sessionId: "sdk-session", scope: "context:test" });
    expect(runtime.setModel).toHaveBeenCalledWith("sdk-session", "newly-listed-model");
    expect(third[4].model).toBe("newly-listed-model");
    expect(record).toHaveBeenCalledWith({
      delivery_id: "delivery-1",
      outcome: "completed",
      text: "done",
      metadata: {
        runtime: "floe-runtime",
        runtime_turn_id: expect.stringMatching(/^rt_/),
        execution_attempt_id: null,
        node_execution_id: null,
        composition_revision_id: null,
        stop_reason: "idle",
        session_id: "sdk-session",
      },
    });
  });

  it("keeps coded SDK faults visible instead of recording a successful result", async () => {
    const failure = Object.assign(new Error("model call failed"), { code: "model_call_failure" });
    const runtime = new FakeRuntime(failure);
    const record = vi.fn();
    const ctx = context();
    ctx.bus.recordRuntimeTurnResult = record;
    const adapter = new FloeRuntimeAdapter({ runtimeFactory: () => runtime as any });

    await expect(adapter.handleBundle(ctx, bundle(), undefined)).rejects.toThrow(/\[model_call_failure\]/);
    expect(record).not.toHaveBeenCalled();
  });

  it("interrupts the active SDK delivery without converting cancellation into completion", async () => {
    let release!: () => void;
    const runtime = new FakeRuntime();
    runtime.run = vi.fn(async (...args: any[]) => {
      await args[3]?.("sdk-session");
      await new Promise<void>(resolve => { release = resolve; });
      return { text: "done", sessionId: "sdk-session", stopReason: "idle", usage: null, elapsedMs: 1 };
    }) as any;
    const adapter = new FloeRuntimeAdapter({ runtimeFactory: () => runtime as any });
    const work = adapter.handleBundle(context(), bundle(), undefined);
    await vi.waitFor(() => expect(runtime.run).toHaveBeenCalled());
    await vi.waitFor(() => expect(adapter.cancelDelivery("delivery-1")).toBe(true));
    await vi.waitFor(() => expect(runtime.interrupt).toHaveBeenCalledWith("sdk-session"));
    release();
    await expect(work).rejects.toThrow(/\[interrupted\]/);
  });

  it("retains cancellation during session creation and quiesces before any result or usage is persisted", async () => {
    let createSession!: () => void;
    let modelOrToolWorkStarted = false;
    const runtime = new FakeRuntime();
    runtime.run = vi.fn(async (...args: any[]) => {
      await new Promise<void>(resolve => { createSession = resolve; });
      await args[3]?.("created-session");
      modelOrToolWorkStarted = true;
      return { text: "must not persist", sessionId: "created-session", stopReason: "idle", usage: { tokens: 1 }, elapsedMs: 1 };
    }) as any;
    const ctx = context();
    ctx.bus.recordRuntimeTurnResult = vi.fn();
    ctx.bus.appendRuntimeTelemetry = vi.fn();
    const adapter = new FloeRuntimeAdapter({ runtimeFactory: () => runtime as any });
    const work = adapter.handleBundle(ctx, bundle(), undefined);

    await vi.waitFor(() => expect(runtime.run).toHaveBeenCalled());
    expect(adapter.cancelDelivery("delivery-1")).toBe(true);
    createSession();

    await expect(work).rejects.toThrow(/\[interrupted\]/);
    expect(runtime.interrupt).toHaveBeenCalledWith("created-session");
    expect(runtime.quiesce).toHaveBeenCalledWith("created-session");
    expect(modelOrToolWorkStarted).toBe(false);
    expect(ctx.bus.recordRuntimeTurnResult).not.toHaveBeenCalled();
    expect(ctx.bus.appendRuntimeTelemetry).toHaveBeenCalledTimes(1);
    expect(ctx.bus.appendRuntimeTelemetry.mock.calls[0][0].kind).toBe("runtime_error");
  });

  it("deduplicates SDK activity and direct callback records by tool call ID", async () => {
    const runtime = new FakeRuntime();
    const activity: any[] = [];
    runtime.run = vi.fn(async (...args: any[]) => {
      await args[3]?.("sdk-session");
      const emit = args[4].tools.find((tool: any) => tool.name === "emit");
      runtime.emit("activity", { id: "tool-call-1", kind: "tool", status: "started", title: "emit" });
      await emit.handler(
        { type: "message", destination: "operator", text: "once" },
        { sessionId: "sdk-session", toolCallId: "tool-call-1", toolName: "emit" },
      );
      runtime.emit("activity", { id: "tool-call-1", kind: "tool", status: "completed", title: "emit" });
      return { text: "done", sessionId: "sdk-session", stopReason: "idle", usage: null, elapsedMs: 1 };
    }) as any;
    const ctx = context();
    ctx.bus.emit = vi.fn(async () => ({ event_id: "event-1", accepted_at: "now", event: { artefact_version_ids: [] } }));
    ctx.bus.listEndpoints = vi.fn(async () => [{ endpoint_id: "actor:workspace:test:operator", name: "operator" }]);
    ctx.hooks = {
      hasHandlers: (name: string) => name === "TurnEnd",
      fire: async (_name: string, payload: any) => { activity.push(...payload.tool_activity); return []; },
    };
    const adapter = new FloeRuntimeAdapter({ runtimeFactory: () => runtime as any });

    await adapter.handleBundle(ctx, bundle(), undefined);

    expect(activity).toEqual([{
      name: "emit",
      call_id: "tool-call-1",
      arguments: { type: "message", destination: "operator", text: "once" },
      is_error: false,
    }]);
  });
});

describe("direct substrate tools", () => {
  const schemaExpectations: Record<string, { required?: string[]; properties: string[] }> = {
    emit: { required: ["type", "destination", "text"], properties: ["type", "destination", "text", "references", "attachments", "artefact_version_ids", "data"] },
    request: { required: ["actor", "work"], properties: ["actor", "work", "artefact_version_ids"] },
    discover_capabilities: { properties: ["query", "operation_id", "include_result_schema", "category", "target", "limit"] },
    use_capability: { required: ["operation_id", "operation_version", "input_schema_version", "input"], properties: ["operation_id", "operation_version", "input_schema_version", "target", "expected_resource_revision", "idempotency_key", "input"] },
    create_pulse: { required: ["pulse_id", "trigger", "subscribers"], properties: ["pulse_id", "trigger", "event", "content", "subscribers", "persistence", "scope_id"] },
    list_pulses: { properties: ["status"] },
    pause_pulse: { required: ["pulse_id"], properties: ["pulse_id"] },
    resume_pulse: { required: ["pulse_id"], properties: ["pulse_id"] },
    cancel_pulse: { required: ["pulse_id"], properties: ["pulse_id"] },
    read_artefact: { required: ["artefact_version_id"], properties: ["artefact_version_id", "offset", "limit"] },
  };

  it("advertises every shared tool schema to SDK tools without loosening it", () => {
    const tools = createDirectSubstrateTools({
      getBus: () => ({}) as any, getAnchor: () => null, getActiveTurn: () => null,
      isDependencyRequested: () => false, markDependencyRequested: () => {}, recordEmitted: () => {}, recordToolActivity: () => {},
    });
    expect(Object.fromEntries(tools.map(tool => [tool.name, tool.parameters]))).toEqual(expect.objectContaining(
      Object.fromEntries(Object.keys(schemaExpectations).map(name => [name, expect.any(Object)])),
    ));
    for (const tool of tools) {
      const schema = tool.parameters as any;
      const expected = schemaExpectations[tool.name]!;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required ?? []).toEqual(expected.required ?? []);
      expect(Object.keys(schema.properties).sort()).toEqual(expected.properties.sort());
      expect(tool.skipPermission).toBe(true);
    }
    const schemas = Object.fromEntries(tools.map(tool => [tool.name, tool.parameters])) as Record<string, any>;
    expect(schemas.emit.properties.destination.description).toEqual(expect.any(String));
    expect(schemas.request.properties.actor.description).toEqual(expect.any(String));
    expect(schemas.discover_capabilities.properties.limit.description).toEqual(expect.any(String));
    expect(schemas.use_capability.properties.input.description).toEqual(expect.any(String));
    expect(schemas.create_pulse.properties.trigger.description).toEqual(expect.any(String));
    expect(schemas.list_pulses.properties.status.description).toEqual(expect.any(String));
    expect(schemas.pause_pulse.properties.pulse_id.description).toEqual(expect.any(String));
    expect(schemas.resume_pulse.properties.pulse_id.description).toEqual(expect.any(String));
    expect(schemas.cancel_pulse.properties.pulse_id.description).toEqual(expect.any(String));
    expect(schemas.read_artefact.properties.limit.description).toEqual(expect.any(String));
    expect(schemas.create_pulse.properties.trigger.properties.type.enum).toEqual(["once", "cron"]);
    expect(schemas.discover_capabilities.properties.limit).toMatchObject({ type: "number", minimum: 1, maximum: 20 });
    expect(schemas.read_artefact.properties.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 16000 });
  });

  it("executes through Bridge authority and rejects an unavailable active turn", async () => {
    const emitted: any[] = [];
    const tools = createDirectSubstrateTools({
      getBus: () => ({
        async emit(event: any) { emitted.push(event); return { event_id: "event-2", accepted_at: "now", event: { artefact_version_ids: [] } }; },
        async listEndpoints() { return [{ endpoint_id: "actor:workspace:test:operator", name: "operator" }]; },
      }) as any,
      getAnchor: () => ({ workspace_id: "workspace:test", endpoint_id: "actor:workspace:test:worker", thread_id: "context:test", context_id: "context:test", runtime_turn_id: "turn-1", delivery_id: "delivery-1", execution_attempt_id: null, scope_execution_id: null, composition_revision_id: null, node_execution_id: null, target_node_id: null, invocation_request_event_id: null }),
      getActiveTurn: () => null,
      isDependencyRequested: () => false, markDependencyRequested: () => {}, recordEmitted: () => {}, recordToolActivity: () => {},
    });
    const emit = tools.find(tool => tool.name === "emit")!;
    await emit.handler({ type: "message", destination: "operator", text: "approved" }, { sessionId: "s", toolCallId: "t", toolName: "emit" });
    expect(emitted).toHaveLength(1);
    const capability = tools.find(tool => tool.name === "use_capability")!;
    await expect(capability.handler({ operation_id: "x", operation_version: "1", input_schema_version: "1", input: {} }, { sessionId: "s", toolCallId: "t", toolName: "use_capability" })).rejects.toThrow("no active Floe turn");
  });

  it("preserves a Bus governance refusal as a failed direct-tool result", async () => {
    const invokeOperation = vi.fn(async () => ({
      kind: "rejected",
      refusal: {
        code: "operation_not_granted",
        message: "This operation is not granted to the runtime delivery.",
        retryable: false,
        required_action: "request_grant",
        details: {},
      },
    }));
    const recordToolActivity = vi.fn();
    const tools = createDirectSubstrateTools({
      getBus: () => ({
        async prepareRuntimeDelivery() {
          return {
            processing_contract: { processing_contract_id: "contract-1" },
            operation_authority_session: {
              bearer_token: "test-authority",
              expires_at: "2099-01-01T00:00:00.000Z",
            },
          };
        },
        invokeOperation,
      }) as any,
      getAnchor: () => null,
      getActiveTurn: () => ({
        workspace_id: "workspace:test",
        context_id: "context:test",
        workspace_locator: null,
        delivery_id: "delivery-1",
        processing_contract_id: null,
        operation_authority_session: null,
      }),
      isDependencyRequested: () => false, markDependencyRequested: () => {}, recordEmitted: () => {}, recordToolActivity,
    });
    const capability = tools.find(tool => tool.name === "use_capability")!;

    await expect(capability.handler(
      { operation_id: "live.ungranted.operation", operation_version: "1", input_schema_version: "1", input: {} },
      { sessionId: "s", toolCallId: "t", toolName: "use_capability" },
    )).resolves.toMatchObject({ resultType: "failure", textResultForLlm: expect.stringContaining("operation_not_granted") });
    expect(invokeOperation).toHaveBeenCalledWith(
      "workspace:test",
      "test-authority",
      expect.objectContaining({ operation_id: "live.ungranted.operation" }),
    );
    expect(recordToolActivity).toHaveBeenNthCalledWith(1, {
      name: "use_capability",
      call_id: "t",
      arguments: {
        operation_id: "live.ungranted.operation",
        operation_version: "1",
        input_schema_version: "1",
        input: {},
      },
    });
    expect(recordToolActivity).toHaveBeenNthCalledWith(2, {
      name: "use_capability", call_id: "t", is_error: true, result_code: "operation_not_granted",
    });
  });

  it("dispatches SDK external tool requests through registered Bridge handlers", async () => {
    const emitted: any[] = [];
    const completed = vi.fn(async () => {});
    const activity: any[] = [];
    const tools = createDirectSubstrateTools({
      getBus: () => ({
        async emit(event: any) {
          emitted.push(event);
          return { event_id: "event-emit-1", accepted_at: "now", event: { artefact_version_ids: [] } };
        },
        async listEndpoints() { return [{ endpoint_id: "actor:workspace:test:operator", name: "operator" }]; },
      }) as any,
      getAnchor: () => ({
        workspace_id: "workspace:test", endpoint_id: "actor:workspace:test:worker",
        thread_id: "context:test", context_id: "context:test", runtime_turn_id: "rt-1",
        delivery_id: "delivery-1", execution_attempt_id: null, scope_execution_id: null,
        composition_revision_id: null, node_execution_id: null, target_node_id: null,
        invocation_request_event_id: null,
      }),
      getActiveTurn: () => null,
      isDependencyRequested: () => false, markDependencyRequested: () => {}, recordEmitted: () => {},
      recordToolActivity: entry => activity.push(entry),
    });
    const sdkSession = new (CopilotSession as any)("sdk-session-1", {});
    sdkSession._rpc = { tools: { handlePendingToolCall: completed } };
    sdkSession.registerTools(tools);

    sdkSession._dispatchEvent({
      type: "external_tool.requested",
      data: {
        requestId: "request-1",
        toolCallId: "tool-call-1",
        toolName: "emit",
        arguments: { type: "message", destination: "operator", text: "exact provenance" },
      },
    });

    await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
    expect(emitted).toEqual([expect.objectContaining({
      type: "message",
      source_endpoint_id: "actor:workspace:test:worker",
      destination: { kind: "endpoint", endpoint_id: "actor:workspace:test:operator" },
      current_delivery_context_id: "context:test",
      metadata: expect.objectContaining({ origin: "floe_emit_tool", delivery_id: "delivery-1", runtime_turn_id: "rt-1" }),
    })]);
    expect(activity).toEqual([
      { name: "emit", call_id: "tool-call-1", arguments: { type: "message", destination: "operator", text: "exact provenance" } },
      { name: "emit", call_id: "tool-call-1", is_error: false },
    ]);
  });
});
