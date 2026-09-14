import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { defaultConfig } from "./config.js";
import { BusStore } from "./store.js";

it("freezes legacy visible attachment history once with explicit provenance and a recovery copy", () => {
  const root = mkdtempSync(join(tmpdir(), "floe-event-history-"));
  const configPath = join(root, "config.yaml");
  const config = defaultConfig(root);
  let store = new BusStore(configPath, config);
  try {
    const workspace = "workspace:history";
    const actor = "actor:history";
    store.registerEndpoint({
      endpoint_id: actor, workspace_id: workspace, name: "History", bridge_id: null, status: "idle",
    }, () => {});
    const artefact = store.artefactStore.createArtefact({
      workspace_id: workspace, type_ref: "core:text", idempotency_key: "brief",
    });
    const versions = ["original", "later"].map(revision => store.artefactStore.publishVersion({
      artefact_id: artefact.artefact_id, idempotency_key: revision,
      content_ref: { kind: "external-revision", resolver_id: "fixture", external_id: "brief", revision },
    }).artefact_version_id);
    const event = store.submitEvent({
      type: "message", workspace_id: workspace, source_endpoint_id: actor,
      destination: { kind: "endpoint", endpoint_id: actor }, content: { text: "Retained history" },
      metadata: { retained: "operator evidence" },
    }, () => {}).event;
    store.artefactStore.associateVersion({
      artefact_version_id: versions[0], target_kind: "event", target_id: event.event_id,
      role: "output", idempotency_key: "legacy-association",
    });
    // Recreate the schema-11 storage boundary; that build projected associations
    // on read, including ones added after the original Event.
    store.db.exec("ALTER TABLE events DROP COLUMN artefact_version_ids_json; PRAGMA user_version = 11;");
    store.close();
    store = new BusStore(configPath, config);
    const frozen = store.getEvent(event.event_id);
    expect(frozen).toEqual({ ...event, artefact_version_ids: [versions[0]], metadata: {
      retained: "operator evidence", artefact_reference_basis: "legacy_projection_at_schema_12",
    } });
    const migration = store.db.prepare("SELECT backup_path FROM schema_migrations ORDER BY schema_version DESC LIMIT 1")
      .get() as { backup_path: string };
    expect(existsSync(migration.backup_path)).toBe(true);
    const backup = new DatabaseSync(migration.backup_path, { readOnly: true });
    try {
      expect(backup.prepare("SELECT content_json FROM events WHERE event_id = ?").get(event.event_id))
        .toEqual({ content_json: JSON.stringify(event.content) });
      expect(backup.prepare("PRAGMA user_version").get()).toEqual({ user_version: 11 });
    } finally { backup.close(); }
    store.artefactStore.associateVersion({
      artefact_version_id: versions[1], target_kind: "event", target_id: event.event_id,
      role: "attachment", idempotency_key: "post-upgrade-association",
    });
    store.close();
    store = new BusStore(configPath, config);
    expect(store.getEvent(event.event_id)).toEqual(frozen);
    const current = store.submitEvent({
      type: "message", workspace_id: workspace, source_endpoint_id: actor,
      destination: { kind: "endpoint", endpoint_id: actor }, content: { text: "Current exact reference" },
      artefact_version_ids: [versions[1]],
    }, () => {}).event;
    expect(store.getEvent(current.event_id)).toEqual(current);
    expect(current.metadata.artefact_reference_basis).toBeUndefined();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
