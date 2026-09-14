# Floe Substrate - Domain Context

This document defines current Floe terminology and invariants. `MISSION.md` owns
purpose, `PRODUCT.md` owns the operator experience, and accepted ADRs own the
reason a lasting technical decision was made.

## Glossary

### Workspace

The top-level portable identity and isolation boundary for an organisation's
Actors, Contexts, Scopes, Artefacts, authority, and history.

A Workspace has a stable opaque `workspace_id`. A filesystem path is a
host-local **Workspace locator binding**, never its identity. Moving or rebinding
retains the Workspace identity. Restoring an export retains it. Copying or
forking creates a new Workspace identity with source provenance. Remote
projections never expose host paths, binding IDs, or host identity.

_Avoid_: path-derived Workspace ID, path as identity, locator in a remote
projection.

### Workspace locator binding

A replaceable association between one Workspace and one absolute path on one
host. It owns local attachment, selection, configuration, and compare-and-swap
revision state. Superseded bindings remain evidence. A callback must name the
exact binding it began under; a late callback cannot update a replacement
binding.

### Portable Workspace package

A versioned, deterministic transfer representation of one retained Workspace
identity and its canonical evidence. It carries immutable revisions, execution
and Delivery history, Context material subject to retention, Artefact lineage,
exact reachable content, and safe authority references. It never carries host
locator bindings, reusable credential material, authority sessions, Bridge or
worker attachments, or other host-local state.

Restore retains canonical IDs and historical states, binds a new host-local
Workspace locator, and creates a separate restore hold. SecretRefs and other
host dependencies remain unresolved until exact new target-host evidence is
reconciled. Imported operation receipts can never prove that reconciliation.
Reactivation is an explicit governed operation after every dependency resolves.

A portable Workspace package is a transfer format, not a new substrate
primitive and not an opaque backup of one host.

### Scope

The durable outcome, organisation, lifecycle, and governance boundary presented
to the operator as organised work. A Scope owns draft and published
ScopeCompositionRevisions, ScopeExecutions, related Contexts and Artefacts,
policies, budgets, attention state, and history.

Retirement makes a Scope inert while preserving evidence. Removal is allowed
only when no required history or active work would be destroyed.

_Avoid_: graph as a separate product primitive, canvas, universal fallback
bucket.

### ScopeCompositionRevision

One exact semantic design of a Scope. It contains NodePlacements, Ports, Edges,
bindings, instructions, activation policy, Context policy, and semantic
configuration. A draft is mutable. Publication makes the revision immutable and
atomically selects it for new ingress. Existing ScopeExecutions stay pinned to
their starting revision.

Pan, zoom, node position, and collapsed panels are client presentation state and
do not create a semantic revision.

Legacy mutable Scope graphs are retained migration input. They are not the
canonical authoring or execution model.

### NodePlacement

The graph-local representation and configuration of an Actor, Context, Command,
Capability, Connector, Event boundary, or nested Scope within one
ScopeCompositionRevision. It references that resource; it does not replace its
identity.

A NodePlacement is design, not work. Runtime activity is represented by a
NodeExecution.

### Port

A stable typed input or output interface on a NodePlacement. It may carry a
control Event, exact ArtefactVersion references, or both. Required cardinality,
schema compatibility, collection role, and output identity policy belong to the
Port contract.

### Edge

A stored connection from one output Port to one input Port in one
ScopeCompositionRevision. Enabled Edges are the only routes that advance a
canonical ScopeExecution. Publishing one output traverses every enabled outgoing
Edge exactly once logically.

Context membership, Event type matches, prompts, observed history, direct Actor
requests, and Artefact lineage never imply an Edge.

### ScopeExecution

One causally coherent activation of a Scope under one pinned
ScopeCompositionRevision. It records root ingress, exact initial Event and
ArtefactVersion references, status, initiator, environment, children, budget,
terminal outcome, cancellation, and redo lineage.

It is an execution record, not a new Workspace primitive.

### NodeExecution

