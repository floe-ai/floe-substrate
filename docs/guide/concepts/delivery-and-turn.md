# Delivery and Turn

**Delivery is durable transport. A Turn is one Endpoint processing cycle. Neither replaces logical Scope execution.**

## Delivery

A Delivery is Floe's obligation to transfer an [[Event]] and exact
ArtefactVersion references to an [[Endpoint]] or input Port. It owns queue,
lease, acknowledgement, transport attempt, expiry, and cancellation state.

A graph-routed Delivery pins its ScopeExecution, ScopeCompositionRevision,
source and target NodePlacements and Ports, Edge, causal Event, NodeExecution,
and publication. Root ingress and continuation callbacks may have no Edge but
still pin their exact revision and NodeExecution. Direct conversations and
direct Actor requests may have no ScopeExecution.

Once a Delivery enters a runtime it may already have caused effects. If Floe
loses runtime ownership, the Delivery ends as an unknown-outcome failure. It is
not silently replayed.

## Push and reconnect

The Bridge and product clients use the authenticated WebSocket stream. The first
frame authenticates the exact audience before any state is sent. Reconnect uses
an opaque cursor to replay missed authorised frames and then receives
`caught_up`. Floe does not add a recurring poll or full-state refresh loop.

## Turn

A Turn processes one Delivery using exactly one origin [[Context]]. Runtime
sessions are ephemeral and isolated per Actor and Context. History and Actor
discovery are retrieved when needed rather than injecting unrelated state.

A non-empty natural completion is recorded in the target NodeExecution Context,
or direct Delivery Context. This does not advance a ScopeExecution. Only
publication to a named output Port does that.

A step never waits silently for its required output. When a step has exactly
one required output Port with no saved-file type, the Actor's reply is handed
on through it, unless the Actor handed it on explicitly. If the Port declares
an inline `schema`, the reply must match it; a Port naming only a `schema_ref`
is not handed a reply. Otherwise a step missing required output gets one
visible reminder turn, saying why the reply could not be handed on, then fails
with "required output not handed on" and the reason.

While a Turn runs, each tool call's start and end is pushed live as a
`runtime_telemetry` entry of kind `tool_activity`, with the call's id, tool
name, status (`started`, `completed` or `failed`), time, and the route run
(`scope_execution_id`) when the Turn is a step. Only the name is
pushed: tool arguments and results are not public Context content.

A person can read a finished or running Turn afterwards with
`runtime.delivery.inspect`, targeting its `runtime_delivery` (the
`delivery_id` in the Turn's result Event). It returns `model`, the model the
Turn actually ran on as the engine's own usage record names it (`null` until
the engine reports usage), `models`, every model it called, and `tools`: each
tool call with its name, status and times, joined by `tool_call_id` with
Floe's decision on it (`operation_id`, `decision`, `policy_evaluation_id`).
Read the full decision with `policy.evaluation.inspect`. The read never shows
arguments, results or prose.

Direct `request(actor, work)` remains non-graph delegation. Floe owns the exact
return path and resumes the same NodeExecution, Context, and pinned revision
with the result or terminal failure.

For work on saved inputs, `request` accepts optional `artefact_version_ids`.
These exact published versions become the request Event's immutable input
references and are delivered to the requested Actor. The accepted Event confirms
the references. Omission means no attached input; unrelated versions are never
inherited automatically. Recipients can inspect saved content with `read_artefact`
and continue a long text using its `next_offset`.

## Implementation

- `floe-bus/src/transport-push-stream.ts` — durable cursor and filtered replay
- `floe-bus/src/store.ts` — Delivery queue, lease, and cancellation
- `floe-bus/src/scope-executions.ts` — logical execution references
- `floe-bridge/src/daemon.ts` — authenticated Bridge stream and runtime
  processing
- `floe-bridge/src/runtime-processing-contract.ts` — runtime input/output
  boundary

See [[Glossary]].
