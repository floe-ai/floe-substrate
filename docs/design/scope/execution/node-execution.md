# Node execution

_Resolution: settled_
_Built: partly_
_Authority: agent-provisional_
_Authored by: unknown_

Canonical name: **NodeExecution.** One logical activation of one
[placement](../placement.md) within a [ScopeExecution](scope-execution.md). It
records exact Port-bound inputs, join or activation key, resolved Context,
assigned Actors, lifecycle, [attempts](attempt.md), outputs, decisions and
failure state. The NodeExecution itself is the record of the run.

## When a run has a Context

_Resolution: settled_
_Built: no_
_Authority: operator-confirmed (9 Oct ruling)_
_Authored by: operator_

A Context exists only when it is meant to have members
([primitives](../../pillars/primitives.md)). A run with Actors uses a Context:
a fixed one, or one reused by key. A Command run with no Actors has no Context.

Today every NodeExecution gets a Context, and a Command run gets a new empty one
(`floe-bus/src/store.ts`, `resolveExecutionContext`).
