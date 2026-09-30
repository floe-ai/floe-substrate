# Node placement

**A NodePlacement is one resource's configured place in an exact [[Scope]] design.**

The interface may shorten this to **node**. The canonical record is a
NodePlacement inside one immutable `ScopeCompositionRevision`. It references an
existing resource; it does not replace that resource's identity.

A NodePlacement is design, not work. One activation of it is a NodeExecution.
Every NodeExecution records its exact inputs, responsible [[Actor]]s, resolved
[[Context]], attempts, outputs, decisions, and failure state.

## What can be placed

A NodePlacement may reference an Actor, Context, [[Command]], Capability,
Connector, Event boundary, or nested Scope. The placement adds only the
configuration needed in that revision, such as bindings, instructions,
activation policy, and Context policy.

## Ports and Edges

Each placement exposes stable typed input and output Ports. A Port may carry a
control [[Event]], exact [[Artifact|ArtefactVersion]] references, or both.

An Edge is an explicit stored connection from one output Port to one input Port
in the same revision. Enabled Edges are the only routes that advance a canonical
ScopeExecution. Context membership, subscriptions, prompts, observed history,
direct Actor requests, and Artefact lineage never imply an Edge.

Branching is one output Port connected to several input Ports. Convergence is
several Edges satisfying one placement's activation contract. These are
topology, not special node kinds.

## Output shape

An output Port may declare a `schema`: a JSON Schema every publication's
content must satisfy. A publication that does not match is refused, naming the
fields, for example `output does not match Port 'verdict' schema: /text must
match pattern "^(PASS|FAIL|UNSURE)\b"`. A schema that cannot be compiled is
refused when the route is saved or published.

A turn's reply handed on as a step's only required output arrives as
`{"text": "..."}` and is checked the same way. If it does not match, the Actor's
one reminder says why; if the output is still missing after it, the step fails
with that reason.

`schema_ref` is only a name for the contract, matched against a Command's
`$ref`. It is not enforced on its own.

## Separation of duties

An Actor node may declare `distinct_actor_from`: other Actor nodes whose Actor
must differ from its own, for example a judge that must never be a builder.
A route that breaks it is refused when saved, when published, and when started.

## Context policy

Every NodeExecution references an inspectable writable Context. The placement's
Context policy may create one, reuse one by a stable key, or enter a fixed
persistent Context. A NodeExecution does not require a newly created Context,
and a Context is never the connection between placements.

## Implementation

- `floe-bus/src/scope-compositions.ts` — immutable revisions, NodePlacements,
  Ports, and Edges
- `floe-bus/src/scope-executions.ts` — ScopeExecution, NodeExecution, and
  ExecutionAttempt records
- `floe-bus/src/scope-operations.ts` — canonical composition and execution
  operations
- `floe-bus/src/scope-graphs.ts` — legacy mutable graph import and inspection;
  not the canonical authoring or execution model

See [[Glossary]].
