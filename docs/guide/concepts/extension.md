# Extension

**An Extension is a versioned package that contributes bounded capability under declared permissions, isolation, approval, and rollback.**

Canonical Extension source may live in an independent repository or package
(ADR-0006). A Workspace-installed copy or pointer remains under
`.floe/extensions/NAME/` so the Bridge can discover it. Source ownership and
Workspace installation are different concerns.

## What an extension contributes

- **Tools** — functions an [[Actor]] can call. Names are auto-prefixed with the extension name to prevent collisions: an extension named `acme` exporting a tool `move` is exposed to the actor as `acme_move`.
- **Pulses** — schedule declarations ([[Event]] sources) the extension wants registered.
- **Views** — UI panels rendered as scope-detail tabs.
- **HTTP handlers** — request handlers reachable through the bridge's extension relay.
- **Hooks** — programmatic handlers for the runtime lifecycle (`SessionStart`, `BeforeTurn`, `Pulse`, and so on — see [[Hook]]).
- **Bundled agents** — agent definitions the extension ships with, loaded in memory at workspace attach.
- **Capabilities, Commands, and Connectors** — semantic operations and typed
  external sources/actions exposed through the shared Bus contract.
- **Schemas and presentation** — domain metadata, previews, renderers,
  dashboards, and bounded product surfaces over canonical records.

An Extension may own domain schemas, specialised statuses, invalidation and
regeneration policy, and rich presentation. It does not own competing
Workspace, Context, Scope topology, Artefact identity, authority, or operation
ledgers.

## Manifest

Extensions live in `.floe/extensions/NAME/` and declare an `extension.json`:

```json
{
  "schema": "floe.extension.v1",
  "name": "acme",
  "entry": "./index.js",
  "views": [
    { "slot": "scope-detail-tab", "label": "Board", "component": "acme/Board" }
  ],
  "agents": [
    { "agent_id": "acme-bot", "label": "Acme Bot", "instructions_path": "./agents/bot.md" }
  ]
}
```

`schema` must be exactly `floe.extension.v1`. `entry` resolves to a file that default-exports a factory `(ctx: ExtensionContext) => AgentTool[]`. An `extension.json` may also be a lightweight pointer (`{ "manifest_source": "..." }`) to a manifest that lives in the extension's own repository, so the installed copy never drifts from the source.

## Current loader boundary

The current in-process Bridge loader reads bundled Actor definitions and
handlers. That loader and its relay routes are legacy implementation beneath the
accepted isolated Extension lifecycle. They do not grant arbitrary filesystem,
network, secret, or action access.

## HTTP relay

An extension can register HTTP handlers via `ExtensionContext.registerHttpHandler(method, path, handler)`. The bridge runs a relay HTTP server (port 5378 by default, falling back to an OS-assigned port if taken) that dispatches to these handlers, with each extension's handlers namespaced under its own name in the URL path: `http://127.0.0.1:5378/{extName}/{handlerPath}`.

The bridge reports its relay's base URL to the bus. The bus then proxies client
requests: `GET|POST /v1/extensions/:name/*` forwards to that extension's
`relay_url`. If an extension has registered no HTTP handlers, `relay_url` is
`null` and the bus responds `503`.

## Implementation

- `floe-bus/src/extensions.ts` — canonical package/install lifecycle records
- `floe-bus/src/extension-operations.ts` — shared inspect, install, upgrade,
  disable, and rollback operations
- `docs/adr/0006-external-extension-repositories.md` — extensions live outside this repo
- `docs/adr/0002-extension-substrate-design.md` — manifest format, tool prefixing, hook registration
- `floe-bridge/src/extension-loader.ts` — `loadExtensions`, `validateManifest` (schema `floe.extension.v1`), `loadBundledAgentsInMemory`, tool-name prefixing
- `floe-bridge/src/extension-relay.ts` — `startExtensionRelayServer`, per-extension path namespacing
- `GET /v1/extensions` — list registered extensions (`floe-bus/src/server.ts:1543`)
- `POST /v1/extensions/report` — bridge reports its extensions + relay URL (`floe-bus/src/server.ts:1514`)
- `GET|POST /v1/extensions/:name/*` — proxy to the extension's relay (`floe-bus/src/server.ts:1604`, `:1608`)

External extension view components: Not built yet — a declared view renders `PlaceholderExtensionView`.

See [[Glossary]] for term definitions.
