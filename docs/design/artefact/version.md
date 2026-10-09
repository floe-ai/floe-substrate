# Version

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

Canonical name: **ArtefactVersion.** One immutable state of an
[Artefact](artefact.md), or an exact externally pinned observation. It has a
version ID, digest or provider-guaranteed revision, media type, schema, typed
[ContentRef](content-ref.md), provenance, lineage, membership, and Context or
execution associations.

There is no universal mutable current version. Branches may have several heads.
Current, approved, stale or domain status is a policy-governed annotation or
projection.

## Direction: version control holds history, Floe holds the pin

_Resolution: direction_
_Built: partly_
_Authority: operator-confirmed (9 Oct ruling, D18)_
_Authored by: operator_

- Floe must know the exact version used, for approvals, retry, redo, fork and
  lineage. It needs a pin, not its own history.
- Where the content's store can pin it, the version is a pointer: a git commit
  and path, or the provider's revision ID. Every Workspace is a git repository,
  so git is the first store.
- Floe copies bytes only when nothing can pin the content.
- Other version control (for example Perforce) waits until the need appears.

Today Floe copies every published local file (see
[content reference](content-ref.md)).
