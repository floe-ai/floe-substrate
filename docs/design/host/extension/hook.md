# Hook

_Resolution: direction_
_Built: partly_
_Authority: operator-confirmed (9 Oct ruling, Q28)_
_Authored by: operator_

A point inside an [Actor's](../../actor/actor.md) runtime where an
[Extension](extension.md) can step in while something is happening, for example
before a tool call runs (allow it, block it or change it), or before a
[Turn](../../event/delivery/turn/turn.md) starts (add text to its
[input](../../event/delivery/turn/input.md)). A hook can apply to every Actor or
to one Actor.

A hook steps in; an [Event](../../event/event.md) records something that
happened and can wake or start work. Anything that only reacts afterwards uses
Events, not hooks.

Handlers run in registration order. A failing handler is caught and logged and
never crashes the turn.

## Open

- Fired today: `SessionStart`, `BeforeTurn`, `TurnEnd`, `Error`, and
  `WebhookReceived` (a Bridge ingress point). No Extension can register for them
  because the loader is gone (see [Extension](extension.md)).
- `WebhookReceived` reacts to something from outside; under this ruling it is an
  Event source, not a hook.
- Tool-call hooks (`BeforeToolUse`, `AfterToolUse`, `ToolUseFailed`) stopped
  firing when the old runtime adapter was removed (14 Sep); the names remain in
  `floe-bridge/src/hooks.ts`. The engine tool gate
  ([engine](../engine.md#engine-tools-are-gated)) already stops every tool call
  before it runs; `BeforeToolUse` belongs at that point.
- `SessionResume`, `SessionEnd` and `Pulse` names also remain unfired. Restore
  or drop each when a real Extension needs it.
