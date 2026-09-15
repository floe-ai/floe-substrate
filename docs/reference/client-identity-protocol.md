# Client identity protocol

**How an unprivileged client authenticates to a Floe Bus and obtains a scoped
`workspace_operation` bearer, using a client-held keypair.**

This reference is written so a client developer can build against it **without
reading Bus source**. It carries the on-the-wire formats, the key-ownership
boundary, and how a client discovers where to connect.

The decision and rationale are ADR-0015. The authority model is in
[Bus API](../guide/terminal/bus-api.md).

## Summary

- A human holds a keypair. The **public key is the identity**; the Bus stores
  the public key and a display name and **never** a private key or seed.
- **Admission** is a one-time `host_control` action run by the operator through
  the `floe` CLI. It puts a public key on the Bus roster **and binds it to a
  workspace it may act in**. Re-running admission for the same key with a
  different workspace adds a membership; an identity may be admitted to several.
- **Authentication** is unprivileged: the client signs a Bus-issued challenge
  and receives a `workspace_operation` bearer. No `host_control`, no broker. The
  authenticate response **tells the client which workspaces it may act in**, so
  the workspace a bearer is scoped to comes from the substrate, not from a
  workspace id the human typed.
- The bearer is scoped, expiring, and revocable, identical to what the local
  desktop path already issues.

## Cryptography (adopted standards)

Floe adopts, and does not invent, the following. Use a maintained library
(`nostr-tools`, built on `@noble/curves`); do **not** implement these yourself.

| Concern | Standard |
|---|---|
| Seed phrase | BIP-39 |
| Key derivation | NIP-06, path `m/44'/1237'/0'/0/0` |
| Event id / signature | NIP-01, `sha256` id + BIP-340 Schnorr over `secp256k1` |
| Challenge auth event | NIP-42, `kind: 22242` |
| `npub` / `nsec` encoding | NIP-19 |

**Deviation from NIP-42, stated up front:** NIP-42's native transport is the
relay WebSocket `["AUTH", …]` frame. Floe carries the **same `kind: 22242`
event and the same verification rules over HTTP** (`GET .../challenge` then
`POST .../authenticate`). Only the transport differs; the event, signature, and
checks are exactly NIP-42.

## Who owns what

**The client owns key material. The substrate never does.**

- **Mnemonic generation, seed storage, and `nsec` custody are the client's
  responsibility.** They do not happen in the Floe substrate repository and the
  Bus never receives them. A client generates a BIP-39 mnemonic (or holds an
  `nsec`), derives the key via NIP-06, and stores the secret using its own OS
  keychain / secure storage.
- **`floe-cli` offers**, as convenience, on the machine that holds
  `host_control`:
  - `floe identity generate` — generate a BIP-39 mnemonic and print the mnemonic
    and derived `npub` **once**, storing nothing. Intended for the operator to
    hand a seed to a client out of band. Optional; a client may generate its own.
  - `floe identity add --name "<display name>" --pubkey <npub|hex>` — admit a
    public key (the actual trust-anchor action; requires `host_control`). Run
    from inside the workspace directory and it resolves the workspace
    automatically; pass `--workspace <workspace_id>` to override.
  - `floe identity list` / `floe identity revoke <npub|hex>` — inspect and revoke.
- **A client is expected to implement** its own key generation (or reuse any
  Nostr signer), its own secret storage, event signing, and the two HTTP calls
  below.

**Seed loss is unrecoverable.** If the seed/`nsec` is lost the identity cannot
authenticate. The operator can admit a **new** key under the same display name;
that is re-admission, not recovery, and prior history stays under the old key.

## Discovering where to connect

**Bus URL — told out of band.** The Bus is loopback-only. A client is told its
Bus base URL the same way the desktop client is: it reads `bus.http_base_url`
from the local `~/.floe/config.yaml` (non-secret local config written by
`floe register`), or falls back to the default `http://127.0.0.1:5377`. There is
no remote discovery, because there is no remote Bus.

**Workspace — learned from the substrate, not supplied.** A client does **not**
need to be told a `workspace_id`. Workspace enumeration (`/v1/workspaces`) is
`host_control`-gated and an unprivileged client cannot call it. Instead,
admission binds the identity to the workspaces it may act in, and the
**authenticate response returns exactly those workspaces** (see step 4). The
client picks one from that list. This is deliberate: the client learns only the
workspaces its own key was admitted to — proven by its signature — and never
enumerates workspaces it has no claim on.

The challenge request no longer takes a `workspace_id`; a challenge is
workspace-independent proof of key possession, and the workspace is chosen at
the authenticate step.

To avoid URL-normalization ambiguity in the signed `relay` tag, the challenge
response returns the **exact `relay` string** the client must echo in the signed
event. Sign against that value verbatim. That string is the Bus's own HTTP base
URL (the loopback Bus, e.g. `http://127.0.0.1:5377`) — there is no separate relay
service. Do not hardcode it: always echo the value the challenge returns.

## Wire protocol

All bodies are JSON. Public keys are accepted and returned as **either** 64-char
lowercase hex (x-only, NIP-01 form) **or** `npub` (NIP-19). Internally the Bus
normalizes to hex.

