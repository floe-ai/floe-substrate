# Install and first run

**Getting from nothing installed to a working Floe: start local services, connect a provider, choose a workspace, and talk to Floe.**

## Packaged Windows installation

The Windows installer includes Floe's desktop application, Node runtime, Bus,
and Pi bridge. A packaged user does not need Node.js, Rust, `cargo`, or the Floe
CLI.

Run the `.msi` installer and launch Floe from the installed shortcut. The MSI is
a per-machine installation, so Windows requests administrator approval when
installing or upgrading it. An upgrade replaces the application binaries in
place. Floe's Workspace records and history remain in the user's data area;
reusable provider and host credentials remain in the operating-system
credential vault rather than the installation directory or webview.

## Developing from source

Source development requires Node.js. Rust and `cargo` are additionally required
for the native desktop window; the browser UI at `http://localhost:5379` does
not require Rust.

`floe desktop` checks for `cargo` on `PATH` before doing anything else. If it's
missing, it fails fast with a link to `https://rustup.rs/` instead of trying to
install Rust for you (`floe-cli/src/desktop.ts`, `checkCargoAvailable`).

Install the source dependencies with:

```bash
npm install
```

## `floe setup`

```bash
floe setup
```

Run once per machine. It:

- creates `~/.floe/config.yaml` if it doesn't already exist
- optionally enables user-level autostart
- starts the [[Services]] (bus, bridge, frontend)
- verifies they're healthy
- if the current directory (or an ancestor) already has a `.floe/` folder, registers it as a [[Workspace]] with the bus
- opens the web UI, unless you pass `--no-open`

Flags: `--yes` (accept defaults), `--no-autostart`, `--no-open`, `--repair` (reconcile local service records if something's stuck).

## Starting services without setup

```bash
floe start
```

Starts the bus, bridge, and frontend only — no browser window, nothing else. This is the command to use for autostart; it never opens a display. Open the UI yourself at:

```
http://localhost:5379
```

## The desktop window

```bash
floe desktop
```

Starts services if they aren't already running, waits for the 5379 frontend to answer a health check, then opens a native Tauri window attached to that same running frontend — it never starts a second frontend. First launch compiles Rust and takes about 2–5 minutes; the build output streams to your terminal. Later launches are fast.

Once the native shell opens, it renders a lightweight **Starting Floe…** state immediately and checks the local substrate while it becomes ready. The packaged app verifies the substrate's HTTP health rather than only checking that its port is occupied. On Windows it replaces an unresponsive packaged sidecar left by an earlier Floe run. If startup still fails, the wait is bounded and the app shows a recovery message instead of remaining on the starting screen. After startup, a compact green/amber/red status at the bottom of the navigation continues to reflect the live Bus connection and model-runtime attachment without polling. Opening a failed status shows the packaged process detail and can restart stopped local services without closing the application.

## First-use onboarding

A [[Workspace]] is a portable identity and isolation boundary. A local repo or
folder is its host-local locator binding. On a clean desktop installation,
opening Floe starts or attaches to its packaged local substrate in the
background. The app then offers the subscription providers supported by its
packaged Pi runtime, asks for an existing or new local binding, applies the
chosen model as the Workspace default, and opens the Floe conversation. No CLI
setup or login is required.

`floe setup` and `floe open` may discover an ancestor containing `.floe/`, but
registration still runs through authenticated host semantic operation
`workspace.register`. A headless integration needs a trusted host adapter; raw
loopback access and a caller-supplied `init_authorized` field do not grant
authority. See [[Working without floe-app]] for the authenticated terminal
boundary, and [[Workspace config]] for the portable configuration surface.

## What you see when nothing exists yet

A freshly attached workspace lands in the conversation with Floe and asks what outcome you want. It does not require a Scope, Actor inventory, or substrate configuration before that first conversation. The richer developer views remain available under Developer tools.

## If it breaks

If local state needs repair, use the bounded repair instruction for the
affected state. Do not delete the whole Floe home or operating-system credential
entry blindly. Workspace identity, history, SecretRefs, and provider credentials
are valuable state; missing or mismatched authority must be shown for explicit
recovery rather than silently replaced.

## Implementation

The desktop installer includes the Node runtime used by Floe and one bundled
desktop companion script. Together they run the Bus and Bridge as the background
substrate and perform provider-neutral Pi authentication when requested by the
Tauri shell. The native shell loads host authority from the operating-system
vault, passes it privately to a newly started sidecar, obtains a short-lived
Workspace session, and brokers authenticated requests and push events. If an
already-running Bus has incompatible authority, Floe shows recovery required
instead of silently replacing it.

- `floe-cli/src/cli.ts` — `setup`, `start`, `desktop`, `open` commands; `registerCurrentWorkspace`, `findAncestorWithFloe`
- `floe-cli/src/desktop.ts` — `checkCargoAvailable`, `missingCargoMessage`
- `floe-cli/src/config.ts` — `ensureConfig` (config creation, fail-fast reset message)
- `floe-cli/src/process-manager.ts` — `startAll`/service start/stop
- `floe-app/src-tauri/src/bus_broker.rs` — protected host credential, Workspace
  session, authenticated request/media, and push broker
- `floe-bus/src/workspace-operations.ts` — canonical registration and locator
  lifecycle operations
- `floe-bus/src/transport-auth.ts` — non-interchangeable host, Workspace, and
  Bridge authorities

See [[Glossary]].
