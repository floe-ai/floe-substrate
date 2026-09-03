# The documentation pipeline

**Status:** Historical reproduction of the pre-ADR-0010 mutable Scope graph. Do
not use it as the current authoring or execution contract.

This example proved that a folder Event, Actors, a deterministic Command,
Contexts, Events, and Deliveries could complete real work. It also exposed the
limits later corrected by ADR-0010 and ADR-0011:

- Context subscriptions were overloaded as pipeline routing.
- The Scope stored nodes without explicit Ports and Edges.
- Recomposition changed one mutable design.
- Raw HTTP mutations and the Actor-only capability catalogue could diverge from
  product clients.

`scripts/prove-docs-pipeline.mjs` remains a legacy regression fixture. Its
`graph_id`, trigger-node, subscription-routing, raw mutation, and shared-Context
steps describe compatibility behavior only.

## Current equivalent

A current implementation must:

1. discover the relevant Bus-owned semantic operations;
2. create a draft ScopeCompositionRevision containing NodePlacements, typed
   Ports, and explicit Edges;
3. publish that immutable revision;
4. start a ScopeExecution pinned to it;
5. record each logical placement activation as a NodeExecution with an
   inspectable Context;
6. publish exact output Events and ArtefactVersion references to named output
   Ports; and
7. inspect stable operation receipts and canonical execution records.

Direct Actor requests and Context pub/sub remain valid for non-graph
communication, but they do not advance this ScopeExecution.

The live input schemas, authority, confirmations, expected revisions, and result
shapes come from [[Bus API]] operation discovery. Do not copy the legacy request
bodies from this page into a new client.

## Retained evidence

- `scripts/prove-docs-pipeline.mjs` — legacy runnable reproduction
- `docs/plans/documentation-pipeline-e2e-reproduction.md` — point-in-time plan
  and observations
- `floe-bus/src/scope-graphs.ts` — isolated legacy compatibility
- `floe-bus/src/scope-compositions.ts` — canonical Scope designs
- `floe-bus/src/scope-executions.ts` — canonical execution evidence
- `floe-bus/src/scope-operations.ts` — current semantic operations

See [[Glossary]].
