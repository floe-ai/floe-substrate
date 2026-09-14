# Floe Product Contract

This document defines the intended human experience of Floe. It does not prescribe internal architecture.

## The product

The operator tells Floe what they want to happen.

Floe determines what organisation, actors, capabilities, contexts, tools, and continuing work are required. It forms and evolves that system using the substrate.

The operator should not need to understand how Floe is implemented in order to use it.

Floe is the shared environment; the default Floe actor helps the operator use it. The operator may collaborate directly, delegate an outcome, or change their involvement as the work evolves. The default actor's coordinating role is behaviour built on the substrate, not a privileged actor class or a mandatory organisation.

## Complete product direction

Floe is one provider-neutral substrate with multiple clients. The desktop app,
mobile experience, shared deployment, CLI, public API, and Actors operate on the
same canonical organisation and safety contract rather than maintaining client-
specific versions of it.

The complete product includes:

- explicit, versioned Scope design and durable execution which can branch,
  converge, wait, retry, stop, recover, and preserve exact history;
- canonical Artefact identity, immutable versions, provenance, collections, and
  relationships across files, images, source trees, websites, reports, external
  references, and future content types;
- typed connectors for external Event sources and actions, including webhook,
  scheduled, API, and legitimately polled sources;
- credential brokering through operating-system or managed secret stores,
  narrow grants, approvals, redaction, rotation, and audit;
- safe, versioned Extensions which may contribute capabilities, connectors,
  schemas, templates, previews, renderers, dashboards, and bounded product
  surfaces under declared permissions and approval;
- portable local operation, shared multi-user deployment, and a mobile
  experience for conversation, attention, approval, status, recovery, and
  Artefact inspection without changing substrate semantics.

These are end-state capabilities. They need not ship in one release, but release
boundaries must not redefine them as speculative or design foundations that make
them harder to deliver later.

Human and model clients use the same semantic capabilities under equivalent authority and evidence. Presentation and authentication may differ; backing does not grant extra rights.

Opening Floe locally requires no browser pairing step. The local app establishes
access automatically. Remote access may require pairing before that session can
use the approved Workspace. Connection mechanics should not become work for the
operator when Floe already runs on the same computer.

## Operator contract

The operator may say:

- what they want;
- what they expected;
- what confused them;
- what feels wrong;
- what they want changed;
- what they approve or reject;
- what only they can decide or do.

The operator should not be required to:

- design actor topology;
- design workflows or graphs;
- wire events;
- choose contexts;
- create substrate structures as setup work;
- understand routing or delivery;
- choose a substrate solution to a product problem.

There is no Default Scope that the operator must understand or manage. Scopes are optional substrate organisation when the work actually needs them.

## Floe's responsibility

Given an outcome, Floe should:

1. understand enough of the desired result to attempt it;
2. inspect available capabilities and relevant workspace state;
3. compose what already exists before requesting new machinery;
4. form the organisation required to pursue the outcome;
5. start useful work;
6. continue across time and interruptions;
7. adapt the organisation when reality requires it;
8. keep the operator sufficiently informed to trust and redirect the work;
9. ask for human involvement only when it is valuable.

Floe should not ask the operator to solve implementation questions that Floe or its development system can resolve by inspecting, testing, or experimenting.

## Capability discovery

Floe is not expected to preload every implementation detail.

When a real outcome exposes a missing capability, Floe should first discover what is already available. It may inspect tools, workspace state, runtime capabilities, canonical documentation, and accepted extension contracts for a concrete reason.

Extensions are one possible way to add capability, not the default answer to every problem.

If an outcome requires a capability that Floe cannot currently create, install, enable, or use, that is a product failure to surface clearly. It is not a request for the operator to design the missing substrate mechanism.

## floe-app

`floe-app` is the preferred human operator surface, but the existing application is not automatically the product specification.

The default operator path should be simple:

**open a workspace → talk to Floe about an outcome → see meaningful consequences and references → intervene when useful**

The operator interface should show the organisation Floe has created and the state that matters to the operator. It should not default to an inventory of substrate primitives.

Existing views that enumerate or configure Scopes, Actors, Contexts, runtime details, activity, or substrate settings may remain useful as a developer/debugging observatory. Their existence does not make them part of the default operator experience.

Do not extend those observatory surfaces merely because a new substrate capability exists.

