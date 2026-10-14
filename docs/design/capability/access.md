# Workspace access

_Resolution: settled_
_Built: no_
_Authority: operator-confirmed (13 Oct: "we should just have 'here is what LLM backed actors can do in this workspace' thats it")_
_Authored by: operator_

Floe works like an agent harness. Every [Actor](../actor/actor.md) in a
[Workspace](../workspace/workspace.md) gets the same tools, permissions and
access by default. Only its instructions, the Extensions it chooses to use and
its Workspace differ. Nothing has to be granted per Actor, so a newly formed
Actor can start work straight away.

**Workspace access** is the one list that says what Actors can do in a
Workspace: which tools they may use and which folders they may reach. Every
Actor uses the same list, whoever or whatever backs it.

- The list belongs to the Workspace and is set in configuration, never by
  environment variables ([pillars](../pillars/pillars.md)).
- When an Actor's turn starts, Floe hands the list to the
  [engine](../host/engine.md), which applies it to every tool call.
- [Hooks](../host/extension/hook.md) can still block or change a tool call the
  list allows.
- Every operation in the Workspace is open to every Actor in it. Per-Actor
  grants, roles, approval rules and spending limits exist only as
  [frozen governance](#frozen-governance), off unless someone turns them on.

## Unrestricted by default

_Resolution: settled_
_Built: partly_
_Authority: operator-confirmed (29 Sep ruling; 13 Oct: restrictions are per Workspace, not per Actor; 14 Oct: "full access", folders included)_
_Authored by: operator_

A new Workspace starts unrestricted: every tool and every folder. Narrowing the
list is opt-in, for the whole Workspace. "Ask before acting" is never a
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

## Joining a Workspace

_Resolution: settled_
_Built: partly_
_Authority: operator-confirmed (14 Oct, D28, red-team finding RT1)_
_Authored by: operator_

Equal access starts after someone is let in. Only a member allowed to answer
[requests to join](#asking-to-join), or the machine owner's own Floe, admits a
new identity to a Workspace. Knowing a Workspace's folder never admits anyone.
Joining again never undoes a removal; only they can readmit a removed identity.

The first identity to choose a new folder becomes its first member. A folder
Floe opened while nobody was signed in has no member yet, so the first identity
to join it does the same. Anyone else [asks to join](#asking-to-join), or the
machine owner's own Floe admits them directly with `floe identity add`.

Still in code: only the machine owner's own Floe can admit; members cannot yet
([asking to join](#asking-to-join) is not built).

## Asking to join

_Resolution: settled_
_Built: no_
_Authority: operator-confirmed (14 Oct: "a new user should be able to 'request' access to a listed workspace, and the owner should able to see pending requests"; on who answers: "O64 and O65, and it is a workspace setting")_
_Authored by: operator_

Letting someone in works from any surface, not only the terminal.

- A signed-in identity sees the Workspaces on this machine, including ones it
  is not in, and asks to join one.
- Who may answer is a Workspace setting: any member, or only the first member.
- Those who may answer see waiting requests as they arrive, with who is asking
  (display name and public key). Requests are pushed, never polled.
- They accept or decline. Accepting admits the identity, as
  `floe identity add` does. The asker is told the answer.
- A surface does all of this as an ordinary client, with the person's own
  sign-in, never with the machine's host credential
  ([surfaces](../../surfaces/README.md)).
- Each request and answer is an [Event](../event/event.md).

### Expiry, withdrawal and asking again

_Resolution: settled_
_Built: no_
_Authority: operator-confirmed (14 Oct: "Yes, low priority, not required for release")_
_Authored by: operator_
_Priority: P3_
_Release: 1.0_

A request expires if nobody answers it, and the asker can withdraw it. A
removed identity may ask again.

## One trust level per machine

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed (14 Oct, D27, red-team finding RT2)_
_Authored by: operator_

An unrestricted Workspace reaches every folder the machine's user can reach,
so its Actors can read another Workspace's files directly. Workspaces on one
machine share that user's trust; they are not walled off from each other.
A Workspace keeps its own records, and Floe's own routes never serve one
Workspace's records to another. Keep work that must be separated on separate
machines or user accounts.

[Extensions](../host/extension/extension.md) are trusted code that runs with the
machine user's rights. An Extension never receives Floe's own service
credentials, so it cannot act as Floe. Floe's services remove their credentials
from their own environment at start, so no process they launch inherits them.

## Frozen governance

_Resolution: settled_
_Built: partly_
_Authority: operator-confirmed (14 Oct: "MY gut feel is to literally keep all the goverenence", freeze option O63 approved)_
_Authored by: operator_

The September governance system stays in the code, frozen. It is open by
default, kept working and tested, and nothing new is built on it. A team that
needs per-Actor control later can turn parts of it on for a Workspace. It
replaces the 13 Oct call to remove it.

- capability grants and their delegation
- Policies (operation, approval, budget, trust, data, emergency stop) and their
  lifecycle
- Actor roles
- approvals and tool approvals
- budgets
- engine tool policy and the Bridge's per-call tool gate
- the separate audit record
- the operation authority that ends with each Delivery

Not built: open defaults. Today an Actor needs grants for each operation; new
Actors copy their creator's access, or get a default list only in a Workspace
with exactly one person; Floe-issued Actor access lapses on a set date unless a
person adopts the Actor; and the Bridge refuses the shell and folders outside
the Workspace ([Workspace](../workspace/workspace.md#files)). Each of these
becomes open by default.

## Open

- **Who answers by default.** Who may answer requests is a Workspace setting
  (any member, or only the first member). Which does a new Workspace start
  with?
- **Where the list lives.** Workspace configuration (`.floe/floe.yaml`) is
  committed and portable, but extra folders are paths on one machine
  ([folder binding](../workspace/folder-binding.md)). Which file holds which
  part?
