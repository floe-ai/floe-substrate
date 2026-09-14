import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  PolicyBindingSubject,
  PolicyEvaluationRecord,
} from "./policies.js";

export type BudgetSourceRef = Readonly<{
  kind: "operation_invocation" | "execution_attempt" | "connector_action" | "extension_activation";
  id: string;
}>;

export type ResourceUsageFacts = Readonly<{
  workspace_id: string;
  principal_id: string;
  operation_id: string;
  scope_id: string | null;
  scope_execution_id: string | null;
  actor_id: string | null;
  scope_composition_revision_id: string | null;
  node_placement_id: string | null;
  connector_binding_id: string | null;
  extension_installation_id: string | null;
}>;

export type BudgetReservationItem = Readonly<{
  reservation_item_id: string;
  reservation_id: string;
  policy_revision_id: string;
  policy_binding_id: string;
  rule_id: string;
  subject: PolicyBindingSubject;
  metric: string;
  maximum: number;
  window: PolicyEvaluationRecord["budget_limits"][number]["window"];
  timezone: string | null;
  window_start: string | null;
  window_end: string | null;
  estimated_amount: number;
}>;

export type BudgetReservationRecord = Readonly<{
  reservation_id: string;
  workspace_id: string;
  source: BudgetSourceRef;
  policy_evaluation_id: string;
  facts: ResourceUsageFacts;
  estimates: Readonly<Record<string, number>>;
  state: "reserved" | "committed" | "released" | "outcome_unknown" | "exceeded";
  idempotency_digest: string;
  actual_usage_digest: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  items: readonly BudgetReservationItem[];
}>;

export type ResourceUsageEntry = Readonly<{
  usage_entry_id: string;
  workspace_id: string;
  source: BudgetSourceRef;
  principal_id: string;
  operation_id: string;
  scope_id: string | null;
  scope_execution_id: string | null;
  actor_id: string | null;
  scope_composition_revision_id: string | null;
  node_placement_id: string | null;
  connector_binding_id: string | null;
  extension_installation_id: string | null;
  metric: string;
  amount: number;
  observed_at: string;
}>;

type ReservationRow = Readonly<{
  reservation_id: string;
  workspace_id: string;
  source_kind: BudgetSourceRef["kind"];
  source_id: string;
  policy_evaluation_id: string;
  facts_json: string;
  estimates_json: string;
  state: BudgetReservationRecord["state"];
  idempotency_digest: string;
  actual_usage_digest: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}>;

type ReservationItemRow = Readonly<{
  reservation_item_id: string;
  reservation_id: string;
  policy_revision_id: string;
  policy_binding_id: string;
  rule_id: string;
  subject_kind: PolicyBindingSubject["kind"];
  subject_id: string;
  subject_revision_id: string;
  metric: string;
  maximum: number;
  window: BudgetReservationItem["window"];
  timezone: string | null;
  window_start: string | null;
  window_end: string | null;
  estimated_amount: number;
}>;

type UsageRow = Readonly<{
  usage_entry_id: string;
  workspace_id: string;
  source_kind: BudgetSourceRef["kind"];
  source_id: string;
  principal_id: string;
  operation_id: string;
  scope_id: string | null;
  scope_execution_id: string | null;
  actor_id: string | null;
  scope_composition_revision_id: string | null;
  node_placement_id: string | null;
  connector_binding_id: string | null;
  extension_installation_id: string | null;
  metric: string;
  amount: number;
  observed_at: string;
}>;

export class BudgetValidationError extends Error {
  readonly code = "E_BUDGET_INVALID" as const;
  constructor(readonly reason: string) {
    super(`Invalid budget request: ${reason}`);
    this.name = "BudgetValidationError";
  }
}

export class BudgetExceededError extends Error {
  readonly code = "E_BUDGET_EXCEEDED" as const;
  constructor(
    readonly metric: string,
    readonly subject: PolicyBindingSubject,
    readonly maximum: number,
    readonly committed: number,
    readonly reserved: number,
    readonly requested: number,
  ) {
    super(`Budget '${metric}' for ${subject.kind}:${subject.id} would exceed ${maximum}.`);
    this.name = "BudgetExceededError";
  }
}

