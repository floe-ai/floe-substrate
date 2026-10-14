# Actor

_Resolution: settled_
_Built: partly_
_Authority: agent-provisional_
_Authored by: unknown_

An entity that perceives, decides, communicates and acts within declared
responsibility. It has stable identity, a versioned
[definition](definition.md) and a separately replaceable
[runtime binding](runtime-binding.md). It receives work through an
[Endpoint](../event/delivery/endpoint.md).

Assignment to a placement or Context controls responsibility, never routing or
access.

## An Actor is an Actor

_Resolution: settled_
_Built: partly_
_Authority: operator-confirmed ("An Actor is no different if Human or LLM")_
_Authored by: operator_

Nothing in code or docs distinguishes a person from a model: no human backing
kind, no "waiting for a human" state. An Actor waits on another Actor's
response; who backs it does not matter. Every Actor in a Workspace has the same
access by default ([Workspace access](../capability/access.md)), and backing
never confers privilege or prohibition. Responsibilities may differ.

Still in code: the Bus treats a single person differently from other Actors
(local product policy, the approvals `local_operator`, a `backing_kind` model
check in `store.ts`).

## Principals

An authenticated principal backs an Actor only through a retained
principal–Actor binding with exact evidence. A runtime self-binding is derived by
the Bus from the exact definition and runtime binding pinned by an active
Delivery; request content cannot claim it, and revocation is never restored
implicitly. A principal records who acted; it does not decide access.

Publishing an assigned Actor's output resolves the principal's current binding
and executor evidence against the exact NodeExecution. Identifier equality is
not proof of who acted. The Event records the assigned Actor as publisher and
the principal separately.

## Direct requests

When an Actor directly requests another Actor during a NodeExecution, it remains
non-graph delegation. The result resumes the same NodeExecution, Context and
revision; the model does not manage return identifiers.

## The Floe Actor

The Floe Actor that comes with every Workspace follows the same Actor,
Delivery, runtime and operation contracts as any other Actor. It
differs only in its definition and assignment, never by a privileged path. Its
coordinating behaviour (understand outcomes, discover capabilities, organise
work, verify results, keep the Actor who asked informed) belongs to the Actor, not the
substrate (`floe-bridge/src/prompts/default-floe-agent.md`).

## Direction: responsibilities route work

_Resolution: question_
_Built: no_
_Authority: agent-provisional_
_Authored by: operator (thought log, June)_

An Actor asked to do something outside its responsibilities does not silently do
it. It hands the work back, naming the mismatch, so an Actor with the right remit
can take it. With no suitable Actor, the work becomes a visible unowned
responsibility rather than disappearing. Something that coordinates the
Workspace then decides: extend an existing Actor, create one, or redraw
boundaries.

Origin: agent ADR-0009 (25 Aug), partly replaced by agent ADR-0011 (4 Sep).
