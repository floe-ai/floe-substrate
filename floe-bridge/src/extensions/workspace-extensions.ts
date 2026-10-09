/**
 * Keeps each Workspace's running Extensions in step with its install records,
 * and hands an Actor the tools of the Extensions its definition lists.
 */
import { join } from "node:path";

import { ExtensionHost, type ExtensionHostOptions } from "./extension-host.js";
import type { ExtensionLoadResult, ExtensionToolResult } from "./extension-protocol.js";
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

type WorkspaceState = { checks: readonly ExtensionCheck[]; loaded: Map<string, ExtensionLoadResult> };

export type WorkspaceExtensionsOptions = Pick<ExtensionHostOptions, "log" | "processPath" | "restartDelaysMs"> & {
  /** Pushed when statuses change without a reconcile, such as after the Extension process restarts. */
  onStatusChanged?: (workspaceId: string, statuses: readonly ExtensionStatus[]) => void;
};

export class WorkspaceExtensions {
  private readonly host: ExtensionHost;
  private readonly workspaces = new Map<string, WorkspaceState>();
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

  /** Reads the Workspace's install records, loads the accepted Extensions and returns every status. */
  async reconcile(workspaceId: string, workspacePath: string): Promise<readonly ExtensionStatus[]> {
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
    const state = { checks, loaded: new Map(results.map(result => [result.name, result])) };
    this.workspaces.set(workspaceId, state);
    return statuses(state);
  }

  stop(workspaceId: string): void {
    if (!this.workspaces.delete(workspaceId)) return;
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

  dispose(): void {
    this.workspaces.clear();
    this.host.dispose();
  }
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
