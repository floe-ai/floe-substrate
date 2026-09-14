# Desktop exit and fresh review proof

Status: F69 corrected, installed and proved with a real browser conversation on
0.1.70. The packaged regression and eight-Workspace desktop read check pass.
This is a bounded increment, not full product completion.

## F69 — starting work after desktop exit stopped the service

The generic need is for a client to disconnect without terminating shared work.
This belongs in local runtime infrastructure; it needs no new substrate concept
or client-owned execution state.

Installed 0.1.69 started desktop PID 40720 and service PID 41620. With no active
Delivery, the desktop was deliberately terminated. The service remained healthy
and the compiled browser opened the saved build report. A subsequent real review
request was retained as Event `evt_da284c6c-f1ea-4c1e-a0b4-386b0c364de5`, but the
service then exited before its first model response. Delivery
`del_00242c0c-6219-479a-9d95-b375b4b607e0` was left leased and the browser showed
reconnecting and failed refreshes.

The isolated packaged service reproduced `EPIPE: broken pipe, write` and exit
code 1 when its stdout reader was closed and `console.log` subsequently wrote.
Health requests alone did not reproduce the failure. This matches the live
Bridge's first diagnostic at Delivery dispatch and explains why read-only
browsing appeared healthy after desktop exit.

The packaged substrate now handles only `EPIPE` from stdout/stderr. Losing a
diagnostic reader cannot end shared work; unrelated stream errors still fail
visibly. This is scoped to the service entry point, not authentication helpers
or a global exception handler. Runtime telemetry and work history retain their
existing canonical storage. Console output whose desktop reader has closed is
not retained by that reader.

`floe-app/scripts/check-substrate-continuity.mjs` starts the actual packaged
service with a temporary empty home and a temporary credential, closes both
console readers, exercises later console writes, and verifies continued health.
It also verifies that an unrelated `EIO` still exits visibly. It failed against
installed 0.1.69 and passes against the candidate. Sidecar packaging now runs it
alongside the existing isolated Command, Extension and image checks.

The first-run guide also corrects a stale claim that Floe replaces an
unresponsive process. The launcher deliberately leaves an occupied port alone.

## Installed 0.1.70 repeat

Both installers built successfully. The installed desktop matches the build
apart from Tauri's expected NSIS marker; the authority broker and service match
byte-for-byte. Recovery is saved at
`C:/Users/jfenech/.floe/recovery/before-0.1.70-20260907-continuity`.
All 1,531 earlier Events, 36 Actor heads, runtime bindings, grants, accounts and
configuration survived. Schema remains 13; integrity and foreign keys pass.
All three exact campaign content hashes match and the temporary grant remains
revoked.

The compiled browser loaded `/assets/index-CIXaKj7g.js`. The actual desktop
broker read check passed in all eight Workspaces with retained conversations,
including refusal across Workspace boundaries.

Desktop PID 39120 was terminated at 00:54:39 UTC with service PID 9640 retained.
The browser then sent a new, useful question about decisions needed before
publication. Event `evt_3df70c7b-98e4-42cb-9cc7-ac998e5a943b` entered Delivery
`del_a04960cf-3da4-4d46-9a11-e89f3f40b9a1`, which completed and acknowledged with
no error. Floe returned two short bullets distinguishing the unresolved evidence
gaps from exact publication approval. The response was visible in the original
conversation while the desktop was still absent.

Response Event `evt_9667e580-ef70-4046-bb5a-34d8a29d4ec7` was saved at
00:55:38.724 UTC, 22.5 seconds after Delivery creation. It used three model
responses and 24,832 reported tokens, with two bounded history reads and no
other tools, delegation, new review or external publication. This measures a
different, smaller outcome than the fresh review and is not a comparative
efficiency claim.

Reopening the installed desktop as PID 36880 at 00:57:08 UTC kept the same
service PID 9640 and its original 00:52:33 UTC start time. The model request
therefore started and finished while the desktop was absent, without a service
restart or message resend. Native window interaction is still unproven because
the current UI tool exposes only the browser.

## F67 — updated reviewer instructions were used in a fresh run

