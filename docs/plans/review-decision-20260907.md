# Review decision proving attempt — 7 September 2026

The previous goal turn made progress: installed conversation reads passed in all
eight retained Workspaces, and the fresh review returned its named gallery and
reports automatically. Those browser attachments were opened and the proof index
was updated. The full goal remains active.

## Real attempt

At 03:03:37 UTC the operator browser asked Floe to prepare a decision about
exporting the exact retained gallery to `published/night-market/index.html` in
the campaign test Workspace. No copy or publication was authorised yet. This
tests a real local action without granting internet publication or accepting
the gallery's disclosed licensing and accessibility gaps for public release.

**F75 — an apparent approval without a record.** Floe emitted a message headed
“Approval requested” with attachments and invented `data.decision_request`
metadata. The actual approval inbox remained empty. It did not call
`approval.request`. The initial turn acknowledged after 29 responses and 766,454
reported tokens. No files, versions or previous reviews changed.

The generic need is an inspectable, durable decision for an exact supported
action. Conversation text cannot replace that record. The correction belongs
first in Actor behaviour: the default instructions now require a retained
ApprovalRequest before claiming that an approval is ready. The same one-paragraph
correction was published to the existing Floe Actor through normal operations,
preserving its other instructions, grants and runtime binding.

The actual browser then reported the empty inbox. Floe corrected its earlier
claim and identified the missing action without inventing another record. That
turn acknowledged after 19 responses and 615,459 reported tokens. These costs are
failure and diagnosis costs, not an efficiency improvement.

**F76 — exact saved content cannot be exported through a shared action.** Current
operation discovery and source agree: no operation or enabled Extension can save
an exact ArtefactVersion at a requested Workspace path. Ordinary runtime shell
access does not supply an approvable shared action. The existing Extension
filesystem broker is also unavailable, so an Extension cannot currently compose
this from supported file access.

## Native increment

The smallest generic capability is exporting an immutable saved version to a
Workspace file. `artefact.version.export` extends the existing Artefact contract;
it does not introduce publication policy, a new primitive, an approval system,
or a second record of identity. The existing resolver verifies the bytes. Atomic
file creation preserves different existing content, while a matching file can be
reused after retry. Current grants, Policy, approval, idempotency and audit apply
through the same operation registry for app, model and API callers.

The operation supplies a Bus-authored description of the exact destination and
version for the existing ApprovalRequest expected effect. Only that safe summary
is retained; arbitrary operation inputs are not copied into approval records.
The local review requirement will be configuration of the existing Policy
mechanism, limited to this test gallery. Other work remains unaffected.

## Verification

Thirteen export tests pass, including both interaction modes, byte identity,
unchanged canonical versions, retries, conflicting destinations, altered source,
path traversal, Windows alternate streams/reserved names, symlink escape, missing
grants, cross-Workspace access, exact approval before filesystem changes, changed
destination requiring its own decision, and one-time approval use.

The combined Artefact, governance and approval suite passes 37 tests; ten
Workspace import and authority-upgrade tests also pass. The Bus build passes.
Default Floe Actors receive the exact export capability through the existing
local product authority upgrade, preserving their other configuration and
respecting earlier grant removal or revocation. A gallery-specific review Policy
has been configured through normal operations in the campaign test Workspace.
No ApprovalRequest or preview file has been created by this setup.

The operator then reported the desktop's persistent reconnecting label. The
[desktop health investigation](desktop-runtime-health-20260907.md) reproduced a
separate client health-read failure (F77). 0.1.74 is now installed with that
correction. Retention checks preserve all 1,574 earlier Events, 36 Actors, eight
earlier review runs, original grants, runtime bindings, account files and
configuration. Eight eligible default Floe definitions gained only the export
grant; their other instructions and settings are unchanged. Database integrity and
foreign-key checks pass at schema 13.

The actual model/app attempt was repeated on 0.1.74 at 03:50:36 UTC. The export
preflight created a valid pending request. Floe then cloned it to add supporting
reports and changed its bound action, making the clone unsuitable for the original
export. The browser recorded **Changes requested** on that clone; no approval or
local copy occurred. See [approval feedback](approval-feedback-20260907.md) for
F78/F79, installed 0.1.75, and the outstanding automatic continuation attempt.
The full end-state gates and 18-step journey remain pending.

Evidence: `C:/Development/_temp/floe-review-decision-evidence-20260907/`.
