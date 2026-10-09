/**
 * The Bridge's side of the Extension process: starts it, loads each
 * Workspace's accepted Extensions into it, calls their tools, and restarts it
 * after a crash. Restart delays are timers, not polling.
 */
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type {
  BridgeToExtensionProcess,
  ExtensionLoadResult,
  ExtensionProcessToBridge,
  ExtensionHookName,
  ExtensionHookResult,
  ExtensionToLoad,
  ExtensionToolResult,
} from "./extension-protocol.js";

const RESTART_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const STABLE_AFTER_MS = 60_000;

export type ExtensionHostOptions = {
  /** Pushed whenever a Workspace's Extensions are loaded again after a restart. */
  onReloaded?: (workspaceId: string, results: readonly ExtensionLoadResult[]) => void;
  log?: (message: string) => void;
  /** Overridable for tests. */
  restartDelaysMs?: readonly number[];
  processPath?: string;
};

type Pending = { resolve: (message: ExtensionProcessToBridge) => void; reject: (error: Error) => void };
type WorkspaceLoad = { workspace_path: string; extensions: readonly ExtensionToLoad[] };

export class ExtensionProcessError extends Error {}

export class ExtensionHost {
  private child: ChildProcess | null = null;
  private startedAt = 0;
  private restartAttempt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private nextRequestId = 1;
  private disposed = false;
  private readonly pending = new Map<number, Pending>();
  private readonly workspaces = new Map<string, WorkspaceLoad>();
  /** Entry path → version imported by the running process. Node cannot unload a module, so a new version needs a fresh process. */
  private readonly imported = new Map<string, string>();
  private readonly loadQueues = new Map<string, Promise<unknown>>();
  private readonly options: ExtensionHostOptions;
  private readonly restartDelays: readonly number[];
  private readonly processPath: string;

  constructor(options: ExtensionHostOptions = {}) {
    this.options = options;
    this.restartDelays = options.restartDelaysMs ?? RESTART_DELAYS_MS;
    this.processPath = options.processPath ?? defaultProcessPath();
  }

  /** Replaces a Workspace's loaded Extensions with this set and returns what each one offers. */
  load(workspaceId: string, workspacePath: string, extensions: readonly ExtensionToLoad[]): Promise<readonly ExtensionLoadResult[]> {
    const previous = this.loadQueues.get(workspaceId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.loadNow(workspaceId, { workspace_path: workspacePath, extensions }));
    this.loadQueues.set(workspaceId, next);
    return next;
  }

  unload(workspaceId: string): void {
    this.workspaces.delete(workspaceId);
    if (this.child?.connected) this.send({ type: "unload", workspace_id: workspaceId });
  }

  /** Calls one tool. `tool` is the tool's own name, without the Extension prefix. */
  async call(
    workspaceId: string,
    extension: string,
    tool: string,
    callId: string,
    params: Record<string, unknown>,
  ): Promise<ExtensionToolResult> {
    const child = this.child;
    if (!child?.connected) throw new ExtensionProcessError("the Extension process is restarting; try again shortly");
    const reply = await this.request(id => ({
      type: "call", request_id: id, workspace_id: workspaceId, extension, tool, call_id: callId, params,
    }));
    if (reply.type !== "result") throw new ExtensionProcessError("unexpected reply from the Extension process");
    if (!reply.ok) throw new ExtensionProcessError(reply.error);
    return reply.value;
  }

  /**
   * Runs one Extension's handlers for a hook. While the process is restarting
   * the hook is skipped and logged, except BeforeToolUse: a check that cannot
   * run throws, so the tool call is blocked.
   */
  async hook(
    workspaceId: string,
    extension: string,
    hook: ExtensionHookName,
    payload: Record<string, unknown>,
  ): Promise<readonly ExtensionHookResult[]> {
    if (!this.child?.connected) {
      if (hook === "BeforeToolUse") throw new ExtensionProcessError(`${extension}'s BeforeToolUse check cannot run: the Extension process is restarting`);
      this.options.log?.(`Skipped ${extension}'s ${hook} hook: the Extension process is restarting`);
      return [];
    }
    const reply = await this.request(id => ({
      type: "hook", request_id: id, workspace_id: workspaceId, extension, hook, payload,
    }));
    if (reply.type !== "hook_result") throw new ExtensionProcessError("unexpected reply from the Extension process");
    return reply.results;
  }

  dispose(): void {
    this.disposed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.workspaces.clear();
    this.stop("Floe is shutting down");
  }

