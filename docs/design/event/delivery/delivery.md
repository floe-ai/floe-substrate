# Delivery

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

Floe's durable obligation to transfer an [Event](../event.md) and exact
ArtefactVersion references to an [Endpoint](endpoint.md) or input Port. Delivery
owns queue, lease, acknowledgement, transport attempt, expiry and cancellation
state. It is transport, not logical execution, and never replaces a
NodeExecution.

A graph-routed Delivery pins ScopeExecution, composition revision, source and
target node and Port, Edge, causal Event, NodeExecution and publication. Root
ingress and continuation callbacks may have no Edge but still pin their revision
and NodeExecution. Direct conversations and direct Actor requests may have no
ScopeExecution.

Once a Delivery enters a runtime it may already have caused effects. Losing
runtime ownership becomes a terminal unknown-outcome failure and is never
silently replayed.
