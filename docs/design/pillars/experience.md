# Experience

_Resolution: settled_
_Built: partly_
_Authority: agent-provisional_
_Authored by: unknown_

What using Floe must feel like, through any surface. This describes the human
experience, not internal architecture.

The operator tells Floe what they want to happen. Floe determines the
organisation, Actors, capabilities, Contexts, tools and continuing work
required, and forms and evolves that system. The operator does not need to
understand how Floe is implemented.

Floe's default Actor helps the operator use Floe. Its coordinating role is
behaviour built on the substrate, not a privileged Actor class.

## What the operator does, and does not do

The operator may say what they want, what they expected, what confused them,
what feels wrong, what they want changed, what they approve or reject, and what
only they can decide or do.

The operator is never required to design Actor topology, design workflows or
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
8. keep the operator informed enough to trust and redirect the work;
9. ask for human involvement only when it is valuable.

Floe does not ask the operator implementation questions it could resolve by
inspecting, testing or experimenting.

## Capability discovery

When an outcome exposes a missing capability, Floe first discovers what already
exists: tools, Workspace state, runtime capabilities, documentation, Extension
contracts. Extensions are one way to add capability, not the default answer. A
capability Floe cannot create, install, enable or use is a product failure to
surface clearly, not a design task for the operator.

Before building a capability, strip the request to its generic need. A request
for stock-market charts needs chart rendering, structured results, data sources
and refresh, not a "stock market Extension". The result must work without any
particular surface.

## Legibility

The operator needs situational awareness, not omniscience: what outcome Floe is
pursuing, what organisation it formed, what meaningful work is happening, what
changed, what is blocked, what needs judgement, and why an important decision
happened.

The default path through any surface trends toward: **open a Workspace → talk
to Floe about an outcome → see meaningful consequences and references →
intervene when useful.** Inventories of Scopes, Actors, Contexts and settings
are a developer observatory, not the default experience. Not every capability
needs a human UI.

Stopping: while connected work is active, the operator can stop it from the
same place. Stopping is durable: queued work, active turns, folder sources and
scheduled pulses for that operation do not resume on restart. History remains.

## Self-describing representation

Prefer substrate objects, relationships, references, state and actions that
describe themselves well enough for a generic client to show them safely.
Bespoke presentation is for cases generic representation cannot express. This
is a design pressure, not a roadmap item.

## Progressive disclosure

Normal autonomous work is quiet. Detail appears when the operator asks, follows
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
work through the detail. The operator sees consequences, not line-by-line
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

The operator can create a local support report from an affected conversation.
Floe may add a tentative explanation; system facts come from supported APIs. The
operator sees the exact redacted report before saving or sharing; nothing is
sent automatically.

Built: Floe assembles the report (`context-diagnostics`). Each surface must
offer it; no surface has been checked.
