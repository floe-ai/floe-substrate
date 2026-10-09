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
allowed, but never allow one Floe blocked (9 Oct, Q38). The runtime owns the
"before a tool runs" point for every tool, so there is one place a call is
checked: floe-runtime calls it after the permission check, and the Bridge
passes it to the listing Extensions' `BeforeToolUse` handlers. When a handler
changes a built-in tool's input, the permission check runs again on the new
input.

## Hooks an Extension can register

Inside its entry function: `ctx.hooks.on(NAME, handler)`. Any other name stops
the Extension loading, with the reason in its status.

| Hook | When | Can |
|---|---|---|
| `SessionStart` | A new runtime session starts for the Actor | React |
| `BeforeTurn` | Before a Turn starts | Return `{ inject: { source, content } }` to add text to the Turn's input |
| `TurnEnd` | After a Turn finishes | React |
| `BeforeToolUse` | A tool call Floe allowed is about to run. The handler gets `tool_call_id`, `tool_name`, `source` (`builtin` or `custom`), `args` and `cwd` | Return nothing or `{ decision: "allow" }`, `{ decision: "block", reason }`, or `{ decision: "change", args }` |
| `Error` | A Turn fails | React |

`BeforeToolUse` handlers run in order across the Actor's listed Extensions,
each seeing the input as changed by the one before. The first block wins. Unlike
other hooks, a check that fails, times out, answers something unknown, or
cannot run because the Extension process is restarting blocks the call.

## Open

- `BeforeToolUse` needs floe-runtime branch `before-tool-use`; the Bridge pins
  that branch's commit until the operator approves and it merges.
- `WebhookReceived` and the Context hooks (`ContextCompacted`,
  `ContextHistoryCleared`, `ParticipantAdded`, `ParticipantRemoved`) still fire
  inside the Bridge but are not offered to Extensions: they only react
  afterwards, so under this ruling they are Events, not hooks.
- `AfterToolUse` and `ToolUseFailed` names remain in
  `floe-bridge/src/hooks.ts`, unfired. They react afterwards, so they are
  Events too; drop them unless a real need appears.
- `SessionResume`, `SessionEnd` and `Pulse` names also remain unfired. Restore
  or drop each when a real Extension needs it.
