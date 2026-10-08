# Connector

_Resolution: settled_
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
