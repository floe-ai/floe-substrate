# Connector

_Resolution: settled_
_Built: partly_
_Authority: operator-confirmed (8 Oct ruling)_
_Authored by: operator_

A Workspace setting: the connection to one outside system, such as a Slack
account. It holds what is needed to reach that system (sign-in through
[SecretRefs](../capability/secret.md), health) and is set up once.

A Connector is not a primitive and does nothing by itself. [Event
sources](../event/source/source.md) and [Commands](../command/command.md) that
support it use it: a Slack Event source listens through the Slack Connector; a
"post to Slack" Command posts through it.

## Open

- Code still models a Connector as a definition plus binding with its own
  actions and approvals (`floe-bus/src/connectors.ts`,
  `connector-action-authority.ts`). Under this design those actions become
  Commands that use a Connector.
