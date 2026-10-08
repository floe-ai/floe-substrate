# Contributing to Floe

For agents and people changing Floe itself. Read [`AGENTS.md`](../../AGENTS.md)
first, then [working rules](working-rules.md) for how to reason about a change.

## How a change happens

1. **Start from a real need.** An operator outcome, an observed failure, or an
   approved [surface gap](surface-gaps.md). Not a guess about what Floe might need.
2. **Branch.** Never work on `main`.
3. **Change the smallest layer that solves it** (see the solution hierarchy in
   [working rules](working-rules.md)).
4. **Prove it live** on a test profile (below), not only with tests.
5. **Correct every document the change made false**, in the same branch.
6. **Report to the operator** what changed, what was proved, and what is still
   open. Merge and release only after the operator approves.

## Test profile

Never touch the operator's own Floe: port 5377 and `~/.floe`.

- Use a separate configuration file (`floe --config <path>`) whose `home` is a
  throwaway folder and whose ports are in **5480–5489**.
- Stop the test Floe when finished and leave those ports free.

## Releasing

`scripts/release.mjs` builds, verifies, tags and publishes the
`floe-ai/floe` package. Run it only after operator approval.

## Where things go

| Kind of knowledge | Goes in |
|---|---|
| Terms and invariants | `CONTEXT.md`, edited in place |
| A lasting decision | a new ADR in `docs/adr/` |
| A contract a surface needs | `docs/reference/` |
| How to use Floe | `docs/guide/` |
| How to build a surface | `docs/surfaces/` |
| Plans, evidence, worklogs | nowhere in the repository; git keeps history |

A new top-level document or `docs/` folder needs operator approval;
`floe-bus/src/docs-structure.test.ts` enforces this.
