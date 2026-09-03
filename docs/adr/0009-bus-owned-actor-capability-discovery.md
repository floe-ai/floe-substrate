# ADR-0009: Actor-safe capability contracts are Bus-owned and discovered on demand

**Status:** superseded in part by ADR-0011 (2026-09-04)

The two-tool, on-demand discovery seam remains. The separate Actor capability
catalogue and `/capabilities` routes do not: actors now consume the canonical
semantic operation registry through Delivery-scoped authority.

## Context

Real Snowball operation proved that Floe actors need to inspect, compose, and
start connected Scope work. The first correction exposed four Bridge-owned
runtime tools for those actions. That made the operation possible, but copied
the Bus contract into another catalogue: tool names, descriptions, schemas,
validation, endpoint resolution, and composition behaviour all lived in the
Bridge while the durable mechanisms lived in the Bus.

Continuing that pattern would preload every future Bus action into each model
session and create two descriptions of what the substrate can do. A raw HTTP
tool would avoid the copied wrappers but would expose unrelated administrative,
authentication, runtime, and internal routes and make actors reconstruct
ordering and safety rules from low-level requests.

## Decision

The Bus owns a small allow-list of actor-safe semantic capabilities. Each
capability definition is the single source for its:

- stable id and category;
- title and description;
- read or write effect;
- input JSON Schema;
- validation and execution.

The same JSON Schema returned by discovery is compiled to validate invocation.
The Bridge does not restate a capability's description or arguments. It exposes
only two stable runtime tools: discover capabilities for a concrete need, and
invoke one capability using the exact id and input schema returned by the Bus.

Capability details therefore enter model context on demand. Direct,
irreducible runtime verbs such as ordinary event emission and dependent actor
requests remain first-class tools; this decision does not require every
existing tool to become a discovered capability.

The actor-safe catalogue is API metadata and an invocation boundary. It is not
a persisted substrate primitive, a general raw-HTTP tool, an extension system,
or a new workflow abstraction.

## Consequences

- Adding an actor-safe Bus operation does not require a capability-specific
  Bridge tool or copied prompt recipe.
- Runtime prompts and skills explain when to discover; the Bus response owns
  the live operation wording and input shape.
- Only explicitly registered semantic operations are invocable through this
  seam. Internal or operator-only Bus routes are not exposed by default.
- The first registered operations cover the Scope inspection, composition, and
  manual Event activation proven by Snowball. The earlier folder shortcut is
  removed because the general composition operation already expresses it.
- This is a bounded correction to the proven organisation gap, not a mandate to
  catalogue every Bus endpoint or migrate unrelated tool families.
