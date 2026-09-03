# Artefact

**An Artefact is a stable logical thing produced, consumed, discussed, revised, assembled, tested, approved, or derived by work.**

Examples include a document, concept image, child image, collection, source
tree, website, report, decision, or deployable package.

## Identity and versions

Floe owns the stable Artefact identity. An ArtefactVersion is one immutable
state of that Artefact, or one exact externally pinned observation. It records a
digest or provider-guaranteed revision, media type, schema, ContentRef,
provenance, exact lineage, collection membership, and Context or execution
associations.

There is no universal mutable `current_version`. Branches may have several
heads. Current, approved, stale, and other domain statuses are policy-governed
annotations or projections.

## Content and Events

The content store owns bytes. A ContentRef securely identifies exact content in
a filesystem, Git repository, object store, document provider, database
snapshot, or another store. Floe does not need to copy large bytes when a
verified immutable reference is sufficient.

An [[Event]] may carry small payload facts and zero or more exact
ArtefactVersion references. Arbitrary Event content is not automatically an
Artefact. A Delivery transports those references; it does not create a competing
identity.

## Provenance is not topology

Artefact lineage records exact version relationships. A [[Scope]] Edge records
the designed route between Ports. One never implies the other.

Extensions may own domain schemas, metadata, specialised statuses,
invalidation and regeneration policy, and rich presentation. They do not own a
parallel Artefact identity ledger. Existing extension lineage JSON is legacy
import evidence or a projection over canonical Artefacts.

## Implementation

- `floe-bus/src/artefacts.ts` — canonical identity, versions, ContentRefs, and
  lineage
- `floe-bus/src/artefact-operations.ts` — create, publish-version, and inspect
  semantic operations
- `floe-bus/src/fs/` — one local content adapter; a path is never Artefact
  identity

See [[Glossary]].