One logical activation of one NodePlacement within a ScopeExecution. It records
exact Port-bound inputs, join or activation key, resolved Context, assigned
Actors, lifecycle, attempts, outputs, decisions, and failure state.

Every NodeExecution references an inspectable writable Context. Context policy
may create a Context, reuse one by key, or enter a fixed persistent Context.

### ExecutionAttempt

One processing or infrastructure attempt within a NodeExecution. Retry creates
another ExecutionAttempt without inventing another logical NodeExecution.
Runtime, model, instructions, tools, Extension versions, resource use, result,
error, and evidence belong to the attempt.

### Context

The durable place where participants understand, discuss, and record work. It
contains conversation, attached evidence, relevant references, decisions,
summaries, and exact relationships to ArtefactVersions and execution records.

Context is collaboration, never pipeline wiring. Membership, parentage,
subscriptions, instructions, and proximity cannot advance a ScopeExecution.

A Context may be a direct conversation, a processing space, a persistent Actor
workspace, or a Scope overview. It may be anchored by participants, a Scope, or
both. A Context with neither anchor is invalid.

_Avoid_: channel as topology, room as routing table, Thread in new domain
contracts.

### Context participant

An Actor with an explicit role and access relationship to a Context.
Participation controls collaboration and authority; it does not create an Edge.

### Context subscription

Ordinary pub/sub for non-graph communication and a retained index for explicitly
legacy compositions. A canonical ScopeCompositionRevision never dispatches by
Context subscription, and one revision can never use both legacy subscription
routing and Edge routing.

### Event

An immutable fact, signal, communication, observation, or decision that landed
in Floe. It records source, time, Workspace, causation, correlation, schema,
small payload facts, and zero or more exact ArtefactVersion references.

Those version references are recorded when the Event is emitted. Later Artefact
associations describe relationships to that Event; they cannot change its input
or attachment references. Legacy Event references frozen during schema 12's
upgrade retain their then-visible projection with explicit metadata provenance;
that snapshot is not evidence of which versions were present at original emission.

An Event can start an execution, satisfy a Port, record an output or decision,
or remain non-graph communication. Arbitrary Event content is not automatically
an Artefact.

Context communication may carry optional `content.references` entries with
`name` and `resource_ref: { kind, id, revision }`. The reference uses the existing
semantic-operation resource shape; a null revision means no exact revision was
supplied. It is navigation supplied by the message author, not an assertion of
current state, authority, approval or an instruction to execute an operation.
Clients retain the selected Workspace boundary and discover current actions when
opened. Model input retains these references alongside the message text.
Exact saved content continues to use ArtefactVersion attachments and canonical
Event membership. A named reference does not create an Artefact association.

### Emit

The substrate publish operation for deliberate non-graph communication or for
an explicitly attached Port publication. A natural runtime response is recorded
in its NodeExecution Context without automatically routing downstream.

### Delivery

Floe's durable obligation to transfer an Event and exact ArtefactVersion
references to an Endpoint or input Port. Delivery owns queue, lease,
acknowledgement, transport attempt, expiry, and cancellation state. It is
transport, not logical execution.

A graph-routed Delivery pins ScopeExecution, ScopeCompositionRevision, source
and target Node/Port, Edge, causal Event, NodeExecution, and publication. Root
ingress and continuation callbacks may have no Edge, but still pin their exact
revision and NodeExecution. Direct conversations and direct Actor requests may
have no ScopeExecution.

Once a Delivery enters a runtime it may already have caused effects. Loss of
runtime ownership becomes a terminal unknown-outcome failure and is never
silently replayed.

### Turn

An Endpoint processing cycle for one Delivery built from one origin Context. A
non-empty natural completion is stored in the target NodeExecution Context, or
the direct Delivery Context when no NodeExecution exists. It does not advance a
ScopeExecution. Only publication to a named output Port does that.

When an Actor directly requests another Actor during a NodeExecution, the
request remains non-graph delegation. Its exact result resumes the same
NodeExecution, Context, and pinned revision. The model does not manage return
identifiers.

