# floe-app

**floe-app is the visual surface on top of the [[What floe is|substrate]] — a window onto the [[Services|Bus]], never a second brain.**

## The governing rule

floe-app does not invent substrate behaviour. It discovers and invokes the same
Bus-owned semantic operations as Actors, then renders authenticated read-only
projections. The Tauri native shell owns host authority, obtains short-lived
Workspace sessions, and brokers Bus requests, media, provider authentication,
filesystem access, and resumable push frames. The webview never receives bearer
or provider credentials.

This matters because the app is optional. A [[Workspace]] runs fine with no UI open at all — [[Actor]]s deliver over the bridge↔bus WebSocket regardless of whether anyone is looking. The app is a way of looking, not a way of working that only it can do.

## What the UI actually adds

The substrate does not get easier to use just because it has a UI. What changes is the cost of looking:

- **Seeing what exists without composing a query.** [[Scope]]s, [[Context]]s and [[Actor]]s render as lists and cards instead of `GET` responses you have to shape yourself.
- **Watching work happen live.** The substrate is push-only — no polling anywhere. floe-app rides the same event stream the [[Services|Bridge]] does, so a [[Context]] you have open updates the moment a [[Delivery and Turn|Delivery]] lands, with no refresh.
- **Reading a conversation as a conversation.** A [[Context]]'s events render as a message list with actor names, not raw JSON envelopes.
- **Using the same operations without hand-writing requests.** Actor definition,
  runtime binding, Context lifecycle, and Scope actions use the same discovered
  schemas, authority, refusals, and receipts as any other client.

None of this is a new substrate primitive. It is the same bus and the same local configuration contracts, presented through a friendlier surface.

## First use

The desktop app opens its shell immediately while it waits for local Floe services. A clean installation is guided through three product steps:

1. connect a model provider;
2. choose or create a workspace;
3. enter Conversations with Floe selected.

The provider step offers the subscription providers supported by the packaged Pi runtime. The browser sign-in, device-code feedback, provider profile, model choice, and workspace binding are completed inside floe-app; no terminal command is part of first use.

Normal Conversations repeats the workspace's provider, model, and reasoning-effort choice at the point of use. Its composer is disabled until a provider and model are saved, preventing an unserviceable message from being accepted and deferred.

## One substrate, one product surface

There is one Bus and one app presentation. The packaged Tauri desktop shell is
the normal trusted client: it can use the operating-system credential vault and
native broker. The React webview remains presentation code. A standalone
browser needs a separately established trusted session adapter; loopback access
alone grants nothing.

## What only the desktop can do

The trusted desktop shell owns:

- **Authority and provider setup.** Host authority and reusable provider
  credentials remain in protected native storage. The webview receives typed
  status and results.
- **Authenticated Bus transport.** Workspace requests, media fetches, and the
  cursor-resumable WebSocket stream are brokered natively.
- **Native filesystem access.** Local content operations require the exact
  current Workspace locator binding as well as Workspace authority.

Scope, Context, Actor, conversation, and settings semantics remain identical
across clients because they come from the Bus operation registry. Authentication
adapters and presentation may differ.

See [[Glossary]].

## Implementation

- `floe-app/src/App.tsx` — the shell and Workspace bootstrap
- `floe-app/src-tauri/src/bus_broker.rs` — host credential, Workspace sessions,
  authenticated HTTP/media, and push relay
- `floe-app/src/bus-client/transport.ts` — typed webview-facing broker adapter
- `floe-app/src/features/onboarding/OnboardingFlow.tsx` — provider → workspace → chat first-use flow
- `floe-app/src/providers/ProviderAccess.tsx` — normal subscription-provider surface
- `floe-app/src/features/conversations/OperatorConversations.tsx` — unified operator conversation entry and lifecycle
- `floe-app/src/workspace/FloeModelControl.tsx` — conversation-level provider/model/effort selection and readiness gate
- `floe-app/src/features/substrate/SubstrateSettingsView.tsx` — secondary developer observatory and advanced API-key profiles
- `floe-app/src/fs/workspaceFs.ts` — native Workspace content adapter
- `floe-cli/src/desktop.ts` — `floe desktop` command, cargo preflight
- Bus WebSocket: `GET /v1/events/stream` (also used by the bridge)
