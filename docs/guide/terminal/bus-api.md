# Bus API

**The Bus exposes authenticated projections and one canonical semantic operation contract over HTTP, plus a resumable push stream over WebSocket.**

Raw HTTP routes are transport and compatibility details. They are not a second
product contract. The Bus-owned operation definitions are authoritative for
state-changing intent, validation, authority, refusal, execution, and receipts.

The packaged desktop app brokers credentials in its native shell. Bearer and
provider credentials never enter URLs, logs, local storage, or the webview.
Direct API use is an authenticated developer or integration path.

## Transport authority

Floe uses non-interchangeable bearer audiences:

| Audience | Boundary | Used by |
|---|---|---|
| `host_control` | One trusted host | Native host lifecycle and host semantic operations |
| `workspace_operation` | One Workspace and current CapabilityGrants | Operator, Actor, CLI, SDK, API, or MCP semantic operations and projections |
| `bridge_service` | One Bridge service on one host | Delivery/runtime transport |

Send HTTP credentials only as:

```http
Authorization: Bearer <opaque credential>
```

A request body cannot claim its own principal, Workspace, host, Bridge, Actor,
Endpoint, grants, or interaction mode.

An operation's target and its causal provenance are separate. An authorised
Actor may inspect or control another execution from its current Context. The
receipt retains the originating Event, Delivery and execution; governance
evaluates the selected target. Publishing runtime output remains tied to the
originating NodeExecution. Clients use the canonical lifecycle states and
`state_revision` when requesting execution changes.
Scope execution inspection includes each Node's `resource_ref`, whose `revision`
is the exact mutation precondition. The numeric `state_revision` alone is not
that reference; clients must not guess or manufacture it.

A Bridge reports `deferred` for a runtime setup failure before the model turn
starts, including credential resolution after injection. A prepared Scope
attempt then closes as failed, its NodeExecution becomes `blocked` with the
setup reason, and its inputs are held for an explicit retry. Reattaching the
Endpoint does not replay those inputs. Retry retains the original Actor and
runtime pins; changing their configuration requires a deliberate new execution.
Failures after the model turn begins remain terminal and are never replayed
automatically.

`GET /health` is public. Other routes require the authority selected by the
route. A missing, expired, revoked, wrong-audience, or wrong-Workspace
credential is refused rather than treated as anonymous.

## Push stream starting position

The first authenticated WebSocket frame may supply `start_at: "current"` for
a client that needs new activity, such as a notification listener. A snapshot
view must read fresh authoritative state after `authenticated`. It receives the
accepted cursor and subsequent changes without replaying the old activity log.
The client must retain that cursor even when no live update arrives. Reconnect
with `after_cursor` to receive missed changes; do not request a new current
position after an interruption. The two starting-position fields are mutually
exclusive. Without either field, historical replay remains available.

Each client view owns its replay position. Bridge service connections retain
their durable acknowledged checkpoint and cannot skip it with `start_at`.
This is a transport option, not a change to canonical Event or Context history.

## Workspace operation session

The trusted host adapter requests a short-lived Workspace session:

```text
POST /v1/local/workspaces/:workspace_id/operation-sessions
Authorization: Bearer <host_control>
```

Optional body:

```json
{
  "interaction_session_id": "desktop-window-1",
  "expires_in_seconds": 3600
}
```

The Bus derives the principal and current grants from authenticated host policy
and registered operations. The client cannot submit grant or operation lists.
The returned Workspace bearer is one-time session material and belongs in
trusted process memory only.

## Discover semantic operations

Workspace-bound discovery:

```text
GET /v1/workspaces/:workspace_id/operations
  ?query=
  &category=
  &target_kind=
  &target_id=
```

Host-bound discovery:

```text
GET /v1/local/operations
  ?query=
  &category=
  &target_kind=
  &target_id=
```

Each response returns the caller-appropriate projections of the same registered
operation definitions:

```json
{
  "operations": []
}
```

Definitions supply stable ID, version, input/result schema versions, effect,
availability, preconditions, grants, interaction constraints, confirmation or
approval, expected-revision rules, and result shape. Clients render or wrap
these definitions; they do not copy their rules.

Approval operation result schema version 2 includes a canonical `resource_ref`
on every returned ApprovalRequest and ApprovalReceipt. Lists and inspection
return the exact identity and current mutation revision, so a client can open
the next permitted action without interpreting IDs or revision counters.
Decisions still append under the immutable request policy and do not require a
mutable request-state revision. Cancellation and receipt revocation retain their
own discovered revision requirements.

## Invoke a semantic operation

Workspace-bound invocation:

```text
POST /v1/workspaces/:workspace_id/operations/invoke
```

Host-bound invocation:

```text
POST /v1/local/operations/invoke
```

Request content is intent only:

```json
{
  "operation_id": "context.archive",
  "operation_version": "1",
  "input_schema_version": "1",
  "target": {
    "kind": "context",
    "id": "context_123"
  },
  "expected_resource_revision": "4",
  "idempotency_key": "archive-context-123-once",
  "input": {}
}
```

