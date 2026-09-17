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
model list in the app.

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
