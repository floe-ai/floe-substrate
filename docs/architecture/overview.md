# Floe Substrate — Living Architecture Graph

> **How to evolve this document**
>
> This is the living architecture graph. Every slice reassesses and augments it.
> Before merging a slice: (1) verify current-state diagrams still reflect the code,
> (2) move any items that shipped from "Target / Aspirational" to "Current State",
> (3) flag any new open questions.
>
> Machine-readable ownership map: [`architecture.map.yaml`](../../architecture.map.yaml)
> (clusters → cells → modules with write-authority and path globs).  
> This document is the human-facing companion: it explains *why* things are shaped as
> they are and where they are going, and renders as diagrams on GitHub.  
> Canonical terminology lives in [`CONTEXT.md`](../../CONTEXT.md).  
> Accepted decisions live in [`docs/adr/`](../adr/).
>
> **Canonical foundation:** ADR-0010 through ADR-0012 supersede the earlier
> subscription-routed mutable-graph, path-identity, raw-client, and direct-secret
> assumptions still visible in legacy adapters. This document distinguishes
> those adapters from the accepted contract; they are not alternate product
> semantics.

---

## Part 1 — Transitional implementation inventory

Grounded in current code. Legacy adapters are labelled as such; canonical
semantics come from `CONTEXT.md` and accepted ADRs.

---

### 1.0 System Domains & Seams

The four domains and the mechanisms connecting them. Read this first — the sections
below zoom in on each domain independently.

```mermaid
graph LR
    subgraph APP["floe-app"]
        UI["React webview\n(presentation only)"]
        NATIVE["Tauri native broker\nhost vault · Workspace sessions"]
        CREG["COMPONENT_REGISTRY\n(maps extension component IDs\nto React components at build time)"]
    end

    subgraph BUS["floe-bus · port 5377"]
        BHTTP["Fastify HTTP + WebSocket"]
        BSTORE["BusStore (SQLite)\nidentity · authority · semantic operations\nScope design/execution · Context · Artefact\nEvent · Delivery · Connector · Extension"]
        BHTTP <-->|"internal"| BSTORE
    end

    subgraph BRIDGE["floe-bridge"]
        DAEMON["BridgeDaemon\n(delivery loop + runtime adapter)"]
        HOOKS["HookRegistry\n(BeforeTurn, Pulse, TurnEnd…)"]
        LOADER["extension-loader"]
        RELAY["extension-relay · port 5378"]
    end

    subgraph EXTS["external extensions"]
        ENTRY["entry factory\n(tools + hook handlers)"]
        EHTTP["HTTP handlers"]
        EVIEW["declared view"]
        EFILES[".floe/extensions/name/\n(definition files)"]
    end

    UI -->|"typed IPC; no bearer material"| NATIVE
    NATIVE -->|"authenticated projections\nand semantic operations"| BHTTP
    NATIVE -->|"authenticated cursor stream"| BHTTP
    BHTTP -->|"GET /v1/extensions\n→ registered views"| UI
    CREG -.->|"unavailable components render a placeholder"| EVIEW

    DAEMON -->|"authenticated Delivery/runtime transport"| BHTTP
    DAEMON -->|"POST /v1/extensions/report\n(relay_url)"| BHTTP

    ENTRY -->|"loaded by (workspace attach)"| LOADER
    ENTRY -->|"registers handlers on"| HOOKS
    EHTTP -->|"served via"| RELAY
    RELAY -->|"proxied as\nGET/POST /v1/extensions/name/*"| BHTTP

    EFILES -->|"read/written by\nextension tools & handlers"| DAEMON
```

**Desktop trust boundary:** the Tauri shell owns the `host_control` credential in
the operating-system vault, obtains short-lived Workspace operation sessions,
and brokers HTTP, media, provider authentication, and resumable push events.
The webview receives typed results, never bearer or provider credentials
(ADR-0012).

---

### 1.1 Substrate Primitives (`floe-bus`)

The Bus is the canonical substrate store and semantic operation authority.
Committed `.floe/` files remain configuration or legacy import sources; they do
not replace canonical Workspace identity, Scope topology, execution, Context,
Artefact, authority, or receipt records.

**Key invariant (`floe-bus/src/store.ts` header):** `BusStore` is the sole mutable
substrate store for bus-owned records. No parallel runtime state.

#### Core primitive relationships

