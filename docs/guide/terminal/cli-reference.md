# CLI reference

**The `floe` binary covers setup and service management only — nothing about scopes, contexts, nodes or extensions.**

| Command | What it does | Key flags |
|---|---|---|
| `floe setup` | Create config, start services, verify health, offer to install auto-start | `--yes`, `--no-autostart`, `--repair` |
| `floe status` | Show service health and configured URLs | — |
| `floe up` | Ensure the substrate is reachable (start it if this machine's policy allows), without launching a surface | — |
| `floe start` | Start local services (bus, bridge) | — |
| `floe stop` | Stop local services | — |
| `floe restart` | Restart local services | — |
| `floe logs [service]` | Print service logs (`bus`, `bridge`; both if omitted) | — |
| `floe doctor` | Diagnose local setup | — |
| `floe config path` | Print active config path | — |
| `floe config edit` | Open config in `$EDITOR`, or print the path | — |
| `floe service install` | Install Floe to start automatically on this machine | — |
| `floe service uninstall` | Remove Floe auto-start from this machine | — |
| `floe service status` | Show whether Floe is installed to auto-start | — |
| `floe surface list` / `register` / `remove` | Manage the registry of surfaces (how you use Floe) | — |
| `floe uninstall` | Remove auto-start and stop services; preserve `~/.floe` data | — |
| `floe reset` | Factory reset: wipe workspaces, contexts, boards, agents; preserve provider credentials and service config | `--yes` |
| `floe [surface]` | Ensure the substrate is reachable, then launch a surface (bare `floe` launches the only one, prompts if several, guides if none) | — |

## `floe setup`

First-run entry point. Writes `~/.floe/config.yaml` if missing, then starts services and checks health.

```bash
floe setup --yes
```

`--repair` reconciles local service records (PID files, ports) without wiping data.

## `floe status`

```bash
floe status
```

Prints whether bus/bridge/app are running and the URLs they're bound to.

## `floe open` / `floe start` / `floe stop` / `floe restart`

```bash
floe start     # bus + bridge + frontend, no window
floe stop
floe restart
floe open       # opens http://localhost:5379 in a browser
```

## `floe desktop`

Starts services if not already running, waits for the frontend to be healthy, then opens the Tauri desktop shell attached to the same 5379 frontend. It never starts a second frontend. Requires `cargo` on `PATH`; fails fast with an install link if missing.

```bash
floe desktop
```

## `floe logs`

```bash
floe logs           # bus, bridge, app
floe logs bridge     # bridge only
```

## `floe config path` / `floe config edit`

```bash
floe config path
floe config edit
```

## `floe up`

Connect-first. If the substrate is already serving on the configured bus URL,
it does nothing and reports it is running. If it is not reachable, it starts it
only when this machine's policy allows (`services.start_on_demand`); otherwise it
says plainly that Floe is not running and does not start a rogue copy. This is
the door a surface's own binary uses to make sure Floe is up before it connects.

```bash
floe up
```

## `floe service install` / `floe service uninstall` / `floe service status`

Install Floe as a real OS auto-start so the machine starts it, not a person.

```bash
floe service install     # from now on, the machine starts Floe for you
floe service status
floe service uninstall
```

Platform reach is honest: **Windows** installs a per-user logon Scheduled Task
that runs the CLI directly and needs no administrator rights. Linux (systemd)
and macOS (launchd) are designed but not yet implemented — the command says so
rather than pretending to have installed a service. A machine-wide service that
runs before any logon is a separate, elevation-requiring concern and is not
installed here.

`services.start_on_demand` in the config is a different setting: it is the
*policy* governing whether a client may start the substrate on demand (on for a
personal machine, off where Floe runs as a managed service). It is start-on-demand
only, and does not by itself install any OS auto-start. Start-at-login is not a
config key — it is the OS auto-start above, read from the OS by `floe service
status`.

## `floe doctor`

```bash
floe doctor
```

## `floe reset`

Destructive. Prompts for confirmation unless `--yes` is passed.

```bash
floe reset --yes
```

## `floe uninstall`

```bash
floe uninstall
```

## Not covered by the CLI

There is no dedicated `floe` command family for the following. An authorised
terminal integration discovers and invokes the same semantic operations
documented in [[Bus API]]; it does not use raw mutation routes as a shortcut:

- **Scopes** — composition revisions, publication, execution, stop, retirement,
  and safe removal.
- **Contexts** — create, inspect, participant access, archive, restore,
  communication, and guarded permanent destruction.
- **NodePlacements, Ports, and Edges** — the exact design inside one
  ScopeCompositionRevision.
- **Events and Artefacts** — publish, inspect, trace, and exact-version
  provenance.
- **Pulses and Connectors** — schedule or external source/action lifecycle.
- **Actors and runtime profiles** — versioned definition, binding, retirement,
  and reactivation.
- **Extensions** — inspect, install, upgrade, disable, and rollback under
  declared authority.

## `npm run build` (developer tool, not a `floe` command)

`npm run build` at the repo root is a dev/dogfooding build picker. It is entirely separate from the `floe` CLI and must never become a `floe` command.

Entry point: `scripts/build.mjs`. Targets: `bus` (`floe-bus`, `tsc`), `bridge` (`floe-bridge`, `tsc`), `cli` (`floe-cli`, `tsc`), `app` (`floe-app`, `tsc -b` + `vite build`).

```bash
npm run build              # interactive multi-select on a TTY, all pre-ticked
npm run build -- --all     # build all targets, non-interactive
npm run build -- bus app   # build named targets
```

On a non-TTY (agent/CI), if no targets are given, all four are built automatically — it never hangs waiting for input. The Tauri desktop exe build (`tauri:build`) is deliberately excluded; run it manually inside `floe-app` when needed.

See [[Glossary]] for term definitions.

## Implementation

- `floe-cli/src/cli.ts` — the full command registry
- `floe-cli/src/index.ts` — CLI entry point / dependency preflight
- `scripts/build.mjs` — the dev build picker (not part of the CLI)
