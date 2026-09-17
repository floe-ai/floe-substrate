# Services

**Floe runs the substrate as two local services. A surface is a separate client,
not another substrate service.**

| Piece | What it does | Port |
|---|---|---|
| bus | Owns canonical substrate state and exposes authenticated HTTP and WebSocket transport. | 5377 |
| bridge | Claims deliveries and runs Actors through runtime adapters. | none |
| floe-cli | Starts and manages the substrate, and launches registered surfaces. | none |

## Starting and stopping

```bash
floe start
floe status
floe stop
floe restart
```

`floe start` starts the bus and bridge. It does not launch a surface.

`floe up` is the connect-first entry for clients that need the substrate but do
not want to launch a surface. It reuses a reachable substrate. If the substrate
is unavailable, it starts the local services only when
`services.start_on_demand` permits that.

Typing `floe` uses the same readiness path and then launches a registered
surface. See [[Install and first run]].

## Other commands

| Command | What it does |
|---|---|
| `floe logs [service]` | Print logs for `bus`, `bridge`, or both |
| `floe doctor` | Show service status, configuration path, and Floe home |
| `floe config path` / `floe config edit` | Print or edit the active configuration |
| `floe service install` / `uninstall` / `status` | Manage operating-system auto-start |
| `floe uninstall` | Remove auto-start and stop services while preserving Floe home data |
| `floe reset` | Wipe runtime and state data while preserving configuration and provider credentials |

Start on demand and start at login are separate:

- `services.start_on_demand` controls whether a client may start an unreachable
  substrate.
- Operating-system auto-start is installed state, queried with
  `floe service status`; it is not a configuration key.

## Implementation

- `floe-cli/src/cli.ts` - service and launcher commands
- `floe-cli/src/startup.ts` - connect-first readiness and startup
- `floe-cli/src/process-manager.ts` - local process records, logs, and stopping
- `floe-cli/src/service.ts` - operating-system auto-start