### 1. Admission (operator, `host_control`)

```http
POST /v1/identities
Authorization: ****** control credential>
Content-Type: application/json

{
  "display_name": "Jamie",
  "pubkey": "npub1zutzeysacnf9rru6zqwmxd54mud0k44tst6l70ja5mhv8jjumytsd2x7nu",
  "workspace_id": "workspace_123"
}
```

`workspace_id` is required and must be an existing workspace; it binds this key
to that workspace. To admit the same key to another workspace, repeat the call
with a different `workspace_id`.

```json
{
  "identity": {
    "identity_id": "identity_…",
    "display_name": "Jamie",
    "pubkey_hex": "17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917",
    "npub": "npub1zutzeysacnf9rru6zqwmxd54mud0k44tst6l70ja5mhv8jjumytsd2x7nu",
    "admitted_at": "<ISO timestamp>",
    "revoked_at": null
  },
  "workspaces": [
    { "workspace_id": "workspace_123", "name": "My workspace" }
  ]
}
```

Normally run as `floe identity add` from inside the workspace directory (the CLI
resolves `workspace_id` from the current directory, or lists the registered
workspaces if it cannot); the raw route is documented for completeness.

### 2. Request a challenge (client, unauthenticated)

```http
GET /v1/identity/challenge
```

```json
{
  "challenge": "<high-entropy hex string>",
  "relay": "http://127.0.0.1:5377",
  "expires_at": "<ISO timestamp>"
}
```

The challenge is single-use, short-lived and **workspace-independent**. `relay`
is the exact string to place in the signed event's `relay` tag.

### 3. Build and sign the authentication event (client)

Construct a NIP-01 event and sign it with the identity key (BIP-340 Schnorr):

```json
{
  "kind": 22242,
  "created_at": 1789000000,
  "tags": [
    ["relay", "http://127.0.0.1:5377"],
    ["challenge", "<the challenge from step 2>"]
  ],
  "content": "",
  "pubkey": "<64-char hex x-only public key>",
  "id": "<NIP-01 sha256 id>",
  "sig": "<128-char hex Schnorr signature>"
}
```

With `nostr-tools` this is `finalizeEvent(template, secretKey)`.

### 4. Authenticate and receive a bearer (client)

```http
POST /v1/identity/authenticate
Content-Type: application/json

{
  "auth_event": { …the signed kind:22242 event… },
  "workspace_id": "workspace_123"
}
```

`workspace_id` is **optional** and selects which admitted workspace to scope the
bearer to. Omit it to discover memberships first (below).

The Bus verifies: `kind === 22242`; `created_at` within ~10 minutes of now; the
`challenge` tag matches a live, unconsumed challenge; the `relay` tag matches the
issued `relay`; the Schnorr signature is valid; and the `pubkey` is admitted and
not revoked. It then resolves the workspaces this key is admitted to.

**One membership, or an explicit valid `workspace_id`** — the Bus mints a bearer
scoped to it:

```json
{
  "bearer_token": "<workspace_operation bearer>",
  "workspace_id": "workspace_123",
  "expires_at": "<ISO timestamp>",
  "workspace_selection_required": false,
  "identity": {
    "identity_id": "identity_…",
    "display_name": "Jamie",
    "pubkey_hex": "17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917"
  },
  "workspaces": [
    { "workspace_id": "workspace_123", "name": "My workspace" }
  ]
}
```

**More than one membership and no `workspace_id`** — no bearer is minted; the Bus
reports the choices and the client re-authenticates (a fresh challenge) naming
one:

```json
{
  "bearer_token": null,
  "workspace_id": null,
  "workspace_selection_required": true,
  "identity": { "…": "…" },
  "workspaces": [
    { "workspace_id": "workspace_123", "name": "My workspace" },
    { "workspace_id": "workspace_456", "name": "Other workspace" }
  ]
}
```

A `workspace_id` the key is **not** admitted to returns `403`
`{ "error": "identity_not_admitted_to_workspace" }`. Verification failures return
`401` with `{ "error": "identity_auth_failed" }` for a bad signature,
expired/unknown challenge, wrong relay, stale `created_at`, or an
unadmitted/revoked key. A revoked key can never re-authenticate.

**What a client does with more than one workspace:** authenticate once with no
`workspace_id` to read `workspaces`, present them to the human (or pick the only
sensible one), then authenticate again with a fresh challenge and the chosen
`workspace_id`. Each bearer is scoped to a single workspace; to act in another
admitted workspace, obtain a separate bearer the same way.

### 5. Use the bearer

