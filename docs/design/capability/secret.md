# Secret

_Resolution: settled_
_Built: partly_
_Authority: agent-provisional_
_Authored by: unknown_

Canonical name: **SecretRef.** A metadata-only reference to credential material
held by the operating system or a managed credential broker. Floe records
resolution and an opaque broker binding, never reusable secret bytes.

A SecretRef belongs to a Workspace, usually through a
[Connector](../workspace/connector.md). Any Actor in that Workspace may use it
there, within the credential's own purpose limits; there is no per-Actor grant
([Workspace access](access.md), 13 Oct). Export carries only unresolved
SecretRef metadata. Missing credentials stay unresolved.

Model credentials are not Floe secrets; they belong to the vendor
([Engine](../host/engine.md)).

Origin: agent ADR-0012 (4 Sep).

## Legacy

Old `auth.json` is migration input. Secret material moves only through an
explicit trusted broker action, is verified, and is kept until separately
approved cleanup.

## Open

- Migration code is being removed (Pre-release, [pillars](../pillars/pillars.md)),
  but the same law says to preserve credentials. Does the `auth.json` import
  stay, or does anything still depend on it?
