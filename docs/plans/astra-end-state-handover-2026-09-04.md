# Floe end-state implementation handover

Date: 2026-09-04  
Branch: `codex/floe-end-state`  
HEAD: `fba0075 docs: define canonical Floe end state`

## Status

This is a coherent implementation checkpoint for transfer to one owner. It is
not completion of the Floe end state, a release candidate, or proof of the
operator experience.

The active goal remains the complete operator-approved Floe end state. Its live
acceptance index is [end-state-verification.md](./end-state-verification.md).
Every gate in that file remains `Pending` until its stated current,
reproducible proof exists:

- P1-P5: product and organisation;
- C1-C10: composition and execution;
- A1-A8: Artefacts and Contexts;
- I1-I8: integrations, security, and evolution;
- R1-R12: reliability, portability, and trust;
- the complete 18-step campaign-site journey through normal operator surfaces.

Focused tests below establish foundations only. They do not close those gates.
The next operator-proof sequence is recorded separately in
[astra-operator-proof.md](./astra-operator-proof.md); it also does not narrow
the end-state goal.

## Completed foundations at this checkpoint

### F1 - Canonical operation governance

- One semantic operation registry carries validation, authority, refusal,
  approval, budget, execution, and audit metadata for clients and runtimes.
- Policy, Approval, Budget, Audit, authority session, target, and provenance
  foundations are present.
- Exact causal Event and stable Delivery provenance are retained where required.
- Restore holds prevent effectful resume until target-host dependencies are
  explicitly reconciled.
- `outcome_unknown` represents an external effect that cannot safely be
  classified or replayed.
- Remaining boundary: raw legacy mutation routes have not all been cut over to
  the canonical operation path.

### F2 - Canonical Command execution

- Stable Command identity and immutable `CommandDefinitionRevision` are
  distinct from the authenticated worker `Endpoint`.
- Each `NodeExecution` and `ExecutionAttempt` pins exact Command and worker
  revisions; retry retains the original pins after head change or retirement.
- Inputs and outputs are validated against named Ports and outputs traverse
  stored Edges.
- Attempts persist processing contracts, results, errors, resource use, and
  evidence.
- Cancellation, timeout, bounded restart recovery, and idempotency are covered.
- Interrupted external effects become `outcome_unknown` and are not replayed
  automatically.
- Legacy Bridge shell execution was removed. Legacy graph Commands remain
  readable evidence but receive an explicit non-executable refusal.
- Critical package gap: the Store resolves an adjacent
  `isolated-command-host-process.js`, while the desktop package currently emits
  only `floe-desktop.js`. Real packaged Command execution is therefore not
  proven and is expected to fail until the child process is packaged.

Primary files:

- `floe-bus/src/command-definitions.ts`
- `floe-bus/src/command-operations.ts`
- `floe-bus/src/command-runtime.ts`
- `floe-bus/src/isolated-command-host*.ts`
- `floe-bus/src/canonical-command-execution.test.ts`
- `floe-bus/src/store.ts`
- `floe-bus/src/scope-executions.ts`
- `floe-bus/src/scope-operations.ts`
- `floe-bridge/src/daemon.ts`
- deleted `floe-bridge/src/command-runner.ts`
- `docs/guide/concepts/command.md`

### F3 - Portable Workspace archive and restore authority

- A deterministic, versioned directory bundle preserves canonical IDs,
  revisions, provenance, history, lineage, waits, and evidence.
- Export has schema validation, preflight, collision detection, idempotency,
  content-addressed payloads, and transactional database/content rollback.
- Source absolute paths and secrets are excluded.
- Restore stays held until exact target-host dependencies are revalidated.
- Secrets, runtime bindings, workers, and connector bindings do not silently
  travel with the bundle.
- Portable definitions include Commands, revisions, and contracts;
  `command_worker_bindings` remain host-owned.
- Required reconciliation operations are allowlisted narrowly:
  `credential.bind`, `actor.runtime-binding.replace`,
  `connector.health.record`, `extension.enable`,
  `workspace.package.reconcile_restore`, and
  `workspace.package.release_restore_hold`.
- Supplying content and attaching Endpoint/Command workers remain explicit host
  operations.

Primary files are the `workspace-portability*`, Workspace operation, credential,
runtime-profile, connector, and extension operation modules under
`floe-bus/src/`, with operator documentation in
`docs/guide/setup/workspace-transfer.md`.

### F4 - Canonical conversation attachments

The previous app path wrote a file under `.floe/state/attachments`, then sent a
UI-authored path in public Event content. A failed message could leave an
orphaned file and the path was treated as identity.

The replacement path is:

1. The native broker requests a one-use ingress bound to the exact principal,
   Workspace, and Context.
2. It uploads the selected bytes directly to that ingress.
3. `context.communication.emit` consumes only the ingress IDs.
4. The Bus content-addresses the exact bytes under
   `.floe/content/sha256/<sha256>`.
5. The Bus creates one canonical Artefact and immutable ArtefactVersion per
   file, associates exact versions with the Context and Event, and returns the
   exact references in the operation receipt.
6. Public Event content contains only the exact ArtefactVersion reference,
   display name, media type, and byte count. It contains no source path.
7. The conversation renders an image from the canonical ArtefactVersion
   content. Legacy path parsing remains read-only for existing history.

The ingress is memory-only, bearer-protected, size/count bounded, one-use,
revocable, and retry-safe when its exact commit callback fails. A canonical
operation idempotency replay returns the original Event and ArtefactVersion
references without consuming a second upload.

Primary files:

