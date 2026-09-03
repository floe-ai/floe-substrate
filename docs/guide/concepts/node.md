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
