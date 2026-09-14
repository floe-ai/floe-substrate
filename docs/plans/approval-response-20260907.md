# Approval response proving slice — 7 September 2026

The previous goal turn made progress: installed 0.1.75 preserves recorded
decision feedback and the real model now keeps the original export approval
unchanged. Its subsequent attempt proved F80: deciding that request cannot
resume the requested work. The full goal remains active.

## Observed need and placement

An operator decision must reach a selected collaborator without another message.
This belongs in the existing request and Event/Delivery mechanisms. The Actor
chooses whether to request a response and what to do with the decision. The
substrate does not choose a recipient, execute an action merely because it was
approved, or require a Scope for ordinary conversation.

`approval.response.configure` selects an existing participant in the pending
request's original active Context, or removes that selection. The exact action,
inputs, evidence and Policy remain unchanged. The response choice is inspectable
on the canonical request and guarded by its current revision. The same operation
serves interactive and unattended participation. Existing Scope decision bindings
remain independent stored routes.

The resolving decision and its direct delivery obligation commit together. A
partial collective vote does not deliver a response. A replay returns the saved
decision without creating another response. If the recipient left or became
unavailable, the decision still records successfully and retains the suppression
reason without delivering content to that recipient.

The app's **Choose decision response** reads current request and Context state,
offers eligible collaborators by name, and confirms that choice against the
current exact request revision. It uses the existing typed action form and does
not ask the operator to enter participant IDs.

## Resuming the exact operation

The export regression attempt exposed the second part of F80: an approved retry
from a new response was rejected because the new Delivery replaced the original
invocation's provenance. An idempotent retry now retains the saved invocation's
causal origin. Current authority, interaction mode, target, roles, Policy, exact
input and approval are still checked before the handler executes.

The decision Event carries the safe retry identity of its awaiting operation:
operation/version, target/revision, invocation identity and idempotency key. It
does not retain the operation input or secret values. The model tool also makes
an awaiting approval's refusal, request IDs and retry identity visible instead
of hiding them in tool details.

The local product adds only the response capability to previously initialised
default Floe Actors, preserving instructions and runtime bindings. The added
grant targets ApprovalRequests only, so it does not alter the authority set for
the already-reviewed gallery export. Removed or revoked upgrade grants are not
restored.

## Verification and actual result

The combined 88 Bus tests pass, covering request/receipt behaviour, all three
decision outcomes, restart, replay, missing authority, stale response changes,
removed participants, collective resolution, and exact-version export. A later
focused authority test also proves the new request-only grant leaves the export
grant set unchanged. The export test uses a new response to resume the original
intent, preserves the exact bytes, and consumes its approval once.

Sixteen focused client tests and ten model-tool tests pass. Bus and app builds
pass. The final narrow-grant build of 0.1.76 was installed. All nine desktop live
connections and saved reads in all eight Workspaces with conversations pass.
Retention preserved 1,580 Events, 31 versions, 11 Scope executions, both requests,
accounts, configuration and bindings. Eight default Floe definitions gained only
the narrow response grant; their instructions and other settings are unchanged.

The installed verification then caught a missing schema-version increment.
Existing schema-13 databases skipped the migration callback, leaving the new
response column absent despite its presence in fresh-database tests. No actual
response configuration or model attempt was started on that build.

0.1.77 advances the existing atomic backup-and-upgrade boundary to schema 14.
The new regression reproduces a retained schema-13 approval without the column,
verifies its recovery copy and unchanged action, then configures its response.
An isolated copy of the actual saved database also passes: 1,580 Events, 36 Actors,
31 versions, 11 Scope executions, both requests, 2,855 grants and 38 runtime
bindings survive unchanged. The original pending request accepts the response
in that copy. No alternate service was launched and the live request was still
unchanged at that checkpoint. The final 0.1.77 package is installed. Its desktop, broker and
service match the build. Live schema-14 verification preserves every earlier
Event, version, Scope execution and request, all 36 Actor heads, accounts,
configuration, grants and bindings. Integrity and foreign keys pass. Installed
desktop health, all nine live connections and saved reads in all eight Workspaces
with conversations pass. The browser recovers automatically.

At 05:13:17 UTC, the actual browser asked Floe to configure its response on the
original pending request. Request `evt_5c8410e0-d921-423f-aed8-00d0b637d9f6`
completed as Delivery `del_2a00a8c9-9e42-4b71-94fa-968b32a91c93`. The actual
model discovered and invoked `approval.response.configure`, then verified the
original request at revision 2. It retained the exact action and attached the
three saved versions with readable names. No approval or export preceded the
operator-surface decision. The app's **Choose decision response** independently
read the saved selection and displayed **Floe**; Astra did not configure it.

At 05:21:17.821 UTC, Astra operated **Decide approval** through the browser,
reviewing and confirming only the local product test. This is an agent-operated
test decision under the operator's standing test authorisation, not a claim that
the human personally approved a release. Decision
`evt_11e415b7-31a2-48b6-806b-c03e0605a000` produced one response Delivery,
`del_334cda3f-b5e3-48c4-8e9c-bbf0b7dc792b`, to Floe in the original conversation.
The browser displayed the decision, its reason and **Floe is working**.

Floe retried the original `artefact.version.export` intent using its saved
idempotency key, completed it under Floe's own authority, read the local output,
and returned `evt_c9ecffb2-ebb2-4a48-87a9-66b7f66eca4a` at 05:21:49.291 UTC.
There was no follow-up message, direct export by Astra, status-check loop, new
review, rebuild or image read. Both setup and response Deliveries are acknowledged.

The installed outcome audit proves:

- The original action and decision policy are unchanged. The earlier
  changes-requested clone remains unchanged, with no additional request.
- Approval receipt `approval_receipt_29f11d41-c2ca-49b6-b56e-1a32ee99bf89`
  was consumed once by Floe for the original export invocation
  `opinv_0790b9dc666166315652c035ed77365a`.
- `published/night-market/index.html` contains exactly 362,748 bytes with SHA-256
  `57dc46c34b38dfb81f2c35560015f3e0a397b5268147978fe55ef1ad1ff73743`, matching
  the reviewed Gallery. All eight earlier review runs, three versions and four
  campaign Actor heads remain unchanged; all three retained content hashes pass.
- The browser opens and runs the retained Gallery after the return. This is a
  preview of the saved version; the exported local file is independently verified
  byte-for-byte. No internet publication occurred. Database integrity and foreign
  keys pass.

Decision-to-result took 31.469 seconds and five model responses, reporting 35,848
tokens (30,288 input, 568 output, 4,992 cache-read; reasoning is reported separately
as 213). Response accounting is complete. The earlier setup cost 399,119 reported
tokens over fourteen responses; combined setup and continuation cost 434,967.
These are measurements of this attempt, not a comparable efficiency win. Earlier
diagnosis, failed attempts and installation work remain separate costs.

F80 now has an actual model/app proof. The full product goal remains active.
Two observed legibility gaps remain in this attempt: the pending request is named
by an ID and requires Actions/list/selection to reach; the final result is plain
text without an Open button, although the named evidence remains available in
preceding messages. The next bounded attempt should make the decision and result
reachable from the conversation using existing canonical references, beginning
with Actor behaviour and current client contracts. Native desktop window
interaction and the complete product gates are still unproven.

Evidence: `C:/Development/_temp/floe-approval-response-evidence-20260907/`.
Schema-14 upgrade and final install evidence:
`C:/Development/_temp/floe-approval-response-upgrade-evidence-20260907/`.
Pre-package focused logs are under the preceding
`C:/Development/_temp/floe-approval-feedback-evidence-20260907/`.
