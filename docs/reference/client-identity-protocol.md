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

## Answering as a client-executed Actor

**Answering is not a special emit. It is the Actor's turn ending — exactly as a
model's turn ends.** A client does not assemble an event with a type, a source
endpoint, a destination, a correlation id and a content shape in order to say a
sentence. It reports a turn result by delivery id, and the substrate resumes the
asking Actor in its original context, because the substrate already knows which
turn asked. That is the whole meaning of correlation. **A client never supplies a
context and never touches a correlation id.**

The operator is an ordinary Actor. What makes its turns yours to execute is only
its runtime adapter, `client`: no Bridge provides that adapter, so a model Bridge
never executes its turns; whichever client is attached executes them instead. An
admitted client resolves to the operator principal today (ADR-0015: named at the
identity layer, indistinguishable at the authority layer).

The loop is: **discover → learn by push → claim → end the turn.** There is no
polling anywhere in it, and no deadline on any of it.

### 1. Discover the Actor you execute (ordinary listing)

```http
GET /v1/workspaces/:workspace_id/endpoints
Authorization: Bearer <workspace_operation bearer>
```

Every Actor is returned as an ordinary entry. A **client-executed** Actor is one
whose resolved runtime adapter is `client`:

```json
{ "endpoint_id": "actor:workspace_123:operator", "name": "Operator", "adapter_id": "client", "…": "…" }
```

Filter on `adapter_id === "client"`. **Do not construct an id from a naming
convention and do not match a role field — there is none.** The endpoint id is
opaque; take it from this listing (or from the push in step 2, which carries it).

### 2. Learn of work by push (never poll)

Open the authenticated stream you already hold and authenticate it with your
bearer:

```
WebSocket GET /v1/events/stream
→ send    { "type": "authenticate", "bearer_token": "<bearer>", "workspace_id": "<workspace_id>" }
← receive { "type": "authenticated", … }
```

When a delivery is waiting for a client-executed Endpoint you may act for, the
stream pushes:

```json
{
  "type": "delivery_bundle_available",
  "payload": { "delivery": { "delivery_id": "del_…", "endpoint_id": "actor:workspace_123:operator", "…": "…" } }
}
```

The frame carries the `endpoint_id` the work is for and the `delivery_id` to
claim. **This is the only signal you wait on. Do not poll for work** — the
substrate is push-only.

### 3. Claim the delivery

```http
GET /v1/delivery/claim?endpoint_id=<client-executed endpoint id>
Authorization: Bearer <workspace_operation bearer>
```

```json
{
  "deliveries": [
    { "delivery_id": "del_…", "endpoint_id": "actor:workspace_123:operator", "events": [ { "type": "request", "content": { "text": "Operator, approve the deploy?" }, "…": "…" } ] }
  ]
}
```

You may claim only a client-executed Endpoint in your own admitted workspace;
any other `endpoint_id` returns `403`. The question the asking Actor put is the
delivered event's `content.text`. **You do not read the source event for context
and you do not handle a context id** — everything you need to answer is in the
bundle.

### 4. End the turn (the single act)

```http
POST /v1/runtime/turn-result
Authorization: Bearer <workspace_operation bearer>
Content-Type: application/json

{
  "delivery_id": "del_…",
  "text": "Approved by the console operator."
}
```

That is the whole answer. `delivery_id` and `text` are required; `outcome`
(`"completed"` | `"failed"`, default `"completed"`) and a free-form `metadata`
object are optional. **There is no `type`, no `source_endpoint_id`, no
`destination`, no `correlation_id`, and no context field** — the same shape a
model runtime reports a turn with. Success is `202` with `{ "ok": true, … }`.

The substrate resumes the asking Actor **in the context it asked from**,
correlated by the delivery alone, and settles the delivery and reopens your
Endpoint. A reply cannot land in a fresh context, because the client never names
one.

### No deadline

A request addressed to a client-executed Actor stays waiting until a client ends
the turn. An unanswered request is not an error; there is no timeout to observe
or reset, and the wait is never modelled as a problem.

### Known hole: several Actors in one context

Fan-out — three or more Actors live in one shared context at once — is coherent
in this model but **has not been exercised end to end**. Correlation resumes the
turn that asked, so a single asker and a single answering Actor are proven; a
context with several simultaneously-live Actors answering is not yet proven and
should not be relied on as if it were.
