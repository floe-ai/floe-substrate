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

## Lifecycle

A Delivery moves durably through `queued → reserved → delivered_to_bridge →
injected_to_runtime → acknowledged`. Transport may retry before injection.
After injection, pushed runtime activity renews a single-shot ownership lease;
runtime failure or lost ownership is a terminal dead letter. Queued Events reach
a runtime as bundles at safe boundaries.

## Stopping

The operator stops one exact active response through the shared
`runtime.delivery.cancel` operation. Cancellation is terminal: it interrupts the
exact runtime or Command process, revokes that Delivery's operation authority
and ignores late acknowledgements. Partial text from a stopped or failed
response never becomes a successful completion; already committed results and
file changes remain.

Stopping one response does not stop the responses it requested; each has its
own Stop. Stopping a whole Scope run uses `scope.execution.stop`. Cancellation is
runtime state, never an Actor instruction.
