# Floe Substrate Semantics

**Status:** Current working synthesis of `CONTEXT.md` and accepted ADRs.
**Authority:** `CONTEXT.md` defines terms; accepted ADRs define lasting
decisions. This document explains their implementation consequences.

## 1. Actor and Endpoint are different

An Actor is an entity permitted to perceive, decide, communicate, and act. Its
backing may be a person, model, deterministic service, or future runtime without
changing its identity or authority semantics.

An Endpoint is an addressable delivery interface used by an Actor, Command,
Connector, service, or other runtime. Endpoint is not an identity type. No
backing is privileged.

## 2. Context is collaboration, never routing

A Context is the durable place where participants understand, discuss, and
record work. It contains conversation, evidence, decisions, summaries, and
exact references to ArtefactVersions and execution records.

Context membership, parentage, subscriptions, instructions, and proximity do
not advance a ScopeExecution. Participation controls collaboration and access.
Ordinary Context pub/sub remains valid non-graph communication.

Every NodeExecution references an inspectable writable Context. Context policy
may create one, reuse one by a stable key, or enter a fixed persistent Context.
A NodeExecution does not imply a newly created Context.

## 3. Scope owns explicit immutable designs

A Scope is the stable outcome, organisation, lifecycle, and governance
boundary. Each semantic design is a ScopeCompositionRevision containing
NodePlacements, typed Ports, explicit Edges, bindings, activation policy,
Context policy, and semantic configuration.

A draft may change. Publication freezes it and selects it for new ingress.
Existing ScopeExecutions, callbacks, and retries remain pinned to the revision
under which they began. A later semantic change creates another revision.

Only enabled Edges advance a canonical ScopeExecution. Context relationships,
Event type matches, direct Actor requests, and Artefact lineage never imply an
Edge. A graph is a useful projection of one revision, not a separate
user-facing primitive.

## 4. Execution has canonical records

A ScopeExecution is one causally coherent activation under one pinned
ScopeCompositionRevision.

A NodeExecution is one logical activation of one NodePlacement. It records exact
Port-bound inputs, activation or join key, resolved Context, responsible Actors,
outputs, decisions, lifecycle, and failure state.

An ExecutionAttempt is one processing or infrastructure attempt within a
NodeExecution. Retry adds an attempt; it does not create another logical
activation.

Presentation state such as pan, zoom, node positions, and collapsed panels may
reference these records but cannot alter topology or execution.

## 5. Event, emit, and Delivery have distinct jobs

An Event is an immutable fact, signal, communication, observation, or decision.
It may start a ScopeExecution, satisfy a Port, record an output or decision, or
remain non-graph communication.

`emit` deliberately publishes non-graph communication or an explicitly
attached Port publication. A natural runtime completion is recorded in its
NodeExecution Context without automatically routing downstream.

A Delivery is the durable transport obligation for an Event and exact
ArtefactVersion references. It owns queue, lease, acknowledgement, expiry, and
cancellation state. It is transport, not logical execution.

A graph-routed Delivery pins the exact ScopeExecution, revision, source and
target NodePlacements and Ports, Edge, causal Event, NodeExecution, and
publication. Direct communication may have no ScopeExecution.

Once a Delivery enters a runtime it may already have caused effects. Loss of
runtime ownership becomes an unknown-outcome terminal failure and is never
silently replayed.

## 6. Turn results and direct requests do not change topology

A Turn is one Endpoint processing cycle for one Delivery, built from one origin
Context. Provider-private session state is ephemeral and cannot bleed unrelated
Context into the Turn.

A non-empty natural completion is stored in the target NodeExecution Context,
or the direct Delivery Context when no NodeExecution exists. It does not advance
a ScopeExecution. Only publication to a named output Port does that.

A direct Actor request remains non-graph delegation. Its exact result resumes
the same NodeExecution, Context, and pinned revision. Floe, not the model, owns
return identifiers and correlation.

## 7. Floe owns minimum universal Artefact identity

An Artefact is a stable logical input, output, collection, reference, or body of
evidence. An ArtefactVersion is one immutable state or exact externally pinned
observation.

