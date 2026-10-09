import type { DatabaseSync } from "node:sqlite";

/**
 * Tables of the removed September 2026 Extension package system. Extensions
 * were redesigned (docs/design/host/extension/extension.md) and keep no Bus
 * tables of this shape. The versioned upgrade backs the database up first.
 */
export const RETIRED_EXTENSION_TABLES: readonly string[] = Object.freeze([
  "extension_runtime_audit",
  "extension_activation_attempts",
  "extension_execution_package_pins",
  "extension_installation_changes",
  "extension_installations",
  "extension_package_versions",
  "canonical_extensions",
]);

/** Idempotent; runs in the upgrade's rebuild step with foreign keys disabled. */
export function dropRetiredExtensionTables(db: DatabaseSync): void {
  for (const table of RETIRED_EXTENSION_TABLES) {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}
