# Portable package

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

A versioned, deterministic transfer format for one [Workspace](workspace.md)
identity and its canonical evidence: immutable revisions, execution and Delivery
history, Context material subject to retention, Artefact lineage, exact
reachable content and safe authority references.

It never carries host folder bindings, reusable credentials, authority sessions,
Bridge or worker attachments, or other host-local state.

Restore keeps canonical IDs and history, binds a new host folder, and creates a
separate restore hold. Secrets and other host dependencies stay unresolved until
the new host provides exact evidence; imported operation receipts never prove
that. Reactivation is an explicit governed operation once every dependency
resolves.

A transfer format, not a primitive and not an opaque backup.

Decision: [ADR-0012](../../adr/0012-portable-workspace-authority-and-secret-brokering.md).
