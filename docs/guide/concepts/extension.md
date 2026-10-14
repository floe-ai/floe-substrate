# Extension

**An Extension is a folder that adds tools and hooks to Floe: a small manifest and a code entry.**

Any [[Actor]] can write one. Any Actor with the right permission can turn one on
or off. Extension code is trusted like normal code: there is no sandbox and no
per-Extension permission list. An Extension adds kinds inside the primitives; it
never adds a new primitive.

## What works today

- **Tools** that an Actor can call.
- **[[Hook]]s** that run at points in an Actor's turn.

Skills, Commands, Event sources, Connector kinds, Actor definitions, record
types and screens from an Extension are not built yet.

## Where the code lives

The code can live anywhere on the machine: its own repository, another folder,
or inside `.floe/extensions/NAME/` itself. The Workspace records each installed
Extension in `.floe/extensions/NAME/installed.json`:

```json
{ "schema": "floe.extension-install.v1", "code": ".", "enabled": true, "accepted_version": "sha256:…" }
```

- `code` — the code folder, relative to the record's folder or absolute. `"."`
  means the code sits beside the record.
- `enabled` — the on/off switch. Turning an Extension on or off is an ordinary
  file change.
- `accepted_version` — the only version Floe will run.

The folder name is the Extension's name. It must match `name` in the code
folder's `extension.json`:

```json
{ "schema": "floe.extension.v1", "name": "todo", "description": "A shared todo list", "entry": "./index.js" }
```

Names use lowercase letters, digits and hyphens. The entry must stay inside the
code folder.

## Versions

The version is a digest of every file in the code folder (`sha256:…`), leaving
out `.git`, `node_modules` and the install record. When the folder is committed
in git with no uncommitted changes, the commit and path are recorded beside it.

A change to the code is a new version, never a silent change. Floe keeps the
accepted version until an Actor accepts the new one by writing it into
`accepted_version`. A first install also starts held. There is no Floe
operation for accepting a version or turning an Extension on or off yet; edit
`installed.json`.

## Status

Each installed Extension has one status, pushed whenever it changes:

| Status | Meaning |
|---|---|
| `running` | Loaded at its accepted version; lists its tools and hooks |
| `off` | `enabled` is false |
| `new_version` | The code is not the accepted version; held until an Actor accepts it |
| `failed` | The record, manifest or code could not be loaded; carries the reason |

Floe watches `.floe/extensions` and every code folder outside it, and checks
again shortly after files stop changing.

All Extensions run together in one Extension process, separate from the Bus and
the Bridge. A crash or hang in an Extension cannot take Floe down. The process
restarts by itself after a crash, waiting a little longer each time.

## Writing the entry

The entry's default export receives `{ workspacePath, workspaceId,
extensionName, hooks }` and returns a list of tools. Each tool has a `name`, a
`description`, `parameters` (a JSON Schema object) and `execute(callId,
params)`, which returns `{ content: [{ type: "text", text }], details? }`.

```js
export default function todo({ workspacePath, hooks }) {
  return [{
    name: "add",
    description: "Add an item to the shared todo list.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(callId, params) {
      return { content: [{ type: "text", text: `Added: ${params.text}` }] };
    },
  }];
}
```

Floe offers the tool as `EXTENSION_TOOL`, here `todo_add`. Only an Actor whose
definition lists the Extension in `extensions` is offered its tools and runs its
hooks. Tool calls run in the Extension process and are recorded like Floe's own
tools.

See [[Glossary]].
