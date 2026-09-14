# Conversations in floe-app

**A [[Context]] opens as a conversation: a message list, who is currently working, and the authenticated operator's available actions.**

## Opening a conversation

The normal **Conversations** entry lists Contexts in which the Workspace
operator participates. Workspace entry selects the latest Floe conversation
inside this same surface; Floe is not a separate route. Opening any item names
the other participant. The Bus derives authorship from the authenticated
operator principal; the app cannot claim an Actor or Endpoint identity. Context
lifecycle actions come from the shared semantic operation contract: archive is
reversible, restore returns an archived Context, and permanent destruction is a
separately confirmed action that may refuse while retained evidence depends on
the Context. Developer tools can inspect the same Context details; they do not
own another lifecycle.

Conversation rows show **Working** while a related response is active,
**Stopped** when the latest response was cancelled, or **Needs attention** when
it failed or was deferred. The Bus derives these labels from the conversation's
Deliveries and explicit dependent requests. A labelled preview starts with
**Last message:** so earlier progress text cannot be mistaken for current status.
Related responses include a collaborator resuming to assess a dependency's
returned result, even when that work happens in another Context.
These labels describe response activity, not whether the operator's outcome is
complete. Live delivery changes update the list without polling.

## The message list

The body is a scrollable, chronological stream. Only events of `type === "message"` render as chat bubbles — lifecycle bookkeeping (like a context being created) is hidden from the stream by default. Each bubble shows the author's resolved name and a timestamp; the author is looked up from the [[Endpoint]] id on the event, never shown as a raw id if a name is available. The list auto-scrolls to the bottom as new messages arrive, but stops sticking if you scroll up to read history.

## Authenticated authorship

The substrate has no human/agent identity type. The authenticated principal
establishes authority and authorship. An [[Endpoint]] is only the addressable
delivery interface used for an Event; selecting one does not grant permission
to speak as its Actor.

Normal operator conversations show the workspace provider, model, and reasoning
effort above the composer. The composer remains disabled until a connected
provider and model are saved, so an operator cannot create a message that a
model-backed collaborator is not configured to handle. Developer-opened
Context views are read-only; they never offer Actor impersonation.

Files selected in the desktop composer are uploaded through a one-use transfer
bound to the authenticated operator and this Context. Sending the message turns
each file into an immutable [[Artefact and ArtefactVersion|ArtefactVersion]] and
records its exact Event and Context relationships. The message contains no host
file path. Supported images render inline from the exact ArtefactVersion bytes.

## Context participation

Participation is retained collaboration membership, not author identity and not
a subscription to being woken. Participant changes use the Bus-owned Context
operations; inspecting a Context in Developer tools does not silently add an
Actor or the operator.

## Opening saved results

A message with an exact ArtefactVersion attachment has an **Open** action.
It opens the existing content and history view inside the conversation, starting
with the version attached to that message. **Close** returns to the compact
attachment. The same action is available for any message author. A plain
workspace file path in message text is not an attachment.

The message's canonical version references determine its attachments. A version
without a display name still has **Open Saved result**. Newly published local
files are verified and retained before publication, so later source edits do
not change what an earlier attachment opens.

Floe can give each attachment a clear name, such as **Teal Lantern** or
**Revised Courtyard**. The name labels the same exact saved version; it does
not create another copy or change its contents.

Recorded approval decisions remain visible in the conversation with their exact
decision and reason. **Review decision** opens the saved request through Actions.
**Changes requested** is shown separately from rejection. Evidence reuses names
explicitly attached to that exact version in the loaded conversation; these names
do not change the action being approved. Ordinary messages claiming an approval
do not become recorded decisions.

For a pending approval, **Choose decision response** selects a responding
collaborator from that conversation, or **No automatic response**. The saved
decision then reaches the selected collaborator once the required decisions
resolve. This does not itself carry out the approved action. Floe can use the
result to continue the requested work under the same permissions and exact
approval.

References are fixed when the message is sent. Relating a later result to a
message does not attach that result to the earlier message. To share a saved
result, send a new message carrying its exact version reference.

Markdown attachments open as readable documents. **Version details** keeps the
exact reference, content identity and related records available for inspection.

Self-contained HTML attachments have **Run interactive result** and **Stop preview**
controls. Opening the attachment does not run its scripts. Run opens the exact saved
version in a larger isolated preview; **Stop preview** or Escape ends that preview.
Running again starts fresh. Preview activity is not saved back to the attachment.

The preview cannot access your Floe account or Workspace. It may still connect to
the internet through browser features such as WebRTC; it is not an offline execution
environment. Ordinary external scripts, images, network requests, forms and navigation
are blocked. Content needing separate files or external resources requires another
supported presentation; this preview supports self-contained HTML.

Self-contained GLB attachments have **Open 3D view**. Drag to rotate, scroll or
pinch to zoom, and use **Reset view** to return to the initial view. **Stop preview**
or Escape closes it. Viewing does not change the saved result. Models that require
outside files or unsupported decoders show an explanation instead of a partial view.

## Seeing who is working

A "`<actor> is working…`" indicator appears for active responses in this conversation
and work explicitly requested from it, even when a collaborator works in a separate
Context. It remains available after reopening the conversation. Lifecycle updates
arrive through the shared WebSocket; there is no polling.

**Stop response** stops the selected response through the shared operation contract.
Each active response has its own control. Stopping Floe's response does not silently
stop separately delegated responses. Already saved changes remain. Canonical Scope
executions use their execution Stop action.
When a collaborator resumes to assess a returned result, stopping that response
also closes its original outstanding request. The completed dependency's result
remains available.

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

- `floe-app/src/scope/ContextConversation.tsx` — operator conversation, read-only developer inspection, message stream, and working indicator
- `floe-app/src/features/conversations/OperatorConversations.tsx` — unified operator conversation lifecycle, discovery, and Needs you/Recent grouping
- `floe-app/src/app/layout/LeftNav.tsx` — compact operator health status and recovery action
- `context.participant.set_access` — canonical participant role/access change
- `GET /v1/events?context_id=…&direction=backward` — newest-first bounded public Context history with earlier-page cursors (`listContextEventHistoryPage`); the conversation shows messages and recorded approval decisions while keeping lifecycle Events out of the normal view
- `context.create` and `context.communication.emit` — canonical conversation
  creation and communication
- Bus WebSocket `GET /v1/events/stream` — live updates, `delivery_bundle_available` / turn-end signals drive the working indicator
## Opening referenced work

Floe can include named **Open** buttons for saved records such as an approval.
These open the existing actions for that exact reference in the current
Workspace. The message's name is an explanation from its author; current record
state and available actions are checked when inspected. A reference does not
grant access, record approval or execute an action.

Saved files continue to use named exact-version attachments. An exported result
should include its saved version as an attachment so it remains openable from
the handoff message.