```mermaid
graph TD
    subgraph BUS["floe-bus — BusStore (SQLite)"]
        WS["Workspace identity\n+ host-local locator binding"]
        SC["Scope\n(organising boundary)"]
        REV["ScopeCompositionRevision\nNodePlacements · Ports · Edges"]
        EX["ScopeExecution\nNodeExecution · ExecutionAttempt"]
        CTX["Context\ncollaboration + evidence"]
        ACT["Actor\nidentity + definition revision"]
        EP["Endpoint\ndelivery interface"]
        ART["Artefact\nimmutable versions + provenance"]
        EV["Event\n(canonical record)"]
        DEL["Delivery\ntransport obligation"]
        PL["Pulse\n(scheduled trigger)"]
        PF["pulse.fired event\n(one per subscriber per fire)"]
    end

    WS -->|"contains 0..n"| SC
    WS -->|"contains 0..n"| ACT
    SC -->|"owns immutable"| REV
    SC -->|"owns"| EX
    EX -->|"pins one"| REV
    EX -->|"references"| CTX
    REV -->|"explicit Edges advance"| EX
    SC -->|"organises"| CTX
    CTX -->|"participants"| ACT
    ACT -->|"uses"| EP
    CTX -->|"contains"| EV
    EP -->|"emits"| EV
    EV -->|"creates"| DEL
    DEL -->|"delivered to"| EP
    EX -->|"produces/consumes exact"| ART
    PL -->|"fires → creates"| PF
    PF -->|"is a"| EV
    PF -->|"creates"| DEL
```

**Context anchoring rules (ADR-0004 + `floe-bus/src/contexts/store.ts`):**

- A Context must be anchored by actor participants, a Scope, or both.
- A Context with no actor participants **must** have a non-null `scope_id`.
- A Context with actor participants may have `scope_id: null` (workspace-level conversation).
- Participants have explicit role/access relationships and may change through
  canonical Context semantic operations.
- `parent_context_id` allows hierarchical nesting (e.g. sub-conversations).
- Context membership, parentage, and subscriptions never advance a canonical
  ScopeExecution. Only stored Edges do.

**Pulse = scheduled event (ADR-0001, `floe-bus/src/server.ts:firePulse`):**

```mermaid
sequenceDiagram
    participant PS as [bus] PulseScheduler
    participant BUS as [bus] BusStore
    participant EV as [bus] Events table
    participant DEL as [bus] Deliveries table

    Note over PS: setTimeout → nearest pulse
    PS->>BUS: firePulse(pulseId)
    loop for each subscriber
        BUS->>EV: INSERT event type="pulse.fired"
        BUS->>DEL: INSERT delivery (endpoint subscriber)<br/>or append to Context only (context subscriber)
    end
    BUS->>PS: reschedule next fire (cron) or mark completed (one-off)
    BUS-->>all: broadcast("pulse_fired", {...})
```

- Pulse **definitions** live in `.floe/floe.yaml` — committed, portable.
- Pulse **runtime state** (next_fire_at, last_fired) lives in SQLite — local, ephemeral.
- `PulseScheduler` (`floe-bus/src/pulse-scheduler.ts`) uses a single `setTimeout` sorted by next fire time; zero CPU cost at rest.
- A **context subscriber** appends `pulse.fired` to an existing Context for rendering only (no delivery created).
- An **endpoint subscriber** creates a Delivery; the bus reuses a stable generated scoped Context per pulse+subscriber, rather than creating a new Context on every fire.

**Emit / event routing (`floe-bus/src/store.ts:submitEvent`):**

```mermaid
graph LR
    SRC["Source endpoint\nor system (null)"] -->|"emit or trigger"| SE

    subgraph BUS["floe-bus — submitEvent()"]
        SE["submitEvent()"]
        SE -->|"resolve/create Context"| CTX["Context"]
        SE -->|"insert Event"| EV["Events table"]
        SE -->|"resolveDestinations()"| DST{"destination\nkind?"}
        DST -->|endpoint| D1["INSERT delivery\nfor target endpoint"]
        DST -->|broadcast| D2["INSERT delivery\nfor each matching endpoint"]
        SE -->|"broadcastEventSubmission()"| WS["WebSocket broadcast\nevent_submitted"]
    end
```

- `source_endpoint_id` is null for system-originated events (pulse.fired, webhook ingest).
- Broadcast targets are delivery-processor-based (e.g. `active_with_delivery_processor`) — actor-neutral.
- Context resolution: if `context_id` is supplied and source is not a participant → rejected with `E_NOT_CONTEXT_PARTICIPANT`.

---

### 1.2 Runtime Boundary (`floe-bridge`)

