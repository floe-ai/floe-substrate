# App participation revision — 2026-09-06

Status: 0.1.67 built, installed and running. Normal app participation, output and
work notes pass against the installed service. Full product acceptance remains pending.

Subsequent desktop correction: the operator reported conversations failing across
Workspaces. Earlier browser checks missed the native broker's route restriction.
See [F66 desktop conversation loading proof](conversation-loading-fix-20260906.md).

## Observed need

A person must be able to read assigned work, discuss that work and publish an
authorised result without configuring a test identity or copying record IDs.
This is an increment of existing Actor authority and client representation.
It introduces no substrate primitive or new permission based on Actor backing.

## Changes

- **F64:** output publication resolves current Principal–Actor binding and exact
  executor evidence. The authenticated principal and assigned Actor may have
  different identifiers. Revoked bindings, absent grants and conflicting runtime
  origin remain refused. App onboarding prepares an unbound participant with a
  published app Runtime Profile through normal operations; chosen or disabled
  runtime bindings are preserved. Lost setup responses and concurrent opens are
  covered by integration tests.
- **F65:** a work conversation posts to its Context with no requested reply.
  It no longer arbitrarily addresses the first participant. Explicit direct
  communication still requires an addressable recipient. This is not evidence
  of a background human notification adapter or direct-message delivery to an
  unattached Actor.
- **F57:** the CLI now reads the actual installed broker's flat local Workspace
  projection. The old parser expected a nested binding and refused every local
  Workspace list. Missing bindings remain unbound; malformed records fail closed.

The selected pipeline step now exposes its existing actions under Work details,
carrying its exact execution revision. Output publication offers the saved output
names as a picker; values remain the pinned Port references, and the shared
descriptor and server still validate the invocation. The approved canvas remains
the default presentation.

## Real app attempts

The retained courtyard wall-panel Context now contains the acceptance note that
was refused in the visual revision. The browser displayed the note as Operator
and cleared the composer. Evidence: `C:/Development/_temp/floe-actor-parity-evidence-20260906/wall-panel-note.png`.

The fresh **Floe app participation proof** Workspace was registered through the
normal app screen at `C:/Development/_temp/floe-app-participation-20260906`.
Its operator, principal binding and app runtime profile were created by normal
onboarding, with no worker Endpoint or model turn. A two-step review was composed
through canonical operations and assigned to that operator.

Workspace: `workspace_aefa1110-03ad-4149-a1b1-3046aa56a1e2`.
Scope: `scope_app_participation_review`.
Execution: `execution_39668e50-e3ef-4d8d-9838-bcae85057fa7`.
Assigned work: `node_execution_f7dfabe0-349b-4279-b6a4-1222f4a30da1`.
Context: `ctx_22947ae0-8293-4288-8779-5199068e9c85`.
Operation journal: `C:/Development/_temp/floe-app-participation-proof.json`.

The app showed this work as Ready. Opening its actions exposed the missing step
entry and raw Port-ID field; both are now corrected. The shared action dialog is
mounted outside the pipeline layout so its form is not obscured by the canvas.

Using the normally onboarded operator, the browser selected **Reviewed result**,
entered the review and confirmed publication against installed 0.1.66. Both the
step and execution became Complete through push updates. Publication
`publication_25e64602-1b2a-45a6-b64f-5a4b42d96273` retained exactly one output Event,
`evt_045c1a32-62db-4264-9e65-861c51f43beb`, under the assigned Actor and authenticated
principal. No worker Endpoint or model Delivery bundle was created.

The browser then read the original request in the preceding step's conversation,
reopened the saved review and posted a note with no requested response. The
composer cleared, and the review stayed Complete. The operator's saved output
now displays **Operator** even without a runtime Endpoint; known participant
names remain unchanged. Evidence: `assigned-input.png`, `review-note.png`,
`output-completed.png` and `participation-result.json` under
`C:/Development/_temp/floe-actor-parity-evidence-20260906/`.

The fixture used `config.label` rather than the canonical Node `label`; therefore
its two cards display Event and Work step. This is a fixture authoring error,
not evidence that saved Node labels are ignored. Its published revision is
preserved rather than edited to improve a screenshot.

## Verification

127 focused checks passed across bus, app and CLI. After the final presentation
correction, all 30 Context conversation checks passed, including one added
regression check (128 distinct focused checks across the changes). Full packaging
runs type checking and isolated sidecar checks. This is not a full-suite claim.

The 0.1.66 installation retained all 1,500 earlier Events, all 36 Actor heads,
runtime bindings, grants, configuration and account files. Integrity passed and
foreign-key checks were empty. Recovery and build evidence are retained in the
same evidence directory.

Final 0.1.67 packaging completed both MSI and NSIS bundles, including type checking
and packaged sidecar checks. The installed executable reports 0.1.67, and the
installed service matches the final build SHA-256:
`a37bb4b565cca3f5825ea1c340253888c37f0a242ddf0a77501396f6d82bec3a`.
Recovery: `C:/Users/jfenech/.floe/recovery/before-0.1.67-20260906-participation`.

Post-install verification retained all **1,502 earlier Events**, all **36 Actor
heads**, runtime bindings, grants, configuration and account files. Integrity
passed, foreign-key checks were empty and schema 13 was unchanged. The actual
review still has one output, one note and no model Delivery bundles. Reports:
`delegation-upgrade-0.1.67.json`, `participation-result.json`,
`build-0.1.67-final.log`, and `install-0.1.67.log` in the evidence directory.
After a browser reload, local access resumed automatically. The organised work
remained Complete, and its conversation displayed the original review and note
as Operator. Screenshot: `review-retained-0.1.67.png`. This uses the source-served
browser frontend against the installed service; it is not native window proof.

## Remaining acceptance boundaries

Native window interaction remains unproved
because available computer tools expose the browser surface only. The broader
18-step journey, model-driven current-envelope proof and canonical approval
request remain separate acceptance gates in `end-state-verification.md`.
