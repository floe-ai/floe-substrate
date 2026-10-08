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

Only explicit [Edge](edge.md) traversal advances canonical graph work.

Avoid: graph as a separate product primitive, canvas, universal fallback bucket.
Do not introduce `Work`, `Job`, `WorkItem`, `NodeRun`, `HumanGate`, `Split`,
`Gather` or user-facing `Graph` as new primitives.

Decisions: [ADR-0004](../../adr/0004-scope-as-substrate-organising-boundary.md),
[ADR-0010](../../adr/0010-canonical-scope-composition-execution-and-artefacts.md).

## Legacy

Old mutable Scope graphs may be imported and inspected. New or republished
compositions use stored Edges only.
