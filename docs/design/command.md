# Command

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

A deterministic executable operation with declared inputs, outputs, side
effects, permissions, timeout, idempotency and implementation. A Command runs a
defined operation; an [Actor](actor/actor.md) can interpret, choose, converse
and delegate.

A Command points to its current published immutable CommandDefinitionRevision.
Publishing a Scope revision validates referenced Commands and exact Port
contracts. A NodeExecution pins the Command revision and worker binding it began
with; every retry keeps those pins even if the Command changes or retires.

The Bus stores the exact processing contract for each attempt and dispatches it
to an isolated Command host. Implementations are exact core or Extension version
references. Filesystem, network, secret and external access goes only through
granted operations and brokers. Command output advances Edges only through a
named Port using `scope.node-output.publish`.

## Direction: repeated work becomes a Command

_Resolution: direction_
_Built: partly_
_Authority: agent-provisional_
_Authored by: operator (thought log, June)_

When an Actor meets a deterministic, repeatable step (a calculation, a
transformation, a check), it builds or reuses a Command for it instead of
reasoning through it again, and packages it so it can be found later. Commands
exist; Actors doing this as a habit does not yet.
