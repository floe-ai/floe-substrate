# Content reference

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

Canonical name: **ContentRef.** A typed, secure reference to exact content held
by the filesystem, Git, object storage, a document provider, a database snapshot
or another store. Floe does not copy large bytes when a verified immutable
reference is enough.

Publishing a local Workspace file verifies its digest and size, keeps those
bytes in the Workspace content store, and records that reference. Later edits to
the source file never change the published version. Externally pinned revisions
keep their resolver contract.
