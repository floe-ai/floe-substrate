# Placement

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

Canonical name: **NodePlacement.** The graph-local representation and
configuration of an Actor, Context, Command, Capability, Event
or nested Scope within one [revision](revision.md). It references that
resource and never replaces its identity.

A nested Scope's inputs and outputs are described in
[Scope](scope.md#direction-a-scope-as-a-node-has-inputs-and-outputs). When a
placement starts is its [activation](activation.md).

A placement is design, not work. Activity is a
[NodeExecution](execution/node-execution.md).

A [Connector](../workspace/connector.md) is never placed; a Command or Event
node that supports it uses it (operator ruling, 9 Oct).

## Open

- Code still lists `connector` as a placement kind
  (`floe-bus/src/scope-compositions.ts`).
- Whether a Capability is a node is not decided.
