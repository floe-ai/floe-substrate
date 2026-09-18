# PRD: Floe Substrate Release Direction

## Status
Draft for builder review

## Purpose
Floe has reached an important substrate milestone: a runtime-backed agent can receive events, use local workspace tools, write work logs, explicitly emit communication events, and return to idle. The next release direction is to move beyond a single default chat agent and establish the substrate capabilities needed for actors, extensions, hooks, and scheduled pulses.

This PRD defines the product direction and required outcomes. It intentionally does not prescribe the detailed technical design. The builder should use this as the product target, then propose vertical issues and implementation details for review.

## Product Objective
Enable Floe to become a self-shaping local agent substrate where users can ask Floe to create and configure actors, install or author extensions, schedule pulses, and connect these pieces through events, tools, work logs, and explicit communication.

The user should be able to start from a working workspace and progressively shape Floe by asking for things like:

- “Create an implementation actor for this project.”
- “Create a review actor that can review completed work.”
- “Add a todo extension for tracking work items.”
- “Schedule a daily reminder for me to check email at 3pm.”
- “Set up a pulse that asks the implementer to check the backlog each morning.”

## Current Baseline
The current system can already:

- register a workspace/project folder
- run the default Floe agent as a runtime-backed endpoint
- route events through bus and bridge
- use explicit `emit` for communication
- use local workspace tools for basic project work
- write auditable work logs
- keep runtime/tool activity separate from communication

This release should preserve those behaviours.

## First Principles

### Floe is an endpoint/event substrate
Floe is not fundamentally a chat product. Chat is only one view over events.

### Events are the communication primitive
Actors, humans, agents, extensions, pulses, and webhooks communicate by emitting canonical events.

### Emit is communication
Only explicit `emit` creates communication. Runtime visible output, tool output, and turn lifecycle are work log or trace material unless explicitly emitted.

### Turn completion is lifecycle
Agent end / turn completion means the endpoint has finished processing delivered events. It is not itself a message.

### Actors work by observing state and using tools
Agents should not primarily coordinate through chat. They should observe authorised substrate/project state, use tools or extension capabilities, write work logs, and emit only when communication or publication is needed.

## Key Product Capabilities

### 1. Actor creation and configuration
Users should be able to ask Floe to create or configure additional actors in a workspace.

Expected outcomes:

- create a new actor/agent definition
- assign a name, role, and instructions
- make the actor available as an endpoint
- allow it to use the standard local workspace tool set
- allow it to emit events to valid destinations
- record its work in auditable logs

### 2. Extension substrate
Floe should support extensions as first-class substrate additions.

An extension may provide:

- event types
- tools
- state
- hooks
- pulse behaviours
- work-log contributions
- future UI blocks or surfaces

The release should establish the minimal substrate needed for extensions to be discovered, described, and used by agents.

### 3. Hook system
Floe should expose stable hook points that extensions can attach to.

The hook vocabulary should be substrate-oriented and should support, at minimum, lifecycle points around:

- event received
- event emitted
- delivery created or acknowledged
- processing cycle start/end
- tool use start/end/failure
- agent/session lifecycle
- pulse execution
- extension lifecycle

The current supported implementation approach is programmatic TypeScript registration through `ExtensionContext.hooks.on(...)` while an extension is loaded. Hook registration is distinct from hook firing: active hooks are only those currently fired by bridge/runtime paths.

Active fired hooks:

- `SessionStart`
- `BeforeTurn`
- `TurnEnd`
- `Error`
- `WebhookReceived`

`BeforeTurn` currently supports prompt/context injection through returned `inject` data. The other SDK runtime hooks are observation hooks. `WebhookReceived` fires from the persisted bus webhook ingest event path. Pulse deliveries, session reuse/shutdown, and direct-tool activity do not currently fire extension hooks on the SDK path. Declarative YAML hook configuration is future/not implemented.

### 4. Pulse as substrate scheduling
Pulse should be a substrate-native scheduled event mechanism, not an agent heartbeat or keepalive.

Agents should be able to create simple scheduled pulses directly without writing an extension.

Example outcome:

- user asks: “Schedule a daily reminder for me to check email at 3pm.”
- Floe creates a scheduled pulse
- the pulse emits a reminder event to the target endpoint at the scheduled time
- the reminder appears through the normal event/delivery path

