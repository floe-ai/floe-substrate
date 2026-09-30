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

const TEST_ACCOUNT = { label: "tester", host: "https://github.com" };

function context() {
  return {
    bridge_id: "bridge:test",
    engine_account: TEST_ACCOUNT,
    bus: {
      async getContext() { return null; },
      async listContextEvents() { return { events: [], next_cursor: null }; },
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
      rpc: {
        gitHubAuth: { async getStatus() { return { isAuthenticated: true, authType: "user", login: "tester", host: "https://github.com" }; } },
        permissions: {
          async configure() {},
          async setApproveAll() {},
          async setMode() { return { success: true, mode: "manual" }; },
          async resetSessionApprovals() {},
        },
        tools: {
          async initializeAndValidate() {},
          async getCurrentMetadata() {
            return { tools: (createdConfig?.availableTools as string[] ?? []).map(name => ({ name: name.replace(/^(custom|builtin):/, "") })) };
          },
        },
      },
    };
    const client = {
      async start() {},
      async listModels() { return [{ id: "creation-model" }]; },
      async createSession(config: Record<string, unknown>) {
        createdConfig = config;
        return session;
      },
      async stop() { return []; },
    };
    const runtime = new CopilotRuntime({ client: client as any, clientOptions: { baseDirectory: "unused-by-stand-in" }, expectedAccount: TEST_ACCOUNT });
    const adapter = new FloeRuntimeAdapter({ runtimeFactory: () => runtime });

    await adapter.handleBundle(context(), bundle(), { model: "creation-model" } as any);

    expect(createdConfig).toMatchObject({
      model: "creation-model",
      availableTools: [
        "custom:emit",
        "custom:request",
        "custom:discover_capabilities",
        "custom:use_capability",
        "custom:create_pulse",
        "custom:list_pulses",
        "custom:pause_pulse",
        "custom:resume_pulse",
        "custom:cancel_pulse",
        "custom:read_artefact",
      ],
    });
    expect((createdConfig!.tools as any[]).map(tool => `custom:${tool.name}`)).toEqual(createdConfig!.availableTools);
    expect((createdConfig!.tools as any[]).find(tool => tool.name === "emit")).toMatchObject({
      skipPermission: true,
      parameters: expect.objectContaining({ type: "object", additionalProperties: false }),
    });
  });

  it("separates first-session system instructions, forwards model selection, and reuses the SDK session", async () => {
    const runtime = new FakeRuntime();
    const ctx = context();
    const record = vi.fn(async () => ({ request_resolved: false, result_event: { event_id: "result-1" } }));
    ctx.bus.recordRuntimeTurnResult = record;
    const adapter = new FloeRuntimeAdapter({ runtimeFactory: () => runtime as any });
    const logged: unknown[][] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logged.push(args); });
    try {
      await adapter.handleBundle(ctx, bundle(), { model: "dynamic-model", instructions: "Floe instructions" } as any);
      await adapter.handleBundle(ctx, bundle("delivery-2"), { model: "dynamic-model", instructions: "Floe instructions" } as any);
      await adapter.handleBundle(ctx, bundle("delivery-3"), { model: "newly-listed-model", instructions: "Floe instructions" } as any);
    } finally {
      log.mockRestore();
    }

    const [first, second, third] = runtime.runs;
    // The log states what was actually sent: the system message on the new
    // session, nothing on a resumed one.
    const injected = logged.filter(([label]) => label === "[bridge] floe-runtime prompt injected").map(([, body]) => body as any);
    expect(injected.map((body) => body.system_message_bytes)).toEqual([first[4].systemMessage.content.length, 0, 0]);
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

  it("rebuilds canonical Context continuity once on a cold session", async () => {
    const runtime = new FakeRuntime();
    const ctx = context();
    const listContextEvents = vi.fn(async () => ({
      events: [{
        event_id: "event-old",
        type: "message",
        created_at: "2026-09-30T00:00:00.000Z",
        source_endpoint_id: "actor:workspace:test:operator",
        correlation_id: null,
        content: { text: "Remember code ORANGE-417." },
        artefact_version_ids: [],
      }],
      next_cursor: null,
    }));
    const telemetry = vi.fn(async () => {});
    ctx.bus.listContextEvents = listContextEvents;
    ctx.bus.appendRuntimeTelemetry = telemetry;
    const adapter = new FloeRuntimeAdapter({ runtimeFactory: () => runtime as any });

    await adapter.handleBundle(ctx, bundle(), undefined);
    await adapter.handleBundle(ctx, bundle("delivery-2"), undefined);

    expect(listContextEvents).toHaveBeenCalledOnce();
    expect(runtime.runs[0][1].prompt).toContain("[Floe Context continuity]");
    expect(runtime.runs[0][1].prompt).toContain("ORANGE-417");
    expect(runtime.runs[0][1].prompt.match(/Do work/g)).toHaveLength(1);
    expect(runtime.runs[1][1].prompt).not.toContain("[Floe Context continuity]");
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
      kind: "context_continuity_rebuilt",
      payload: expect.objectContaining({
        source: "floe_context_events",
        event_count: 1,
        token_upper_bound: expect.any(Number),
      }),
    }));
    expect(telemetry.mock.calls.filter(call =>
      (call as unknown as Array<{ kind?: string }>)[0]?.kind === "context_continuity_rebuilt"
    )).toHaveLength(1);
  });

  it("retires cached vendor state when canonical Context history changes", async () => {
    const runtimes: FakeRuntime[] = [];
    const ctx = context();
    const listContextEvents = vi.fn(async () => ({ events: [], next_cursor: null }));
    ctx.bus.listContextEvents = listContextEvents;
    const adapter = new FloeRuntimeAdapter({
      runtimeFactory: () => {
        const runtime = new FakeRuntime();
        runtimes.push(runtime);
        return runtime as any;
      },
    });

    await adapter.handleBundle(ctx, bundle(), undefined);
    await adapter.contextHistoryChanged("context:test");
    await adapter.handleBundle(ctx, bundle("delivery-2"), undefined);

    expect(runtimes).toHaveLength(2);
    expect(runtimes[0].close).toHaveBeenCalledOnce();
    expect(listContextEvents).toHaveBeenCalledTimes(2);
    expect(runtimes[1].runs[0][5]).toEqual({ scope: "context:test" });
  });

  it("fails explicitly when canonical Context history exceeds its token budget", async () => {
    const runtime = new FakeRuntime();
    const ctx = context();
    ctx.bus.listContextEvents = vi.fn(async () => ({
      events: [{
        event_id: "event-old",
        type: "message",
        created_at: "2026-09-30T00:00:00.000Z",
        source_endpoint_id: "actor:workspace:test:operator",
        correlation_id: null,
        content: { text: "x".repeat(9_000) },
        artefact_version_ids: [],
      }],
      next_cursor: null,
    }));
    const adapter = new FloeRuntimeAdapter({ runtimeFactory: () => runtime as any });

    await expect(adapter.handleBundle(ctx, bundle(), undefined)).rejects.toThrow(
      /\[context_continuity_too_large\].*Compact the Context/,
    );
    expect(runtime.runs).toHaveLength(0);
  });

  it("fails without starting memoryless work when Context history is unavailable, then retries", async () => {
    const runtime = new FakeRuntime();
    const ctx = context();
    const listContextEvents = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("Bus history unavailable"), { code: "bus_unavailable" }))
      .mockResolvedValueOnce({ events: [], next_cursor: null });
    ctx.bus.listContextEvents = listContextEvents;
    const adapter = new FloeRuntimeAdapter({ runtimeFactory: () => runtime as any });

    await expect(adapter.handleBundle(ctx, bundle(), undefined)).rejects.toThrow(
      /\[bus_unavailable\] Bus history unavailable/,
    );
    expect(runtime.runs).toHaveLength(0);

    await adapter.handleBundle(ctx, bundle("delivery-2"), undefined);
    expect(listContextEvents).toHaveBeenCalledTimes(2);
    expect(runtime.runs).toHaveLength(1);
  });

  it("runs each turn as the account readiness admitted, and never reuses a session across accounts", async () => {
    const built: { runtime: FakeRuntime; account: unknown }[] = [];
    const adapter = new FloeRuntimeAdapter({
      runtimeFactory: (options) => {
        const runtime = new FakeRuntime();
        built.push({ runtime, account: options.expectedAccount });
        return runtime as any;
      },
    });
    const other = { label: "someone-else", host: "https://github.com" };

    await adapter.handleBundle(context(), bundle(), undefined);
    await adapter.handleBundle(context(), bundle("delivery-2"), undefined);
    await adapter.handleBundle({ ...context(), engine_account: other }, bundle("delivery-3"), undefined);

    expect(built.map(b => b.account)).toEqual([TEST_ACCOUNT, other]);
    expect(built[0].runtime.runs).toHaveLength(2);
    expect(built[0].runtime.close).toHaveBeenCalled();
    expect(built[1].runtime.runs).toHaveLength(1);
  });

  it("refuses a turn when readiness admitted no account", async () => {
    const runtimeFactory = vi.fn(() => new FakeRuntime() as any);
    const ctx = context();
    delete ctx.engine_account;
    const record = vi.fn(async () => ({ request_resolved: false, result_event: { event_id: "result-1" } }));
    ctx.bus.recordRuntimeTurnResult = record;
    const adapter = new FloeRuntimeAdapter({ runtimeFactory });

    await expect(adapter.handleBundle(ctx, bundle(), undefined)).rejects.toThrow(/did not report a signed-in account/);
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  it("records a result with empty text when a turn ends without visible output", async () => {
    const runtime = new FakeRuntime();
    runtime.run = vi.fn(async (...args: any[]) => {
      await args[3]?.("sdk-session");
      return { text: "  ", sessionId: "sdk-session", stopReason: "idle", usage: null, elapsedMs: 1 };
    }) as any;
    const ctx = context();
    const record = vi.fn(async () => ({ request_resolved: false, result_event: { event_id: "result-1" } }));
    ctx.bus.recordRuntimeTurnResult = record;
    const adapter = new FloeRuntimeAdapter({ runtimeFactory: () => runtime as any });

    await adapter.handleBundle(ctx, bundle(), undefined);

    expect(record).toHaveBeenCalledWith(expect.objectContaining({ delivery_id: "delivery-1", outcome: "completed", text: "" }));
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

  it("does not confirm quiescence until the cancelled delivery has fully settled", async () => {
    let finishTool!: () => void;
    let toolFinished = false;
    const runtime = new FakeRuntime();
    runtime.run = vi.fn(async (...args: any[]) => {
      await args[3]?.("sdk-session");
      runtime.emit("activity", {
        id: "shell-call",
        kind: "tool",
        status: "started",
        title: "shell",
        startedAt: Date.now(),
      });
      await new Promise<void>((resolve) => { finishTool = resolve; });
      toolFinished = true;
      runtime.emit("activity", {
        id: "shell-call",
        kind: "tool",
        status: "completed",
        title: "shell",
        endedAt: Date.now(),
      });
      throw Object.assign(new Error("cancelled"), { code: "interrupted" });
    }) as any;
    const adapter = new FloeRuntimeAdapter({ runtimeFactory: () => runtime as any });
    const work = adapter.handleBundle(context(), bundle(), undefined);
    await vi.waitFor(() => expect(runtime.run).toHaveBeenCalled());

    expect(adapter.cancelDelivery("delivery-1")).toBe(true);
    let acknowledged = false;
    const cancellation = adapter.waitForDeliveryCancellation("delivery-1").then((result) => {
      acknowledged = true;
      return result;
    });
    await runtime.quiesce.mock.results[0]!.value;
    await Promise.resolve();

    expect(acknowledged).toBe(false);
    expect(toolFinished).toBe(false);

    finishTool();
    await expect(work).rejects.toThrow(/\[interrupted\]/);
    await expect(cancellation).resolves.toMatchObject({
      outcome: "quiesced",
      evidence: {
        timeline: {
          adapter_cancel_requested_at: expect.any(String),
          runtime_quiesced_at: expect.any(String),
          delivery_settled_at: expect.any(String),
          tool_activity: [{
            call_id: "shell-call",
            lifecycle: "completed",
            started_at: expect.any(String),
            ended_at: expect.any(String),
          }],
        },
      },
    });
  });

  it("force-retires when aborted idle cannot prove the shell process tree exited", async () => {
    let reportAbortedIdle!: () => void;
    const runtime = new FakeRuntime();
    runtime.quiesce.mockRejectedValue(Object.assign(
      new Error("Copilot did not prove that the cancelled shell process tree exited."),
      { code: "quiescence_unknown" },
    ));
    runtime.run = vi.fn(async (...args: any[]) => {
      await args[3]?.("sdk-session");
      runtime.emit("activity", {
        id: "shell-call",
        kind: "tool",
        status: "started",
        title: "shell",
        startedAt: Date.now(),
      });
      await new Promise<void>((resolve) => { reportAbortedIdle = resolve; });
      throw Object.assign(new Error("cancelled"), { code: "interrupted" });
    }) as any;
    const adapter = new FloeRuntimeAdapter({ runtimeFactory: () => runtime as any });
    const work = adapter.handleBundle(context(), bundle(), undefined);
    await vi.waitFor(() => expect(runtime.run).toHaveBeenCalled());

    expect(adapter.cancelDelivery("delivery-1")).toBe(true);
    const cancellation = adapter.waitForDeliveryCancellation("delivery-1");
    reportAbortedIdle();
    await expect(work).rejects.toThrow(/\[quiescence_unknown\]/);
    await expect(cancellation).resolves.toBeNull();
    await expect(adapter.forceRetireDelivery("delivery-1")).resolves.toMatchObject({
      outcome: "session_retired",
      evidence: { timeline: { session_retired_at: expect.any(String) } },
    });
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("force-retires a session when runtime idle arrives before its shell tool ends", async () => {
    let reportIdle!: () => void;
    let stopTool!: () => void;
    let toolStopped = false;
    const runtime = new FakeRuntime();
    runtime.run = vi.fn(async (...args: any[]) => {
      await args[3]?.("sdk-session");
      runtime.emit("activity", {
        id: "shell-call",
        kind: "tool",
        status: "started",
        title: "shell",
        startedAt: Date.now(),
      });
      await new Promise<void>((resolve) => { reportIdle = resolve; });
      throw Object.assign(new Error("runtime reported idle"), { code: "interrupted" });
    }) as any;
    runtime.close.mockImplementation(async () => {
      await new Promise<void>((resolve) => { stopTool = resolve; });
      toolStopped = true;
    });
    const adapter = new FloeRuntimeAdapter({ runtimeFactory: () => runtime as any });
    const work = adapter.handleBundle(context(), bundle(), undefined);
    await vi.waitFor(() => expect(runtime.run).toHaveBeenCalled());

    expect(adapter.cancelDelivery("delivery-1")).toBe(true);
    reportIdle();
    await expect(work).rejects.toThrow(/\[interrupted\]/);
    await expect(adapter.waitForDeliveryCancellation("delivery-1")).resolves.toBeNull();

    let retired = false;
    const retirement = adapter.forceRetireDelivery("delivery-1").then((result) => {
      retired = true;
      return result;
    });
    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledOnce());
    expect(retired).toBe(false);
    expect(toolStopped).toBe(false);

    stopTool();
    await expect(retirement).resolves.toMatchObject({
      outcome: "session_retired",
      evidence: {
        timeline: {
          adapter_cancel_requested_at: expect.any(String),
          session_retired_at: expect.any(String),
          delivery_settled_at: expect.any(String),
          tool_activity: [{
            call_id: "shell-call",
            lifecycle: "started",
            started_at: expect.any(String),
          }],
        },
      },
    });
    expect(toolStopped).toBe(true);
  });

  it("force-retires only the isolated session that owns an overdue delivery", async () => {
    let release!: () => void;
    const runtime = new FakeRuntime();
    runtime.run = vi.fn(async (...args: any[]) => {
      await args[3]?.("sdk-session");
      await new Promise<void>((resolve) => { release = resolve; });
      throw new Error("session closed");
    }) as any;
    runtime.close.mockImplementation(async () => { release(); });
    const adapter = new FloeRuntimeAdapter({ runtimeFactory: () => runtime as any });
    const work = adapter.handleBundle(context(), bundle(), undefined);
    await vi.waitFor(() => expect(runtime.run).toHaveBeenCalled());

    await expect(adapter.forceRetireDelivery("delivery-1")).resolves.toMatchObject({
      outcome: "session_retired",
      evidence: { session_id: "sdk-session" },
    });
    expect(runtime.close).toHaveBeenCalledOnce();
    await expect(work).rejects.toThrow();
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
    ctx.bus.appendRuntimeTelemetry = vi.fn(async () => {});
    ctx.hooks = {
      hasHandlers: (name: string) => name === "TurnEnd",
      fire: async (_name: string, payload: any) => { activity.push(...payload.tool_activity); return []; },
    };
    const adapter = new FloeRuntimeAdapter({ runtimeFactory: () => runtime as any });

    await adapter.handleBundle(ctx, bundle(), undefined);

    expect(activity).toEqual([{
      name: "emit",
      call_id: "tool-call-1",
      lifecycle: "completed",
      provenance: "floe_direct_tool_callback",
      arguments: { type: "message", destination: "operator", text: "once" },
      is_error: false,
      result_type: "success",
      result_value: expect.stringContaining("event-1"),
      started_at: expect.any(String),
      ended_at: expect.any(String),
    }]);
    const toolEvidence = ctx.bus.appendRuntimeTelemetry.mock.calls
      .map(([entry]: any[]) => entry)
      .find((entry: any) => entry.kind === "sdk_tool_evidence");
    expect(toolEvidence.payload).toMatchObject({
      sdk_session_id: "sdk-session",
      registration_acknowledgement: {
        exposed: false,
        reason: "copilot_sdk_does_not_expose_tool_registration_acknowledgement",
      },
      exposure_proof: { kind: "first_exact_callback", tool_call_id: "tool-call-1" },
      tool_calls: [expect.objectContaining({
        call_id: "tool-call-1",
        lifecycle: "completed",
        provenance: "floe_direct_tool_callback",
      })],
    });
  });

  it("pushes each tool call's start and end live, in order, before the turn's evidence, without its arguments", async () => {
    const runtime = new FakeRuntime();
    const ctx = context();
    const kinds: string[] = [];
    let seenMidTurn: any[] = [];
    ctx.bus.appendRuntimeTelemetry = vi.fn(async (entry: any) => { kinds.push(entry.kind); });
    runtime.run = vi.fn(async (...args: any[]) => {
      await args[3]?.("sdk-session");
      runtime.emit("activity", { id: "call-1", kind: "tool", status: "started", title: "view", startedAt: 1_000 });
      runtime.emit("activity", { id: "call-1", kind: "tool", status: "completed", title: "view", endedAt: 2_000 });
      runtime.emit("activity", { id: "call-2", kind: "tool", status: "started", title: "shell", startedAt: 3_000 });
      runtime.emit("activity", { id: "call-2", kind: "tool", status: "failed", title: "shell", endedAt: 4_000 });
      await vi.waitFor(() => expect(kinds.filter(kind => kind === "tool_activity")).toHaveLength(4));
      seenMidTurn = ctx.bus.appendRuntimeTelemetry.mock.calls
        .map(([entry]: any[]) => entry)
        .filter((entry: any) => entry.kind === "tool_activity");
      return { text: "done", sessionId: "sdk-session", stopReason: "idle", usage: null, elapsedMs: 1 };
    }) as any;
    const adapter = new FloeRuntimeAdapter({ runtimeFactory: () => runtime as any });

    await adapter.handleBundle(ctx, bundle(), undefined);

    expect(seenMidTurn.map((entry: any) => [entry.payload.tool_call_id, entry.payload.name, entry.payload.status, entry.payload.at]))
      .toEqual([
        ["call-1", "view", "started", new Date(1_000).toISOString()],
        ["call-1", "view", "completed", new Date(2_000).toISOString()],
        ["call-2", "shell", "started", new Date(3_000).toISOString()],
        ["call-2", "shell", "failed", new Date(4_000).toISOString()],
      ]);
    expect(seenMidTurn[0]).toMatchObject({ delivery_id: "delivery-1", payload: { delivery_id: "delivery-1" } });
    expect(Object.keys(seenMidTurn[0].payload)).not.toContain("arguments");
    expect(kinds.lastIndexOf("tool_activity")).toBeLessThan(kinds.indexOf("sdk_tool_evidence"));
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
        code: "operation_grant_required",
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
      { operation_id: "command.list", operation_version: "1", input_schema_version: "1", input: {} },
      { sessionId: "s", toolCallId: "t", toolName: "use_capability" },
    )).resolves.toMatchObject({ resultType: "failure", textResultForLlm: expect.stringContaining("operation_grant_required") });
    expect(invokeOperation).toHaveBeenCalledWith(
      "workspace:test",
      "test-authority",
      expect.objectContaining({ operation_id: "command.list" }),
    );
    expect(recordToolActivity).toHaveBeenNthCalledWith(1, {
      name: "use_capability",
      call_id: "t",
      lifecycle: "started",
      provenance: "floe_direct_tool_callback",
      arguments: {
        operation_id: "command.list",
        operation_version: "1",
        input_schema_version: "1",
        input: {},
      },
      started_at: expect.any(String),
    });
    expect(recordToolActivity).toHaveBeenNthCalledWith(2, expect.objectContaining({
      name: "use_capability",
      call_id: "t",
      lifecycle: "failed",
      provenance: "floe_direct_tool_callback",
      is_error: true,
      result_type: "failure",
      result_value: expect.stringContaining("operation_grant_required"),
      result_code: "operation_grant_required",
    }));

    const completed = vi.fn(async () => {});
    const sdkSession = new (CopilotSession as any)("sdk-session-1", {});
    sdkSession._rpc = { tools: { handlePendingToolCall: completed } };
    sdkSession.registerTools(tools);
    sdkSession._dispatchEvent({
      type: "external_tool.requested",
      data: {
        requestId: "request-denied-1",
        toolCallId: "tool-denied-1",
        toolName: "use_capability",
        arguments: { operation_id: "command.list", operation_version: "1", input_schema_version: "1", input: {} },
      },
    });
    await vi.waitFor(() => expect(completed).toHaveBeenCalledWith({
      requestId: "request-denied-1",
      result: expect.objectContaining({
        resultType: "failure",
        textResultForLlm: expect.stringContaining("operation_grant_required"),
      }),
    }));
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
    expect(completed).toHaveBeenCalledWith({
      requestId: "request-1",
      result: expect.objectContaining({
        resultType: "success",
        textResultForLlm: expect.any(String),
      }),
    });
    expect(emitted).toEqual([expect.objectContaining({
      type: "message",
      source_endpoint_id: "actor:workspace:test:worker",
      destination: { kind: "endpoint", endpoint_id: "actor:workspace:test:operator" },
      current_delivery_context_id: "context:test",
      metadata: expect.objectContaining({ origin: "floe_emit_tool", delivery_id: "delivery-1", runtime_turn_id: "rt-1" }),
    })]);
    expect(activity).toEqual([
      {
        name: "emit",
        call_id: "tool-call-1",
        lifecycle: "started",
        provenance: "floe_direct_tool_callback",
        arguments: { type: "message", destination: "operator", text: "exact provenance" },
        started_at: expect.any(String),
      },
      {
        name: "emit",
        call_id: "tool-call-1",
        lifecycle: "completed",
        provenance: "floe_direct_tool_callback",
        is_error: false,
        result_type: "success",
        result_value: expect.stringContaining("event-emit-1"),
        result_code: undefined,
        started_at: expect.any(String),
        ended_at: expect.any(String),
      },
    ]);
  });
});

describe("F1 cancellation regression", () => {
  it("allows next delivery after cancellation during session creation", async () => {
    let createSession!: () => void;
    const runtime = new FakeRuntime();
    runtime.run = vi.fn(async (...args: any[]) => {
      // Don't resolve session creation until the test allows it
      await new Promise<void>(resolve => { createSession = resolve; });
      await args[3]?.("created-session-f1");
      // This part should not be reached if cancellation is correct
      return { text: "must not persist", sessionId: "created-session-f1", stopReason: "idle", usage: { tokens: 1 }, elapsedMs: 1 };
    }) as any;

    const ctx = context();
    ctx.bus.recordRuntimeTurnResult = vi.fn(async () => ({ request_resolved: false, result_event: { event_id: "result-f1-2" } }));
    ctx.bus.appendRuntimeTelemetry = vi.fn();
    const adapter = new FloeRuntimeAdapter({ runtimeFactory: () => runtime as any });

    // --- First delivery ---
    const firstDelivery = bundle("delivery-f1-1");
    const firstWork = adapter.handleBundle(ctx, firstDelivery, undefined);

    // Wait for the adapter to call runtime.run
    await vi.waitFor(() => expect(runtime.run).toHaveBeenCalled());

    // Cancel the first delivery while it's "creating the session"
    expect(adapter.cancelDelivery(firstDelivery.delivery_id)).toBe(true);

    // Now, let the session creation proceed
    createSession();

    // The first delivery should fail with an interruption error
    await expect(firstWork).rejects.toThrow(/\[interrupted\]/);

    // Public proof the cancellation produced a recorded result: the adapter
    // emitted a runtime_error telemetry carrying the interrupted fault for the
    // first delivery. We never inspect the adapter's private session map.
    const firstErrorTelemetry = ctx.bus.appendRuntimeTelemetry.mock.calls
      .map(([entry]: [{ kind: string; payload: { fault_code?: unknown } }]) => entry)
      .find((entry: { kind: string }) => entry.kind === "runtime_error");
    expect(firstErrorTelemetry).toBeDefined();
    expect(firstErrorTelemetry.payload.fault_code).toBe("interrupted");

    // --- Second delivery ---
    const secondDelivery = bundle("delivery-f1-2");
    runtime.run = vi.fn(async (...args: any[]) => {
      await args[3]?.("created-session-f1-2");
      return { text: "second delivery success", sessionId: "created-session-f1-2", stopReason: "idle", usage: null, elapsedMs: 1 };
    }) as any;

    // The second delivery reuses the same endpoint/context. If the cancelled
    // turn had not freed the session, this call could not be accepted and
    // completed. Its success is the public evidence the session is reusable.
    const secondWork = adapter.handleBundle(ctx, secondDelivery, undefined);

    // The second delivery should complete successfully
    await expect(secondWork).resolves.toBeUndefined();

    // Verify that the result of the second delivery was recorded
    expect(ctx.bus.recordRuntimeTurnResult).toHaveBeenCalledWith(expect.objectContaining({
      delivery_id: "delivery-f1-2",
      outcome: "completed",
      text: "second delivery success",
    }));
  });
});