### Actor

An entity permitted to perceive, decide, communicate, and act within declared
responsibility and authority. Human, local-model, hosted-model, deterministic
service, and future runtime backing do not change Actor identity or graph
semantics.

An Actor has stable identity, a versioned ActorDefinitionRevision, and a
separately replaceable runtime binding. Assignment to a NodePlacement or Context
controls responsibility and access, never routing.

An authenticated principal backs an Actor only through a retained Principal–Actor
binding with exact evidence. A runtime self-binding is derived by the Bus from
the exact ActorDefinitionRevision and Actor runtime binding pinned by an active
Delivery; request content cannot claim it, and revocation is never restored
implicitly. Workspace and Scope roles use explicit retained Actor role
assignments. Context roles use the retained assignment referenced by canonical
Context participation. An executor role at a NodePlacement or NodeExecution is
valid only with its exact ScopeCompositionRevision and revision-local node ID.
Roles may qualify a Policy or Approval decision, but never grant an operation or
advance work.

Publishing an assigned Actor's output resolves the authenticated principal's
current retained binding and executor evidence against the exact NodeExecution.
Identifier equality is not authority. The Event records the assigned Actor as
publisher and retains the authenticated principal separately. Runtime-origin
restrictions and operation grants still apply.

### Endpoint

An addressable delivery interface used by an Actor runtime, authenticated
Command worker, Connector, service, or other runtime. Endpoint is not a type of
identity and no backing is privileged. A Command never masquerades as its own
Endpoint: its stable identity and immutable definition are separate from the
host-local worker Endpoint that executes it. A retired Endpoint keeps
historical references but receives no new Delivery.

### ActorDefinitionRevision

An immutable revision of an Actor's charter, responsibilities, knowledge,
budgets, trust policy, instructions, capability grants, and escalation rules.
Each ExecutionAttempt records the revision and runtime binding it actually used.

### Command

A deterministic executable operation with declared inputs, outputs, side
effects, permissions, timeout, idempotency, and implementation. A Command
executes a defined operation; an Actor can interpret, choose, converse, and
delegate.

A stable Command points to its currently published immutable
CommandDefinitionRevision. Publication of a ScopeCompositionRevision validates
the referenced Command and exact Port contracts. A NodeExecution pins the
CommandDefinitionRevision and authenticated worker binding it began with, and
every retry retains those pins even if the Command head changes or retires.

The Bus persists the exact processing contract for each ExecutionAttempt and
dispatches it to an isolated Command host. Implementations are exact core or
Extension version references. Filesystem, network, secret, and external action
access is available only through granted canonical operations and brokers.
Command output can advance stored Edges only through a named Port using
`scope.node-output.publish`.

### Artefact

A stable logical thing produced, consumed, discussed, revised, assembled,
tested, approved, or derived by work. Examples include a document, concept
image, child image, collection, source tree, website, report, decision, or
deployable package.

Floe owns stable identity, type, access and retention state, creation
provenance, and the version graph. Extensions own domain schemas, metadata,
specialised statuses, invalidation policy, regeneration policy, and rich
presentation.

_Avoid_: mutable file path as identity, Event payload as identity,
Extension-owned identity ledger.

### ArtefactVersion

One immutable state of an Artefact or exact externally pinned observation. It
has a canonical version ID, digest or provider-guaranteed revision, media type,
schema, typed ContentRef, provenance, exact lineage, membership, and Context or
execution associations.

There is no universal mutable `current_version`. Branches may have multiple
heads. Current, approved, stale, or domain status is a policy-governed annotation
or projection.

### ContentRef

A typed secure reference to exact content held by the filesystem, Git, object
storage, document provider, database snapshot, or another content store. Floe
does not need to copy large bytes when a verified immutable reference is
sufficient.

Publishing a local Workspace file through the canonical operation verifies its
digest and size, retains those bytes in the Workspace content store, and records
that retained reference. Later edits to the source file cannot change the
published version. Externally pinned revisions keep their resolver contract.

