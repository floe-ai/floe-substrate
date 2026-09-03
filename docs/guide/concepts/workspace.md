# Workspace

**A Workspace is the portable identity and isolation boundary for one body of work.**

It owns Actors, Contexts, Scopes, Artefacts, authority, and history. Its stable
opaque `workspace_id` is independent of a directory, host, repository URL,
storage provider, display name, or tenant.

## Location is a binding

A Workspace locator binding associates that Workspace with one absolute path on
one host. Moving or rebinding retains the Workspace identity and records the
superseded binding as evidence. Restoring an export retains identity. Copying or
forking creates a new identity with source provenance.

Filesystem operations require both Workspace authority and the exact current
binding. A stale binding is refused rather than silently redirected. Remote
projections never expose host paths, binding IDs, or host identity.

## Committed configuration and canonical state

`.floe/floe.yaml`, Actor definition sources, and installed Extension manifests
may form a committed, portable configuration surface. They are not the
Workspace's identity and are not runtime scratch state.

The Bus owns canonical Context, Event, Delivery, Scope design/execution,
Artefact, authority, operation receipt, and runtime records. A client or
Extension must not create a competing ledger merely because some configuration
is stored in Git.

## Authority

Workspace operations require an authenticated principal and current
CapabilityGrants for that exact Workspace. A request body cannot claim another
Workspace or principal. Host control manages host-owned locator lifecycle but
cannot substitute for a Workspace session.

## Implementation

- `floe-bus/src/workspace-identities.ts` — portable identities, locator
  bindings, and provenance
- `floe-bus/src/workspace-operations.ts` — inspect, register, rebind, restore,
  copy, and fork semantic operations
- `floe-bus/src/operation-routes.ts` — host and Workspace operation transport
- `floe-bridge/src/project.ts` — reads the current local `.floe/`
  configuration surface

See [[Glossary]].
