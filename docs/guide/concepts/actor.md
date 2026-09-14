# Actor

**An Actor is an entity permitted to perceive, decide, communicate, and act within declared responsibility and authority.**

A person, local model, hosted model, deterministic service, or future runtime
backing does not change Actor identity or Scope semantics. The substrate does
not encode a human/agent type distinction.

## Identity, definition, and runtime stay separate

An Actor has stable identity. Its charter, responsibilities, knowledge, budgets,
trust policy, instructions, capability grants, and escalation rules belong to
an immutable ActorDefinitionRevision. A draft may change; publication freezes
the revision.

Runtime embodiment is a separately replaceable binding to a RuntimeProfile. An
ExecutionAttempt records the exact ActorDefinitionRevision and runtime binding
it used, so later edits do not rewrite history.

## Placement and participation

A NodePlacement may reference an Actor and add placement-specific instructions
or policy for one ScopeCompositionRevision. A Context participant relationship
may give the Actor a role and access in one Context. Neither relationship makes
the Actor owned by the Scope or Context, and neither creates an Edge.

Placement instructions use the discovered `bindings` array with
`{ "kind": "instructions", "text": "..." }`. The runtime appends these ordered
bindings to the pinned Actor definition's instructions. `config.instructions`
is configuration data and is not injected. Discovery describes the binding
fields and invocation rejects malformed bindings before storing a draft.

Capability refusals include the canonical recovery evidence in the model's
tool result: the refusal code, whether a retry is appropriate, the required
action, relevant details and receipt identity when one exists. The Actor can
use the returned current revision instead of guessing after a conflict.
Successful results also expose exact target and changed references, plus
progress, cancellation and audit references when present. Use a changed
resource's returned revision for the next operation; do not construct it from
individual result fields.

For a saved Scope result, `scope.execution.inspect` accepts
`include_outputs: true`. This returns the published Event content and exact attached
ArtefactVersion IDs alongside each publication reference. Ordinary Context
messages are excluded. A missing or mismatched Event stays unavailable; the
inspection does not substitute another result. Leave this option off when only
execution status is needed.

## Model image inspection

The Bridge's `read_image` tool supplies a preview at most 1,536 pixels on either
side, without enlarging or changing the source. It supports PNG, JPEG, GIF and
WebP sources up to 20 MiB and 64 megapixels, applies image orientation, and shows
the first frame of an animation. The result identifies the source by its SHA-256
and dimensions, alongside the preview dimensions. Unsupported, oversized or
corrupt input returns a recoverable tool result instead of forwarding those
bytes to the model. This is a runtime input bound, not an Artefact transformation.

## Legacy definition files

`.floe/agents/<id>.md` remains a portable definition source used by the current
Bridge and migration tooling. It must import or project into canonical Actor and
ActorDefinitionRevision records; the file path and frontmatter are not the
Actor's universal identity.

## Implementation

- `floe-bus/src/actor-definitions.ts` — canonical Actor identity and immutable
  definitions
- `floe-bus/src/actor-definition-operations.ts` — shared Actor lifecycle and
  definition operations
- `floe-bus/src/runtime-profiles.ts` — runtime profiles and Actor bindings
- `floe-bridge/src/project.ts` — legacy `.floe/agents/*.md` loading boundary

See [[Glossary]].
