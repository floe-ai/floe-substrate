# Secret

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

Canonical name: **SecretRef.** A metadata-only reference to credential material
held by the operating system or a managed credential broker. Floe records
resolution and an opaque broker binding, never reusable secret bytes.

Using a secret needs a current [grant](grant.md) for the exact SecretRef and
resource, plus credential-specific purpose limits. Export carries only
unresolved SecretRef metadata. Missing credentials stay unresolved.

Model credentials are not Floe secrets; they belong to the vendor
([Engine](../host/engine.md)).

Decision: [ADR-0012](../../adr/0012-portable-workspace-authority-and-secret-brokering.md).

## Legacy

Old `auth.json` is migration input. Secret material moves only through an
explicit trusted broker action, is verified, and is kept until separately
approved cleanup.
