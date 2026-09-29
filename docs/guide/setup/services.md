# Services

**Floe runs the substrate as three local services. A surface is a separate
client, not another substrate service.**

| Piece | What it does | Port |
|---|---|---|
| bus | Owns canonical substrate state and exposes authenticated HTTP and WebSocket transport. | 5377 |
| bridge | Claims deliveries and runs Actors through runtime adapters. | none |
| identity agent | Holds the person's unlocked identity and gives surfaces bearers, over a local pipe or socket. | none |
| floe-cli | Starts and manages the substrate, and launches registered surfaces. | none |

## Starting and stopping

```bash
floe start
floe status
floe stop
floe restart
```

`floe start` starts the bus, bridge and identity agent. It does not launch a
surface.

Starts of the same Floe home take turns. If Floe is started twice at once (from
the terminal and a surface, or by launching twice), the second start waits for
the first, then uses the services it started. Neither start fails. A start
that waits more than three minutes stops and says another start has not
finished.

`floe up` is the connect-first entry for clients that need the substrate but do
not want to launch a surface. It reuses a reachable substrate. If the substrate
is unavailable, it starts the local services only when
`services.start_on_demand` permits that. When the bus is already serving but
the identity agent or bridge is down, the same setting lets a client start
the missing one. It does this only for a bus this Floe home started, never for
someone else's.

Typing `floe` uses the same readiness path and then launches a registered
surface. See [[Install and first run]].

## Where the services run from

An npm-installed Floe does not run its services from the installed package.
Before starting one, it snapshots the package and the packages it loads into
`<Floe home>/runtime/<version>-<fingerprint>/` and runs the service there. On
Windows a running process locks the folder it runs from, so this is what lets
`npm install -g` replace Floe, or a surface that carries it, while Floe runs.

- Files are hard links to the installed ones, so a snapshot takes almost no
  disk space. It is built once per install (about a second) and reused after.
- A snapshot belongs to the copy that made it. Its `stage.json` records that
  copy, and a staged service reports that copy's version and whether it is a
  dependency. Staging adds no third kind of copy.
- Starts that build the same snapshot at once share it: each builds its own
  copy, and the first to finish becomes the snapshot. If Windows briefly holds
  the files, Floe tries again for up to 30 seconds, then gives a plain message.
- Each start removes snapshots that no running service uses. A snapshot still in
  use is kept until the next start after it stops. `floe reset` removes them all.
- A source checkout runs in place and is never staged.

## Other commands

| Command | What it does |
|---|---|
| `floe logs [service]` | Print logs for `bus`, `bridge`, `identity`, or all |
| `floe doctor` | Show service status, configuration path, and Floe home |
| `floe config path` / `floe config edit` | Print or edit the active configuration |
| `floe service install` / `uninstall` / `status` | Manage operating-system auto-start |
| `floe uninstall` | Remove auto-start and stop services while preserving Floe home data |
| `floe reset` | Wipe runtime and state data while preserving configuration, provider credentials and your identity (`--include-identity` removes it too) |

Start on demand and start at login are separate:

- `services.start_on_demand` controls whether a client may start an unreachable
  substrate.
- Operating-system auto-start is installed state, queried with
  `floe service status`; it is not a configuration key.

## Implementation

- `floe-cli/src/cli.ts` - service and launcher commands
- `floe-cli/src/startup.ts` - connect-first readiness and startup
- `floe-cli/src/start-lock.ts` - one start at a time per Floe home
- `floe-cli/src/process-manager.ts` - local process records, logs, and stopping
- `floe-cli/src/staging.ts` - service snapshots under `<Floe home>/runtime/`
- `floe-cli/src/service.ts` - operating-system auto-start