export class BudgetConflictError extends Error {
  readonly code = "E_BUDGET_CONFLICT" as const;
  constructor(readonly source: BudgetSourceRef, readonly reason: string) {
    super(`Budget source '${source.kind}:${source.id}' conflicts: ${reason}`);
    this.name = "BudgetConflictError";
  }
}

export function applyBudgetSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS budget_reservations (
      reservation_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('operation_invocation', 'execution_attempt', 'connector_action', 'extension_activation')),
      source_id TEXT NOT NULL,
      policy_evaluation_id TEXT NOT NULL REFERENCES policy_evaluations(evaluation_id),
      facts_json TEXT NOT NULL,
      estimates_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'committed', 'released', 'outcome_unknown', 'exceeded')),
      idempotency_digest TEXT NOT NULL,
      actual_usage_digest TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(workspace_id, source_kind, source_id)
    );

    CREATE INDEX IF NOT EXISTS idx_budget_reservations_state
      ON budget_reservations(workspace_id, state, created_at);

    CREATE TABLE IF NOT EXISTS budget_reservation_items (
      reservation_item_id TEXT PRIMARY KEY,
      reservation_id TEXT NOT NULL REFERENCES budget_reservations(reservation_id),
      policy_revision_id TEXT NOT NULL,
      policy_binding_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('workspace', 'scope', 'actor', 'node_placement', 'connector_binding', 'extension_installation')),
      subject_id TEXT NOT NULL,
      subject_revision_id TEXT NOT NULL DEFAULT '',
      metric TEXT NOT NULL,
      maximum REAL NOT NULL CHECK (maximum >= 0),
      window TEXT NOT NULL CHECK (window IN ('operation', 'scope_execution', 'day', 'month', 'all_time')),
      timezone TEXT,
      window_start TEXT,
      window_end TEXT,
      estimated_amount REAL NOT NULL CHECK (estimated_amount >= 0),
      UNIQUE(reservation_id, policy_binding_id, rule_id, subject_kind, subject_id, subject_revision_id, metric, window)
    );

    CREATE INDEX IF NOT EXISTS idx_budget_reservation_items_accounting
      ON budget_reservation_items(subject_kind, subject_id, metric, window, window_start, window_end);

    CREATE TABLE IF NOT EXISTS resource_usage_entries (
      usage_entry_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('operation_invocation', 'execution_attempt', 'connector_action', 'extension_activation')),
      source_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      scope_id TEXT,
      scope_execution_id TEXT,
      actor_id TEXT,
      scope_composition_revision_id TEXT,
      node_placement_id TEXT,
      connector_binding_id TEXT,
      extension_installation_id TEXT,
      metric TEXT NOT NULL,
      amount REAL NOT NULL CHECK (amount >= 0),
      observed_at TEXT NOT NULL,
      UNIQUE(workspace_id, source_kind, source_id, metric)
    );

    CREATE INDEX IF NOT EXISTS idx_resource_usage_workspace_metric
      ON resource_usage_entries(workspace_id, metric, observed_at);
    CREATE INDEX IF NOT EXISTS idx_resource_usage_scope
      ON resource_usage_entries(workspace_id, scope_id, metric, observed_at);
    CREATE INDEX IF NOT EXISTS idx_resource_usage_scope_execution
      ON resource_usage_entries(workspace_id, scope_execution_id, metric, observed_at);
    CREATE INDEX IF NOT EXISTS idx_resource_usage_actor
      ON resource_usage_entries(workspace_id, actor_id, metric, observed_at);
    CREATE INDEX IF NOT EXISTS idx_resource_usage_node
      ON resource_usage_entries(workspace_id, scope_composition_revision_id, node_placement_id, metric, observed_at);
    CREATE INDEX IF NOT EXISTS idx_resource_usage_connector
      ON resource_usage_entries(workspace_id, connector_binding_id, metric, observed_at);
    CREATE INDEX IF NOT EXISTS idx_resource_usage_extension
      ON resource_usage_entries(workspace_id, extension_installation_id, metric, observed_at);
  `);
  const itemColumns = new Set(
    (db.prepare("PRAGMA table_info(budget_reservation_items)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!itemColumns.has("subject_revision_id")) {
    db.exec("ALTER TABLE budget_reservation_items ADD COLUMN subject_revision_id TEXT NOT NULL DEFAULT ''");
  }
  const usageColumns = new Set(
    (db.prepare("PRAGMA table_info(resource_usage_entries)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!usageColumns.has("scope_composition_revision_id")) {
    db.exec("ALTER TABLE resource_usage_entries ADD COLUMN scope_composition_revision_id TEXT");
  }
}

export class BudgetStore {
  private readonly now: () => string;

  constructor(
    readonly db: DatabaseSync,
    dependencies: Readonly<{ now?: () => string }> = {},
  ) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  reserve(input: Readonly<{
    source: BudgetSourceRef;
    evaluation: PolicyEvaluationRecord;
    facts: ResourceUsageFacts;
    estimates: Readonly<Record<string, number>>;
  }>): BudgetReservationRecord | null {
    if (input.evaluation.workspace_id !== input.facts.workspace_id) {
      throw new BudgetValidationError("Policy evaluation and usage facts belong to different Workspaces");
    }
    if (!input.evaluation.facts) {
      throw new BudgetValidationError("Policy evaluation does not retain the exact facts required for a reservation");
    }
    if (input.evaluation.decision === "deny") {
      throw new BudgetValidationError("a denied Policy evaluation cannot reserve resources");
    }
    const source = normalizeSource(input.source);
    const facts = normalizeFacts(input.facts);
    assertEvaluationMatchesUsage(input.evaluation.facts, facts);
    const estimates = normalizeUsage(input.estimates, "estimate");
    if (input.evaluation.budget_limits.length === 0) return null;
    const requestDigest = digest({
      source,
      policy_evaluation_id: input.evaluation.evaluation_id,
      facts,
      estimates,
      limits: input.evaluation.budget_limits,
    });
    const existing = this.getBySource(facts.workspace_id, source);
    if (existing) {
      if (existing.idempotency_digest !== requestDigest) {
        throw new BudgetConflictError(source, "the source was already reserved with different facts or limits");
      }
      return existing;
    }

    const at = this.now();
    const reservationId = `budget_reservation_${randomUUID()}`;
    return inSavepoint(this.db, "reserve_budget", () => {
      const items = input.evaluation.budget_limits.map((limit) => {
        const estimatedAmount = estimates[limit.metric];
        if (estimatedAmount === undefined) {
          throw new BudgetValidationError(`estimate for constrained metric '${limit.metric}' is required`);
        }
        const bounds = budgetWindowBounds(limit.window, limit.timezone ?? null, at, facts);
        const committed = this.committedAmount({
          workspace_id: facts.workspace_id,
          subject: limit.subject,
          metric: limit.metric,
          window: limit.window,
          bounds,
          scope_execution_id: facts.scope_execution_id,
        });
        const reserved = this.reservedAmount({
          workspace_id: facts.workspace_id,
          subject: limit.subject,
          metric: limit.metric,
          window: limit.window,
          bounds,
          scope_execution_id: facts.scope_execution_id,
          excluding_reservation_id: null,
        });
        if (committed + reserved + estimatedAmount > limit.maximum) {
          throw new BudgetExceededError(
            limit.metric,
            limit.subject,
            limit.maximum,
            committed,
            reserved,
            estimatedAmount,
          );
        }
        return {
          reservation_item_id: `budget_reservation_item_${randomUUID()}`,
          reservation_id: reservationId,
          policy_revision_id: limit.policy_revision_id,
          policy_binding_id: limit.policy_binding_id,
          rule_id: limit.rule_id,
          subject: limit.subject,
          metric: limit.metric,
          maximum: limit.maximum,
          window: limit.window,
          timezone: limit.timezone ?? null,
          window_start: bounds.start,
          window_end: bounds.end,
          estimated_amount: estimatedAmount,
        } satisfies BudgetReservationItem;
      });
      this.db.prepare(`
        INSERT INTO budget_reservations (
          reservation_id, workspace_id, source_kind, source_id,
          policy_evaluation_id, facts_json, estimates_json, state,
          idempotency_digest, actual_usage_digest,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, NULL, ?, ?, NULL)
      `).run(
        reservationId,
        facts.workspace_id,
        source.kind,
        source.id,
        input.evaluation.evaluation_id,
        JSON.stringify(facts),
        JSON.stringify(estimates),
        requestDigest,
        at,
        at,
      );
      const statement = this.db.prepare(`
        INSERT INTO budget_reservation_items (
          reservation_item_id, reservation_id, policy_revision_id, policy_binding_id,
          rule_id, subject_kind, subject_id, subject_revision_id, metric, maximum, window, timezone,
          window_start, window_end, estimated_amount
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        statement.run(
          item.reservation_item_id,
          item.reservation_id,
          item.policy_revision_id,
          item.policy_binding_id,
          item.rule_id,
          item.subject.kind,
          item.subject.id,
          item.subject.composition_revision_id ?? "",
          item.metric,
          item.maximum,
          item.window,
          item.timezone,
          item.window_start,
          item.window_end,
          item.estimated_amount,
        );
      }
      return this.requireReservation(reservationId);
    });
  }

  commit(input: Readonly<{
    workspace_id: string;
    reservation_id: string;
    actual_usage: Readonly<Record<string, number>>;
  }>): BudgetReservationRecord {
    const reservation = this.requireReservationForWorkspace(input.reservation_id, input.workspace_id);
    const actual = normalizeUsage(input.actual_usage, "actual usage");
    const actualDigest = digest(actual);
    if (reservation.state === "committed" || reservation.state === "exceeded") {
      if (reservation.actual_usage_digest !== actualDigest) {
        throw new BudgetConflictError(reservation.source, "actual usage changed after it was committed");
      }
      return reservation;
    }
    if (reservation.state === "released") {
      throw new BudgetConflictError(reservation.source, "a released reservation cannot be committed");
    }
    const observedAt = this.now();
    return inSavepoint(this.db, "commit_budget", () => {
      let exceeded = false;
      for (const item of reservation.items) {
        const amount = actual[item.metric];
        if (amount === undefined) {
          throw new BudgetValidationError(`actual usage for constrained metric '${item.metric}' is required`);
        }
        const committed = this.committedAmount({
          workspace_id: reservation.workspace_id,
          subject: item.subject,
          metric: item.metric,
          window: item.window,
          bounds: { start: item.window_start, end: item.window_end },
          scope_execution_id: reservation.facts.scope_execution_id,
        });
        const reserved = this.reservedAmount({
          workspace_id: reservation.workspace_id,
          subject: item.subject,
          metric: item.metric,
          window: item.window,
          bounds: { start: item.window_start, end: item.window_end },
          scope_execution_id: reservation.facts.scope_execution_id,
          excluding_reservation_id: reservation.reservation_id,
        });
        if (committed + reserved + amount > item.maximum) exceeded = true;
      }
      for (const [metric, amount] of Object.entries(actual)) {
        this.db.prepare(`
          INSERT INTO resource_usage_entries (
            usage_entry_id, workspace_id, source_kind, source_id,
            principal_id, operation_id, scope_id, scope_execution_id,
            actor_id, scope_composition_revision_id, node_placement_id, connector_binding_id, extension_installation_id,
            metric, amount, observed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `resource_usage_${randomUUID()}`,
          reservation.workspace_id,
          reservation.source.kind,
          reservation.source.id,
          reservation.facts.principal_id,
          reservation.facts.operation_id,
          reservation.facts.scope_id,
          reservation.facts.scope_execution_id,
          reservation.facts.actor_id,
          reservation.facts.scope_composition_revision_id,
          reservation.facts.node_placement_id,
          reservation.facts.connector_binding_id,
          reservation.facts.extension_installation_id,
          metric,
          amount,
          observedAt,
        );
      }
      this.db.prepare(`
        UPDATE budget_reservations
        SET state = ?, actual_usage_digest = ?, updated_at = ?, completed_at = ?
        WHERE reservation_id = ? AND workspace_id = ?
          AND state IN ('reserved', 'outcome_unknown')
      `).run(
        exceeded ? "exceeded" : "committed",
        actualDigest,
        observedAt,
        observedAt,
        reservation.reservation_id,
        reservation.workspace_id,
      );
      return this.requireReservation(reservation.reservation_id);
    });
  }

  release(input: Readonly<{ workspace_id: string; reservation_id: string }>): BudgetReservationRecord {
    const reservation = this.requireReservationForWorkspace(input.reservation_id, input.workspace_id);
    if (reservation.state === "released") return reservation;
    if (reservation.state !== "reserved") {
      throw new BudgetConflictError(reservation.source, `a ${reservation.state} reservation cannot be released`);
    }
    const at = this.now();
    this.db.prepare(`
      UPDATE budget_reservations SET state = 'released', updated_at = ?, completed_at = ?
      WHERE reservation_id = ? AND workspace_id = ? AND state = 'reserved'
    `).run(at, at, reservation.reservation_id, reservation.workspace_id);
    return this.requireReservation(reservation.reservation_id);
  }

  markOutcomeUnknown(input: Readonly<{ workspace_id: string; reservation_id: string }>): BudgetReservationRecord {
    const reservation = this.requireReservationForWorkspace(input.reservation_id, input.workspace_id);
    if (reservation.state === "outcome_unknown") return reservation;
    if (reservation.state !== "reserved") {
      throw new BudgetConflictError(reservation.source, `a ${reservation.state} reservation cannot become outcome_unknown`);
    }
    this.db.prepare(`
      UPDATE budget_reservations SET state = 'outcome_unknown', updated_at = ?
      WHERE reservation_id = ? AND workspace_id = ? AND state = 'reserved'
    `).run(this.now(), reservation.reservation_id, reservation.workspace_id);
    return this.requireReservation(reservation.reservation_id);
  }

  reconcileNoEffect(input: Readonly<{ workspace_id: string; reservation_id: string }>): BudgetReservationRecord {
    const reservation = this.requireReservationForWorkspace(input.reservation_id, input.workspace_id);
    if (reservation.state === "released") return reservation;
    if (reservation.state !== "outcome_unknown") {
      throw new BudgetConflictError(reservation.source, `only outcome_unknown can be reconciled as no effect`);
    }
    const at = this.now();
    this.db.prepare(`
      UPDATE budget_reservations SET state = 'released', updated_at = ?, completed_at = ?
      WHERE reservation_id = ? AND workspace_id = ? AND state = 'outcome_unknown'
    `).run(at, at, reservation.reservation_id, reservation.workspace_id);
    return this.requireReservation(reservation.reservation_id);
  }

  getReservation(reservationId: string): BudgetReservationRecord | null {
    const row = this.db.prepare("SELECT * FROM budget_reservations WHERE reservation_id = ?")
      .get(reservationId) as ReservationRow | undefined;
    return row ? this.mapReservation(row) : null;
  }

  requireReservation(reservationId: string): BudgetReservationRecord {
    const record = this.getReservation(reservationId);
    if (!record) throw new BudgetValidationError(`reservation '${reservationId}' was not found`);
    return record;
  }

  requireReservationForWorkspace(reservationId: string, workspaceId: string): BudgetReservationRecord {
    const record = this.requireReservation(reservationId);
    if (record.workspace_id !== workspaceId) throw new BudgetValidationError(`reservation '${reservationId}' was not found`);
    return record;
  }

  getBySource(workspaceId: string, source: BudgetSourceRef): BudgetReservationRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM budget_reservations
      WHERE workspace_id = ? AND source_kind = ? AND source_id = ?
    `).get(workspaceId, source.kind, source.id) as ReservationRow | undefined;
    return row ? this.mapReservation(row) : null;
  }

  listReservations(workspaceId: string, options: Readonly<{ state?: BudgetReservationRecord["state"] }> = {}): BudgetReservationRecord[] {
    const rows = options.state
      ? this.db.prepare(`
          SELECT * FROM budget_reservations WHERE workspace_id = ? AND state = ?
          ORDER BY created_at DESC, reservation_id DESC
        `).all(workspaceId, options.state) as ReservationRow[]
      : this.db.prepare(`
          SELECT * FROM budget_reservations WHERE workspace_id = ?
          ORDER BY created_at DESC, reservation_id DESC
        `).all(workspaceId) as ReservationRow[];
    return rows.map((row) => this.mapReservation(row));
  }

  listUsage(workspaceId: string, options: Readonly<{ metric?: string; limit?: number }> = {}): ResourceUsageEntry[] {
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 500);
    const rows = options.metric
      ? this.db.prepare(`
          SELECT * FROM resource_usage_entries WHERE workspace_id = ? AND metric = ?
          ORDER BY observed_at DESC, usage_entry_id DESC LIMIT ?
        `).all(workspaceId, options.metric, limit) as UsageRow[]
      : this.db.prepare(`
          SELECT * FROM resource_usage_entries WHERE workspace_id = ?
          ORDER BY observed_at DESC, usage_entry_id DESC LIMIT ?
        `).all(workspaceId, limit) as UsageRow[];
    return rows.map(mapUsage);
  }

  private committedAmount(input: Readonly<{
    workspace_id: string;
    subject: PolicyBindingSubject;
    metric: string;
    window: BudgetReservationItem["window"];
    bounds: Readonly<{ start: string | null; end: string | null }>;
    scope_execution_id: string | null;
  }>): number {
    if (input.window === "operation") return 0;
    const subjectColumn = usageSubjectColumn(input.subject.kind);
    const clauses = ["workspace_id = ?", `${subjectColumn} = ?`, "metric = ?"];
    const values: string[] = [input.workspace_id, input.subject.id, input.metric];
    if (input.subject.kind === "node_placement") {
      clauses.push("scope_composition_revision_id = ?");
      values.push(input.subject.composition_revision_id ?? "");
    }
    if (input.window === "scope_execution") {
      if (!input.scope_execution_id) throw new BudgetValidationError("scope_execution budget requires a ScopeExecution");
      clauses.push("scope_execution_id = ?");
      values.push(input.scope_execution_id);
    }
    if (input.bounds.start) {
      clauses.push("observed_at >= ?");
      values.push(input.bounds.start);
    }
    if (input.bounds.end) {
      clauses.push("observed_at < ?");
      values.push(input.bounds.end);
    }
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS amount
      FROM resource_usage_entries WHERE ${clauses.join(" AND ")}
    `).get(...values) as { amount: number };
    return Number(row.amount);
  }

  private reservedAmount(input: Readonly<{
    workspace_id: string;
    subject: PolicyBindingSubject;
    metric: string;
    window: BudgetReservationItem["window"];
    bounds: Readonly<{ start: string | null; end: string | null }>;
    scope_execution_id: string | null;
    excluding_reservation_id: string | null;
  }>): number {
    if (input.window === "operation") return 0;
    const clauses = [
      "r.workspace_id = ?",
      "i.subject_kind = ?",
      "i.subject_id = ?",
      "i.subject_revision_id = ?",
      "i.metric = ?",
      "i.window = ?",
      "r.state IN ('reserved', 'outcome_unknown')",
    ];
    const values: string[] = [
      input.workspace_id,
      input.subject.kind,
      input.subject.id,
      input.subject.composition_revision_id ?? "",
      input.metric,
      input.window,
    ];
    if (input.window === "scope_execution") {
      if (!input.scope_execution_id) throw new BudgetValidationError("scope_execution budget requires a ScopeExecution");
      clauses.push("json_extract(r.facts_json, '$.scope_execution_id') = ?");
      values.push(input.scope_execution_id);
    }
    if (input.bounds.start) {
      clauses.push("i.window_start = ?");
      values.push(input.bounds.start);
    }
    if (input.bounds.end) {
      clauses.push("i.window_end = ?");
      values.push(input.bounds.end);
    }
    if (input.excluding_reservation_id) {
      clauses.push("r.reservation_id <> ?");
      values.push(input.excluding_reservation_id);
    }
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(i.estimated_amount), 0) AS amount
      FROM budget_reservation_items i
      JOIN budget_reservations r ON r.reservation_id = i.reservation_id
      WHERE ${clauses.join(" AND ")}
    `).get(...values) as { amount: number };
    return Number(row.amount);
  }

  private mapReservation(row: ReservationRow): BudgetReservationRecord {
    const items = (this.db.prepare(`
      SELECT * FROM budget_reservation_items WHERE reservation_id = ?
      ORDER BY subject_kind, subject_id, metric, window, reservation_item_id
    `).all(row.reservation_id) as ReservationItemRow[]).map(mapReservationItem);
    return {
      reservation_id: String(row.reservation_id),
      workspace_id: String(row.workspace_id),
      source: { kind: row.source_kind, id: String(row.source_id) },
      policy_evaluation_id: String(row.policy_evaluation_id),
      facts: JSON.parse(row.facts_json) as ResourceUsageFacts,
      estimates: JSON.parse(row.estimates_json) as Record<string, number>,
      state: row.state,
      idempotency_digest: String(row.idempotency_digest),
      actual_usage_digest: row.actual_usage_digest == null ? null : String(row.actual_usage_digest),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      completed_at: row.completed_at == null ? null : String(row.completed_at),
      items,
    };
  }
}

