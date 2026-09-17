# Extension Substrate — Slice PRD

## Problem Statement

Floe agents currently have a fixed set of built-in tools (emit, list_endpoints, resolve_destination, pulse, actor, workspace tools). There is no mechanism for workspace authors to add new tools, capabilities, or scheduled behaviours without modifying the bridge source code. The extension directory (`.floe/extensions/`) and the agent frontmatter `extensions: []` field exist as scaffolding but are completely non-functional.

## Solution

Implement the extension substrate: a discovery, loading, and injection system that lets workspace authors create extensions as TypeScript modules in `.floe/extensions/NAME/`. Each extension declares a JSON manifest and exports a factory function that returns agent tools. The bridge discovers extensions at workspace attach time, loads them, auto-prefixes tool names, and injects them into agent sessions based on each agent's `extensions: [...]` frontmatter declaration. Extensions may also declare pulse schedules that are registered as normal pulses.

## User Stories

1. As a workspace author, I want to create a new extension by adding a directory under `.floe/extensions/` with an `extension.json` manifest and an `index.ts` entry point, so that I can extend agent capabilities without modifying Floe source code.

2. As a workspace author, I want my extension manifest to follow a versioned schema (`floe.extension.v1`), so that Floe can validate and evolve the format over time.

3. As a workspace author, I want my extension entry point to be a TypeScript factory function that receives an `ExtensionContext` (workspace path, bus client, workspace ID, extension name), so that my extension tools can interact with the workspace and substrate.

4. As a workspace author, I want my extension to export an array of `AgentTool` objects, so that the tools follow the same contract as built-in tools.

5. As an agent, I want extension tool names to be auto-prefixed with the extension name (e.g., tool `add` in extension `todo` becomes `todo_add`), so that tools from different extensions never collide.

6. As a workspace author, I want to bind an extension to an agent by adding its name to the agent's `extensions: ["todo"]` frontmatter array, so that only designated agents receive the extension's tools.

7. As an agent, I want extension tools to appear alongside built-in tools in my session, so that I can use them like any other tool.

8. As the bridge, I want to discover all extensions in `.floe/extensions/` at workspace attach time and load their manifests and entry points, so that extensions are available before any agent session starts.

9. As the bridge, I want to validate extension manifests (required fields: schema, name, entry) and log warnings for invalid extensions without blocking workspace attachment, so that one bad extension doesn't break the whole workspace.

10. As a workspace author, I want my extension to declare pulse schedules in the manifest, so that recurring or one-off pulses are automatically registered when the extension is loaded.

11. As a workspace author, I want extension-declared pulses to be registered as normal bus pulses with the extension name as source context, so that they flow through the existing pulse infrastructure.

12. As the bridge, I want to detect extension changes via the config hash (like agents), so that adding/removing/modifying extensions triggers re-attachment.

13. As an agent with no extensions declared, I want no extension tools injected, so that my tool set remains lean.

14. As a workspace author, I want clear error messages when an extension fails to load (missing entry point, invalid manifest, runtime errors), so that I can debug issues.

15. As a workspace author, I want extensions to use the workspace filesystem freely through their tools (no sandboxed state directory), so that I have full flexibility in where state lives.

## Implementation Decisions

### New module: Extension Loader

A deep module in the bridge that handles discovery, manifest parsing, validation, dynamic import, and tool prefixing. Single public interface: `loadExtensions(extensionsDir, context) → LoadedExtension[]`. Internally handles all filesystem scanning, JSON parsing, TypeScript dynamic import, validation, error handling, and tool name prefixing.

Interface:
- Input: path to `.floe/extensions/` directory, `ExtensionContext` object
- Output: array of `LoadedExtension` objects, each containing: extension name, loaded tools (prefixed), pulse declarations, any load errors

Types:
- `ExtensionManifest` — parsed `extension.json` shape: `{ schema, name, description?, entry, pulses? }`
- `ExtensionContext` — context passed to factory: `{ workspacePath, busClient, workspaceId, extensionName, hooks }`
- `LoadedExtension` — result: `{ name, tools: AgentTool[], pulses: PulseConfig[], errors: string[] }`

### Modified module: Project loader (project.ts)

Parse the `extensions` field from agent frontmatter and make it available in `AgentConfig`. Discover extension directories and include them in `ProjectLoadResult` for config hash computation.

