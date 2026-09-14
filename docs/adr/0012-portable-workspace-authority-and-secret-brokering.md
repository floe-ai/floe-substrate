# ADR-0012: Workspace identity, authority, and secrets cross explicit trust boundaries

**Status:** accepted (2026-09-03)

## Context

Floe began as cooperating processes on one machine. Much of the HTTP and
WebSocket surface consequently treated loopback reachability, request-body
identifiers, or a browser origin as sufficient trust. Workspace identity was
also coupled to a filesystem path, while provider credentials were represented
in host files that product and runtime code could read directly.

Real desktop operation has already shown why those shortcuts are unsafe and
incomplete:

- a stale, unrelated, or compromised local process can invoke the same routes;
- a caller can claim a different Bridge, Endpoint, Actor, or Workspace identity;
- an app session cannot be constrained to one Workspace and a known operation
  set;
- moving or restoring a Workspace changes its path without changing the work;
- copying a directory can accidentally duplicate an identity;
- credentials cannot be safely delegated to an Actor, connector, mobile client,
  remote Bridge, or shared deployment;
- reconnecting clients can receive unrelated state before their authority is
  established.

These are not desktop-only concerns. The product direction includes portable
Workspaces, connectors, mobile operation, shared deployment, and approved
self-extension. Those clients need the same authority model even though their
authentication adapters differ.

## Decision

### Workspace identity is portable; location is a host binding

A Workspace has one stable opaque identity independent of a directory, host,
repository URL, storage provider, display name, or tenant.

Each host records a Workspace locator binding separately. A binding identifies
the host, locator, binding generation, verification state, and whether local
initialisation is authorised. Rebinding uses compare-and-swap semantics and
preserves the superseded binding as evidence.

- Moving or restoring the same work retains its Workspace identity.
- Copying or forking work creates a new Workspace identity with explicit source
  provenance.
- Remote projections never disclose host-local paths.
- Filesystem operations require the exact current binding as well as Workspace
  authority. A stale binding is refused rather than redirected silently.

A path is therefore a locator, never identity or authority.

### Authority comes from an authenticated principal and durable grants

Every semantic operation receives an authority context established by its
transport. Request content cannot claim its own principal, Workspace, Actor,
Endpoint, Bridge, grant, or interaction mode.

A CapabilityGrant is the canonical durable statement that a principal may use
an exact set of semantic operations against an exact resource boundary, subject
to expiry, revocation, interaction, and policy constraints. A session references
current CapabilityGrants; it does not copy their power. Revocation therefore
takes effect on the next request.

The initial authority boundaries are Workspace and host. Each operation declares
which boundary kinds it accepts. Host authority covers host-owned lifecycle work;
it cannot be substituted for a Workspace session, and Workspace authority cannot
be substituted for host control.

The substrate does not encode a human/agent authority distinction. A desktop
operator session, active Delivery, CLI session, connector, mobile client, and
hosted client may use different authentication adapters, but all resolve to the
same principal, grant, operation, refusal, receipt, and audit model.

Role-based Policy and Approval decisions resolve identity through the same trust
boundary. A retained Principal–Actor binding establishes which Actor an
authenticated principal backs. Explicit retained Actor role assignments establish
Workspace and Scope roles; canonical Context participation owns Context roles.
Executor responsibility comes from the exact immutable
ScopeCompositionRevision plus revision-local NodePlacement, and a NodeExecution
must confirm its assigned Actor. The request cannot supply a role claim. An
active Delivery may establish its Actor's runtime self-binding only from the
exact ActorDefinitionRevision and Actor runtime binding already resolved and
pinned by the Bus. Revocation is never silently reversed. These records qualify
Policy and Approval decisions but do not replace CapabilityGrants.

The Bus derives session authority from policy and registered semantic
operations. A client may request a session for a Workspace and interaction, but
cannot submit its own grant or operation list.

### Delegation retains the source authority boundary

Creating an Actor does not give it another principal's grants. The shared
`capability.grant.delegate` operation requires explicit delegation permission
for the recipient and an active source grant pinned by the authenticated
session. It creates the recipient's own CapabilityGrant with a subset of the
source operations and targets, and an expiry no later than either source or
delegation permission. Workspace delegation cannot create host authority.

The source grant and delegation-permission grant remain durable dependencies.
Revocation or expiry of either removes the child's authority at the next use,
including through further delegation and after portable Workspace restore.
SecretRef purpose constraints accompany delegated account access; credential
material does not. Issuers can withdraw their delegated grants through the same
semantic operation boundary. Actor definition publication and rollback reject
grant references belonging to another principal or Workspace, or no longer
active; runtime preparation repeats the current authority checks.

Delegation policy remains outside this mechanism. The local product assigns
delegation responsibility to its default Floe Actor. For a previously imported
default Actor, the product may append its explicit policy grant while preserving
the current instructions, existing grants and Runtime Profile. The retained
import ownership and current original policy grant must establish that role.
This does not replay source-file configuration or grant access to other Actors,
and startup must not replace a removed, expired or revoked policy grant.