function normalizeSource(source: BudgetSourceRef): BudgetSourceRef {
  if (!["operation_invocation", "execution_attempt", "connector_action", "extension_activation"].includes(source.kind)) {
    throw new BudgetValidationError("source kind is invalid");
  }
  return { kind: source.kind, id: requiredText(source.id, "source id") };
}

function normalizeFacts(facts: ResourceUsageFacts): ResourceUsageFacts {
  const normalized: ResourceUsageFacts = {
    workspace_id: requiredText(facts.workspace_id, "workspace_id"),
    principal_id: requiredText(facts.principal_id, "principal_id"),
    operation_id: requiredText(facts.operation_id, "operation_id"),
    scope_id: nullableText(facts.scope_id),
    scope_execution_id: nullableText(facts.scope_execution_id),
    actor_id: nullableText(facts.actor_id),
    scope_composition_revision_id: nullableText(facts.scope_composition_revision_id),
    node_placement_id: nullableText(facts.node_placement_id),
    connector_binding_id: nullableText(facts.connector_binding_id),
    extension_installation_id: nullableText(facts.extension_installation_id),
  };
  if (Boolean(normalized.node_placement_id) !== Boolean(normalized.scope_composition_revision_id)) {
    throw new BudgetValidationError(
      "NodePlacement usage requires both node_placement_id and scope_composition_revision_id",
    );
  }
  return normalized;
}

