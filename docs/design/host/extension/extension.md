# Extension

_Resolution: question_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

A versioned package that contributes bounded capability under declared
permissions, isolation, approval and rollback: Capabilities, Commands,
Connectors, schemas, templates, Actor definitions, previews, renderers,
dashboards and bounded product surfaces. It may also register [hooks](hook.md).

- Source and installation are separate. Canonical source lives in its own
  repository or package; a Workspace installs it under `.floe/extensions/NAME/`,
  where the Bridge discovers it. An installed `extension.json` may point to
  canonical source.
- Extension code runs in the isolated Extension host. The Bridge does not import
  Extension source or inject Extension tools into runtime sessions.
- Filesystem, network, secret and action access needs an exact declared
  permission and current authority; missing brokers fail closed.
- An Extension may own domain schemas, specialised statuses, invalidation and
  regeneration policy, and rich presentation. It never owns competing
  Workspace, Context, Scope topology, Artefact identity or authority.
- Install, enable, upgrade and rollback are governed operations
  (`extension.install`, `extension.enable`, `extension.upgrade`,
  `extension.rollback`), so an Actor can add capability without anyone copying
  files by hand.

## Starting point: the original design

_Resolution: settled_
_Built: partly_
_Authority: operator-confirmed (ADR-0002, May; ADR-0006, Aug; 9 Oct ruling: decisions from August and earlier stand)_
_Authored by: operator_

- An Extension is a folder with a small manifest (`extension.json`) and a
  TypeScript entry. The entry receives the Workspace's details and returns
  tools for Actors. Tool names are prefixed with the Extension's name.
- It is trusted code, loaded by the Bridge when a Workspace attaches. It has no
  separate state store; it uses Workspace files like any other tool.
- It can declare Pulses and register [hooks](hook.md) in code.
- Extension source lives in its own repository, never in the Floe repository.
  A Workspace installs it under `.floe/extensions/NAME/`.

## Legacy

Old Extension lineage JSON may be imported once as evidence; it is never a
continuing source of Artefact identity.

## Open

- Being redesigned. Operator rulings, 8 Oct: any Actor can write an Extension;
  Extension code is trusted like normal code (no sandbox); an Extension can add
  hooks, Event sources, Connector kinds, Commands, Actors, record types,
  screens, and actions and know-how for Actors; any Actor with the right
  permission can enable one. The isolation, permission and package machinery
  at the top came from the unreviewed September snapshot. The original design
  above is the starting point.
- The Floe Actor template and build skill
  (`floe-bridge/src/prompts/default-floe-agent.md`,
  `floe-bridge/src/prompts/substrate-build-skill.md` and their copies under
  `.floe/`) still tell Actors to read ADR-0002 and ADR-0006, which are retired,
  and describe the snapshot's package model. They are rewritten with the
  redesign.
