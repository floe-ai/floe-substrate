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
| `engine.tool.filesystem.read` | `view`, `grep`, `glob` |
| `engine.tool.filesystem.write` | none yet |
| `engine.tool.process.execute` | `powershell` |
| `engine.tool.network.fetch` | `web_fetch` |

Every Actor may use every engine tool by default, anywhere the machine allows,
without prompts. Restrictions are opt-in: a person chooses them for an Actor or
a Workspace. Each call is decided before it runs, and checked only against the
limits that were chosen:

1. the Actor's live grants for that operation. An Actor is offered only the
   built-in tools its grants cover. A grant with no targets is unrestricted;
   targets narrow it to folders (`filesystem_path`), commands (`executable`)
   or fetch domains (`network_domain`);
2. its definition's `scope.paths`, if set: every path a file tool touches must
   resolve, after symlinks, inside those folders;
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

The default Floe Actor of a new local Workspace holds all four engine tool
operations with no targets and no folder limit. An Actor it creates holds what
it is handed through `capability.grant.delegate`: an Actor can hand on only
what it holds, and by default it hands on its engine tool access unchanged. A
grant may be **delegation-only**: its holder cannot use it, but can delegate a
subset of it to another Actor.

Limits:

- The Copilot tool set is proven for Copilot CLI 1.0.83 on Windows only. On
  another platform no built-in tool is offered. If the engine's tool
  catalogue differs from the proven one, the session does not start.
- Copilot has no governed file-write tool yet, so a write grant exposes nothing.
- Copilot reports only the command names in a shell call, not the files,
  addresses or redirections it touches. So a folder limit refuses every shell
  call, and a command allowlist is checked on those names only.
- A path outside the Workspace is recorded as unresolved, not by name.
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
