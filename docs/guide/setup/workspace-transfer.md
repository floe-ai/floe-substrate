# Portable Workspace transfer

**A portable Workspace package moves one retained Workspace identity and its canonical evidence to another host without moving host authority or reusable credentials.**

The package is a versioned directory, not an opaque database backup. It can be
streamed, inspected, validated before restore, and restored idempotently after
an interruption.

## What the package retains

- Workspace identity and canonical IDs.
- Scope identities, immutable composition revisions, Ports, Edges, published
  heads, executions, NodeExecutions, ExecutionAttempts, Deliveries, waits, and
  retained routing evidence.
- Actor and Command identities, immutable definition revisions, published
  heads, runtime-profile pins, Context participation, Events, and retained
  conversation material.
- Artefacts, immutable ArtefactVersions, lineage, membership, annotations, and
  exact reachable content.
- Connector and Extension identities, exact revision or package pins,
  lifecycle evidence, Policies, Budgets, Approvals, Audit records, and grants.

Each record file is deterministic JSON Lines with a schema digest, record
count, whole-file digest, and per-record digest. Included content is addressed
by SHA-256. `manifest.json` records the package format, Bus schema compatibility,
redactions, content disposition, unresolved dependencies, restore transforms,
and the digest-derived package identity.

## What never travels

- reusable credential material;
- credential-broker locators;
- transport credentials or authority sessions;
- the source host identity, Workspace locator, Bridge attachment, or local
  worker binding;
- absolute host paths; or
- rebuildable push-stream indexes and local presentation state.

SecretRef metadata retains its identity but restores unresolved. A host-local
Command worker identity remains origin evidence only; it is never imported as
an executable worker. External content remains by reference only when the
named resolver guarantees the exact reference is portable. Otherwise exact
bytes are included or the dependency is explicit.

## Restore safety

Preflight verifies the package identity, compatibility, every record digest,
and every included content digest before changing the target. A conflicting
canonical ID is refused. Replaying the same package retains matching records
instead of duplicating them. Adding records to an existing Workspace first
creates and verifies a SQLite backup.

Database records, the target Workspace locator, and included content are
committed as one restore attempt. If a later database step fails, the database
transaction rolls back and newly materialized content is removed.

Historical execution, Delivery, wait, Connector, and Extension states remain
exactly as recorded. The target host adds a separate restore hold; it does not
rewrite history to pretend the work was paused. While held, ordinary Workspace
writes and external effects are refused before their handlers run.

Only these Workspace recovery operations may run under the hold:

- `credential.bind`
- `actor.runtime-binding.replace`
- `connector.health.record`
- `extension.enable`
- `workspace.package.reconcile_restore`
- `workspace.package.release_restore_hold`

Endpoint and Command-worker attachment are host registration. Missing content
uses the host-only `workspace.package.supply_content` operation, which accepts
an operator-selected file only when its bytes match the retained digest.

`workspace.package.reconcile_restore` resolves dependencies only from new exact
target-host evidence: a protected credential binding, a live Bridge and
Endpoint, a replacement resolved Actor runtime binding, a healthy exact
Connector revision, a completed exact Extension activation, an available
target Command worker, or verified supplied content. Imported receipts cannot
satisfy this check. `workspace.package.release_restore_hold` refuses until no
dependency remains unresolved and always requires explicit confirmation.

## Shared operation contract

The app, an Actor, the CLI, and direct API clients discover and invoke the same
Bus-owned semantic operations. Current package operations are:

- Workspace authority: `workspace.package.export`,
  `workspace.package.inspect_restore`,
  `workspace.package.reconcile_restore`, and
  `workspace.package.release_restore_hold`.
- Host authority: `workspace.package.locate`,
  `workspace.package.preflight_restore`, `workspace.package.restore`, and
  `workspace.package.supply_content`.

Use `floe operations list` or the authenticated operation-discovery endpoints
described in [[Bus API]]. Host paths appear only in host-authority operation
input or output; they are not canonical Workspace records.

## Implementation

- `floe-bus/src/workspace-portability.ts` — package, validation, restore,
  dependency reconciliation, and restore hold.
- `floe-bus/src/workspace-portability-operations.ts` — shared semantic
  operation definitions.
- `floe-bus/src/operation-governance-control-plane.ts` — fail-closed hold
  enforcement for governed Workspace effects.

