# ADR-0011: Humans and Actors use one semantic operation contract

**Status:** accepted (2026-09-03)

## Context

ADR-0009 established a Bus-owned, actor-safe capability catalogue so the Bridge
would not copy every Bus operation into model tools. Subsequent app work exposed
the same risk on the human side: bespoke client functions and screens can restate
operation names, availability, validation, safety, and lifecycle behaviour.

The operator needs to do through a natural interface everything an authorised
Actor can do, while retaining richer interactions and protecting administrative
and credential boundaries. This requires semantic parity, not a raw endpoint
browser.

## Decision

The Bus owns one definition and handler for each semantic operation:

- stable identifier, title, description, category, and effect;
- accepted authority boundaries, initially Workspace or host;
- required grants and interaction constraints;
- versioned input and result schemas;
- availability and preconditions for the selected resource;
- validation, confirmation or approval requirements;
- idempotency and expected-resource revision requirements;
- execution, refusal, audit, and a stable result/error shape containing changed
  resource references, required operator action, retryability, and asynchronous
  progress or cancellation references where applicable.

The actor-safe discovery catalogue, app projections and action rendering, CLI,
and public API consume client-appropriate views of that same definition and
invoke the same handler. App, Actor, CLI, and API describe transports and
presentations, not privileged identity classes. No client maintains a second
description or validation path.

Principal and authority come from the authenticated connection, local trusted
session, or active Delivery. An operation never trusts a caller identity supplied
inside its request content. Every consequential invocation has a stable receipt
which can be queried after timeout or reconnection, so a client cannot report
failure merely because it stopped waiting after the operation committed.

Parity means identical semantic validation, authority, consequences, and audit.
It does not mean identical transport, presentation, or visibility:

- The app may provide operation-specific presentation for a rich interaction.
- A generic schema-driven action form is the fallback for an unfamiliar
  supported operation.
- Raw internal, authentication, and administrative routes are not automatically
  operations.
- Credential values remain behind trusted native or server credential brokers.
  Actors and humans may request scoped grants without receiving reusable secret
  values.
- Projections may be tailored to the caller and include `available_actions`, but
  they are read-only interpretations of canonical records.
- Existing raw mutation routes must delegate to the semantic operation handler
  or become internal. They cannot remain an alternate, less-safe write path.

## Consequences

- Adding an operation requires one semantic implementation rather than app,
  Bridge, CLI, and API copies.
- Archive, stop, retry, delete, composition, approval, connector, and extension
  actions behave consistently wherever invoked.
- A normal operator capability cannot exist only inside Developer tools.
- Developer tools may still expose raw diagnostics that are not product
  operations.
- ADR-0009's small, on-demand actor tool seam remains valid. Its separate
  catalogue and routes are superseded: the Actor audience view is projected
  directly from this shared registry using authority issued for the active
  Delivery.
