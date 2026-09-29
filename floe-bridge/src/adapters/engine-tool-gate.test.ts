import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopilotRuntime } from "floe-runtime/adapters/copilot";
import { EngineToolGate, toolCallFacts, workspaceRelativePath } from "./engine-tool-gate.js";
import { FloeRuntimeAdapter, grantedBuiltinTools } from "./floe-runtime-adapter.js";

const DIGEST = "b".repeat(64);
let root: string;
let workspace: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "floe-tool-gate-"));
  workspace = path.join(root, "workspace");
  mkdirSync(path.join(workspace, "src"), { recursive: true });
  mkdirSync(path.join(root, "outside"));
  writeFileSync(path.join(workspace, "src", "a.ts"), "");
  symlinkSync(path.join(root, "outside"), path.join(workspace, "escape"), "junction");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function permission(kind: string, facts: Record<string, unknown>, operationId: string | null = "engine.tool.filesystem.read") {
  return {
    runtime: "copilot", sessionId: "sdk-session", id: "call-1", title: "view", kind, options: [], raw: {},
    operationId, nativeToolCandidates: ["view"], manifestVersion: "manifest-1",
    facts: { paths: [], urls: [], requestSandboxBypass: false, argumentDigest: DIGEST, ...facts },
  } as any;
}

function decision(overrides: Record<string, unknown>) {
  return { evaluation_id: "eval-1", decision: "allow", refusal: null, approval_request_ids: [], approval_expires_at: null, ...overrides };
}

describe("engine tool facts", () => {
  it("resolves paths inside the Workspace and refuses escapes, including through links", () => {
    expect(workspaceRelativePath(workspace, "src/a.ts")).toBe("src/a.ts");
    expect(workspaceRelativePath(workspace, path.join(workspace, "src", "new.ts"))).toBe("src/new.ts");
    expect(workspaceRelativePath(workspace, ".")).toBe(".");
    expect(workspaceRelativePath(workspace, "../outside")).toBeNull();
    expect(workspaceRelativePath(workspace, "escape/secret.txt")).toBeNull();
    expect(workspaceRelativePath(null, "src/a.ts")).toBeNull();
  });

  it("reports unclassified shell segments and redirect origins instead of dropping them", () => {
    const facts = toolCallFacts(permission("shell", {
      paths: ["src/a.ts"],
      urls: ["https://example.com/a"],
      commandSegments: [{ identifier: "git" }, { identifier: "" }],
      hasWriteFileRedirection: true,
      requestSandboxBypass: true,
    }, "engine.tool.process.execute"), workspace);
    expect(facts).toMatchObject({
      operation_id: "engine.tool.process.execute", tool_call_id: "call-1", engine: "copilot",
      paths: ["src/a.ts"], executables: ["git", null], urls: ["https://example.com/a"],
      write_redirection: true, sandbox_bypass: true, argument_digest: DIGEST,
    });
    expect(toolCallFacts(permission("url", { urls: ["https://b.example"], redirectedFrom: "https://a.example" }), workspace).urls)
      .toEqual(["https://b.example", "https://a.example"]);
  });

  it("offers only the pinned built-ins that granted operations cover", () => {
    expect(grantedBuiltinTools([], "win32")).toEqual([]);
    expect(grantedBuiltinTools(["engine.tool.filesystem.read"], "win32")).toEqual(["builtin:glob", "builtin:grep", "builtin:view"]);
    expect(grantedBuiltinTools(["engine.tool.filesystem.write"], "win32")).toEqual([]);
    expect(grantedBuiltinTools(["engine.tool.filesystem.read"], "linux")).toEqual([]);
  });
});

