# Receipt

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

Canonical name: **Operation receipt.** The stable result of one idempotent
operation call. It records principal, authority, exact target and revision,
provenance, state, changed references, refusal or required action, progress and
cancel references, and the [audit](audit.md) reference. A client reconnects to
the receipt instead of guessing whether an operation committed.
