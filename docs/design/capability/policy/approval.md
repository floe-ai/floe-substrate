# Approval

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

Approval exists only where a [Policy](policy.md) asks for it; it is never a
default.

An **ApprovalRequest** binds an exact action, inputs, evidence, Scope revision,
Policy decision, eligible decision set and expiry. Named, all-named, quorum and
role-based decisions are kept individually. Only a final approved decision
creates an **ApprovalReceipt**; a changed action or authority invalidates it
before use.

A pending request may name one existing participant in its Context to receive
the decision. This changes neither the action nor its Policy. Partial votes and
replayed decisions create no extra response. A removed or unavailable recipient
does not block the decision and receives nothing. Scope decision bindings keep
using their own Ports and Edges.

Resuming after approval keeps the call's original origin. Authority,
interaction mode, target, roles, Policy, inputs and the exact approval are
rechecked before running. A decision may carry the safe retry identity of the
waiting operation, never its inputs or secrets.

## Open

- Floe pushes all its approval requests to every surface (shipped in 0.4.13
  without operator approval). The operator is unsure: it feels developer-only
  and could affect users.

## What would settle it

The operator's call on who should see approval requests once a real
"ask me first" Policy is in use.
