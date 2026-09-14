# F70 — saved review evidence and one assignment

## Attempt and observed failure

The fresh review in `execution_3ef81f6f-4931-4c33-8d10-2378c02b5a4d`
completed, but Floe requested the same reviewer through a second direct
conversation. That reviewer asked Floe for a verdict already saved in the
Scope. Inspection exposed publication IDs without the published content, so
Floe searched repeatedly for another Context's history and workspace files.
The complete request used 2,257,948 reported tokens across 91 responses.

The saved verdict also reported 21 checks. The exact saved test report contains
22 checks. Later chat summaries saying 22 did not correct the immutable verdict.

## Smallest need and correction

An authorised Actor needs to follow a saved work-output reference without
requesting that work again. This belongs in the existing execution inspection
contract and Actor behaviour, not a new Event primitive or review lifecycle.

`scope.execution.inspect` now accepts optional `include_outputs: true`. It
returns each publication's exact Event envelope and attached ArtefactVersion
IDs. Default inspection stays compact. The same operation, Workspace boundary
and grant apply to interactive and unattended Actors. Ordinary Context messages
and other executions' outputs are excluded; unavailable or mismatched Event
references return `event: null` without substituting content.

The default Floe instructions now prohibit assigning the same execution work
again through a direct request, require arranging its return, and direct the
Actor to read saved outputs. Counts and comparisons must use deterministic
calculations. These instructions need explicit publication to existing Actor
definitions; an installed default Markdown file does not replace retained
definitions.

The saved review graph can compose delivery back to Floe with existing Edges,
Ports and Context policies. Do not add polling or a special completion manager.
The live repeat must prove the return actually happens.

## Verification so far

- The new evidence-read test failed against the previous operation schema.
- Both focused operation suites pass: 25 tests, including equivalent modes,
  missing grants, wrong Workspace, and missing/mismatched Event references.
- `npm run build --workspace floe-bus` passes.
- Installed 0.1.71 passes full installed-binary comparison and retains all 1,533
  Events, 36 Actor heads, runtime bindings, grants, configuration and account
  files from its recovery snapshot. Database integrity and foreign keys pass.
- The live desktop broker reads conversations in all eight retained conversation
  Workspaces and refuses cross-Workspace reads.
- In the compiled browser client, Actions for the saved review discovers the new
  option, renders its checkbox and returns both published Events, including the
  original verdict and exact evidence references. This uses the shared operation
  without client-specific code or a model turn.
- Canonical Actor publication changed only instructions. Floe now uses
  `actor_definition_13cf943c-e616-48c2-aec8-1722a4e8138f`; the reviewer uses
  `actor_definition_2cc5fd47-214f-4eb6-8352-7a4263d4c58c`. Previous revisions remain.
- The identical review request was sent through the existing browser conversation
  at 01:24:29 UTC on 7 September. Event:
  `evt_a1867fdd-f19c-42e1-b52d-69e49924701b`; initial Delivery:
  `del_5a4f44db-3000-422b-957d-54f405e118df`.

## Live result

Execution `execution_6d01e42c-7727-4526-b5d5-86580f63eded` completed on published
revision 7, `revision_cdc5ae4f-7eec-4401-a73a-e8f77aab2165`. Its reviewer Node
`node_execution_4b9d12c8-b5e7-474b-ba8b-432ca5ff7efd` pinned the corrected
definition and unchanged runtime binding/model. The four prior runs remain
unchanged, and the exact three saved versions retain their original hashes.

Verdict publication `publication_3da9735c-79fa-443d-9444-e62aaa66384c`, Event
`evt_85a19405-49e4-44f7-9f51-2414c0ade62f`, records **22 total, 22 passed,
0 failed**. The reviewer used `run_command` to parse the saved JSON and verify
its SHA-256 before publishing; the command succeeded. Independent parsing agrees.
External publication remains unapproved and unperformed; no ApprovalRequest
was created. Provenance/licensing and accessibility-audit gaps remain disclosed.

Floe returned named gallery, test and build attachments to the original
conversation. The browser opened the exact gallery in its interactive preview
and read both reports. No additional reviewer request or operator intervention
was needed during the attempt.

| Measurement | Previous identical request | This repeat |
|---|---:|---:|
| Model responses | 91 | 49 |
| Reported tokens | 2,257,948 | 1,318,226 |
| Duplicate direct reviewer requests | 1 | 0 |

Reported token use fell **41.6%** with the same configured capable model and exact
evidence. This is one observed comparison, not a general performance guarantee.
This repeat took 400.3 seconds through its final conversation result. All four
Deliveries acknowledged and usage coverage matches all 49 model responses.
The initial Context-history tool failed once and recovered; there were no
semantic-operation refusals. Broad product completion remains unproven.

## F71 — completion still depends on timed collection

Floe used two one-shot pulses to collect the result. The first inspection at
01:28:49.396 UTC preceded verdict publication at 01:28:51.801 by 2.4 seconds.
It then published an already-stale active-status message and scheduled another
check for 01:30:17. The later check returned the result. These two turns cost
14 responses and 183,034 reported tokens; their schedule is not a durable
completion path for an arbitrary-duration review.

Smallest need: a completed result should deliver itself to the waiting
recipient. Existing stored Edges, Actor placements and fixed Context policies
can compose that return. The current plan has no return Edge. The first
instruction correction prevented duplicate assignment but did not make Floe
compose a direct return before starting work.

Next: correct Floe's coordination instructions at the Actor/configuration layer
to arrange a stored output return to its originating conversation, then repeat
the same outcome and prove completion without status pulses. Do not introduce
a new primitive, polling loop or completion manager. Preserve the five runs and
their verdicts. This is an observed remaining handoff defect, not a new roadmap.

The [F71 proving attempt](completion-return-20260907.md) checks the actual Context
boundary: execution Contexts stay in their Scope. A return placement receives the
output there, then communicates to the original operator Context; a fixed Context
from outside the Scope is not valid under the current contract.

Local evidence: `C:/Development/_temp/floe-output-handoff-evidence-20260907/`.
Key files: `comparison.json`, `review-final.json`, `review-final-audit.json`,
`handoff-tools.json`, `human-output-inspection.txt`, `final-conversation.txt`,
`gallery-preview.png`, `opened-reports.txt`, `opened-test-report.txt`, installed
binary/retention reports, and the focused test/build logs.
The complete goal and all gates in `end-state-verification.md` remain open.