function assertEvaluationMatchesUsage(
  evaluated: NonNullable<PolicyEvaluationRecord["facts"]>,
  usage: ResourceUsageFacts,
): void {
  const pairs: Array<readonly [string, string | null, string | null]> = [
    ["workspace_id", evaluated.workspace_id, usage.workspace_id],
    ["principal_id", evaluated.principal_id, usage.principal_id],
    ["operation_id", evaluated.operation_id, usage.operation_id],
    ["scope_id", evaluated.scope_id, usage.scope_id],
    ["actor_id", evaluated.actor_id, usage.actor_id],
    ["scope_composition_revision_id", evaluated.scope_composition_revision_id, usage.scope_composition_revision_id],
    ["node_placement_id", evaluated.node_placement_id, usage.node_placement_id],
    ["connector_binding_id", evaluated.connector_binding_id, usage.connector_binding_id],
    ["extension_installation_id", evaluated.extension_installation_id, usage.extension_installation_id],
  ];
  const mismatch = pairs.find(([, left, right]) => left !== right);
  if (mismatch) {
    throw new BudgetValidationError(
      `Policy evaluation ${mismatch[0]} does not match the resource-use source`,
    );
  }
}

function normalizeUsage(values: Readonly<Record<string, number>>, label: string): Readonly<Record<string, number>> {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new BudgetValidationError(`${label} must be an object`);
  }
  const normalized: Record<string, number> = {};
  for (const [metricValue, amount] of Object.entries(values)) {
    const metric = requiredText(metricValue, "metric");
    if (!Number.isFinite(amount) || amount < 0) {
      throw new BudgetValidationError(`${label} '${metric}' must be a non-negative finite number`);
    }
    normalized[metric] = amount;
  }
  return Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)));
}

