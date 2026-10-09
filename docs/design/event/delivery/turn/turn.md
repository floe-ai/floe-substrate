# Turn

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

An [Endpoint](../endpoint.md)'s processing cycle for one [Delivery](../delivery.md),
built from one origin Context. Unrelated context never bleeds into a turn.
Runtime sessions are ephemeral and isolated per Actor and Context.

A non-empty natural completion is stored in the target NodeExecution Context, or
the direct Delivery Context when there is no NodeExecution. It does not advance
a ScopeExecution; only publication to a named output Port does that.

Extensions can act at points in a turn through [hooks](../../../host/extension/hook.md).
What the model receives is [turn input](input.md).

Turn end is a lifecycle signal, not a message. The Bridge observes the
runtime's own completion and reports the Endpoint's state to the Bus.

Tool calls and scratch reasoning stay private trace unless the Actor
deliberately contributes a result. Tool failure combines runtime exceptions with
explicit failure results: a command that returns a nonzero exit is a failed
operation in progress, hooks and the work log.

## Usage

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

Each turn records one usage record: input, output, cache-read and cache-write
tokens summed over every model call in the turn, with model-call and tool-call
counts (`measurement_scope: turn`). Raw per-call usage is kept beside it. A
runtime that does not report a call count is labelled `last_model_call`; a turn
with no usage is `unmeasured`. Neither is ever shown as a whole-turn figure.

## Required outputs

_Resolution: direction_
_Built: yes_
_Authority: operator-confirmed (8 Oct: keep for now, revisit)_
_Authored by: unknown_

When an Actor step's turn ends, its required outputs settle without a silent
wait. A step with exactly one required output Port, and no schema or saved-file
type on it, hands on the non-empty completion through that Port; an explicit
publication wins. Otherwise a step still missing required output gets exactly
one recorded reminder turn in the same Context naming what is missing, and fails
with `required_output_not_handed_on` if it is still missing.

## What would settle it

Real Scope runs showing whether the automatic hand-on and single reminder help
or surprise the operator.

## Work log

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

A local Markdown audit projection of a turn, kept in the Workspace's git-ignored
`.floe/state`. A turn never changes tracked files by writing it. It is evidence,
not execution state, topology, an Artefact ledger, or what makes a response
visible.
