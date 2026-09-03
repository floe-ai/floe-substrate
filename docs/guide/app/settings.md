# Settings in floe-app

**Normal Floe Settings combines the two choices a user needs: which providers this device can use, and which model the current workspace should use.**

## The user-facing distinction

The interface avoids asking a user to understand "substrate settings":

- **Model providers** are connections available to Floe on this device and can be reused by every workspace.
- **Workspace model** selects which connected provider and model Floe normally uses in the current workspace.

They appear together because users commonly need to connect an account and then
choose it. Their storage and scope remain separate: provider secret values stay
behind the operating-system credential broker and canonical records hold
SecretRefs, while the Workspace choice is an Actor/runtime-profile binding.

## Workspace model

The Floe conversation shows the workspace's provider → model → effort choice
directly above the composer. Floe does not accept an outcome or message until a
connected provider and model have been saved for that Workspace. Changing the
inline choice invokes the same Bus-owned runtime-profile/binding operation used
by every authorised client.

The gear next to the workspace switcher opens the fuller Settings surface. It contains subscription connections managed through Floe's packaged Pi authentication helper and the same workspace model choice. Both surfaces use provider names and model names rather than asking a normal user to create profile identifiers or paste tokens.

## The actor Configure tab

Opening an actor and switching to its **Configure** tab shows its [[Binding]]: auth profile, model (constrained to that profile's provider), and thinking level (`off` / `minimal` / `low` / `medium` / `high` / `xhigh`). It also shows the effective resolved binding with its layer — actor, workspace, or global — so you can see what is actually in effect versus what is set at this level.

This correctly lives on the actor, not in a separate settings drawer: a [[Binding]] is what the actor is doing *as this actor*, and inheritance (actor → workspace → global) only makes sense read from where it resolves. A drawer elsewhere would just be a second, worse place to see the same thing.

## Substrate Settings

Reached by expanding **Developer tools** in the left nav and selecting **Substrate Settings** — switches the whole app into machine-level mode. It has six tabs:

| Tab | Status |
|---|---|
| Authentication | Developer/advanced. Inspect profiles and manage API-key profiles; browser is read-only (see [[floe-app]]). Normal ChatGPT setup is in Floe Settings. |
| Runtime | Developer/advanced. Inspect or force test versus live provider runtimes. |
| Model Registry | Stub. |
| MCP Manager | Stub. |
| Workspace Catalog | Stub. |
| Diagnostics | Stub. |

Stub tabs render a "Pillar Coming Soon" placeholder — no functionality behind them yet.

See [[Glossary]].

## Implementation

- `floe-app/src/workspace/WorkspaceSettings.tsx` — workspace-level default binding
- `floe-app/src/workspace/FloeModelControl.tsx` — compact provider/model/effort control at the conversation boundary
- `floe-app/src/providers/ProviderAccess.tsx` — device-level subscription connection
- `floe-app/src/actors/ActorInspector.tsx` — actor Configure tab, binding form, resolved-binding display
- `floe-app/src/features/substrate/SubstrateSettingsView.tsx` — Substrate Settings shell and the six tabs (Authentication/Runtime real; Models/MCP/Workspaces/Diagnostics are stubs)
- `floe-bus/src/runtime-profile-operations.ts` — canonical RuntimeProfile and
  Actor binding definitions
- `floe-app/src-tauri/src/bus_broker.rs` — native authority and provider
  credential boundary
- legacy `/v1/auth/profiles` and `/v1/runtime/bindings` routes — developer or
  compatibility adapters, not the product write contract
