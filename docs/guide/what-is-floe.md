# What floe is

**Floe is a substrate: a small set of first-principle building blocks that agents and people use to design, run and improve the environment around them.**

It is not an agent framework. It is not a workflow tool. Agent frameworks compete on driving a model well; floe binds to those frameworks through the bridge and does not compete with them. Workflow tools encode procedure — fixed steps someone designed in advance. Floe encodes organisation instead: identity, memory, communication, accountability, and scheduling that persist no matter which model or which framework is doing the work today.

## The bet

Models are labor. The substrate is the company.

Every model release makes the labor smarter and cheaper. No model release gives you the company — the durable record of who did what, why, and what happened, or the coordination fabric that turns interchangeable model capability into something that compounds. Floe is that layer.

The bet is that a few stable concepts — [[Workspace]], [[Scope]], [[Actor]],
[[Context]], and [[Event]] — plus explicit composition records when repeatable
work needs them, can express what a workspace needs. Floe should extend *itself*
toward a real objective rather than needing every capability designed in up
front.

The operator's own bar for this, which the whole guide is written against:

> a few core primitives, some basic systems and a real idea to make anything possible.

## Why it survives the next model release

A better model is an upgrade event, not an extinction event. [[Actor]]s bind to models through a [[Binding]]; a new release is a configuration change that upgrades every actor in a [[Workspace]] at once. Floe stores what no model can regenerate — the [[Event]]s, [[Context]]s and work logs of what actually happened — and a 10x better model cannot remember what it was never present for.

Anything assembled inside a single vendor's harness lives at that vendor's pleasure: its memory, its scheduling, its agent definitions can change or disappear with a pricing or product decision. The record of what a workspace has done needs to outlive any one vendor relationship. And floe assumes from the start that "actor" can mean a model or a person — most tools assume one human driving one tool, and have to be rebuilt to stop assuming that.

## The redundancy test

Before floe builds anything, it asks: would a 10x better model make this unnecessary?

- If yes, it doesn't get built — it's scaffolding compensating for a weak model, and the next release deletes it.
- If it gets *more* valuable as models improve — more work flowing through identity, audit, scheduling, communication — it belongs in the substrate.

Use this test yourself when deciding whether to build something on top of floe, or to just wait for a better model.

## Who it's for

Anyone who wants actors — agents, people, or both — to coordinate on real work and leave a durable record of it: what was decided, who said what, why a check passed or failed. It suits teams running real operations through agents now, not teams looking for a chatbot wrapper or a fixed pipeline builder.

## When not to use it

If your problem is genuinely a fixed, linear procedure that never needs a person, an argument between actors, or a durable record — a plain script or CI pipeline is smaller and simpler. Floe's primitives cost you nothing if you don't need coordination, memory, or accountability across runs; if you don't need those things, they're overhead, not a feature.

## Implementation

- `MISSION.md` — the source for this page: the bet, the redundancy test, what floe is not
- `docs/guide/concepts/README.md` — [[Concepts]], the substrate vocabulary and
  its design/execution records
