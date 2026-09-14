import type { DatabaseSync } from "node:sqlite";

/**
 * Binds one short-lived operation-authority session to a runtime Delivery.
 * The bearer is never stored here. Terminal state and deletion revoke the
 * referenced session centrally so every Delivery lifecycle path is covered.
 */
export function applyDeliveryOperationAuthoritySchema(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(delivery_bundles)")
    .all() as Array<{ name: string }>;
  if (columns.length === 0) {
    throw new Error("Delivery operation authority requires the delivery_bundles table.");
  }
  if (!columns.some((column) => column.name === "operation_authority_session_id")) {
    db.exec(`
      ALTER TABLE delivery_bundles
      ADD COLUMN operation_authority_session_id TEXT
    `);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_delivery_operation_authority_session
      ON delivery_bundles(operation_authority_session_id)
      WHERE operation_authority_session_id IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS trg_delivery_operation_authority_terminal
    AFTER UPDATE OF state, operation_authority_session_id ON delivery_bundles
    WHEN NEW.operation_authority_session_id IS NOT NULL
      AND NEW.state IN ('acknowledged', 'failed', 'dead_lettered', 'deferred', 'cancelled')
    BEGIN
      UPDATE operation_authority_sessions
      SET revoked_at = COALESCE(
        revoked_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      )
      WHERE authority_session_id = NEW.operation_authority_session_id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_delivery_operation_authority_deleted
    AFTER DELETE ON delivery_bundles
    WHEN OLD.operation_authority_session_id IS NOT NULL
    BEGIN
      UPDATE operation_authority_sessions
      SET revoked_at = COALESCE(
        revoked_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      )
      WHERE authority_session_id = OLD.operation_authority_session_id;
    END;
  `);
}