### Transport credentials have non-interchangeable audiences

Transport authentication uses opaque credentials with domain-separated hashes.
The initial audiences are:

- `host_control` for one trusted host adapter;
- `bridge_service` for one Bridge service identity;
- Workspace operation sessions backed by CapabilityGrants.

One audience can never authenticate as another. Bridge identity is resolved
from the credential binding, not a body or query parameter. Host identity is
resolved from the host credential. Workspace sessions are constrained to their
exact Workspace.

HTTP credentials use the authorization header and never appear in URLs or
logs. A WebSocket authenticates in its first frame and receives no state before
successful authentication. Subsequent projections and resumable push events are
filtered to the authenticated boundary. Reconnection uses a durable cursor and
catch-up; it does not introduce polling.

Loopback address, browser origin, CORS, process ancestry, and filesystem access
are not credentials. The local product may explicitly enable the automatic
browser-session policy below; ordinary requests still require canonical authority.

### Secret values remain behind a credential broker

Floe stores SecretRef metadata and provenance, not reusable secret values, in
canonical records, Events, Contexts, operation inputs, exports, or logs. Secret
material remains in an operating-system or deployment credential protector and
is resolved only by a trusted broker at the point of use.

A provider account is connected at the host boundary before a Workspace is
selected. It is a projection over one host-owned SecretRef plus broker health,
not a second account or profile ledger. A Workspace may reuse that account only
when a current CapabilityGrant names the exact Workspace, provider-account
resource, SecretRef, operation, principal, and purpose. No Workspace gains
access merely because the account exists on the same host.

Using a SecretRef requires both:

- a current CapabilityGrant covering the exact principal, Workspace, resource,
  operation, and SecretRef; and
- a declared purpose constraint matching the attempted use.

Rotation and refresh update the protected value atomically while retaining the
stable SecretRef and audit evidence. Export and restore carry unresolved
SecretRefs; missing credentials remain visible unresolved bindings and are never
copied insecurely. Legacy credential files may be inventoried and verified for
an approved migration, but are not silently imported or deleted.

Interactive account connection uses a short-lived, single-use credential
ingress. It is bound to one provider audience, purpose, principal, authority
boundary, and SecretRef. Material is accepted once, consumed atomically, and is
lost on service restart. Only the SecretRef and safe account status are returned
after binding. The initial Windows protector is CurrentUser DPAPI; protected
bytes may be durable, but plaintext exists only inside the broker and the
isolated runtime-use callback.

Enterprise KMS integration is an adapter to this broker contract, not a separate
authority model.

### Native and hosted adapters keep credentials out of presentation code

For the desktop product, the trusted native shell owns the host credential in
the operating-system credential vault, starts the packaged substrate through a
private handoff, obtains Workspace sessions, and brokers authenticated requests,
media, and push events. The webview receives typed results and state, never
bearer or provider credentials. Missing or invalid authority is a visible
recovery state.

The reusable native authority core is independent of Tauri. Desktop, CLI, and a
headless local host call its typed semantic-operation and session methods; none
receives the host-control credential, an arbitrary Bus URL, or generic process
execution. Provider authentication helpers receive only the single-use ingress
over an anonymous pipe.

Mobile and hosted clients use their platform identity and session adapters but
invoke the same semantic operation contract. Shared deployment adds tenant and
membership policy around Workspace authority; it does not redefine Workspace
identity or create a privileged alternate API.

The local application host enables automatic browser access for its configured
loopback frontend. Opening that frontend on the same computer requires no code
or approval. The adapter checks the actual loopback peer, exact frontend origin
and Host, and refuses forwarded and cross-site requests. This is an explicit
local product policy, disabled by default in the reusable server. It trusts
local access to the configured frontend; it is not an operating-system user
isolation boundary or proof against a deliberately configured loopback tunnel.
The authenticated host issues the same Workspace sessions used by the native
app. Each Workspace request selects its own session, so tabs and Workspace
switching do not change another request's authority.

Remote access uses a short-lived connection request approved by the
authenticated native host for one Workspace. The matching code identifies the
request; it is not a credential. Origin-bound HttpOnly, SameSite cookies refer
to canonical Workspace authority sessions held by the server. Native and
browser connections share the same grant/session issuer and request verifier.
Browser presentation never receives the underlying bearer, host credential, or
local Workspace locator. WebSockets authenticate in their first frame through
the same cookie-bound session, then use the existing filtered cursor stream.
Expired local sessions renew through the host policy on use. Local reload and
reconnection restore access automatically after restart. Remote expiry,
revocation, disconnect, and restart require a new approved connection.

