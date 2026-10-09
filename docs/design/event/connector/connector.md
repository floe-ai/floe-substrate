# Connector

_Resolution: question_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

How the outside world enters and is acted on. A **ConnectorDefinition** describes
a typed external Event source or action. A **ConnectorBinding** configures it
for one Workspace using SecretRefs, schemas, idempotency, health and policy.

Webhook, folder, schedule ([Pulse](pulse.md)), API and legitimate polling of an
external source all use this contract. Polling an outside system that cannot
push is ingress, not a Floe loop. Actions outside Floe are recorded as
[external effects](external-effect.md).

## Open

- Clashes with [primitives](../../pillars/primitives.md) (operator ruling,
  8 Oct): a Connector is a Workspace setting, the connection to an outside
  system. Webhook, folder and schedule are Event sources
  ([ADR-0008](../../../adr/0008-event-is-the-primitive.md)), and acting outside
  Floe is a Command. This document, Connector actions in code, and the
  `event/connector/` folder all need restructuring with the operator.
