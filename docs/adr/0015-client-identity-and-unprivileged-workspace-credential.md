# ADR-0015: Client identity and the unprivileged Workspace credential

**Status:** accepted (2026-09-15)

## Context

The substrate has exactly one client today (`floe-app`) and two ways to obtain a
transport credential, both wrong for an ordinary outside client:

1. Spawn the native broker to obtain `host_control` and mint a
   `workspace_operation` session. This hands an ordinary client the most
   privileged identity in the system and requires the broker binary.
2. The browser cookie loopback path (`server.ts` local-browser session issuing,
   `browser-connections.ts`). It is origin-bound and designed for a web
   frontend, not a terminal client.

A read-only investigation of this repository by the developer of a second,
deliberately unprivileged client (`floe-console`, HTTP/WebSocket only, no
privileged access) found the consequence directly: there is **no route where an
unprivileged client presents something and receives its own scoped
`workspace_operation` bearer** without holding `host_control` and without
spawning the broker.

The scoped bearer itself already exists and is already issued to a local caller.
`issueWorkspaceOperationSession(hostAuthority, workspaceId, …)`
(`floe-bus/src/server.ts`) mints a `workspace_operation` bearer backed by a
CapabilityGrant set and a persisted `operation_authority_sessions` row that is
hashed, expiring (`OperationAuthorityVerifier`), and revocable
(`SqliteOperationAuthoritySessionStore.revokeSession`,
`floe-bus/src/operation-authority-sessions.ts`). The only missing piece is a
gate that lets an unprivileged, non-browser client obtain that bearer.

### Why not a shared local secret

The first design for this ADR was a shared local enrollment secret file: reading
a `0600` file proved same-machine, same-OS-user presence, which minted the
bearer. It was rejected before implementation for one reason: **a shared file
can only ever prove "some process on this machine", never *who*.** The moment a
second human participates in one substrate, a shared secret is superseded by
identity. This project does not ship a mechanism a known future requirement will
replace.

## Decision

An outside client authenticates as a **client-held keypair identity**. Its
public key is a stable, self-sovereign, self-named identity. Authentication is a
**signed challenge**, not a presented secret. Two operations are kept strictly
separate:

- **Admission** (trust anchor, `host_control`, one-time): the operator admits a
  public key and a human-chosen display name through the `floe` CLI, which
  already holds the broker trust path. Admission is the same authority class as
  seeding the operator actor (`floe-cli/src/actor-seed.ts`).
- **Authentication** (unprivileged, ongoing): the client proves possession of an
  admitted key by signing a Bus-issued challenge and receives the **same**
  scoped `workspace_operation` bearer via the existing
  `issueWorkspaceOperationSession` path. No new authority class, no new power.

### Cryptography — adopt, do not invent

We adopt the Nostr / Bitcoin key stack and never implement a cryptographic
primitive ourselves:

