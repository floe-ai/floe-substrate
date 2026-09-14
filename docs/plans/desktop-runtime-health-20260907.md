# Desktop reconnecting status — 7 September 2026

**F77 — the desktop reports a failed health read as a lost connection.** The
operator reported that every desktop Workspace always says “Reconnecting”. The
browser appeared healthy. Earlier desktop conversation checks proved saved
message reads, not the desktop's live connection or health label.

## Diagnosis

The smallest need is an accurate indication that local services and the model
runtime are available. This is a client projection, not a new substrate
mechanism or a reason to weaken Workspace authority.

The actual native relay authenticated and stayed open for three seconds in each
of all nine installed Workspaces. Its health follow-up failed before making a
network request: `getRuntimeStatus` forwarded `/v1/runtime/status` through a
Workspace session, while this fixed installation projection requires host
authority. The broker correctly refused that route. `App.tsx` interpreted the
failure as “Floe is reconnecting”. The browser used its existing session
projection and did not take the broken desktop path.

## Correction

The desktop now invokes one fixed native health method with no path, body or
Workspace supplied by the webview. The native authority broker reads the existing
health projection using installation authority. Neither generic Workspace
requests nor generic host requests gain additional routes. The browser path and
push-only connection behaviour remain unchanged.

## Verification

- The original desktop health request failed with the reproduced route refusal.
- The fixed desktop health read reports the local service and model runtime
  connected. Both generic transport refusal checks still pass.
- The actual desktop live relay opened and stayed connected in all nine installed
  Workspaces. This bounded check does not establish long-duration stability.
- Client, transport and stream checks: 42 passed, two pre-existing TODOs.
- Desktop broker checks: nine passed; native authority checks: five passed.

## Installed result

Floe 0.1.74 is installed and restarted from `C:/Apps/Floe/`. The desktop matches
the build except for the expected Tauri NSIS marker; the authority broker and
service match exactly. The installed service SHA-256 is
`b31b61c0bf3afd3221401cecfd552711199a615d70b86a14614caddf32a84011`.

All three installed acceptance checks pass: health reports the model runtime
online; saved conversations load in all eight Workspaces that contain them,
including cross-Workspace refusal checks; live connections authenticate and stay
open in all nine Workspaces. The browser recovered automatically after restart,
retained the open conversation and shows “Floe is running”.

Recovery: `C:/Users/jfenech/.floe/recovery/before-0.1.74-20260907-review-decision`.
The upgrade preserves all 1,574 earlier Events, 36 Actors, eight previous review
runs, original grants, runtime bindings, configuration and account files. Schema
13, integrity and foreign-key checks pass. The bundled review-decision change
adds only the export grant to eight eligible default Floe definitions; other
instructions and settings remain unchanged. The first retention verifier hit a
JavaScript object-prototype comparison mismatch; comparing the actual record
values resolved that verifier error without changing stored state.

Native window interaction has not been automated; these checks exercise the same
desktop broker and Channel used by the webview against the real service. The
review-decision attempt remains pending and the full product goal remains open.

Evidence: `C:/Development/_temp/floe-review-decision-evidence-20260907/`, including
`desktop-stream-before.log`, `desktop-health-before.log`,
`desktop-health-host-refusal.log`, `desktop-health-fixed.log`,
`desktop-client-tests.log`, `desktop-broker-tests.log` and
`native-authority-tests.log`. Installed proof is in `desktop-post-install.log`,
`installation-verification.json`, `export-upgrade-verification.json`,
`browser-after-install.txt` and `browser-running.png`.
