# F71 — deliver completion back to the conversation

## Observed need

The previous real review saved its verdict successfully, but Floe checked 2.4
seconds before that publication, reported an already-stale active status, and
scheduled another check. Collecting the result took two extra turns and 183,034
reported tokens. The operator needs the result when the work finishes.

The preceding goal turn made progress: 0.1.71 installed a governed saved-output
read and the same real review returned accurate evidence with fewer tokens.
F71 remains a concrete obstacle to durable completion and clear feedback.

## Classification and current contract

This is Actor/configuration behaviour using existing mechanisms. A stored output
Edge can deliver the result to a placement of the existing Floe Actor. That
result turn can verify the saved evidence and communicate to the requesting
Context without another assignment or timed status check.

Current code in `resolveExecutionContext` requires a fixed execution Context to
belong to the same Scope. The operator conversation is outside that Scope.
Do not move the conversation or widen this boundary to fit the earlier sketch.
The return placement can have its own execution Context and retain the requesting
Context reference in its instructions. Communication sends the verified result
back under the Actor's existing authority. Each runtime turn keeps one origin
Context; no unrelated history is injected.

## Change and proving attempt

The default Floe instructions now explicitly require a stored return Edge before
starting Scope work that needs a result in the conversation. They require the
requesting Context reference in the return placement and prohibit timed status
collection. The existing dedicated-progress-actor prohibition remains; reuse
Floe itself. No runtime or substrate code changed for this correction.

The source default and repository Actor Markdown match. Canonical publication
changed only Floe's instructions, from
`actor_definition_13cf943c-e616-48c2-aec8-1722a4e8138f` to
`actor_definition_0c76505e-2dc2-4823-b019-8566718e402e`. The reviewer remains on
`actor_definition_2cc5fd47-214f-4eb6-8352-7a4263d4c58c`; grants and model bindings
are unchanged. The 33 existing guidance/project tests pass.

The identical request was sent through the existing browser conversation at
01:42:16 UTC on 7 September, using installed 0.1.71 and the new published Actor
definition. Event: `evt_98049895-a42c-4038-b315-4b06c0ff56e7`; initial Delivery:
`del_71737f9c-1efb-4396-bb47-80f9b9e37381`. The app is building 0.1.72 to carry
the corrected default instructions for newly created Actors. That initial
candidate was replaced by the F72 correction below before installation.

## Required proof

1. Floe authors and publishes a real return route through its normal tools.
2. One reviewer receives the same three exact saved versions and records an
   accurate verdict; the earlier five runs and all evidence remain retained.
3. Output publication itself delivers the result to Floe, with no status pulse
   or duplicate reviewer request.
4. Named, openable evidence returns to the original operator conversation and
   the execution settles. Verify actual app behaviour and canonical records.
5. Measure all model responses, reported tokens, elapsed time and interventions.
6. Install the default-instruction package with retained-state proof, then reopen
   the actual result. Preserve the distinction between pre-upgrade model proof
   and post-upgrade inspection.

## First live result and F72

The first repeat created execution
`execution_26270dbd-8652-4857-a9f8-836533d123fc` on revision 8,
`revision_5f837031-2f1b-45bd-ad31-53cd898efa9d`. Floe authored
`actor_floe_return` and `edge_release_to_floe_return` through normal operations,
using the existing Floe Actor and a new execution Context inside the Scope.

The reviewer published the correct 22/22 verdict in Event
`evt_e7ff5485-142f-4437-8575-54839ecbaab0`. That publication traversed the stored
return Edge once and created Floe Delivery
`del_f012fd90-5a40-46ba-bbdc-dedd3d41d0cf` 16 milliseconds later. No timed check
or duplicate reviewer request occurred. All three Deliveries acknowledged.

The operator outcome nevertheless failed: Floe answered only in its execution
Context (`ctx_520556aa-504c-42f3-8274-b772d85e8247`), asking for publication
approval. The original conversation still contained only the start promise.
This is not a completed handoff or a valid efficiency improvement.

**F72 — discovery omitted the instruction-binding contract.** The authored return
placement stored its directions in `config.instructions` with `bindings: []`.
The runtime correctly injects only ordered `bindings` of kind `instructions`.
The discovered schema described bindings as arbitrary objects, so it omitted the
only implemented binding kind and its required text field.

