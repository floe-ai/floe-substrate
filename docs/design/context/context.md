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

## Legacy

The Thread primitive is removed. The Event and pending-response stores still
carry `thread_id` columns, read by the event filter and response matching; they
go with the schema collapse in [pillars](../pillars/pillars.md) (Pre-release).