The bridge is the sole owner of effective runtime embodiment. It processes
event deliveries and runs agent turns.

#### Adapter selection and hook flow

```mermaid
graph TD
    subgraph BRIDGE["floe-bridge"]
        BD["BridgeDaemon\n(daemon.ts)"]
        CA["chooseAdapter()\n(daemon.ts:728)"]
        FA["FakeRuntimeAdapter\n(fake-runtime-adapter.ts)"]
        PA["PiAgentCoreAdapter\n(pi-agent-core-adapter.ts)"]
        HR["HookRegistry\n(hooks.ts)"]
        TURN["handleBundle()"]
    end

    subgraph EXTS["extensions (loaded into bridge)"]
        EXT["LoadedExtension[]\n(extension-loader.ts)"]
    end

    BD -->|"at startup"| CA
    CA -->|"no real profile"| FA
    CA -->|"has real profile OR env=pi"| PA

    BD -->|"per workspace attach"| EXT
    EXT -->|"registers handlers on"| HR
    BD -->|"per delivery"| TURN
    TURN -->|"fires hooks"| HR
```

**Adapter selection logic** (`daemon.ts:chooseAdapter`):
- `FLOE_RUNTIME_ADAPTER` env var overrides config.
- If no override: presence of a non-fake auth profile → `PiAgentCoreAdapter`; otherwise `FakeRuntimeAdapter`.

**RuntimeAdapter interface** (`floe-bridge/src/adapters/runtime-adapter.ts`):

```typescript
interface RuntimeAdapter {
  readonly name: string;
  handleBundle(context: RuntimeContext, bundle: DeliveryBundle, runtimeConfig?: AgentRuntimeConfig): Promise<void>;
  dispose?(reason?: HookPayload<"SessionEnd">["reason"]): Promise<void>;
}
```

#### Extension lifecycle

```mermaid
sequenceDiagram
    participant BD as [bridge] BridgeDaemon
    participant EL as [bridge] extension-loader.ts
    participant EXT as [extension] entry factory
    participant HR as [bridge] HookRegistry
    participant RL as [bridge] extension-relay.ts
    participant BUS as [bus] POST /v1/extensions/report

    BD->>EL: loadExtensions(workspaceExtDir, ctx)
    EL->>EXT: import(entry) → factory(ctx)
    EXT->>HR: ctx.hooks.on("BeforeTurn", handler)
    EXT->>BD: ctx.registerHttpHandler(...)
    EXT-->>EL: AgentTool[] (prefixed extension name)
    EL-->>BD: LoadedExtension[]
    BD->>RL: startExtensionRelayServer() [port 5378]
    BD->>BUS: POST /v1/extensions/report (relay_url)
```

#### Hooks fired at runtime (all hooks from `floe-bridge/src/hooks.ts`)

| Hook | When | Active behaviour |
|---|---|---|
| `SessionStart` | New LLM session created | Observation |
| `SessionResume` | Existing session reused | Observation |
| `BeforeTurn` | Before each agent turn | **Injection** — handler may return `{ inject: { source, content } }` to add context to the prompt |
| `TurnEnd` | After agent turn completes | Observation (visible_output, tool_activity, emitted_events) |
| `BeforeToolUse` | Before each tool call | Observation |
| `AfterToolUse` | After successful tool call | Observation |
| `ToolUseFailed` | After failed tool call | Observation |
| `Pulse` | When `pulse.fired` delivery is processed | Observation / side-effect trigger |
| `WebhookReceived` | When webhook ingest event is processed | Observation |
| `SessionEnd` | Session replaced or bridge shutting down | Observation |
| `Error` | Unrecoverable turn error | Observation |

Handlers run sequentially in registration order; failures are caught and logged, never crashing the adapter.

---

### 1.3 UI Surface (`floe-app`)

The React app is presentation. The packaged Tauri shell is the trusted desktop
adapter: it owns host authority, obtains Workspace sessions, and brokers
authenticated Bus requests, media, provider setup, filesystem access, and push
events (ADR-0012). A standalone browser requires a separate trusted session
adapter; loopback reachability is not authority.

