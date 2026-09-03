# Working rules

Read `MISSION.md` for why Floe exists, `PRODUCT.md` for the operator experience, `CONTEXT.md` for current terminology and invariants, and accepted ADRs in `docs/adr/` for decisions reality has already forced.

This file governs agents developing the Floe repository.

## Prime directive

**Do not build what Floe might need. Attempt what the operator wants, and build only what the attempt proves Floe lacks.**

The operator is not the architect.

Treat operator input as product evidence: an outcome, observation, confusion, reaction, judgement, preference, or correction. Do not make the operator translate that evidence into architecture.

If the operator proposes a solution, preserve the underlying need but independently diagnose whether that solution belongs in Floe.

## Abstract before solving

**Always zoom out to first principles before proposing or implementing a solution.**

Do not reason only inside the framing you were given. Before choosing what to build, strip away:

- the operator's proposed solution;
- existing Floe terminology;
- current UI structure;
- issue, PR, roadmap, or Wayfinder framing;
- existing implementation choices;
- domain-specific assumptions.

Restate the observed need as the smallest generic capability or constraint that remains.

Only then decide where the solution belongs.

Classify the solution at the highest appropriate layer:

1. **Actor / configuration** — behaviour achievable through responsibilities, instructions, existing tools, or composition.
2. **Client / representation** — a human interpretation or interaction over state that already exists.
3. **Extension** — an opinionated capability, integration, workflow, presentation, policy, or domain-specific composition built from existing primitives.
4. **Substrate / primitive** — a generic, domain-neutral, policy-free mechanism: a new Lego piece that enables many unrelated systems and cannot be safely or generally composed from existing primitives.

**The substrate supplies mechanism, not opinion.**

Extensions are allowed to be opinionated. The substrate is not.

Before putting behaviour into the substrate, ask:

> Could two legitimate Floe use cases reasonably want different behaviour here?

If yes, Floe core should normally expose the mechanism and allow an actor, configuration, extension, or client to choose the policy.

A primitive does not need to appear in every use case, but it must be generic and useful independent of a particular domain or preferred way of working.

When uncertain, default outward: keep the behaviour out of the substrate until real operations prove that it belongs there.

After classifying the need, choose the smallest change that satisfies it and return to the real operator experience.

## How work proceeds

**Attempt before designing. Build to learn. Grill what exists.**

The normal loop is:

**Want → Attempt → Observe → Diagnose → Generalise → Change → Attempt again**

A question about something already running is checkable. A question about hypothetical future machinery is a guess.

When uncertainty can be answered by a small experiment, run the experiment rather than starting a design interrogation.

Deliver end-to-end vertical slices. Prefer the smallest change that advances a real outcome. Avoid horizontal plumbing, speculative abstraction, ontology expansion, and unrelated improvement.

Small describes the delivery boundary, not permission to build a disposable
substitute. When repeated operation or an accepted decision has already proved
the required end-state mechanism, implement a native increment of that mechanism.
Do not add an interim source of truth, inferred contract, compatibility model, or
UI-owned behaviour merely because it produces a quicker demonstration.

After every meaningful product change, return to the proving experience.

## Solution hierarchy

When an observed problem appears, prefer solutions in this order:

1. better actor behaviour or instructions;
2. composition of existing substrate mechanisms;
3. an existing tool or capability;
4. a workspace-specific capability;
5. a reusable external extension;
6. a substrate change.

Substrate is the last resort.

Do not add a primitive because a concept is useful to describe. Add one only when repeated real operations demonstrate that existing mechanisms cannot safely and generally compose the required behaviour.

## Primitive freeze

Assume the existing core is sufficient to discover what is actually missing.

Treat Workspace, Actor/Endpoint, Context, Event/emit, and optional Scope as the protected conceptual nucleus unless real operation proves otherwise.

Runtime boundaries, durable delivery/history, tools/extensions, and world ingress are enabling infrastructure.

Do not introduce a new first-class noun, node kind, lifecycle, graph concept, or substrate citizen without evidence from attempted work.

## Wayfinding and design discussion

Wayfinding is diagnostic, not generative.

Use it to investigate a bounded obstacle encountered during real work. Do not ask Wayfinder or another design process to roam the system looking for things to solve.

Ask the operator only questions whose answers are genuinely subjective or require their judgement.

Do not ask the operator to choose between internal architecture alternatives that can be resolved through code, tests, prototypes, or first principles.

## Issue discipline

Do not create issue trees from speculative consequences.

Create work when it:

- blocks the current real operation;
- represents an observed recurring failure;
- is a regression;
- is necessary to preserve an already-proven invariant.

Unproven ideas belong in observations/hypotheses without roadmap weight.

## floe-app rule