The correction makes the existing binding fields self-describing, explains that
`config.instructions` is not injected, and rejects malformed bindings before
draft storage. Runtime interpretation is unchanged; do not add a second
instruction source or silently support the misplaced field. All 16 retained
bindings match the discovered supported contract.

The new regression failed against the old descriptor in both interactive and
unattended modes. With the correction, 27 focused Scope tests and four runtime
instruction tests pass; Bus and Bridge builds pass. The earlier 33 guidance
tests also passed. The final 0.1.72 package includes this contract correction.
Its installed discovery exposes the supported instruction binding. The repair
and fresh repeat below use that installed package.

First-attempt evidence is immutable in `first-final.json`,
`first-final-audit.json`, `failed-return-context.json` and
`first-conversation-missing-result.txt`. These preserve the failure separately
from the next attempt. No reviewer result or historical run was overwritten.

## Installed correction and retained-verdict repair

0.1.72 was installed at 01:59 UTC after the first attempt settled. MSI and NSIS
packaging passed, including packaged image decoding, isolated hosts and desktop
pipe-closure continuity checks. The installed desktop matches every built byte
except the expected Tauri bundle marker; the broker and service match exactly.
Recovery is retained under
`C:/Users/jfenech/.floe/recovery/before-0.1.72-20260907-completion-return`.
All 1,549 prior Events, all 36 Actor heads, bindings, grants, configuration and
account files survived. Integrity is clean and schema 13 is unchanged.

The installed desktop broker again reads conversations, history, delivery and
telemetry in all eight Workspaces with retained conversations. Cross-Workspace
requests remain refused. This checks the desktop's real transport path; native
window interaction remains a separate unproven surface.

The actual browser sent repair Event `evt_dafe91e9-2617-49ed-bf39-12e79be4f02f`
at 02:02:39 UTC. Floe discovered the corrected contract and published revision 9,
`revision_7d1d5225-d598-4d1a-ae73-338df97d5953`, moving the return directions into
an instructions binding and removing the inert configuration field. It returned
the already-saved verdict and three named attachments in the original
conversation. No review was repeated: all six runs and every saved version are
unchanged. The repair used 28 model responses and 1,072,023 reported tokens over
248.136 seconds. Keep that repair cost separate from any fresh-outcome comparison.
Evidence: `repair-final.json`, `repair-final-audit.json`, `repair-tools.json` and
`repair-conversation.txt`.

At 02:12:19 UTC the browser sent the identical fresh technical review request
once, Event `evt_7ddd7169-cb9b-45e5-add1-65bdfcca225f`, initial Delivery
`del_b0691705-6ea1-4af4-92bc-6437e51504dc`. The six-run baseline is retained in
`repeat-before.json`.

## Automatic return passes; attachment labels need correction

The repeat completed execution `execution_088a6411-c5b8-40aa-bd35-e80697ffb55e`
using the repaired revision 9. The existing reviewer independently verified the
same three exact versions and published the correct 22/22 verdict in
`evt_ac3a3976-d01f-437e-a75b-b37453e59aec`. All six earlier runs are unchanged.

The stored Edge created return Delivery
`del_26b2da3d-e256-4af6-b875-3753c98a140f` nine milliseconds after publication.
Floe inspected the saved output, resolved the original Context and invoked
`context.communication.emit` under its own authenticated principal. Receipt
`opinv_667c6ca05fe64adaf545851b795b1ca7` retains the verdict as cause and the
return attempt as provenance. The message arrived in the original conversation
38.368 seconds after the verdict, carrying all three exact versions. Its Event
is `evt_da0bc49b-cc97-44aa-bc02-fd04f7d4efbb`. Principal communication uses
`metadata.source_principal_id`; a null `source_endpoint_id` is expected here.
The browser correctly labels the sender Floe.

All three Deliveries acknowledged. There was one reviewer Delivery, no direct
request, no timed status pulse, no mid-attempt intervention, no image inspection,
and no rebuild or external publication. The deterministic command only parsed
and counted the saved report after verifying its hash. Complete usage coverage
records 26 responses and 767,856 reported tokens over 196.660 seconds.

