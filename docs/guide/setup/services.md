# Services

**Floe runs as four pieces: a substrate daemon, an agent runtime, a UI, and a command-line tool.**

| Piece | What it is | Port |
|---|---|---|
| bus | The [[What floe is|substrate]]. SQLite + authenticated HTTP/WebSocket. Owns canonical identity, Context, Event, Delivery, Scope design/execution, Artefact, authority, and operation receipts. | 5377 |
| bridge | Runs [[Actor]]s. Attaches workspaces, claims deliveries, executes [[Delivery and Turn|Turn]]s, loads [[Extension]]s. | — |
| floe-app | React presentation plus the trusted Tauri desktop broker. A standalone browser needs its own authenticated session adapter. | 5379 |
| floe-cli | The `floe` command. Setup, services, auth. | — |

floe-app is a client of the substrate. Its trusted native shell holds host
authority in the operating-system vault, obtains short-lived Workspace
sessions, and brokers authenticated requests, media, and push frames. The
webview receives results, never bearer or provider credentials. State-changing
product actions invoke Bus-owned semantic operations; the Bridge runs authorised
Deliveries.

## Starting services

```
floe start
```

Starts the bus, the bridge, and the floe-app frontend on port 5379. No window opens. This is the safe command for autostart — it is service-only, with nothing to attach to a display.

```
floe desktop
```

Starts services if they are not already running, waits for the 5379 frontend to answer a health check, then opens the Tauri desktop window **attached** to that already-running frontend. It never spawns a second frontend — the desktop window is a native shell wrapped around the same UI a browser would load at `http://127.0.0.1:5379`.

`floe desktop` requires the Rust toolchain (`cargo`) to compile the Tauri window. If `cargo` isn't on `PATH`, the command fails fast with a link to `https://rustup.rs/` and re-run instructions — it does not attempt to install Rust for you. The first launch compiles Rust, which takes about 2–5 minutes; the build output streams to your terminal. Later launches are fast.

## Other commands

| Command | What it does |
|---|---|
| `floe setup` | Create config, optionally enable autostart, start services, verify health, open the web UI |
| `floe status` | Show service health and configured URLs |
| `floe open` | Open the floe-app web UI in your browser |
| `floe stop` | Stop all local services |
| `floe restart` | Stop then start all local services |
| `floe logs [service]` | Print logs for `bus`, `bridge`, or `app` (all three if omitted) |
| `floe doctor` | Diagnose local setup |
| `floe config path` / `floe config edit` | Print or edit the active config path |
| `floe service install` / `floe service uninstall` / `floe service status` | Install/remove/inspect Floe auto-start on this machine |
| `floe uninstall` | Remove auto-start and stop services; preserves `~/.floe` data |
| `floe reset` | Wipe runtime/state data back to first-run, preserving config and credentials |

See [[Glossary]] for term definitions.

## Implementation

- `floe-cli/src/cli.ts` — all `floe` subcommands (`start`, `desktop`, `stop`, `restart`, `logs`, `status`, `open`, `doctor`, `config`, `autostart`, `uninstall`, `reset`, `setup`)
- `floe-cli/src/desktop.ts` — `checkCargoAvailable`, `missingCargoMessage` (cargo preflight)
- `floe-cli/src/process-manager.ts` — service start/stop, PID records, log paths
- `floe-app/src-tauri/tauri.attach.conf.json` — Tauri config override with empty `beforeDevCommand`, used by `npm run tauri:attach --workspace floe-app` so `floe desktop` attaches instead of spawning a second vite
