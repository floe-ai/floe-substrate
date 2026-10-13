# Capability

_Resolution: settled_
_Built: partly_
_Authority: agent-provisional_
_Authored by: unknown_

A discoverable operation, or reusable implementation, available to the Actors of
a Workspace.
Its Bus-owned definition is one versioned contract for every caller: surfaces,
Actors, the CLI, SDKs and the API. Surfaces project and invoke the same
operations; they never own parallel validation or policy.

Each call returns a [receipt](receipt.md). Every Actor in a Workspace may call
every operation in it; what Actors can do is set once for the Workspace
([Workspace access](access.md)).

Principal, Workspace or host boundary, interaction mode and causal origin come
from the authenticated connection or the active Delivery. Request content can
never claim them. Consequential calls need an idempotency key, and
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

Old raw mutation routes are removed, not kept compatible: they are never a
second public contract (Pre-release, [pillars](../pillars/pillars.md)).

## Open

- The old glossary listed "MCP clients" among this contract's callers, and
  ADR-0014's title calls MCP "an internal transport". Both read against "no MCP
  inside Floe". Which wording is right: does Floe use MCP internally at all?
