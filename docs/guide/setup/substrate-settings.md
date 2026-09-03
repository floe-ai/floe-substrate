# Substrate settings

**Substrate Settings is the secondary developer observatory for machine-level Floe state. Normal provider and workspace model choices live together in Floe Settings.**

A Workspace may carry committed configuration in its `.floe/` directory (see
[[Workspace config]]). Host settings and SecretRef broker bindings apply to the
local installation. Reusable credentials stay in the operating-system
credential protector rather than `~/.floe/`, the Workspace, or the webview.
Committing a host path or secret would leak local authority and confuse a
Workspace locator with Workspace identity.

The developer view covers:

- provider metadata, SecretRefs, and unresolved bindings ([[Providers and auth]])
- daemon runtime (which adapter the bridge, see [[Services]], uses to run actors)
- the model registry ([[Models and thinking level]])
- MCP server configuration
- the catalogue of workspaces this machine knows about
- diagnostics

This is a short, deliberate list — not a dumping ground. Anything that describes what a *workspace* is (its agents, extensions, per-project settings) belongs in `.floe/`, not here.

## What's real today

The Substrate Settings view in floe-app has six tabs. Only two are implemented:

| Tab | Status |
|---|---|
| Authentication | Real, developer/advanced — inspect profiles and manage API-key profiles; browser reads only (see [[Providers and auth]]) |
| Runtime | Real, developer/advanced — inspect or force test versus live provider runtimes |
| Model Registry | Stub — disabled, "coming soon" |
| MCP Manager | Stub — disabled, "coming soon" |
| Workspace Catalog | Stub — disabled, "coming soon" |
| Diagnostics | Stub — disabled, "coming soon" |

Normal ChatGPT connection is intentionally absent from this view. It belongs in first-use onboarding and the Settings gear beside the workspace name. Clicking a stub tab does nothing. The model registry, MCP servers, and workspace catalogue are real substrate concepts, but there is no settings UI for them yet.

## Implementation

- `floe-app/src/features/substrate/SubstrateSettingsView.tsx` — tab list (`auth`, `runtime` real; `models`, `mcp`, `workspaces`, `diagnostics` marked `isStub`), `AuthenticationPillar`, `RuntimeAdapterPillar`
- `floe-cli/src/config.ts` — `~/.floe/config.yaml` schema (`bus`, `bridge`, `app`, `library`, `runtime` sections)
- `floe-bus/src/credential-broker.ts` — canonical SecretRef and broker
  contract
- `floe-cli/src/auth.ts` — legacy `~/.floe/auth/` migration/CLI boundary

See [[Glossary]] for term definitions.
