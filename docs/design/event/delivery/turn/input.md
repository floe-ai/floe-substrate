# Turn input

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

What a model receives for one [Turn](turn.md), and where each part comes from.
Keep it accurate and compact; load changing knowledge only when the work needs
it.

## Layers

1. **Shared guidance.** Common Context, Event, execution and authority
   behaviour, appended for every Actor (`floe-bridge/src/prompts/substrate-guidance.md`).
   It never imposes the Floe Actor's preferred way of working on other Actors.
2. **The Actor's instructions.** Taken from the exact
   [definition](../../../actor/definition.md) pinned by the Bus-issued
   processing contract, including pinned placement instructions. Editable files
   are not the authority.
3. **The current cause.** A compact orientation to the origin Context and the
   current input, with exact Artefact references and named references.
4. **Tools.** Tool schemas from the runtime, plus discovered
   [Capability](../../../capability/capability.md) operations.

Not injected by default: Context history, the participant list, the Workspace
Actor directory, implementation documentation and unrelated histories. Actors
retrieve bounded history or discover Actors when the work needs it.

A skill file or a declared `skills` field does not prove automatic injection.
A reference skill is read through tools when relevant, unless a verified runtime
contract supplies it.

Prompt files are cached by the running Bridge. Editing them changes nothing
until a restart, and an observed turn is the only proof of what is active.

## Discovery

Capability search returns operation summaries. Selecting an operation loads its
exact input contract through the same discovery tool; its result schema is
available on request. Operation IDs and versions are labelled separately.
Searches use short keywords.

Actors never invent Endpoint IDs. They receive enough to reply to the current
source and can discover other valid destinations.

## Files and attachments

Workspace `read` and `edit` results include the SHA-256 and byte count of the
whole file they read or wrote; a selected range does not narrow that identity.

Attachments come from the Event's exact ArtefactVersion references. The
`read_artefact` tool uses the active Delivery's authority to fetch the same
digest-checked content other clients see; images are shown to the model only on
request, and text is paged with offsets and a whole-content digest. Each page
rechecks authority. Attachment bytes never travel through Actor instructions.

## Direction: focus by folder

_Resolution: question_
_Built: no_
_Authority: agent-provisional_
_Authored by: operator (thought log, June)_

Start an Actor in the smallest useful folder for its task, so large Workspaces do
not flood it with irrelevant files. The folder is a focus boundary, not a
blindness boundary: the Actor still knows the wider system exists and searches
outward when a change depends on shared contracts. Today every turn starts at
the Workspace folder.
