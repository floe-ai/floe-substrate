# Floe instruction layering

## Purpose

Keep actor instructions accurate and compact. Load changing implementation knowledge when an attempt needs it, and distinguish editable Markdown from the instructions an execution actually received.

## Current instruction path

### Shared runtime guidance

`floe-bridge/src/prompts/substrate-guidance.md` is read by `prompt-assets.ts` and appended by `runtime-core/guidance.ts` to actor instructions. It supplies common Context, Event, execution, and authority semantics. It must not impose the default Floe actor's preferred organisation or communication policy on every actor.

Prompt assets are cached in the Bridge process. Editing source Markdown does not update an already running or packaged Bridge. A build/restart and an observed turn are needed to establish which guidance is active.

### Default Floe actor

`floe-bridge/src/prompts/default-floe-agent.md` supplies reusable operating behaviour: understand outcomes, discover capabilities, organise useful work, verify results, and keep the operator informed. This coordinating responsibility belongs to the actor, not the substrate.

`project.ts` seeds `.floe/agents/floe.md` when the file is missing. It preserves existing workspace files. Updating the template therefore changes future initialisation; it does not replace existing workspace instructions.

### Workspace instructions and canonical revisions

`.floe/agents/*.md` contains editable actor source and configuration. The current Bridge submits a configuration inventory to the Bus. Canonical ActorDefinition revisions and Runtime Profiles determine the instructions and runtime selected for execution; files are not an alternate authority or execution ledger.

`runtime-processing-contract.ts` selects instructions from the Bus-issued processing contract, including pinned placement instructions where applicable. Published revisions and existing execution pins must be preserved. Verify import/publication and the actual processing contract before claiming that an edited file changed a live actor.

### Reference skills

`floe-bridge/src/prompts/substrate-build-skill.md` seeds `.floe/skills/substrate-build/SKILL.md`. It is an on-demand reference for composition and Extension contracts. As with the actor template, existing files are preserved.

A declared `skills` field or a Markdown file does not prove automatic injection. The current Pi adapter builds its system prompt from selected actor instructions plus shared guidance; it does not concatenate arbitrary skill files. A reference must be read through available tools when relevant unless a verified runtime contract supplies it another way.

### Tools and the current cause

Not everything supplied to a model is Markdown. Runtime code defines tool schemas and descriptions, constructs the current cause and Context envelope, and supplies scoped runtime data. The Bus owns discovered semantic operation schemas, authority, receipts, and execution references. Relevant Context history is retrieved on demand.

Capability search returns operation summaries. Selecting an `operation_id` loads
that operation's exact input contract through the same discovery tool. Its result
schema is available explicitly when needed for integration work. This changes the
model's presentation of the Bus contract, not authority or operation semantics.
Operation IDs and versions are labelled separately so the combined display cannot
be mistaken for an ID. Queries use short keywords because long sentences match
many unrelated operations.

Workspace `read` and `edit` results include the SHA-256 and byte count of the
complete file snapshot they read or wrote, including its original bytes and line
endings. A selected text range does not narrow that identity to the excerpt.
Publication still checks those bytes; the tools do not promise that a working file
cannot change after the snapshot.

The Pi adapter records `usage` for each completed model response, including those
that request tools. New records carry `measurement_scope: model_response` and a
turn-local `response_index`; `usage_coverage` records the response count when
`agent_end` is observed. Missing usage remains null. A turn with no coverage
record has an incomplete measurement, even when some responses were recorded.
Older usage records contain only the final response and cannot establish a total.

Cancellation is runtime state, not an actor instruction. The direct conversation
client invokes `runtime.delivery.cancel` for one exact active response through the
shared operation contract. Its terminal state revokes operation authority and
pushes abort to Pi. Partial text from an aborted or failed response cannot become
a successful completion. Already committed results and file changes remain
available. The conversation projects active requested responses from their recorded
`request_parent_delivery_id` lineage and offers a separate Stop control for each.
Stopping one response does not implicitly cancel its descendants; canonical Scope
execution cancellation uses `scope.execution.stop`.

Shared attachment membership comes from exact Event ArtefactVersion references, with display labels
from Event content. Both the current cause and requested history preserve those references. The
shared runtime `read_artefact` tool uses active Delivery authority to retrieve the same digest-checked
content available to other clients. It presents supported images to the model only when requested;
text output is paged with explicit offsets and a whole-content digest. Later pages
recheck current Delivery authority; they do not require reading a mutable source
file or retain an authority-bypassing content cache. Attachment bytes are not
injected through actor Markdown.

Tool failure reporting combines runtime exceptions with explicit tool failure
results. A normally returned nonzero command exit remains a failed operation in
progress, hooks and the work log; a completed tool call does not prove success.

Tool calls and scratch reasoning remain private trace unless an actor deliberately contributes a useful result. One turn uses one origin Context. Implementation documentation and unrelated histories are not default turn input.

## Change and verification rules

- Put generic execution semantics in shared guidance and coordinating preferences in the default actor.
- Keep workspace-specific responsibilities in workspace actor definitions; preserve intentional local customisation.
- Update templates and authorised existing copies separately. Do not overwrite every workspace or mutate pinned history to propagate prose.
- Follow accepted ADRs and live discovery when a reference disagrees; repair the contradictory reference.
- Run relevant prompt and template checks, then inspect the running version and an actual turn during product acceptance.
- Measure efficiency per successful outcome, including repeated attempts. Shorter instructions alone do not prove fewer tokens or better work.
