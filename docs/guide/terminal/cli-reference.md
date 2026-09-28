# CLI reference

**The `floe` command starts and manages the substrate, launches installed
surfaces, and exposes substrate operations for terminal clients.**

| Command | What it does |
|---|---|
| `floe` / `floe <surface>` | Ensure the substrate is reachable, then launch an installed surface |
| `floe setup` | Create configuration, start services, check health, and offer auto-start |
| `floe up` | Ensure the substrate is reachable without launching a surface |
| `floe start` / `stop` / `restart` | Manage the local bus, bridge and identity agent |
| `floe status` | Show each service's process state, bus health and version, the identity agent and identity state, and this copy's version |
| `floe logs [service]` | Print logs for `bus`, `bridge`, `identity`, or all |
| `floe surface list` / `register` / `remove` | List surfaces; register or remove non-package surfaces |
| `floe operations list` / `describe` / `invoke` | Discover and invoke Bus-owned semantic operations |
| `floe identity status` / `create` / `unlock` / `lock` / `reveal` / `restore` / `replace` / `join` / `sessions` | Manage your identity, held by Floe's identity agent |
| `floe identity add` / `list` / `revoke` | Admit, list and revoke keys on the bus (host control) |
| `floe config path` / `edit` | Inspect local configuration |
| `floe service install` / `uninstall` / `status` | Manage operating-system auto-start |
| `floe doctor` | Show service and local-path diagnostics |
| `floe uninstall` | Remove auto-start and stop services; preserve Floe home data |
| `floe reset` | Wipe Floe runtime and state data; preserve provider credentials, service configuration and your identity |

## Launcher

```bash
floe
floe <surface-name>
```

Both forms first reuse a reachable substrate or start it when the machine's
policy permits. Bare `floe` launches the only installed surface, prompts when
several are installed, and explains how to add one when none exist. Surfaces
come from globally installed packages that declare `floe.surface` in their
`package.json`, plus registry files (see [[Install and first run]]). The first
launch asks once about start-at-login.

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

`floe setup` creates configuration when missing, starts the bus, bridge and
identity agent,
checks bus health, registers an enclosing `.floe/` Workspace when present, and
offers operating-system auto-start. `--yes` accepts the auto-start offer,
`--no-autostart` skips it, and `--repair` clears stale local service records
before startup.

`floe up` does not launch anything. It starts the local substrate only when
`services.start_on_demand` allows it; otherwise it reports that the configured
substrate is not running.

`floe start` fails if the bridge exits while Floe is starting, and shows the
end of the bridge's log. `floe status`, `floe up` and `floe` report when the
running Floe is a different version from this copy, for example after an
upgrade. `floe restart` switches to this copy's version. See
[[Install and first run]] for upgrading.

## Surfaces

```bash
floe surface list
floe surface register \
  --name <name> \
  --label "<label>" \
  --command <command> \
  --arg <arg>
floe surface remove <name>
```

`list` shows surfaces declared by installed packages and registered surfaces
together, with where each came from. `register` is for surfaces that are not npm
packages; `--arg` may be repeated. Registry entries are YAML files in the
`surfaces` directory under the configured Floe home. `remove` deletes a
registry entry; a package surface is removed by uninstalling its package.
Unreadable entries and invalid `floe.surface` declarations are reported rather
than silently ignored.

## Operating-system auto-start

```bash
floe service install
floe service status
floe service uninstall
```

Windows installs a per-user scheduled task at logon and does not require
administrator rights. Linux systemd and macOS launchd installation are not
implemented.

This is separate from `services.start_on_demand`, which controls whether a
client may start an unreachable substrate. Start at login is not a configuration
key.

`floe service install` only works from a directly installed Floe. A copy that
lives inside another package's `node_modules` refuses and says to install Floe
directly (see [[Install and first run]]).

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

## Your identity

```bash
floe identity status
floe identity create --name "<display name>"
floe identity unlock
floe identity lock
floe identity reveal
floe identity restore [--name "<display name>"] [--replace]
floe identity replace [--name "<display name>"]
floe identity join [folder] [--create]
floe identity sessions [--revoke <session-id>]
```

Floe holds one identity per Floe home. Surfaces ask Floe's identity agent to act
as you and never hold the key (see
[Identity agent protocol](../../reference/identity-agent-protocol.md)).

- `create` asks for a passphrase. Leaving it empty protects the identity with
  this device instead: anyone who can use this computer as you can act as you,
  and the recovery phrase is the only copy that survives this machine. The
  recovery phrase is shown once; write it down.
- `lock` makes Floe forget the key and ends every surface session. Floe also
  locks by itself after `identity.lock_after_idle_minutes` (default 15) with no
  surface connected.
- `reveal` shows the recovery phrase, or the `nsec` for an identity that has no
  phrase.
- Forgot the passphrase: `restore` if you have the recovery phrase (same
  identity), otherwise `replace`. `replace` makes a new identity, admits it to
  every workspace the old one was in and revokes the old one. Work done before
  stays credited to the old identity. The old file is set aside, not deleted.
- `join` creates or joins the workspace for a folder as you.
- `sessions` lists which surfaces are acting as you; `--revoke` ends one.

## Admitting other keys

```bash
floe identity add --name "<display name>" --pubkey <npub-or-hex>
floe identity list
floe identity revoke <identity-id>
```

Admission, listing, and revocation require host control.

## Maintenance

```bash
floe config path
floe config edit
floe doctor
floe uninstall
floe reset
```

`floe reset` prompts unless `--yes` is supplied. It keeps your identity.
`floe reset --include-identity` also removes it; the recovery phrase is then the
only way back.

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
- `floe-cli/src/identity-command.ts` - identity admission commands
- `floe-cli/src/identity/terminal-commands.ts` - your identity, through the agent
- `floe-cli/src/surfaces.ts` - surface registry and process launch
- `scripts/build.mjs` - repository build picker
