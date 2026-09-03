# Floe Runtime Contracts

This document records runtime transport boundaries for the TypeScript build.
`CONTEXT.md` and accepted ADRs own domain semantics. Services may use matching
TypeScript types internally, but they communicate only through authenticated
HTTP, authenticated WebSocket, and persisted state they own.

## Local Ports

- `floe-bus`: `127.0.0.1:5377`
- `floe-app`: `127.0.0.1:5379`
- `floe-bridge`: outbound bus connection only

## Runtime Adapter Boundary

The bridge owns runtime-specific behavior. Runtime adapters implement the
`floe-runtime-core` contract, which defines the Floe-native endpoint processing
boundary. The operational interface is:

```ts
interface RuntimeAdapter {
  readonly name: string;
  handleBundle(context: RuntimeContext, bundle: DeliveryBundle): Promise<void>;
  cancelDelivery?(deliveryId: string): Promise<boolean> | boolean;
  dispose?(reason?: "bridge_shutdown" | "normal" | "error"): Promise<void>;
}
```

The semantic contract (in `floe-bridge/src/runtime-core/types.ts`) defines:
- `EndpointProcessingInput` — what the adapter receives
- `EndpointProcessingOutput` — what the adapter produces
- `FloeRuntimeContract` — the future strongly-typed adapter interface

Runtime adapters translate between the Floe-native event/endpoint model and
engine-specific assumptions. Pi's user/assistant/message model is contained
inside `PiRuntimeAdapter`.

Local development and CI use `FakeRuntimeAdapter` to exercise the real
bus/bridge/runtime boundary without consuming premium requests. It is
development-only and must not define product semantics.

## Scope and Context Semantics

- Context is collaboration, evidence, and conversation; it is never pipeline
  routing.
- A published ScopeCompositionRevision owns NodePlacements, typed Ports, and
  explicit Edges.
- Only output publication and enabled Edge traversal advance a canonical
  ScopeExecution.
- Each ScopeExecution pins one published revision. Each NodeExecution references
  an inspectable Context and owns its logical attempts and outputs.
- Retry adds an ExecutionAttempt. Redo creates an explicit new ScopeExecution.

## Event Semantics

- The bus persists one canonical event envelope.
- Direct non-graph communication uses authorised destination selectors.
- Graph routing uses exact Ports and stored Edges from the pinned
  ScopeCompositionRevision.
- `emit` persists deliberate non-graph communication or an explicitly attached
  Port publication, creates the required Delivery records, and returns.
- Events that expect a future response declare it through structured event
  metadata (`response.expected: true`), not through held runtime calls.
- Queued events are delivered as bundles at safe bridge/runtime boundaries.
- Delivery state progresses durably as `queued -> reserved ->
  delivered_to_bridge -> injected_to_runtime -> acknowledged`. Transport work
  may be retried before runtime injection. After injection, pushed telemetry
  renews a single-shot ownership lease; runtime failure or ownership loss is a
  terminal dead letter because effects may already exist. Operator cancellation
  is terminal, interrupts the exact runtime or command process, and ignores late
  acknowledgements.
- Turn end is a lifecycle signal, not a message. The bridge observes native
  runtime turn completion and reports endpoint state to the bus.

## Semantic Operations and Authority

- The Bus owns one versioned definition and handler for each semantic operation.
- App, Actor, CLI, SDK, API, and MCP clients discover projections of those same
  definitions and invoke the same handlers.
- Authenticated transport supplies principal, authority boundary, grants,
  interaction mode, and causal provenance. Request content cannot claim them.
- Consequential invocations require idempotency and return stable operation
  receipts. Expected resource revisions protect state-changing intent where the
  operation requires them.
- Legacy raw mutation routes delegate to semantic handlers or remain
  authenticated internal adapters. They are not an alternate client contract.

Transport credentials have non-interchangeable `host_control`,
`bridge_service`, and Workspace-operation audiences. HTTP uses the
`Authorization` header. WebSocket clients authenticate in their first frame,
receive no prior state, and reconnect with an opaque durable cursor.

## Artefact and Secret Boundaries

- Floe owns stable Artefact and immutable ArtefactVersion identity, exact
  provenance, lineage, access, and retention metadata.
- Content stores own bytes; canonical records use typed ContentRefs.
- Extensions own domain schemas, policy, metadata, and rich presentation, not a
  parallel Artefact identity ledger.
- Canonical records contain SecretRef metadata only. Reusable credential values
  stay behind the operating-system or deployment credential broker and never
  enter Events, Contexts, operation inputs, exports, URLs, or presentation code.

## Turn Results, Emits, and Requests

One non-empty natural model completion is recorded as an actor-attributed
message in the delivery's originating Context. This is a record-only operation:
it does not resolve destinations, fan out, wake subscribers, or create another
response expectation. Tool calls, scratch reasoning, and telemetry remain work
trace rather than Context conversation.

`emit` remains the intentional event/effect operation. The model-facing
`request(actor, work)` affordance establishes one durable dependency using the
existing Event, delivery, pending-response, and correlation machinery. The
requested actor completes normally; the bus owns the exact return path and
resumes the requester with the result or terminal failure.

Runtime prompts contain a compact causal Context orientation and the current
input. Context history, participant inventory, and the workspace actor directory
are not injected automatically; actors retrieve bounded history or discover
actors when the current work requires it.

## Validation Baseline

Local and CI validation use:

- Unit tests for IDs, config, queue eligibility, and `.floe/` template logic.
- Contract tests against real daemon processes using temp `FLOE_HOME`.
- Browser/UI tests against the fake adapter.
- Live runtime smoke tests only when `FLOE_LIVE_COPILOT=1`.
