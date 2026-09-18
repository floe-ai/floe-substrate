# CLI reference

**The `floe` command starts and manages the substrate, launches registered
surfaces, and exposes substrate operations for terminal clients.**

| Command | What it does |
|---|---|
| `floe` / `floe <surface>` | Ensure the substrate is reachable, then launch a registered surface |
| `floe setup` | Create configuration, start services, check health, and offer auto-start |
| `floe up` | Ensure the substrate is reachable without launching a surface |
| `floe start` / `stop` / `restart` | Manage the local bus and bridge |
| `floe status` | Show bus and bridge process state and bus health |
| `floe logs [service]` | Print logs for `bus`, `bridge`, or both |
| `floe surface list` / `register` / `remove` | Manage the surface registry |
| `floe operations list` / `describe` / `invoke` | Discover and invoke Bus-owned semantic operations |
| `floe identity generate` / `add` / `list` / `revoke` | Manage client keypair identities |
| `floe config path` / `edit` | Inspect local configuration |
| `floe service install` / `uninstall` / `status` | Manage operating-system auto-start |
| `floe doctor` | Show service and local-path diagnostics |
| `floe uninstall` | Remove auto-start and stop services; preserve Floe home data |
| `floe reset` | Wipe Floe runtime and state data; preserve provider credentials and service configuration |

## Launcher

```bash
floe
floe <surface-name>
```

Both forms first reuse a reachable substrate or start it when the machine's
policy permits. Bare `floe` launches the only registered surface, prompts when
several are registered, and gives registration guidance when none exist.

Before launch, Floe makes a best-effort attempt to register a Workspace found
in the current directory or an ancestor. Failure to register that Workspace
does not stop the selected surface from opening.

## Setup and service lifecycle

```bash
floe setup
floe up
floe start
floe status
floe logs
floe logs bridge
floe stop
floe restart
```

`floe setup` creates configuration when missing, starts the bus and bridge,
checks bus health, registers an enclosing `.floe/` Workspace when present, and
offers operating-system auto-start. `--yes` accepts the auto-start offer,
`--no-autostart` skips it, and `--repair` clears stale local service records
before startup.

`floe up` does not launch anything. It starts the local substrate only when
`services.autostart` allows it; otherwise it reports that the configured
substrate is not running.

## Surface registry

```bash
floe surface list
floe surface register \
  --name <name> \
  --label "<label>" \
  --command <command> \
  --arg <arg>
floe surface remove <name>
```

`--arg` may be repeated. Registry entries are YAML files in the `surfaces`
directory under the configured Floe home. Unreadable entries are reported
rather than silently ignored.

## Operating-system auto-start

```bash
floe service install
floe service status
floe service uninstall
```

Windows installs a per-user scheduled task at logon and does not require
administrator rights. Linux systemd and macOS launchd installation are not
implemented.

This is separate from `services.autostart`, which controls whether a
client may start an unreachable substrate. Start at login is not a configuration
key.

## Semantic operations

```bash
floe operations list
floe operations describe <operation-id>
floe operations invoke <operation-id> --input '<json>'
floe operations invoke <operation-id> --input @input.json
```

Commands can select `--workspace <workspace-id>` or `--host`, and may identify a
target with `--target-kind` plus `--target-id`. Writes can provide
`--idempotency-key`; compare-and-swap operations can provide
`--expected-revision`.

The Bus supplies the operation schema, availability, authority requirements,
confirmation, and result. The CLI does not reproduce those rules.

## Client identities

```bash
floe identity generate
floe identity add --name "<display name>" --pubkey <npub-or-hex>
floe identity list
floe identity revoke <identity-id>
```

`identity generate` prints a new seed and keys once and stores nothing.
Admission, listing, and revocation require host control.

## Maintenance

```bash
floe config path
floe config edit
floe doctor
floe uninstall
floe reset
```

`floe reset` prompts unless `--yes` is supplied.

## `npm run build`

The repository build picker is a developer tool, not a `floe` command.

```bash
npm run build
npm run build -- --all
npm run build -- bus cli
```

Its current targets are `bus`, `bridge`, and `cli`. With no targets on a
non-interactive terminal, it builds all three.

## Implementation

- `floe-cli/src/cli.ts` - launcher, setup, service, surface, and maintenance commands
- `floe-cli/src/operations-command.ts` - semantic operation commands
- `floe-cli/src/identity-command.ts` - client identity commands
- `floe-cli/src/surfaces.ts` - surface registry and process launch
- `scripts/build.mjs` - repository build picker