### Capability

A discoverable semantic operation or reusable implementation available under
authority. Its Bus-owned definition supplies one versioned contract for app,
Actor, CLI, SDK, API, and MCP clients.

### CapabilityGrant

A durable, revocable, expiring grant from an issuer to one principal for exact
semantic operation IDs within one explicit authority boundary: a Workspace or
a host. A grant may also be restricted to exact resources. Authority sessions
reference CapabilityGrant IDs and resolve their current state on every
invocation; they never copy operation strings as authority.

### Policy

A stable governance identity with immutable published Policy revisions and
exact revocable bindings to a Workspace, Scope, Actor, ConnectorBinding,
Extension installation, or one NodePlacement in one ScopeCompositionRevision.
A Policy can deny, require approval, or limit resource use; it cannot create
authority that a CapabilityGrant does not provide.

Every Policy decision retains the normalized facts and exact Policy revisions
that were evaluated. Actor roles come from retained Actor assignments, never a
role claimed in an operation request.

### Budget reservation and resource use

A Budget reservation atomically holds estimated use against every applicable
Policy limit before work starts. Completion records measured use; a failed
action releases its reservation; uncertain external effects remain reserved
until reconciliation proves the outcome. Workspace, Scope, Actor, Connector,
Extension, and exact revision-local NodePlacement limits remain independent and
all apply when relevant.

### ApprovalRequest and ApprovalReceipt

An ApprovalRequest binds an exact action, inputs, evidence, composition
revision, Policy decision, eligible decision set, and expiry. Named, all-named,
quorum, and role-based decisions are retained individually. Only a terminal
approved decision creates an ApprovalReceipt, and changed action or authority
invalidates it before use.

A pending request may explicitly select one existing participant in its Context
to receive the resolved decision. This response choice changes neither the bound
action nor its Policy. The decision and its delivery obligation are retained
together; partial collective votes and replayed decisions do not create another
response. A removed or unavailable recipient does not prevent the decision and
receives no content. Scope decision bindings continue to use their stored Ports
and Edges independently.

Resuming an operation after approval retains that invocation's original causal
provenance. A new authenticated Delivery does not replace the origin of the same
intent. Current authority, interaction mode, target, roles, Policy, inputs and
exact approval are revalidated before execution. A decision can carry the safe
retry identity of its awaiting operation, never its invocation inputs or secrets.

### Audit record

An immutable request and outcome record for one semantic operation. It retains
the authenticated principal and grants, exact target, input and state digests,
Policy and Budget references, provenance, changed references, refusal, and
affected ArtefactVersions without copying secret values.

### SecretRef

A stable metadata-only reference to credential material held by an operating
system or managed credential broker. Floe records resolution and an opaque
broker binding, never reusable secret bytes.

Secret use requires a current CapabilityGrant targeting the exact SecretRef and
resource plus credential-specific purpose constraints. Export contains only
unresolved SecretRef metadata. Missing credentials remain unresolved bindings.

### ConnectorDefinition and ConnectorBinding

A ConnectorDefinition describes a typed external Event source or action. A
ConnectorBinding configures it for one Workspace using SecretRefs, schemas,
idempotency, health, and policy. Webhook, folder, schedule, API, and legitimate
polling sources use this contract.

### ExternalEffectReceipt

The durable record of an attempted action outside Floe, including exact input,
target, idempotency identity, provider receipt, and known, failed, or uncertain
outcome. An uncertain effect pauses for reconciliation instead of blind retry.

### Pulse

Bus-owned scheduled Event creation. A Pulse is a scheduling mechanism, not a
heartbeat, liveness loop, or separate routing system. In canonical execution a
Pulse is bound through a schedule Connector and explicit ingress Port.

### Extension

A versioned package that can contribute Capabilities, Commands, Connectors,
schemas, templates, Actor definitions, previews, renderers, dashboards, or
bounded product surfaces under declared permissions, isolation, approval, and
rollback. Workspace installation remains under `.floe/extensions/NAME/`;
canonical source may live in an independent repository or package.

