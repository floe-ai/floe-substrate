# Extension

_Resolution: settled_
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

Decisions: [ADR-0002](../../../adr/0002-extension-substrate-design.md),
[ADR-0006](../../../adr/0006-external-extension-repositories.md).

## Legacy

Old Extension lineage JSON may be imported once as evidence; it is never a
continuing source of Artefact identity.
