# Endpoint

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

An addressable delivery interface used by an Actor runtime, a Command worker, a
service or another runtime. Endpoint is not a type of identity and
no backing is privileged.

A Command never masquerades as its own Endpoint: its identity and definition are
separate from the host-local worker Endpoint that runs it. A retired Endpoint
keeps historical references but receives no new Delivery.

A [Connector](../../workspace/connector.md) is a Workspace setting, not an
Endpoint; it receives no Deliveries.
