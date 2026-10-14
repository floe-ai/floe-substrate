# Participant

_Resolution: settled_
_Built: partly_
_Authority: agent-provisional_
_Authored by: unknown_

An [Actor](../actor/actor.md) taking part in a [Context](context.md).
Participation decides who takes part; it never controls access
([Workspace access](../capability/access.md)) and never creates an Edge.

## Direction: asking the Actor who did earlier work

_Resolution: direction_
_Built: partly_
_Authority: agent-provisional_
_Authored by: operator (issue #182, Aug)_
_Priority: P3_
_Release: later_

Each step of work keeps its own Context, so a later Actor does not inherit what
an earlier one learned. When it needs that knowledge, it asks the Actor who did
the earlier step, the way a colleague would: it opens a Context with that Actor,
or joins one where the answer already is.

- Built: sending to an Actor who is not a participant opens a new Context with
  it; participants can be added and removed while work runs; an Actor can take
  part without being woken by every Event.
- Not built: finding which Actor did an earlier step and which Contexts could
  answer; an Actor joining a Context on its own, without being added.

Joining changes who takes part, never what an Actor may read: Workspace access
already decides that.
