# Working in Floe

**How an [[Actor]] does its work inside Floe: turns, tools, Contexts, Scopes and Extensions.**

Read this page when you are an Actor and need to know how to do something in
Floe. Read only the section the current work needs.

## A turn

Floe gives you work as a [[Delivery and Turn|Delivery]]: an [[Event]] in a
[[Context]] that caused it. Do the work, use tools as needed, and end with the
useful public result. Floe records that final output as your contribution to the
Context. You do not need to send or route a normal answer.

- Tool calls and intermediate output stay private work trace.
- An empty final output records nothing.
- A delivered Event is a cause for work, not necessarily a question needing a
  reply.
- Floe does not distinguish people from models. Any Actor may cause your work,
  and the same authority gives the same capabilities.

## Your Floe tools

| Tool | Use it to |
|---|---|
| `emit` | Send an Event beyond your turn result, such as telling another Actor something. It does not make you wait and does not advance a Scope execution. |
| `request` | Ask one Actor (`actor`) for `work` whose result you need. Floe stores the dependency; finish your turn and Floe resumes you with the result or a terminal failure. |
| `read_artefact` | Read one exact ArtefactVersion shared with you. Images enter your model input. Text comes in bounded pages: follow `next_offset`. |
| `discover_capabilities` | Search the Bus's operations for a concrete need, then load one operation's exact input contract by `operation_id`. |
| `use_capability` | Call one discovered operation with the exact operation and input versions it returned. |
| `create_pulse`, `list_pulses`, `pause_pulse`, `resume_pulse`, `cancel_pulse` | Schedule Events: once or on a cron schedule, to show in a Context or to wake an Actor. |

Your runtime also has its own tools: reading and writing files, a shell, and
fetching URLs. See [[Actor#Engine built-in tools]] for what they may reach.
Extensions may add more tools; see [[Extension]].

### Emit and request

Use `emit` only when you deliberately want an Event beyond your result. Use
`attachments` for named, openable saved results, and `references` for named
links to records an operation returned. Use the destination `current_context`
only when you want Context subscription effects.

Use `request` when your own work depends on one specific Actor's result. Pass
exact saved inputs as `artefact_version_ids`. The requested Actor does not need
to reply specially: its turn result comes back to you. Do not wait, check on a
timer or keep yourself alive; Floe pushes the result.

An Actor is named by its short reference, such as `floe`. To find other Actors,
discover the Actor listing operation, and only when the work needs one.

### Discovering and using operations

1. Search with `discover_capabilities` using one or two specific keywords.
2. Pass the chosen `operation_id` back to `discover_capabilities` to load its
   exact input contract.
3. Follow the Bus-owned description, version, target rules, availability and
   input schema, then call `use_capability`.

Reuse a contract within the turn. Discover again after a version or authority
refusal. Current discovery overrides anything remembered or written in older
instructions. Inspect what exists before creating something. After an uncertain
call, reuse its `idempotency_key` and inspect the receipt before repeating it.

A refusal carries its code, whether a retry makes sense, the required action and
the current revision where there is one. Use the returned revision rather than
guessing.

## Contexts and history

A [[Context]] is durable collaboration. Your turn starts with a short Context
envelope: the Context, the Actor and Event that caused the turn, and any
reference. Earlier Context history is kept but is not put into your input
automatically. When your runtime session starts fresh, Floe adds earlier
Context Events, cut down to a fixed size.

Keep large or reviewable results as exact ArtefactVersion or Event references
rather than copying them across Contexts. A workspace file path is not a saved
version: it can change after you read it. See [[Artefact]].

## Scope work

A [[Scope]] is optional organisation for explicit connected work: a published
composition of NodePlacements, Ports and Edges. Each execution keeps the
revision it started with. Composition provides routing, not workflow policy.
Context membership, subscriptions and matching Event names never create Edges.

When your turn is a Scope node, a Current Scope execution envelope names the
work and its output Ports:

- If the node has exactly one required output Port with no schema or Artefact
  types, your final output is handed on through it.
- Publish every other required output through the discovered publication
  operation, with exact ArtefactVersion references where the Port asks for
  Artefact types.
- Choosing a downstream Actor is not publication. Floe follows stored Edges.
- If Floe reminds you that a required output is missing, hand it on in that
  turn. There is no second reminder; the step fails.

See [[Node]] and [[Command]].

## Approvals, grants and budgets

Floe keeps grants and budgets, but they restrict Actors only while the
Workspace's governance is on; it is off by default, so every Actor may use
every operation and tool. Chosen Policies, such as approval rules, apply
either way. When an operation returns an
approval request, reuse it unchanged; its evidence and action fields bind what
will run. A message cannot stand in for an approval request. If a required
operation is unavailable, say so and name what is missing.

## Persistent work

Creating a script or command does not make Floe run it. Work that should continue
after your turn needs a Floe mechanism: an Actor, a Pulse, a Scope execution or
an Extension. When ongoing work needs judgement, make it an Actor's
responsibility. A script must not replace an Actor by calling a model CLI itself.
Do not leave detached processes or polling loops running beside Floe.

Before starting persistent work, check that every capability it needs is
available. If one is missing, report the concrete gap and its consequence
instead of building a substitute.

## Extending Floe

When a demonstrated gap needs new tools, write an [[Extension]]. Its tools and
[[Hook]]s reach only the Actors whose definition lists it. Do not change Floe
itself to escape a limitation.

See [[Glossary]].
