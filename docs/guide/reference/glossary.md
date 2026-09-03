# Glossary

Canonical terms used across the guide. `CONTEXT.md` remains authoritative.

## Actor

An entity permitted to perceive, decide, communicate, and act within declared
responsibility and authority. Its runtime backing does not change its identity
or Scope semantics. See [[Actor]].

## ActorDefinitionRevision

An immutable revision of an Actor's charter, instructions, trust policy,
budgets, and capability grants.

## Artefact

A stable logical input, output, collection, reference, or body of evidence.
Floe owns identity and exact-version provenance; extensions own domain meaning
and presentation. See [[Artifact|Artefact]].

## ArtefactVersion

One immutable state of an Artefact or exact externally pinned observation.
There is no universal mutable current version.

## Binding

A replaceable association between a resource and configuration such as a
runtime profile. A binding is not the resource's identity. See [[Binding]].

## Bridge

The service that receives authorised Deliveries and runs the appropriate Actor,
Command, Connector, or runtime adapter.

## Bus

The authoritative substrate service. It owns canonical records, semantic
operation definitions, authority checks, receipts, and authenticated
projections. See [[Bus API]].

## Capability

A discoverable semantic operation or reusable implementation available under
authority. One Bus-owned definition serves app, Actor, CLI, SDK, API, and MCP
clients.

## CapabilityGrant

A durable, revocable, expiring grant allowing one principal to invoke exact
operation IDs within an explicit Workspace or host boundary.

## Command

A deterministic executable operation with declared inputs, outputs, side
effects, permissions, timeout, idempotency, and implementation. See [[Command]].

## ConnectorDefinition and ConnectorBinding

A typed external Event source or action, and its Workspace-specific
configuration. Folder, webhook, schedule, API, and legitimate polling sources
use this contract.

## ContentRef

A typed secure reference to exact content held by a filesystem, Git, object
store, document provider, database snapshot, or another content store.

## Context

The durable place where participants understand, discuss, and record work.
Context is collaboration, never pipeline routing. See [[Context]].

## Context participant

An Actor with an explicit role and access relationship to a Context.
Participation controls collaboration and authority; it does not create an Edge.

## Context subscription

Ordinary pub/sub for non-graph communication and an identified legacy-routing
index. A canonical ScopeCompositionRevision never dispatches through a Context
subscription.

## Delivery

Floe's durable obligation to transfer an Event and exact ArtefactVersion
references to an Endpoint or input Port. It is transport, not logical execution.
See [[Delivery and Turn]].

## Edge

An explicit stored connection from one output Port to one input Port within one
ScopeCompositionRevision. Enabled Edges are the only routes that advance a
canonical ScopeExecution.

## Emit

The publish operation for deliberate non-graph communication or for an
explicitly attached Port publication. A natural runtime response does not
automatically route downstream.

## Endpoint

An addressable delivery interface used by an Actor, Command, Connector, service,
or another runtime. Endpoint is not a type of identity. See [[Endpoint]].

## Event

An immutable fact, signal, communication, observation, or decision that landed
in Floe. It may start execution, satisfy a Port, record an output, or remain
non-graph communication. See [[Event]].

## Event Cursor

An opaque ordered position in a Workspace Event or push stream. Cursor-based
catch-up resumes a client without periodic full-state refresh.

## ExecutionAttempt

One processing or infrastructure attempt within a NodeExecution. Retry creates
another attempt without inventing another logical NodeExecution.

## Extension

A versioned package that contributes Capabilities, Commands, Connectors,
schemas, templates, Actor definitions, previews, or bounded product surfaces
under declared permissions, isolation, approval, and rollback. See
[[Extension]].

## ExternalEffectReceipt

The durable record of an attempted action outside Floe, including exact input,
target, idempotency identity, provider receipt, and known, failed, or uncertain
outcome.

## Hook

An extension-supplied handler at a runtime lifecycle point. A Hook does not
create another routing system. See [[Hook]].

## NodePlacement

The configured placement of an Actor, Context, Command, Capability, Connector,
Event boundary, or nested Scope inside one ScopeCompositionRevision. It is
design, not work. See [[Node|Node placement]].

## NodeExecution

One logical activation of one NodePlacement within a ScopeExecution. It records
exact Port-bound inputs, resolved Context, responsible Actors, attempts, outputs,
decisions, and failure state.

## Operation receipt

The stable result of one idempotent semantic operation invocation. A client
reconnects to the receipt instead of guessing whether an operation committed.

## Port

A stable typed input or output interface on a NodePlacement. It may carry a
control Event, exact ArtefactVersion references, or both.

## Presentation state

Client-owned arrangement such as pan, zoom, node positions, collapsed panels,
and selected tabs. It cannot change topology, identity, execution, or authority.

## Projection

A read-only view derived from canonical records. A projection is never another
ledger.

## Pulse

Bus-owned scheduled Event creation. A Pulse is scheduling, not liveness or a
separate routing system.

## Scope

The durable outcome, organisation, lifecycle, and governance boundary for
organised work. See [[Scope]].

## ScopeCompositionRevision

One exact semantic design of a Scope. A draft may change; publication makes it
immutable and selects it for new ingress.

## ScopeExecution

One causally coherent activation of a Scope pinned to one published
ScopeCompositionRevision.

## SecretRef

A metadata-only reference to credential material held by an operating-system or
managed credential broker. Reusable secret bytes do not enter normal records,
Events, Contexts, exports, or logs.

## Session

A private, ephemeral runtime construct for one Actor and origin Context. It is
not the Context and is not persisted as collaboration history.

## Turn

An Endpoint processing cycle for one Delivery, built from one origin Context.
Its natural completion is recorded in that Context and does not advance a
ScopeExecution. See [[Delivery and Turn]].

## Work Log

A committed Markdown audit projection for a runtime Turn. It is evidence, not
execution state, topology, or communication.

## Workspace

The portable identity and isolation boundary for Actors, Contexts, Scopes,
Artefacts, authority, and history. A filesystem path is a host-local locator
binding, never Workspace identity. See [[Workspace]].

## Workspace locator binding

A replaceable association between a Workspace and one absolute path on one
host. Superseded bindings remain evidence.

---

## Retired or legacy terms

| Term | Current meaning |
|---|---|
| Field | A Scope is rendered as itself; there is no separate renderer primitive. |
| Default Scope | Does not exist. A Context is anchored by participants, a Scope, or both. |
| trigger as a node kind | Legacy storage wording for an Event boundary or Connector ingress. |
| named graph / `graph_id` | Legacy mutable-composition handle. Current design is an immutable ScopeCompositionRevision. |
| read receipt | Use an Event Cursor, operation receipt, or product-specific attention state. |
| Thread as a primitive | Use Context in new domain contracts. |
| working space node | Legacy placement wording. Use a NodePlacement that references its resource. |