Extension source executes through the isolated Extension host. The Bridge does
not import package source or inject Extension tools into runtime sessions.
Filesystem, network, secret, and action access requires an exact declared
permission and current canonical authority; unavailable brokers fail closed.

### Projection

A read-only queryable view derived from canonical records. Organised Work,
Scope plan/execution, Artefact lineage, Context trees, attention, health, and
current heads are projections. A projection is never another ledger.

### Presentation state

Client-owned arrangement such as pan, zoom, node positions, collapsed panels,
and selected tabs. Presentation state may reference canonical IDs but cannot
change topology, identity, execution, or authority.

### Operation receipt

The stable result of one idempotent semantic operation invocation. It records
principal, authority context, exact target and revision, provenance, state,
changed references, refusal or required action, progress/cancel references, and
audit reference. A client reconnects to the receipt instead of guessing whether
an operation committed.

### Event Cursor

An opaque ordered position in a Workspace's Event or push stream. Cursor-based
catch-up prevents skipping or duplicating records after reconnect. It is not an
offset, page number, or periodic full-state refresh.

### Work Log

A committed Markdown audit projection for a runtime Turn. It is useful evidence,
not execution state, topology, an Artefact identity ledger, or the mechanism
that makes a response visible.

## Standing relationships

- A Workspace owns portable identity; each host owns its Workspace locator binding.
- A Scope owns immutable composition revisions and executions; it remains the user-facing organisation.
- A published ScopeCompositionRevision owns NodePlacements, Ports, and Edges.
- A ScopeExecution pins exactly one published revision for its complete causal life.
- A NodeExecution activates one NodePlacement and references one inspectable Context.
- An ExecutionAttempt belongs to one NodeExecution and may reference several joined Deliveries.
- A Delivery transports an Event and exact ArtefactVersion references; it does not replace NodeExecution.
- Only explicit Edge traversal advances canonical graph work.
- Context membership, subscription, and parentage remain collaboration relationships.
- Direct `emit` and `request` remain valid non-graph communication.
- Artefact lineage records exact version relationships; it is never pipeline topology.
- Content storage owns bytes; Floe owns identity, provenance, authority, and safe references.
- CapabilityGrant owns operation authority; SecretRef constraints narrow credential purpose without creating another grant lifecycle.
- Policy restricts granted authority; Budget, approval, and audit retain exact decisions and evidence rather than creating parallel permission paths.
- Clients project and invoke the same Bus-owned semantic operations; they do not own parallel validation or policy.
- Developer diagnostics may expose raw evidence, but normal operator work cannot depend on Developer tools.

## Legacy boundaries

- Legacy Scope graphs and Context subscriptions may be imported and inspected,
  but new or republished compositions use stored Edges only.
- Legacy extension lineage JSON may be imported idempotently as evidence; it is
  not a continuing source of Artefact identity.
- Legacy path-derived Workspace identifiers are retained as opaque identities
  during safe migration; new identities are opaque and path-independent.
- Legacy raw mutation routes must delegate to semantic operations or become
  authenticated internal routes. They are not a second public contract.
- Legacy `auth.json` is migration input. Secret material is transferred only
  through an explicit trusted broker action, verified, and preserved until
  separately approved cleanup.

## Settled naming

- Use **Workspace**, **Scope**, **Context**, **Actor**, **Event**, **Command**,
  and **Artefact** for substrate primitives.
- Use **ScopeCompositionRevision**, **NodePlacement**, **Port**, and **Edge** for
  composition records.
- Use **ScopeExecution**, **NodeExecution**, **ExecutionAttempt**, **Delivery**,
  and **ExternalEffectReceipt** for execution records.
- Use **Thread** only when describing legacy UI wording; new contracts use
  **Context**.
- Do not introduce `Work`, `Job`, `WorkItem`, `NodeRun`, `HumanGate`, `Split`,
  `Gather`, or user-facing `Graph` as new primitives. Existing records and
  Extension capabilities represent those behaviours.
