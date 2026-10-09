# Scope

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

The durable outcome, organisation, lifecycle and governance boundary presented
to the operator as organised work. A Scope owns draft and published
[revisions](revision.md), [executions](execution/scope-execution.md), related
Contexts and Artefacts, policies, budgets, attention state and history. A Scope
is optional: Floe works without one (see [experience](../pillars/experience.md)).

Retirement makes a Scope inert while keeping evidence. Removal is allowed only
when no required history or active work would be destroyed.

Only explicit [Edge](edge.md) traversal advances canonical graph work. One
Scope can hold several separate chains of nodes, and other Scopes as nodes
(operator ruling, 9 Oct).

Avoid: graph as a separate product primitive, canvas, universal fallback bucket.
Do not introduce `Work`, `Job`, `WorkItem`, `NodeRun`, `HumanGate`, `Split`,
`Gather` or user-facing `Graph` as new primitives.

Origin: agent ADR-0010 (4 Sep).

## What a Scope is not

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed (ADR-0004, May; ADR-0008, Aug; 9 Oct ruling: decisions from August and earlier stand)_
_Authored by: operator_

- There is no fallback Scope. Work without a Scope stays in the Workspace.
  Workspace Home is a view over the Workspace, not a Scope. The id `default`
  cannot be used for a Scope.
- A webhook or other [Event source](../event/source/source.md) gets its Scope
  from its own configuration, never from the incoming payload.
- A graph is not a primitive. It is the picture of a Scope's nodes and how they
  connect. What will happen is the nodes; what has happened is in the records.
- The old `trigger` node is retired: it is an Event node with a source.

## Legacy

Old mutable Scope graphs may be imported and inspected. New or republished
compositions use stored Edges only.
