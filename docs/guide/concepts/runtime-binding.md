# Runtime binding

**A runtime binding is the replaceable link between an [[Actor]] and a RuntimeProfile.**

The RuntimeProfile selects provider, model, reasoning effort and other runtime
configuration. The binding may carry the Actor's own model over its profile's.
Tool access is not part of it; see [[Actor#Engine built-in tools]].

The binding never becomes the Actor's identity. Each stop and each direct
message pins the binding current when it begins, so a change applies from the
Actor's next stop, never in the middle of one. Each ExecutionAttempt records the
exact ActorDefinitionRevision, RuntimeProfileRevision and binding it used, so
changing a binding never makes an old attempt appear to have used the new
configuration.

## Not the same as placement instructions

A NodePlacement may add instructions or configuration for how an Actor or
Command takes part in one ScopeCompositionRevision. Those belong to the
published composition, not to the runtime binding, and do not change the Actor.
See [[Node]].

## Credentials

A runtime binding refers to SecretRef metadata where credentials are needed.
Credential values stay behind the credential broker and never enter the
binding, a Context, an Event, operation input, an export or a surface.

## Operations

RuntimeProfile and runtime binding changes use Bus-owned semantic operations
(`actor.runtime-binding.create`, `actor.runtime-binding.get`,
`actor.runtime-binding.inspect`, `actor.runtime-binding.replace`). Discover
their current contracts before use.

See [[Glossary]].
