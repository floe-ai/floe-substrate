# Workspace

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

The top-level portable identity and isolation boundary for an organisation's
Actors, Contexts, Scopes, Artefacts, access and history.

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

## Open

- Safe file editing from a remote surface is unsolved (ADR-0005).
