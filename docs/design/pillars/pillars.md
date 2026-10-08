# Pillars

_Resolution: settled_
_Built: partly_
_Authority: agent-provisional_
_Authored by: unknown_

Floe exists so people and their agent counterparts can express outcomes,
organise themselves, and achieve useful work together in a durable shared
environment.

Actors can form and change the organisation, capabilities, and ways of working
an outcome needs: a conversation, a repeatable process, a creative
collaboration, or a continuing organisation. No one arrangement defines Floe.

Floe supplies the smallest durable set of mechanisms that makes this possible
across models, sessions, tools, people, and time: dependable identity,
authority, context, coordination, history, and continuity. Actors choose and
evolve the work within it. A company, pipeline, or management structure is
something they may build, never the identity of Floe.

The operator can work alongside other Actors or delegate an outcome and steer by
exception, without needing to understand or design the substrate.

## The proving experience

**operator expresses an outcome → Floe forms what it needs → Actors work → Floe
remains legible → operator steers by exception**

Every product or substrate change must make that loop materially more possible,
reliable, legible, or autonomous. A change that only makes Floe more
theoretically complete is not progress.

## Mechanism, never policy

Floe makes many organisations possible without encoding one preferred
organisation. A workflow, pipeline, company structure, review process, graph,
project method, or domain process is a composition built on Floe, not a Floe
primitive.

If two legitimate uses could want different behaviour, Floe exposes the
mechanism and lets an Actor, configuration, Extension or surface choose.

A primitive is earned only when real operations repeatedly show the behaviour
cannot be composed safely and generally from what exists. One use case shows a
need; two may show a pattern; only repeated evidence creates a primitive.

## Operator leverage

Normal work continues without supervision. Interrupting the operator is
justified only for judgement, permission, real-world action they alone can take,
or meaningful redirection.

Progress means: useful work continuing unsupervised; fewer low-value
interruptions; higher-value decisions; reliable recovery and continuation;
forming new organisations from high-level outcomes; understanding without
substrate expertise; corrections that improve future behaviour.

## Efficient intelligence

Use model capability where judgement is needed and deterministic mechanisms
where it is not. Keep shared instructions compact, discover capabilities when
needed, retrieve Context history in bounded portions, and retain evidence so
work is not rediscovered.

Measure tokens, time, repeated work and interventions per successful outcome.
Fewer tokens is an improvement only when usefulness, correctness, continuity and
clarity hold.

## Laws

These apply everywhere. Each is owned here; other documents link here.

### Push, never poll

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed ("Ban Polling for everything please")_
_Authored by: operator_

State and progress flow as pushed events. No recurring polling, reconcile
intervals or liveness loops, in Floe or in surfaces. Request/response is for
actions only. A Connector may poll an outside source only where that source
offers nothing else.

### No environment-variable switches

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed (no-globals ruling)_
_Authored by: operator_

Behaviour is configured in Floe's configuration file, never by environment
variables.

### Local-first

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed (29 Sep ruling)_
_Authored by: operator_

Floe runs on this machine. Remote access, passkeys, tunnels and multi-user
deployment are deferred, not designed away. See the direction below.

### Pre-release

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

Nothing external depends on Floe yet. Prefer replacement over compatibility and
migration machinery. Preserve credentials and genuinely valuable user state.

## Tests every change must pass

- **Delete test.** If deleting one surface would leave something in Floe that
  only made sense for it, it does not belong in Floe. Floe owns shared
  mechanism; a surface owns its domain, rules, formats and state.
  _Authority: operator-confirmed (30 Sep ruling)._
- **Redundancy test.** If models become 10× more capable, does this become
  unnecessary (leave it to models, instructions, tools or an Extension) or more
  valuable (durable identity, coordination, history, permissions, continuity,
  boundaries: may belong in Floe)?
- **Actor-generality test.** A mechanism must stay valuable to an Actor that
  never opens a human UI. Human interfaces are clients, not the substrate. See
  [Actor](../actor/actor.md).

## What Floe is not

Not a workflow product with every workflow prebuilt. Not an observability
product exposing every internal primitive. Not a graph editor. Not a collection
of architecture patterns waiting to be implemented.

The goal is for the operator to say:

> I gave Floe something important to achieve. It formed what it needed, kept
> working, and made the result easy to understand and steer. I could join the
> work or leave it running, and it involved me when my judgement mattered.

## Direction: the complete product

_Resolution: direction_
_Built: partly_
_Authority: agent-provisional_
_Authored by: unknown_

One provider-neutral substrate with many clients: desktop, mobile, shared
deployment, CLI, public API and Actors all operate on the same organisation and
safety contract. The end state includes durable Scope design and execution,
canonical Artefacts, typed Connectors, credential brokering, safe Extensions,
portable local operation, shared multi-user deployment, and a mobile experience
for conversation, attention, approval, status, recovery and Artefact inspection.

Built today: local operation, Scopes, Artefacts, Connectors, credential
brokering, Extensions. Not built: shared multi-user deployment, mobile, remote
access (deferred by Local-first).

Release boundaries must not redefine these as speculative.
