# Endpoint

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

An addressable delivery interface used by an Actor runtime, a Command worker, a
Connector, a service or another runtime. Endpoint is not a type of identity and
no backing is privileged.

A Command never masquerades as its own Endpoint: its identity and definition are
separate from the host-local worker Endpoint that runs it. A retired Endpoint
keeps historical references but receives no new Delivery.

## Open

- A Connector as an Endpoint predates [primitives](../../pillars/primitives.md),
  where a Connector is a Workspace setting, not something that receives
  Deliveries.
