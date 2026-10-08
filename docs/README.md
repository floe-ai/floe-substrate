# How Floe documentation works

Read this before adding, moving or deleting any document in this repository.

## Where things go

| Kind of knowledge | Goes in |
|---|---|
| What Floe is and is meant to be: goals, experience, terms, rules | `docs/design/`, following its [README](design/README.md) |
| Why a lasting decision was made | a new ADR in `docs/adr/` |
| A contract a surface builds against | `docs/reference/` |
| How to use Floe | `docs/guide/` |
| How to change Floe itself | `docs/contributing/` |
| How to build a surface on Floe | `docs/surfaces/` |
| How the code is put together today | `docs/architecture/overview.md` |
| Plans, evidence, worklogs, old PRDs | nowhere in the repository; git keeps history |

## Rules

1. **One home.** Each rule or fact is written once, in the one place it belongs.
   Everywhere else links to it. If a document could fit in two places, the
   structure is wrong: restructure and ask the operator. The design rules
   (P1–P4, D1, D3) are in [design](design/README.md#where-a-document-goes).
2. **Design leads code.** Every Floe change names the design document it serves.
   `Built: no` in design is the roadmap; nothing else is.
3. **Every design document states four facts** (Resolution, Built, Authority,
   Authored by). See [design](design/README.md#every-document-starts-with-four-facts).
4. **Only the operator confirms.** An agent never marks anything
   `operator-confirmed`. Settling a question is not approval.
5. **No history.** Plans, worklogs and evidence are not kept as documents. A
   document describes the present and the intended future. Delete what is no
   longer true instead of marking it old.
6. **ADRs are append-only.** Never edit an accepted ADR's decision; write a new
   one that supersedes it.
7. **The set of standing documents is closed.** A new top-level document or a
   new `docs/` folder needs operator approval.
   `floe-bus/src/docs-structure.test.ts` fails until it is registered.
8. **A change corrects every document it made false**, in the same branch.

## How the docs improve

New knowledge goes where it will be found next time, not into a new file.

| You learned | Put it in |
|---|---|
| An unanswered question about Floe | `## Open` in the design document it concerns |
| Something about how Floe should behave | the design document, as `question` or `direction` |
| A better way to build any surface | a drafted edit, via [surface lessons](surfaces/lessons.md) |
| Floe lacks something a surface needs | [surface gaps](surfaces/gaps.md), then [Floe's side](contributing/surface-gaps.md) |
| A better way to work on Floe | a drafted edit to [working rules](contributing/working-rules.md) |

Agents draft these edits; the operator approves them before merge.
