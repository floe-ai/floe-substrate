# Hook

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

A handler an [Extension](extension.md) registers for a named point in a
[Turn](../../event/delivery/turn/turn.md)'s lifecycle. The Bridge fires it at that
point. Handlers run in registration order; a failing handler is caught and
logged and never crashes the turn.

Fired today: `SessionStart`, `BeforeTurn`, `TurnEnd`, `Error`. `WebhookReceived`
is a Bridge ingress hook. Other declared names (including `Pulse`, fired only by
the test engine) are not promises. `BeforeTurn` can add text to the
[turn input](../../event/delivery/turn/input.md); the others observe.
Handlers are registered in code (`hooks.on(...)`); declaring hooks in YAML is
not built.

## Direction: more hook points

_Resolution: question_
_Built: no_
_Authority: agent-provisional_
_Authored by: unknown_

The September release direction asked for hook points around Events received
and emitted, Deliveries, tool use, session lifecycle, Pulse runs and Extension
lifecycle. Only the points above exist; add one when a real Extension needs it.

## Open

- Hooks fire at points in a Turn and look like a trigger, close to Events and
  Pulses. Should hook live under Turn or Event instead of Extension (P4)?
- The original design fired `SessionResume`, `SessionEnd`, `BeforeToolUse`,
  `AfterToolUse`, `ToolUseFailed` and `Pulse` too. They stopped firing when the
  old runtime adapter was removed (14 Sep); the names remain in
  `floe-bridge/src/hooks.ts`. Restore or drop them in the Extension redesign.
