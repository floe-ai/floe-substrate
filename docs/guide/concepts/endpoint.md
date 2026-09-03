# Endpoint

**An Endpoint is an addressable delivery interface. It is not an [[Actor]] identity.**

An Actor, [[Command]], Connector, service, or another runtime may use an
Endpoint. Runtime backing does not change the Endpoint's transport semantics,
and no backing type is privileged.

## Delivery and lifecycle

An active Endpoint can receive an authorised [[Delivery and Turn|Delivery]].
Retirement prevents new Delivery while retaining historical references.
Attachment and status describe whether a runtime currently owns the interface;
they do not define the Actor or grant authority.

## Authority and identity

Authenticated transport establishes the Bridge or Workspace authority. Request
content cannot claim an Endpoint, Actor, Bridge, or grant. An Endpoint ID is an
address inside authorised substrate state, not a credential.

Endpoint watermarks are retained transport/runtime cursors where older adapters
need them. Product push clients use the Workspace Event Cursor and resumable
WebSocket contract.

## Implementation

- `floe-bus/src/store.ts` — Endpoint and Delivery transport records
- `floe-bus/src/transport-auth.ts` — authenticated Bridge and Workspace
  audiences
- `floe-bus/src/server.ts` — authenticated Endpoint projections and legacy
  Bridge transport routes

See [[Glossary]].
