# Hook

_Resolution: direction_
_Built: partly_
_Authority: operator-confirmed (9 Oct ruling, Q28)_
_Authored by: operator_

A point inside an [Actor's](../../actor/actor.md) runtime where an
[Extension](extension.md) can step in while something is happening, for example
before a tool call runs (allow it, block it or change it), or before a
[Turn](../../event/delivery/turn/turn.md) starts (add text to its
[input](../../event/delivery/turn/input.md)).

An Extension's hooks run only for Actors whose
[definition](../../actor/definition.md) lists that Extension, the same rule as
its tools (9 Oct, O26). To apply a hook to every Actor, list the Extension on
every Actor.

A hook steps in; an [Event](../../event/event.md) records something that
happened and can wake or start work. Anything that only reacts afterwards uses
Events, not hooks.

Handlers run in registration order. A failing handler is caught and logged and
never crashes the turn. A handler that has not finished after 30 seconds is
treated as failed.

Floe's own permission check decides first. A hook can block a tool call Floe
allowed, but never allow one Floe blocked (9 Oct, Q38).

## Hooks an Extension can register

Inside its entry function: `ctx.hooks.on(NAME, handler)`. Any other name stops
the Extension loading, with the reason in its status.

| Hook | When | Can |
|---|---|---|
| `SessionStart` | A new runtime session starts for the Actor | React |
| `BeforeTurn` | Before a Turn starts | Return `{ inject: { source, content } }` to add text to the Turn's input |
| `TurnEnd` | After a Turn finishes | React |
| `Error` | A Turn fails | React |

## Open

- `BeforeToolUse` is not offered yet. The runtime will own it: floe-runtime
  gets one "before a tool runs" callback, called after Floe's permission
  check, for every tool (branch `before-tool-use` in floe-runtime, pending
  operator approval). The Bridge then forwards it to Extensions.
- `WebhookReceived` and the Context hooks (`ContextCompacted`,
  `ContextHistoryCleared`, `ParticipantAdded`, `ParticipantRemoved`) still fire
  inside the Bridge but are not offered to Extensions: they only react
  afterwards, so under this ruling they are Events, not hooks.
- `AfterToolUse` and `ToolUseFailed` names remain in
  `floe-bridge/src/hooks.ts`, unfired. They react afterwards, so they are
  Events too; drop them unless a real need appears.
- `SessionResume`, `SessionEnd` and `Pulse` names also remain unfired. Restore
  or drop each when a real Extension needs it.
