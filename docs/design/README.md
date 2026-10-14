# How Floe design works

`docs/design/` describes Floe: what exists and what is intended. It leads
development. Code follows design, not the other way round.

Design records intended behaviour, rules and outcomes. Implementation details
(file layout, frameworks, internal APIs) belong in code and `docs/reference/`
unless a technical property is itself part of the design.

## Where a document goes

- **L1. The top level is fixed.** `pillars/` (goals and laws for all of Floe),
  `host/` (Floe on one machine), the seven building blocks (`workspace/`,
  `actor/`, `context/`, `event/`, `scope/`, `command/`, `artefact/`) and
  `capability/` (who may do what). Changing the top level needs operator
  approval.
- **L2. Below that, a thing lives inside the one thing it cannot exist without.**
- **L3. A file becomes a folder only when a part of it needs its own document.**
  `extension.md` became `host/extension/` because hooks needed their own
  document.
- **L4. If a document could fit in two places, the structure is wrong.**
  Restructure and ask the operator; never just pick one.
- **D1. One owner.** A rule has exactly one home. Every other document links to
  it and says only how it differs. No `shared/` or `common/` folders.
- **D3. Goals and rules.** A goal admits several implementations and lives in
  `pillars/`. A rule admits one and lives with the thing it governs.

## Every document starts with four facts

```markdown
_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_
```

| Fact | Values |
|---|---|
| Resolution | `question` (open, no answer yet), `direction` (leaning, with a way to settle it), `settled` |
| Built | `yes`, `partly`, `no`, as checked against the code when written |
| Authority | `operator-confirmed` (cite the ruling), `agent-provisional` |
| Authored by | `operator`, `agent`, `unknown` (moved from older docs) |

A section inside a document that differs from the document's facts carries its
own four lines under its heading.

Resolution is not approval. Only the operator makes something
`operator-confirmed`; an agent never does. `agent-provisional` content is the
operator's review list.

## Priority and release

Work not yet built carries two more markers: how much it matters and which
release it is for. A section puts them under its four facts; a single item, such
as a `Still in code:` line or a list entry, ends with them.

```markdown
_Priority: P1_
_Release: 1.0_
```

| Priority | Meaning |
|---|---|
| `P0` | Critical: Floe is failing. Fix and release now; nothing waits. |
| `P1` | Must be done for its release. |
| `P2` | Should ship in its release: without it quality drops, but nothing breaks. |
| `P3` | Could be done, only if there is time. |

Release is the version as major.minor (`1.0`). Fixes shipped later in that line
are patch versions (`1.0.1`, `1.0.2`) and keep the same Release. Work planned
for no release yet says `_Release: later_`.

Only the operator sets priority and release; an agent may propose them in its
pull request. Unmarked work is not yet prioritised. To find work, search the
markers, for example `rg "Priority: P1" docs/design` or
`rg "Release: 1.0" docs/design`.

## Design is the plan (D5)

Design is the one source of truth for what Floe is and for everything that will
be built or fixed. There is no other plan: no issue list, backlog or separate
document.

- Every Floe change names the design section it serves. If none exists, write
  it first as `question` or `direction` and bring it to the operator.
- Something to build is written in the section of the feature it changes, and
  that section says `Built: no` or `partly`.
- Something to fix, where Floe does not do what its design says, is a
  `Still in code:` line under the section it breaks, naming the file.
- When the change ships, the section's Built fact is updated and its
  `Still in code:` line deleted.

## Open questions (D6)

An unresolved question lives in the document it concerns under `## Open`, with
`## What would settle it` when known. When settled, update the document and its
four facts.

## Map

```
pillars/      pillars.md (mission, laws, tests), experience.md (what using Floe must feel like),
              primitives.md (the canonical list and the primitive test)
host/         installation.md, identity.md, engine.md,
              surface/ (surface, projection, presentation-state),
              extension/ (extension, hook)
workspace/    workspace, folder-binding, portable-package, connector
actor/        actor, definition, runtime-binding
context/      context, participant, subscription
event/        event, emit, cursor,
              source/ (source, pulse),
              delivery/ (delivery, endpoint, turn/ (turn, input))
scope/        scope, revision, placement, port, edge, activation,
              execution/ (scope-execution, node-execution, attempt)
command/      command
artefact/     artefact, version, content-ref
capability/   capability, access, secret, receipt
```

## Naming

The primitives and the test for adding one are in
[primitives](pillars/primitives.md).

Use **Workspace**, **Scope**, **Context**, **Actor**, **Event**, **Command** and
**Artefact** for the building blocks. Use **ScopeCompositionRevision**,
**NodePlacement**, **Port** and **Edge** for composition records, and
**ScopeExecution**, **NodeExecution**, **ExecutionAttempt** and **Delivery** for
execution records. **Thread** is legacy UI wording
only; new contracts use **Context**.

Each term is defined once, in its own document. Never use a synonym for a
defined term (for example "source type" for ConnectorDefinition), and never
reuse one name for two things.
