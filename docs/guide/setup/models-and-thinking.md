# Models and thinking level

**A runtime binding selects a versioned RuntimeProfile for an [[Actor]] without changing the Actor's identity.**

A RuntimeProfile may describe provider, model, reasoning effort, tool policy,
and other runtime configuration. Provider credential material is not part of
the profile. The profile refers to SecretRef metadata that a trusted broker may
resolve only under current grants and a matching purpose.

## Model catalogue

Model catalogues come from the runtime provider adapter that will execute the
work. A provider may narrow its catalogue after authentication to the models
available to that account. Floe does not maintain a second provider-specific
model list.

A model is usable only when the current profile revision, provider entitlement,
SecretRef resolution, and policy allow it. Missing credentials remain a visible
unresolved binding.

## Reasoning effort

Reasoning effort is constrained by the selected model's declared support. The
current Pi adapter may expose values such as `off`, `minimal`, `low`, `medium`,
`high`, and `xhigh`; other runtime adapters project their supported contract
without changing Floe's Actor or execution semantics.

## Binding and history

An Actor runtime binding is separately replaceable from the ActorDefinition.
Workspace or host defaults may participate in runtime resolution, but every
ExecutionAttempt records the exact ActorDefinitionRevision,
RuntimeProfileRevision, and binding it actually used.

## An Actor's own model

A binding may carry its own `model`, overriding the profile revision's model,
so each Actor can run its own model on one shared RuntimeProfile. Set it with
`actor.runtime-binding.create`, `actor.runtime-binding.replace` or
`actor.setup`. On replace, omitting `model` keeps the current one and `null`
returns the Actor to the profile's model. Choose from the engine's own list:
`models(engine)` on the engines channel (see the
[engine control protocol](../../reference/engine-control-protocol.md)).
A model the engine does not offer is refused before any model call, naming
the requested and the available models.

Every change creates a new binding and retains the one it replaced, so history
shows which model each turn ran.

## When a model change takes effect

**From the Actor's next stop, never mid-stop.** A stop (a NodeExecution in a
Scope run) pins the Actor's current binding when it begins, and every retry of
that stop reuses the same pins. A direct message pins the binding current when
it is delivered. So changing an Actor's model mid-journey leaves the stop in
progress, and any retry of it, on the old model; the Actor's next stop or
message runs the new one.

This is deliberate: a stop's result must be explainable by exactly one
configuration. Publishing a new RuntimeProfile revision does not move an
Actor either, because a binding names an exact revision; rebinding does.

A NodePlacement may add revision-specific runtime policy for one Scope design.
Publishing the ScopeCompositionRevision freezes that semantic configuration.
Changing a current Actor or Workspace default cannot rewrite an existing
execution's recorded configuration.

## Operations

RuntimeProfile creation, draft replacement, publication, rollback, retirement,
reactivation, and Actor runtime-binding changes use Bus-owned semantic
operations. Authorised clients and Actors consume the same definitions. Legacy
`/v1/runtime/bindings` routes are compatibility/internal adapters.

See [[Glossary]] for term definitions.

## Implementation

- `floe-bus/src/runtime-profiles.ts` — profiles, immutable revisions, and Actor
  bindings
- `floe-bus/src/runtime-profile-operations.ts` — canonical lifecycle and
  binding operations
- `floe-bridge/src/bus-client.ts` — effective runtime resolution for execution
- `floe-bus/src/credential-broker.ts` — SecretRef resolution boundary
