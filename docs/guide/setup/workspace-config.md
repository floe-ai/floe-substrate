# Workspace config

**`.floe/` is a committed, human-authored configuration surface for a [[Workspace]].**

The Workspace's stable identity, authority, Contexts, Scope designs and
executions, Artefacts, Events, Deliveries, and receipts live in canonical Bus
records. A host-local directory is a Workspace locator binding, and `.floe/`
contains portable configuration inside that bound content. Neither the path nor
the files are the Workspace identity. See [[Substrate settings]] for
machine-level settings that do not belong here.

## `.floe/floe.yaml`

The workspace manifest. Structure:

```yaml
schema: floe.workspace.v1
version: 1
agents:
  - id: floe
    path: ./agents/floe.md
pulse:
  default: "off"
  after_idle: "30m"
  min_interval: "30m"
state:
  path: ./state
```

- `agents` — the list of agent definition files this workspace declares
- `pulses` — workspace-level pulse declarations (schedule sources for [[Event]]s)
- `watchers` — legacy folder-watch configuration; current sources use typed
  Connector definitions and bindings
- `state` — where ephemeral, non-config runtime state is written

## `.floe/agents/<id>.md`

An agent definition: YAML frontmatter plus a body of free-text instructions.

```markdown
---
schema: floe.agent.v1
agent_id: floe
label: Floe
extensions: []
skills:
  - ../skills/substrate-build
mcp: []
pulse:
  inherit: true
scope:
  paths:
    - ./
  services: []
---
You are Floe, ...
```

Fields: `schema`, `agent_id`, `label`, `runtime.engine`, `extensions` (list of [[Extension]] names bound to this actor), `skills`, `mcp`, `pulse.inherit`, `scope`.

## `.floe/floe.yaml` and runtime composition

This is a hard invariant: `.floe/floe.yaml` is committed project configuration, not runtime scratch state. Ordinary workspace attachment reads it without modification. A deliberate actor-management operation may add, update, or remove an actor definition and then request a config snapshot so the active runtime follows the committed configuration change.

During attachment, the Bridge sends a deterministic,
secret-free inventory of the current files and Runtime selection to the Bus.
The Bus creates or versions the canonical ActorDefinition, RuntimeProfile and
ActorRuntimeBinding records, then records an import receipt. Only an applied
receipt advances the Workspace's active configuration hash. An unresolved
credential or operation-authority binding keeps that Actor unavailable; it is
not treated as a usable Runtime. Actors omitted from a later inventory are
preserved rather than silently retired.

Runtime attachment separately reads current published Actors and their saved
runtime bindings. Changing an Actor or model through the app therefore survives
restart even when an older file import conflicts. The refused import remains
available as evidence and cannot replace the saved settings. Unimported file
changes do not start legacy Event sources. Disabled or retired runtimes remain
unavailable. Instructions and model choices for work come from the exact records
pinned by its Delivery.

The compatibility authority used for a verified retained Workspace is a
closed, versioned policy with a bounded expiry. New, copied and forked
Workspaces require explicit per-Actor operation authority. Runtime capability
requirements never create operation authority by implication.

Actors may form runtime organisation through the Bus without hand-editing this
file. The app and Actors discover the same Bus-owned semantic operations.
Creating a draft ScopeCompositionRevision, publishing it, and starting a pinned
ScopeExecution use one source of validation, authority, refusal, and receipts.
The revision contains explicit NodePlacements, Ports, and Edges; it does not use
a scoped Context or Context subscriptions as wiring. Older top-level `watchers`
and mutable Scope graphs remain migration input, not the normal composition
path.

Extensions supply Actor definitions through the canonical lifecycle. The Bridge
does not load Extension source into model sessions. A clean attachment must not
dirty tracked workspace files.

## Git behaviour on write

Actor management uses discovered semantic operations and the active runtime's
authority. It does not create Actor Markdown files as a second authoring API.
Workspace files remain import sources and may be maintained deliberately through
ordinary file tools. Committing those file changes is a workspace choice, not an
automatic consequence of creating or changing a canonical Actor.

## Implementation

- `floe-bridge/src/project.ts` — `ensureProjectTemplate`, `loadProject`, `.floe/floe.yaml` and `.floe/agents/*.md` parsing, `computeConfigSurface`
- `floe-bus/src/actor-definition-operations.ts` — canonical Actor definition
  lifecycle
- `floe-bus/src/workspace-config-import.ts` — canonical, receipt-producing
  configuration import and compatibility policy boundary
- `floe-bridge/src/workspace-config-inventory.ts` — deterministic secret-free
  inventory construction
- `floe-bridge/src/daemon.ts` — imports file-backed configuration and separately
  attaches current canonical Actor runtimes

Git-behaviour-on-write as a workspace setting ("leave it / show it / commit it"): Not built yet.

See [[Glossary]] for term definitions.
