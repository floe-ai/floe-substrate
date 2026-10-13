# Workspace access

_Resolution: settled_
_Built: no_
_Authority: operator-confirmed (13 Oct: "we should just have 'here is what LLM backed actors can do in this workspace' thats it")_
_Authored by: operator_

Floe works like an agent harness. Every [Actor](../actor/actor.md) in a
[Workspace](../workspace/workspace.md) gets the same tools, permissions and
access. Only its instructions, the Extensions it chooses to use and its
Workspace differ. Nothing is granted per Actor, so a newly formed Actor can
start work straight away.

**Workspace access** is the one list that says what Actors can do in a
Workspace: which tools they may use and which folders they may reach. Every
Actor uses the same list, whoever or whatever backs it.

- The list belongs to the Workspace and is set in configuration, never by
  environment variables ([pillars](../pillars/pillars.md)).
- When an Actor's turn starts, Floe hands the list to the
  [engine](../host/engine.md), which applies it to every tool call. The Bus does
  not judge tool calls one by one.
- [Hooks](../host/extension/hook.md) can still block or change a tool call the
  list allows.
- Every operation in the Workspace is open to every Actor in it. Floe keeps no
  per-Actor grants, roles, approval rules or spending limits.

## Unrestricted by default

_Resolution: settled_
_Built: partly_
_Authority: operator-confirmed (29 Sep ruling; 13 Oct: restrictions are per Workspace, not per Actor; 14 Oct: "full access", folders included)_
_Authored by: operator_

A new Workspace starts unrestricted: every tool and every folder. Narrowing the
list is opt-in, for the whole Workspace. "Ask a person first" is never a
default. One Actor asking another before acting is an ordinary message in a
[Context](../context/context.md); it needs no approval mechanism.

## Extensions are context, not access

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed (14 Oct: "you can enable disable per actor, its for context not security")_
_Authored by: operator_

An Actor's [definition](../actor/definition.md#extensions) may list which
Extensions it uses, the same way it chooses its instructions. The list keeps an
Actor's tool set relevant to its job. It is not a security boundary: any Actor
could be given any Extension, and nothing relies on the list to stop one.

## What Floe keeps for safety

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed (13 Oct governance calls)_
_Authored by: operator_

- Signing in and connection credentials ([Identity](../host/identity.md)). A
  credential says who is acting and in which Workspace. It records who did what;
  it does not decide access.
- Floe accepts browser requests only from approved web origins.
- The machine owner's desktop app acts without a separate sign-in.
- Secret storage ([SecretRef](secret.md)).
- Holding operations while a Workspace restore runs.

What happened is recorded as [Events](../event/event.md), operation
[receipts](receipt.md) and each turn's [work log](../event/delivery/turn/turn.md#work-log).
There is no separate audit store.

## Still in code

The Bus still carries the September governance system, which this design
removes:
- capability grants and their delegation
- Policies (operation, approval, budget, trust, data, emergency stop) and their
  lifecycle
- Actor roles
- approvals and tool approvals
- budgets
- engine tool policy and the Bridge's per-call tool gate
- the "new Actors copy their creator's access" rule
- authority adoption
- the separate audit record
- the limit on writes outside the Workspace's folders
  ([Workspace](../workspace/workspace.md#files))

## Open

- **Where the list lives.** Workspace configuration (`.floe/floe.yaml`) is
  committed and portable, but extra folders are paths on one machine
  ([folder binding](../workspace/folder-binding.md)). Which file holds which
  part?