The final UI still fails part of the accepted outcome: attachments are present
but labelled **Saved result 1, 2, 3**. Their useful names appear only in prose.
The return message omitted `content.attachments` display metadata. This is a
recurrence of F68, not a routing failure. Do not claim a same-quality efficiency
gain against the earlier 49-response, 1,318,226-token outcome while these labels
remain inferior. `comparison.json` explicitly marks that comparison invalid.
Immutable evidence: `repeat-final.json`, `repeat-final-audit.json` and
`repeat-unnamed-conversation.txt`.

At 02:18:10 UTC the browser requested only an attachment-label correction,
Event `evt_befed950-6a07-40a3-a6c3-b87773cd47bf`, Delivery
`del_081d0b86-f278-4ac9-a7ad-9f0f54fb1313`. Floe must correct the saved return
step and resend the retained verdict with named buttons, without another review.
The named result arrived in `evt_52844a6a-2bdc-4b01-be05-0d24869e4955` with
**Gallery**, **Test report** and **Build report** attachment metadata. All seven
runs and exact versions remain unchanged. The label correction used 22 responses
and 747,175 reported tokens over 206.038 seconds. The review plus label repair
therefore used 1,515,031 reported tokens, excluding the earlier return repair.
This is recovery evidence, not an efficiency improvement. The browser opens the
gallery preview and both named reports; evidence is in `labels-final.json`,
`labels-final-audit.json`, `named-gallery.png` and the named-report snapshots.

## F74 — fixed Context validation and corrective configuration

The label repair also published revision 10,
`revision_ab7e6664-5696-4845-a939-c8f2f0c08fb1`, changing the return placement to
a fixed operator Context and using native `emit` in that Context. Validation and
publication both accepted it. That Context is outside the Scope, so the existing
`resolveExecutionContext` contract cannot activate it. No execution was started
against this revision. The gap is early validation of an already-enforced
Context constraint; do not widen execution boundaries to accommodate it.

Astra corrected only this return placement through normal authenticated
operations. Published revision 11 is
`revision_2966b1b3-e73b-4149-99c5-41c2afc6e29a`, receipt
`opinv_0a9cbe9f8b9ddea3bd2204bb16f2b8ad`. It restores `new_per_execution` and
explicit communication to the requesting Context. Its instructions include both
the exact canonical version IDs and `content.attachments` display names. Ports,
Edges, other placements, Actor definitions and runtime bindings are unchanged.
The impact report contains only `actor_floe_return`, with no active executions
affected. The invalid revision remains retained history. The first developer
validation request omitted the separate expected revision field and was refused;
the corrected request with the exact digest passed. No live SQL writes were used.

This developer intervention is recorded, not attributed to Floe. At this
checkpoint the configuration was corrected and inspected, but the full named
automatic return still required a fresh model repeat after correcting F73/F74.
The subsequent 0.1.73 proof linked below completes those checks. Evidence:
`return-config-before.json`, `return-config-ready.json`,
`return-config-publish.json`, `return-config-after.json` and
`return-config-verification.json`.

## F73 — bounded history loses page structure

Both the repair and fresh repeat returned history text truncated at 16,000
characters. In 0.1.72, `createContextHistoryTool` serialized `{events,next_cursor}`
and then slices the entire JSON string, which can remove both part of an Event
and the cursor. The repair subsequently tried an Event ID and timestamp as
cursors; both failed. The fresh repeat recovered by requesting fewer Events,
then continued through further pages. Source and live retrieval telemetry are
retained in `history-page-evidence.json`.

The observed need is a bounded, structurally complete history page with a valid
continuation reference. This belongs in the existing Bridge tool representation;
it does not need a new history source, cross-Context prompt injection, or polling.
The subsequent correction proves no skipped contributions or fabricated cursors
before its same-quality efficiency comparison. No F73 implementation was included
in 0.1.72.

## Subsequent verification — 0.1.73

[History, validation and return proof](history-and-plan-validation-20260907.md)
records the installed corrections and successful full named automatic return.
The fresh review preserves all seven earlier runs and the three exact versions,
returns the accurate 22/22 verdict without intervention or timed checks, and
opens Gallery, Test report and Build report in the browser. It uses 28 responses
and 595,342 reported tokens, 54.84% fewer than the earlier successful equivalent
review. That is one repeat, with the earlier failures and repair costs above
retained separately. No full end-state gate is closed.

Local evidence is in
`C:/Development/_temp/floe-completion-return-evidence-20260907/`.
The full goal and all end-state gates remain required.
