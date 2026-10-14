# Context

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

The durable place where participants understand, discuss and record work:
conversation, attached evidence, references, decisions, summaries, and exact
links to ArtefactVersions and execution records.

A Context may be a direct conversation, a processing space, a persistent Actor
workspace or a Scope overview. It may belong to a Scope.

Context is collaboration, never pipeline wiring. Membership, parentage,
[subscriptions](subscription.md), instructions and proximity never advance a
ScopeExecution; only an [Edge](../scope/edge.md) does.

Tool calls and scratch reasoning are not automatically Context content.

## Nesting

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed (9 Oct ruling)_
_Authored by: operator_

A Context can sit inside another, like a thread inside a channel.

## Archive, redact and delete

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed (9 Oct ruling: keep while working and tested)_
_Authored by: agent_

- **Archive** hides a finished Context; it can be restored.
- **Redact** wipes a Context's content but keeps a marker that something was
  there.
- **Delete** removes it for good, leaving a marker so links do not break.

## Members

_Resolution: settled_
_Built: partly_
_Authority: operator-confirmed (9 Oct ruling)_
_Authored by: operator_

A Context exists only when it is meant to have
[participants](participant.md). An Event or Command run with nobody to take
part needs no Context. Today the code still creates memberless Contexts for
stored Events and Command runs ([primitives](../pillars/primitives.md), Open).

Avoid: channel as topology, room as routing table, Thread in new contracts.

## Direction: a Context lives where it was made

_Resolution: direction_
_Built: no_
_Authority: agent-provisional_
_Authored by: operator (issue #185, Aug: "Contexts will never really end, they are just abandoned")_
_Priority: P3_
_Release: later_

A Context never really ends; it is abandoned. So a long list is not solved by
marking Contexts finished, but by where each one belongs:

- A Context made inside a Scope node belongs to that node. It is reached
  through that node's history and never listed with the Workspace's Contexts.
- A Context made at the Workspace, such as talking to Floe about the Workspace
  itself, is the list Actors normally see.

Where a Context belongs is a fact recorded when it is made, not a status anyone
keeps up to date.

## Legacy

The Thread primitive is removed. The Event and pending-response stores still
carry `thread_id` columns, read by the event filter and response matching; they
go with the schema collapse in [pillars](../pillars/pillars.md) (Pre-release).

## Open

- **A node's Context that needs someone.** When a Context inside a node is stuck
  or asking a question, where does it show?
- **How long a node's history is kept.**
- **An Actor's own list.** Seeing every Context an Actor took part in spans
  both levels. Does that bring node Contexts back into view?
- **Contexts between two Actors** outside any node: listed with the
  Workspace's, or seen only by the two of them?
