# Surface

_Resolution: settled_
_Built: partly_
_Authority: agent-provisional_
_Authored by: unknown_

A surface is a product people use, built on Floe in its own repository. Floe
supplies shared mechanism; the surface owns its domain, rules, formats, screens
and state (delete test, [pillars](../../pillars/pillars.md)). The how-to for
building one is [docs/surfaces/](../../../surfaces/README.md).

A surface is an ordinary client. It has no privileged access and never keeps its
own copy of Floe's state.

## Launching

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed (boot-menu ruling; launch-argument ruling 30 Sep)_
_Authored by: operator_

- `floe` belongs to Floe alone. Bare `floe` is a boot menu: one surface
  launches, several ask, none explains how to add one.
- A packaged surface declares `floe.surface` (`name`, `label`, `bin`) in its
  `package.json` and keeps its own command. Other programs register by hand.
  Floe has no built-in list or special case for any surface.
- Floe appends exactly one final argument, `--launched-by=floe`. With it, a
  surface offers the person's Workspaces; without it, the launch folder decides.
  A surface never silently opens another Workspace.

## Surfaces use the installed Floe

_Resolution: settled_
_Built: no_
_Authority: operator-confirmed (8 Oct)_
_Authored by: operator_

- A surface uses the machine's installed Floe, like an app uses installed Node.
- It declares the Floe version range it needs. Missing Floe: offer to install.
  Too old: offer to upgrade.
- A surface carries its own Floe only to test Floe or itself in isolation.

Built today: surfaces carry a Floe dependency for the Node helpers, and can ask
Floe to restart from the surface's copy (`switchToThisVersion`). Identity and
engines are already reached over published protocols without a copy.

## Agents learn to build surfaces

_Resolution: settled_
_Built: partly_
_Authority: operator-confirmed (8 Oct)_
_Authored by: operator_

- The surface-building guide lives in Floe and ships with it. Built:
  `docs/surfaces/` exists; it is not yet in the release package.
- Floe setup installs it as a skill for every agent tool on the machine
  (`~/.agents/skills`, linked into `~/.claude/skills`). Not built.
- Floe's own Actor knows the guide, so asking Floe to help build a surface
  works without a skill. Not built.

## Open

- Under the installed-Floe ruling, where do the Node helpers (`floe/identity`,
  `floe/engines`, `floe/actors`) and their "start Floe if needed" step come from?
- Does `switchToThisVersion` survive once surfaces no longer carry Floe?
