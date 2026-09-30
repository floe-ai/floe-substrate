# Scope

**A Scope is the durable outcome, organisation, lifecycle, and governance boundary for organised work.**

A Scope owns its exact designs, executions, related Contexts and Artefacts,
policies, budgets, attention state, and history. It is the stable operator-facing
identity even as its design changes.

## Composition revisions

Each semantic design is a `ScopeCompositionRevision`. It contains
NodePlacements, typed Ports, explicit Edges, bindings, instructions, activation
policy, Context policy, and semantic configuration.

A draft revision may change. Publishing freezes that revision and atomically
selects it for new ingress. A later semantic change creates another revision.
Existing ScopeExecutions, callbacks, and retries remain pinned to the revision
under which they began. Redo is an explicit new execution and may select the old
or current published revision.

Pan, zoom, node position, and collapsed panels are client presentation state.
They do not create a semantic revision.

## Explicit topology

An Edge is a stored connection from one output Port to one input Port. Enabled
Edges are the only routes that advance a canonical ScopeExecution. Context
membership, Event type matches, subscriptions, direct Actor requests, and
Artefact lineage are separate relationships.

There is no separate user-facing Graph primitive. A graph is a useful
visualisation of one ScopeCompositionRevision, not another source of truth.

## Execution and history

A ScopeExecution is one activation pinned to one published revision. Each
NodeExecution records the exact placement, Port-bound inputs, Context, attempts,
outputs, and state. This lets the operator inspect the current plan and the work
that followed it without reconstructing either from Event traffic.

Retiring a Scope makes it inert while preserving evidence. Removal is allowed
only when no required history or active work would be destroyed.

## Legacy graphs

Legacy mutable Scope graphs and subscription-derived routing are migration
input. They may be inspected as identified legacy revisions, but new and
republished designs use explicit Edges. Legacy raw graph routes are
compatibility/internal routes, not a second authoring contract.

## Implementation

- `floe-bus/src/scope-compositions.ts` — immutable composition revisions,
  NodePlacements, Ports, and Edges
- `floe-bus/src/scope-executions.ts` — canonical execution records
- `floe-bus/src/scope-operations.ts` — canonical plan and execution operations
- `floe-bus/src/scope-graphs.ts` — isolated legacy graph compatibility

See [[Glossary]].
