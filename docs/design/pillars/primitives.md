# Primitives

_Resolution: question_
_Built: partly_
_Authority: agent-provisional (draft from operator rulings, 8 Oct, and ADR-0008)_
_Authored by: agent_

The canonical list of Floe's primitives: the few things everything else is made
of. This document owns the list. Each primitive's own document owns its detail.

## The primitive test

_Resolution: direction_
_Built: yes_
_Authority: agent-provisional_
_Authored by: agent_

Something becomes a primitive only if it passes all of these:

1. **It owns something no existing primitive owns.** A name that only
   describes a shape of an existing primitive is not a primitive.
   ([ADR-0008](../../adr/0008-event-is-the-primitive.md))
2. **Real work needed it.** Evidence from attempted work, not a guess about
   what Floe might need ([working rules](../../contributing/working-rules.md#primitive-freeze)).
3. **It is mechanism, not opinion.** If two legitimate uses could want it
   different, or it only makes sense for one product, it belongs in an
   [Extension](../host/extension/extension.md) or a surface.
4. **It is first principles.** Strip it to the generic need; if what is left is
   an existing primitive, it is not new.

## The list

_Resolution: question_
_Built: partly_
_Authority: agent-provisional_
_Authored by: agent_

| Primitive | What it is |
|---|---|
| **Workspace** | Holds everything below. |
| **Actor** | Uses judgement: reads, decides, acts, and brings results back. Who or what backs it never matters. |
| **Command** | A fixed, repeatable step. A script plus a description Floe can read: what goes in, what comes out, what it changes outside Floe, what it may touch, how long it may run, and whether it is safe to retry. |
| **Context** | A shared room. Actors join it, post in it and read its history; that history is what an Actor reads before it acts. Each member says which kinds of Event wake it. A Context can sit inside another, like a thread inside a channel. |
| **Event** | Something that happened. It fires; it does not travel. It has a source: a schedule (a Pulse), a folder change, a webhook, or a person pressing go. It may carry a payload, including pointers to things kept elsewhere. |
| **Scope** | Holds a workflow: nodes and the connections between them. Saved versions mean a running job keeps the version it started with. |
| **Artefact** | A real output that can leave Floe: an image, a document, a build deployed somewhere else. |

## How they connect

_Resolution: question_
_Built: partly_
_Authority: agent-provisional_
_Authored by: agent_

- Actors, Commands, Contexts and Events can be placed as nodes in a Scope. An
  Event node carries its source.
- Connections between nodes are their own records. A Context is never the
  wiring between nodes.
- What an Event triggers depends on its type and what it is connected to: it can
  wake the members of a connected Context, or start a Command directly.
- A Context exists only when it is meant to have members. A Command run is
  recorded in its own run record ([NodeExecution](../scope/execution/node-execution.md)),
  not in a Context.
- A Command can be a node in a Scope, or an action an Actor calls. It is the
  same Command either way.

## Not primitives

_Resolution: direction_
_Built: partly_
_Authority: operator-confirmed (8 Oct ruling)_
_Authored by: operator_

- **[Connector](../workspace/connector.md).** A Workspace setting: the connection to an outside system
  (account, sign-in, health). Event sources and Commands that support it use
  it. A Connector does not have actions of its own; acting on the outside world
  is a Command.
- **Pulse, webhook, folder watcher.** [Sources](../event/source/source.md) of an Event
  ([ADR-0008](../../adr/0008-event-is-the-primitive.md)).
- **Card.** Something one Extension or surface moves through a workflow. It
  lives where that Extension keeps it (a Markdown file, a database row) and
  stays editable outside Floe. An Event may carry a pointer to it; Floe never
  knows what a card is.
- **Extension.** How a Workspace gains new Commands, Event sources, Connector
  kinds, Actors, record types, hooks, screens, and know-how and actions for
  Actors. It adds kinds of things inside the primitives; it never adds a
  primitive.

## Open

- **Contexts without members (not built).** Today every stored Event is given a
  Context, and a Command run gets a new Context with no members
  (`floe-bus/src/store.ts`, `resolveExecutionContext`). This could create
  millions of empty Contexts. Operator ruling, 9 Oct: a Context exists only
  when it is meant to have members; Events that start a Command need no
  Context.
- **Where the rest of the design still disagrees** is recorded as `## Open` in
  each affected document: [Connector](../workspace/connector.md),
  [NodeExecution](../scope/execution/node-execution.md),
  [Endpoint](../event/delivery/endpoint.md),
  [Context](../context/context.md) and [Extension](../host/extension/extension.md).
- `AGENTS.md` and the working rules name five building blocks; this list has
  seven. They are updated once the operator confirms this list.

## What would settle it

The operator confirms or corrects each row of the list and each Open item.
