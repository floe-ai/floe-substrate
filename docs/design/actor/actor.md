# Actor

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

An entity permitted to perceive, decide, communicate and act within declared
responsibility and authority. It has stable identity, a versioned
[definition](definition.md) and a separately replaceable
[runtime binding](runtime-binding.md). It receives work through an
[Endpoint](../event/delivery/endpoint.md).

Assignment to a placement or Context controls responsibility and access, never
routing.

## An Actor is an Actor

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed ("An Actor is no different if Human or LLM")_
_Authored by: operator_

Nothing in code or docs distinguishes a person from a model: no human backing
kind, no "waiting for a human" state. An Actor waits on another Actor's
response; who backs it does not matter. Actors with equivalent grants and
evidence have equivalent capabilities, validation, consequences and audit.
Responsibilities and explicit policy may differ; backing never confers privilege
or prohibition.

## Principals and roles

An authenticated principal backs an Actor only through a retained
principal–Actor binding with exact evidence. A runtime self-binding is derived by
the Bus from the exact definition and runtime binding pinned by an active
Delivery; request content cannot claim it, and revocation is never restored
implicitly.

Workspace and Scope roles use explicit retained role assignments. Context roles
use the assignment referenced by Context participation. An executor role at a
placement or NodeExecution is valid only with its exact revision. Roles may
qualify a Policy or approval decision, but never grant an operation or advance
work.

Publishing an assigned Actor's output resolves the principal's current binding
and executor evidence against the exact NodeExecution. Identifier equality is
not authority. The Event records the assigned Actor as publisher and the
principal separately.

## Direct requests

When an Actor directly requests another Actor during a NodeExecution, it remains
non-graph delegation. The result resumes the same NodeExecution, Context and
revision; the model does not manage return identifiers.

## The Floe Actor

The Floe Actor that comes with every Workspace follows the same Actor,
authority, Delivery, runtime and operation contracts as any other Actor. It
differs only in its definition and assignment, never by a privileged path. Its
coordinating behaviour (understand outcomes, discover capabilities, organise
work, verify results, keep the operator informed) belongs to the Actor, not the
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
