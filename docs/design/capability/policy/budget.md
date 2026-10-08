# Budget

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

A Budget reservation atomically holds estimated use against every applicable
[Policy](policy.md) limit before work starts. Completion records measured use; a
failed action releases its reservation; uncertain external effects stay
reserved until the outcome is proven.

Workspace, Scope, Actor, Connector, Extension and exact placement limits are
independent and all apply when relevant.
