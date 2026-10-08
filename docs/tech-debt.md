# Tech Debt — removal queue

Per the pre-release stance in `docs/contributing/working-rules.md`: zero tech-debt accumulation, no
migration paths. This file is a **removal queue**, not a parking lot. Entries are
scheduled deletions, not deferred maybe-laters — burn them down; do not let this
list grow.

## Migration / back-compat scaffolding in floe-bus

`floe-bus/src/store.ts` carries data-migration and backward-compatibility
machinery that the pre-release rule says we do not need (no external data, no
consumers — local dev databases can simply be recreated):

- `relaxEventScopeColumn()` and the `events_next` table rebuild
- `addColumnIfMissing()` calls and the `backfill*` methods
  (`backfillEventDestinationJson`, `backfillEventResponseJson`,
  `backfillEventScopeId`)
- legacy `NULLIF(scope_id, 'default')` / reserved-id cleanup paths
- the `is_default` `DROP INDEX` cleanup added during Slice 2

**Action:** collapse the schema to a single authoritative `CREATE TABLE` set and
delete the migration/backfill paths; recreate local databases rather than
migrate them.

**When:** after the three UI substrate gaps land, so the schema changes once,
cleanly — not piecemeal before. Recorded by operator decision 2026-06-14.

## Remove `migrateWebToApp` config shim

`floe-bus/src/config.ts`, `floe-bridge/src/config.ts`, and `floe-cli/src/config.ts`
each contain a `migrateWebToApp()` function that rewrites on-disk configs still
using the old `web:` / `services.start_web` keys (from before the `app:` rename
in PR #62). The shim is idempotent and becomes a no-op after the first run, but
it is back-compat migration scaffolding that the pre-release rule says we do not
need.

**Action:** once enough time has passed that no local installs carry the old
format, delete `migrateWebToApp` from all three config files and remove the
matching migration tests in `floe-bus/src/config-migration.test.ts` and
`floe-bridge/src/config-migration.test.ts`.

## Remove the `Thread` primitive (approved 2026-06-14)

**Completed in `fm/remove-thread-primitive`:** removed the `threads` table, thread storage, HTTP and bridge APIs, lifecycle hook/session eviction, side-thread resolver state, and associated tests. Runtime Rule 3 now opens an independent peer context containing `{source, destination}` and records the origin in `parent_context_id`; the origin context remains unchanged.

**Deferred to the schema collapse above:** retain `events.thread_id` (including its `NOT NULL` constraint), `pending_responses.thread_id`, and `thread_affine`. They are still read by the event filter/deserialiser and response matching. `submitEvent` preserves a supplied `thread_id` and falls back to the resolved `context_id` only when it is absent.