Send it as `Authorization: ****** on `workspace_operation`
routes, exactly as any Workspace bearer (see [Bus API](../guide/terminal/bus-api.md)).
The bearer expires; before expiry, repeat steps 2–4 to obtain a fresh one
(there is no long-lived refresh token — the identity key is the durable
credential).

## Legibility and revocation

```http
GET /v1/clients                         Authorization: ****** control>
DELETE /v1/clients/:identity_id         Authorization: ****** control>
```

`GET /v1/clients` lists admitted identities, **the workspaces each is admitted
to**, and their live sessions, so the operator sees exactly who holds a bearer
and where they may act. `DELETE` revokes: it marks the
identity revoked **and** revokes its live `workspace_operation` session, so the
bearer stops working immediately and the key can no longer authenticate.

## Answering the operator Actor

The operator is an ordinary Actor. Workspace registration provisions it through
the same path any Actor is created by, so it appears in the ordinary endpoint
listing and `request` can address it like any other Actor. It carries **no role
marker** — a client discovers it by listing Actors, not by matching a special
field. What distinguishes it is only its runtime adapter (`client`): no Bridge
provides that adapter, so a model Bridge never executes its turns; whatever
client is attached executes them instead.

An admitted client resolves to the operator principal today (ADR-0015: named at
the identity layer, indistinguishable at the authority layer). To answer a
request another Actor addressed to the operator Actor:

1. Identify the operator Endpoint. It follows the substrate id convention
   `actor:<workspace_id>:operator`, where `<workspace_id>` is the workspace the
   bearer is scoped to (from the authenticate response). List Actors to confirm
   it — `GET /v1/workspaces/:workspace_id/endpoints` returns it as an ordinary
   entry (its `agent_id` is `operator`); there is no `role` field to match on.
2. Find what is waiting on it:
   `GET /v1/pending-responses?workspace_id=…&destination_endpoint_id=<operator endpoint id>`.
   This returns the pending requests whose source event was addressed to the
   operator Endpoint. Each row carries `destination_endpoint_id` (the operator),
   `waiting_endpoint_id` (the actor that asked and is awaiting the reply) and the
   `correlation_id` to reply against. (`waiting_endpoint_id` is also accepted as a
   filter, but it selects rows where that endpoint is the one *waiting*, which is
   the opposite of answering as the operator.) The question the actor asked is
   the source Event's `content.text`; read the source Event
   (`GET /v1/events?workspace_id=…&context_id=…`, or the row's referenced event)
   to show the human what they are answering.
3. Emit a correlated reply as the operator Endpoint via `POST /v1/events/emit`,
   matching the pending `correlation_id` and addressing the reply to the
   `waiting_endpoint_id` (the actor). A `workspace_operation` bearer is permitted
   to emit as the operator Endpoint; Endpoint ownership is enforced only for
   `bridge_service` callers.

There is no deadline on any of this. A request addressed to the operator Actor
stays pending until a client answers it — an unanswered request is not an error
and there is no timeout to observe or reset.
   `GET /v1/pending-responses?workspace_id=…&destination_endpoint_id=<operator endpoint id>`.
   This returns the pending requests whose source event was addressed to the
   operator Endpoint. Each row carries `destination_endpoint_id` (the operator),
   `waiting_endpoint_id` (the actor that asked and is awaiting the reply) and the
   `correlation_id` to reply against. (`waiting_endpoint_id` is also accepted as a
   filter, but it selects rows where that endpoint is the one *waiting*, which is
   the opposite of answering as the operator.) The question the actor asked is
   the source Event's `content.text`; read the source Event
   (`GET /v1/events?workspace_id=…&context_id=…`, or the row's referenced event)
   to show the human what they are answering.
3. Emit a correlated reply as the operator Endpoint via `POST /v1/events/emit`,
   matching the pending `correlation_id` and addressing the reply to the
   `waiting_endpoint_id` (the actor). A `workspace_operation` bearer is permitted
   to emit as the operator Endpoint; Endpoint ownership is enforced only for
   `bridge_service` callers.

### The `POST /v1/events/emit` body (authoritative for a product client)

This is the request body — there is no separate operation to discover for this
reply. `content` is a free-form object; **the answer text goes in
`content.text`**, the same field the pending question arrived in. The reply
`type` is `response`:

```http
POST /v1/events/emit
Authorization: ****** workspace_operation bearer>
Content-Type: application/json

{
  "type": "response",
  "workspace_id": "<the workspace the bearer is scoped to>",
  "source_endpoint_id": "<the operator endpoint id from step 1>",
  "destination": { "kind": "endpoint", "endpoint_id": "<waiting_endpoint_id from step 2>" },
  "correlation_id": "<correlation_id from step 2>",
  "content": { "text": "Approved by the console operator." }
}
```

Success is `202` with `{ "ok": true, "event_id": "…", "deliveries_created": 1 }`.
A body that does not match the schema is refused with `400`
`{ "ok": false, "error": { "code": "invalid_event_command", … } }` — the fields
above (`type`, `workspace_id`, `source_endpoint_id`, `destination`, `content`)
are all required; `correlation_id` is required to resolve the pending request.
The `destination.kind` for a direct reply is `"endpoint"`; do not guess other
shapes. After a successful emit the pending row from step 2 reads
`status: "resolved"`.

This raw `emit` route — not a discovered semantic operation — is the supported
path for an unprivileged client answering a correlated request. See
[Bus API → Direct communication ingress](../guide/terminal/bus-api.md#direct-communication-ingress-emit).
