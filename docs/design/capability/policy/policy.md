# Policy

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

A governance identity with immutable published revisions and revocable bindings
to a Workspace, Scope, Actor, ConnectorBinding, Extension installation, or one
placement in one Scope revision. A Policy can deny, require
[approval](approval.md) or limit resource use ([Budget](budget.md)). It never
creates authority a [grant](../grant.md) does not provide.

Every decision keeps the normalised facts and exact Policy revisions evaluated.
Actor roles come from retained assignments, never a role claimed in a request.

## Unrestricted by default

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed (29 Sep ruling)_
_Authored by: operator_

Floe is unrestricted by default. Restrictions are opt-in per Actor or Workspace;
"ask a person" is never a default. Every tool call is still
[audited](../audit.md).
