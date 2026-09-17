# Working without floe-app

**Normal operator work uses floe-app. Terminal and direct Bus access are authenticated developer and integration surfaces.**

The `floe` CLI starts and diagnoses local services, manages local authentication,
and performs maintenance. The Bus exposes read-only projections and the same
semantic operations used by the app and Actors. Direct HTTP access is not an
unauthenticated shortcut around authority or validation.

## What the CLI covers

- `floe setup`, `floe start`, `floe stop`, `floe restart`, `floe status`,
  and `floe logs`
- `floe login`, `floe logout`, `floe auth list`, and `floe auth doctor`; login
  and logout use the packaged native authority broker and logout presents the
  same Bus-authored confirmation as the app
- `floe config path` and `floe config edit`
- `floe up`, `floe service install|uninstall|status`, and
  `floe surface list|register|remove`
- `floe doctor`, `floe reset`, and `floe uninstall`

Full detail: [[CLI reference]].

## What direct Bus use requires

1. Start the local services.
2. Confirm public liveness with `GET http://127.0.0.1:5377/health`.
3. Obtain an appropriate authenticated session through a trusted client or
   integration adapter. Floe does not print reusable host or provider
   credentials for copying into commands.
4. Discover the allowed operation through the routes in [[Bus API]].
5. Invoke that exact operation. Supply an idempotency key for a write so a
   retry replays safely, and the expected resource revision where required; a
   read needs neither.
6. Keep the operation receipt and query it after a timeout or reconnect.

The operation definition owns the input schema, grants, availability,
confirmation, and consequences. A terminal client must not reproduce those
rules or use a legacy raw mutation route as a shortcut.

## Read-only diagnostics

`GET /health` is public. Workspace projections, Context history, execution
projections, and the WebSocket stream require authority for the exact boundary.
The stream authenticates in its first frame and resumes from an opaque cursor.

Developer diagnostics may expose lower-level evidence that is not a product
operation. They remain observatory surfaces and do not establish another write
contract.

## Implementation

- `floe-cli/src/cli.ts` — local service, authentication, and maintenance
  commands
- `floe-bus/src/operation-routes.ts` — canonical semantic-operation transport
- `floe-bus/src/transport-auth.ts` — HTTP and WebSocket authority
- `floe-bus/src/server.ts` — projections and internal/legacy transport routes
