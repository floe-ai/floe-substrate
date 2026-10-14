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
there, within the credential's own purpose limits; by default there is no
per-Actor grant
([Workspace access](access.md), 13 Oct). Export carries only unresolved
SecretRef metadata. Missing credentials stay unresolved.

Model credentials are not Floe secrets; they belong to the vendor
([Engine](../host/engine.md#use-the-machines-existing-sign-in)).

Origin: agent ADR-0012 (4 Sep).

Still in code: the old `auth.json` import, removed with the rest of the
migration code ([pillars](../pillars/pillars.md#no-migration-code)).
_Priority: P1_ _Release: 1.0_
