# Workspace

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

The top-level portable identity and record boundary for an organisation's
Actors, Contexts, Scopes, Artefacts, access and history. Workspaces on one
machine share that machine user's trust
([Workspace access](../capability/access.md#one-trust-level-per-machine)).

A Workspace has a stable opaque `workspace_id`. A folder path is never its
identity; it is a host-local [folder binding](folder-binding.md). Moving or
rebinding keeps the identity. Restoring an export keeps it. Copying or forking
creates a new identity with source provenance. Remote projections never expose
host paths, binding IDs or host identity.

`.floe/floe.yaml` is committed project configuration, never runtime scratch
state. Runtime state lives in the git-ignored `.floe/state`.

## Files

_Resolution: settled_
_Built: partly_
_Authority: operator-confirmed (ADR-0005, Jun; 14 Oct: Actors get "full access", replacing ADR-0005's folder limit)_
_Authored by: operator_
_Priority: P1_
_Release: 1.0_

- An Actor may read and write anywhere [Workspace access](../capability/access.md)
  allows, and a new Workspace allows everything. The Workspace's folders say
  where its work lives, not where Actors may reach.
- No general network route writes host files or credentials, so credentials
  never travel over network ports. A surface writes local configuration through
  its own native layer.

Still in code: an Actor's writes outside the Workspace's folders are refused
until the folder is added with `workspace.folder.add`.

Avoid: path-derived Workspace IDs, path as identity, locators in remote
projections.

## Removing a Workspace

_Resolution: direction_
_Built: partly_
_Authority: agent-provisional_
_Authored by: agent_
_Priority: P2_
_Release: 1.0_

Removing a Workspace ends its records on this machine. Asking to remove its
folder too first stops everything Floe runs in that folder (turns, Extensions),
then deletes the folder. If the folder still cannot be deleted, Floe says which
file is held instead of failing silently.

Still in code: on Windows, deleting the folder while Floe still holds it open
fails with an unexplained server error (`floe-bus/src/store.ts`,
`deleteWorkspaceLocator`).

## Reading and changing the Workspace file

_Resolution: direction_
_Built: partly_
_Authority: agent-provisional_
_Authored by: operator (issue #180, Aug)_
_Priority: P2_
_Release: 1.0_

What a Workspace is lives in its committed `.floe/floe.yaml`: Actors, Pulses,
folder sources, webhook routes, Extensions and settings. Any Actor or surface
can read each of these and change one through the Bus, without handling the
file's text.

- A change keeps the file's comments, order and formatting: saving one change
  alters only that change.
- Floe writes the file only when asked. Starting Floe never changes it, so the
  repository stays clean.

Still in code: the file can be written only whole, as raw text
(`PUT /v1/workspaces/:id/fs/file`), and folder sources, hooks and webhook
routes cannot be read back once loaded. Pulses can (`GET /v1/pulses`).

## Open

- Safe file editing from a remote surface is unsolved (ADR-0005).
