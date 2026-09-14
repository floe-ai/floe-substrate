/**
 * Shared types for Floe workspace tools.
 */

import type { RuntimeOperationAuthoritySession } from "../bus-client.js";

export type ToolActivityEntry = {
  name: string;
  call_id?: string;
  summary?: string;
  is_error?: boolean;
  files_touched?: string[];
  duration_ms?: number;
};

export type ActiveToolTurn = {
  tool_activity: ToolActivityEntry[];
  context_id?: string | null;
  delivery_id?: string;
  processing_contract_id?: string;
  operation_authority_session?: RuntimeOperationAuthoritySession;
};

/**
 * Context provided to every workspace tool factory.
 * Gives tools access to the workspace root and the active turn
 * for enriching tool activity records.
 */
export type ToolContext = {
  workspaceRoot: string;
  getActiveTurn?: () => ActiveToolTurn | undefined;
};
