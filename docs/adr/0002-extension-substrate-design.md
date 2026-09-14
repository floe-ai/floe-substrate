# ADR-0002: Canonical Extension package lifecycle and isolated execution

## Status
Accepted (amended 2026-09-04)

## Context
Floe needs Extensions to add capabilities, connectors, schemas, resolvers, and
bounded product surfaces without giving third-party package code the authority
of the Bridge or creating another source of truth.

The original implementation dynamically imported TypeScript from
`.floe/extensions/NAME/` into the Bridge. It injected returned tools into every
runtime session, gave package code ambient Bridge authority, and reported an
in-memory view/HTTP-relay registry to the Bus. Real operation proved that this
could not support exact version identity, permission review, execution pinning,
crash containment, safe upgrade, or rollback. Those loading, authority, and
registration decisions are superseded by this amendment.

## Decision

### Canonical identity and lifecycle

The Bus owns durable Extension identity, immutable ExtensionPackageVersion
records, Workspace installations, activation attempts, lifecycle history, and
execution pins. Install, enable, disable, upgrade, rollback, inspection,
contribution discovery, and entry-point invocation use the shared semantic
operation contract.

Every executable package version has an exact content digest, permission digest,
compatibility contract, provenance, declared entry points, and test evidence.
An execution that invokes an Extension pins the exact ExtensionPackageVersion.

### Source and installation

Canonical source may live in an independent repository or package as required by
ADR-0006. `.floe/extensions/NAME/` remains the Workspace installation and
discovery location, not an identity or registration ledger. Its descriptor
points to one canonical ExtensionPackageVersion. The host verifies the exact
installed source bytes against that version before code can run.

### Contributions

An ExtensionPackageVersion may declare capabilities, connectors, Artefact
schemas or resolvers, and bounded product surfaces. Active contributions are a
projection of the exact enabled package version. Disabling or rolling back an
installation changes that projection through the canonical lifecycle.

A product surface declares canonical projection and action operation IDs plus a
presentation schema. It cannot register executable UI code or an arbitrary HTTP
relay. This is a bounded contract, not a universal renderer or design system.

### Isolation and authority

Package source runs in a dedicated hidden child process and a constrained
QuickJS WebAssembly realm. The realm receives no ambient Node, filesystem,
network, environment, secret, or semantic-operation access.

Every host call must use an exact declared permission. The trusted parent checks
the call again, resolves current CapabilityGrants, invokes the canonical
operation or broker, and records an audit entry. Secret values never enter the
Extension contract; only SecretRefs and grant IDs cross it. Filesystem and
network calls fail closed until their canonical brokers are connected.

Activation consumes an exact canonical ApprovalReceipt and creates the durable
activation attempt in one transaction before untrusted code runs. Compatibility,
permission digest, package bytes, isolation level, principal, lifecycle action,
and grant IDs are bound to that attempt. A replay returns the same attempt and
does not silently run code again.

An upgrade starts and verifies the candidate before retiring the prior host. A
failed candidate preserves the prior version. Unexpected host exit quarantines
the exact active installation. Disable and rollback retain history and require
the host stop to be confirmed; uncertain shutdown remains quarantined.

### Bridge boundary

The Bridge does not import Extension source, inject Extension tools, host an
Extension HTTP relay, or report a second Extension registry. Runtime actors and
clients discover and invoke Extension behaviour through the same canonical
semantic operations.

## Consequences

- Extension identity, permissions, active contributions, and lifecycle have one
  durable source of truth.
- Package code cannot inherit the Bridge's authority.
- Installed package bytes are verified before activation.
- Activation, execution, crash, upgrade, disable, and rollback retain exact
  package evidence.
- Clients can render safe declared product surfaces from canonical operations
  without loading untrusted UI code.
- The process boundary and QuickJS limits are defence in depth, not a claim of
  perfect containment.
