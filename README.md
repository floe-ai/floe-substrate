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
npm run floe -- setup -- --yes --no-autostart
```

Step 2 is required before first run: the register, seed, and `identity` commands
reach the Bus through the native authority broker, and `npm run floe` runs the
CLI from source without building it. If you skip step 2, `setup` stops with an
error naming this exact build command.

`setup` writes `~/.floe/config.yaml` if missing, starts the Bus and Bridge,
verifies health, and — when the current directory contains a `.floe/` folder —
registers it as a Workspace and seeds the operator Actor. It prints the
registered Workspace id.

Useful commands:

```bash
npm run floe -- status
npm run floe -- stop
npm run floe -- restart
npm run floe -- logs
npm run floe -- autostart off
```

When passing CLI flags through `npm run floe`, put `--` before the flags, as in
`npm run floe -- setup -- --yes --no-autostart`. A packaged `floe` binary does
not need the extra separator.

### Admitting a terminal client identity

An unprivileged client (for example a terminal console) authenticates as a
client-held keypair. Admit its public key to the Workspace it may act in — the
`workspace_id` `setup` printed:

```bash
npm run floe -- identity generate --name "Console"    # optional: mint a keypair
npm run floe -- identity add --name "Console" --workspace <workspace_id> --pubkey <npub>
npm run floe -- identity list
```

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
execution runs through the `floe-runtime` adapter, which spawns the official
vendor CLI (for example `copilot --acp`); the vendor CLI owns model
authentication, so Floe brokers no model credentials. Select it explicitly:

```bash
FLOE_RUNTIME_ADAPTER=floe-runtime
```

Or set `bridge.runtime_adapter: floe-runtime` in `~/.floe/config.yaml` and
restart Floe. Unsupported adapter names fail fast rather than silently falling
back to fake.
