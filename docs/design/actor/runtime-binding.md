# Runtime binding

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

The replaceable link between an [Actor](actor.md) and a RuntimeProfile: provider,
model, reasoning effort, tool policy and other runtime configuration. The binding
may carry the Actor's own model over its profile's.

Each stop and each direct message pins the binding current when it begins, so a
change applies from the Actor's next stop, never mid-stop. Each
ExecutionAttempt records the exact definition, profile revision and binding it
used; changing a binding never rewrites history.
