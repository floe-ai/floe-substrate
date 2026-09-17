# floe-cli

The Floe command line — the front door to the local Floe substrate. Once it is
on your `PATH`, typing `floe` starts the substrate (if it is not already
running) and opens a surface.

## Install (put `floe` on your PATH)

From the repository root:

```bash
npm install          # once, to install workspace dependencies
npm run install:cli  # builds the CLI and installs `floe` globally
```

`install:cli` builds the native authority broker (requires Rust/cargo) and the
TypeScript, then runs `npm install -g ./floe-cli`. After it finishes, open a
**new** shell and `floe` is available everywhere — nothing needs to be linked by
hand.

To do the two steps yourself:

```bash
npm run build --workspace floe-cli   # native broker + dist
npm install -g ./floe-cli            # put `floe` on PATH
```

To remove it: `npm rm -g floe-cli`.

> This package is not published to a registry. Global-install-from-checkout is
> the supported install path while Floe is pre-release, which is why it is
> marked `private`.

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
