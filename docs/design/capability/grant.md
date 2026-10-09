# Grant

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

Canonical name: **CapabilityGrant.** A durable, revocable, expiring grant from an
issuer to one principal for exact operation IDs within one authority boundary: a
Workspace or a host. It may also be limited to exact resources.

Authority sessions reference grant IDs and resolve their current state on every
call; they never copy operation strings as authority. Grants own operation
authority; [SecretRef](secret.md) constraints narrow credential purpose without
another grant lifecycle.
