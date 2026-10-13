# Cursor

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

An opaque ordered position in a Workspace's Event or push stream. Catching up
from a cursor prevents skipping or duplicating records after reconnect. It is
not an offset, a page number or a periodic full-state refresh.

Push updates are filtered to the client's authenticated boundary.

## Snapshot first

_Resolution: settled_
_Built: no_
_Authority: operator-confirmed (13 Oct: "we should then take snapshots")_
_Authored by: operator_

A client that connects first receives one snapshot of the current state inside
its boundary, with the cursor it was taken at, and then only the changes after
that cursor. A client that reconnects resumes from its cursor. If it has fallen
too far behind, it receives a fresh snapshot instead of a long replay. Each
change names the cursor it follows, so a client can check that its state still
matches Floe's.

A snapshot is sent when a client needs one, never on a timer (push, never
poll; [pillars](../pillars/pillars.md)). It is a view of current state; Events
remain the record of what happened.

Still in code: a connecting client catches up by replaying from its cursor
(`floe-bus/src/transport-push-stream.ts`).

## Open

- How far behind is "too far"? Pi Durable sends a fresh snapshot after
  100 batches.
