import type { DatabaseSync } from "node:sqlite";

/**
 * Tables of removed mechanisms. The versioned upgrade backs the database up
 * before they are dropped.
 *
 * - The September 2026 Extension package system; Extensions were redesigned
 *   (docs/design/host/extension/extension.md).
 * - Connector actions and their outside-effect receipts; a Connector has no
 *   actions (docs/design/workspace/connector.md), and a Command decides how
 *   it handles retries and unclear outcomes.
 */
export const RETIRED_TABLES: readonly string[] = Object.freeze([
  "extension_runtime_audit",
  "extension_activation_attempts",
  "extension_execution_package_pins",
  "extension_installation_changes",
  "extension_installations",
  "extension_package_versions",
  "canonical_extensions",
  "external_action_reconciliations",
  "external_action_attempts",
  "external_effect_receipts",
]);

/** Idempotent; runs in the upgrade's rebuild step with foreign keys disabled. */
export function dropRetiredTables(db: DatabaseSync): void {
  for (const table of RETIRED_TABLES) {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}