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
provider. The Floe conversation and Settings both expose the current
Workspace's provider, model, and reasoning-effort choice. The composer remains
unavailable until a usable runtime binding resolves.

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

A standalone browser needs its own trusted authenticated session adapter. It
cannot read the operating-system vault or turn loopback access into authority.
The CLI may support a terminal provider flow, but it uses the same SecretRef,
grant, and broker rules rather than printing credentials.

```text
floe login --provider <provider>
floe auth list
floe auth doctor
floe logout
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
