# Hook

**A hook is a point inside an Actor's runtime where an [[Extension]] can step in while something is happening.**

For example, before a tool call runs (allow it, block it or change it), or
before a [[Delivery and Turn|Turn]] starts (add text to its input).

An Extension's hooks run only for [[Actor]]s whose definition lists that
Extension, the same rule as its tools. To apply a hook to every Actor, list the
Extension on every Actor.

A hook steps in; an [[Event]] records something that happened and can wake or
start work. Anything that only reacts afterwards should use Events.

Handlers run in registration order. A failing handler is caught and logged and
never crashes the turn. A handler that has not finished after 30 seconds is
treated as failed.

## Hooks an Extension can register

Inside its entry function: `hooks.on(NAME, handler)`. Any other name stops the
Extension loading, with the reason in its status.

| Hook | When | Can |
|---|---|---|
| `SessionStart` | A new runtime session starts for the Actor | React |
| `BeforeTurn` | Before a Turn starts | Return `{ inject: { source, content } }` to add text to the Turn's input |
| `TurnEnd` | After a Turn finishes | React |
| `BeforeToolUse` | A tool call that Workspace access allows is about to run. The handler gets `tool_call_id`, `tool_name`, `source` (`builtin` or `custom`), `args` and `cwd` | Return nothing or `{ decision: "allow" }`, `{ decision: "block", reason }`, or `{ decision: "change", args }` |
| `Error` | A Turn fails | React |

## BeforeToolUse

A hook can block a tool call that Workspace access allows, but never allow one
it blocks. Workspace access is applied first; then the call passes to the
`BeforeToolUse` handlers of the Actor's listed Extensions, in order, each seeing
the input as changed by the one before. The first block wins. When a handler
changes a built-in tool's input, Workspace access is applied again to the new
input.

Unlike other hooks, a check that fails, times out, answers something unknown,
or cannot run because the Extension process is restarting blocks the call.

## BeforeTurn injection

Injected content is added once and resolved live. Floe keeps a hash of the last
content injected per Context and `source`:

- the same content as last time is skipped, because the model already has it;
- changed content is injected, and the hash updates;
- a Delivery with no Context is always injected.

Clearing or compacting a Context resets its hashes, so the next turn injects
everything again.

## Seeing which hooks are registered

A running Extension's status lists the hooks it registered. There is no
separate operation for listing hooks.

See [[Glossary]].
