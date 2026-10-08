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

Avoid: path-derived Workspace IDs, path as identity, locators in remote
projections.

## Legacy

Old path-derived Workspace identifiers are kept as opaque identities during
migration; new identities are opaque and path-independent.
