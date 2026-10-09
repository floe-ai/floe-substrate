# Floe — start here

Floe is a local substrate: a small set of
[primitives](docs/design/pillars/primitives.md) (Workspace, Actor, Command,
Context, Event, optional Scope, Artefact) that Actors share to get work done.
Products are built on it as separate **surfaces**.

## Which job are you doing?

| Job | Read |
|---|---|
| Changing Floe itself (substrate, runtime, CLI) | [docs/contributing/](docs/contributing/README.md) |
| Building a product on Floe, in its own repository | [docs/surfaces/](docs/surfaces/README.md) |
| Using or operating Floe | [docs/guide/](docs/guide/README.md) |

If you are building a surface, you do not edit this repository. You report gaps.

## Hard rules

1. **Operator approval.** Every change to Floe (this repository and
   floe-runtime) is made on a branch. Nothing merges or releases without the
   operator's explicit approval.
2. **Requests go through the operator.** Surface work never asks Floe developers
   for changes directly.
3. **The delete test.** If deleting a surface would leave something in Floe that
   only made sense for that surface, it does not belong in Floe. Floe owns shared
   mechanism; a surface owns its domain, rules, formats and state.
4. **Mechanism, not opinion.** If two legitimate uses could want different
   behaviour, Floe exposes the mechanism and lets the Actor, configuration,
   extension or surface choose.
5. **Fix, never work around.** No mocks, fakes or temporary substitutes for a
   mechanism Floe should provide. Name the gap instead.
6. **Push, never poll.** State and progress flow as pushed events.
7. **An Actor is an Actor.** Nothing in code or docs distinguishes a person from
   a model.
8. **No environment-variable switches.** Configuration lives in the Floe
   configuration file.
9. **Live proof.** Done means shown working against a real Floe, on a test
   profile that never touches the operator's own Floe (port 5377, `~/.floe`).
10. **History lives in git.** Do not keep plans, evidence or worklogs in the
    repository.
11. **One name per thing.** Every Floe term has one name, defined in its
    [design document](docs/design/README.md#naming). Use that name in code, docs
    and conversation; never a synonym, and never one name for two things.

## Where truth lives

- [docs/README.md](docs/README.md) — how documentation works: where knowledge
  goes and how the docs improve. Read it before adding or moving a document.
- [docs/design/](docs/design/README.md) — what Floe is and is meant to be:
  goals, the operator experience, terms, rules and the decisions behind them.
  `Built: no` is the roadmap.
- [docs/reference/](docs/reference/) — the published contracts surfaces build against.

Current code says what happens today; design says what should happen.
When they disagree, say so. Do not silently pick one.
