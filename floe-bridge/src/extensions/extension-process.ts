/**
 * The Extension process: runs every enabled Extension's code, apart from the
 * Bus and Bridge, so a crash or hang here cannot take Floe down.
 *
 * Started by the Bridge with an IPC channel. This file must stay runnable
 * without a build step: only Node built-ins and `import type`.
 */
import { pathToFileURL } from "node:url";

import type {
  BridgeToExtensionProcess,
  ExtensionHookName,
  ExtensionHookResult,
  ExtensionLoadResult,
  ExtensionProcessToBridge,
  ExtensionToLoad,
  ExtensionToolResult,
  ExtensionToolSpec,
} from "./extension-protocol.js";

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const HOOK_NAMES: ReadonlySet<ExtensionHookName> = new Set<ExtensionHookName>(["SessionStart", "BeforeTurn", "TurnEnd", "BeforeToolUse", "Error"]);
/** A handler that has not settled by then is logged and skipped, so a hung hook cannot hold a turn forever. */
const HOOK_TIMEOUT_MS = 30_000;

type LoadedTool = { spec: ExtensionToolSpec; execute: (callId: string, params: Record<string, unknown>) => unknown };
type LoadedExtension = { tools: Map<string, LoadedTool>; hooks: Map<string, Array<(payload: Record<string, unknown>) => unknown>> };

/** Workspace id → Extension name → loaded Extension. */
const workspaces = new Map<string, Map<string, LoadedExtension>>();

function send(message: ExtensionProcessToBridge): void {
  process.send?.(message);
}

async function loadOne(workspaceId: string, workspacePath: string, extension: ExtensionToLoad): Promise<
  { result: ExtensionLoadResult; loaded?: LoadedExtension }
> {
  const { name, version } = extension;
  try {
    const module = await import(pathToFileURL(extension.entry_path).href) as { default?: unknown };
    if (typeof module.default !== "function") {
      throw new Error("entry must default-export a function that returns the Extension's tools");
    }
    const hooks = new Map<string, Array<(payload: Record<string, unknown>) => unknown>>();
    const context = {
      workspacePath,
      workspaceId,
      extensionName: name,
      hooks: {
        on(hook: string, handler: (payload: Record<string, unknown>) => unknown): void {
          if (typeof hook !== "string" || typeof handler !== "function") {
            throw new Error("hooks.on needs a hook name and a handler function");
          }
          if (!HOOK_NAMES.has(hook as ExtensionHookName)) {
            throw new Error(`hook '${hook}' is not offered; use one of ${[...HOOK_NAMES].join(", ")}`);
          }
          hooks.set(hook, [...(hooks.get(hook) ?? []), handler]);
        },
      },
    };
    const returned = await (module.default as (ctx: typeof context) => unknown)(context);
    if (!Array.isArray(returned)) throw new Error("entry function must return a list of tools");
    const tools = new Map<string, LoadedTool>();
    returned.forEach((tool: unknown, index: number) => {
      const spec = toolSpec(name, tool, index);
      if (tools.has(spec.name)) throw new Error(`tool '${spec.name}' is defined twice`);
      tools.set(spec.name, { spec, execute: (tool as { execute: LoadedTool["execute"] }).execute.bind(tool) });
    });
    return {
      result: { name, version, ok: true, tools: [...tools.values()].map(tool => tool.spec), hooks: [...hooks.keys()].sort() },
      loaded: { tools, hooks },
    };
  } catch (error) {
    return { result: { name, version, ok: false, error: message(error) } };
  }
}

function toolSpec(extension: string, tool: unknown, index: number): ExtensionToolSpec {
  if (tool === null || typeof tool !== "object") throw new Error(`tool ${index} must be an object`);
  const candidate = tool as Record<string, unknown>;
  const label = typeof candidate.name === "string" ? candidate.name : `tool ${index}`;
  if (typeof candidate.name !== "string" || !TOOL_NAME.test(`${extension}_${candidate.name}`)) {
    throw new Error(`${label}: name must use letters, digits, '_' or '-' (64 characters at most with the Extension name)`);
  }
  if (typeof candidate.description !== "string" || candidate.description.trim() === "") {
    throw new Error(`${label}: description is required`);
  }
  if (candidate.parameters === null || typeof candidate.parameters !== "object" || Array.isArray(candidate.parameters)) {
    throw new Error(`${label}: parameters must be a JSON Schema object`);
  }
  if (typeof candidate.execute !== "function") throw new Error(`${label}: execute must be a function`);
  return {
    name: `${extension}_${candidate.name}`,
    ...(typeof candidate.label === "string" ? { label: candidate.label } : {}),
    description: candidate.description,
    parameters: JSON.parse(JSON.stringify(candidate.parameters)) as Record<string, unknown>,
  };
}

