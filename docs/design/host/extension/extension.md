# Extension

_Resolution: direction_
_Built: no_
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

Installing records the exact version in use: the git commit when the code is in
a git repository, otherwise a content digest (see
[version](../../artefact/version.md)). A change to the code is a new version,
never a silent change.

## Where it runs

All Extensions run together in one Extension process, separate from the Bus and
Bridge. This is for stability, not security: a crash or hang in an Extension
cannot take Floe down, and the process can be restarted.

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

- Code does not match. The September snapshot (70e5752, unreviewed) deleted the
  loader (`floe-bridge/src/extension-loader.ts`), so no Extension loads today,
  including `examples/extensions/todo`. It added a package system instead
  (`floe-bus/src/extensions.ts`, `extension-operations.ts`,
  `extension-activation-authority.ts`, `canonical-extension-runtime.ts`,
  `isolated-extension-*.ts`, about 5,200 lines): sandboxing, permission lists,
  test evidence and a seven-stage lifecycle. The operator ruled to remove it
  (9 Oct, Q27).
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
