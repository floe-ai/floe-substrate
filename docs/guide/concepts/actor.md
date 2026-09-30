# Actor

**An Actor is an entity permitted to perceive, decide, communicate, and act within declared responsibility and authority.**

A person, local model, hosted model, deterministic service, or future runtime
backing does not change Actor identity or Scope semantics. The substrate does
not encode a human/agent type distinction.

## Identity, definition, and runtime stay separate

An Actor has stable identity. Its charter, responsibilities, knowledge, budgets,
trust policy, instructions, capability grants, and escalation rules belong to
an immutable ActorDefinitionRevision. A draft may change; publication freezes
the revision.

Runtime embodiment is a separately replaceable binding to a RuntimeProfile. An
ExecutionAttempt records the exact ActorDefinitionRevision and runtime binding
it used, so later edits do not rewrite history.

### Setting up an Actor in one step

`actor.setup` creates an Actor, binds it to a runtime, gives it any further
access (`grants`, each a subset of one of the caller's grants, as in
`capability.grant.delegate`) and publishes it, all or nothing. If any part is
refused, nothing is created and nothing is announced; the refusal is
`actor_setup_refused`, naming the part (`step`: `create`, `bind_runtime`,
`delegate_access` or `publish`) and the part's own refusal (`cause_code`).
Publishing is the last part, so the Actor can receive work the moment the call
completes. It needs no permission of its own: the caller must hold
`actor.create`, `actor.runtime-binding.create` and `actor.definition.publish`,
plus `capability.grant.delegate` when giving grants. The individual operations
remain for changing one part of an existing Actor.

## Placement and participation

A NodePlacement may reference an Actor and add placement-specific instructions
or policy for one ScopeCompositionRevision. A Context participant relationship
may give the Actor a role and access in one Context. Neither relationship makes
the Actor owned by the Scope or Context, and neither creates an Edge.

Placement instructions use the discovered `bindings` array with
`{ "kind": "instructions", "text": "..." }`. The runtime appends these ordered
bindings to the pinned Actor definition's instructions. `config.instructions`
is configuration data and is not injected. Discovery describes the binding
fields and invocation rejects malformed bindings before storing a draft.

Capability refusals include the canonical recovery evidence in the model's
tool result: the refusal code, whether a retry is appropriate, the required
action, relevant details and receipt identity when one exists. The Actor can
use the returned current revision instead of guessing after a conflict.
Successful results also expose exact target and changed references, plus
progress, cancellation and audit references when present. Use a changed
resource's returned revision for the next operation; do not construct it from
individual result fields.

For a saved Scope result, `scope.execution.inspect` accepts
`include_outputs: true`. This returns the published Event content and exact attached
ArtefactVersion IDs alongside each publication reference. Ordinary Context
messages are excluded. A missing or mismatched Event stays unavailable; the
inspection does not substitute another result. Leave this option off when only
execution status is needed.

## Model image inspection

The Bridge's `read_image` tool supplies a preview at most 1,536 pixels on either
side, without enlarging or changing the source. It supports PNG, JPEG, GIF and
WebP sources up to 20 MiB and 64 megapixels, applies image orientation, and shows
the first frame of an animation. The result identifies the source by its SHA-256
and dimensions, alongside the preview dimensions. Unsupported, oversized or
corrupt input returns a recoverable tool result instead of forwarding those
bytes to the model. This is a runtime input bound, not an Artefact transformation.

## Engine built-in tools

An engine's own tools (reading files, running a shell, fetching a URL) are
governed by Floe, not by the engine. Authority is named by canonical
operations, never by the engine's native tool names:

| Operation | Copilot tools |
|---|---|
| `engine.tool.filesystem.read` | `view`, `grep` (Codex models: `rg`), `glob` |
| `engine.tool.filesystem.write` | `create`, `edit` (Codex models: `apply_patch`) |
| `engine.tool.process.execute` | `powershell`, `read_powershell`, `stop_powershell`, `list_powershell` |
| `engine.tool.network.fetch` | `web_fetch` |

