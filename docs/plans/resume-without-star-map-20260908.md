# Direct development resumed — 8 September 2026

The operator requested continuation without Star Map if it remained blocked.
The Floe destination `goal_e51a4bc9-5175-400c-962a-f9edb7722254` still reported
the workspace snapshot limit, with zero tasks. Astra used its Stop destination
control and verified **Stopped** at 01:45:23 UTC. The project command guard then
released access. Star Map is no longer the implementation owner for this work.
Its other destinations were not changed. The complete Floe acceptance scope is
unchanged; no product gate is closed by this recovery.

The original native Codex goal still reports `paused`. Its complete objective is
retained. A subsequent goal continuation was automatically captured by Star Map
as `goal_d3cea8d9-afbd-4d92-aae5-1aab5bed197d`, again blocked before any task by
the workspace snapshot limit. Astra stopped that destination through its control
and verified Stopped at 01:58:01 UTC. Resuming the native goal alone is therefore
insufficient: the installed Star Map hook attaches any active native goal even
after its preceding destination was stopped. No supported per-chat exemption
was found in the installed hook or control command. The operator asked whether
only this chat can be exempted; no global hook settings have been changed.
Direct work can proceed in an active turn while the native goal stays paused.
Automatic multi-turn continuation still needs a supported ownership opt-out.
This is separate from the Floe Builder continuing inside the restored service.

## Restored proving environment

The existing installation is 0.1.80 at `C:/Apps/Floe/`. Initially its local
services were absent and the browser could not connect. Astra launched the
installed desktop; it started the existing service against the real Floe home.
No duplicate substrate or account was created and no upgrade was performed.
The existing compiled browser surface was restarted on loopback port 5379.
This still uses a developer preview process: packaged standalone browser access
remains a product obligation, not a completed installation feature.

Observed process identities: desktop 8348, installed service 49932, browser
preview 12612. These are observations, not durable configuration. Browser logs
are in `C:/Development/_temp/floe-resume-evidence-20260908/`.

The existing installed checks were rerun:

```text
cargo test --manifest-path floe-app/src-tauri/Cargo.toml --lib bus_broker::tests::installed_ -- --ignored --nocapture
```

All three tests passed. Health reported the service and model runtime connected;
conversation reads passed in all eight Workspaces containing conversations;
live connections authenticated and remained open during the bounded test in
all nine Workspaces. Cross-Workspace access remained refused. This exercises
the native broker and live service, not native window interaction.

Actual browser use opened the participation Workspace, switched to the existing
campaign Workspace, loaded its conversation and displayed **Floe is running**.
No pairing or account interaction was needed. The campaign conversation retained
the prior approval, named evidence and completed export messages.

## Interrupted Builder recovery

The original image-service request remains
`evt_09f04e7e-8181-4a71-b26b-7d1fb2440d3e` in Workspace
`workspace_cde8e617-30c2-4638-9072-36df577e52f3`, Context
`ctx_fea089d9-7a55-4c60-8cef-950782790f97`.

Before restart, its Builder Delivery
`del_d6e000a8-1bb6-4608-a9d6-d978a16224e0` was still recorded as active despite
the absent service. On restart it was dead-lettered with the recorded reason
that the runtime stopped reporting activity before its lease expired. The Bus
retained the uncertain outcome instead of blindly replaying the work. Event
`evt_27d62cef-9871-4d07-a946-6066285dd7fb` returned that failure to Floe.

Floe handled it in `del_514ec667-663e-42af-b0e6-3d865f43360a` and explicitly
asked the existing Builder to inspect retained work before continuing. The new
Builder Delivery is `del_3ced1faa-4c67-4fce-bbb2-59e4b320a776`, started at
01:48:28.961 UTC. Astra did not resend the operator request, create a replacement
Builder, edit its package, approve installation, or manufacture completion.

The actual browser showed Floe's recovery explanation, the Builder's progress
and its Stop response control. At 01:53:37 UTC the Builder was still working;
14 responses reported 451,711 tokens. This is incomplete recovery cost, not a
successful-outcome efficiency comparison. The original interrupted Builder
reported 196,056 tokens and the original coordinating turn 1,168,170.

The read-only preservation check passed at 01:46:48 and again at 01:50:49 UTC:
all 14 earlier campaign files, three retained versions, earlier Scope executions,
approval requests and approval uses match the pre-attempt baseline. Evidence and
read-only observers remain under
`C:/Development/_temp/floe-image-service-extension-evidence-20260907/`.

Update at 02:14 UTC: the recovery and evidence handoff have settled. The browser
shows named saved evidence controls, and Package verification opens its exact
saved content. The read-only campaign preservation check still passes. However,
an independent check of the exact package archive through Floe's QuickJS realm
refuses its imports. The Builder's external Node tests do not establish Floe
host compatibility. See [F83 evidence](extension-host-attempt-20260908.md).

Its authored source is under the campaign Workspace's independent
`packages/floe-picsum-image-acquisition/` package. Source preparation is not
Extension registration, host compatibility, approved installation or successful
invocation. Compare the result with accepted ADR-0002, ADR-0006 and the running
contracts; retain and correct any proven obstacle at the appropriate layer.

The full gates and 18-step journey in `end-state-verification.md` remain pending.
