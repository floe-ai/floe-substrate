# Audit

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

An immutable request-and-outcome record for one operation. It keeps the
authenticated principal and grants, exact target, input and state digests,
Policy and Budget references, provenance, changed references, refusal and
affected ArtefactVersions, without copying secret values.

Every tool call is recorded, whether or not anything restricts it
([Policy](policy/policy.md)).