- **BIP-39** — mnemonic seed phrase (<https://bips.xyz/39>).
- **NIP-06** — derive a `secp256k1` key at `m/44'/1237'/0'/0/0`
  (<https://github.com/nostr-protocol/nips/blob/master/06.md>). NIP-06 is
  tagged `unrecommended` (it prefers a single `nsec`); we use the mnemonic only
  as the optional human-friendly path. The identity is the derived key, so a
  client MAY hold an `nsec` directly and skip the mnemonic.
- **NIP-01** — event serialization, `id = sha256(serialized event)`, and
  `sig` = **Schnorr signature over `secp256k1`** per BIP-340
  (<https://github.com/nostr-protocol/nips/blob/master/01.md>,
  <https://bips.xyz/340>).
- **NIP-42** — client authentication by signing an ephemeral `kind: 22242`
  event whose tags carry the relay URL and the challenge, verified by checking
  the kind, that `created_at` is within ~10 minutes of now, that the challenge
  tag matches the issued challenge, and that the relay tag matches the relay URL
  (<https://github.com/nostr-protocol/nips/blob/master/42.md>).
- **NIP-19** — `npub` / `nsec` bech32 encoding
  (<https://github.com/nostr-protocol/nips/blob/master/19.md>).

The maintained library is `nostr-tools` (MIT, `nbd-wtf`), built on the audited
`@noble/curves`. The Bus imports only signature verification and `npub`
decoding; it never holds, derives, or stores a private key.

### Deliberate deviation from NIP-42

NIP-42's native transport is the relay WebSocket `AUTH` frame
(`["AUTH", <challenge>]` from the relay, `["AUTH", <signed-event>]` from the
client). **The Bus carries the identical `kind: 22242` event and the identical
verification rules over an ordinary HTTP challenge/response instead of the relay
WebSocket `AUTH` frame.** The event format, signature scheme, and verification
checks are exactly NIP-42; only the transport differs. This deviation is stated
here, in the ADR body, and in the client protocol reference, so anyone reading
our code against the spec finds the mismatch stated rather than discovering it.

The concrete exchange:

1. `GET /v1/identity/challenge` → `{ challenge, relay, expires_at }`. The
   challenge is workspace-independent (see *Workspace binding* below); the Bus is
   authoritative for the exact `relay` string the client must echo, sidestepping
   URL-normalization ambiguity.
2. Client signs a `kind: 22242` event with tags `["relay", <relay>]` and
   `["challenge", <challenge>]`.
3. `POST /v1/identity/authenticate` with the signed event. On success the Bus
   mints the `workspace_operation` bearer, scoped to a workspace the identity is
   admitted to (see *Workspace binding*).

### Identity-to-principal binding (multi-human is NOT solved)

Every admitted identity stores an `identity → principal` binding. **Today every
binding points at the single existing operator principal
(`store.localOperatorPrincipalId`).** The consequence must be stated plainly and
not blurred:

- Two admitted humans are **named at the identity layer** (distinct public keys,
  distinct display names, distinct revocation).
- They are **indistinguishable at the authority layer today**: both resolve to
  the operator principal and receive the operator's full `workspace_operation`
  scope. Floe cannot yet say *which human* did a thing, nor grant one human less
  than another.

Per-human principals and per-human scoped grants are **additive future work**.
They extend this decision — a future identity gains its own `principal_id` and
grants while the identity and authentication layers are untouched. This ADR does
**not** claim multi-human authority is delivered. It delivers multi-human
*authentication and naming* and the seam to add authority later.

### Workspace binding (how a client learns where it may act)

An admitted identity that can authenticate is still useless if it cannot learn
*which workspace* it may act in. Workspace enumeration (`/v1/workspaces`,
`/v1/local/workspaces`) is `host_control`-gated, so an unprivileged client
cannot list workspaces. Requiring a human to type a `workspace_id` out of band is
the same defect class as a hardcoded bus URL: the substrate, not the human,
should state the scope of a bearer.

**Decision: an identity carries a list of admitted workspaces (many-to-many),
not a per-workspace identity.** A keypair is one self-sovereign thing; minting a
separate identity per workspace would fragment that self and multiply seeds. So
the identity stays global (public key, display name, principal) and a separate
`client_identity_workspaces` membership table records the workspaces it may act
in. Admission (`POST /v1/identities`, `floe identity add --workspace …`) now
requires a `workspace_id` and records a membership; admitting the same key to
another workspace adds a row.

**What this changes for a client:**

- The **challenge is workspace-independent** — it is proof of key possession
  only. `GET /v1/identity/challenge` no longer takes a `workspace_id`.
- **Authentication reports memberships and scopes the bearer.**
  `POST /v1/identity/authenticate` takes an **optional** `workspace_id`. With one
  membership (or an explicit valid one) the Bus mints a bearer scoped to it and
  returns the `workspaces` list. With several memberships and no `workspace_id`
  it mints **no** bearer and returns `workspace_selection_required: true` with the
  `workspaces` to choose from; the client re-authenticates naming one. A
  `workspace_id` the key is not admitted to returns `403`
  `identity_not_admitted_to_workspace`.
- The client therefore learns its workspaces **from the substrate, proven by its
  own signature**, and never enumerates workspaces it has no claim on.
- `GET /v1/clients` lists each identity's admitted workspaces, so the operator
  sees not just who holds a bearer but where each may act.

**Why this survives multi-human.** The near-future requirement the operator named
— a human who may act in one workspace and not another — is exactly a membership
list. When per-human principals arrive, each identity keeps its own membership
rows and a future per-workspace grant attaches to a membership; the identity and
authentication layers are unchanged. Nothing built here is thrown away. Per-human
permissions are **not** built now: every membership still resolves to the single
operator principal, so any admitted human may act in any workspace they are
admitted to with the operator's full scope. Admission is the only gate today.

## Primitive freeze

`AGENTS.md` declares the freeze. The relevant lines:

> "Treat Workspace, Actor/Endpoint, Context, Event/emit, and optional Scope as
> the protected conceptual nucleus unless real operation proves otherwise."
> (`AGENTS.md:98`)

> "Do not introduce a new first-class noun, node kind, lifecycle, graph concept,
> or substrate citizen without evidence from attempted work." (`AGENTS.md:102`)

This decision does **not** cross the freeze, on the strength of that text:

- The nucleus in line 98 is untouched. Identity adds no Workspace, Actor,
  Endpoint, Context, Event, or Scope semantics, and introduces no node kind,
  lifecycle, or graph concept. It attaches to the **already-existing** principal
  concept (`localOperatorPrincipalId`, CapabilityGrants issued to principals),
  making that principal externally addressable by a public key.
- Line 102's prohibition is explicitly conditional: *"without evidence from
  attempted work."* The evidence exists — the `floe-console` developer's
  investigation is attempted work that proved the substrate lacks an
  unprivileged client credential path. The condition that would forbid this is
  not met.

## Consequences

### What improves
- An unprivileged client obtains a scoped, expiring, revocable
  `workspace_operation` bearer with no `host_control` and no broker.
- The bearer is byte-for-byte the same authority the local browser path already
  issues. The new path cannot yield `host_control` or `bridge_service`, cannot
  seed actors, and cannot touch config.
- Revocation now revokes a *named identity's* session, which is strictly more
  legible than revoking an anonymous enrollment.

### What this makes worse (stated honestly)
- **Seed loss is unrecoverable by design.** BIP-39 / Nostr keys have no recovery
  path. If a human loses their seed phrase, that identity is gone and cannot
  authenticate. This is a real burden: humans must safeguard a phrase.
- **`host_control` cannot recover a lost key and must not** — it never sees the
  seed. What it can legitimately do is **admit a new public key** (optionally
  reusing the display name) and revoke the lost one. This is **re-admission, not
  recovery**; the two are not the same and the CLI wording must not blur them.
  History attributed to the old public key stays under the old public key.
- **Theft (not loss) is handled better than a shared secret would be:**
  revocation kills live sessions immediately and marks the public key revoked so
  it can no longer authenticate.
- A new persistent surface exists: a Bus-side roster of admitted public keys and
  display names. It stores public keys and names only — never seeds.

## Implementation

- `floe-bus/src/client-identity-store.ts` — admitted-identity roster,
  workspace memberships (`client_identity_workspaces`), and workspace-independent
  single-use challenges.
- `floe-bus/src/server.ts` — admission, challenge, authenticate, list, and
  revoke routes; challenge-to-session minting via `issueWorkspaceOperationSession`.
- `floe-cli/src/*` — `floe identity` admission and key-generation commands.
- Client protocol reference: [Client identity protocol](../reference/client-identity-protocol.md).

Relates to ADR-0007 (renderer identity), ADR-0013 (model auth belongs to the
vendor CLI — unchanged), and ADR-0014 (MCP internal transport — unchanged).
