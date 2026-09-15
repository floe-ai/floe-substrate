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
  the `floe` CLI. It puts a public key on the Bus roster.
- **Authentication** is unprivileged: the client signs a Bus-issued challenge
  and receives a `workspace_operation` bearer. No `host_control`, no broker.
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
    public key (the actual trust-anchor action; requires `host_control`).
  - `floe identity list` / `floe identity revoke <npub|hex>` — inspect and revoke.
- **A client is expected to implement** its own key generation (or reuse any
  Nostr signer), its own secret storage, event signing, and the two HTTP calls
  below.

**Seed loss is unrecoverable.** If the seed/`nsec` is lost the identity cannot
authenticate. The operator can admit a **new** key under the same display name;
that is re-admission, not recovery, and prior history stays under the old key.

## Discovering where to connect

A client is **told** its Bus base URL and its `workspace_id` out of band (its
own configuration or CLI arguments), the same way the desktop client is
configured. There is no unauthenticated workspace-enumeration endpoint; a
`workspace_id` is required to request a challenge.

To avoid URL-normalization ambiguity in the signed `relay` tag, the challenge
response returns the **exact `relay` string** the client must echo in the signed
event. Sign against that value verbatim.

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
  "pubkey": "npub1zutzeysacnf9rru6zqwmxd54mud0k44tst6l70ja5mhv8jjumytsd2x7nu"
}
```

```json
{
  "identity": {
    "identity_id": "identity_…",
    "display_name": "Jamie",
    "pubkey_hex": "17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917",
    "npub": "npub1zutzeysacnf9rru6zqwmxd54mud0k44tst6l70ja5mhv8jjumytsd2x7nu",
    "admitted_at": "<ISO timestamp>",
    "revoked_at": null
  }
}
```

Normally run as `floe identity add`; the raw route is documented for
completeness.

### 2. Request a challenge (client, unauthenticated)

```http
GET /v1/identity/challenge?workspace_id=workspace_123
```

```json
{
  "challenge": "<high-entropy hex string>",
  "relay": "http://127.0.0.1:5174",
  "expires_at": "<ISO timestamp>"
}
```

The challenge is single-use and short-lived. `relay` is the exact string to
place in the signed event's `relay` tag.

### 3. Build and sign the authentication event (client)

Construct a NIP-01 event and sign it with the identity key (BIP-340 Schnorr):

```json
{
  "kind": 22242,
  "created_at": 1789000000,
  "tags": [
    ["relay", "http://127.0.0.1:5174"],
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
  "workspace_id": "workspace_123",
  "auth_event": { …the signed kind:22242 event… }
}
```

The Bus verifies: `kind === 22242`; `created_at` within ~10 minutes of now; the
`challenge` tag matches a live, unconsumed challenge for this `workspace_id`; the
`relay` tag matches the issued `relay`; the Schnorr signature is valid; and the
`pubkey` is admitted and not revoked. On success:

```json
{
  "bearer_token": "<workspace_operation bearer>",
  "workspace_id": "workspace_123",
  "expires_at": "<ISO timestamp>",
  "identity": {
    "identity_id": "identity_…",
    "display_name": "Jamie",
    "pubkey_hex": "17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917"
  }
}
```

Failures return `401` with `{ "error": "identity_auth_failed" }` for a bad
signature, expired/unknown challenge, wrong relay, stale `created_at`, or an
unadmitted/revoked key. A revoked key can never re-authenticate.

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

`GET /v1/clients` lists admitted identities and their live sessions, so the
operator sees exactly who holds a bearer. `DELETE` revokes: it marks the
identity revoked **and** revokes its live `workspace_operation` session, so the
bearer stops working immediately and the key can no longer authenticate.

## Acting as the operator (client-only human)

An admitted client resolves to the operator principal today (ADR-0015: named at
the identity layer, indistinguishable at the authority layer). To answer a
question an actor addressed to the operator:

1. Find the operator Endpoint:
   `GET /v1/workspaces/:workspace_id/endpoints` and select the one with
   `metadata.role === "operator"` (bridgeless, `bridge_id: null`).
2. Find what is waiting on it:
   `GET /v1/pending-responses?workspace_id=…&waiting_endpoint_id=<operator endpoint id>`.
3. Emit a correlated reply as the operator Endpoint via
   `POST /v1/events/emit`, matching the pending `correlation_id`. A
   `workspace_operation` bearer is permitted to emit as the operator Endpoint;
   Endpoint ownership is enforced only for `bridge_service` callers.