Do not create a requirement that every substrate capability must have a human UI.

Do not require the operator to browse the substrate to discover whether work is healthy.

## Legibility

The operator needs situational awareness, not omniscience.

Floe should make it possible to understand:

- what outcome it is pursuing;
- what organisation it formed;
- what meaningful work is happening;
- what changed;
- what is blocked;
- what needs human judgement;
- why an important decision or action occurred.

When connected work is still active, the operator must be able to stop it from
the same work surface. Stopping is durable: queued work, active model or command
turns, folder sources, and scheduled pulses for that operation do not resume on
restart. Its history remains available so stopping work does not erase what
happened.

The appropriate representation should be discovered through use. It may be conversation, summaries, references, notifications, generated surfaces, or other forms.

No universal visualisation architecture is assumed.

### Approved pipeline presentation

The existing pipeline and Work presentation must visually match the
[approved pipeline focus prototype](docs/design/approved-pipeline-focus/README.md).
The operator approved its appearance and progressive navigation on 2026-09-02
and explicitly reaffirmed visual fidelity for the next revision on 2026-09-06.
Preserve the image and output cards, actor labels, visible branch connections,
focused step with neighbouring layers, conversation access, spacing, contrast,
and responsive behaviour. Similar navigation alone does not satisfy approval.

Use current canonical plan, execution, Context and Artefact records to populate
that presentation. The prototype's example content and proposed Context split
are not live facts or a replacement for ADR-0010. Technical details and history
remain available through deliberate inspection. Visual comparison in the actual
app is required before the next revision is declared ready.

## Self-describing representation

Prefer a substrate whose objects, relationships, references, state, and available actions are self-describing enough that clients can provide a safe generic representation without bespoke UI code for each concept.

A generic representation is a fallback for legibility and inspection, not a mandate to place every substrate concept in front of the operator.

When a human need requires a richer surface, Floe may compose a purpose-specific projection or lens from the same underlying shapes. Bespoke coded UI should be reserved for cases where generic or declarative representation cannot express the required interaction or meaning.

This is a design pressure, not a roadmap item. Build it only when real operator experience proves where generic interpretation is insufficient.

## Progressive disclosure

Normal autonomous work should be quiet.

More detail should become available when the operator asks, follows a reference, investigates a problem, or needs to build trust.

Deep substrate telemetry belongs behind deliberate inspection, not in the normal product path.

When real use exposes a problem, the operator should be able to create a local support report from the affected conversation. Floe may contribute a tentative semantic explanation, while system facts come from authoritative supported APIs. The operator sees the exact redacted report before saving or sharing it; Floe does not transmit the report automatically. Reproduction should begin in an isolated workspace when replay could create persistent unwanted state, external effects, or material token use.

When persistent work produces or consumes an Artefact, the Workspace and Work
surfaces may project its canonical versions, provenance, lineage, collections,
and related Contexts. The client may preview safe content and offer focused visual
or domain-specific representations over the same canonical records. Floe owns
stable Artefact and immutable ArtefactVersion identity and universal provenance.
Extensions retain domain schemas, specialised statuses, invalidation and
regeneration policy, and rich presentation. An extension document may be import
evidence or a projection, but not a competing identity ledger.

## Product development

Product needs are discovered from real use.

The development agent must use the actual app as an operator: begin with onboarding, express an outcome in conversation, inspect useful results, make a correction, and verify continuation and stopping across interruptions. Use an isolated workspace when the attempt could create unwanted state or effects. Preserve the operator's credentials and work.

Record the observed behaviour, relevant app views, result references, and remaining gaps. A passing component check or a convincing conversation is insufficient without the expected work and usable controls. Verify the running version being exercised.

Assess efficiency over the complete outcome, including input, output, cached and reasoning tokens where available, elapsed time, repeated attempts, and human interventions. Keep quality and UX acceptance fixed when comparing changes; record unavailable measurements as unavailable. Rich model capability and efficient use of it are compatible goals.

A user observation such as "I cannot tell what happened" is evidence of a legibility problem. It is not an instruction to build a universal visualiser.

A user observation such as "I expected this to continue" is evidence of a continuity failure. It is not an instruction to add a particular scheduler.

Diagnose the experience first. Build the smallest general correction that is a
native part of the understood destination. Then return the product to the
operator. Do not ship a knowingly disposable substitute for an already-proven
missing mechanism.
