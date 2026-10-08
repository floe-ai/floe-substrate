# Pulse

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

Bus-owned scheduled Event creation. A Pulse is a scheduling mechanism, not a
heartbeat, liveness loop or separate routing system. In canonical execution a
Pulse is bound through a schedule [Connector](connector.md) and an explicit
ingress Port.

Decision: [ADR-0001](../../../adr/0001-pulse-scheduled-event-delivery.md).
