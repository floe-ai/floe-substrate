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

Floe then finds the installed surfaces, like a boot menu:

- one surface: launch it;
- several surfaces: ask which one to launch;
- no surfaces: keep the substrate running and explain how to add one.

Run a particular surface by name:

```bash
floe <surface-name>
```

On the first launch, Floe asks once whether to start automatically at login.
It records that it asked, so it asks once per Floe home no matter which command
created the configuration.

If the current directory or an ancestor contains `.floe/`, the launcher also
tries to register that Workspace before handing control to the surface.

## Make a package a surface

A surface that is an npm package declares itself in its own `package.json`.
Nothing runs at install time: installing the package globally is enough for
`floe` to find it.

```json
{
  "name": "my-surface",
  "bin": { "my-surface": "./dist/main.js" },
  "floe": {
    "surface": {
      "name": "my-surface",
      "label": "My Surface",
      "bin": "my-surface"
    }
  }
}
```

- `name` — what a person types (`floe my-surface`): lowercase letters, digits
  and hyphens.
- `label` — what a person sees in the menu.
- `bin` — which of the package's own `bin` entries launches it. The surface
  stays launchable by that command on its own.

Floe reads these from globally installed packages (`npm root -g`). A surface
must not ship a bin called `floe`; that command belongs to Floe.

## Register a surface that is not a package

A surface that is not an npm package (a script, a tool in another language) is
registered by hand:

```bash
floe surface register --name <name> --label "<label>" --command <command>
floe surface list
floe surface remove <name>
```

Use `--arg <arg>` more than once when the launch command needs arguments. Each
registered surface owns one YAML file in the `surfaces` directory under the Floe
home.

`floe surface list` shows both kinds together. If an installed package and a
registry file use the same name, the installed package wins, and the unused file
is listed. If two installed packages use the same name, Floe offers neither and
says which packages conflict. Floe does not contain a built-in list or special
case for any surface.

## Set up and manage the substrate

```bash
floe setup
```

Setup creates the local configuration when needed, starts the bus, bridge and
identity agent, checks bus health, registers an enclosing `.floe/` Workspace
when present, and offers to install operating-system auto-start.

Useful service commands:

```bash
floe up       # ensure the substrate is reachable without launching a surface
floe start    # start the local bus, bridge and identity agent
floe status
floe stop
floe restart
```

On Windows, `floe service install` installs a per-user scheduled task that
starts Floe at logon. Linux systemd and macOS launchd installation are not
implemented.

## Two copies of Floe

A surface can carry Floe as a dependency, so one machine may have a copy you
installed directly and a copy inside a surface. Whichever starts first serves;
the other connects to it.

- A copy reads where it lives. If it sits in another package's `node_modules`,
  it is a dependency. Only a directly installed copy (a global install or a
  checkout) may set up start-at-login, because uninstalling the surface would
  remove a dependency's copy and silently break it. A dependency's copy says to
  install Floe directly instead.
- The bus reports its version at `/health`. When a copy connects to a running
  Floe of a different version, it says so and leaves it running. `floe status`
  shows both versions.
- Both copies share one identity agent, because the agent's address comes from
  the Floe home. The same rule applies: whichever agent is running serves.

## Upgrading

Upgrade while Floe is running; there is no need to stop it first:

```bash
npm install -g github:floe-ai/floe     # or upgrade the surface that carries Floe
floe restart                           # when you want the new version to serve
```

The running Floe keeps serving the old version until it restarts. `floe`,
`floe up` and `floe status` say when a newer Floe is installed than the one
running. A surface gets the same fact from `floe/identity` (`versionNote`), and
restarting is always the person's choice.

This works from 0.3.1 on. A Floe 0.3.0 or older that is running still blocks
npm on Windows (`EBUSY`), so stop it once (`floe stop`) for that upgrade.

## Your identity

Floe holds one identity for you, under the Floe home, and every surface uses it.
A surface asks you to create or unlock it and draws those screens; Floe keeps
the key. The same steps work in the terminal:

```bash
floe identity create --name "<your name>"   # shows your recovery phrase once
floe identity join                          # create or join this folder's workspace
floe identity status
```

`floe reset` keeps your identity. See [[CLI reference]] for unlock, restore,
"forgot passphrase" and revoking a surface's session.

See [[CLI reference]] for the complete command list.

## Implementation

- `scripts/install-cli.mjs` - builds, packs, and globally installs `floe` from a checkout
- `scripts/release.mjs` - builds, verifies, tags, and publishes the `floe-ai/floe` artifact
- `floe-cli/src/cli.ts` - launcher and command definitions
- `floe-cli/src/surface-manifests.ts` - detects surfaces declared by installed packages
- `floe-cli/src/surface-catalog.ts` - merges detected and registered surfaces
- `floe-cli/src/surfaces.ts` - on-disk surface registry and launching
- `floe-cli/src/prompt-state.ts` - records one-time questions already asked
- `floe-cli/src/installation.ts` - this copy's version and whether it is a dependency
- `floe-cli/src/staging.ts` - runs the services from a snapshot, so npm can upgrade under them
- `floe-bus/src/version.ts` - the version the bus reports at `/health`
- `floe-cli/src/startup.ts` - connect-first substrate startup
- `floe-cli/src/service.ts` - operating-system auto-start
- `floe-cli/src/identity/` - the identity agent and the `floe/identity` client
