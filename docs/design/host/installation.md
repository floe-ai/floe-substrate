# Installation

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

How Floe gets onto a machine, runs, and upgrades. How surfaces depend on Floe is
owned by [Surface](surface/surface.md).

## Install

_Authority: operator-confirmed (star-map session, install path ruling)_

One command from GitHub, no clone, registry, account or Rust toolchain:
`npm install -g github:floe-ai/floe`. The npm registry may come later.
`floe-ai/floe` holds the built release.

Git installs cannot run install scripts, so the release carries built output
and anything that needs setting up happens at `floe setup` or first run.

## Running

Floe is three local services: the Bus (canonical state, port 5377), the Bridge
(runs engine turns) and the identity agent ([Identity](identity.md)).

- Starting is connect-first: reuse a running Floe; start one only when
  configuration allows on-demand start.
- One start at a time per Floe home.
- Launching a surface starts Floe when needed.
  _Authority: operator-confirmed._
- On first launch Floe asks once whether to start at login, and records that it
  asked. _Authority: operator-confirmed._ Built on Windows only (scheduled
  task); Linux and macOS are not built.

## Upgrading

_Authority: operator-confirmed (staging ruling)_

Services run from a staged, versioned copy under the Floe home, so npm can
replace the installed package while Floe runs. Floe never needs stopping to
upgrade. The running version keeps serving until restart; Floe says when a newer
version is installed than the one running.

## Configuration

Machine configuration lives in the Floe configuration file under the Floe home
(see the no-environment-variables law in [pillars](../pillars/pillars.md)).
Workspace configuration is owned by [Workspace](../workspace/workspace.md).

## Direction: first run without traps

_Resolution: direction_
_Built: no_
_Authority: agent-provisional_
_Authored by: agent_

- A configuration file that is named but missing is an error. Floe never falls
  back to the default home or port 5377 in its place.
- `floe setup` never turns the current folder into a Workspace without saying
  so and offering a choice.
- Setup tells the person when an engine needs signing in, and offers to do it
  from the command line ([Engine](engine.md#open)). `floe status` shows each
  engine's sign-in state, and whether work is waiting on it.
