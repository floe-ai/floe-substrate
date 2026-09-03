# ADR-0010: Scope topology, execution, and Artefact provenance are canonical

**Status:** accepted (2026-09-03)

## Context

Repeated operation of the Snowball delivery pipeline and the concept-image
pipeline exposed four failures in the current model:

1. Context membership and Event subscriptions are used as pipeline wiring.
   Changing collaboration can therefore change routing, while the substrate
   cannot explain one exact designed path independently of observed traffic.
2. A Scope stores nodes but no connections. Clients reconstruct apparent routes
   from subscriptions, Event types, Deliveries, and runtime emissions.
3. Re-composition overwrites one mutable node list. Historical execution can no
   longer prove which design it used, and retry versus redo is ambiguous.
4. Extension-owned mutable JSON supplies output identity, versions, provenance,
   and lineage. Other extensions and substrate records cannot reliably refer to
   the exact same output.

These are no longer hypothetical design concerns. They prevented the operator
from understanding active work, caused multiple live-looking pipeline versions,
made branching execution difficult to follow, and created competing accounts of
which output was current.

## Decision

### Context is collaboration, not pipeline routing

A Context remains the durable place where participants understand, discuss, and
record work. Context membership, parentage, and ordinary pub/sub remain valid.
They do not advance a Scope execution.

Every NodeExecution references an inspectable Context selected by the
NodePlacement's Context policy. The policy may create a Context, reuse one by a
stable key, or use a fixed persistent Context. A NodeExecution does not imply a
new Context.

### A Scope owns explicit composition

A Scope is the stable organising identity. Its semantic design is stored as
ScopeCompositionRevisions. Each revision contains:

- NodePlacements that reference existing Actors, Commands, Contexts, nested
  Scopes, Event sources, capabilities, or connector actions;
- stable typed input and output Ports;
- explicit enabled Edges from one output Port to one input Port;
- bindings, activation policy, Context policy, safety policy, and semantic
  configuration.

Only designed pipeline routes are Edges. Direct conversation, explicit Actor
requests, Context relationships, and Artefact lineage are different
relationships.

A draft revision may be edited. Publication freezes its semantic content and
atomically makes it the Scope's current published revision. A later semantic
change creates another revision. Presentation state such as pan, zoom, node
position, or collapsed panels is app-owned and does not create a semantic
revision.

New root ingress uses the current published revision. Existing ScopeExecutions,
callbacks, retries, and correlated arrivals remain pinned to the revision under
which they began. A redo is an explicit new logical execution and may select
the original or current revision.

### Execution has canonical records

A ScopeExecution is one causally coherent activation of a Scope under one
composition revision.

A NodeExecution is one logical activation of one NodePlacement. It records its
resolved Context, exact Port-bound inputs, activation or join key, responsible
Actors, outputs, lifecycle, and failure state.

An ExecutionAttempt is one processing attempt within a NodeExecution. Retry adds
an attempt; it does not invent a new logical activation.

Delivery remains the durable transport obligation. Graph-routed Delivery records
the ScopeExecution, revision, source and target Ports and NodePlacements, Edge,
causal Event, and NodeExecution where resolved. Events and Deliveries remain the
transport ledger; execution records do not create a second queue.

Publishing an outcome to a named output Port validates the pinned contract and
traverses every enabled outgoing Edge exactly once logically. An Actor does not
choose downstream Endpoints when reporting graph progress. Direct `emit` and
`request` remain available for deliberate non-graph communication and do not
masquerade as Scope execution progress.

### Floe owns minimum universal Artefact identity

An Artefact is a stable logical output, input, collection, reference, or body of
evidence. An ArtefactVersion is one immutable state or exact externally pinned
observation of it.

Floe owns only the universal contract:

- stable Artefact and ArtefactVersion identity;
- type and schema references;
- content-addressed or externally revision-pinned references;
- exact provenance involving Event, Context, ScopeExecution, NodeExecution,
  Actor, Command, and connector receipts;
- exact-version lineage and collection membership;
- access, retention, redaction, and tombstone metadata needed for safe use.

Extensions own domain schemas, domain metadata, specialised statuses,
invalidation and regeneration policy, and rich presentation. Content stores own
bytes. External systems remain authoritative for their external state; Floe
records exact observations and receipts.

Pipeline Edges and Artefact lineage never substitute for one another.

## Migration

Existing Scope, Context, Event, Delivery, Actor, credential, report, and output
history is valuable user state and must be preserved.

- Existing mutable Scope graphs are imported as explicit legacy composition
  revisions. Legacy subscription routing is isolated and identified; a revision
  can never use both legacy and Edge routing.
- New and republished revisions use explicit Edge routing.
- Existing extension lineage documents are idempotent import evidence. Once an
  item is imported, canonical Artefact APIs own its identity and provenance;
  the document may remain an extension projection but not a parallel authority.
- Migration is validated and backed up before destructive schema work. Missing
  credentials become unresolved bindings rather than copied secret values.

Compatibility code is a bounded migration boundary, not an alternate product
model. It is removed after retained user state has a canonical representation.

## Consequences

- The app can display a published plan and a selected execution without
  reconstructing topology from activity.
- Branching, convergence, retry, redo, history, and stopping have stable
  identities and explainable consequences.
- Contexts remain useful collaboration spaces without being overloaded as
  routing tables.
- Output versions and provenance can be shared across extensions, connectors,
  clients, and runtime providers.
- Scope composition and execution APIs, the runtime processing contract,
  projections, product views, and documentation must migrate together.

This decision supersedes ADR-0008 only where it states that a Context is graph
wiring, no Edge is stored, re-composition replaces one mutable design, and
outcomes exist only through Context. ADR-0008's Event-source consolidation,
Actor/Command distinction, Actor-backing neutrality, and Scope-level product
boundary remain accepted.

This decision also supersedes PRODUCT.md's statement that extension lineage
documents own Artefact identity, status, version, and lineage. Extensions retain
domain meaning and presentation as described above.