describe("EngineToolGate", () => {
  function bus(evaluation: Record<string, unknown>) {
    return {
      evaluateRuntimeToolCall: vi.fn(async () => decision(evaluation)),
      resolveRuntimeToolApproval: vi.fn(async (): Promise<any> => ({ outcome: "pending", refusal: null })),
    };
  }
  const request = () => permission("read", { paths: ["src/a.ts"] });

  it("allows once or refuses with the Bus's reason", async () => {
    const gate = new EngineToolGate();
    const allowed = bus({});
    expect(await gate.decide({ bus: allowed as any, deliveryId: "d1", workspaceLocator: workspace, request: request() })).toBe("allow_once");
    const denied = bus({ decision: "deny", refusal: { code: "tool_policy_denied", rule_id: "tool_path_outside_scope", reason: "outside" } });
    expect(await gate.decide({ bus: denied as any, deliveryId: "d1", workspaceLocator: workspace, request: request() })).toEqual({
      decision: "reject_once", refusal: { code: "tool_policy_denied", rule_id: "tool_path_outside_scope", reason: "outside" },
    });
    expect(denied.resolveRuntimeToolApproval).not.toHaveBeenCalled();
  });

  it("waits for the pushed answer, reading the current answer once first", async () => {
    const gate = new EngineToolGate();
    const b = bus({ decision: "require_approval", approval_request_ids: ["req-1"], approval_expires_at: new Date(Date.now() + 60_000).toISOString() });
    const pending = gate.decide({ bus: b as any, deliveryId: "d1", workspaceLocator: workspace, request: request() });
    await vi.waitFor(() => expect(b.resolveRuntimeToolApproval).toHaveBeenCalledTimes(1));
    gate.approvalChanged("req-other");
    b.resolveRuntimeToolApproval.mockResolvedValueOnce({ outcome: "allowed", refusal: null });
    gate.approvalChanged("req-1");
    expect(await pending).toBe("allow_once");
    expect(b.resolveRuntimeToolApproval.mock.calls).toEqual([["d1", "eval-1", null], ["d1", "eval-1", null]]);
    gate.approvalChanged("req-1");
    expect(b.resolveRuntimeToolApproval).toHaveBeenCalledTimes(2);
  });

  it("answers a waiting call when its Delivery stops or its authority expires", async () => {
    const gate = new EngineToolGate();
    const b = bus({ decision: "require_approval", approval_request_ids: ["req-1"], approval_expires_at: new Date(Date.now() + 60_000).toISOString() });
    const pending = gate.decide({ bus: b as any, deliveryId: "d1", workspaceLocator: workspace, request: request() });
    await vi.waitFor(() => expect(b.resolveRuntimeToolApproval).toHaveBeenCalledTimes(1));
    b.resolveRuntimeToolApproval.mockResolvedValueOnce({ outcome: "cancelled", refusal: { rule_id: "approval.cancelled", reason: "stopped" } });
    gate.abandonDelivery("d1");
    expect(await pending).toEqual({ decision: "cancel", refusal: { code: "tool_policy_cancelled", rule_id: "approval.cancelled", reason: "stopped" } });
    expect(b.resolveRuntimeToolApproval).toHaveBeenLastCalledWith("d1", "eval-1", "cancelled");

    const expiring = bus({ decision: "require_approval", approval_request_ids: ["req-2"], approval_expires_at: new Date(Date.now() + 20).toISOString() });
    expiring.resolveRuntimeToolApproval
      .mockResolvedValueOnce({ outcome: "pending", refusal: null })
      .mockResolvedValueOnce({ outcome: "unavailable", refusal: { rule_id: "approval.unavailable", reason: "expired" } });
    const late = await gate.decide({ bus: expiring as any, deliveryId: "d2", workspaceLocator: workspace, request: request() });
    expect(late).toMatchObject({ decision: "reject_once", refusal: { rule_id: "approval.unavailable" } });
    expect(expiring.resolveRuntimeToolApproval).toHaveBeenLastCalledWith("d2", "eval-1", "unavailable");
  });
});

