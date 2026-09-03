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

The Bus derives session authority from policy and registered semantic
operations. A client may request a session for a Workspace and interaction, but
cannot submit its own grant or operation list.

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
may reduce exposure but never grant authority.

### Secret values remain behind a credential broker

Floe stores SecretRef metadata and provenance, not reusable secret values, in
canonical records, Events, Contexts, operation inputs, exports, or logs. Secret
material remains in an operating-system or deployment credential protector and
is resolved only by a trusted broker at the point of use.

Using a SecretRef requires both:

- a current CapabilityGrant covering the exact principal, Workspace, resource,
  operation, and SecretRef; and
- a declared purpose constraint matching the attempted use.

Rotation and refresh update the protected value atomically while retaining the
stable SecretRef and audit evidence. Export and restore carry unresolved
SecretRefs; missing credentials remain visible unresolved bindings and are never
copied insecurely. Legacy credential files may be inventoried and verified for
an approved migration, but are not silently imported or deleted.

Enterprise KMS integration is an adapter to this broker contract, not a separate
authority model.

### Native and hosted adapters keep credentials out of presentation code

For the desktop product, the trusted native shell owns the host credential in
the operating-system credential vault, starts the packaged substrate through a
private handoff, obtains Workspace sessions, and brokers authenticated requests,
media, and push events. The webview receives typed results and state, never
bearer or provider credentials. Missing or invalid authority is a visible
recovery state.

Mobile and hosted clients use their platform identity and session adapters but
invoke the same semantic operation contract. Shared deployment adds tenant and
membership policy around Workspace authority; it does not redefine Workspace
identity or create a privileged alternate API.

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