  private async loadNow(workspaceId: string, load: WorkspaceLoad): Promise<readonly ExtensionLoadResult[]> {
    if (this.disposed) throw new ExtensionProcessError("the Extension host is closed");
    if (load.extensions.length === 0) {
      this.unload(workspaceId);
      return [];
    }
    this.workspaces.set(workspaceId, load);
    const needsFreshProcess = load.extensions.some(extension => {
      const imported = this.imported.get(extension.entry_path);
      return imported !== undefined && imported !== extension.version;
    });
    if (needsFreshProcess) {
      this.options.log?.("[extensions] restarting the Extension process to load a new version");
      this.stop("the Extension process restarted to load a new version");
      this.start();
      const results = await this.reloadAll();
      for (const [otherId, otherResults] of results) {
        if (otherId !== workspaceId) this.options.onReloaded?.(otherId, otherResults);
      }
      return results.get(workspaceId) ?? [];
    }
    if (!this.child) this.start();
    return this.sendLoad(workspaceId, load);
  }

  private async sendLoad(workspaceId: string, load: WorkspaceLoad): Promise<readonly ExtensionLoadResult[]> {
    const reply = await this.request(id => ({
      type: "load", request_id: id, workspace_id: workspaceId, workspace_path: load.workspace_path, extensions: load.extensions,
    }));
    if (reply.type !== "loaded") throw new ExtensionProcessError("unexpected reply from the Extension process");
    for (const extension of load.extensions) this.imported.set(extension.entry_path, extension.version);
    return reply.results;
  }

  /** Loads every Workspace's current set into a fresh process. */
  private async reloadAll(): Promise<Map<string, readonly ExtensionLoadResult[]>> {
    const results = new Map<string, readonly ExtensionLoadResult[]>();
    await Promise.all([...this.workspaces].map(async ([workspaceId, load]) => {
      try {
        results.set(workspaceId, await this.sendLoad(workspaceId, load));
      } catch (error) {
        results.set(workspaceId, load.extensions.map(extension => ({
          name: extension.name, version: extension.version, ok: false as const, error: errorMessage(error),
        })));
      }
    }));
    return results;
  }

  private start(): void {
    const child = fork(this.processPath, [], {
      execArgv: [],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    this.child = child;
    this.startedAt = Date.now();
    child.on("message", message => this.receive(message as ExtensionProcessToBridge));
    child.on("exit", (code, signal) => this.exited(child, code, signal));
    child.on("error", error => this.options.log?.(`[extensions] Extension process error: ${error.message}`));
  }

  private stop(reason: string): void {
    const child = this.child;
    this.child = null;
    this.imported.clear();
    this.rejectPending(reason);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.removeAllListeners("exit");
      child.kill();
    }
  }

  private exited(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (child !== this.child) return;
    this.child = null;
    this.imported.clear();
    this.rejectPending("the Extension process stopped unexpectedly");
    if (this.disposed) return;
    if (Date.now() - this.startedAt >= STABLE_AFTER_MS) this.restartAttempt = 0;
    const delay = this.restartDelays[Math.min(this.restartAttempt, this.restartDelays.length - 1)]!;
    this.restartAttempt += 1;
    this.options.log?.(
      `[extensions] Extension process stopped (${signal ?? `exit ${code}`}); restarting in ${Math.round(delay / 1000)}s`,
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.disposed || this.child || this.workspaces.size === 0) return;
      this.start();
      void this.reloadAll().then(results => {
        for (const [workspaceId, workspaceResults] of results) this.options.onReloaded?.(workspaceId, workspaceResults);
      });
    }, delay);
  }

  private request(build: (id: number) => BridgeToExtensionProcess): Promise<ExtensionProcessToBridge> {
    const child = this.child;
    if (!child?.connected) return Promise.reject(new ExtensionProcessError("the Extension process is not running"));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(build(id));
    });
  }

  private send(message: BridgeToExtensionProcess): void {
    this.child?.send(message);
  }

  private receive(message: ExtensionProcessToBridge): void {
    const pending = this.pending.get(message.request_id);
    if (!pending) return;
    this.pending.delete(message.request_id);
    pending.resolve(message);
  }

  private rejectPending(reason: string): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const { reject } of pending) reject(new ExtensionProcessError(reason));
  }
}

function defaultProcessPath(): string {
  const here = fileURLToPath(import.meta.url);
  return here.replace(/extension-host\.(ts|js)$/, "extension-process.$1");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