function budgetWindowBounds(
  window: BudgetReservationItem["window"],
  timezone: string | null,
  at: string,
  facts: ResourceUsageFacts,
): Readonly<{ start: string | null; end: string | null }> {
  if (window === "operation" || window === "all_time") return { start: null, end: null };
  if (window === "scope_execution") {
    if (!facts.scope_execution_id) throw new BudgetValidationError("scope_execution budget requires a ScopeExecution");
    return { start: null, end: null };
  }
  if (!timezone) throw new BudgetValidationError(`${window} budget requires a timezone`);
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) throw new BudgetValidationError("budget time is invalid");
  const parts = zonedDateParts(date, timezone);
  const startParts = window === "day"
    ? { year: parts.year, month: parts.month, day: parts.day }
    : { year: parts.year, month: parts.month, day: 1 };
  const endParts = window === "day"
    ? addCalendarDays(startParts, 1)
    : addCalendarMonths(startParts, 1);
  return {
    start: zonedMidnight(startParts, timezone).toISOString(),
    end: zonedMidnight(endParts, timezone).toISOString(),
  };
}

function zonedDateParts(date: Date, timezone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function zonedMidnight(
  parts: Readonly<{ year: number; month: number; day: number }>,
  timezone: string,
): Date {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let index = 0; index < 4; index += 1) {
    const local = formatter.formatToParts(new Date(guess));
    const value = (type: string) => Number(local.find((part) => part.type === type)?.value);
    const represented = Date.UTC(
      value("year"),
      value("month") - 1,
      value("day"),
      value("hour"),
      value("minute"),
      value("second"),
    );
    const correction = target - represented;
    guess += correction;
    if (correction === 0) break;
  }
  return new Date(guess);
}

