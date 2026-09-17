# Binding

**A binding is a replaceable association between a stable resource and configuration it uses.**

A binding does not become the resource's identity and does not rewrite retained
execution history.

## Runtime binding

An [[Actor]] has stable identity and immutable ActorDefinitionRevisions. Its
runtime embodiment is a separately replaceable binding to a RuntimeProfile.
That profile may select provider, model, reasoning effort, tool policy, and
other runtime configuration.

Each ExecutionAttempt records the exact ActorDefinitionRevision,
RuntimeProfileRevision, and binding it used. Changing a current binding affects
new attempts according to policy; it cannot make an old attempt appear to have
used the new configuration.

## Placement binding

A NodePlacement may add revision-specific instructions, capabilities, or
configuration for how a resource participates in that
ScopeCompositionRevision. These are part of the immutable published design, not
changes to the Actor or Command itself.

## Credentials

A runtime binding refers to SecretRef metadata where credentials are needed.
Reusable credential values stay behind the native or deployment credential
broker and never enter the binding, Context, Event, operation input, export, or
surface.

## Operations

RuntimeProfile and Actor runtime-binding lifecycle use Bus-owned semantic
operations. The legacy `/v1/runtime/bindings` routes are compatibility/internal
adapters and cannot remain an alternate product write path.

## Implementation

- `floe-bus/src/runtime-profiles.ts` — RuntimeProfile revisions and Actor
  bindings
- `floe-bus/src/runtime-profile-operations.ts` — shared lifecycle operations
- `floe-bus/src/credential-broker.ts` — SecretRef resolution boundary
- `floe-bus/src/scope-compositions.ts` — placement-specific bindings

See [[Glossary]].
