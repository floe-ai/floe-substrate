# Floe

Floe is a local daemon-driven substrate with three independent services:

- `floe-bus`: canonical identity, authority, semantic operation, Scope
  design/execution, Context, Artefact, Event, and Delivery daemon
- `floe-bridge`: runtime boundary and project `.floe/` loader
- `floe-app`: chat-first operator surface with a trusted native transport
  broker

The local development and CI runtime adapter is deterministic fake runtime, so
the core substrate can be tested without spending Copilot premium requests. It
is development-only; real profile-backed execution runs through the
`pi-agent-core` bridge adapter.

## Local Start

```bash
npm install
npm run floe -- setup -- --no-autostart --no-open
```

Open the trusted desktop client:

```bash
npm run floe -- desktop
```

The React development server may still run at `http://127.0.0.1:5379`, but
loopback access does not grant Bus authority. A standalone browser needs an
authenticated session adapter; normal product use goes through the Tauri native
broker.

Useful commands:

```bash
npm run floe -- status
npm run floe -- stop
npm run floe -- restart
npm run floe -- logs
npm run floe -- autostart off
```

When passing CLI flags through `npm run floe`, put `--` before the flags, as in
`npm run floe -- setup -- --no-autostart --no-open`. A packaged `floe` binary
does not need the extra separator.

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

The fake adapter is the no-login fallback for local development and CI. Once a
real auth profile is configured, Floe selects the Pi lower-layer adapter
automatically. You can also force it explicitly:

```bash
FLOE_RUNTIME_ADAPTER=pi-agent-core
```

Or set `bridge.runtime_adapter: pi-agent-core` in `~/.floe/config.yaml` and
restart Floe. Unsupported adapter names fail fast rather than silently falling
back to fake.
