# Capability

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

A discoverable operation, or reusable implementation, available under authority.
Its Bus-owned definition is one versioned contract for every caller: surfaces,
Actors, the CLI, SDKs and the API. Surfaces project and invoke the same
operations; they never own parallel validation or policy.

Each call returns a [receipt](receipt.md) and leaves an [audit record](audit.md).
Authority comes from a [grant](grant.md); [Policy](policy/policy.md) can only
narrow it.

Principal, Workspace or host boundary, grants, interaction mode and causal
origin come from the authenticated connection or the active Delivery. Request
content can never claim them. Consequential calls need an idempotency key, and
state-changing calls carry the expected resource revision where the operation
requires one.

Origin: agent ADR-0009 (25 Aug), ADR-0011 (4 Sep).

## MCP

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed (R-4)_
_Authored by: unknown_

No MCP inside Floe as a product surface; MCP is for people's own external tools.

Origin: agent ADR-0014 (14 Sep).

## Legacy

Old raw mutation routes must delegate to these operations or become
authenticated internal routes. They are never a second public contract.

## Open

- The old glossary listed "MCP clients" among this contract's callers, and
  ADR-0014's title calls MCP "an internal transport". Both read against "no MCP
  inside Floe". Which wording is right: does Floe use MCP internally at all?
