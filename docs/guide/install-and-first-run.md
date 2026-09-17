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

### Put `floe` on your PATH

```bash
npm run install:cli
```

This builds the CLI (native authority broker + TypeScript) and installs `floe`
globally as a real, independent copy — not a link back to the checkout. Open a
**new** shell afterwards and `floe` works everywhere. To remove it later: `npm
rm -g floe-cli`. See `floe-cli/README.md` for details. Until you run this, invoke
the CLI from source with `node bin/floe.mjs <args>`.

## `floe setup`

```bash
floe setup
```

Run once per machine. It:

- creates `~/.floe/config.yaml` if it doesn't already exist
- starts the [[Services]] (bus, bridge)
- verifies they're healthy
- offers to install auto-start so the machine starts Floe for you (Windows; see [[CLI reference]])
- if the current directory (or an ancestor) already has a `.floe/` folder, registers it as a [[Workspace]] with the bus and seeds the operator Actor

Flags: `--yes` (accept defaults, install auto-start without prompting), `--no-autostart` (skip the auto-start offer), `--repair` (reconcile local service records if something's stuck).

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

Once the native shell opens, it renders a lightweight **Starting Floe…** state immediately and checks the local substrate while it becomes ready. The packaged app verifies the substrate's HTTP health rather than only checking that its port is occupied. If an unresponsive process occupies that port, Floe leaves it untouched and explains the connection failure. If startup fails, the wait is bounded and the app shows a recovery message instead of remaining on the starting screen. After startup, a compact green/amber/red status at the bottom of the navigation continues to reflect the live Bus connection and model-runtime attachment without polling. Opening a failed status shows the packaged process detail and can restart stopped local services without closing the application.

Closing the desktop leaves the local service running. Work can continue through
an authenticated browser session, and reopening the desktop attaches to that
same service. Losing the desktop's console connection does not stop work.

## First-use onboarding

### Browser connection

On the same computer, open the local browser entry to continue working. Floe
connects automatically; no pairing code or approval is required. Reload and
local reconnection also restore access automatically. The local browser can
register a Workspace, including creating its folder, through the same operation
as the desktop app. This also works before the first Workspace exists.

For remote access:

1. Open the browser entry and select **Connect this browser**.
2. In the updated Floe desktop app, choose the Workspace and open **Remote access**.
3. Match the displayed code, select **Allow workspace access**, and accept the native confirmation.
4. Select **Continue** in the browser.

The remote connection request expires after five minutes; access lasts one hour.
Use **Disconnect browser** to revoke it. A substrate restart requires a new remote connection.
The local browser supports provider setup and model settings. Actions requiring
a trusted native confirmation still use the desktop app. The browser entry is
currently served by the source frontend; the
packaged installer does not yet publish a standalone web entry.

An authorization refusal opens this connection flow immediately. It is not
reported as a stopped or stuck local service.

### Desktop onboarding

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

If a message's result is uncertain, the composer keeps the message and its attachments and offers
**Retry send** (or **Retry start** for a new conversation). This checks the original send. Editing
resumes once Floe confirms the result or refuses the send. The desktop app saves the exact selected
attachment content; model actors can inspect supported images when the work requires them.

If local state needs repair, use the bounded repair instruction for the
affected state. Do not delete the whole Floe home or operating-system credential
entry blindly. Workspace identity, history, SecretRefs, and provider credentials
are valuable state; missing or mismatched authority must be shown for explicit
recovery rather than silently replaced.

## Implementation

The desktop installer includes the Node runtime used by Floe, the desktop
companion, and the isolated Command and Extension helper scripts. Together they run the Bus and Bridge as the background
substrate and perform provider-neutral Pi authentication when requested by the
Tauri shell. The native shell loads host authority from the operating-system
vault, passes it privately to a newly started sidecar, obtains a short-lived
Workspace session, and brokers authenticated requests and push events. If an
already-running Bus has incompatible authority, Floe shows recovery required
instead of silently replacing it.

The sidecar build runs the packaged Node executable against both helper scripts
in a temporary directory without the source checkout or npm dependencies. This
checks actual Command invocation and Extension sandbox activation, invocation,
and shutdown. Installer and operator acceptance remain separate checks.

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
