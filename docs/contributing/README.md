# Contributing to Floe

For agents and people changing Floe itself. Read [`AGENTS.md`](../../AGENTS.md)
first, then [working rules](working-rules.md) for how to reason about a change.

## How a change happens

1. **Start from a real need.** An operator outcome, an observed failure, or an
   approved [surface gap](surface-gaps.md). Not a guess about what Floe might need.
   Name the [design document](../design/README.md) the change serves; if none
   exists, write it first and bring it to the operator.
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

## Test tiers

- **Fake runtime.** Fast tests use the fake runtime adapter to check Bus and
  Bridge behaviour. It never defines what the product means.
- **Live runtime.** The live tier runs a real runtime through the Copilot SDK
  with the machine's Copilot sign-in. It fails loudly when the runtime is
  unavailable instead of quietly skipping.

## Releasing

`scripts/release.mjs` builds, verifies, tags and publishes the
`floe-ai/floe` package. Run it only after operator approval.

## Where things go

See [how documentation works](../README.md).
