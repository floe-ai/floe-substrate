# How Floe design works

`docs/design/` describes Floe: what exists and what is intended. It leads
development. Code follows design, not the other way round.

Design records intended behaviour, rules and outcomes. Implementation details
(file layout, frameworks, internal APIs) belong in code and `docs/reference/`
unless a technical property is itself part of the design.

## Where a document goes

- **P1. The top level is fixed.** `pillars/` (goals and laws for all of Floe),
  `host/` (Floe on one machine), the seven building blocks (`workspace/`,
  `actor/`, `context/`, `event/`, `scope/`, `command/`, `artefact/`) and
  `capability/` (who may do what). Changing the top level needs operator
  approval.
- **P2. Below that, a thing lives inside the one thing it cannot exist without.**
- **P3. A file becomes a folder only when a part of it needs its own document.**
  `budget.md` became part of `capability/policy/` because a budget only exists
  as a Policy limit.
- **P4. If a document could fit in two places, the structure is wrong.**
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

## Design before code (D5)

Every Floe change names the design document it serves. If none exists, write it
first as `question` or `direction` and bring it to the operator. A change that
is `Built: no` in design is the roadmap; nothing else is.

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
command/      command, external-effect
artefact/     artefact, version, content-ref
capability/   capability, grant, secret, receipt, audit,
              policy/ (policy, budget, approval)
```

## Naming

The primitives and the test for adding one are in
[primitives](pillars/primitives.md).

Use **Workspace**, **Scope**, **Context**, **Actor**, **Event**, **Command** and
**Artefact** for the building blocks. Use **ScopeCompositionRevision**,
**NodePlacement**, **Port** and **Edge** for composition records, and
**ScopeExecution**, **NodeExecution**, **ExecutionAttempt**, **Delivery** and
**ExternalEffectReceipt** for execution records. **Thread** is legacy UI wording
only; new contracts use **Context**.

Each term is defined once, in its own document. Never use a synonym for a
defined term (for example "source type" for ConnectorDefinition), and never
reuse one name for two things.
