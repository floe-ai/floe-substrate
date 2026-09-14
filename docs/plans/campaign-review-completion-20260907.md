# Campaign review completion and evidence labels

Status: review correction and evidence-label increment verified and installed in
0.1.69. This is a real model review against the retained campaign Workspace.
It does not complete the full campaign journey.

## F55 — current Scope work reaches the reviewer

The operator request on 6 September created a fresh review using the current
reviewer settings and the three existing exact saved versions. Floe published
plan revision 5 and started `execution_c34dea0f-be33-43c8-a3fb-b498851c310c`.
The reviewer inspected and published against its own current NodeExecution on
the first attempt. No operation was refused and no reference-request loop occurred.
This supplies the previously missing live Scope repeat for F55.

- Workspace: `workspace_cde8e617-30c2-4638-9072-36df577e52f3`.
- Request Event: `evt_02d02591-288d-42bf-b283-4eff53a7f879`.
- Plan: `revision_b1bc7630-c85d-4893-ade5-0c9398f6ecaf` (revision 5).
- Reviewer definition: `actor_definition_3a216e51-6fff-42bf-a8ba-d8e8c1846441`.
- Reviewer Delivery: `del_e9aeab3b-3c0b-43bf-a6a2-52d00dd0ed5d`.
- Reviewer NodeExecution: `node_execution_38800dca-efd9-4984-9f46-f3249b517f71`.
- Verdict publication: `publication_c3f1630e-cf8b-47ba-966d-d726dd943551`.
- Verdict Event: `evt_7e48e8d0-dd95-4103-9277-3758f53e16d2`.

The reviewer checked the saved evidence (22 passing checks, zero failures),
retained its provenance/licensing and accessibility limitations, and performed
no image inspection, rebuild, or external publication. The prior completed and
cancelled runs remain retained. The three saved versions were unchanged.

## F67 — review completion was confused with release approval

The reviewer deliberately published `lifecycle_outcome: waiting` because
publication approval remained unresolved. The operation succeeded and the run
became `waiting_external`. Floe then reported it as a blocker and withheld the
named evidence, although the technical verdict had already been saved.

The generic need is to finish assigned work while preserving a separate unresolved
decision. This is primarily Actor responsibility/configuration. It does not need
a new lifecycle or a review-specific substrate rule. Existing output publication
can finish a nonterminal node. The operation schema now explains that lifecycle
outcome describes this node's assigned work and grants no approval for other actions.

On 7 September, the actual conversation received one correction request to finish
the same review from its saved verdict, clarify the reviewer's instructions, and
return named evidence. It explicitly prohibited rebuilding, repeating the review,
creating another run, or granting publication approval.

- Correction Event: `evt_6c684fbf-4cc6-44b4-a496-a9d164525a23`.
- Initial Delivery: `del_5803b644-f890-4430-a19f-c92596049263`.
- Recovered Delivery: `del_d1283db4-2c0f-48cc-9feb-d381608d1048`.

The local service exited before the initial Delivery produced any model telemetry.
Its process and listener were confirmed absent. After launching the installed app,
the original lease expired and the same Event entered the recovered Delivery;
the operator message was not resent. The cause of service exit is unproven.
The recovered request completed. Floe published reviewer definition
`actor_definition_679f3295-a0fc-4e05-9e4c-2288e5b3e143`; only its instructions
changed. Responsibilities, grants, policies and runtime binding were preserved.
It then requested the existing reviewer to settle the same node from its saved
verdict. That reviewer recorded completion publication
`publication_32020707-f37c-44e4-ae5f-81099058618a` (Event
`evt_d34a513f-0c25-4429-bacc-2ee26ec06f19`) at 00:07:12 UTC on 7 September.
The publication points to the original verdict and explicitly retains release
approval as unresolved. The original verdict and all three exact versions are
unchanged. No new run or approval request was created.

Floe inspected the result and returned the three named saved outputs in
`evt_84c4e8cc-a513-409e-bdcd-1ce7514ab2a8`. All three recovered model Deliveries
acknowledged. `review-audit.json`, `completed-review-records.json`,
`correction-final.json` and `preserved-after-correction.json` retain the evidence.
The new instructions still need a future fresh-review repeat to demonstrate
that review completion no longer requires this correction.

## F68 — meaningful run and evidence labels

Observed in the real work view: run cards displayed raw status and opaque plan
IDs; three different saved inputs shared the output-port name
`campaign.review-package.ready · version 1`.

