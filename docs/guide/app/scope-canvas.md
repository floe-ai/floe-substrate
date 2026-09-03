# The scope canvas

An active [[Scope]] appears under **Organised work**. Opening it shows the
currently published plan and the execution evidence that followed that exact
plan.

## What it shows

- NodePlacements for the resources used by the published
  ScopeCompositionRevision.
- Typed Ports and explicit enabled Edges between them.
- Current resource availability and attention state.
- ScopeExecutions pinned to the revision under which they began.
- NodeExecutions at the selected placement, including exact inputs, outputs,
  resolved [[Context]], attempts, and failure state.
- Exact ArtefactVersion references produced or consumed by execution.

Following one connected placement reveals its immediate upstream and downstream
relationships. Selecting a NodeExecution opens its real Context history. The
app does not create Contexts merely to display the plan.

## Plan, execution, and presentation stay separate

The plan comes from the published ScopeCompositionRevision. Execution comes
from ScopeExecution and NodeExecution records. Conversation comes from the
Context referenced by the NodeExecution. Artefact lineage comes from exact
ArtefactVersion relationships.

The app must not reconstruct topology from Context subscriptions, Event types,
observed emissions, or Artefact lineage. Those relationships answer different
questions.

Pan, zoom, node positions, collapsed panels, and the current selection are
presentation state. Saving them does not create a semantic revision.

## Revisions and retirement

A semantic edit begins or changes a draft. Publishing makes that revision
immutable and selects it for new ingress. Existing executions remain pinned to
their original revision, so history stays explainable.

A retired Scope is inert and hidden from normal operator navigation while
remaining inspectable through Developer tools. Developer tools are an
observatory, not a second authoring or execution contract.

## Implementation

- `floe-app/src/features/work/ScopeWorkView.tsx` — operator Scope projection
- `floe-app/src/features/work/ScopePipelineFocusView.tsx` — focused topology
  and execution navigation
- `floe-bus/src/scope-compositions.ts` — canonical revisions, placements,
  Ports, and Edges
- `floe-bus/src/scope-executions.ts` — canonical execution evidence
- `floe-bus/src/scope-operations.ts` — shared plan and execution operations
- `floe-bus/src/scope-graphs.ts` — legacy compatibility only
