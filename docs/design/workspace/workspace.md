# Workspace

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

The top-level portable identity and isolation boundary for an organisation's
Actors, Contexts, Scopes, Artefacts, authority and history.

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
_Authority: operator-confirmed (ADR-0005, Jun; 9 Oct ruling: decisions from August and earlier stand)_
_Authored by: operator_

- An Actor's file writes stay inside the Workspace's folder. Reaching outside
  it is refused.
- No general network route writes host files or credentials, so credentials
  never travel over network ports. A surface writes local configuration through
  its own native layer.

Avoid: path-derived Workspace IDs, path as identity, locators in remote
projections.

## Legacy

Old path-derived Workspace identifiers are kept as opaque identities during
migration; new identities are opaque and path-independent.

## Open

- Safe file editing from a remote surface is unsolved (ADR-0005).
- Not checked: whether engine file tools are held to the Workspace folder.