function addCalendarDays(parts: Readonly<{ year: number; month: number; day: number }>, count: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + count));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function addCalendarMonths(parts: Readonly<{ year: number; month: number; day: number }>, count: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1 + count, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: 1 };
}

function usageSubjectColumn(kind: PolicyBindingSubject["kind"]): string {
  switch (kind) {
    case "workspace": return "workspace_id";
    case "scope": return "scope_id";
    case "actor": return "actor_id";
    case "node_placement": return "node_placement_id";
    case "connector_binding": return "connector_binding_id";
    case "extension_installation": return "extension_installation_id";
  }
}

function mapReservationItem(row: ReservationItemRow): BudgetReservationItem {
  return {
    reservation_item_id: String(row.reservation_item_id),
    reservation_id: String(row.reservation_id),
    policy_revision_id: String(row.policy_revision_id),
    policy_binding_id: String(row.policy_binding_id),
    rule_id: String(row.rule_id),
    subject: row.subject_kind === "node_placement"
      ? {
          kind: row.subject_kind,
          id: String(row.subject_id),
          composition_revision_id: String(row.subject_revision_id),
        }
      : { kind: row.subject_kind, id: String(row.subject_id) },
    metric: String(row.metric),
    maximum: Number(row.maximum),
    window: row.window,
    timezone: row.timezone == null ? null : String(row.timezone),
    window_start: row.window_start == null ? null : String(row.window_start),
    window_end: row.window_end == null ? null : String(row.window_end),
    estimated_amount: Number(row.estimated_amount),
  };
}

