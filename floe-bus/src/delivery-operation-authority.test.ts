import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { applyDeliveryOperationAuthoritySchema } from "./delivery-operation-authority.js";

describe("Delivery operation authority schema", () => {
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it("preserves existing Deliveries and revokes their sessions on every terminal boundary", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    db.exec(`
      CREATE TABLE operation_authority_sessions (
        authority_session_id TEXT PRIMARY KEY,
        revoked_at TEXT
      );
      CREATE TABLE delivery_bundles (
        delivery_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        retained_value TEXT NOT NULL
      );
      INSERT INTO operation_authority_sessions VALUES ('session:terminal', NULL);
      INSERT INTO operation_authority_sessions VALUES ('session:deleted', NULL);
      INSERT INTO delivery_bundles VALUES ('delivery:terminal', 'delivered_to_bridge', 'keep-me');
      INSERT INTO delivery_bundles VALUES ('delivery:deleted', 'delivered_to_bridge', 'keep-me-too');
    `);

    applyDeliveryOperationAuthoritySchema(db);
    expect(db.prepare(`
      SELECT delivery_id, state, retained_value, operation_authority_session_id
      FROM delivery_bundles ORDER BY delivery_id
    `).all()).toEqual([
      {
        delivery_id: "delivery:deleted",
        state: "delivered_to_bridge",
        retained_value: "keep-me-too",
        operation_authority_session_id: null,
      },
      {
        delivery_id: "delivery:terminal",
        state: "delivered_to_bridge",
        retained_value: "keep-me",
        operation_authority_session_id: null,
      },
    ]);

    db.prepare(`
      UPDATE delivery_bundles SET operation_authority_session_id = ? WHERE delivery_id = ?
    `).run("session:terminal", "delivery:terminal");
    db.prepare("UPDATE delivery_bundles SET state = 'acknowledged' WHERE delivery_id = ?")
      .run("delivery:terminal");
    expect(db.prepare(`
      SELECT revoked_at FROM operation_authority_sessions WHERE authority_session_id = 'session:terminal'
    `).get()).toEqual({ revoked_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });

    db.prepare(`
      UPDATE delivery_bundles SET operation_authority_session_id = ? WHERE delivery_id = ?
    `).run("session:deleted", "delivery:deleted");
    db.prepare("DELETE FROM delivery_bundles WHERE delivery_id = ?").run("delivery:deleted");
    expect(db.prepare(`
      SELECT revoked_at FROM operation_authority_sessions WHERE authority_session_id = 'session:deleted'
    `).get()).toEqual({ revoked_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
  });
});
