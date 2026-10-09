# External effect

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

Canonical name: **ExternalEffectReceipt.** The durable record of an attempted
action outside Floe: exact input, target, idempotency identity, provider receipt,
and a known, failed or uncertain outcome. An uncertain effect pauses for
reconciliation instead of blind retry; its Budget reservation stays held until
the outcome is proven.
