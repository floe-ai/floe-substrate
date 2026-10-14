# Experience

_Resolution: settled_
_Built: partly_
_Authority: agent-provisional_
_Authored by: unknown_

What using Floe must feel like, through any surface. This describes the
experience of any Actor using Floe, not internal architecture.

An Actor tells Floe what it wants to happen. Floe determines the
organisation, Actors, capabilities, Contexts, tools and continuing work
required, and forms and evolves that system. The Actor who asked does not need
to understand how Floe is implemented.

Floe's default Actor helps other Actors use Floe. Its coordinating role is
behaviour built on the substrate, not a privileged Actor class.

## What the Actor who asked does, and does not do

The Actor who asked may say what they want, what they expected, what confused them,
what feels wrong, what they want changed, what they approve or reject, and what
only they can decide or do.

The Actor who asked is never required to design Actor topology, design workflows or
graphs, wire events, choose Contexts, create substrate structures as setup work,
understand routing or delivery, or choose a substrate solution to a product
problem. Using Floe never requires creating or managing a Scope.

## What Floe does with an outcome

1. understand enough of the desired result to attempt it;
2. inspect available capabilities and relevant Workspace state;
3. compose what exists before requesting new machinery;
4. form the organisation the outcome needs;
5. start useful work;
6. continue across time and interruptions;
7. adapt when reality requires it;
8. keep the Actor who asked informed enough to trust and redirect the work;
9. involve the Actor who asked only when its judgement is valuable.

Floe does not ask implementation questions it could resolve by
inspecting, testing or experimenting.

## Capability discovery

When an outcome exposes a missing capability, Floe first discovers what already
exists: tools, Workspace state, runtime capabilities, documentation, Extension
contracts. Extensions are one way to add capability, not the default answer. A
capability Floe cannot create, install, enable or use is a product failure to
surface clearly, not a design task for the Actor who asked.

Before building a capability, strip the request to its generic need. A request
for stock-market charts needs chart rendering, structured results, data sources
and refresh, not a "stock market Extension". The result must work without any
particular surface.

## Legibility

The Actor who asked needs situational awareness, not omniscience: what outcome Floe is
pursuing, what organisation it formed, what meaningful work is happening, what
changed, what is blocked, what needs judgement, and why an important decision
happened.

The default path through any surface trends toward: **open a Workspace → talk
to Floe about an outcome → see meaningful consequences and references →
intervene when useful.** Inventories of Scopes, Actors, Contexts and settings
are a developer observatory, not the default experience. Not every capability
needs a human UI.

Stopping: while connected work is active, any Actor can stop it from the
same place. Stopping is durable: queued work, active turns, folder sources and
scheduled pulses for that operation do not resume on restart. History remains.

Stopping spend: one switch stops all work in a Workspace
([below](#stop-all-work-in-a-workspace)). An Actor can still pause or stop a single
Scope run. Pausing one Actor is deferred until a real need shows
(operator, 13 Oct).

### Stop all work in a Workspace

_Resolution: settled_
_Built: no_
_Authority: operator-confirmed (14 Oct, D29, red-team findings RT4 and RT5)_
_Authored by: operator_

One switch holds all work in a Workspace until an Actor lifts it: waiting
work, running turns, direct requests between Actors and scheduled
[Pulses](../event/source/pulse.md). Stopping work also ends that work's
operation access, so a stopped turn cannot act late.

Built today: Scope run pause and stop, Pulse pause, and stopping a single
response. None of these stops work outside its own run.

## Spend

_Resolution: settled_
_Built: partly_
_Authority: operator-confirmed (13 Oct, SP1)_
_Authored by: operator_

Any Actor can see what work is costing: tokens for every engine, and AI
credits (AIC) for Copilot, by Actor and by Workspace. Seeing spend is how it can
judge whether it is turning into progress ([pillars](pillars.md), efficient
intelligence). Floe sets no spending limits by default; budgets are
[frozen governance](../capability/access.md#frozen-governance).

Built: each turn records its token use
([Turn](../event/delivery/turn/turn.md#usage)). Not built: AIC, and any view of
spend.

## Direction: talk and watch without a surface

_Resolution: direction_
_Built: no_
_Authority: agent-provisional_
_Authored by: agent_

Floe's own command line is enough to use Floe. Any Actor can send the Floe Actor
a message, and see its replies, questions and progress as they are
pushed, with no surface installed. This also serves Actors that never open a
screen (Actor-generality test, [pillars](pillars.md)).

Today the only route is `floe operations invoke` with hand-built JSON. The first
message is refused unless it carries `--expected-revision 1`, and nothing shows
replies except the Actor's work log. Seen in live runs, 13 Oct.

## Self-describing representation

Prefer substrate objects, relationships, references, state and actions that
describe themselves well enough for a generic client to show them safely.
Bespoke presentation is for cases generic representation cannot express. This
is a design pressure, not a roadmap item.

## Progressive disclosure

Normal autonomous work is quiet. Detail appears when an Actor asks, follows
a reference, investigates, or needs to build trust. Deep telemetry sits behind
deliberate inspection.

## Direction: shape before detail

_Resolution: direction_
_Built: no_
_Authority: agent-provisional_
_Authored by: operator (thought log, June)_

Before a meaningful change, Floe proposes its shape in terms of impact: what new
capability or module, where it attaches, what the system looks like after, and
the trade-offs and risks. Once the shape is accepted, Actors break it down and
work through the detail. The Actor who asked sees consequences, not line-by-line
activity.

## Direction: history worth replaying

_Resolution: direction_
_Built: partly_
_Authority: agent-provisional_
_Authored by: operator (thought log, June)_

Records are rich enough for any surface or Actor to follow the chain from
request to actions, decisions, results and evaluation, and to review it through
different lenses: security, architecture, code, tools created, product impact.
The need is legibility over time, not a timeline screen. Actors read the same
history to avoid repeating mistakes.

## Direction: evaluation everywhere

_Resolution: question_
_Built: no_
_Authority: agent-provisional_
_Authored by: operator (thought log, June)_

Any Actor can give feedback on any result, wherever the work is: free text,
thumbs up or down, choosing between alternatives, review notes, retrospectives.
Feedback becomes structured signal for correction and improvement instead of
disappearing into chat. Reference to revisit: agent development lifecycle (ADLC)
practice, https://youtu.be/aMBQB_IJ0dQ.

### Support report

_Resolution: settled_
_Built: partly_
_Authority: agent-provisional_
_Authored by: unknown_

Any Actor can create a local support report from an affected conversation.
Floe may add a tentative explanation; system facts come from supported APIs. The
Actor sees the exact redacted report before saving or sharing; nothing is
sent automatically.

Built: Floe assembles the report (`context-diagnostics`). Each surface must
offer it; no surface has been checked.