```mermaid
graph TD
    subgraph APP["floe-app (port 5379)"]
        APPX["App.tsx\n(workspace selector)"]
        SD["ScopeDetail.tsx\n(scope main view)"]
        CTX_LIST["Contexts tab\n(listContextsForScope)"]
        OPS["Ops tab\n(Ops.tsx — pulse / endpoint ops)"]
        EXT_TABS["Extension tabs\n(dynamic from GET /v1/extensions)"]
        SS["SubstrateSettingsView\n(auth profiles / runtime config)"]
    end

    subgraph EXT["external extensions"]
        EV["Declared views\n(discovered at runtime)"]
    end

    subgraph BUS["floe-bus (port 5377)"]
        BAPI["HTTP + WebSocket API"]
    end

    subgraph DESKTOP["Tauri desktop shell (optional)"]
        TAURI["Tauri native broker\nhost vault · Workspace sessions\nHTTP · media · push relay"]
    end

    APPX -->|"scope selected"| SD
    SD --> CTX_LIST
    SD --> OPS
    SD --> EXT_TABS
    EXT_TABS -->|"unavailable component"| EV
    APPX --> SS
    APPX -->|"typed IPC"| TAURI
    SD -->|"typed IPC"| TAURI
    SS -->|"typed IPC"| TAURI
    TAURI -->|"authenticated projections\n+ semantic operations"| BAPI
    TAURI -->|"cursor-resumable stream"| BAPI
```

**Extension view registration** (`ScopeDetail.tsx`):
- `GET /v1/extensions?workspace_id=X` returns extension manifests with declared views.
- Views with `slot: "scope-detail-tab"` are added as dynamic tabs alongside built-in Contexts/Ops tabs.
- A declared component without an in-repo implementation renders `PlaceholderExtensionView`; runtime loading of external view components is not implemented.
- `contextLabel` prefers `title` over `first_message_preview`.

---

## Part 2 — Extension implementation notes

> This section records extension boundaries that are not fully implemented.
> Accepted ADR-0010 through ADR-0012 are current contract, not aspirations;
> older extension-loader details remain transitional implementation only.

---

### 2.0 Substrate vs Extension — What Belongs Where

Extensions are independent consumers of the substrate. They define their own product semantics and durable state; the substrate owns shared coordination and runtime contracts.

| Concept | Owner | Available to any extension? |
|---|---|---|
| Workspaces, Scopes, Contexts | **Substrate** (`floe-bus`) | ✅ Yes |
| Events, Deliveries, Endpoints | **Substrate** (`floe-bus`) | ✅ Yes |
| Pulses (`pulse.fired`) | **Substrate** (`floe-bus`) | ✅ Yes |
| Hooks (`BeforeTurn`, `Pulse`, `TurnEnd`, …) | **Substrate** (`floe-bridge`) | ✅ Yes — register via `ExtensionContext.hooks.on(...)` |
| HTTP relay (`GET/POST /v1/extensions/name/*`) | **Substrate** (`floe-bridge` + `floe-bus`) | ✅ Yes — declare handlers via `ctx.registerHttpHandler(...)` |
| Extension-view discovery | **Substrate** (`floe-bus` + `floe-app`) | ✅ Yes — declare `views` in the manifest; unavailable components render a placeholder |
| Tool namespacing (auto-prefix) | **Substrate** (`extension-loader`) | ✅ Yes — automatic for all extensions |
| Agent bundling (in-memory, no disk write) | **Substrate** (`floe-bridge` + `floe-bus`) | ✅ Yes — declare `agents` in the manifest |
| Product domain, file formats, and business rules | **Extension** | ❌ No |

> **Rule:** deleting an extension must leave the substrate (bus, bridge, and app) unmodified. Extensions call substrate APIs; they do not add product semantics to them.

---

### 2.1 Extensions as Thin Glue

Extensions integrate into substrate primitives; they must not build parallel stores for substrate-owned mutable state.

- Extension-owned definitions and product state belong to the extension workspace files or its own storage contract.
- The Bus owns Contexts, Events, Deliveries, Scope design/execution, Artefact
  identity/provenance, authority, semantic operations, receipts, and runtime
  state. Context subscriptions remain non-graph communication or identified
  legacy routing only.
- Extension hooks and handlers use the normal event and delivery paths; they do not introduce polling loops or separate participant management.
- Tools are optional interfaces to extension-owned state. Events notify and route work; they are not a replacement for durable product state.

---

### 2.2 Definitions-in-Files / Runtime-in-Bus Split

Following ADR-0001, human-authored definitions are committed and portable; bus runtime state is local and ephemeral. An extension may define its own durable files, but it must not treat runtime scratch state as committed configuration.

| What | Home | Committed? |
|---|---|---|
| Project configuration | `.floe/floe.yaml` | ✅ Yes |
| Extension definitions and product state | Extension-owned contract | Extension-defined |
| Contexts, Events, Deliveries, Scope revisions/executions, Artefacts, grants, receipts, and cursors | Bus SQLite | ❌ No — canonical/runtime state |

