# Pulse

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

Bus-owned scheduled Event creation: the schedule kind of
[Event source](source.md). A Pulse is a scheduling mechanism, not a heartbeat,
liveness loop or separate routing system. In a Scope, a Pulse is the source of
an Event node.

## How a Pulse works

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed (ADR-0001, May; 9 Oct ruling: decisions from August and earlier stand)_
_Authored by: operator_

- A Pulse's definition is committed in `.floe/floe.yaml`. Its runtime state
  (next and last firing) lives in the Bus and is rebuilt when the Workspace
  attaches.
- The Bus keeps one timer set to the nearest Pulse. There is no polling loop.
- A firing creates a `pulse.fired` Event with no source Endpoint. No stand-in
  system Actor is invented.
- A firing on its own is not a message to an Actor. It wakes an Actor only when
  delivered to one.