Extensions may also use or respond to pulses for more complex behaviours, such as checking a todo list or performing maintenance.

### 5. Simple reminder support
Simple scheduled reminders should work without extensions.

Expected outcomes:

- create one-off or recurring reminders
- target a human, actor, thread, or valid destination
- list existing reminders/pulses
- update or cancel scheduled pulses
- keep all pulse activity visible through event/work-log/audit paths

### 6. Extension proof through todo-style state
A todo-style extension is a strong proof candidate because it exercises extension state, tools, events, and agent work.

The exact implementation is for the builder to propose, but the product proof should show that an extension can own state and expose actions that an agent can use.

Example outcomes:

- create/list/update todo items
- agent can inspect todo state
- agent can update task status when work is done
- agent can emit review or completion events when appropriate

### 7. Destination discovery and addressing
Agents should not invent endpoint IDs.

They should receive enough context to reply to the current source when applicable, and should have a way to discover valid additional destinations when needed.

Expected outcomes:

- reply context is available when an actor should respond
- endpoint discovery remains workspace-scoped for now
- future extension/channel/subscription visibility is not blocked by the design

### 8. Work logs and auditability
All actor work should remain inspectable.

Expected outcomes:

- runtime visible output, tool calls, and tool results are logged as work activity
- emitted communication remains separate from work logs
- extension and pulse activity can be audited
- logs are useful to humans and may later support memory

## Non-Goals for This Release Direction

Do not prioritise:

- marketplace-style extension distribution
- remote or hosted sandboxing
- full permissions/trust UI
- full field/block/surface UI unless needed to prove substrate capability
- MCP as the default local tooling path
- pulse as keepalive or heartbeat

## Acceptance Outcomes

The release direction is successful when Floe can demonstrate:

1. The current local actor work loop remains functional.
2. A user can ask Floe to create or configure another actor.
3. A user can ask Floe to create a simple scheduled reminder/pulse without writing an extension.
4. Pulse events travel through the normal event/delivery path.
5. An extension can be represented, loaded, and used in a minimal but real way.
6. A todo-style extension or equivalent proof can provide state/actions that an agent can use.
7. Hooks are defined clearly enough for extensions to attach to substrate lifecycle points.
8. Agents can discover valid destinations without hard-coded endpoint IDs.
9. Work logs clearly separate activity from communication.

## Risks and assumptions

### Local-first trust model

Floe currently assumes a local-first workspace model. Runtime-backed actors can act inside the registered workspace using the same local authority as the user running Floe. The permission boundary is the workspace and local machine context, not per-action approval.

This may need to evolve for hosted, team, or remote environments.

### Actor autonomy

Actors are expected to work autonomously within their granted workspace context. The system should not require human approval for every tool call or action. Human review should be introduced at meaningful product boundaries, such as review requests, task completion, publishing, deployment, or destructive operations if those become product concepts.

### Event and coordination complexity

As more actors, extensions, pulses, and tools are introduced, the event stream may become noisy or ambiguous. The product must preserve clear event ownership, routing, visibility, work logs, and user-facing summaries so users can understand what happened and why.

### Extension boundary ambiguity

Extensions may provide tools, state, events, hooks, or UI surfaces. The first implementation must avoid hard-coding each extension as a bespoke product feature. Extensions should attach through substrate-supported mechanisms.

## Success signals

This release direction is successful when:

- A user can ask Floe to create or configure a useful actor without manually editing low-level files.
- A user can ask Floe to create or configure a simple scheduled pulse/reminder without writing an extension.
- A user can ask Floe to help define or scaffold an extension, and the resulting extension can attach through recognised substrate mechanisms.
- Actors can discover the destinations and tools they need without hard-coded endpoint IDs.
- Actors can complete work cycles without relying on chat as the coordination model.
- Work logs make actor activity understandable without turning tool output into communication.
- Pulse, extensions, actors, and emitted events can be validated through end-to-end flows.

## Operational constraints

- Local-first operation must remain fast enough for interactive use.
- Actor work must remain auditable through work logs and event records.
- The product must avoid token/credential leakage for Floe-managed secrets.
- Extension and pulse behaviour must not create unbounded event spam.
- Substrate concepts should be testable without requiring a particular surface.
