# Context

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

The durable place where participants understand, discuss and record work:
conversation, attached evidence, references, decisions, summaries, and exact
links to ArtefactVersions and execution records.

A Context may be a direct conversation, a processing space, a persistent Actor
workspace or a Scope overview. It is anchored by [participants](participant.md),
a Scope, or both; a Context with neither is invalid.

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

## Open

- A Context "anchored by a Scope" with no members conflicts with the ruling in
  [primitives](../pillars/primitives.md) that a Context exists only when it is
  meant to have members.

Avoid: channel as topology, room as routing table, Thread in new contracts.

## Legacy

The Thread primitive is removed. The Event and pending-response stores still
carry `thread_id` columns, read by the event filter and response matching; they
go with the schema collapse in [pillars](../pillars/pillars.md) (Pre-release).
