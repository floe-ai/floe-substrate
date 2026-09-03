# Conversations in floe-app

**A [[Context]] opens as a conversation: a message list, who is currently working, and who you are speaking as.**

## Opening a conversation

The normal **Conversations** entry lists Contexts in which the Workspace
operator participates. Workspace entry selects the latest Floe conversation
inside this same surface; Floe is not a separate route. Opening any item names
the other participant and fixes the speaking identity to the operator. Context
lifecycle actions come from the shared semantic operation contract: archive is
reversible, restore returns an archived Context, and permanent destruction is a
separately confirmed action that may refuse while retained evidence depends on
the Context. Developer tools can inspect the same Context details; they do not
own another lifecycle.

## The message list

The body is a scrollable, chronological stream. Only events of `type === "message"` render as chat bubbles — lifecycle bookkeeping (like a context being created) is hidden from the stream by default. Each bubble shows the author's resolved name and a timestamp; the author is looked up from the [[Endpoint]] id on the event, never shown as a raw id if a name is available. The list auto-scrolls to the bottom as new messages arrive, but stops sticking if you scroll up to read history.

## Speaking as

The substrate has no human/agent identity type. The authenticated principal
establishes authority, and the selected Actor establishes the speaking identity
where the product allows that choice. An [[Endpoint]] is only the addressable
delivery interface used for the Event; it is not the Actor's identity or a
credential.

Normal operator conversations fix the speaking endpoint to the workspace operator and show the workspace provider, model, and reasoning effort above the composer. The composer remains disabled until a connected provider and model are saved, so an operator cannot create a message that a model-backed collaborator is not configured to handle. Developer-opened conversations keep the general "Speaking as" behaviour.

## Joining a context

The "Speaking as" selector stays visible even if the actor you have selected is not a [[Context|Participant]] of this context yet. A "Join context" button lets you add that actor as a participant before you send. Participation is membership, not a subscription to being woken — joining does not by itself make the actor respond to anything; it only makes it able to emit and be seen as present.

## Seeing who is working

A "`<actor> is working…`" indicator appears while an actor has a live [[Delivery and Turn|Delivery]] or turn in progress in this context. It is driven by the same bridge↔bus WebSocket the substrate uses for everything else — there is no polling.

The bottom of the main navigation shows the health of Floe's local services and model runtime. Green means both are connected, amber means the app is reconnecting or waiting for the model runtime, and red means work cannot continue. Open the status for the failure detail and, for a stopped packaged runtime, a **Restart local services** action. If the runtime stops during a visible turn, the conversation replaces the stale working indicator with an explicit interruption notice; it does not imply that work is still progressing in the dark.

## Reporting a Floe problem

Every normal operator conversation has **Report a problem**. The report asks for expected behaviour, actual behaviour, impact, a tentative classification, and the safe boundary for reproducing the problem. Floe's latest reply is offered as an editable tentative interpretation; it is not treated as a system fact. When the operator asks Floe to report a problem in conversation, Floe can emit the same semantic draft and the message shows **Report ready — Review**. Floe still cannot collect authoritative diagnostics or save the report without operator review.

The app then requests one bounded diagnostic envelope from the Bus for that Context: public recent Events, related delivery state and safe operational runtime telemetry, sanitized participant identities, runtime liveness, and current capability identifiers. The Bus omits tool arguments, tool output, visible-output duplication, and scratch reasoning at the diagnostic API boundary. The app then redacts sensitive keys, credential patterns, user-home paths, URL credentials, and email addresses before showing the exact Markdown and versioned JSON export.

Nothing is sent automatically. After exact preview and explicit approval, the app writes `report.md` and `report.json` beneath `.floe/state/feedback/REPORT_ID/`, records the report in the workspace's **Floe reports** list, and marks it **Not shared**. **Copy handoff** produces a direct instruction containing the exact report path for a local developer agent. If replay could create durable unwanted state or material token use, the report directs verification through an isolated workspace first. An actual development connection remains optional and is not implied by saving locally.

## Creating a new context

In normal Conversations, **New conversation** starts another Context with the
currently selected collaborator; **New with Floe** starts one from the list. No
Context is created until the operator submits the first outcome. Contexts may be
archived and restored without losing retained evidence. Permanent destruction
is a separately confirmed operation and may be refused when canonical evidence
depends on the Context. Developer tools may inspect Context details, but they do
not own a second lifecycle.

See [[Glossary]].

## Implementation

- `floe-app/src/scope/ContextConversation.tsx` — conversation view, message stream, Speaking-as selector, Join context, working indicator
- `floe-app/src/features/conversations/OperatorConversations.tsx` — unified operator conversation lifecycle, discovery, and Needs you/Recent grouping
- `floe-app/src/app/layout/LeftNav.tsx` — compact operator health status and recovery action
- `context.participant.set_access` — canonical participant role/access change
- `GET /v1/events?context_id=…&type=message&direction=backward` — newest-first bounded message history with earlier-page cursors (`listContextEventHistoryPage`)
- `context.create` and `context.communication.emit` — canonical conversation
  creation and communication
- Bus WebSocket `GET /v1/events/stream` — live updates, `delivery_bundle_available` / turn-end signals drive the working indicator
