# floe-cli

The Floe command line — the front door to the local Floe substrate. Once it is
on your `PATH`, typing `floe` starts the substrate (if it is not already
running) and opens a surface.

## Install (put `floe` on your PATH)

Floe installs as a single command straight from GitHub — no clone, no registry,
no account, and no Rust toolchain (the native authority broker ships prebuilt):

```bash
npm install -g github:floe-ai/floe
```

Open a **new** shell and `floe` is available everywhere. To remove it:
`npm rm -g floe`.

> Floe is distributed from the `floe-ai/floe` repository as one generated
> package, not a registry. Publishing to npm later is the same artifact pushed
> to a registry, so only the install command changes.

### Install from a checkout (for developing Floe)

Contributors working in this repository install the same `floe` from source.
This builds the native authority broker, so Rust with `cargo` is also required:

```bash
npm install          # once, to install workspace dependencies
npm run install:cli  # builds the services and installs `floe` globally
```

Open a **new** shell afterwards. To remove it: `npm rm -g floe`.

## First run

```bash
floe            # start the substrate and open a surface
```

- With no surface registered, `floe` starts the substrate and tells you how to
  add one.
- `floe setup` also offers to install Floe as a real OS auto-start, so the
  machine starts it for you from then on (see `floe service`).

## Running from source (no install)

```bash
node bin/floe.mjs <args>    # forwards every flag untouched
```

## Two separate start settings

- **Start on demand** (`services.start_on_demand` in the config, default `true`):
  may a client start the substrate itself when it is not already reachable? On
  for a personal machine; turn it off where Floe runs as an externally managed
  service.
- **Start at login**: not a config key. It is the OS auto-start, installed with
  `floe service install` and shown by `floe service status`.