Restarting installed 0.1.69 recovered the original request after lease expiry;
the operator message was not resent. Floe published plan revision 6 and the
reviewer recorded a completed review without another completion correction.

- Recovered Delivery: `del_0d16d809-1b4d-42d9-b22b-ada4fdd9890e`.
- Plan: `revision_187f9d7b-47d0-4f93-8ae4-8173aa98180e`.
- Execution: `execution_3ef81f6f-4931-4c33-8d10-2378c02b5a4d`.
- Reviewer definition: `actor_definition_679f3295-a0fc-4e05-9e4c-2288e5b3e143`.
- Reviewer node: `node_execution_2308018c-119e-4614-895e-d7585ab0de06`.
- Verdict publication: `publication_b8b80318-e3d0-4d08-9dbb-0e1869530468`.
- Verdict Event: `evt_805ad354-5289-4bd4-b286-537e8fe7de6d`.

The review completed at 00:41:39 UTC on 7 September with release approval still
unresolved. No ApprovalRequest exists and no external publication occurred.
Earlier completed/cancelled runs remain retained. This proves the F67 lifecycle
correction in a fresh review; it does not establish accurate, efficient handoff.

## F70 — the fresh review still has evidence and handoff waste

The reviewer first used an incorrect resource revision, then tried to attach
three versions through a Port accepting one. It recovered and published the
site with the other references inside the verdict. Floe also sent a direct
request while the Scope review was already assigned. That extra turn re-read
the three reports and requested the already-recorded verdict back from Floe.
Floe repeatedly searched for access to an Event or another Context's history,
then searched workspace files. This is observed redundant work, not a
hypothetical performance concern.

Current contract inspection supports that diagnosis: `context_history` reads
only the origin Context, while `context.get` and `context.inspect` expose
identity/access/lifecycle metadata, not paged Event content. Do not solve that
by injecting unrelated Context history into runtime turns or bypassing authority.
Inspect the existing read projections and expose the smallest governed read
needed to follow an exact saved reference.

The saved verdict also says 21 checks passed. Direct parsing of the exact saved
test report proves its `checks` array contains 22 entries. Later conversational
summaries say 22, but that does not correct the immutable verdict. Do not claim
this attempt proves exact result accuracy or token efficiency.

Floe eventually returned three named attachments in the original conversation.
The complete attempt consumed 2,257,948 reported tokens across 91 responses,
including recovery and the redundant request chain. The initial failed Delivery
produced no model telemetry. Exact per-Delivery accounting is retained in
`fresh-review-final.json`; this is not an efficiency improvement.

Next, diagnose the existing publication/evidence read contracts and the actor's
choice to request work already running. Use deterministic verification for
mechanical counts. Re-run the same bounded handoff after correcting the proven
cause; do not add a new review lifecycle or generic orchestration framework.

Follow-up: installed 0.1.71 completes the same request with a correct saved count,
no duplicate reviewer request and 41.6% fewer reported tokens. Timed result
collection remains open as F71. See [output evidence and handoff](output-evidence-handoff-20260907.md)
for the new evidence; the measurements above retain the original attempt.

## Evidence

Local evidence is in
`C:/Development/_temp/floe-host-continuity-evidence-20260907/`:
`before.sqlite`, `before.json`, `after-host-exit.json`,
`report-without-desktop.txt`, `review-request.json`,
`closed-native-output-repro.json`, `continuity-before.log`,
`fresh-review-audit.json`, and the candidate build log. `observe.json` is the
latest observation, not an immutable final result.

Installed proof: `installation-verification.json`, `retained-upgrade-0.1.70.json`,
`desktop-post-install-reads.log`, `preserved-after-install.json`,
`before-fixed-host-exit.json`, `after-fixed-host-exit.json`,
`headless-request.json`, `headless-final.json`, `headless-events.json`,
`headless-result.txt`, and `after-reopen-processes.json`.

All gates and the full 18-step journey in
[end-state verification](end-state-verification.md) remain required. R9 still
needs the remaining browser/mobile actions and client matrix after this bounded
desktop-exit proof.
