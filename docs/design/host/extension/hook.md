# Hook

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

A handler an [Extension](extension.md) registers for a named point in a
[Turn](../../event/delivery/turn.md)'s lifecycle. The Bridge fires it at that
point. Handlers run in registration order; a failing handler is caught and
logged and never crashes the turn.

Fired today: `SessionStart`, `BeforeTurn`, `TurnEnd`, `Error`. `WebhookReceived`
is a Bridge ingress hook. Other declared names (including `Pulse`, fired only by
the test engine) are not promises.

## Open

- Hooks fire at points in a Turn and look like a trigger, close to Events and
  Pulses. Should hook live under Turn or Event instead of Extension (P4)?
