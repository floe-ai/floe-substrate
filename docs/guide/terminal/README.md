# Terminal access

**The terminal is a current way to launch a surface and use the Floe substrate.**

Typing `floe` ensures the substrate is reachable and launches a registered
surface. The CLI also manages local services, surface registrations, semantic
operations, and client identities.

Full command detail: [[CLI reference]].

## Direct Bus access

1. Start the local services.
2. Confirm public liveness with `GET http://127.0.0.1:5377/health`.
3. Obtain authority for the exact host or Workspace boundary.
4. Discover the allowed operation.
5. Invoke that operation with an idempotency key for a write and an expected
   resource revision where required.
6. Keep the operation receipt and query it after a timeout or reconnect.

The operation definition owns its input schema, grants, availability,
confirmation, and consequences. A terminal client must not reproduce those
rules or use a legacy raw mutation route as a shortcut.

## Read-only diagnostics

`GET /health` is public. Workspace projections, Context history, execution
projections, and the WebSocket stream require authority for the exact boundary.
The stream authenticates in its first frame and resumes from an opaque cursor.

## Implementation

- `floe-cli/src/cli.ts` - launcher, local services, surfaces, and maintenance
- `floe-cli/src/operations-command.ts` - canonical semantic operations
- `floe-cli/src/identity-command.ts` - client identities
- `floe-bus/src/operation-routes.ts` - semantic-operation transport
- `floe-bus/src/transport-auth.ts` - HTTP and WebSocket authority
