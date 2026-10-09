/**
 * Keeps each Workspace's running Extensions in step with its install records,
 * and hands an Actor the tools of the Extensions its definition lists.
 */
import { join, relative, isAbsolute } from "node:path";

import { ExtensionHost, type ExtensionHostOptions } from "./extension-host.js";
import type { HookRegistry } from "../hooks.js";
import type { ExtensionHookName, ExtensionLoadResult, ExtensionToolResult } from "./extension-protocol.js";
import { watchTrees, type WatchedTree } from "./extension-watch.js";
import { checkInstalledExtensions, type ExtensionCheck, type ExtensionVersionSource } from "./install-records.js";

/** What the Workspace's attachment report shows for one installed Extension. */
export type ExtensionStatus =
  | Readonly<{ name: string; status: "running"; version: string; source: ExtensionVersionSource; tools: readonly string[]; hooks: readonly string[] }>
  | Readonly<{ name: string; status: "off" }>
  | Readonly<{
    name: string;
    status: "new_version";
    accepted_version: string | null;
    current_version: string;
    source: ExtensionVersionSource;
    message: string;
  }>
  | Readonly<{ name: string; status: "failed"; message: string }>;

/** One Extension tool, ready to offer to an Actor's runtime. */
export type ExtensionToolBinding = Readonly<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  call(params: Record<string, unknown>, callId: string): Promise<ExtensionToolResult>;
}>;

type WorkspaceState = {
  checks: readonly ExtensionCheck[];
  loaded: Map<string, ExtensionLoadResult>;
  stopWatching: () => void;
};

export type WorkspaceExtensionsOptions = Pick<ExtensionHostOptions, "log" | "processPath" | "restartDelaysMs"> & {
  /**
   * Pushed when statuses change without the caller asking: an install record or
   * Extension code changed on disk, or the Extension process restarted.
   */
  onStatusChanged?: (workspaceId: string, statuses: readonly ExtensionStatus[]) => void;
  /** Quiet period after the last file change before the Workspace is checked again. */
  watchDebounceMs?: number;
};

export class WorkspaceExtensions {
  private readonly host: ExtensionHost;
  private readonly workspaces = new Map<string, WorkspaceState>();
  /** Workspaces that are attached; a reconcile that finishes after stop() is discarded. */
  private readonly active = new Set<string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly options: WorkspaceExtensionsOptions;

  constructor(options: WorkspaceExtensionsOptions = {}) {
    this.options = options;
    this.host = new ExtensionHost({
      log: options.log,
      processPath: options.processPath,
      restartDelaysMs: options.restartDelaysMs,
      onReloaded: (workspaceId, results) => {
        const state = this.workspaces.get(workspaceId);
        if (!state) return;
        state.loaded = new Map(results.map(result => [result.name, result]));
        this.options.onStatusChanged?.(workspaceId, statuses(state));
      },
    });
  }