This is a client representation correction over existing canonical records.
Run cards and the run chooser now share readable status and date labels. Saved
items keep their filename when available, otherwise their declared type, with
media type as fallback. A shared port no longer replaces each item's name.
Media parameters such as `text/html; charset=utf-8` are normalized for preview
classification. No Artefact, version, composition, or approval is rewritten by
these presentation changes.

Returning from the completed review also exposed a stale list status: the list
did not react to `scope_output_published`, the committed notification that can
finish a run. It now refreshes from that existing push notification. Run names
use status and creation date, avoiding inconsistent numbering between filtered lists.

Focused checks: 17 tests passed across the conversation work view, pipeline
projection, and run controls. The new regression opens three different exact
versions through their distinct labels on one port; another reproduces the
waiting-to-complete notification. Five Scope operation tests passed.
App typecheck passed. The actual browser displayed distinct Campaign site,
Campaign build evidence, and Campaign test evidence labels, rendered the saved
gallery, and opened each matching report. The run list and chooser show Complete.
Screenshots and DOM snapshots are retained in the evidence directory.

## Installed 0.1.69 and restart proof

The Windows build, including both installers and packaged sidecar checks,
completed. Installation used the existing `C:/Apps/Floe` location after confirming
there were no active Deliveries. Recovery copy:
`C:/Users/jfenech/.floe/recovery/before-0.1.69-20260907-review`.
The recovery database passed integrity checks before installation.

After installation, the verified desktop SHA-256 is
`ac36b25a1ae79980eda8b328280b8acb192b76797cc893a7325fa2e776dbd7f3`;
the service SHA-256 is
`d9a6f609e1767559e0ec75a0e3067aec007fa4a36f87b67428730e6627fbae38`.
The broker remains
`7dd6b1162f37dc8b1648ba28fe7e035e9a15bbef951ef25c6257cf8529760e6b`.
The desktop differs from the raw build only by Tauri's expected NSIS bundle
marker; every other byte matches. Service and broker bytes match their builds.

All 1,517 earlier Events, 36 Actor heads, runtime bindings, grants, account files
and configuration are preserved. Database schema remains 13, integrity is good,
and no foreign-key errors exist. The three saved evidence hashes still match;
the completed review and earlier runs retain their states. The exact desktop
broker conversation-read test passed in all eight Workspaces with conversations,
including cross-Workspace refusal. Native window visual interaction remains
unproven because the available UI tool does not expose native applications.

The browser repeat uses the compiled `floe-app/dist` through `vite preview` on
5379 against the installed 0.1.69 service. Its loaded entry is
`/assets/index-Bkv2EZon.js`. It reopens the completed conversation, named outputs,
and completed work view after restart, without account repair. This is compiled
browser-client proof, not proof of a standalone packaged web server or native
window interaction. The installed pipeline snapshot is `installed-pipeline.txt`;
installation and preservation reports are in the same evidence directory.

## Cost and remaining proof

The first fresh review and its single scheduled verification used 41 model
responses and 1,095,569 reported total tokens, including 201,984 cached input
tokens. The reviewer saved its verdict about 208 seconds after the operator
request. The subsequent check did not resolve F67. This is not a successful
end-to-end completion or evidence that token-efficiency targets are met.

The successful correction used 46 model responses and 966,387 reported tokens,
including 313,984 cached input tokens. It took 650 seconds from the saved request
to Floe's final reply, including the service interruption; model execution after
recovery took about 354 seconds. Total fresh review plus correction: 2,061,956
reported tokens across 87 responses. No model tool failed or repeated image
inspection occurred in the correction. Repeated capability discovery and history
retrieval remain expensive; do not treat this as the efficiency target achieved.
The correction's discovery trace includes repeated searches for node completion,
waiting, and execution finish before discovering output publication. The next
efficiency diagnosis should examine that real discovery path. Floe's final
message also still exposes internal IDs; named attachments are usable, but its
summary is not yet consistently written for the operator.

Local evidence: `C:/Development/_temp/floe-campaign-review-evidence-20260906/`.
`baseline.json` retains the before-state; `first-review-final.json` retains the
first attempt independently of later observations. `work-label-tests.log` records
the 17 passing checks. `observe.json` is the latest live observation, not an
immutable final result.

Release approval remains a separate unresolved decision (F60). No exact external
destination or publication action has been supplied. The full acceptance gates
and all 18 steps in [end-state verification](end-state-verification.md) remain required.
