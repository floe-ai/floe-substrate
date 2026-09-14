# Pipeline visual revision — 2026-09-06

Status: visual restoration built and installed in 0.1.65, with browser presentation checks and 48 focused tests passing. The selected-branch conversation and normal operator output gaps were subsequently closed in the [app participation revision](actor-participation-revision-20260906.md). P6 remains partial until installed native visual confirmation.

## Delivered presentation

The current app uses the approved prototype's dotted dark canvas, colour hierarchy, card proportions, actor chips, compact inputs, image output tiles, progressive focus and individual curved branch connections. Outputs filter downstream work only through exact saved publication, Delivery and input-version records. Planned work remains explicitly planned.

Image previews resolve immutable versions and retain their Blob URLs only for the mounted work view. Reads run with four concurrent preview requests; there are no model calls or polling for rendering. Actor labels resolve the retained ActorDefinitionRevision once per mounted view. Content-store digests are not shown as filenames; named Ports provide labels when the saved version has no meaningful filename.

The pipeline stays mounted while its selected run receives an update or a conversation opens. Exact output inspection has a separate panel, so opening it does not scroll the underlying pipeline. Scope execution history and individual step execution history remain reachable. Branches are progressively revealed in groups of twelve. On narrow screens the layout stacks; below 640px the selected work uses the sidebar's space and retains its Workspace return control.

## Actual attempt

Workspace: `workspace:924d51e349c3852a` — **Pipeline view test**.

Scope: `scope_pipeline_visual_20260906` — **Courtyard image review — visual proof**.

Completed execution: `execution_a40dae87-a5f6-4d22-abad-bd4b4e745e3c`, pinned plan `revision_839750ac-c76d-47f9-9444-e754414e3f77`.

This is a controlled visual test: an authenticated local test actor published retained courtyard reference images through native semantic operations. Eleven NodeExecutions completed and ten Edge traversals were retained, including nine independently selected image branches. It is **not** evidence of autonomous model generation, automatic human onboarding or the full acceptance campaign. No model turns were requested for this test.

The earlier test execution `execution_dfcf8d3f-6414-40d5-9dc5-93b97517c62b` was stopped after the observed operator identity mismatch. Its history remains intact. The pre-existing Concept reference pipeline remains a plan-only comparison.

Operation journal: `C:/Development/_temp/floe-pipeline-visual-proof.json`.

Browser evidence directory: `C:/Development/_temp/floe-pipeline-visual-evidence-20260906/`.

Final browser screenshot after reconnecting to the upgraded service: `floe-0.1.65-browser.png`. All nine retained image branches were visible again after installation. The source-served browser and installed native executable are distinct verification surfaces.

## Evidence and limits

| Check | Evidence |
|---|---|
| V1–V2 appearance and cards | Source, focused work and image branches exercised in the actual source-served app against the installed service. Saved screenshots include `source-1393.png`, `branches-wide.png` and `selected-child-1393.png`. Names use saved step/Port records; actor labels use retained definitions. |
| V3 exact branches | Selecting the wall-panel output reduced nine downstream branches to the one matching its recorded Delivery and exact input version. Opening the output displayed the retained wall-panel image, `artefact_version_1fabaf0f-24d1-406b-a6cd-428e98b03baa`. |
| V4 focus and history | Followed source → review → wall-panel work, returned through breadcrumbs, and retained the completed and stopped Scope executions in the history selector. Behaviour tests reject untraversed branches and prevent repeated breadcrumbs. |
| V5 inspection/conversation | Opened the exact image and selected wall-panel Context. The view stays mounted while panels open/close and during a pushed refresh. A real note submission remains refused by the address-linking gap below. |
| V6 responsive | The documented browser viewport override did not change the existing tab. A temporary same-origin frame therefore loaded the same app at widths 900 and 390. At 900 the content width was 660 and the pipeline stacked. At 390 the sidebar initially consumed 240px; the corrected work view uses the full width. `app-390-before.png`, `app-390-after.png`, `phone-source-full.png` and `phone-focus.png` record the check. This is browser width testing, not native/mobile device proof. |
| V7 real records | All live previews, statuses and connections above come from canonical operations. The original prototype's proposed Contexts were not inserted as execution evidence. |
| Automated checks | 48 tests in five relevant files passed. App type checking passed before the final CSS-only correction. Full final packaging also includes type checking. |

The original self-contained reference remains unchanged. Its different number of current outputs and different example images naturally change card height. The application retains its Workspace header and run controls. These differences are explicit; there is no claim of a pixel-identical screenshot or installed native UI proof. The same-origin sizing frame was a temporary test page, not a second Floe service; it was closed and removed after testing.

## Installed verification

Both MSI and NSIS bundles completed successfully in the final build, including type checking. Installed executable: `C:/Apps/Floe/floe-console.exe`, file version **0.1.65**. Installed service SHA-256: `49f1fe579b10149b632975b886b330b8fdba4afe7639c817ac90095078e9741c`; it matches the final built service. The installed service returned a healthy response on port 5377.

Recovery: `C:/Users/jfenech/.floe/recovery/before-0.1.65-20260906-final`.

Post-install verification retained all **1,498 pre-upgrade Events**, all **34 Actor heads**, all runtime bindings and grants. Configuration and account files are byte-identical. SQLite integrity passed with no foreign-key errors, and the schema remains 13. Reports and build/test logs are in the browser evidence directory above. This proves installation and retained state, not native visual interaction.

## Observed actor parity gaps

These are the original observations from 0.1.65. The subsequent
[app participation revision](actor-participation-revision-20260906.md) supersedes
their unresolved status: normal onboarding, authorised output and Context notes
now pass in the browser against the installed service. Direct addressing and
background notification to an unattached Actor are separate, unproved boundaries.

- **F64 — Local identity and the saved Operator actor do not line up for this attempt.** The test workspace's Operator actor initially had no current runtime binding. After publishing a human-backed profile and binding it, the run started, but publishing its output as the authenticated local principal was refused with `e_scope_output_authority`. The controlled visual run used a separately declared test actor whose identity matched that authenticated principal. This configuration is test evidence, not the solution to automatic human participation.
- **F65 — Work conversation assumes a model and requires an addressable Endpoint.** Opening the test actor's Context originally disabled the composer and asked for a provider/model. Work conversations now use the ordinary Context communication operation without that model setup gate; the Floe front door keeps its existing setup behaviour. An attempted note was still refused because the selected canonical participant had no addressable Endpoint. The note was not sent; its draft was cleared. Actor addressing and automatic identity linkage must be closed before claiming human/agent parity.

## Next success criteria

1. P6: confirm the installed native presentation against the preserved reference. The selected-branch conversation attempt now passes.
2. F64/F65: normal operator setup, assigned-work output and Context notes now pass. Prove background attention and direct communication separately before claiming complete actor participation parity.
3. Continue the full 18-step acceptance journey in `end-state-verification.md`; this visual revision does not complete it.
