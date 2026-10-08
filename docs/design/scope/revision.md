# Revision

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

Canonical name: **ScopeCompositionRevision.** One exact design of a
[Scope](scope.md). It contains [placements](placement.md), [Ports](port.md),
[Edges](edge.md), bindings, instructions, activation policy, Context policy and
configuration.

A draft is mutable. Publishing makes the revision immutable and atomically
selects it for new ingress. Existing executions stay pinned to the revision they
started with.

Pan, zoom, node position and collapsed panels are
[presentation state](../host/surface/presentation-state.md) and never create a
revision.
