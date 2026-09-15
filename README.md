# Floe

Floe is a local daemon-driven substrate with two services and one native helper:

- `floe-bus`: canonical identity, authority, semantic operation, Scope
  design/execution, Context, Artefact, Event, and Delivery daemon
- `floe-bridge`: runtime boundary and project `.floe/` loader
- `floe-native-authority`: the native authority broker binary the CLI uses to
  hold the host-control credential and boot the Bus as the trusted host owner

The local development and CI runtime adapter is deterministic fake runtime, so
the core substrate can be tested without spending Copilot premium requests. It
is development-only; real profile-backed execution runs through the
`floe-runtime` bridge adapter, which spawns the official vendor CLI (for
example `copilot --acp`). Floe never sees the model credential — the vendor CLI
owns model authentication.

## Local Start

Floe runs from source. You need Node.js, and — for the one native component, the
authority broker — Rust and `cargo` (install from <https://rustup.rs/>).

```bash
npm install
npm run build --workspace floe-cli          # compiles the native authority broker (needs cargo)
node bin/floe.mjs setup --yes --no-autostart
```

The CLI runs from source through `node bin/floe.mjs`. Do not run it through
`npm run floe` — npm eats any flag it recognises (`--help`, `--workspace`,
`-w`, `--version`) before the flag reaches the CLI, so it is silently dropped.
`node bin/floe.mjs` forwards every flag exactly as typed.

Step 2 is required before first run: the register, seed, and `identity` commands
reach the Bus through the native authority broker. If you skip step 2, `setup`
stops with an error naming this exact build command.

`setup` writes `~/.floe/config.yaml` if missing, starts the Bus and Bridge,
verifies health, and — when the current directory contains a `.floe/` folder —
registers it as a Workspace and seeds the operator Actor. It prints the
registered Workspace id.

Useful commands:

```bash
node bin/floe.mjs status
node bin/floe.mjs stop
node bin/floe.mjs restart
node bin/floe.mjs logs
node bin/floe.mjs service status
```

### Admitting a terminal client identity

An unprivileged client (for example a terminal console) authenticates as a
client-held keypair. Admit its public key to the workspace it may act in. Run
`identity add` from inside the workspace directory and it resolves the workspace
for you — no id to copy:

```bash
node bin/floe.mjs identity generate --name "Console"    # optional: mint a keypair
node bin/floe.mjs identity add --name "Console" --pubkey <npub>
node bin/floe.mjs identity list
```

`identity add` prints which workspace it admitted into. If you run it outside any
registered workspace it lists the registered workspaces with their ids so you can
pass `--workspace <workspace_id>` explicitly.

The client then requests a challenge, signs it, and receives a scoped bearer. The
full on-the-wire protocol — including the request body for emitting a reply as
the operator — is in
[Client identity protocol](docs/reference/client-identity-protocol.md).

## Local repair and breaking changes

Floe is in early development, but Workspace identity, history, SecretRefs,
locator bindings, and provider credentials are valuable state. Do not delete
`~/.floe` or operating-system credential entries as a generic repair step.

Use the repair instruction for the exact failed state. Schema upgrades validate
and back up retained data before destructive work. Missing or mismatched host
authority and provider credentials become visible recovery states; Floe does
not silently replace or copy them.

If a service fails to start with a stale-dependency error, your `node_modules`
is out of date after a version bump — reinstall with `npm install`.

## Validation

```bash
npm run build
npm test
```

The black-box vertical-slice test starts real bus and bridge processes against a
temporary `FLOE_HOME`, registers a project, verifies `.floe/` initialization,
sends a human message, receives fake agent progress/output, and resumes a
waiting fake agent with a later message. It also verifies bus-owned
`wait_refresh` generation and delivery acknowledgement state.

## Runtime Adapter

The fake adapter is the no-login fallback for local development and CI. Real
execution runs through the `floe-runtime` adapter, backed by the official
Copilot SDK. Floe passes its first-session instructions as an appended system
message and exposes Bridge-owned tools directly; it does not broker model
credentials. The ACP path and its local MCP transport are rollback-only
internals, not a user-facing runtime selection. Select it explicitly:

```bash
FLOE_RUNTIME_ADAPTER=floe-runtime
```

Or set `bridge.runtime_adapter: floe-runtime` in `~/.floe/config.yaml` and
restart Floe. Unsupported adapter names fail fast rather than silently falling
back to fake.