---
### 2.3 Pulse / Event / Hook Unification Note

> **Current state:** hooks are session/turn lifecycle only. Pulses create `pulse.fired` events delivered to endpoints. Events are the reaction currency.

**Relationship (target and current):**

```mermaid
graph LR
    subgraph SUB["Substrate (general primitives)"]
        SCHED["Clock / Cron"] -->|"fires"| PL["Pulse\n(scheduled event trigger)"]
        PL -->|"creates"| PFE["pulse.fired event"]
        PFE -->|"is an"| EV["Event"]
        HUM["Human action"] -->|"emits"| EV
        WH["Webhook ingest"] -->|"emits"| EV
        EV -->|"delivered to"| EP["Endpoint"]
        EP -->|"processed by bridge"| HOOKS["Hooks\n(BeforeTurn, TurnEnd, Pulse…)"]
    end

    subgraph EXT["Extension handlers"]
        HNDL["Hook handler\n(observes / injects)"]
        AGT["Agent tool call"] -->|"emits"| EV
        HNDL -->|"may emit"| EV
    end

    HOOKS -->|"fires registered handlers"| HNDL
    HNDL -->|"may return inject{ }\nfor BeforeTurn"| RT["Runtime turn"]
```

- A pulse is just a scheduled event — no special processing path beyond creation.
- Events are the reaction currency; hooks are observation/injection points on the processing lifecycle.
- Today's hooks are session/turn lifecycle only. Future domain-event hooks are not yet designed.

---

## Part 3 — Open Questions

> These are deliberately unresolved. Do not answer them here — flag them for the captain.

| # | Question | Why deferred |
|---|---|---|
| OQ-1 | **Domain-event hooks**: should extensions register handlers on domain events rather than lifecycle hooks such as `BeforeTurn`? | Hook system currently covers session/turn lifecycle only. Extending to arbitrary event types requires design. |

---

## Cross-references

| Document | Role |
|---|---|
| [`architecture.map.yaml`](../../architecture.map.yaml) | Machine-readable ownership map (clusters, cells, modules, write-authority, path globs). This doc is the human-facing companion. |
| [`CONTEXT.md`](../../CONTEXT.md) | Canonical terminology and invariants. Definitions here are authoritative for all code and docs. |
| [`docs/adr/0001-pulse-scheduled-event-delivery.md`](../adr/0001-pulse-scheduled-event-delivery.md) | Pulse = scheduled event; definitions-in-files / runtime-in-bus split; event-driven scheduler. |
| [`docs/adr/0002-extension-substrate-design.md`](../adr/0002-extension-substrate-design.md) | Extension manifest format, factory function entry, hook registration model, tool namespacing. |
| [`docs/adr/0003-field-substrate-primitive.md`](../adr/0003-field-substrate-primitive.md) | Superseded renderer vocabulary decision (superseded by ADR-0004 for ownership questions). |
| [`docs/adr/0004-scope-as-substrate-organising-boundary.md`](../adr/0004-scope-as-substrate-organising-boundary.md) | Scope is the organising boundary; contexts may be scope-anchored or actor-anchored; there is no automatic fallback Scope. |
| [`docs/adr/0005-file-access-patterns.md`](../adr/0005-file-access-patterns.md) | Original desktop file/auth boundary, now extended by ADR-0012's native authenticated transport and credential broker. |
| [`docs/adr/0006-external-extension-repositories.md`](../adr/0006-external-extension-repositories.md) | Extensions live in independent repositories; the monorepo contains substrate only. |
| [`docs/adr/0010-canonical-scope-composition-execution-and-artefacts.md`](../adr/0010-canonical-scope-composition-execution-and-artefacts.md) | Context is collaboration; immutable Scope revisions own Ports/Edges; execution and Artefact provenance are canonical. |
| [`docs/adr/0011-one-semantic-operation-contract.md`](../adr/0011-one-semantic-operation-contract.md) | App, Actor, CLI, SDK, API, and MCP clients share one Bus-owned operation contract. |
| [`docs/adr/0012-portable-workspace-authority-and-secret-brokering.md`](../adr/0012-portable-workspace-authority-and-secret-brokering.md) | Portable Workspace identity, authenticated authority, transport audiences, and credential brokering. |
| [`docs/substrate-semantics.md`](../substrate-semantics.md) | Current working synthesis of canonical terms and accepted decisions. |
