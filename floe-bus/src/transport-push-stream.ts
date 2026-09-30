/**
 * @invariant This store is the durable ordered push ledger. Transactional
 * outbox promotion must atomically append one stream entry and acknowledge the
 * source record so restart recovery cannot lose or duplicate a push.
 */
import type { DatabaseSync } from "node:sqlite";

export type TransportPushEntry = Readonly<{
  cursor: string;
  sequence: number;
  workspace_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  at: string;
}>;

type PushRow = Readonly<{
  sequence: number;
  workspace_id: string | null;
  event_type: string;
  payload_json: string;
  created_at: string;
}>;

const SAFE_FAILURE_MESSAGE_LENGTH = 300;

/**
 * A pushed step failure carries a reason a surface can show: its first line,
 * bounded, so stack frames and long provider output stay in the attempt record.
 */
export function safeFailure(failure: Record<string, unknown>): Record<string, unknown> {
  if (typeof failure.message !== "string") return failure;
  const firstLine = failure.message.split(/\r?\n/, 1)[0]!.trim();
  const message = firstLine.length > SAFE_FAILURE_MESSAGE_LENGTH
    ? firstLine.slice(0, SAFE_FAILURE_MESSAGE_LENGTH - 1) + "…"
    : firstLine;
  return { ...failure, message };
}

/**
 * Durable delivery cursor for transport projections. Canonical domain records
 * remain authoritative; this ledger only lets a disconnected client catch up
 * without polling or guessing what changed.
 */
export class TransportPushStreamStore {
  constructor(readonly db: DatabaseSync) {
    applyTransportPushStreamSchema(db);
  }

