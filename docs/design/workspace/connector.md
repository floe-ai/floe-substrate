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

## Where the name came from

The end-state handoff the operator endorsed on 3 Sep defined a Connector as an
outside-system integration that is "not graph topology". It also allowed
"external-action" nodes; code merged those into a `connector` node kind. Such a
node is a Command that uses a Connector. "Connector" is not a node's inputs and
outputs: those are [Ports](../scope/port.md) and [Edges](../scope/edge.md).

## Open

- Code models a Connector as a definition plus a binding
  (`floe-bus/src/connectors.ts`). Connector actions and their outside-effect
  receipts are removed; outside effects become Commands that use a Connector.
  Floe does not track whether an outside effect happened: retries and unclear
  outcomes are up to whoever builds the Command (operator ruling, 9 Oct).
- Connector listening (`connector-worker.ts`, `connector-source-adapters.ts`)
  runs only in tests; the live Bus does not start it.
- Code still has a `connector` node kind that can be placed in a Scope but
  never runs. It becomes a Command node that uses a Connector.
