# Identity

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

Floe holds one identity for the person, under the Floe home, and every surface
uses it. Floe keeps the key; a surface never sees a private key, challenge or
signature. A surface asks Floe's identity agent to act, and the agent pushes
back state and short-lived bearers.

Clients authenticate as themselves and receive an unprivileged Workspace
credential; authority comes from grants, never from being a particular client.

## Connection credentials

Credentials have three audiences that are never interchangeable: host control,
the Bridge service, and Workspace operations. HTTP sends them only in the
`Authorization` header, never in URLs or logs. A WebSocket client authenticates
in its first frame and receives nothing before that succeeds.

Origin: agent ADR-0015 (14 Sep), ADR-0016 (28 Sep).
Contract: `docs/reference/identity-agent-protocol.md`,
`docs/reference/client-identity-protocol.md`.

## Sign-in screens

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed (8 Oct: "sign-in logic is handled by Floe and surfaces reuse the same code")_
_Authored by: operator_

Floe owns sign-in and identity logic. Each surface draws its own screens in its
own style (web, terminal, anything). A future optional component library may
offer ready-made screens as an Extension; Floe and its instructions stay unaware
of it.

## Open

- **Remote sign-in** (passkeys and similar). Parked by the operator, 8 Oct;
  follows the Local-first law in [pillars](../pillars/pillars.md).
