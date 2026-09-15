# CLI reference

**The `floe` binary covers setup and service management only — nothing about scopes, contexts, nodes or extensions.**

| Command | What it does | Key flags |
|---|---|---|
| `floe setup` | Create config, optionally enable autostart, start services, verify health | `--yes`, `--no-autostart`, `--repair` |
| `floe status` | Show service health and configured URLs | — |
| `floe open` | Open the web UI | — |
| `floe start` | Start local services (bus, bridge, frontend) | — |
| `floe desktop` | Start services if needed, then open the desktop window attached to the running frontend | — |
| `floe stop` | Stop local services | — |
| `floe restart` | Restart local services | — |
| `floe logs [service]` | Print service logs (`bus`, `bridge`, or `app`; all three if omitted) | — |
| `floe doctor` | Diagnose local setup | — |
| `floe config path` | Print active config path | — |
| `floe config edit` | Open config in `$EDITOR`, or print the path | — |
| `floe autostart on` | Enable user-level autostart | — |
| `floe autostart off` | Disable user-level autostart | — |
| `floe uninstall` | Remove autostart entries and stop services; preserve `~/.floe` data | — |
| `floe reset` | Factory reset: wipe workspaces, contexts, boards, agents; preserve provider credentials and service config | `--yes` |
| `floe` (no args) | Start services, verify health, and (if a workspace is found in the current directory) attach it | — |

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

## `floe autostart on` / `floe autostart off`

```bash
floe autostart on
floe autostart off
```

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
