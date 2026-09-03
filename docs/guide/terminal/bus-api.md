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

`GET /health` is public. Other routes require the authority selected by the
route. A missing, expired, revoked, wrong-audience, or wrong-Workspace
credential is refused rather than treated as anonymous.

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

## Canonical Scope operations

The live definitions come from discovery. Current operation families include:

- creating and replacing a draft ScopeCompositionRevision;
- publishing a revision;
- inspecting the published plan;
- starting, inspecting, and stopping a ScopeExecution; and
- publishing a NodeExecution output to a named Port.

A published revision owns NodePlacements, Ports, and Edges. Existing executions
remain pinned to their starting revision. Only Port publication and enabled Edge
traversal advance canonical Scope work.

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
- `context.communication.emit`; and
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

Direct `emit` and Actor `request` remain valid non-graph communication. A
natural runtime completion is recorded in the origin Context and does not
advance a ScopeExecution.

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

Product clients must discover and invoke semantic operations. A remaining raw
mutation is acceptable only when it delegates to the same operation handler or
is an authenticated internal transport that is not exposed as normal product
capability.

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
