# Navigating floe-app

**The app opens the Conversations workspace index. Developer inspection remains available without being the default product path.**

## The shell

The left nav ([[Workspace]]-scoped) has one normal operator entry and one secondary disclosure:

- **Conversations** — the default operator view, containing conversations in which the workspace operator participates.
- **Developer tools** — a collapsed disclosure containing the existing workspace overview, Activity, Scopes, Actors, creation controls, and Substrate Settings.

Selecting a developer tool drives the main column. Opening a [[Node]], [[Actor]] or [[Context]] can also open detail in the right-hand inspector aside. The inspector is not shown in normal Conversations.

## First use

When no supported provider is configured, the desktop app first asks the user to choose and connect a subscription through the packaged Pi authentication flow. When no workspace exists, it then asks for a folder. Floe applies the selected model as that workspace's default and lands in Conversations with Floe. An existing workspace is reused; connecting a provider does not force the user to create another one.

After onboarding, the gear beside the workspace name opens normal **Settings**. Provider connections apply to this device; the workspace model applies only to the selected workspace. Substrate Settings remains under Developer tools for diagnostics and advanced configuration.

## Actions

**Actions** beside the Workspace name opens the live catalogue of semantic
actions available to your connection. Search or select a category, choose an
action, and fill its described fields. Read actions return their result;
changes show your choices for review before submission. Floe applies the same
permissions, validation and audit used by other Actors. A required trusted
confirmation still uses the installed app's confirmation path.

**Actions for this work** opens actions for the selected organised run. Returned
canonical references can open further actions without copying their identifiers.
An action that needs a record or a current version explains that requirement.
The catalogue does not itself supply every resource picker or specialised
interaction; complete app capability coverage remains in progress.

Approval results show the requested effect, status, reason, decision progress
and exact saved evidence. A conversation saying that work is ready for approval
does not create an approval request. Decisions remain governed by the request's
current policy and the acting principal's permissions.

If a response is lost, Actions retains the submitted intent for the browser
session, including closing the panel and reloading. Retrieve the result using
the same request before starting another action. An accepted asynchronous action
is shown as pending; **Check action result** retrieves its recorded outcome.
This session recovery does not establish recovery after closing the browser or
restarting the native application.

## Conversations

Conversations is the operator's normal way into work with Floe or another actor. When conversations already exist, opening or selecting a workspace leaves the operator at the shared index instead of silently choosing one. When there are none, the app opens a new outcome with Floe. Deliberately clicking Conversations returns to the index.

If no Floe conversation exists, the app asks what outcome the operator wants. Submitting the first outcome creates a direct [[Context]], emits the message to Floe, and opens the conversation. Merely opening the workspace does not create a Context.

The list contains only Contexts where the ordinary workspace operator is already a participant; actor-to-actor operational traffic is not promoted into this view. Floe is the default collaborator and new-outcome target, not a separate navigation hierarchy.

Active Scopes appear under **Organised work** on the same index. Opening one
shows the currently published ScopeCompositionRevision. Focusing a
NodePlacement reveals its immediate upstream and downstream Edges, then the
NodeExecutions that reached it. Each NodeExecution may open its exact Context
and exact ArtefactVersion inputs or outputs. The app reads topology from stored
Ports and Edges and execution from canonical execution records; it does not
infer either from Context subscriptions or observed Event traffic.

When canonical Artefacts exist, **Artefacts** remains on the Workspace index
even after the originating Scope stops. **Visual trail** and **Relationship
graph** are projections of exact ArtefactVersion lineage, collection membership,
and execution provenance. Raster images appear directly; selected JSON and
Markdown content can show a readable preview. Related Context history remains
accessible from exact associations. Extensions may add domain metadata,
invalidation policy, and rich presentation, but their files are not a parallel
Artefact identity ledger. Retired Scopes remain available under Developer tools
for history and diagnostics and do not appear as active organisation.

An incoming message addressed to the operator with a response expected appears under **Needs you**. Once the operator replies, the conversation returns to **Recent**. This is an interpretation of existing Event response metadata, not separate task or notification state.

