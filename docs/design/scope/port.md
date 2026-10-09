# Port

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

A stable typed input or output interface on a [placement](placement.md). It may
carry a control Event, exact ArtefactVersion references, or both. Required
cardinality, schema compatibility, collection role and output identity policy
belong to the Port contract.

An output Port with `min_count` above zero is required: its step completes only
once it has been handed on (see [Turn](../event/delivery/turn/turn.md)). The count
bounds saved ArtefactVersion references only when the Port declares
`artefact_types`; otherwise a text or data publication satisfies it.

An output Port's optional `schema` (JSON Schema) is enforced on every
publication, including a reply handed on as output; a mismatch is refused,
naming the fields. `schema_ref` is only a contract name.
