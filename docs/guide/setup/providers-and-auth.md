# Providers and auth

**A provider connection gives an authorised runtime access to model labour without exposing reusable credentials to the app webview, Actors, Contexts, Events, or the Bus API.**

Floe's packaged Pi runtime can use the subscription providers it supports,
including ChatGPT, Claude, and GitHub Copilot. API-key connections remain an
advanced option.

## Connecting a provider

On first use, the desktop app asks for a provider before asking for a Workspace.
Choose a provider and model, then complete that provider's supported browser or
device flow. The packaged native helper performs the exchange; the user does
not need to run `floe login`.

After onboarding, **Settings → Model providers** connects another supported
provider or disconnects a connected account after a native confirmation. The
Floe conversation and Settings both expose the current
Workspace's provider, model, and reasoning-effort choice. The composer remains
unavailable until a usable runtime binding resolves.

A newly saved runtime binding notifies the running Bridge to attach the Actor;
it does not require restarting Floe. Attachment does not grant access to an
account or to Workspace capabilities.

When Floe brings in a collaborator, it can delegate a permitted part of its
access. The collaborator receives its own permissions, with the same account
restrictions and no later expiry. Withdrawing the source permission also removes
that delegated access. Creating a collaborator or copying permission references
does not authorise account use.

## SecretRef and credential broker

Canonical records hold a SecretRef: stable metadata and an opaque broker binding,
never reusable secret bytes. The credential value remains in the operating
system or deployment credential protector and is resolved by a trusted broker
only for an authorised declared purpose.

Secret use requires both a current CapabilityGrant for the exact principal,
Workspace, resource, operation, and SecretRef, and a matching purpose
constraint. Rotation changes the protected value while retaining the SecretRef
and audit evidence.

The following never receive reusable provider credentials:

- the webview or browser local storage;
- URL query strings;
- Contexts, Events, Artefacts, operation inputs, or exports;
- Actor/model prompts; and
- normal logs.

## Desktop, browser, and CLI boundaries

The desktop native shell brokers provider connection, authenticated Bus
requests, media, and the push stream. It returns typed results to the webview,
not bearer or provider credentials.

The local browser establishes its authenticated session automatically when it
connects to the installed Floe. It can use that installation's connected
accounts under the same grants, without another provider login. Remote browser
access requires the supported pairing flow. Neither browser can read the
operating-system vault or turn loopback access into authority.

An account connection belongs to the Floe installation's retained state, not to
a browser tab. A separate Floe home has separate state; Pi does not make that
second instance share the first instance's account connection automatically.

The CLI supports the same provider connection flow through the packaged native
authority broker. It does not print or receive reusable credentials. Account
disconnection uses the same Bus-owned `credential.revoke` operation and
Bus-authored confirmation in the desktop app and CLI.

```text
floe login --provider <provider>
floe auth list
floe auth doctor
```

## Legacy files and migration

Older installations may contain `~/.floe/auth/auth.json`,
`~/.floe/auth/models.json`, and `~/.floe/auth/profiles.yaml`. They are
explicit migration input, not the canonical secret contract.

Migration must inventory and verify each connection, create SecretRef metadata,
move secret material through a trusted broker action, and preserve the original
until separately approved cleanup. Missing credentials become visible
unresolved bindings. Floe never silently copies, replaces, logs, or deletes
them.

## Developer tools

Developer tools may inspect provider metadata, unresolved bindings, runtime
health, and legacy migration state. They are an observatory, not the normal
provider setup path and not a second credential-write contract.

## Implementation

- `floe-app/src/providers/ProviderAccess.tsx` — normal provider connection
  surface
- `floe-app/src/features/onboarding/OnboardingFlow.tsx` — first-use provider
  step
- `floe-app/src-tauri/src/bus_broker.rs` — trusted Bus session and transport
  broker
- `floe-app/src-auth-sidecar/index.ts` — packaged Pi provider authentication
  helper
- `floe-bus/src/credential-broker.ts` — SecretRef and purpose-constrained
  resolution contract
- `floe-bus/src/runtime-profile-operations.ts` — canonical runtime profile and
  Actor binding operations

See [[Glossary]].
