# Install and first run

**Floe is a substrate. Install its command-line launcher, then install a surface
that a person can interact with.**

## Install

Floe installs as a single command from GitHub — no clone, no registry, no
account, and no Rust toolchain (the native authority broker ships prebuilt in
the package):

```bash
npm install -g github:floe-ai/floe
```

Open a **new** shell afterwards, then run `floe`. To remove it later:

```bash
npm rm -g floe
```

### Install from a checkout (for developing Floe)

Contributors working in this repository can install the same `floe` from source.
This path builds the native authority broker, so Node.js and Rust with `cargo`
are required:

```bash
npm install
npm run install:cli
```

`install:cli` builds and globally installs an independent copy of `floe`; it
does not link the command back to the checkout. Open a new shell after it
finishes. Before it completes, the CLI can be run from the repository with
`node bin/floe.mjs <args>`.

## Launch Floe

```bash
floe
```

The launcher first checks whether the configured substrate is reachable. It
reuses a running substrate. If none is reachable, it starts the local bus and
bridge only when `services.start_on_demand` allows that.

Floe then reads the registered surfaces from the `surfaces` directory under the
configured Floe home:

- one surface: launch it;
- several surfaces: ask which one to launch;
- no surfaces: keep the substrate running and explain how to register one.

Run a particular registered surface by name:

```bash
floe <surface-name>
```

If the current directory or an ancestor contains `.floe/`, the launcher also
tries to register that Workspace before handing control to the surface.

## Register a surface

A surface's installer should register it. A surface can also be registered
manually:

```bash
floe surface register --name <name> --label "<label>" --command <command>
floe surface list
floe surface remove <name>
```

Use `--arg <arg>` more than once when the launch command needs arguments. Each
surface owns one YAML file in the registry; Floe does not contain a built-in
list or special case for any surface.

## Set up and manage the substrate

```bash
floe setup
```

Setup creates the local configuration when needed, starts the bus and bridge,
checks bus health, registers an enclosing `.floe/` Workspace when present, and
offers to install operating-system auto-start.

Useful service commands:

```bash
floe up       # ensure the substrate is reachable without launching a surface
floe start    # start the local bus and bridge
floe status
floe stop
floe restart
```

On Windows, `floe service install` installs a per-user scheduled task that
starts Floe at logon. Linux systemd and macOS launchd installation are not
implemented.

See [[CLI reference]] for the complete command list.

## Implementation

- `scripts/install-cli.mjs` - builds, packs, and globally installs `floe-cli`
- `floe-cli/src/cli.ts` - launcher and command definitions
- `floe-cli/src/surfaces.ts` - on-disk surface registry and launching
- `floe-cli/src/startup.ts` - connect-first substrate startup
- `floe-cli/src/service.ts` - operating-system auto-start