- `floe-bus/src/attachment-ingress.ts`
- `floe-bus/src/attachment-ingress.test.ts`
- `floe-bus/src/context-operations.ts`
- `floe-bus/src/context-operation-backend.ts`
- `floe-bus/src/context-operation-server.test.ts`
- `floe-bus/src/store.ts`
- `floe-bus/src/server.ts`
- `floe-native-authority/`
- `floe-app/src-tauri/src/bus_broker.rs`
- `floe-app/src-tauri/src/fs_commands.rs`
- `floe-app/src-tauri/src/lib.rs`
- `floe-app/src/fs/conversationAttachments.ts`
- `floe-app/src/features/conversations/contextCommunication.ts`
- `floe-app/src/features/conversations/OperatorConversations.tsx`
- `floe-app/src/scope/ContextConversation.tsx`
- `.gitignore`
- `docs/adr/0005-file-access-patterns.md`
- `docs/guide/app/conversations.md`

A7 remains pending because crash/fault injection and a packaged operator run
have not yet proven the complete boundary.

### F5 - Instruction and product reorientation already present in the checkout

During transfer, the incoming owner aligned `MISSION.md`, `PRODUCT.md`,
`docs/floe-instruction-layering.md`, `.floe/agents/floe.md`,
`.floe/skills/substrate-build/SKILL.md`, and Bridge prompt files with the
operator-facing end state. These edits share this uncommitted checkout and must
be preserved and reviewed as part of the same active goal.

## Verification completed

| Area | Command or proof | Result |
|---|---|---|
| Bus build | `npm run build --workspace floe-bus` | Passed |
| Bus full suite | full Bus Vitest run | 111 files; 808 passed; 1 existing skip |
| Bus documentation | focused docs tests | 9 passed |
| Governance and portability | focused suites | 110 passed |
| Canonical Command | focused proof | 7 passed |
| Command Bus regressions | focused suites | 50 passed |
| Bridge build | `npm run build --workspace floe-bridge` | Passed |
| Bridge full suite | full Bridge Vitest run | 23 files; 378 passed |
| Bridge daemon/no-shell boundary | focused suites | 25 passed |
| App build | `npm run build --workspace floe-app` | Passed |
| App full suite | `npm test --workspace floe-app` | 36 files; 188 passed; 2 existing TODOs |
| Tauri native layer | `cargo test --manifest-path floe-app/src-tauri/Cargo.toml` | 27 passed; doc tests passed |
| Native authority | `cargo test --manifest-path floe-native-authority/Cargo.toml` | 4 passed |
| Patch hygiene | `git diff --check` | Passed; CRLF conversion warnings only |

Two stale app-test expectations found by the full run were corrected before the
final green run: URL form encoding expects `+`, and the settings copy names the
current ADR-0012 boundary.

## Known gaps before end-state completion

- G1: migrate remaining raw legacy mutation routes to the canonical operation
  registry; prove app, actor, CLI, API, SDK, and MCP semantic parity.
- G2: complete Actor activation/addressability and lifecycle proof across human,
  model, service, and team backing.
- G3: complete Scope identity, draft/published revision lifecycle, publication
  validation, simulation, diff, rollback, clone/template/reuse, and live
  composition migration.
- G4: finish Workspace lifecycle and portable two-host restore proof, including
  content supply, binding reconciliation, resumable waits, and no duplicated
  external effects.
- G5: finish Runtime Profile/provider/model selection cutover with visible
  unresolved bindings and no fallback.
- G6: close the packaged isolated Command child-process gap and run real
  packaged Command fault tests.
- G7: prove backpressure, bounded concurrency, priority, rate/circuit policy,
  retry, stop, restart, callback, join, and uncertain-effect behavior.
- G8: complete the Connector matrix, external action receipts, and deterministic
  deduplication/health behavior.
- G9: complete canonical Artefact type coverage, lineage/branch/gather behavior,
  lifecycle retention/redaction/destruction, and product projections.
- G10: prove credential redaction, grant rotation/revocation, tenant isolation,
  Extension permission isolation, self-extension, rollback, and an
  Extension-provided product surface without a second state store.
- G11: complete resumable push/cursor catch-up, headless/shared semantics,
  browser/mobile intervention, and runtime replacement.
- G12: run the clean install, upgrade, rollback, uninstall/reinstall, backup
  restore, and full 18-step operator journey through normal product surfaces.

No current test or implementation result should be used to mark any gate in
`end-state-verification.md` complete without the exact evidence requested there.

## Live and repository state

- The installed service was not rebuilt, restarted, stopped, or replaced.
- Port 5377 is listening on PID 42248:
  `C:\Apps\Floe\floe-node.exe`, started 2026-09-03 18:58:32 local time.
- Port 5379 is not listening.
- `C:\Users\jfenech\.floe\bus\floe-bus.sqlite` was not opened or modified by
  this implementation checkpoint.
- No installer was built or installed.
- Tests used isolated temporary Workspaces and cleaned them up.
- No implementation commit exists. The working tree intentionally contains the
  combined end-state work from multiple agents: 133 tracked files differ from
  HEAD (16,517 insertions and 9,912 deletions) plus many untracked new modules.
- The only branch commits remain `7144b48` and the canonical-doc commit
  `fba0075`.

## Agent checkpoint

- `portable_workspace_archive`: completed; no live service, user database, or
  commit changed.
- `operation_governance_control`: completed; no blocker reported; raw legacy
  route migration remains.
- `canonical_command_execution`: completed; packaged child-process gap recorded
  above; no live service, user database, or commit changed.
- `command_final_review`: interrupted only after its parent had incorporated the
  review and completed the checkpoint; it is not an active writer.

The shared checkout is ready for one implementation owner. All previous writers
are stopped or completed. The next owner should preserve the working tree,
review this checkpoint, and continue from the operator-proof milestone without
claiming the full goal complete.