describe("FloeRuntimeAdapter engine tools", () => {
  it.runIf(process.platform === "win32")("resumes the engine session under a changed tool list instead of drifting", async () => {
    const runs: any[] = [];
    const retire = vi.fn(async () => ({ status: "retiredLocally" }));
    const runtime = Object.assign(new (await import("node:events")).EventEmitter(), {
      retire,
      close: vi.fn(async () => {}),
      async run(...args: any[]) {
        runs.push(args);
        await args[3]?.("sdk-session");
        return { text: "done", sessionId: "sdk-session", stopReason: "idle", usage: null, elapsedMs: 1 };
      },
    });
    const adapter = new FloeRuntimeAdapter({ runtimeFactory: () => runtime as any });
    const ctx = (ops: string[]) => ({
      bridge_id: "bridge:test", engine_tool_operation_ids: ops,
      bus: {
        async getContext() { return null; },
        async recordRuntimeTurnResult() { return { request_resolved: false, result_event: { event_id: "result-1" } }; },
        async appendRuntimeTelemetry() {},
      },
    }) as any;
    const delivery = (id: string) => ({
      delivery_id: id, endpoint_id: "actor:workspace:test:worker", workspace_id: "workspace:test",
      context_id: "context:test", events: [{ event_id: `event-${id}`, type: "message", context_id: "context:test", source_endpoint_id: "actor:workspace:test:operator", content: { text: "Do work" } }],
    }) as any;

    await adapter.handleBundle(ctx([]), delivery("d1"));
    await adapter.handleBundle(ctx([]), delivery("d2"));
    expect(retire).not.toHaveBeenCalled();
    await adapter.handleBundle(ctx(["engine.tool.filesystem.read"]), delivery("d3"));
    expect(retire).toHaveBeenCalledWith("sdk-session");
    expect(runs[2][4].availableTools).toEqual(expect.arrayContaining(["builtin:view", "builtin:grep", "builtin:glob"]));
    expect(runs[2][5]).toMatchObject({ sessionId: "sdk-session" });
  });

  it("offers granted built-ins and sends every permission request to the Bus before it runs", async () => {
    let createdConfig: Record<string, any> | undefined;
    let permissionResult: unknown;
    const session = {
      sessionId: "sdk-session",
      on(handler: (event: unknown) => void) {
        queueMicrotask(async () => {
          permissionResult = await createdConfig!.onPermissionRequest(
            { kind: "read", path: path.join(workspace, "src", "a.ts"), toolCallId: "call-7" },
            { sessionId: "sdk-session" },
          );
          handler({ type: "assistant.message", data: { content: "done", finishReason: "end_turn" } });
          handler({ type: "session.idle", data: {} });
        });
        return () => {};
      },
      async send() {},
      async disconnect() {},
      rpc: {
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
    const evaluate = vi.fn(async () => decision({ decision: "deny", refusal: { code: "tool_policy_denied", rule_id: "tool_grant_missing", reason: "no grant" } }));
    const adapter = new FloeRuntimeAdapter({
      runtimeFactory: (options) => new CopilotRuntime({ ...options, client: client as any }),
    });
    await adapter.handleBundle({
      bridge_id: "bridge:test",
      workspace_locator: workspace,
      engine_tool_operation_ids: ["engine.tool.filesystem.read"],
      bus: {
        async getContext() { return null; },
        async recordRuntimeTurnResult() { return { request_resolved: false, result_event: { event_id: "result-1" } }; },
        async appendRuntimeTelemetry() {},
        evaluateRuntimeToolCall: evaluate,
      },
    } as any, {
      delivery_id: "delivery-1", endpoint_id: "actor:workspace:test:worker", workspace_id: "workspace:test",
      context_id: "context:test", events: [{ event_id: "event-1", type: "message", context_id: "context:test", source_endpoint_id: "actor:workspace:test:operator", content: { text: "Do work" } }],
    } as any);

    expect(createdConfig!.availableTools).toEqual(expect.arrayContaining(grantedBuiltinTools(["engine.tool.filesystem.read"])));
    if (process.platform !== "win32") return;
    expect(evaluate).toHaveBeenCalledWith("delivery-1", expect.objectContaining({
      operation_id: "engine.tool.filesystem.read", tool_call_id: "call-7", paths: ["src/a.ts"],
    }));
    expect(permissionResult).toMatchObject({ kind: "reject" });
    expect(JSON.parse((permissionResult as { feedback: string }).feedback)).toMatchObject({ rule_id: "tool_grant_missing", reason: "no grant" });
  });
});