function toolResult(value: unknown): ExtensionToolResult {
  const candidate = value as { content?: unknown; details?: unknown } | null;
  const content = candidate?.content;
  if (!Array.isArray(content) || !content.every(part => part && part.type === "text" && typeof part.text === "string")) {
    throw new Error("tool must return { content: [{ type: 'text', text }], details }");
  }
  return JSON.parse(JSON.stringify({
    content,
    ...(candidate?.details && typeof candidate.details === "object" ? { details: candidate.details } : {}),
  })) as ExtensionToolResult;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type HookHandler = (payload: Record<string, unknown>) => unknown;

async function settle(handler: HookHandler, payload: Record<string, unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => handler(payload)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`did not finish within ${HOOK_TIMEOUT_MS / 1000}s`)), HOOK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs one Extension's BeforeToolUse handlers in order. Each sees the input as
 * changed by the one before. The first block ends the check; a handler that
 * fails or answers something unknown blocks the call.
 */
async function checkToolUse(extension: string, handlers: readonly HookHandler[], payload: Record<string, unknown>): Promise<ExtensionHookResult[]> {
  let current = payload;
  let changed = false;
  for (const handler of handlers) {
    let value: unknown;
    try {
      value = await settle(handler, current);
    } catch (error) {
      return [{ decision: "block", reason: `${extension}'s BeforeToolUse check failed: ${message(error)}` }];
    }
    const answer = value as { decision?: unknown; reason?: unknown; args?: unknown } | null | undefined;
    if (answer === undefined || answer === null || answer.decision === "allow") continue;
    if (answer.decision === "block") {
      return [{ decision: "block", reason: typeof answer.reason === "string" && answer.reason.trim() ? answer.reason : `${extension} blocked this tool call` }];
    }
    if (answer.decision === "change" && "args" in answer) {
      current = { ...current, args: JSON.parse(JSON.stringify(answer.args ?? null)) as unknown };
      changed = true;
      continue;
    }
    return [{ decision: "block", reason: `${extension}'s BeforeToolUse check answered something other than allow, block or change` }];
  }
  return changed ? [{ decision: "change", args: current.args }] : [];
}

async function runHook(extension: string, hook: string, handlers: readonly HookHandler[], payload: Record<string, unknown>): Promise<ExtensionHookResult[]> {
  if (hook === "BeforeToolUse") return checkToolUse(extension, handlers, payload);
  const results: ExtensionHookResult[] = [];
  for (const handler of handlers) {
    try {
      const value = await settle(handler, payload);
      const inject = (value as { inject?: unknown } | null | undefined)?.inject;
      if (inject && typeof inject === "object" && !Array.isArray(inject)) {
        results.push({ inject: JSON.parse(JSON.stringify(inject)) as Record<string, unknown> });
      }
    } catch (error) {
      console.error(`[extension:${extension}] ${hook} hook failed: ${message(error)}`);
    }
  }
  return results;
}

async function handle(request: BridgeToExtensionProcess): Promise<void> {
  if (request.type === "load") {
    const outcomes = await Promise.all(
      request.extensions.map(extension => loadOne(request.workspace_id, request.workspace_path, extension)),
    );
    const loaded = new Map<string, LoadedExtension>();
    outcomes.forEach((outcome, index) => {
      if (outcome.loaded) loaded.set(request.extensions[index]!.name, outcome.loaded);
    });
    workspaces.set(request.workspace_id, loaded);
    send({
      type: "loaded",
      request_id: request.request_id,
      workspace_id: request.workspace_id,
      results: outcomes.map(outcome => outcome.result),
    });
    return;
  }
  if (request.type === "unload") {
    workspaces.delete(request.workspace_id);
    return;
  }
  if (request.type === "hook") {
    const handlers = workspaces.get(request.workspace_id)?.get(request.extension)?.hooks.get(request.hook) ?? [];
    const results = await runHook(request.extension, request.hook, handlers, request.payload);
    send({ type: "hook_result", request_id: request.request_id, results });
    return;
  }
  const tool = workspaces.get(request.workspace_id)?.get(request.extension)?.tools.get(`${request.extension}_${request.tool}`);
  if (!tool) {
    send({ type: "result", request_id: request.request_id, ok: false, error: `tool '${request.extension}_${request.tool}' is not loaded` });
    return;
  }
  try {
    const value = toolResult(await tool.execute(request.call_id, request.params));
    send({ type: "result", request_id: request.request_id, ok: true, value });
  } catch (error) {
    send({ type: "result", request_id: request.request_id, ok: false, error: message(error) });
  }
}

process.on("message", request => {
  void handle(request as BridgeToExtensionProcess);
});
process.on("disconnect", () => process.exit(0));