### Modified module: Bridge daemon (daemon.ts)

On workspace attach, after loading agents and pulses:
1. Call `loadExtensions()` for the workspace's `.floe/extensions/` directory
2. Store loaded extensions in a workspace-scoped registry
3. Register extension-declared pulses via bus client (same as floe.yaml pulses)

### Modified module: Pi agent core adapter (pi-agent-core-adapter.ts)

When creating a session for an agent:
1. Read the agent's `extensions: [...]` frontmatter
2. Look up loaded extensions from the workspace registry
3. Inject prefixed extension tools alongside built-in tools

### Bus: No changes

The bus remains extension-unaware. Extension-declared pulses are just normal pulses. Extension-provided tools are just tools.

### Manifest schema

```json
{
  "schema": "floe.extension.v1",
  "name": "todo",
  "description": "Task tracking with persistent state",
  "entry": "./index.ts",
  "pulses": [
    {
      "id": "todo-daily-review",
      "trigger": { "type": "cron", "expression": "0 9 * * *", "timezone": "America/New_York" },
      "subscribers": ["agent:floe"]
    }
  ]
}
```

### Entry point shape

```ts
import type { AgentTool } from "@earendil-works/pi-agent-core";

export interface ExtensionContext {
  workspacePath: string;
  busClient: BusClient;
  workspaceId: string;
  extensionName: string;
  hooks: {
    on(hook: HookName, handler: HookHandler): void;
  };
}

export default function(ctx: ExtensionContext): AgentTool[] {
  return [
    { name: "add", description: "...", parameters: {...}, execute: async () => {...} }
  ];
}
```

### Tool auto-prefixing

The extension loader prefixes each tool's `name` with `{extensionName}_`. The `label` and `description` are left as-is. This is transparent to the extension author.

### TypeScript loading

Uses `await import(pathToUrl(entryPoint))` — the bridge runs under `tsx` which handles TypeScript natively. On Windows, file paths must be converted to `file://` URLs for dynamic import.

## Testing Decisions

### What makes a good test

Tests should verify behaviour through public interfaces. Extension loader tests should call `loadExtensions()` with real filesystem fixtures and assert on the returned tools and errors — not on internal parsing logic. Tests should survive internal refactors.

### Modules to test

1. **Extension Loader** — the deep module. Test: valid extension loads and returns prefixed tools; missing manifest returns error; invalid manifest returns error; missing entry point returns error; entry point runtime error returns error; pulse declarations are parsed; multiple extensions load independently; empty extensions directory returns empty array.

2. **Agent-extension binding** — integration. Test via the adapter or daemon: agent with `extensions: ["todo"]` gets todo tools; agent with `extensions: []` gets no extension tools; agent with unknown extension name logs warning.

### Prior art

- `floe-bridge/src/tools/pulse-tools.test.ts` — same pattern: factory function returning AgentTool[], tested by calling `execute()` and asserting results
- `floe-bridge/src/tools/actor-tools.test.ts` — same pattern
- `tests/src/vertical-slice.test.ts` — contract tests for full lifecycle

### Testing approach

Create temporary directories with real `extension.json` and `index.ts` files. Call `loadExtensions()` and assert on returned tools. Execute tools and verify behaviour. This avoids mocking the filesystem.

## Out of Scope

- **Declarative hook configuration** — programmatic `ExtensionContext.hooks.on(...)` registration and public hook firing exist, but YAML hook config remains a separate future slice.
- **Event type declarations** — extensions declaring custom event schemas
- **Extension state management** — dedicated state directories or APIs
- **Work-log contributions** — extensions adding to work logs
- **Pi extension compatibility** — reusing Pi's `ExtensionAPI` interface
- **Extension marketplace/registry** — remote extension discovery
- **Extension versioning/dependencies** — semver, dependency resolution
- **Bus extension awareness** — no bus schema changes

## Further Notes

- The extension loader should be defensive: one failing extension should not prevent others from loading or block workspace attachment
- Extension-declared pulses should use the extension name as a prefix for pulse IDs to avoid collision with user-defined or other extension pulses
- The config hash should include extension manifests so that adding/removing extensions triggers bridge re-attachment
- This is the foundation for PRD §6 (Todo Extension Proof) — the todo extension will be the first real extension built on this substrate
