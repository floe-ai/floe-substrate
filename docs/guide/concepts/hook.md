# Hook

**A hook is an extension-supplied handler fired at a point in the runtime lifecycle.**

An [[Extension]] registers a handler for a named hook via `ExtensionContext.hooks.on(...)`.
The bridge fires that hook at the matching lifecycle point. Handlers run sequentially
in registration order; a handler that throws is caught and logged — it never crashes
the run.

## Active hooks

| Hook | Fires on | Payload carries |
|---|---|---|
| `SessionStart` | A new SDK session is created for an (actor, context) pair | `provider`, `model_id`, endpoint/workspace/delivery ids, `reason: "session_created"` |
| `BeforeTurn` | Just before a [[Delivery and Turn|Turn]] runs | endpoint/delivery ids and the delivery's origin; `kind: "thread"` is legacy storage compatibility, while new contracts use Context |
| `TurnEnd` | A turn finishes | `visible_output`, `tool_activity`, `emitted_events` |
| `WebhookReceived` | An inbound webhook lands | `route_id`, `event_id`, `context_id`, `target_endpoint_id`, `content`, `metadata` |
| `Error` | An unhandled error occurs in a turn | `error` |
| `ContextCompacted` | A [[Context]]'s history is truncated to a summary | `context_id`, `summary_event_id` |
| `ContextHistoryCleared` | A context's history is wiped | `context_id`, `events_deleted` |
| `ParticipantAdded` | An endpoint joins a context | `context_id`, `endpoint_id` |
| `ParticipantRemoved` | An endpoint leaves a context | `context_id`, `endpoint_id` |

## BeforeTurn injection

A `BeforeTurn` handler can return `{ inject: { source, content } }`. The bridge
renders this into the turn's prompt alongside the [[Event]] that triggered it — a way
for an extension to add context the model wouldn't otherwise see (a memory recall, a
todo list, a policy reminder).

**Injection is inject-once / resolve-live.** The bridge keeps a hash of the last
content injected per `(context_id, source)`:

- Same resolved content as last time → skipped. The model already has it in its
  running context; injecting it again every turn would be noise.
- Content changed → injected, and the baseline hash updates.
- No `context_id` on the delivery → always injected (there's nothing to key the
  dedup on).

Clearing or compacting a context resets that context's baseline, so the next turn
re-injects everything fresh — matching the fact that the model's visible history was
just reset too.

## Hooks cannot be listed

There is no read endpoint for hook registrations. A workspace's registered hooks are
only visible in code, at the extension that registers them.

## Implementation

- `floe-bridge/src/hooks.ts` — `HookName`, `HookPayloadByName`, `HookRegistry.fire`
- `floe-bridge/src/adapters/floe-runtime-adapter.ts` — SDK session and turn hook dispatch
- `floe-bridge/src/adapters/floe-direct-tools.ts` — direct tool activity is recorded in the turn work log, not emitted as an extension hook
- Hook listing / read endpoint — Not built yet.

See [[Glossary]].
