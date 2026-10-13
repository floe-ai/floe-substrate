# Engine

_Resolution: settled_
_Built: partly_
_Authority: agent-provisional_
_Authored by: unknown_

An engine is the AI runtime that performs an Actor's [Turn](../event/delivery/turn/turn.md).
Floe has one runtime, floe-runtime, built on the GitHub Copilot SDK.

## Sign-in belongs to the vendor

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed (ADR-0013, 14 Sep)_
_Authored by: unknown_

The vendor's own sign-in writes the credential to the vendor's store. Floe never
reads, copies or refreshes model credentials. A surface sees readiness, an
account label and sign-in progress, never credentials
(`docs/reference/engine-control-protocol.md`).

## Use the Copilot SDK, not a bundled CLI

_Resolution: direction_
_Built: partly_
_Authority: operator-confirmed (8 Oct: Floe should use the Copilot SDK, not bundle the CLI directly)_
_Authored by: operator_

Turns already run through the Copilot SDK, which brings its own runtime. Floe
also bundles the full Copilot CLI, used only to run engine sign-in.

## What would settle it

Official Copilot SDK documentation showing whether the SDK can perform sign-in.
If it can, the bundled CLI goes.

## Engine tools follow Workspace access

_Resolution: settled_
_Built: no_
_Authority: operator-confirmed (13 Oct governance calls; replaces the D13 per-call gate)_
_Authored by: operator_

When a turn starts, Floe hands the engine the Workspace's
[access list](../capability/access.md). The engine applies it to every tool call
itself; the Bus does not decide tool calls one by one. Floe is unrestricted by
default. The vendor's own agent-spawning tools are off.

Still in code: the Bridge asks the Bus before each engine tool call
(`floe-bridge` engine tool gate, Bus tool policy), and refuses the shell and
outside folders by default. Both contradict "unrestricted by default".

## One engine

_Resolution: settled_
_Built: yes_
_Authority: operator-confirmed (13 Oct: "It's one or the other"; Pi Durable parked)_
_Authored by: operator_

Floe runs one engine at a time, never two side by side. Today that is
floe-runtime on the Copilot SDK.

- Engines plug in at one point: the Bridge's `RuntimeAdapter`
  (`floe-bridge/src/adapters/runtime-adapter.ts`). Changing engines touches that
  point and nothing else.
- Pi Durable (Earendil) was assessed as a replacement on 13 Oct and not adopted.
  Floe already ran on Pi's earlier engine from July to 14 Sep. Live runs showed
  that Floe's engine does the work; the gaps were in how a person talks to Floe
  and sees what it is doing, and Pi does not address those.
- Look at changing engines again only when a real need appears: a crash loses an
  Actor's work, a non-Copilot model is needed, or steering an Actor mid-task is
  not enough.

## One shell: bash

_Resolution: settled_
_Built: no_
_Authority: operator-confirmed (13 Oct: "lets do bash on windows")_
_Authored by: operator_

Actors use bash on every operating system. On Windows that is Git Bash. One
shell means one set of instructions for every Actor and every machine. The
engine's instructions name no other shell.

Still in code: floe-runtime's system message gives PowerShell guidance on
Windows.

## Open

- Which mechanism makes the Copilot SDK's shell tool use bash on Windows? Read
  the SDK documentation before building it.
- **Reuse the machine's sign-in.** Floe keeps its own Copilot folder
  (`<home>\bridge\copilot`), so someone already signed in to Copilot on this
  machine must sign in again, and only through a surface. Should Floe use the
  vendor's normal sign-in on this machine instead? That still keeps the
  credential with the vendor. The answer depends on whether sharing the vendor
  folder would bring the person's own Copilot settings (agents, MCP servers,
  skills) into Actors' turns.
