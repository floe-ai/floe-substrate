# Extension

_Resolution: direction_
_Built: partly (loading, versions and tools; see Open)_
_Authority: operator-confirmed (8 Oct and 9 Oct rulings)_
_Authored by: operator_

A folder that adds to Floe: a small manifest (`extension.json`) and a code
entry. Any [Actor](../../actor/actor.md) can write one. Any Actor with the right
permission can enable or disable one. Extension code is trusted like normal code:
no sandbox and no per-Extension permission list.

An Extension adds kinds inside the primitives, never a new primitive
([primitives](../../pillars/primitives.md)).

## What an Extension can add

| Adds | Fits inside |
|---|---|
| Commands, including ready-made nodes ([Command](../../command/command.md#direction-a-command-is-a-ready-made-node)) | Command |
| Event sources (for example a folder watcher) | Event |
| Connector kinds | [Connector](../../workspace/connector.md) |
| Actor definitions | Actor |
| Tools (actions an Actor can call) and skills (written know-how an Actor reads when relevant) | Actor |
| Record types (for example a campaign brief) | Artefact |
| [Hooks](hook.md) | Actor runtime |
| Screens | Floe lists them; a [surface](../surface/surface.md) chooses to show them |

## Where the code lives

The code can live anywhere on the machine: its own repository, another folder,
or inside `.floe/extensions/NAME/` itself. The Workspace records each installed
Extension under `.floe/extensions/NAME/`, pointing at its code when the code is
elsewhere.

The install record is `.floe/extensions/NAME/installed.json`:

```json
{ "schema": "floe.extension-install.v1", "code": ".", "enabled": true, "accepted_version": "sha256:…" }
```

- `code`: the code folder, relative to the record folder or absolute. `"."`
  means the code sits beside the record.
- `enabled`: the on/off switch. It lives in Workspace files, so turning an
  Extension on or off is a normal file change (9 Oct, O23).
- `accepted_version`: the only version Floe will run.

The folder name is the Extension's name and must match the `name` in the code
folder's `extension.json`
(`{ "schema": "floe.extension.v1", "name", "description"?, "entry" }`). Names
use lowercase letters, digits and hyphens. The entry must stay inside the code
folder.

### Versions

The version is a digest of every file in the code folder (`sha256:…`),
leaving out `.git`, `node_modules` and the install record. When the folder is
committed in git and has no uncommitted changes, the git commit and path are
recorded beside it as where that version came from.

The digest, not the commit, is the version, for two reasons. When code and
record share a folder, accepting a version edits the record, which would
otherwise look like a new version. And a commit elsewhere in the repository
must not count as a new version of an Extension it did not touch. This
narrows [version](../../artefact/version.md)'s "git first" rule for Extension
code.

A change to the code is a new version, never a silent change. Floe keeps
running the accepted version until an Actor accepts the new one by writing
its `accepted_version` (9 Oct, O25). A first install also starts held. The
old code keeps running in memory only until the Extension process next
reloads or restarts; after that the Extension is held, not running.

### Status

Each installed Extension's status is part of the Workspace's attachment
report and is pushed again whenever it changes:

| Status | Meaning |
|---|---|
| `running` | Loaded at its accepted version; lists its tools and hooks |
| `off` | `enabled` is false |
| `new_version` | The code is not the accepted version; held until an Actor accepts it |
| `failed` | The record, manifest or code could not be loaded; carries the reason |

The Bridge watches each Workspace's `.floe/extensions` folder and every code
folder outside it with file events, and re-checks after a short quiet period.

## Where it runs

All Extensions run together in one Extension process, separate from the Bus and
Bridge. This is for stability, not security: a crash or hang in an Extension
cannot take Floe down, and the process can be restarted. It restarts by itself
after a crash, waiting a little longer each time, and loads every Workspace's
Extensions again.

## Tools for Actors

The entry's default export receives
`{ workspacePath, workspaceId, extensionName, hooks }` and returns its tools.
Each tool has a `name`, `description`, `parameters` (JSON Schema) and
`execute(callId, params)`, which returns
`{ content: [{ type: "text", text }], details? }`. Floe offers the tool as
`EXTENSION_TOOL` (for example `todo_add`).

Only an Actor whose [definition](../../actor/definition.md) lists the Extension
in `extensions` is offered its tools (9 Oct, O21). Tool calls run in the
Extension process and are recorded like Floe's own tools.

## Origin

The original design (ADR-0002, May; ADR-0006, Aug): a folder with
`extension.json` and a TypeScript entry that returns tools for Actors, tool
names prefixed with the Extension's name, trusted code, no separate state store,
Pulses and hooks declared by the Extension, source outside the Floe repository.
The 8 and 9 Oct rulings keep that shape and widen what an Extension can add.

## Legacy

Old Extension lineage JSON may be imported once as evidence; it is never a
continuing source of Artefact identity.

## Open

- Built so far: install records, versions, the Extension process, status
  reports, watching, and tools for listing Actors. Not built yet: hooks reach
  the Extension process and are reported, but nothing calls them; skills,
  Commands, event sources, Connector kinds, Actor definitions, record types
  and screens.
- There is no Floe action to accept a version or turn an Extension on or
  off; an Actor edits `installed.json`. Whether Floe should offer one is open.
- The September package system (sandboxing, permission lists, a seven-stage
  lifecycle) was removed on branch `extensions/redesign` (9 Oct, Q27).
- Needs review with the operator before it is built: permission, approval and
  spending-limit rules still have places for "an Extension" and "a Connector
  action" from the removed systems (`policies.ts`, `budgets.ts`,
  `approvals.ts`, `approval-operations.ts`, `artefacts.ts`, Command owner and
  implementation kinds). The operator ruled to keep them and point them at the
  new Extensions and Commands as those are built, but not without first
  agreeing what each place should mean (9 Oct).
- Proof of done: an Actor repairs `examples/extensions/todo` against these
  documents and it works live (9 Oct, Q29).
- Code may live outside the Workspace, so an export can lack it. Export should
  name each Extension, where it came from and its version, so restoring can
  fetch it.
- The Floe Actor template and build skill
  (`floe-bridge/src/prompts/default-floe-agent.md`,
  `floe-bridge/src/prompts/substrate-build-skill.md` and their copies under
  `.floe/`) still cite ADR-0002 and ADR-0006, which are retired, and describe
  the snapshot's package model. Rewrite them with this design.
