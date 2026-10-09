# Artefact

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

A stable logical thing produced, consumed, discussed, revised, assembled,
tested, approved or derived by work: a document, image, collection, source tree,
website, report, decision or deployable package.

Floe owns identity, type, access, retention, redaction and tombstone state,
creation provenance and the [version](version.md) graph. Extensions own domain schemas, metadata,
specialised statuses, invalidation and regeneration policy, and rich
presentation.

Artefact lineage records exact version relationships; it is never pipeline
topology. Content storage owns bytes ([ContentRef](content-ref.md)); Floe owns
identity, provenance, authority and safe references.

Avoid: file path as identity, Event payload as identity, Extension-owned
identity ledger.

Origin: agent ADR-0010 (4 Sep).