Opening an item keeps the speaking identity fixed to the operator and names the
other participant in the conversation header. Context lifecycle actions use the
same Bus-owned semantic definitions as Actors: archive is reversible, restore
returns an archived Context, and permanent destruction is separately named,
confirmed, and refused when retained evidence depends on it. New conversation
starts a fresh Context with the current collaborator; from the list, **New with
Floe** starts a fresh outcome with Floe. **Report a problem** prepares an
explicitly approved local Markdown and JSON export from bounded Bus diagnostics;
a Floe-authored draft can open the same review flow. Saved reports appear on the
workspace index with an explicit **Not shared** status and a developer-handoff
action. A compact provider → model → effort control sits at the conversation
boundary, and the composer remains disabled until the workspace has a connected
provider and saved model.

Conversation history opens on a bounded newest page. Scrolling upward retrieves earlier pages through the Bus cursor contract without hiding or discarding durable messages. The conversation index reads only each Context's newest message, and supplementary runtime/delivery status may fail independently without hiding conversation history.

The operator view omits participant controls, substrate inventory, and the inspector. The general participant and identity controls remain available when the same Context is opened through Developer tools.

## Workspace overview

The Developer tools workspace overview preserves the previous scope-card grid — one per [[Scope]], each showing its title, description, and a live count of contexts and pulses. Clicking a card opens that scope's detail view. A "New scope" tile sits at the end of the grid.

## Opening a scope

Clicking a scope card opens **scope detail** in the main column, with a **Contexts** tab and an **Ops** tab:

- **Contexts** lists the [[Context]]s that belong to this scope, by human label.
- **Ops** is a read-only view of recent [[Event]]s scoped to this scope, plus the [[Event|Pulse]]s that can fire into it (create, pause, resume, cancel, subscribe/unsubscribe).

Any extension that registers a `scope-detail-tab` view appears as an additional tab alongside Contexts and Ops. If the extension's actual component was not built into this app bundle, the tab renders a placeholder rather than nothing.

## Opening an actor

Clicking an actor in the nav opens the **actor view** with two tabs:

- **Conversations** — a list of [[Context]]s that actor is a participant in, and a right-hand pane that opens the selected one as a full conversation.
- **Configure** — the actor's [[Binding]] form (see [[Settings in floe-app]]).

## Opening a context

Clicking a Context from a Scope, Actor, or Activity opens its message history and
participant list as a read-only developer inspection. The normal Conversations
surface is where the authenticated operator can reply. See
[[Conversations in floe-app]].

## Other direct contexts

Conversations provides the normal route to scoped or unscoped Contexts in which the operator participates. Contexts that do not include the operator remain available through Activity or an actor's context list under Developer tools.

See [[Glossary]].

## Implementation

- `floe-app/src/App.tsx` — routing/state, main column switch
- `floe-app/src/app/layout/LeftNav.tsx` — the left nav
- `floe-app/src/hooks/useNavigation.ts` — navigation state machine
- `floe-app/src/features/conversations/OperatorConversations.tsx` — unified operator entry, conversation lifecycle, list, and attention projection
- `floe-app/src/features/work/ScopeWorkView.tsx` — loads the published Scope
  plan and canonical execution evidence
- `floe-app/src/features/work/ScopePipelineFocusView.tsx` — progressive
  NodePlacement/Edge path with exact Context and ArtefactVersion evidence
- `floe-app/src/features/work/ArtifactLineageView.tsx` — legacy extension
  lineage projection pending canonical Artefact projection cutover
- `floe-app/src/workspace/FloeModelControl.tsx` — inline workspace model selection and readiness gate
- `floe-app/src/features/home/HomeView.tsx` — scope grid
- `floe-app/src/scope/ScopeDetail.tsx` — Contexts/Ops/extension tabs
- `floe-app/src/features/actor/ActorView.tsx` — Conversations/Configure tabs
- `floe-app/src/scope/DirectContexts.tsx` — general developer-oriented direct-context list, not wired into a route