function mapUsage(row: UsageRow): ResourceUsageEntry {
  return {
    usage_entry_id: String(row.usage_entry_id),
    workspace_id: String(row.workspace_id),
    source: { kind: row.source_kind, id: String(row.source_id) },
    principal_id: String(row.principal_id),
    operation_id: String(row.operation_id),
    scope_id: row.scope_id == null ? null : String(row.scope_id),
    scope_execution_id: row.scope_execution_id == null ? null : String(row.scope_execution_id),
    actor_id: row.actor_id == null ? null : String(row.actor_id),
    scope_composition_revision_id: row.scope_composition_revision_id == null ? null : String(row.scope_composition_revision_id),
    node_placement_id: row.node_placement_id == null ? null : String(row.node_placement_id),
    connector_binding_id: row.connector_binding_id == null ? null : String(row.connector_binding_id),
    extension_installation_id: row.extension_installation_id == null ? null : String(row.extension_installation_id),
    metric: String(row.metric),
    amount: Number(row.amount),
    observed_at: String(row.observed_at),
  };
}

function nullableText(value: string | null): string | null {
  return value == null ? null : requiredText(value, "usage fact");
}

function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BudgetValidationError(`${field} is required`);
  return value.trim();
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function inSavepoint<T>(db: DatabaseSync, label: string, action: () => T): T {
  const name = `${label}_${randomUUID().replaceAll("-", "")}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = action();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}
