# Node execution

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

Canonical name: **NodeExecution.** One logical activation of one
[placement](../placement.md) within a [ScopeExecution](scope-execution.md). It
records exact Port-bound inputs, join or activation key, resolved Context,
assigned Actors, lifecycle, [attempts](attempt.md), outputs, decisions and
failure state.

Every NodeExecution references one inspectable, writable Context. Context policy
may create a Context, reuse one by key, or enter a fixed persistent Context.

## Open

- "Every NodeExecution references one Context" clashes with
  [primitives](../../pillars/primitives.md) (operator ruling, 9 Oct): a Context
  exists only when it is meant to have members, so a Command run needs none.
