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
