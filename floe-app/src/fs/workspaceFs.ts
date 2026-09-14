/**
 * Workspace filesystem bridge — the ONLY seam between the console UI and
 * direct, on-disk workspace files.
 *
 * Two backends, selected per call based on where the console is running:
 *
 *  - Tauri desktop shell: invokes Rust commands that read/write files
 *    scoped to a workspace root (the selected workspace's `locator`, e.g.
 *    `/home/justin/work` on Linux or `C:\Users\justin\work` on Windows).
 *    The Rust side validates every path stays within that root before
 *    touching disk — see `src-tauri/src/fs_commands.rs`.
 *
 *  - Plain browser (no Tauri runtime): the console is usually NOT
 *    co-located with workspace files (e.g. a Windows console tunneled into
 *    a Linux substrate), so there is no local disk to read. Instead these
 *    functions call the bus's workspace FS HTTP surface
 *    (`/v1/workspaces/:id/fs/*`) — the bus runs on the box and resolves the
 *    workspace's locator server-side, applying the same path-containment
 *    rules as the Rust validator (see floe-bus/src/fs/resolveWithinRoot.ts).
 *
 * Callers pass a `WorkspaceFsRef` (workspace_id + locator) rather than a
 * bare locator string, since the Tauri backend needs `.locator` and the bus
 * backend needs `.workspace_id`. A `WorkspaceRef` from bus-client/types.ts
 * satisfies this shape directly.
 */

/** Minimal workspace identity needed to address either FS backend. */
export type WorkspaceFsRef = {
  workspace_id: string;
  /** Host paths are absent from browser projections. */
  locator?: string;
};

/** True when running inside the Tauri desktop shell, false in a plain browser. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invokeTauri<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  // Imported dynamically so this module never fails to load in a plain
  // browser — `@tauri-apps/api` is present in node_modules either way, but
  // we still avoid touching it unless we're actually inside Tauri.
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

// ---------------------------------------------------------------------------
// FS capability (for gating file-editing UI)
// ---------------------------------------------------------------------------

let cachedBusCapability: Promise<boolean> | null = null;

/**
 * Whether file-editing is available at all — either the Tauri desktop shell
 * (always available there) or the bus reports `workspace_access.local_paths`
 * enabled (probed once and cached for the session).
 */
export async function fileAccessAvailable(): Promise<boolean> {
  if (isTauri()) return true;
  if (!cachedBusCapability) {
    cachedBusCapability = import("../bus-client/client.ts")
      .then(({ busFsCapability }) => busFsCapability())
      .then((cap) => cap.local_paths)
      .catch(() => false);
  }
  return cachedBusCapability;
}

/** Test-only: clear the cached bus capability probe. */
export function resetFileAccessAvailableCacheForTests(): void {
  cachedBusCapability = null;
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

/**
 * List `.floe/agents/**\/*.md` files for `workspace`, as relative
 * (forward-slash) path strings, e.g. `.floe/agents/floe.md`.
 */
export async function listAgentFiles(workspace: WorkspaceFsRef): Promise<string[]> {
  if (isTauri()) {
    if (!workspace.locator) throw new Error("This workspace has no local folder binding.");
    return invokeTauri<string[]>("list_agent_files", { workspaceRoot: workspace.locator });
  }
  const { busListAgentFiles } = await import("../bus-client/client.ts");
  return busListAgentFiles(workspace.workspace_id);
}

/** Read a UTF-8 text file at `relPath` under `workspace`. */
export async function readWorkspaceFile(
  workspace: WorkspaceFsRef,
  relPath: string
): Promise<string> {
  if (isTauri()) {
    if (!workspace.locator) throw new Error("This workspace has no local folder binding.");
    return invokeTauri<string>("read_file", { workspaceRoot: workspace.locator, relPath });
  }
  const { busReadFile } = await import("../bus-client/client.ts");
  return busReadFile(workspace.workspace_id, relPath);
}

/** Resolve a workspace-contained raster image for an <img> preview. */
export async function workspaceMediaSource(
  workspace: WorkspaceFsRef,
  relPath: string,
): Promise<string> {
  const { busWorkspaceMediaSource } = await import("../bus-client/client.ts");
  return busWorkspaceMediaSource(workspace.workspace_id, relPath);
}

/**
 * Write `contents` to `relPath` under `workspace`, creating parent
 * directories as needed.
 */
export async function writeWorkspaceFile(
  workspace: WorkspaceFsRef,
  relPath: string,
  contents: string
): Promise<void> {
  if (isTauri()) {
    if (!workspace.locator) throw new Error("This workspace has no local folder binding.");
    await invokeTauri<void>("write_file", { workspaceRoot: workspace.locator, relPath, contents });
    return;
  }
  const { busWriteFile } = await import("../bus-client/client.ts");
  await busWriteFile(workspace.workspace_id, relPath, contents);
}
