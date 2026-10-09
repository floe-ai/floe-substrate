/**
 * Messages between the Bridge and its Extension process (Node IPC, JSON).
 *
 * Types only: the Extension process imports this file with `import type`, so
 * it runs without a build step.
 */

export type ExtensionToolSpec = Readonly<{
  /** Full tool name offered to Actors: `EXTENSION_TOOL`. */
  name: string;
  label?: string;
  description: string;
  /** JSON Schema for the tool's input. */
  parameters: Record<string, unknown>;
}>;

export type ExtensionToolResult = Readonly<{
  content: ReadonlyArray<Readonly<{ type: "text"; text: string }>>;
  details?: Record<string, unknown>;
}>;

/** The points an Extension can step in at. Anything that only reacts afterwards is an Event, not a hook. */
export type ExtensionHookName = "SessionStart" | "BeforeTurn" | "TurnEnd" | "Error";

/** What one hook handler returned: text to add to the turn, or nothing. */
export type ExtensionHookResult = Readonly<{ inject: Record<string, unknown> }>;

export type ExtensionToLoad = Readonly<{ name: string; entry_path: string; version: string }>;

export type ExtensionLoadResult =
  | Readonly<{ name: string; version: string; ok: true; tools: readonly ExtensionToolSpec[]; hooks: readonly string[] }>
  | Readonly<{ name: string; version: string; ok: false; error: string }>;

export type BridgeToExtensionProcess =
  | Readonly<{
    type: "load";
    request_id: number;
    workspace_id: string;
    workspace_path: string;
    extensions: readonly ExtensionToLoad[];
  }>
  | Readonly<{ type: "unload"; workspace_id: string }>
  | Readonly<{
    type: "call";
    request_id: number;
    workspace_id: string;
    extension: string;
    /** The tool's own name, without the Extension prefix. */
    tool: string;
    call_id: string;
    params: Record<string, unknown>;
  }>
  | Readonly<{
    type: "hook";
    request_id: number;
    workspace_id: string;
    extension: string;
    hook: ExtensionHookName;
    payload: Record<string, unknown>;
  }>;

export type ExtensionProcessToBridge =
  | Readonly<{ type: "loaded"; request_id: number; workspace_id: string; results: readonly ExtensionLoadResult[] }>
  | Readonly<{ type: "result"; request_id: number; ok: true; value: ExtensionToolResult }>
  | Readonly<{ type: "result"; request_id: number; ok: false; error: string }>
  | Readonly<{ type: "hook_result"; request_id: number; results: readonly ExtensionHookResult[] }>;