`target` and `expected_resource_revision` may be omitted only when the
discovered definition permits that. Reusing an idempotency key with different
intent is refused.

Every consequential invocation returns a stable receipt. Query it after timeout
or reconnection rather than guessing whether the operation committed:

```text
GET /v1/workspaces/:workspace_id/operation-receipts/:receipt_id
GET /v1/local/operation-receipts/:receipt_id
```

A caller can read its own receipt. Reading another principal's receipt requires
the explicit `operation.receipt.read.all` grant.

## Portable Workspace operations

Portable transfer uses the same discoverable operation contract. Workspace
authority exports and inspects a package, reconciles exact target-host
dependencies, and explicitly releases restored work. Host authority locates,
preflights, and restores a package or supplies exact missing content. The full
retention, redaction, verification, and restore-hold contract is documented in
[[Portable Workspace transfer]].

## Canonical Scope operations

Keyword discovery puts the closest identity and multi-word matches first, so
bounded clients can find a concrete operation without loading the catalogue.
Ordering does not change availability, authority or the operation contract.

The live definitions come from discovery. Current operation families include:

- `scope.create` and `scope.list` at the authenticated Workspace boundary;
- creating and replacing a draft ScopeCompositionRevision;
- publishing a revision;
- inspecting the published plan;
- starting, inspecting, and stopping a ScopeExecution; and
- publishing a NodeExecution output to a named Port.

A published revision owns NodePlacements, Ports, and Edges. Existing executions
remain pinned to their starting revision. Only Port publication and enabled Edge
traversal advance canonical Scope work.

Creating a Scope supplies its title, optional description and optional identity.
It does not prescribe a plan or start execution. Actors and clients use the same
creation and listing definitions. The existing POST
`/v1/workspaces/:workspace_id/scopes` also invokes `scope.create` and returns its
`receipt_id`; it is not a separate write path. Both creation paths require the
same grant and preserve idempotent replay.

Read-only Scope projections include:

```text
GET /v1/workspaces/:workspace_id/scopes
GET /v1/workspaces/:workspace_id/scopes/:scope_id/projection
GET /v1/workspaces/:workspace_id/scopes/:scope_id/compositions
GET /v1/workspaces/:workspace_id/compositions/:revision_id
GET /v1/workspaces/:workspace_id/scopes/:scope_id/executions
GET /v1/workspaces/:workspace_id/scope-executions/:execution_id
GET /v1/workspaces/:workspace_id/contexts/:context_id/scope-executions
```

Saved canvas layout is presentation state. It may arrange canonical IDs but
cannot edit topology:

```text
GET /v1/workspaces/:workspace_id/scopes/:scope_id/projection/layout/:renderer
PUT /v1/workspaces/:workspace_id/scopes/:scope_id/projection/layout/:renderer
```

The layout write is a host-local presentation adapter, not a semantic
composition operation.

## Canonical Context operations

Current semantic operation IDs are:

