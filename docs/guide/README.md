# Floe user guide

**Floe is a substrate: a small set of primitives that agents and people use to build the environment around their work.**

It is not an agent framework and not a fixed workflow product. A [[Workspace]]
holds [[Actor]]s, [[Context]]s, optional [[Scope]]s, Artefacts, authority, and
history. Contexts hold collaboration. A Scope holds immutable composition
revisions and the executions that follow them. Stored Edges, never Context
membership or subscriptions, advance canonical Scope execution.

Read [[What floe is]] for why this exists, or jump straight to [[Install and first run]] to get something running.

## Read this first

New to Floe? Read these four in order:

1. [[What floe is]]
2. [[Install and first run]]
3. [[Concepts]]
4. [[Scope]]

## Entry

- [[Floe user guide]] — this page
- [[What floe is]]
- [[Install and first run]]

## Concepts

- [[Concepts]]
- [[Workspace]]
- [[Scope]]
- [[Node]]
- [[Actor]]
- [[Context]]
- [[Event]]
- [[Command]]
- [[Artifact]]
- [[Binding]]
- [[Endpoint]]
- [[Hook]]
- [[Extension]]
- [[Delivery and Turn]]

## Setup

- [[Services]]
- [[Models and thinking level]]
- [[Workspace config]]
- [[Portable Workspace transfer]]

## Terminal

- [[Terminal access]]
- [[CLI reference]]
- [[Bus API]]

## Legacy reproduction

- [[The documentation pipeline]] — pre-ADR-0010 compatibility evidence, not the
  current authoring contract

## Reference

- [[Glossary]]

## Implementation

- `docs/guide/` — this guide, a free-form standing document directory (`floe-bus/src/docs-structure.test.ts`)
- `CONTEXT.md` — canonical terminology and invariants
- `floe-bus/src/operations.ts` — the shared semantic operation contract
- `floe-bus/src/scope-compositions.ts` — explicit Scope topology
- `floe-bus/src/server.ts` — authenticated HTTP and WebSocket transports
- `floe-cli/src/cli.ts` — the `floe` command