  append(input: Readonly<{
    workspace_id: string | null;
    type: string;
    payload: Record<string, unknown>;
    at?: string;
  }>): TransportPushEntry {
    if (!input.type.trim()) throw new Error("Push update type must not be empty.");
    const at = input.at ?? new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO transport_push_entries (workspace_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(input.workspace_id, input.type, JSON.stringify(input.payload), at);
    return this.require(Number(result.lastInsertRowid));
  }

  /**
   * Promotes committed NodeExecution transition records into the replay stream.
   * The insert and outbox acknowledgement share one transaction, so a restart
   * can neither lose a transition nor append it twice.
   */
  drainNodeExecutionStateOutbox(limit = 1_000): TransportPushEntry[] {
    if (!tableExists(this.db, "node_execution_state_outbox")) return [];
    const rows = this.db.prepare(`
      SELECT node_execution_id, state_revision, workspace_id, scope_id,
             scope_execution_id, composition_revision_id, node_id,
             from_status, to_status, attempt_id, delivery_id,
             failure_json, changed_at
      FROM node_execution_state_outbox
      WHERE push_sequence IS NULL
      ORDER BY changed_at, node_execution_id, state_revision
      LIMIT ?
    `).all(Math.min(Math.max(limit, 1), 10_000)) as Array<{
      node_execution_id: string;
      state_revision: number;
      workspace_id: string;
      scope_id: string;
      scope_execution_id: string;
      composition_revision_id: string;
      node_id: string;
      from_status: string | null;
      to_status: string;
      attempt_id: string | null;
      delivery_id: string | null;
      failure_json: string | null;
      changed_at: string;
    }>;
    if (rows.length === 0) return [];
    const sequences: number[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.db.prepare(`
        INSERT INTO transport_push_entries (workspace_id, event_type, payload_json, created_at)
        VALUES (?, 'node_execution_state_changed', ?, ?)
      `);
      const acknowledge = this.db.prepare(`
        UPDATE node_execution_state_outbox SET push_sequence = ?
        WHERE node_execution_id = ? AND state_revision = ? AND push_sequence IS NULL
      `);
      for (const row of rows) {
        const result = insert.run(row.workspace_id, JSON.stringify({
          workspace_id: row.workspace_id,
          scope_id: row.scope_id,
          scope_execution_id: row.scope_execution_id,
          composition_revision_id: row.composition_revision_id,
          node_execution_id: row.node_execution_id,
          node_id: row.node_id,
          state_revision: row.state_revision,
          from_status: row.from_status,
          to_status: row.to_status,
          attempt_id: row.attempt_id,
          delivery_id: row.delivery_id,
          failure: row.failure_json ? safeFailure(JSON.parse(row.failure_json)) : null,
          changed_at: row.changed_at,
        }), row.changed_at);
        const sequence = Number(result.lastInsertRowid);
        acknowledge.run(sequence, row.node_execution_id, row.state_revision);
        sequences.push(sequence);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return sequences.map((sequence) => this.require(sequence));
  }

  drainActorLifecycleOutbox(limit = 1_000): TransportPushEntry[] {
    if (!tableExists(this.db, "actor_lifecycle_push_outbox")) return [];
    const rows = this.db.prepare(`
      SELECT outbox_id, workspace_id, event_type, payload_json, changed_at
      FROM actor_lifecycle_push_outbox
      WHERE push_sequence IS NULL
      ORDER BY outbox_id
      LIMIT ?
    `).all(Math.min(Math.max(limit, 1), 10_000)) as Array<{
      outbox_id: number;
      workspace_id: string;
      event_type: string;
      payload_json: string;
      changed_at: string;
    }>;
    if (rows.length === 0) return [];
    const sequences: number[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.db.prepare(`
        INSERT INTO transport_push_entries (workspace_id, event_type, payload_json, created_at)
        VALUES (?, ?, ?, ?)
      `);
      const acknowledge = this.db.prepare(`
        UPDATE actor_lifecycle_push_outbox SET push_sequence = ?
        WHERE outbox_id = ? AND push_sequence IS NULL
      `);
      for (const row of rows) {
        const result = insert.run(row.workspace_id, row.event_type, row.payload_json, row.changed_at);
        const sequence = Number(result.lastInsertRowid);
        acknowledge.run(sequence, row.outbox_id);
        sequences.push(sequence);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return sequences.map((sequence) => this.require(sequence));
  }

  latestCursor(): string | null {
    const row = this.db.prepare(`
      SELECT sequence FROM transport_push_entries ORDER BY sequence DESC LIMIT 1
    `).get() as { sequence: number } | undefined;
    return row ? encodeTransportPushCursor(row.sequence) : null;
  }

  listAfter(input: Readonly<{
    after_cursor?: string | null;
    workspace_id?: string | null;
    through_sequence?: number;
    limit?: number;
  }>): TransportPushEntry[] {
    const after = decodeTransportPushCursor(input.after_cursor ?? null);
    const through = input.through_sequence ?? Number.MAX_SAFE_INTEGER;
    const limit = Math.min(Math.max(input.limit ?? 10_000, 1), 10_000);
    const rows = input.workspace_id
      ? this.db.prepare(`
          SELECT sequence, workspace_id, event_type, payload_json, created_at
          FROM transport_push_entries
          WHERE sequence > ? AND sequence <= ? AND workspace_id = ?
          ORDER BY sequence ASC
          LIMIT ?
        `).all(after, through, input.workspace_id, limit) as PushRow[]
      : this.db.prepare(`
          SELECT sequence, workspace_id, event_type, payload_json, created_at
          FROM transport_push_entries
          WHERE sequence > ? AND sequence <= ?
          ORDER BY sequence ASC
          LIMIT ?
        `).all(after, through, limit) as PushRow[];
    return rows.map(rowToEntry);
  }

  latestSequence(): number {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence FROM transport_push_entries
    `).get() as { sequence: number };
    return Number(row.sequence);
  }

  cursorForSequence(sequence: number): string | null {
    return sequence > 0 ? encodeTransportPushCursor(sequence) : null;
  }

  getBridgeCheckpoint(bridgeId: string): string | null {
    const row = this.db.prepare(`
      SELECT sequence FROM transport_push_checkpoints
      WHERE audience = 'bridge_service' AND binding_id = ?
    `).get(bridgeId) as { sequence: number } | undefined;
    return row ? encodeTransportPushCursor(Number(row.sequence)) : null;
  }

  acknowledgeBridge(bridgeId: string, cursor: string): string {
    if (!bridgeId.trim()) throw new Error("Bridge identity must not be empty.");
    const sequence = decodeTransportPushCursor(cursor);
    if (sequence > this.latestSequence()) throw new InvalidTransportPushCursorError();
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO transport_push_checkpoints (
        audience, binding_id, sequence, updated_at
      ) VALUES ('bridge_service', ?, ?, ?)
      ON CONFLICT(audience, binding_id) DO UPDATE SET
        sequence = CASE
          WHEN excluded.sequence > transport_push_checkpoints.sequence
          THEN excluded.sequence
          ELSE transport_push_checkpoints.sequence
        END,
        updated_at = CASE
          WHEN excluded.sequence > transport_push_checkpoints.sequence
          THEN excluded.updated_at
          ELSE transport_push_checkpoints.updated_at
        END
    `).run(bridgeId, sequence, updatedAt);
    return this.getBridgeCheckpoint(bridgeId) ?? encodeTransportPushCursor(0);
  }

  private require(sequence: number): TransportPushEntry {
    const row = this.db.prepare(`
      SELECT sequence, workspace_id, event_type, payload_json, created_at
      FROM transport_push_entries WHERE sequence = ?
    `).get(sequence) as PushRow | undefined;
    if (!row) throw new Error("Push update was not persisted.");
    return rowToEntry(row);
  }
}

export class InvalidTransportPushCursorError extends Error {
  constructor() {
    super("The push stream cursor is invalid.");
    this.name = "InvalidTransportPushCursorError";
  }
}

export function applyTransportPushStreamSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transport_push_entries (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_transport_push_workspace_sequence
      ON transport_push_entries(workspace_id, sequence);

    CREATE TABLE IF NOT EXISTS transport_push_checkpoints (
      audience TEXT NOT NULL CHECK (audience = 'bridge_service'),
      binding_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (audience, binding_id)
    );
  `);
}

export function encodeTransportPushCursor(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new InvalidTransportPushCursorError();
  return Buffer.from(JSON.stringify({ v: 1, sequence }), "utf8").toString("base64url");
}

export function decodeTransportPushCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      !decoded
      || typeof decoded !== "object"
      || (decoded as Record<string, unknown>).v !== 1
      || !Number.isSafeInteger((decoded as Record<string, unknown>).sequence)
      || Number((decoded as Record<string, unknown>).sequence) < 0
    ) {
      throw new InvalidTransportPushCursorError();
    }
    return Number((decoded as Record<string, unknown>).sequence);
  } catch (error) {
    if (error instanceof InvalidTransportPushCursorError) throw error;
    throw new InvalidTransportPushCursorError();
  }
}

function rowToEntry(row: PushRow): TransportPushEntry {
  const payload = JSON.parse(row.payload_json) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Stored push update payload is invalid.");
  }

  return {
    cursor: encodeTransportPushCursor(Number(row.sequence)),
    sequence: Number(row.sequence),
    workspace_id: row.workspace_id,
    type: row.event_type,
    payload: payload as Record<string, unknown>,
    at: row.created_at,
  };
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table));
}
