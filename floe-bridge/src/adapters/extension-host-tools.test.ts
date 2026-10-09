import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import type { ExtensionToolBinding } from "../extensions/workspace-extensions.js";
import { FloeRuntimeAdapter } from "./floe-runtime-adapter.js";

function binding(description: string, call = vi.fn(async (params: Record<string, unknown>, callId: string) => ({
  content: [{ type: "text" as const, text: `${callId}:${String(params.text)}` }],
}))): ExtensionToolBinding {
  return { name: "todo_add", description, parameters: { type: "object", properties: { text: { type: "string" } } }, call };
}

describe("FloeRuntimeAdapter Extension tools", () => {
  it("offers the Actor's Extension tools, runs them through their binding and renews the session when they change", async () => {
    const runs: any[][] = [];
    const retire = vi.fn(async () => ({ status: "retiredLocally" }));
    const runtime = Object.assign(new EventEmitter(), {
      retire,
      close: vi.fn(async () => {}),
      async run(...args: any[]) {
        runs.push(args);
        await args[3]?.("sdk-session");
        return { text: "done", sessionId: "sdk-session", stopReason: "idle", usage: null, elapsedMs: 1 };
      },
    });
    const adapter = new FloeRuntimeAdapter({ runtimeFactory: () => runtime as any });
    const context = (extension_tools: ExtensionToolBinding[]) => ({
      bridge_id: "bridge:test",
      engine_account: { label: "tester", host: "https://github.com" },
      engine_tool_operation_ids: [],
      extension_tools,
      bus: {
        async getContext() { return null; },
        async listContextEvents() { return { events: [], next_cursor: null }; },
        async recordRuntimeTurnResult() { return { request_resolved: false, result_event: { event_id: "result-1" } }; },
        async appendRuntimeTelemetry() {},
      },
    }) as any;
    const delivery = (id: string) => ({
      delivery_id: id, endpoint_id: "actor:workspace:test:worker", workspace_id: "workspace:test", context_id: "context:test",
      events: [{ event_id: `event-${id}`, type: "message", context_id: "context:test", source_endpoint_id: "actor:workspace:test:operator", content: { text: "Do work" } }],
    }) as any;

    const first = binding("Add a todo");
    await adapter.handleBundle(context([first]), delivery("d1"));
    const options = runs[0]![4];
    expect(options.availableTools).toContain("todo_add");
    const tool = (options.tools as any[]).find(candidate => candidate.name === "todo_add");
    expect(tool).toMatchObject({ description: "Add a todo", skipPermission: true });
    expect(await tool.handler({ text: "ship" }, { toolCallId: "call-1" })).toMatchObject({
      textResultForLlm: "call-1:ship",
      resultType: "success",
    });
    expect(first.call).toHaveBeenCalledWith({ text: "ship" }, "call-1");

    await adapter.handleBundle(context([binding("Add a todo")]), delivery("d2"));
    expect(retire).not.toHaveBeenCalled();
    await adapter.handleBundle(context([binding("Add a todo item with a due date")]), delivery("d3"));
    expect(retire).toHaveBeenCalledWith("sdk-session");
    await adapter.handleBundle(context([]), delivery("d4"));
    expect(runs[3]![4].availableTools).not.toContain("todo_add");
  });
});
