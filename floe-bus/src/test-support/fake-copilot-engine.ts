/**
 * A fake Copilot engine: a scripted stand-in for the Copilot SDK client.
 *
 * Tests wrap it in a real CopilotRuntime inside the daemon's real
 * FloeRuntimeAdapter, so everything on Floe's side of a turn is real: the Bus,
 * the Bridge daemon, the adapter, the runtime's event handling, and Floe's
 * tool hook. Only the engine is scripted. It proves nothing about a real
 * engine; the release guard runs a real turn for that.
 */
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";

export const FAKE_ENGINE_ACCOUNT = { label: "fake-engine-user", host: "https://github.com" };

/** What one model call does: answer, fail, stay open until aborted, or make one tool call then answer. */
export type FakeStep = "answer" | "fail" | "hold" | { tool: string; args: Record<string, unknown> };

type Handler = (event: { type: string; data: Record<string, unknown> }) => void;
type Hook = (input: { toolName: string; toolArgs: unknown }, invocation: { sessionId: string }) =>
  Promise<{ permissionDecision: string; permissionDecisionReason?: string } | undefined>;

/** Carries out a tool call the way the engine would once Floe allowed it. */
async function runTool(tool: string, args: Record<string, any>): Promise<string> {
  if (tool === "view") return readFileSync(args.path, "utf8");
  if (tool === "create") { writeFileSync(args.path, args.file_text); return `Created ${args.path}`; }
  if (tool === "powershell") {
    return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", args.command], { encoding: "utf8" });
  }
  if (tool === "web_fetch") return await (await fetch(args.url)).text();
  throw new Error(`The fake engine cannot run '${tool}'.`);
}

export function fakeCopilotEngine() {
  const events = new EventEmitter();
  const script: FakeStep[] = [];
  const prompts: string[] = [];
  const toolResults: string[] = [];
  let offered: string[] = [];
  const sessions = new Map<string, ReturnType<typeof session>>();
  let made = 0;

  function session(sessionId: string, config: Record<string, any>) {
    const handlers = new Set<Handler>();
    let abort: (() => void) | null = null;
    const emit = (type: string, data: Record<string, unknown> = {}) => { for (const handler of [...handlers]) handler({ type, data }); };
    const usage = () => emit("assistant.usage", { model: config.model ?? "fake", inputTokens: 10, outputTokens: 5 });
    const answer = () => {
      usage();
      emit("assistant.message", { content: "done", finishReason: "stop" });
      emit("session.idle", {});
    };

    async function turn(step: FakeStep) {
      emit("assistant.turn_start", { turnId: `fake-turn-${prompts.length}` });
      if (step === "answer") return answer();
      if (step === "fail") {
        emit("model.call_failure", { message: "scripted failure" });
        emit("session.idle", {});
        return;
      }
      if (step === "hold") {
        await new Promise<void>((resolve) => { abort = resolve; events.emit("held"); });
        events.emit("aborted");
        emit("session.idle", { aborted: true });
        return;
      }
      usage();
      const toolCallId = `fake-call-${prompts.length}`;
      const decision = await (config.hooks?.onPreToolUse as Hook)({ toolName: step.tool, toolArgs: step.args }, { sessionId });
      emit("tool.execution_start", { toolCallId, toolName: step.tool, arguments: step.args });
      let result: string;
      let success = true;
      if (decision?.permissionDecision === "deny") {
        result = decision.permissionDecisionReason ?? "denied";
        success = false;
      } else {
        try { result = await runTool(step.tool, step.args); } catch (error) { result = String(error); success = false; }
      }
      toolResults.push(result);
      emit("tool.execution_complete", { toolCallId, toolName: step.tool, success });
      answer();
    }

    return {
      sessionId,
      on(handler: Handler) { handlers.add(handler); return () => handlers.delete(handler); },
      async send(options: unknown) {
        prompts.push(JSON.stringify(options));
        const step = script.shift() ?? "answer";
        events.emit("request", step);
        setImmediate(() => { void turn(step); });
      },
      async abort() { abort?.(); abort = null; },
      async disconnect() {},
      async setModel() {},
      registerHooks(hooks: unknown) { config.hooks = hooks; },
      rpc: {
        gitHubAuth: { async getStatus() {
          return { isAuthenticated: true, authType: "user", login: FAKE_ENGINE_ACCOUNT.label, host: FAKE_ENGINE_ACCOUNT.host };
        } },
        permissions: {
          async configure() {},
          async setApproveAll() {},
          async setMode() { return { success: true, mode: "manual" }; },
          async resetSessionApprovals() {},
        },
        tools: {
          async initializeAndValidate() {},
          async getCurrentMetadata() { return { tools: offered.map((name) => ({ name })) }; },
        },
        options: { async update() { return { success: true }; } },
      },
    };
  }

  const client = {
    async start() {},
    async stop() { return []; },
    async listModels() { return []; },
    async listSessions() { return [...sessions.keys()].map((sessionId) => ({ sessionId })); },
    async createSession(config: Record<string, any>) {
      offered = ((config.availableTools ?? []) as string[]).map((name) => name.replace(/^(custom|builtin):/, ""));
      const created = session(`fake-session-${++made}`, config);
      sessions.set(created.sessionId, created);
      return created;
    },
    async resumeSession(sessionId: string, config: Record<string, any>) {
      offered = ((config.availableTools ?? []) as string[]).map((name) => name.replace(/^(custom|builtin):/, ""));
      const resumed = session(sessionId, config);
      sessions.set(sessionId, resumed);
      return resumed;
    },
  };

  /** The tools the most recent session offered the model. */
  return { client, events, script, prompts, toolResults, offered: () => offered };
}

/** An engine-readiness stand-in that reports the fake engine's account as ready. */
export function readyFakeEngine() {
  const state = {
    engine: "copilot", phase: "ready", authentication: "signed_in", access: "entitled", reachability: "reachable",
    account: FAKE_ENGINE_ACCOUNT, action: null, revision: 1, checked_at: new Date().toISOString(), message: "Ready.",
  } as any;
  return Object.assign(new EventEmitter(), { currentState: () => state, check: async () => state });
}