The current `floe-app` contains useful implementation and debugging surfaces, but its existing information architecture is not authoritative product design.

When the operator experiences a UI tension, treat the tension as evidence, not a prescribed screen:

1. restate the underlying human need in experience terms;
2. test what the current system already exposes;
3. prefer actor behaviour, summaries, references, or a generic projection before bespoke UI;
4. create a purpose-specific surface or lens only when the need requires one;
5. add bespoke coded presentation only when self-describing or generic representation is insufficient;
6. return to the operator experience and test whether the tension is actually resolved.

Prefer substrate/client contracts that are self-describing enough for a generic client to inspect and render safely. Adding a substrate concept should not normally require bespoke `floe-app` code merely to make it inspectable.

This is not a requirement to expose every substrate concept in the default UI. Generic inspectability and operator prominence are separate decisions.

Do not continue expanding the current Scope/Actor/Activity/Substrate-Settings shell simply because new substrate state can be exposed there.

Treat substrate-oriented inventory/configuration views as a developer observatory unless real operator use proves direct manipulation belongs in the product.

The default operator experience should trend toward:

**workspace → Floe conversation/outcome → meaningful references and interventions**

When an operator says they cannot see or understand something, diagnose the smallest legibility need. Do not infer a requirement to visualise the whole substrate.

Do not create a lens framework, plugin surface system, universal renderer, or design system merely to solve one observed UI need. Let repeated useful surfaces earn shared abstractions.

## Capability and extension discovery

The default Floe actor should not be a substrate engineer, but it must be able to discover how to extend its capabilities when a real outcome requires it.

Do not hardcode stale extension recipes into actor instructions.

When extension behaviour matters, inspect current accepted ADRs, runtime/code contracts, and capability discovery surfaces.

**Extension source and extension installation are different concerns.**

- A workspace-installed Floe extension is represented under `.floe/extensions/NAME/`; the bridge discovers workspace extensions there.
- Extension source may be authored and maintained outside the workspace-installed copy, including in an independent repository or package.
- Do not develop against an installed workspace copy when a canonical source package exists.
- An installed `extension.json` may point to canonical source rather than duplicate it.
- Read ADR-0002 and ADR-0006 together with current loader behaviour. ADR-0006's independent-repository rule is a source/development boundary, not removal of `.floe/extensions` as the workspace installation/discovery surface.

If canonical documentation states this ambiguously, repair the documentation before allowing the ambiguity to drive implementation.

Working PRDs and historical notes are evidence, not authority.

## Source of truth

Resolve "what currently happens" from:

1. current code and runtime behaviour;
2. tests and logs;
3. repository documentation and ADRs;
4. prior assumptions or memory.

Resolve "what should happen" from `MISSION.md`, `PRODUCT.md`, first principles, and evidence from real operation. Current code is not proof that an existing product decision is correct.

Within documentation:

- `MISSION.md` — permanent purpose and product-development laws.
- `PRODUCT.md` — operator experience contract.
- `CONTEXT.md` — current terminology and substrate invariants.
- accepted ADRs — lasting decisions that have been earned.
- `docs/plans/` — disposable slice plans.
- worklogs, evidence, implementation reviews, closed plans, issue/PR/map prose — historical evidence.

A ticket saying a decision was accepted does not make it canonical. The committed canonical document must exist.

Surface contradictions. Do not silently choose the convenient side.

## Pre-release stance

Nothing external depends on this repository yet.

- Do not preserve backward compatibility for its own sake.
- Do not add migration machinery for schemas/config that can simply be replaced.
- Prefer deletion and replacement when an approach is wrong.
- Do not knowingly accumulate tech debt "for later".
- Preserve credentials and other genuinely valuable user state when maintenance requires resets.

Pre-release status licenses correction, not sloppiness.

## Standing substrate invariants

These are prohibitions that are not obvious merely from reading code.

- The substrate is push-only. Do not add recurring polling, reconcile intervals, or liveness loops as normal substrate behaviour.
- A runtime turn is built from one origin context; do not bleed unrelated context into it.
- Runtime sessions are ephemeral and isolated per actor/context.
- Tool calls and scratch reasoning are not automatically public context content.
- `.floe/floe.yaml` is committed project configuration, not runtime scratch state.
- The substrate does not encode a human/agent type distinction.
- Extensions are independent repositories building against the substrate contract.
- Developer build commands are not product features.

If real use proves an invariant wrong, surface the evidence and deliberately reconsider it rather than routing around it.

## Completion

A change is not complete because the implementation compiles.

It is complete when:

- the relevant tests pass;
- documentation made false by the change is corrected;
- the original real-world attempt can be rerun;
- the operator experience is measurably closer to the intended outcome.

Then stop.

No "while we're here".
