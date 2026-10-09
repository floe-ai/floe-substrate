import { describe, expect, it } from "vitest";
import { CopilotRuntime } from "floe-runtime/adapters/copilot";
import { HookRegistry } from "../hooks.js";
import { FloeRuntimeAdapter } from "./floe-runtime-adapter.js";

describe("BeforeToolUse through the runtime", () => {
  it("lets the turn's BeforeToolUse handlers block a tool call or change its input", async () => {
    let createdConfig: Record<string, any> | undefined;
    const results: unknown[] = [];
    const seen: unknown[] = [];
    const session = {
      sessionId: "sdk-session",
      on(handler: (event: unknown) => void) {
        queueMicrotask(async () => {
          const tool = createdConfig!.tools[0].name as string;
          for (const text of ["stop", "go"]) {
            results.push(await createdConfig!.hooks.onPreToolUse({ toolName: tool, toolArgs: { text } }, { sessionId: "sdk-session" }));
          }
          handler({ type: "assistant.message", data: { content: "done", finishReason: "end_turn" } });
          handler({ type: "session.idle", data: {} });
        });
        return () => {};
      },
      async send() {},
      async disconnect() {},
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
            return { tools: (createdConfig?.availableTools as string[]).map(name => ({ name: name.replace(/^(custom|builtin):/, "") })) };
          },
        },
      },
    };
    const client = {
      async start() {},
      async createSession(config: Record<string, unknown>) { createdConfig = config; return session; },
      async stop() { return []; },
    };
    const hooks = new HookRegistry();
    hooks.on("BeforeToolUse", "guard", (call) => {
      seen.push({ endpoint_id: call.endpoint_id, delivery_id: call.delivery_id, source: call.source, args: call.args });
      return (call.args as { text: string }).text === "stop"
        ? { decision: "block", reason: "guard says stop" }
        : { decision: "change", args: { text: "changed" } };
    });
    const adapter = new FloeRuntimeAdapter({
      runtimeFactory: (options) => new CopilotRuntime({ ...options, client: client as any, clientOptions: { baseDirectory: "unused-by-stand-in" } }),
    });
    await adapter.handleBundle({
      bridge_id: "bridge:test", engine_account: { label: "tester", host: "https://github.com" },
      engine_tool_operation_ids: [],
      hooks,
      bus: {
        async getContext() { return null; },
        async listContextEvents() { return { events: [], next_cursor: null }; },
        async recordRuntimeTurnResult() { return { request_resolved: false, result_event: { event_id: "result-1" } }; },
        async appendRuntimeTelemetry() {},
      },
    } as any, {
      delivery_id: "delivery-1", endpoint_id: "actor:workspace:test:worker", workspace_id: "workspace:test",
      context_id: "context:test", events: [{ event_id: "event-1", type: "message", context_id: "context:test", source_endpoint_id: "actor:workspace:test:operator", content: { text: "Do work" } }],
    } as any);

    expect(seen).toEqual([
      { endpoint_id: "actor:workspace:test:worker", delivery_id: "delivery-1", source: "custom", args: { text: "stop" } },
      { endpoint_id: "actor:workspace:test:worker", delivery_id: "delivery-1", source: "custom", args: { text: "go" } },
    ]);
    expect(results[0]).toMatchObject({ permissionDecision: "deny" });
    expect((results[0] as { permissionDecisionReason: string }).permissionDecisionReason).toContain("guard says stop");
    expect(results[1]).toEqual({ permissionDecision: "allow", modifiedArgs: { text: "changed" } });
  });
});
