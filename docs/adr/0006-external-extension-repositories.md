# ADR-0006: Extensions live in independent repositories

## Status
Accepted

## Context
An extension grew alongside substrate work in this monorepo. Its product
semantics became entangled with core documentation and examples, making
extension-specific assumptions appear to be substrate requirements. The
monorepo made that coupling easy and invisible.

The substrate must remain a general contract for actors, contexts, events,
deliveries, hooks, and extension discovery. Product extensions must be able to
evolve independently without changing those core concerns.

## Decision

The Floe monorepo contains substrate only. Extensions live in independent
repositories and build against the substrate contract.

Extension discovery remains a substrate capability through canonical semantic
operations and the active-contribution projection defined by ADR-0002. An
Extension may declare a bounded product surface over canonical projection and
action operations. The app does not load executable view components from an
Extension or proxy an Extension-owned HTTP relay.

## Consequences

- Extension product code, tests, files, and documentation do not belong in this
  repository.
- Substrate documentation describes extension contracts and invariants without
  treating an extension as a worked-in product.
- Canonical discovery remains available to external extensions.
- `.floe/extensions/NAME/` remains an installation location, not canonical
  source or a competing registration ledger.
- Bounded product surfaces follow ADR-0002; a universal renderer framework is
  not implied.