  /**
   * Reads the Workspace's install records, loads the accepted Extensions, watches
   * their records and code for changes, and returns every status.
   */
  reconcile(workspaceId: string, workspacePath: string): Promise<readonly ExtensionStatus[]> {
    this.active.add(workspaceId);
    const run = (this.queues.get(workspaceId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.reconcileNow(workspaceId, workspacePath));
    this.queues.set(workspaceId, run);
    void run.finally(() => {
      if (this.queues.get(workspaceId) === run) this.queues.delete(workspaceId);
    }).catch(() => undefined);
    return run;
  }

  private async reconcileNow(workspaceId: string, workspacePath: string): Promise<readonly ExtensionStatus[]> {
    if (!this.active.has(workspaceId)) return [];
    const checks = await checkInstalledExtensions(join(workspacePath, ".floe"));
    const ready = checks.flatMap(check => (check.state === "ready" ? [check] : []));
    let results: readonly ExtensionLoadResult[];
    try {
      results = await this.host.load(
        workspaceId,
        workspacePath,
        ready.map(check => ({ name: check.name, entry_path: check.entry_path, version: check.version })),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results = ready.map(check => ({ name: check.name, version: check.version, ok: false as const, error: message }));
    }
    if (!this.active.has(workspaceId)) {
      this.host.unload(workspaceId);
      return [];
    }
    this.workspaces.get(workspaceId)?.stopWatching();
    const state: WorkspaceState = {
      checks,
      loaded: new Map(results.map(result => [result.name, result])),
      stopWatching: watchTrees(
        watchedTrees(workspacePath, checks),
        () => this.recheck(workspaceId, workspacePath),
        this.options.watchDebounceMs,
      ),
    };
    this.workspaces.set(workspaceId, state);
    return statuses(state);
  }

  private recheck(workspaceId: string, workspacePath: string): void {
    this.reconcile(workspaceId, workspacePath).then(
      result => {
        if (this.active.has(workspaceId)) this.options.onStatusChanged?.(workspaceId, result);
      },
      error => this.options.log?.(`Extensions in Workspace ${workspaceId} could not be checked again: ${String(error)}`),
    );
  }

  stop(workspaceId: string): void {
    this.active.delete(workspaceId);
    const state = this.workspaces.get(workspaceId);
    if (!state) return;
    state.stopWatching();
    this.workspaces.delete(workspaceId);
    this.host.unload(workspaceId);
  }

  /** The tools of the running Extensions this Actor lists, in list order. Unknown or stopped names give none. */
  toolsFor(workspaceId: string, extensionNames: readonly string[] | undefined): ExtensionToolBinding[] {
    const state = this.workspaces.get(workspaceId);
    if (!state || !extensionNames?.length) return [];
    return extensionNames.flatMap(name => {
      const loaded = state.loaded.get(name);
      if (!loaded?.ok) return [];
      return loaded.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        call: (params: Record<string, unknown>, callId: string) =>
          this.host.call(workspaceId, name, tool.name.slice(name.length + 1), callId, params),
      }));
    });
  }

  /**
   * Adds the hooks of the running Extensions this Actor lists to `registry`, in
   * list order. Each handler runs in the Extension process.
   */
  addHooksFor(registry: HookRegistry, workspaceId: string, extensionNames: readonly string[] | undefined): void {
    const state = this.workspaces.get(workspaceId);
    if (!state || !extensionNames?.length) return;
    for (const name of extensionNames) {
      const loaded = state.loaded.get(name);
      if (!loaded?.ok) continue;
      for (const hook of loaded.hooks as readonly ExtensionHookName[]) {
        registry.on(hook, name, payload => this.host.hook(workspaceId, name, hook, payload as Record<string, unknown>));
      }
    }
  }

  dispose(): void {
    this.active.clear();
    for (const state of this.workspaces.values()) state.stopWatching();
    this.workspaces.clear();
    this.host.dispose();
  }
}

/** The install records folder, plus each Extension's code folder that lives outside it. */
function watchedTrees(workspacePath: string, checks: readonly ExtensionCheck[]): WatchedTree[] {
  const floeDir = join(workspacePath, ".floe");
  const recordsDir = join(floeDir, "extensions");
  const trees: WatchedTree[] = [{ dir: floeDir, matters: path => path === "extensions" || path.startsWith("extensions/") }];
  const codeDirs = new Set(
    checks.flatMap(check => (check.state === "ready" || check.state === "new_version" ? [check.code_dir] : [])),
  );
  for (const dir of codeDirs) {
    const fromRecords = relative(recordsDir, dir);
    if (fromRecords === "" || (!fromRecords.startsWith("..") && !isAbsolute(fromRecords))) continue;
    trees.push({ dir });
  }
  return trees;
}

function statuses(state: WorkspaceState): ExtensionStatus[] {
  return state.checks.map((check): ExtensionStatus => {
    switch (check.state) {
      case "off":
        return { name: check.name, status: "off" };
      case "failed":
        return { name: check.name, status: "failed", message: check.message };
      case "new_version":
        return {
          name: check.name,
          status: "new_version",
          accepted_version: check.accepted_version,
          current_version: check.current_version,
          source: check.source,
          message: `Held: an Actor must accept version ${check.current_version} (set accepted_version in installed.json) before it runs.`,
        };
      case "ready": {
        const loaded = state.loaded.get(check.name);
        if (!loaded) return { name: check.name, status: "failed", message: "the Extension process did not load it" };
        if (!loaded.ok) return { name: check.name, status: "failed", message: loaded.error };
        return {
          name: check.name,
          status: "running",
          version: check.version,
          source: check.source,
          tools: loaded.tools.map(tool => tool.name),
          hooks: loaded.hooks,
        };
      }
    }
  });
}