Floe owns stable identity, exact-version provenance, lineage, collection
membership, access, retention, redaction, and tombstone metadata. A ContentRef
points securely to exact bytes owned by a filesystem, Git, object store,
provider, or another content store.

Extensions own domain schemas, metadata, specialised statuses, invalidation and
regeneration policy, and rich presentation. Extension lineage documents may be
legacy import evidence or projections; they are not a parallel identity ledger.
Artefact lineage and Scope topology never substitute for one another.

## 8. One semantic operation contract

The Bus owns one versioned definition and handler for each semantic operation:
description, effect, authority boundary, grants, schemas, availability,
preconditions, confirmation or approval, expected revision, idempotency,
execution, refusal, audit, and receipt.

App, Actor, CLI, SDK, API, and MCP clients consume suitable projections of that
same definition and invoke the same handler. Presentation may differ; semantics
cannot. Existing raw mutation routes must delegate to the semantic handler or
become authenticated internal routes.

Principal, Workspace or host boundary, grants, interaction mode, and causal
provenance come from the authenticated transport or active Delivery. Request
content cannot claim them. Every consequential invocation produces a stable
operation receipt that can be queried after timeout or reconnection.

## 9. Workspace identity and authority cross explicit boundaries

A Workspace has a stable opaque identity independent of its path or host. An
absolute path is a replaceable host-local Workspace locator binding. Moving or
restoring retains identity; copying or forking creates a new identity with
source provenance.

CapabilityGrants give an authenticated principal exact semantic operations
inside an explicit Workspace or host boundary. Host authority and Workspace
authority are not interchangeable.

HTTP credentials use the authorization header and never enter URLs or logs. A
WebSocket authenticates in its first frame and receives no state before success.
Push updates are filtered to the authenticated boundary and resume from a
durable cursor.

Reusable credential material stays behind an operating-system or deployment
credential broker. Canonical records contain SecretRef metadata, never secret
bytes. Missing credentials remain visible unresolved bindings.

## 10. Chat and pipeline views are projections

A chat renders selected Context Events and collaboration state. A Scope view
renders one published composition revision and canonical execution records.
An Artefact view renders exact-version provenance.

These are projections over the same canonical records. A client may add
purposeful interaction and presentation, but cannot become another ledger,
infer topology from activity, or own separate validation and authority rules.

## 11. Pi and other runtimes stay behind the runtime boundary

Runtime-specific message, tool, and session assumptions remain inside their
runtime adapter. Code above that boundary works with Floe Events, Deliveries,
Contexts, execution records, semantic operations, and Artefact references.

The default Floe Actor follows the same Actor, authority, Delivery, runtime, and
operation contracts as any other Actor. It is distinguished by its current
definition and assignment, not a privileged technical path.

## 12. Extensions add opinionated capability, not competing substrate state

An Extension may contribute Capabilities, Commands, Connectors, schemas,
templates, Actor definitions, previews, renderers, dashboards, or bounded
product surfaces. It declares permissions, isolation, version, approval, and
rollback.

Workspace installation remains under `.floe/extensions/NAME/`; canonical source
may live in an independent repository or package. An Extension does not create
parallel Context, topology, Artefact identity, authority, or operation
contracts.

## 13. Work logs are audit projections

A Work Log is committed Markdown evidence for a runtime Turn. It may summarise
cause, timing, meaningful tool activity, emitted Events, outcome, and Artefact
references. It must exclude secrets, credentials, unbounded telemetry, and huge
raw outputs.

A Work Log is not communication, topology, execution state, or an Artefact
identity ledger.

## 14. Implementation rules

- Use Context for collaboration, never routing.
- Use NodePlacement for design and NodeExecution for activity.
- Store semantic routes as Ports and Edges in an immutable published revision.
- Keep retry inside one NodeExecution; make redo an explicit new execution.
- Record natural completion in the origin Context; publish named Port output to
  advance graph work.
- Keep direct `emit` and `request` as deliberate non-graph communication.
- Invoke one Bus-owned semantic operation contract from every client.
- Derive authority from authenticated transport, never request content.
- Keep reusable secret material outside presentation code and canonical state.
- Read current plan and execution from canonical records, never inferred Event
  or subscription patterns.
