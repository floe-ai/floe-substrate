# Context

**A Context is the durable place where participants understand, discuss, and record work.**

It contains conversation, attached evidence, relevant references, decisions,
summaries, and exact relationships to ArtefactVersions and execution records.
It may be a direct conversation, a processing space, a persistent Actor
workspace, or a Scope overview.

## Collaboration, never routing

Context membership, parentage, subscriptions, instructions, and proximity do
not advance a ScopeExecution. A published [[Scope]] design advances only through
stored Edges between Ports.

Ordinary Context pub/sub remains available for deliberate non-graph
communication. Legacy compositions may retain subscriptions for migration, but
one composition revision can never mix subscription routing with Edge routing.

## Anchors

A Context must be anchored by participant relationships, a Scope, or both. A
Context with neither anchor is invalid.

Every NodeExecution references an inspectable writable Context selected by its
NodePlacement's Context policy. That policy may create a Context, reuse one by a
stable key, or enter a fixed persistent Context. The Context is where the work is
understood and recorded; it is not the NodeExecution itself.

A fixed execution Context must already be active, retain available content, and
belong to the same Workspace and Scope as the placement. Validation, publication,
rollback and activation enforce that constraint. A later archive or redaction
can make a previously valid fixed Context unavailable. To return a result to an
outside conversation, keep the execution Context in its Scope and communicate
to that conversation under the Actor's granted authority.

Model-facing history is read on demand as bounded chronological previews.
Pages retain complete JSON and the Bus-issued continuation cursor; the Bridge
reduces the page size before returning it when necessary. Text truncation and
oversized fields omitted from a single-Event preview are explicitly identified.
The canonical Event and its saved content remain unchanged.

## Participants

A Context participant is an Actor with an explicit role and access relationship
to that Context. Participation controls collaboration and authority. It does not
create an Edge or automatically wake the Actor.

Participants and their access may change while the Context is active. Parent and
child relationships organise related Contexts without creating pipeline routes.

## Lifecycle and retained evidence

Archive is the normal reversible way to remove a Context from active use.
Restore returns it to active use. Both preserve conversation and evidence.

Permanent destruction is a separately named irreversible operation. It requires
explicit confirmation and refuses while a retained ScopeExecution,
NodeExecution, ArtefactVersion, pending Delivery, decision, approval, audit
record, child Context, or other canonical evidence still references the
Context. When Floe cannot safely enumerate retained relationships, it refuses
destruction rather than assuming none exist.

History compaction and legacy clear-history routes are maintenance boundaries,
not substitutes for archive, retention, redaction, or tombstones.

## Canonical operations

The Bus-owned semantic operation registry supplies the live schemas,
availability, authority requirements, confirmations, and receipts for:

- `context.list`, `context.get`, and `context.inspect`
- `context.create`, `context.archive`, and `context.restore`
- `context.participant.set_access` and `context.participant.remove`
- `context.communication.emit`
- `context.destroy_permanently`

Clients discover and invoke these definitions instead of maintaining their own
Context rules. Older raw Context mutation routes are compatibility or internal
adapters and must delegate to the same semantics where they remain reachable.

## Implementation

- `floe-bus/src/contexts/store.ts` — Context records and lifecycle metadata
- `floe-bus/src/context-operations.ts` — canonical definitions and handlers
- `floe-bus/src/context-operation-backend.ts` — integration with Event delivery
  and retained-reference checks
- `floe-bus/src/operation-routes.ts` — shared discovery, invocation, and receipt
  transport

See [[Glossary]].