- `context.list`, `context.get`, and `context.inspect`;
- `context.create`, `context.archive`, and `context.restore`;
- `context.participant.set_access` and `context.participant.remove`;
- `context.communication.emit` (the discoverable wrapper over Event submission;
  for a direct or correlated reply a client may also use the raw
  [direct communication ingress](#direct-communication-ingress-emit)); and
- `context.destroy_permanently`.

Archive is reversible. Permanent destruction is separately named, requires
explicit confirmation, and refuses when retained execution, Artefact, Delivery,
decision, approval, audit, child-Context, or other canonical evidence still
references the Context.

Context participation is collaboration and access. Context subscriptions are
ordinary non-graph pub/sub or identified legacy routing. Neither advances a
canonical ScopeExecution.

Read-only Context and history projections include:

```text
GET /v1/workspaces/:workspace_id/contexts
GET /v1/contexts/:id
GET /v1/contexts/:id/tree
GET /v1/contexts/:id/events
```

Context list rows include `delivery_summary` with `active_count` and
`latest_state` (null when there are no Deliveries). The projection includes
Deliveries triggered in the Context, their explicit dependent requests and
responses resumed by those requests' results,
within the same Workspace. It is batched across the returned list, does not
infer work from participation, and does not define an overall outcome status.

## Canonical Artefact operations

Current operation IDs include:

- `artefact.create`;
- `artefact.version.publish`; and
- `artefact.inspect`; and
- `artefact.search`.

An Event may refer to exact ArtefactVersions. A workspace file path is a
ContentRef resolver hint, never the Artefact's identity. `artefact.search`
returns a bounded, filterable page of logical Artefacts and their exact branch
heads; it never labels one branch as universally current. `artefact.inspect`
returns exact lineage, collection membership, associations, annotations, and
optional retained version history.

Canonical content preview resolves one exact version rather than accepting a
path from the client:

```text
GET /v1/workspaces/:workspace_id/artefact-versions/:artefact_version_id/content
```

For workspace-relative content, the Bus verifies the current bytes against the
recorded SHA-256 digest and optional size before returning them. Changed bytes
are refused rather than shown as the retained version. Content-addressed and
external revisions remain explicitly unresolved until their exact resolver is
available. The desktop native broker fetches bytes with the Workspace session
and gives the webview only the verified content. It never returns the host
locator or puts the bearer in a media URL.

## Event and Delivery projections

Events and Deliveries remain canonical transport/history records:

```text
GET /v1/events?workspace_id=&context_id=&scope_id=&type=&since=&before=&direction=&limit=
GET /v1/events/:event_id/trace
GET /v1/delivery?workspace_id=&limit=
GET /v1/pending-responses?workspace_id=&limit=
```

Forward Event reads return `next_cursor`. Backward reads return
`previous_cursor` for earlier history. A Delivery transports an Event and exact
ArtefactVersion references; it does not replace NodeExecution.

### Direct communication ingress (emit)

`POST /v1/events/emit` is a **supported, first-class communication ingress**,
not a legacy compatibility route. It is how an Actor, the operator, or an
unprivileged client emits a direct (non-graph) Event — including a correlated
reply to a request addressed to the operator. It is accepted for
`workspace_operation` and `bridge_service` bearers (`bridge_service` may only
emit as an Endpoint its Bridge owns). A natural runtime completion is recorded
in the origin Context and does not advance a ScopeExecution.

The request body is the canonical Event command. `content` is a free-form
object and the message text lives in `content.text`. A correlated reply names
the pending `correlation_id` and targets the waiting Endpoint:

```json
{
  "type": "response",
  "workspace_id": "workspace_123",
  "source_endpoint_id": "actor:workspace_123:operator",
  "destination": { "kind": "endpoint", "endpoint_id": "<waiting_endpoint_id>" },
  "correlation_id": "<correlation_id>",
  "content": { "text": "Approved by the console operator." }
}
```

Success is `202`; a body that fails the schema is `400 invalid_event_command`.
The **`context.communication.emit` semantic operation** (in *Canonical Context
operations* above) is the discoverable wrapper used where an operation receipt,
confirmation, or richer Context routing is wanted; it delegates to the same
Event submission. For an unprivileged client answering a correlated question,
raw `emit` is authoritative and sufficient — the full field-by-field body is in
[Client identity protocol → Acting as the operator](../../reference/client-identity-protocol.md#acting-as-the-operator-client-only-human).

## Resumable WebSocket stream

Connect to:

```text
GET /v1/events/stream
```

The server sends no state before authentication. The first client frame must be:

```json
{
  "type": "authenticate",
  "bearer_token": "<opaque credential>",
  "workspace_id": "workspace_123",
  "after_cursor": "<opaque cursor or null>"
}
```

`workspace_id` is required for a Workspace session and omitted for privileged
Bridge or host connections. Success begins with:

```json
{
  "type": "authenticated",
  "payload": {
    "audience": "workspace_operation",
    "workspace_id": "workspace_123",
    "cursor": "<opaque cursor>"
  },
  "at": "<ISO timestamp>"
}
```

Replay and live frames use:

```json
{
  "type": "event_submitted",
  "payload": {},
  "at": "<ISO timestamp>",
  "cursor": "<opaque cursor>"
}
```

After replay the Bus sends
`{ "type": "caught_up", "payload": { "cursor": "..." }, "at": "..." }`.
Reconnect with the latest cursor. Invalid authentication closes with code
`4401`; an invalid cursor closes with `4400`. This is push with bounded
catch-up, not polling.

## Legacy and internal routes

The server still contains raw routes used by Bridge transport, diagnostics,
migration, and older clients. In particular:

- `/v1/.../graphs` and graph-node fire routes are legacy mutable-composition
  compatibility;
- raw Context create/delete/participant/subscription routes are compatibility or
  internal adapters;
- raw Scope, runtime-binding, provider, pulse, Endpoint, Delivery, and Extension
  mutations are not an alternate operator contract;
- the older `/v1/.../capabilities` catalogue routes have been removed; actors
  use the same `/operations` discovery and invocation contract as other clients,
  with authority issued for the active Delivery.

Product clients must discover and invoke semantic operations for state-changing
intent. Two named routes are **not** in this legacy set and are supported
product surfaces: the identity routes (`/v1/identity/*`, `/v1/identities`,
`/v1/clients`) documented in the [Client identity protocol](../../reference/client-identity-protocol.md),
and the direct communication ingress `POST /v1/events/emit` described above. A
remaining raw *mutation* is acceptable only when it delegates to the same
operation handler or is an authenticated internal transport that is not exposed
as normal product capability.

## Implementation

- `floe-bus/src/operations.ts` — operation definition, invocation, authority,
  refusal, and receipt contracts
- `floe-bus/src/operation-routes.ts` — Workspace and host discovery,
  invocation, and receipt routes
- `floe-bus/src/transport-auth.ts` — non-interchangeable transport audiences
- `floe-bus/src/transport-push-stream.ts` — filtered cursor-based replay and
  catch-up
- `floe-bus/src/server.ts` — authenticated HTTP/WebSocket adapters and legacy
  boundaries

See [[Glossary]].