Connection requests and browser transport handles are bounded, ephemeral
adapter state. They are not a new authority ledger or substrate primitive.
Browser access does not supply native confirmation or a host-control credential.
The enabled local adapter also brokers semantic host operations, including
Workspace registration before any Workspace exists. Its discovery, invocation
and receipt routes reuse the native host's canonical operation handlers and
current host-policy grants. Every request validates the local cookie, origin,
Host and loopback peer; the server derives authority and accepts only operation
intent. Required trusted confirmations remain unavailable through browser
content. Remote paired sessions cannot use this adapter, and neither kind of
browser session grants access to raw host-control routes.

The explicitly enabled local browser adapter also supports provider sign-in.
It invokes the same account prepare, bind and list operations through the
host-held authority. The provider adapter keeps credential material inside the
process and transfers it through the single-use ingress into the protected
broker. The browser receives an expiring sign-in conversation, provider links,
questions and safe status. Sign-in questions are bound to the initiating cookie;
disconnect and expiry cancel the provider interaction. Remote browser sessions
cannot use these local account routes.

Account existence does not authorize a model. The host operation
`credential.runtime-access.grant` grants one active Actor in one Workspace only
`credential.use` and `credential.refresh` for the exact provider account and
SecretRef, with the runtime authentication purpose and an explicit expiry.
Equivalent authority can invoke it regardless of Actor backing. The local
client requests ninety days of access; that duration is client policy. A
matching grant with sufficient remaining duration is reused. Its identifier
is attached to the Actor definition through normal versioned operations.
`credential.runtime-access.revoke` retains the grant and refuses future use,
including use by active Deliveries. Secret values never enter these operations.

Conversation model selection reads the Actor's retained Endpoint binding and
exact RuntimeProfileRevision. Both clients compose normal Actor definition,
Runtime Profile and binding operations to save a model choice. A stale binding
is refused. The conversation controls no longer treat `profiles.yaml` or the
legacy runtime-binding projection as their source of truth. Other legacy
settings and Workspace import paths still require cutover and end-to-end proof.

Local desktop and CLI entry points install an explicit Workspace import policy.
For a newly created, initialization-authorized Workspace, the declared `floe`
Actor receives a closed set of starting capabilities through ordinary grants.
This choice belongs to the local product, is independent of Actor backing, and
is absent from the reusable server unless supplied by its host. Other Actors,
copied Workspaces and forked Workspaces do not inherit that starting authority.
Policy renewal cannot replace explicitly revoked Actor grants with fresh ones.

Retained Actor runtime bindings determine configuration readiness when an
Endpoint attaches. A committed binding change also updates an attached
Endpoint's configuration readiness and pushes any queued work. An older import
receipt cannot override a later model choice. Binding changes leave active,
failed, retired and offline Endpoints alone; rolled-back changes produce no
readiness announcement or Delivery. Existing Delivery pins remain unchanged.

Startup attachment discovers current published Actors and their retained runtime
bindings through a Bridge-only, current-locator-bound projection. File import
is a separate compatibility action: a refused import remains evidence and does
not overwrite saved settings or prevent existing canonical runtimes attaching.
Unimported files do not start new legacy Event sources. Disabled bindings,
retired Actors, retired Endpoints and retired Runtime Profiles do not attach.
Each Delivery still obtains its exact instructions, model and authority from
its Bus-issued processing contract, never this discovery projection.

Floe app onboarding composes the same Actor and Runtime Profile operations to
prepare an unbound interactive participant. Its `floe-app` profile records app
participation without credentials or a model worker Endpoint. The app reads
assigned work and submits outputs through the shared operation contract. It
preserves an existing runtime choice, including disabled bindings, and never
restores revoked principal authority implicitly. This does not claim a Bridge
Delivery session or implement a background human notification adapter.

## Migration

Existing Workspace, Context, Event, Delivery, Scope, Artefact, and provider
records are valuable state.

- A validated, backed-up upgrade assigns or imports stable Workspace identities
  and host bindings without changing the original content.
- An existing identity collision or missing local credential is reported for
  explicit recovery. It is never repaired by silently claiming another path or
  minting replacement authority.
- Existing raw mutation routes delegate to semantic operations or become
  authenticated internal adapters.
- Existing unauthenticated HTTP and WebSocket behavior is removed rather than
  retained as a fallback.
- Existing credentials become verified SecretRefs through an approved brokered
  migration. Until then they remain an explicit legacy boundary.
- Legacy auth files remain unchanged until verification and successful broker
  binding are complete, and require a separate approved cleanup action.

## Consequences

- The same Workspace can move between local, remote, mobile, and hosted clients
  without treating its path as identity.
- A local client cannot gain power merely by reaching a loopback port or naming
  another caller in a payload.
- Revocation, expiry, least privilege, refusals, receipts, and audit apply
  consistently to operators, Actors, connectors, and services.
- Provider and connector credentials can be used without entering model or
  webview context.
- Desktop startup must establish or recover its host credential before normal
  product operations become available.
- Bridge and app code must use authenticated projections and semantic
  operations; direct unauthenticated fetches are not a supported product path.
- CORS and content security policy remain defense-in-depth and must be narrow,
  but are not substitutes for authentication.
