# Event

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

An immutable fact, signal, communication, observation or decision that landed in
Floe. Everything that makes something else happen arrives as an Event: a
message, a webhook, a folder change, a [Pulse](source/pulse.md), a published
output. Where it comes from is its [source](source/source.md). Floe pushes Events; it never
polls.

An Event records source, time, Workspace, causation, correlation, schema, small
payload facts and zero or more exact ArtefactVersion references. Those
references are fixed when the Event is [emitted](emit.md); later Artefact
associations describe relationships to it and never change it. Arbitrary Event
content is not automatically an Artefact.

An Event can start an execution, satisfy a Port, record an output or decision,
or remain non-graph communication. It reaches its target through
[Delivery](delivery/delivery.md).

## Named references

Context communication may carry optional `content.references` entries with
`name` and `resource_ref: { kind, id, revision }` (null revision: none
supplied). A reference is navigation from the author, not an assertion of
current state, authority or approval, and not an instruction to run anything.
Clients keep the selected Workspace boundary and discover current actions when
opened. Model input keeps references beside the message text. A named reference
does not create an Artefact association.

## Legacy

Event references frozen during schema 12's upgrade keep their then-visible
projection with explicit provenance; that snapshot is not evidence of which
versions were present at original emission.
