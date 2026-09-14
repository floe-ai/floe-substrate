# Desktop conversation loading — 2026-09-06

Status: failure reproduced and corrected; 0.1.68 built, installed and running.

## Observed failure and cause

The operator reported that conversations failed in every desktop Workspace.
The browser could list and open the same saved conversation. This difference
was missed by the earlier browser-only participation checks.

**F66:** the shared native broker admitted only paths starting with
`/v1/workspaces/{selected-workspace}/`. The desktop conversation client also
uses the existing `/v1/contexts`, `/v1/events`, `/v1/delivery` and
`/v1/runtime/telemetry` projections. Those valid reads were rejected before
reaching the Bus. The failing regression check captures the exact conversation
list request in `reproduction.log`.

This is a client transport correction. No substrate primitive, new data store
or conversation migration is needed.

## Correction

The native broker accepts the existing conversation projections for GET requests
under the selected Workspace session. Collection reads must carry that Workspace
in their query. Conflicting Workspace parameters, path traversal, host routes,
worker claims and mutations through these read paths remain refused. The Bus
still checks every referenced Context against the authenticated Workspace.

The CLI command interface remains typed; no arbitrary request command was added.
Conversation records, participant bindings and permissions are unchanged.

## Evidence

Evidence directory: `C:/Development/_temp/floe-conversation-load-evidence-20260906/`.

- Native broker regression and boundary checks: 6 passed.
- Desktop broker checks: 10 passed, including an explicit live acceptance check
  through the same `DesktopBusBroker.request` method used by the webview.
- App conversation and transport checks: 63 passed.
- Bus transport boundary checks: 14 passed.

The live desktop check listed and read saved conversations, message history,
delivery state and telemetry in all **8 Workspaces with retained conversations**.
It used the installed service and normal OS-vault authority, without copying
credentials or logging message contents. Wrong-Workspace authentication returned
401; conflicting Workspace and Context evidence returned 403.

The repeatable desktop check is deliberately ignored in routine test runs:

```powershell
cargo test --manifest-path floe-app/src-tauri/Cargo.toml --lib bus_broker::tests::installed_conversation_reads_cross_the_desktop_broker -- --ignored --nocapture
```

This is real desktop transport proof, not a claim of native window automation.

## Installed verification

MSI and NSIS packaging completed, including type checking and packaged sidecar
checks. The installed executable reports **0.1.68**. Its bytes match the final
build except for Tauri's documented NSIS bundle marker (`UNK` becomes `NSS`).
The initial raw executable hash check flagged that expected difference;
`installation-verification.json` and `verify-installed-executable.mjs` prove
that every other byte matches. The authority broker and service match exactly.

Installed desktop SHA-256:
`972c0243d235082cd9781fca99c982f6d887afa99427ac0dd0ef080d63cfb186`.
Installed service SHA-256:
`60bb225dc67dc40ffe5448abc2e1d9a490de99f15bb32c7190049635e16c5624`.

Recovery: `C:/Users/jfenech/.floe/recovery/before-0.1.68-20260906-conversation-load`.
All **1,502 earlier Events**, all **36 Actor heads**, existing runtime bindings,
grants, account files and configuration survived. Integrity passed, foreign-key
checks were empty, and schema 13 remained unchanged. The app and its installed
service were restarted. Preservation report: `delegation-upgrade-0.1.68.json`.

After installation, the same desktop request check passed again in all eight
Workspaces with retained conversations, including both cross-Workspace refusal
cases. Log: `desktop-post-install-reads.log`. The browser also reconnected and
displayed its retained conversation list.

## Current installed regression check — 0.1.73

On 7 September the same desktop broker check passed again against installed
0.1.73 in all eight Workspaces with saved conversations. It retrieved conversation
lists, message history, delivery state and telemetry, and refused both
cross-Workspace cases. The actual browser also opened the latest conversation
and its named Gallery, Test report and Build report attachments.

The 0.1.73 upgrade preserves 1,562 earlier Events, Actor heads, runtime bindings,
grants, configuration and account files. Evidence and the broader proving limits
are in [history and return verification](history-and-plan-validation-20260907.md).

## Desktop reconnecting report — 0.1.74

The later persistent “Reconnecting” report exposed a separate health-read error
(F77); it was not covered by the earlier saved-message tests. Installed 0.1.74
now passes both the health read and live-stream checks in addition to all eight
retained conversation Workspaces. Evidence and the native-window testing limit
are recorded in [desktop health proof](desktop-runtime-health-20260907.md).
