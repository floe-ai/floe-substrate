# Floe Mission

## North Star

Floe exists so people and their agent counterparts can express outcomes, organise themselves, and achieve useful work together in a durable shared environment.

Actors can form and change the organisation, capabilities, and ways of working an outcome needs. This may be a conversation, a repeatable process, a creative collaboration, or a continuing organisation. No one arrangement defines Floe.

Floe supplies the smallest durable set of mechanisms that makes this possible across models, sessions, tools, people, and time: dependable identity, authority, context, coordination, history, and continuity.

The substrate provides the environment. Actors choose and evolve the work within it. A company, pipeline, or management structure is something they may build, never the identity of the substrate.

The operator can work alongside other actors or delegate an outcome and steer by exception. They should not need to understand or design the substrate to do either.

## The proving experience

The only proving loop that matters is:

**operator expresses an outcome → Floe forms what it needs → actors work → Floe remains legible → operator steers by exception**

Every product or substrate change must make that loop materially more possible, reliable, legible, or autonomous.

A change that merely makes Floe more theoretically complete is not progress.

The development agent must attempt this experience through the actual app, observe what Floe does, correct the proven obstacle, and repeat the attempt. The operator supplies intent and judgement; they must not be the only person discovering broken or confusing behaviour. Onboarding, useful feedback, inspection, correction, and recovery are part of the outcome.

## How Floe is developed

**Do not build what Floe might need. Attempt what the operator wants, and build only what the attempt proves Floe lacks.**

Development proceeds through real use:

**Want → Attempt → Observe → Diagnose → Generalise → Change → Attempt again**

The operator contributes outcomes, reactions, confusion, corrections, preferences, and judgement. The operator is not expected to translate those experiences into architecture.

When an experience exposes a problem, diagnose the problem before choosing a solution. Prefer the smallest correction at the highest possible layer.

A delivery may be divided into small proving increments, but an increment must
be a native part of the intended design. Do not knowingly introduce a temporary
substitute for an already-understood required mechanism merely because it is
quicker to demonstrate; such substitutes become permanent state and obscure the
real gap.

## Mechanism, never policy

Floe should make many organisations possible without encoding one preferred organisation.

A workflow, pipeline, company structure, review process, graph, project method, or domain process is normally a composition built on Floe, not a Floe primitive.

A substrate primitive is earned only when real operations repeatedly demonstrate that the behaviour cannot be composed safely and generally from what already exists.

One use case demonstrates a need. Two may establish a pattern. Only repeated evidence should create a primitive.

## Operator leverage

Floe should make a human's attention unusually valuable.

Normal work should continue without supervision. Human interruption is justified when judgement, permission, inaccessible real-world action, or meaningful redirection is required.

Progress is measured by:

- useful work continuing without operator supervision;
- fewer low-value interruptions;
- higher-value human decisions;
- reliable recovery and continuation;
- the ability to form new organisations from high-level outcomes;
- operator understanding without substrate expertise;
- corrections that improve future behaviour.

## Efficient intelligence

Use model capability where judgement is needed and existing deterministic mechanisms where it is not. Keep shared instructions compact, discover capabilities when needed, retrieve relevant Context history in bounded portions, and retain useful evidence so work is not repeatedly rediscovered.

Measure tokens, time, repeated work, and human interventions per successful outcome. Lower token use is an improvement only when usefulness, correctness, continuity, and clarity are preserved. A short failed attempt followed by repeated repair is not efficient.

## Redundancy test

For every proposed substrate feature ask:

**If models become 10× more capable, does this become unnecessary or more valuable?**

If better models make it unnecessary, prefer leaving it to the model, actor instructions, tools, or an extension.

If better models make it more valuable because it provides durable identity, coordination, history, permissions, continuity, boundaries, or model-independent organisation, it may belong in the substrate.

## Actor-generality test

A substrate mechanism should remain valuable to an actor that never opens a human UI.

Human interfaces are clients of the substrate, not the substrate itself.

People and models are different ways to participate as actors, not different classes of substrate authority. Actors with equivalent grants and required evidence must have equivalent semantic capabilities, validation, consequences, and audit. Responsibilities and explicit policy may differ; human or model backing cannot itself confer a privilege or prohibition.

## First-principles restraint

Floe is not a workflow product with every workflow prebuilt.

Floe is not an observability product whose purpose is to expose every internal primitive.

Floe is not a graph editor.

Floe is not a collection of architecture patterns waiting to be implemented.

Floe is a small set of durable mechanisms from which actors can construct the organisation an outcome requires.

The goal is not to finish the architecture.

The goal is for the operator to be able to say:

> I gave Floe something important to achieve. It formed what it needed, kept working, and made the result easy to understand and steer. I could join the work or leave it running, and it involved me when my judgement mattered.
