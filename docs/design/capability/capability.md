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

Decisions: [ADR-0009](../../adr/0009-bus-owned-actor-capability-discovery.md),
[ADR-0011](../../adr/0011-one-semantic-operation-contract.md).

## MCP

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed (R-4)_
_Authored by: unknown_

No MCP inside Floe as a product surface; MCP is for people's own external tools.

Decision: [ADR-0014](../../adr/0014-mcp-is-an-internal-transport-not-a-product-surface.md).

## Legacy

Old raw mutation routes must delegate to these operations or become
authenticated internal routes. They are never a second public contract.

## Open

- The old glossary listed "MCP clients" among this contract's callers, and
  ADR-0014's title calls MCP "an internal transport". Both read against "no MCP
  inside Floe". Which wording is right: does Floe use MCP internally at all?