Every exposed Copilot tool passes through Floe before it runs. Floe reads the
complete call: the files a file tool names, the URL a fetch names, and the full
PowerShell command text. From a command it takes one command name per pipeline
segment, whether output is redirected to a file, and any literal URLs. Anything
it cannot name with certainty (a variable, a subexpression, a script block, an
escape) is counted as unclassified, never guessed.

Every Actor may use every engine tool by default, without prompts. File tools
(view, grep, glob, create, edit, apply_patch) stay inside the Workspace's
folders; see [Workspace folders and System access](#workspace-folders-and-system-access).
**Shell commands are not confined**: a command can read, change or delete any
file the signed-in user can, inside or outside the Workspace's folders. Other
restrictions are opt-in: a person chooses them for an Actor or a Workspace.
Each call is decided before it runs, and checked against the Workspace's
folders and the limits that were chosen:

1. the Actor's live grants for that operation. An Actor is offered only the
   built-in tools its grants cover. A grant with no targets is unrestricted;
   targets narrow it to folders (`filesystem_path`), commands (`executable`)
   or fetch domains (`network_domain`);
2. its definition's `scope.paths`, if set: every path a file tool touches must
   resolve, after symlinks, inside those folders. Scope paths are relative to
   the Workspace's own folder, so a scope never reaches an added folder;
3. the Approval Policy revision its definition pins, if any, and policies bound
   to the Workspace. These can refuse a call or require a person's decision
   (`require_approval`), but never widen authority.

Where a limit was chosen and the engine's evidence cannot show that a call
keeps to it, the call is refused with a reason. It is never turned into a
prompt. Every call is recorded as a decision, allowed or not.

A refused call returns structured data to the model: `code`
(`tool_policy_denied` or `tool_policy_cancelled`), `tool_call_id`,
`operation_id`, `rule_id` and `reason`. A call that a chosen rule sends to a
person waits for a pushed answer, bounded by the turn's authority and
cancellation. One approval covers one exact call; changed arguments need a new
decision.

### Workspace folders and System access

A Workspace has one or more folders. Its own folder, where `.floe` lives, is
always one of them and cannot be removed. A person may add other folders on
the same machine, by full path. File tools may use any path that resolves,
after symlinks, inside one of those folders. A path outside them is refused
with `tool_path_outside_workspace`, and the reason says to add the folder or
turn on System access. A file tool whose path cannot be resolved, or which
names no path, is refused, because it cannot be shown to stay inside.

**System access** is a Workspace setting, off by default. When on, file tools
may reach any path on the machine, and an engine's request to run outside its
own sandbox may be allowed. When off, such a request is always refused
(`tool_sandbox_bypass`).

These operations change and show the setting. The three that change it are
interactive only, so an Actor cannot widen its own boundary:

| Operation | What it does |
|---|---|
| `workspace.access.inspect` | Lists the folders, whether System access is on, and recent changes and notices, each marked `seen` or not by you. |
| `workspace.folder.add` | Adds a folder by full path. Refuses a relative path, a missing folder, a file, or a folder already inside the Workspace's folders. |
| `workspace.folder.remove` | Removes an added folder. The Workspace's own folder stays. |
| `workspace.system_access.set` | Turns System access on or off. |
| `workspace.notice.acknowledge` | Marks one change or notice (`record_id`) as seen by you. |

Every change is recorded with who made it and is pushed as
`workspace_access_changed`. A Workspace connection also receives the current
folders and setting, as `workspace_access`, with `caught_up`. A change that
removes what a waiting approval needed ends that wait, and the call is refused
with a reason.

Seen is recorded per person in Floe, not in a surface, so every surface a
person uses agrees. Each record lists `seen_by`, the people who have seen it as
it now reads. A notice that changes, such as a lapse date moving, shows as new
again. Marking a notice seen, and Floe recording, changing or removing a notice
by itself, are pushed as `workspace_access_changed` too.

Folders and System access belong to this machine. Copying or forking a
Workspace on the same machine keeps both exactly, and the copy records an
`access_carried` notice saying what came across. A
[portable package](../setup/workspace-transfer.md) carries neither, because it
may be handed to someone else: the restored Workspace has only its own folder
and System access off, and records an `access_left_behind` notice naming the
folders (by name, never by path) and saying whether System access was on.

**Commands are not confined by any of this.** Floe decides which commands an
Actor may run, not which files they touch. The engine's own sandbox does not
confine them on Windows. An Actor that must not reach outside its folders
needs a `scope.paths` limit, which refuses every shell call.

### Default tool access

The default Floe Actor of a new local Workspace holds all four engine tool
operations with no targets and no folder limit. `actor.create` (and
`actor.setup`) gives a new
Actor every engine tool its creator holds, as delegated copies with the
creator's targets. The creator may narrow this with `engine_tool_operation_ids`
(`[]` for none) but never widen it: asking for a tool the creator does not hold
refuses the whole create with `actor_tool_access_widened`. The result's
`tool_access` lists what was given and anything the creator could not pass on.
A delegated copy stops working as soon as the grant it came from is revoked. A
grant may be **delegation-only**: its holder cannot use it, but can delegate a
subset of it to another Actor.

`actor.inspect` shows an Actor's current access in `access`, read-only. It
lists the grants of its current definition, each with its operations, targets
and boundary: `active_grants` (usable), `delegable_grants` (delegation-only)
and `unavailable_grants` (expired, revoked or not issued to this Actor, with
a reason code). `engine_tool_operation_ids` names the engine tools the Actor can
use now. An Actor with no published definition shows none. A folder or System
access rule set on the Workspace applies on top of these grants; read it with
`workspace.access.inspect`.

When access behind a call that is waiting for a person is revoked, the wait
ends: the call is refused with the reason "The access this request depended on
was revoked." and the Actor receives that refusal.

The default Floe Actor of a Workspace made by an older Floe may have no tool
access. When the Bus starts, it gives that Actor the same default access,
unless a person already chose its tool access: any live grant for an engine
tool, even a narrow one, is left as it is. Floe does not widen access silently,
so the Workspace records a one-time notice, shown in
`workspace.access.inspect` as a `tool_access_given` record: "Floe Actors in
this workspace can now use tools inside its folders."

Early Floe templates wrote `scope.paths: [./]` into `.floe/agents/floe.md`.
When a Bridge attaches a Workspace, it removes that scope only if the file's
whole settings block is exactly what a Floe template wrote, so nothing in it
was changed by a person. The normal re-import then makes the Actor
unrestricted. Any other scope is kept. A `./` scope in a settings block that
differs from every template is also kept, and the Bridge logs a warning naming
the file. An Actor changed outside its import keeps its current state, because
the import refuses to overwrite it.

Limits:

- The Copilot tool set is proven for Copilot CLI 1.0.83 on Windows only. On
  another platform no built-in tool is offered. If the engine's tool
  catalogue differs from the proven one, the session does not start.
- A command names what it runs, not every file it may touch. So a folder limit
  refuses every shell call. A command allowlist refuses any segment Floe could
  not name, and any call that only reads or stops an earlier shell.
- A URL built at run time inside a command is not seen, so a fetch-domain limit
  on shell is checked against literal URLs only. Use a command allowlist to
  keep shell off the network.
- Records keep paths, command names, domains and a digest of the arguments.
  Command text and file contents are never stored.
- A path outside the Workspace's folders is counted, never recorded by name.
- The Copilot engine today refuses every request to run outside its sandbox
  before Floe sees it, so the System access rule for such requests cannot yet
  take effect with Copilot.
- Floe controls side effects, not what the engine's own hidden instructions
  tell the model.

## Legacy definition files

`.floe/agents/<id>.md` remains a portable definition source used by the current
Bridge and migration tooling. It must import or project into canonical Actor and
ActorDefinitionRevision records; the file path and frontmatter are not the
Actor's universal identity.

## Implementation

- `floe-bus/src/actor-definitions.ts` — canonical Actor identity and immutable
  definitions
- `floe-bus/src/actor-definition-operations.ts` — shared Actor lifecycle and
  definition operations
- `floe-bus/src/runtime-profiles.ts` — runtime profiles and Actor bindings
- `floe-bridge/src/project.ts` — legacy `.floe/agents/*.md` loading boundary
- `floe-bus/src/tool-policy.ts` — engine tool operations and authority
- `floe-bridge/src/adapters/engine-tool-gate.ts` — the per-call gate

See [[Glossary]].
