import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ScopeExecutionStatus, NodeExecutionStatus } from "./scope-execution-contract.js";
export type { ScopeExecutionStatus, NodeExecutionStatus } from "./scope-execution-contract.js";

export type ExecutionAttemptStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "outcome_unknown";

export type ScopeExecutionRecord = {
  execution_id: string;
  workspace_id: string;
  scope_id: string;
  revision_id: string;
  /** Exact Event that caused this execution to be started, when there was one. */
  cause_event_id: string | null;
  root_event_id: string | null;
  ingress_node_id: string;
  ingress_port_id: string;
  initiator_endpoint_id: string | null;
  idempotency_key: string | null;
  parent_execution_id: string | null;
  redo_of_node_execution_id: string | null;
  /** Monotonic lifecycle revision used to refuse stale control operations. */
  state_revision: number;
  status: ScopeExecutionStatus;
  environment: Record<string, unknown>;
  budget: Record<string, unknown>;
  terminal: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
};

export type NodeExecutionRecord = {
  node_execution_id: string;
  execution_id: string;
  revision_id: string;
  node_id: string;
  activation_key: string;
  join_key: string | null;
  context_id: string;
  /** Exact immutable Actor meaning selected when this logical activation began. */
  actor_definition_revision_id: string | null;
  /** Exact immutable runtime setup selected when this logical activation began. */
  runtime_profile_revision_id: string | null;
  /** Exact replaceable Actor-to-runtime binding selected for this activation. */
  actor_runtime_binding_id: string | null;
  /** Exact immutable Command meaning selected when this logical activation began. */
  command_definition_revision_id: string | null;
  /** Exact authenticated Command worker selected for this activation. */
  command_worker_binding_id: string | null;
  /** Monotonic lifecycle revision used to refuse stale control operations. */
  state_revision: number;
  status: NodeExecutionStatus;
  assigned_actor_ids: string[];
  failure: Record<string, unknown>;
  created_at: string;
  activated_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
};

export type ExecutionAttemptRecord = {
  attempt_id: string;
  node_execution_id: string;
  ordinal: number;
  /** Stable logical Deliveries consumed by this attempt. A join may have many. */
  delivery_ids: string[];
  /** Legacy single-Delivery field; null when an attempt consumes a join. */
  delivery_id: string | null;
  delivery_bundle_id: string | null;
  /** Copied from the owning NodeExecution so every retry proves what it used. */
  actor_definition_revision_id: string | null;
  runtime_profile_revision_id: string | null;
  actor_runtime_binding_id: string | null;
  /** Copied from the owning NodeExecution; retry never follows the Command head. */
  command_definition_revision_id: string | null;
  command_worker_binding_id: string | null;
  status: ExecutionAttemptStatus;
  runtime: Record<string, unknown>;
  resource_use: Record<string, unknown>;
  result: Record<string, unknown>;
  error: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export type NodeExecutionInputRecord = {
  input_id: string;
  node_execution_id: string;
  port_id: string;
  delivery_id: string;
  event_id: string;
  artefact_version_id: string | null;
  member_key: string;
  input_identity: string;
  state: "received" | "late" | "superseded";
  supersedes_input_id: string | null;
  reason: Record<string, unknown>;
  accepted_at: string;
};

export type NodeExecutionExpectationRecord = {
  expectation_id: string;
  node_execution_id: string;
  port_id: string;
  expectation_kind: "required_port" | "collection_member";
  expectation_key: string;
  member_key: string | null;
  expected_artefact_version_id: string | null;
  source_artefact_version_id: string | null;
  match_policy: "cardinality" | "member_key" | "member_key_and_version";
  state: "expected" | "failed" | "superseded";
  reason: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type NodeExecutionExpectedMembershipRecord = {
  membership_id: string;
  node_execution_id: string;
  collection_port_id: string;
  member_port_id: string;
  collection_artefact_version_id: string;
  match_policy: "member_key" | "member_key_and_version";
  state: "active" | "superseded";
  created_at: string;
  superseded_at: string | null;
};

export type NodeExecutionJoinState = {
  received: NodeExecutionInputRecord[];
  expected: NodeExecutionExpectationRecord[];
  missing: NodeExecutionExpectationRecord[];
  failed: NodeExecutionExpectationRecord[];
  late: NodeExecutionInputRecord[];
  superseded: {
    inputs: NodeExecutionInputRecord[];
    expectations: NodeExecutionExpectationRecord[];
    memberships: NodeExecutionExpectedMembershipRecord[];
  };
  memberships: NodeExecutionExpectedMembershipRecord[];
  ready: boolean;
};

export type OutputPublicationRecord = {
  publication_id: string;
  node_execution_id: string;
  port_id: string;
  event_id: string;
  idempotency_key: string;
  published_by_endpoint_id: string | null;
  created_at: string;
  outputs: NodeExecutionOutputRecord[];
};

export type NodeExecutionOutputRecord = {
  artefact_version_id: string | null;
  member_key: string;
};

export type ScopeEdgeTraversalRecord = {
  traversal_id: string;
  publication_id: string;
  edge_id: string;
  delivery_id: string;
  target_node_execution_id: string;
  created_at: string;
};

export type ScopeExecutionPauseResult = {
  execution: ScopeExecutionRecord;
  pause_id: string;
  node_execution_ids: string[];
  delivery_ids: string[];
};

export type ScopeExecutionResumeResult = ScopeExecutionPauseResult;

export type NodeExecutionRetryResult = {
  execution: ScopeExecutionRecord;
  node_execution: NodeExecutionRecord;
  previous_attempt: ExecutionAttemptRecord;
  delivery_ids: string[];
};

export class ScopeExecutionReferenceError extends Error {
  readonly code = "E_SCOPE_EXECUTION_REFERENCE_UNAVAILABLE" as const;
  constructor(readonly reason: string) {
    super(`Scope execution reference unavailable: ${reason}`);
    this.name = "ScopeExecutionReferenceError";
  }
}

export class ScopeExecutionTransitionError extends Error {
  readonly code = "E_SCOPE_EXECUTION_TRANSITION_INVALID" as const;
  constructor(readonly reason: string) {
    super(`Invalid Scope execution transition: ${reason}`);
    this.name = "ScopeExecutionTransitionError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  return value ? JSON.parse(value) as T : fallback;
}

export function applyScopeExecutionSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scope_executions (
      execution_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      cause_event_id TEXT,
      root_event_id TEXT,
      ingress_node_id TEXT NOT NULL,
      ingress_port_id TEXT NOT NULL,
      initiator_endpoint_id TEXT,
      idempotency_key TEXT,
      parent_execution_id TEXT,
      redo_of_node_execution_id TEXT,
      state_revision INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      environment_json TEXT NOT NULL,
      budget_json TEXT NOT NULL,
      terminal_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      cancelled_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_scope_executions_idempotency
      ON scope_executions(workspace_id, scope_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_scope_executions_scope
      ON scope_executions(workspace_id, scope_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_scope_executions_workspace_created
      ON scope_executions(workspace_id, created_at DESC, execution_id DESC);

    CREATE INDEX IF NOT EXISTS idx_scope_executions_cause
      ON scope_executions(workspace_id, cause_event_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS node_executions (
      node_execution_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      activation_key TEXT NOT NULL,
      join_key TEXT,
      context_id TEXT NOT NULL,
      actor_definition_revision_id TEXT,
      runtime_profile_revision_id TEXT,
      actor_runtime_binding_id TEXT,
      command_definition_revision_id TEXT,
      command_worker_binding_id TEXT,
      state_revision INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      assigned_actor_ids_json TEXT NOT NULL,
      missing_port_ids_json TEXT NOT NULL DEFAULT '[]',
      failure_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      activated_at TEXT,
      completed_at TEXT,
      cancelled_at TEXT,
      UNIQUE (execution_id, node_id, activation_key)
    );

    CREATE INDEX IF NOT EXISTS idx_node_executions_execution
      ON node_executions(execution_id, created_at ASC);

    CREATE INDEX IF NOT EXISTS idx_node_executions_context
      ON node_executions(context_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS node_context_bindings (
      workspace_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      binding_key TEXT NOT NULL,
      context_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, scope_id, node_id, binding_key)
    );

    CREATE TABLE IF NOT EXISTS node_execution_inputs (
      input_id TEXT PRIMARY KEY,
      node_execution_id TEXT NOT NULL,
      port_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      artefact_version_id TEXT,
      member_key TEXT NOT NULL,
      input_identity TEXT NOT NULL,
      state TEXT NOT NULL,
      supersedes_input_id TEXT,
      reason_json TEXT NOT NULL,
      accepted_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS node_execution_join_expectations (
      expectation_id TEXT PRIMARY KEY,
      node_execution_id TEXT NOT NULL,
      port_id TEXT NOT NULL,
      expectation_kind TEXT NOT NULL,
      expectation_key TEXT NOT NULL,
      member_key TEXT,
      expected_artefact_version_id TEXT,
      source_artefact_version_id TEXT,
      match_policy TEXT NOT NULL,
      state TEXT NOT NULL,
      reason_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (node_execution_id, port_id, expectation_kind, expectation_key, source_artefact_version_id)
    );

    CREATE INDEX IF NOT EXISTS idx_node_execution_join_expectations_node
      ON node_execution_join_expectations(node_execution_id, state, port_id, expectation_key);

    CREATE TABLE IF NOT EXISTS node_execution_expected_memberships (
      membership_id TEXT PRIMARY KEY,
      node_execution_id TEXT NOT NULL,
      collection_port_id TEXT NOT NULL,
      member_port_id TEXT NOT NULL,
      collection_artefact_version_id TEXT NOT NULL,
      match_policy TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      superseded_at TEXT,
      UNIQUE (node_execution_id, collection_port_id, member_port_id, collection_artefact_version_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_node_execution_expected_memberships_active
      ON node_execution_expected_memberships(node_execution_id, collection_port_id, member_port_id)
      WHERE state = 'active';

    CREATE TABLE IF NOT EXISTS execution_attempts (
      attempt_id TEXT PRIMARY KEY,
      node_execution_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      delivery_id TEXT,
      delivery_bundle_id TEXT,
      actor_definition_revision_id TEXT,
      runtime_profile_revision_id TEXT,
      actor_runtime_binding_id TEXT,
      command_definition_revision_id TEXT,
      command_worker_binding_id TEXT,
      status TEXT NOT NULL,
      runtime_json TEXT NOT NULL,
      resource_use_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      error_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      UNIQUE (node_execution_id, ordinal)
    );

    CREATE INDEX IF NOT EXISTS idx_execution_attempts_node
      ON execution_attempts(node_execution_id, ordinal ASC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_attempts_bundle
      ON execution_attempts(delivery_bundle_id)
      WHERE delivery_bundle_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS execution_attempt_deliveries (
      attempt_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      PRIMARY KEY (attempt_id, delivery_id)
    );

    CREATE INDEX IF NOT EXISTS idx_execution_attempt_deliveries_delivery
      ON execution_attempt_deliveries(delivery_id, attempt_id);

    CREATE TABLE IF NOT EXISTS scope_output_publications (
      publication_id TEXT PRIMARY KEY,
      node_execution_id TEXT NOT NULL,
      port_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      published_by_endpoint_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS node_execution_outputs (
      publication_id TEXT NOT NULL,
      artefact_version_id TEXT,
      member_key TEXT NOT NULL,
      PRIMARY KEY (publication_id, artefact_version_id, member_key)
    );

    CREATE TABLE IF NOT EXISTS scope_edge_traversals (
      traversal_id TEXT PRIMARY KEY,
      publication_id TEXT NOT NULL,
      edge_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      target_node_execution_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (publication_id, edge_id)
    );

    CREATE INDEX IF NOT EXISTS idx_scope_edge_traversals_target
      ON scope_edge_traversals(target_node_execution_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS scope_execution_pauses (
      pause_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      prior_status TEXT NOT NULL,
      prior_terminal_json TEXT NOT NULL,
      reason TEXT,
      paused_at TEXT NOT NULL,
      resumed_at TEXT,
      resume_reason TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_scope_execution_pauses_active
      ON scope_execution_pauses(execution_id)
      WHERE resumed_at IS NULL;

    CREATE TABLE IF NOT EXISTS scope_execution_pause_nodes (
      pause_id TEXT NOT NULL,
      node_execution_id TEXT NOT NULL,
      prior_status TEXT NOT NULL,
      prior_failure_json TEXT NOT NULL,
      PRIMARY KEY (pause_id, node_execution_id)
    );

    CREATE TABLE IF NOT EXISTS scope_execution_pause_deliveries (
      pause_id TEXT NOT NULL,
      queue_id TEXT NOT NULL,
      prior_state TEXT NOT NULL,
      PRIMARY KEY (pause_id, queue_id)
    );
  `);

  // Retained databases predate Actor/runtime pinning. The columns stay nullable
  // so their historical rows remain honest; new Actor work is refused below
  // until all three exact references can be resolved.
  addColumnIfMissing(db, "node_executions", "actor_definition_revision_id", "TEXT");
  addColumnIfMissing(db, "node_executions", "runtime_profile_revision_id", "TEXT");
  addColumnIfMissing(db, "node_executions", "actor_runtime_binding_id", "TEXT");
  addColumnIfMissing(db, "node_executions", "command_definition_revision_id", "TEXT");
  addColumnIfMissing(db, "node_executions", "command_worker_binding_id", "TEXT");
  addColumnIfMissing(db, "node_executions", "join_key", "TEXT");
  addColumnIfMissing(db, "scope_executions", "state_revision", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "node_executions", "state_revision", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "execution_attempts", "actor_definition_revision_id", "TEXT");
  addColumnIfMissing(db, "execution_attempts", "runtime_profile_revision_id", "TEXT");
  addColumnIfMissing(db, "execution_attempts", "actor_runtime_binding_id", "TEXT");
  addColumnIfMissing(db, "execution_attempts", "command_definition_revision_id", "TEXT");
  addColumnIfMissing(db, "execution_attempts", "command_worker_binding_id", "TEXT");
  addColumnIfMissing(db, "node_execution_inputs", "input_identity", "TEXT");
  addColumnIfMissing(db, "node_execution_inputs", "state", "TEXT NOT NULL DEFAULT 'received'");
  addColumnIfMissing(db, "node_execution_inputs", "supersedes_input_id", "TEXT");
  addColumnIfMissing(db, "node_execution_inputs", "reason_json", "TEXT NOT NULL DEFAULT '{}'");

  // Older rows named the physical Delivery but did not retain a stable logical
  // input identity. Reconstruct that identity from the exact ArtefactVersion
  // (or Event when there is no Artefact) before enforcing canonical dedup.
  db.exec(`
    UPDATE node_execution_inputs
    SET input_identity = CASE
      WHEN artefact_version_id IS NOT NULL
        THEN 'artefact:' || artefact_version_id || ':member:' || COALESCE(member_key, '')
      ELSE 'event:' || event_id || ':member:' || COALESCE(member_key, '')
    END
    WHERE input_identity IS NULL OR input_identity = '';

    WITH ranked AS (
      SELECT input_id,
             ROW_NUMBER() OVER (
               PARTITION BY node_execution_id, port_id, input_identity
               ORDER BY accepted_at ASC, input_id ASC
             ) AS occurrence
      FROM node_execution_inputs
      WHERE state = 'received'
    )
    UPDATE node_execution_inputs
    SET state = 'late', reason_json = '{"code":"retained_duplicate_input"}'
    WHERE input_id IN (SELECT input_id FROM ranked WHERE occurrence > 1);

    CREATE INDEX IF NOT EXISTS idx_node_execution_inputs_node
      ON node_execution_inputs(node_execution_id, port_id, state, accepted_at ASC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_node_execution_inputs_identity
      ON node_execution_inputs(node_execution_id, port_id, input_identity)
      WHERE input_identity IS NOT NULL AND state = 'received';
  `);

  // Status names were previously too coarse to distinguish a durable join from
  // runtime activity or an external wait. Retained rows are translated once by
  // the schema upgrade; no parallel lifecycle remains active.
  db.exec(`
    UPDATE scope_executions SET status = CASE status
      WHEN 'pending' THEN 'queued'
      WHEN 'running' THEN 'active'
      WHEN 'waiting' THEN 'waiting_external'
      ELSE status END;
    UPDATE node_executions SET status = CASE status
      WHEN 'pending' THEN 'collecting'
      WHEN 'running' THEN 'active'
      WHEN 'waiting' THEN 'waiting_external'
      ELSE status END;
  `);
}

export class ScopeExecutionStore {
  constructor(readonly db: DatabaseSync) {}

  createExecution(input: {
    workspace_id: string;
    scope_id: string;
    revision_id: string;
    cause_event_id?: string | null;
    root_event_id?: string | null;
    ingress_node_id: string;
    ingress_port_id: string;
    initiator_endpoint_id?: string | null;
    idempotency_key?: string | null;
    parent_execution_id?: string | null;
    redo_of_node_execution_id?: string | null;
    environment?: Record<string, unknown>;
    budget?: Record<string, unknown>;
  }): ScopeExecutionRecord {
    if (input.idempotency_key) {
      const existing = this.db.prepare(`
        SELECT * FROM scope_executions WHERE workspace_id = ? AND scope_id = ? AND idempotency_key = ?
      `).get(input.workspace_id, input.scope_id, input.idempotency_key) as any;
      if (existing) return this.rowToScopeExecution(existing);
    }
    const id = `execution_${randomUUID()}`;
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO scope_executions (
        execution_id, workspace_id, scope_id, revision_id, cause_event_id, root_event_id,
        ingress_node_id, ingress_port_id, initiator_endpoint_id, idempotency_key,
        parent_execution_id, redo_of_node_execution_id, status, environment_json,
        budget_json, terminal_json, created_at, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, '{}', ?, ?)
    `).run(
      id,
      input.workspace_id,
      input.scope_id,
      input.revision_id,
      input.cause_event_id ?? null,
      input.root_event_id ?? null,
      input.ingress_node_id,
      input.ingress_port_id,
      input.initiator_endpoint_id ?? null,
      input.idempotency_key ?? null,
      input.parent_execution_id ?? null,
      input.redo_of_node_execution_id ?? null,
      json(input.environment),
      json(input.budget),
      timestamp,
      timestamp,
    );
    return this.getExecution(id) as ScopeExecutionRecord;
  }

  /**
   * Redo is a new causal branch, never another attempt on the old
   * NodeExecution. The caller selects an exact retained published design; new
   * NodeExecutions in the branch resolve the Actor/runtime heads current then.
   */
  createRedoExecution(input: {
    redo_of_node_execution_id: string;
    revision_id: string;
    ingress_node_id: string;
    ingress_port_id: string;
    cause_event_id?: string | null;
    root_event_id?: string | null;
    initiator_endpoint_id?: string | null;
    idempotency_key?: string | null;
    environment?: Record<string, unknown>;
    budget?: Record<string, unknown>;
  }): ScopeExecutionRecord {
    const sourceNode = this.getNodeExecution(input.redo_of_node_execution_id);
    if (!sourceNode) {
      throw new ScopeExecutionReferenceError(`NodeExecution '${input.redo_of_node_execution_id}' does not exist`);
    }
    const sourceExecution = this.getExecution(sourceNode.execution_id);
    if (!sourceExecution) {
      throw new ScopeExecutionReferenceError(`ScopeExecution '${sourceNode.execution_id}' does not exist`);
    }
    const revision = this.db.prepare(`
      SELECT workspace_id, scope_id, routing_mode, published_at, withdrawn_at
      FROM scope_composition_revisions WHERE revision_id = ?
    `).get(input.revision_id) as {
      workspace_id: string;
      scope_id: string;
      routing_mode: string;
      published_at: string | null;
      withdrawn_at: string | null;
    } | undefined;
    if (!revision
      || revision.workspace_id !== sourceExecution.workspace_id
      || revision.scope_id !== sourceExecution.scope_id
      || revision.routing_mode !== "edge"
      || !revision.published_at
      || revision.withdrawn_at) {
      throw new ScopeExecutionReferenceError(
        `redo revision '${input.revision_id}' is not a retained published design for the source Scope`,
      );
    }
    const redo = this.createExecution({
      workspace_id: sourceExecution.workspace_id,
      scope_id: sourceExecution.scope_id,
      revision_id: input.revision_id,
      cause_event_id: input.cause_event_id ?? null,
      root_event_id: input.root_event_id ?? null,
      ingress_node_id: input.ingress_node_id,
      ingress_port_id: input.ingress_port_id,
      initiator_endpoint_id: input.initiator_endpoint_id ?? null,
      idempotency_key: input.idempotency_key ?? null,
      parent_execution_id: sourceExecution.execution_id,
      redo_of_node_execution_id: sourceNode.node_execution_id,
      environment: input.environment,
      budget: input.budget,
    });
    if (redo.parent_execution_id !== sourceExecution.execution_id
      || redo.redo_of_node_execution_id !== sourceNode.node_execution_id
      || redo.revision_id !== input.revision_id) {
      throw new ScopeExecutionReferenceError("redo idempotency key belongs to a different execution branch");
    }
    return redo;
  }

  setRootEvent(executionId: string, eventId: string): ScopeExecutionRecord {
    this.db.prepare(`
      UPDATE scope_executions
      SET root_event_id = ?, state_revision = state_revision + 1
      WHERE execution_id = ? AND root_event_id IS NULL
    `)
      .run(eventId, executionId);
    return this.getExecution(executionId) as ScopeExecutionRecord;
  }

  getExecution(executionId: string): ScopeExecutionRecord | null {
    const row = this.db.prepare(`SELECT * FROM scope_executions WHERE execution_id = ?`).get(executionId) as any;
    return row ? this.rowToScopeExecution(row) : null;
  }

  listExecutions(workspaceId: string, scopeId: string): ScopeExecutionRecord[] {
    return (this.db.prepare(`
      SELECT * FROM scope_executions WHERE workspace_id = ? AND scope_id = ? ORDER BY created_at DESC
    `).all(workspaceId, scopeId) as any[]).map((row) => this.rowToScopeExecution(row));
  }

  listExecutionsPage(input: {
    workspace_id: string;
    scope_id?: string;
    caused_by_context_id?: string;
    limit: number;
    before?: { created_at: string; execution_id: string };
  }): ScopeExecutionRecord[] {
    const conditions = ["se.workspace_id = ?"];
    const params: Array<string | number> = [input.workspace_id];
    if (input.scope_id) {
      conditions.push("se.scope_id = ?");
      params.push(input.scope_id);
    }
    if (input.caused_by_context_id) {
      // This is deliberately the Context of the exact causal Event. A
      // NodeExecution's working Context is a different relationship.
      conditions.push("cause.context_id = ?");
      params.push(input.caused_by_context_id);
    }
    if (input.before) {
      conditions.push("(se.created_at < ? OR (se.created_at = ? AND se.execution_id < ?))");
      params.push(input.before.created_at, input.before.created_at, input.before.execution_id);
    }
    params.push(input.limit);
    const join = input.caused_by_context_id
      ? "JOIN events cause ON cause.event_id = se.cause_event_id"
      : "";
    const rows = this.db.prepare(`
      SELECT se.*
      FROM scope_executions se
      ${join}
      WHERE ${conditions.join(" AND ")}
      ORDER BY se.created_at DESC, se.execution_id DESC
      LIMIT ?
    `).all(...params) as any[];
    return rows.map((row) => this.rowToScopeExecution(row));
  }

  setExecutionStatus(
    executionId: string,
    status: ScopeExecutionStatus,
    terminal: Record<string, unknown> = {},
  ): ScopeExecutionRecord {
    const current = this.getExecution(executionId);
    if (!current) throw new ScopeExecutionReferenceError(`ScopeExecution '${executionId}' does not exist`);
    if (current.status === status) return current;
    assertScopeStatusTransition(current.status, status);
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE scope_executions
      SET status = ?, terminal_json = ?, state_revision = state_revision + 1,
          completed_at = CASE WHEN ? IN ('completed', 'failed', 'superseded') THEN ? ELSE completed_at END,
          cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END
      WHERE execution_id = ?
    `).run(status, json(terminal), status, timestamp, status, timestamp, executionId);
    return this.getExecution(executionId) as ScopeExecutionRecord;
  }

  /**
   * Pause is a durable scheduling barrier. Work already owned by a runtime is
   * refused because the Bus cannot claim that an external effect is paused.
   */
  pauseExecution(input: {
    execution_id: string;
    reason?: string | null;
  }): ScopeExecutionPauseResult {
    const execution = this.getExecution(input.execution_id);
    if (!execution) {
      throw new ScopeExecutionReferenceError(`ScopeExecution '${input.execution_id}' does not exist`);
    }
    if (execution.status === "paused") {
      const active = this.activePause(execution.execution_id);
      if (!active) {
        throw new ScopeExecutionReferenceError(
          `ScopeExecution '${execution.execution_id}' is paused without a retained pause record`,
        );
      }
      return this.pauseResult(execution, active.pause_id);
    }
    if (!["queued", "active", "waiting_external", "blocked"].includes(execution.status)) {
      throw new ScopeExecutionTransitionError(
        `ScopeExecution '${execution.execution_id}' cannot pause while '${execution.status}'`,
      );
    }
    const unsettledAttempts = this.db.prepare(`
      SELECT ea.attempt_id
      FROM execution_attempts ea
      JOIN node_executions n ON n.node_execution_id = ea.node_execution_id
      WHERE n.execution_id = ? AND ea.status IN ('pending', 'running')
      ORDER BY ea.created_at, ea.attempt_id
    `).all(execution.execution_id) as Array<{ attempt_id: string }>;
    const hasQueue = tableExists(this.db, "event_queue");
    const activeDeliveries = hasQueue
      ? this.db.prepare(`
          SELECT queue_id FROM event_queue
          WHERE scope_execution_id = ?
            AND state IN ('reserved', 'delivered_to_bridge', 'injected_to_runtime')
          ORDER BY created_at, queue_id
        `).all(execution.execution_id) as Array<{ queue_id: string }>
      : [];
    if (unsettledAttempts.length > 0 || activeDeliveries.length > 0) {
      throw new ScopeExecutionTransitionError(
        `ScopeExecution '${execution.execution_id}' has runtime-owned work and cannot be represented as paused`,
      );
    }
    const nodes = this.listNodeExecutions(execution.execution_id).filter((node) => ![
      "completed", "failed", "cancelled", "superseded",
    ].includes(node.status));
    const deliveries = hasQueue
      ? this.db.prepare(`
          SELECT queue_id, state FROM event_queue
          WHERE scope_execution_id = ? AND state IN ('held', 'queued')
          ORDER BY created_at, queue_id
        `).all(execution.execution_id) as Array<{ queue_id: string; state: string }>
      : [];
    const pauseId = `pause_${randomUUID()}`;
    const timestamp = nowIso();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO scope_execution_pauses (
          pause_id, execution_id, prior_status, prior_terminal_json, reason, paused_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        pauseId,
        execution.execution_id,
        execution.status,
        json(execution.terminal),
        input.reason?.trim() || null,
        timestamp,
      );
      const insertNode = this.db.prepare(`
        INSERT INTO scope_execution_pause_nodes (
          pause_id, node_execution_id, prior_status, prior_failure_json
        ) VALUES (?, ?, ?, ?)
      `);
      for (const node of nodes) {
        insertNode.run(pauseId, node.node_execution_id, node.status, json(node.failure));
        if (node.status !== "paused") {
          this.db.prepare(`
            UPDATE node_executions SET status = 'paused', state_revision = state_revision + 1
            WHERE node_execution_id = ?
          `)
            .run(node.node_execution_id);
        }
      }
      const insertDelivery = this.db.prepare(`
        INSERT INTO scope_execution_pause_deliveries (pause_id, queue_id, prior_state)
        VALUES (?, ?, ?)
      `);
      for (const delivery of deliveries) {
        insertDelivery.run(pauseId, delivery.queue_id, delivery.state);
      }
      if (hasQueue) {
        this.db.prepare(`
          UPDATE event_queue SET state = 'held', lease_expires_at = NULL
          WHERE scope_execution_id = ? AND state = 'queued'
        `).run(execution.execution_id);
      }
      this.db.prepare(`
        UPDATE scope_executions
        SET status = 'paused', terminal_json = ?, state_revision = state_revision + 1
        WHERE execution_id = ?
      `).run(json({ code: "operator_paused", reason: input.reason?.trim() || null }), execution.execution_id);
    });
    return this.pauseResult(this.getExecution(execution.execution_id) as ScopeExecutionRecord, pauseId);
  }

  resumeExecution(input: {
    execution_id: string;
    reason?: string | null;
  }): ScopeExecutionResumeResult {
    const execution = this.getExecution(input.execution_id);
    if (!execution) {
      throw new ScopeExecutionReferenceError(`ScopeExecution '${input.execution_id}' does not exist`);
    }
    if (execution.status !== "paused") {
      throw new ScopeExecutionTransitionError(
        `ScopeExecution '${execution.execution_id}' cannot resume while '${execution.status}'`,
      );
    }
    const pause = this.activePause(execution.execution_id);
    if (!pause) {
      throw new ScopeExecutionReferenceError(
        `ScopeExecution '${execution.execution_id}' has no active retained pause`,
      );
    }
    const nodeRows = this.db.prepare(`
      SELECT node_execution_id, prior_status, prior_failure_json
      FROM scope_execution_pause_nodes WHERE pause_id = ? ORDER BY node_execution_id
    `).all(pause.pause_id) as Array<{
      node_execution_id: string;
      prior_status: NodeExecutionStatus;
      prior_failure_json: string;
    }>;
    const deliveryRows = this.db.prepare(`
      SELECT queue_id, prior_state FROM scope_execution_pause_deliveries
      WHERE pause_id = ? ORDER BY queue_id
    `).all(pause.pause_id) as Array<{ queue_id: string; prior_state: string }>;
    const timestamp = nowIso();
    this.transaction(() => {
      for (const node of nodeRows) {
        this.db.prepare(`
          UPDATE node_executions
          SET status = ?, failure_json = ?, state_revision = state_revision + 1
          WHERE node_execution_id = ? AND status = 'paused'
        `).run(node.prior_status, node.prior_failure_json, node.node_execution_id);
      }
      if (tableExists(this.db, "event_queue")) {
        for (const delivery of deliveryRows) {
          this.db.prepare(`
            UPDATE event_queue SET state = ?
            WHERE queue_id = ? AND state = 'held'
          `).run(delivery.prior_state, delivery.queue_id);
        }
      }
      this.db.prepare(`
        UPDATE scope_executions
        SET status = ?, terminal_json = ?, state_revision = state_revision + 1
        WHERE execution_id = ?
      `).run(pause.prior_status, pause.prior_terminal_json, execution.execution_id);
      this.db.prepare(`
        UPDATE scope_execution_pauses SET resumed_at = ?, resume_reason = ?
        WHERE pause_id = ? AND resumed_at IS NULL
      `).run(timestamp, input.reason?.trim() || null, pause.pause_id);
    });
    return this.pauseResult(
      this.getExecution(execution.execution_id) as ScopeExecutionRecord,
      pause.pause_id,
    );
  }

  /**
   * Explicit retry preserves the logical NodeExecution, Context, revision, and
   * Actor/runtime pins. Only a new ExecutionAttempt is created when the exact
   * retained Deliveries are claimed again.
   */
  retryNodeExecution(nodeExecutionId: string): NodeExecutionRetryResult {
    const node = this.getNodeExecution(nodeExecutionId);
    if (!node) {
      throw new ScopeExecutionReferenceError(`NodeExecution '${nodeExecutionId}' does not exist`);
    }
    if (node.status !== "failed" && node.status !== "blocked") {
      throw new ScopeExecutionTransitionError(
        `NodeExecution '${node.node_execution_id}' cannot retry while '${node.status}'`,
      );
    }
    if (this.listPublications(node.node_execution_id).length > 0) {
      throw new ScopeExecutionTransitionError(
        `NodeExecution '${node.node_execution_id}' already published output and cannot be retried in place`,
      );
    }
    const attempts = this.listAttempts(node.node_execution_id);
    const previous = attempts.at(-1);
    if (!previous || !["failed", "cancelled", "outcome_unknown"].includes(previous.status)) {
      throw new ScopeExecutionTransitionError(
        `NodeExecution '${node.node_execution_id}' has no terminal failed attempt to retry`,
      );
    }
    if (previous.delivery_ids.length === 0 || !tableExists(this.db, "event_queue")) {
      throw new ScopeExecutionReferenceError(
        `NodeExecution '${node.node_execution_id}' has no retained Deliveries that can be retried`,
      );
    }
    const queueRows = this.db.prepare(`
      SELECT queue_id, node_execution_id, state
      FROM event_queue
      WHERE queue_id IN (${previous.delivery_ids.map(() => "?").join(", ")})
      ORDER BY queue_id
    `).all(...previous.delivery_ids) as Array<{
      queue_id: string;
      node_execution_id: string | null;
      state: string;
    }>;
    if (queueRows.length !== previous.delivery_ids.length
      || queueRows.some((row) => row.node_execution_id !== node.node_execution_id)
      || queueRows.some((row) => ["reserved", "delivered_to_bridge", "injected_to_runtime"].includes(row.state))) {
      throw new ScopeExecutionReferenceError(
        `NodeExecution '${node.node_execution_id}' retained Delivery set is incomplete or still runtime-owned`,
      );
    }
    const execution = this.getExecution(node.execution_id) as ScopeExecutionRecord;
    if (!["active", "waiting_external", "blocked", "failed"].includes(execution.status)) {
      throw new ScopeExecutionTransitionError(
        `ScopeExecution '${execution.execution_id}' cannot accept a retry while '${execution.status}'`,
      );
    }
    this.transaction(() => {
      for (const row of queueRows) {
        this.db.prepare(`
          UPDATE event_queue
          SET state = 'queued', delivery_id = NULL, lease_expires_at = NULL, last_error = NULL
          WHERE queue_id = ?
        `).run(row.queue_id);
      }
      this.db.prepare(`
        UPDATE node_executions
        SET status = 'retrying', failure_json = '{}', completed_at = NULL, cancelled_at = NULL,
            state_revision = state_revision + 1
        WHERE node_execution_id = ?
      `).run(node.node_execution_id);
      if (execution.status === "failed" || execution.status === "blocked") {
        this.db.prepare(`
          UPDATE scope_executions
          SET status = 'active', terminal_json = '{}', completed_at = NULL, cancelled_at = NULL,
              state_revision = state_revision + 1
          WHERE execution_id = ?
        `).run(execution.execution_id);
      }
    });
    return {
      execution: this.getExecution(execution.execution_id) as ScopeExecutionRecord,
      node_execution: this.getNodeExecution(node.node_execution_id) as NodeExecutionRecord,
      previous_attempt: previous,
      delivery_ids: previous.delivery_ids,
    };
  }

  createOrGetNodeExecution(input: {
    execution_id: string;
    revision_id: string;
    node_id: string;
    activation_key: string;
    join_key?: string | null;
    context_id: string;
    status?: NodeExecutionStatus;
    assigned_actor_ids?: string[];
    command_definition_revision_id?: string | null;
    command_worker_binding_id?: string | null;
  }): NodeExecutionRecord {
    const existing = this.db.prepare(`
      SELECT * FROM node_executions WHERE execution_id = ? AND node_id = ? AND activation_key = ?
    `).get(input.execution_id, input.node_id, input.activation_key) as any;
    if (existing) {
      const record = this.rowToNodeExecution(existing);
      if (record.revision_id !== input.revision_id
        || record.context_id !== input.context_id
        || record.join_key !== (input.join_key ?? null)
        || (input.command_definition_revision_id !== undefined
          && record.command_definition_revision_id !== input.command_definition_revision_id)
        || (input.command_worker_binding_id !== undefined
          && record.command_worker_binding_id !== input.command_worker_binding_id)) {
        throw new ScopeExecutionReferenceError(
          `NodeExecution activation '${input.activation_key}' was resolved with conflicting immutable identity`,
        );
      }
      return record;
    }
    const execution = this.getExecution(input.execution_id);
    if (!execution) {
      throw new ScopeExecutionReferenceError(`ScopeExecution '${input.execution_id}' does not exist`);
    }
    if (input.revision_id !== execution.revision_id) {
      throw new ScopeExecutionReferenceError(
        `NodeExecution revision '${input.revision_id}' does not match its ScopeExecution revision`,
      );
    }
    const placement = this.requireNodePlacement(
      input.revision_id,
      input.node_id,
      execution.workspace_id,
      execution.scope_id,
    );
    const pins = placement.kind === "actor"
      ? this.resolveCurrentActorPins(execution.workspace_id, placement.resource_id)
      : emptyActorPins();
    const commandPins = placement.kind === "command"
      ? {
          command_definition_revision_id: input.command_definition_revision_id ?? null,
          command_worker_binding_id: input.command_worker_binding_id ?? null,
        }
      : emptyCommandPins();
    if (placement.kind === "command" && !hasAllCommandPins(commandPins)) {
      throw new ScopeExecutionReferenceError(
        `Command node '${input.node_id}' requires exact Command definition and worker pins`,
      );
    }
    if (placement.kind !== "command" && hasAnyCommandPin(commandPins)) {
      throw new ScopeExecutionReferenceError(`non-Command node '${input.node_id}' cannot carry Command pins`);
    }
    const assignedActorIds = placement.kind === "actor"
      ? [placement.resource_id as string]
      : input.assigned_actor_ids ?? [];
    if (placement.kind === "actor" && input.assigned_actor_ids
      && (input.assigned_actor_ids.length !== 1 || input.assigned_actor_ids[0] !== placement.resource_id)) {
      throw new ScopeExecutionReferenceError(
        `Actor assignment for node '${input.node_id}' does not match its published placement`,
      );
    }
    const id = `node_execution_${randomUUID()}`;
    const timestamp = nowIso();
    const status = input.status ?? "collecting";
    this.db.prepare(`
      INSERT INTO node_executions (
        node_execution_id, execution_id, revision_id, node_id, activation_key,
        join_key, context_id, actor_definition_revision_id, runtime_profile_revision_id,
        actor_runtime_binding_id, command_definition_revision_id, command_worker_binding_id,
        status, assigned_actor_ids_json,
        failure_json, created_at, activated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
    `).run(
      id,
      input.execution_id,
      input.revision_id,
      input.node_id,
      input.activation_key,
      input.join_key ?? null,
      input.context_id,
      pins.actor_definition_revision_id,
      pins.runtime_profile_revision_id,
      pins.actor_runtime_binding_id,
      commandPins.command_definition_revision_id,
      commandPins.command_worker_binding_id,
      status,
      json(assignedActorIds),
      timestamp,
      ["ready", "active", "waiting_external", "paused", "retrying", "completed"].includes(status)
        ? timestamp
        : null,
    );
    return this.getNodeExecution(id) as NodeExecutionRecord;
  }

  getNodeExecution(nodeExecutionId: string): NodeExecutionRecord | null {
    const row = this.db.prepare(`SELECT * FROM node_executions WHERE node_execution_id = ?`).get(nodeExecutionId) as any;
    return row ? this.rowToNodeExecution(row) : null;
  }

  listNodeExecutions(executionId: string): NodeExecutionRecord[] {
    return (this.db.prepare(`
      SELECT * FROM node_executions WHERE execution_id = ? ORDER BY created_at ASC
    `).all(executionId) as any[]).map((row) => this.rowToNodeExecution(row));
  }

  findNodeExecution(executionId: string, nodeId: string, activationKey: string): NodeExecutionRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM node_executions WHERE execution_id = ? AND node_id = ? AND activation_key = ?
    `).get(executionId, nodeId, activationKey) as any;
    return row ? this.rowToNodeExecution(row) : null;
  }

  setNodeExecutionStatus(
    nodeExecutionId: string,
    status: NodeExecutionStatus,
    failure: Record<string, unknown> = {},
  ): NodeExecutionRecord {
    const current = this.getNodeExecution(nodeExecutionId);
    if (!current) throw new ScopeExecutionReferenceError(`NodeExecution '${nodeExecutionId}' does not exist`);
    if (current.status === status) return current;
    assertNodeStatusTransition(current.status, status);
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE node_executions
      SET status = ?, failure_json = ?, state_revision = state_revision + 1,
          activated_at = CASE WHEN ? IN ('ready', 'active', 'waiting_external', 'paused', 'retrying', 'completed') THEN COALESCE(activated_at, ?) ELSE activated_at END,
          completed_at = CASE WHEN ? IN ('completed', 'failed', 'superseded') THEN ? ELSE completed_at END,
          cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END
      WHERE node_execution_id = ?
    `).run(status, json(failure), status, timestamp, status, timestamp, status, timestamp, nodeExecutionId);
    return this.getNodeExecution(nodeExecutionId) as NodeExecutionRecord;
  }

  acceptInput(input: {
    node_execution_id: string;
    port_id: string;
    delivery_id: string;
    event_id: string;
    artefact_version_id?: string | null;
    member_key?: string;
    state?: "received" | "late";
    supersedes_input_id?: string | null;
    reason?: Record<string, unknown>;
  }): NodeExecutionInputRecord {
    const memberKey = input.member_key ?? "";
    const versionId = input.artefact_version_id ?? null;
    const inputIdentity = versionId
      ? `artefact:${versionId}:member:${memberKey}`
      : `event:${input.event_id}:member:${memberKey}`;
    const existing = this.db.prepare(`
      SELECT * FROM node_execution_inputs
      WHERE node_execution_id = ? AND port_id = ? AND input_identity = ?
    `).get(input.node_execution_id, input.port_id, inputIdentity) as any;
    if (existing) return this.rowToInput(existing);
    const node = this.getNodeExecution(input.node_execution_id);
    if (!node) {
      throw new ScopeExecutionReferenceError(`NodeExecution '${input.node_execution_id}' does not exist`);
    }
    if (input.supersedes_input_id) {
      const superseded = this.db.prepare(`
        SELECT * FROM node_execution_inputs
        WHERE input_id = ? AND node_execution_id = ? AND port_id = ? AND state = 'received'
      `).get(input.supersedes_input_id, input.node_execution_id, input.port_id) as any;
      if (!superseded) {
        throw new ScopeExecutionReferenceError(
          `input '${input.supersedes_input_id}' is not a received input on Port '${input.port_id}'`,
        );
      }
      if (node.status !== "collecting") {
        throw new ScopeExecutionTransitionError(
          `NodeExecution '${node.node_execution_id}' cannot replace inputs while '${node.status}'`,
        );
      }
      this.db.prepare(`
        UPDATE node_execution_inputs SET state = 'superseded', reason_json = ? WHERE input_id = ?
      `).run(json(input.reason ?? { code: "input_replaced" }), input.supersedes_input_id);
    }
    const record = {
      input_id: `input_${randomUUID()}`,
      accepted_at: nowIso(),
    };
    this.db.prepare(`
      INSERT INTO node_execution_inputs (
        input_id, node_execution_id, port_id, delivery_id, event_id,
        artefact_version_id, member_key, input_identity, state,
        supersedes_input_id, reason_json, accepted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.input_id,
      input.node_execution_id,
      input.port_id,
      input.delivery_id,
      input.event_id,
      versionId,
      memberKey,
      inputIdentity,
      input.state ?? "received",
      input.supersedes_input_id ?? null,
      json(input.reason),
      record.accepted_at,
    );
    return this.rowToInput(
      this.db.prepare(`SELECT * FROM node_execution_inputs WHERE input_id = ?`).get(record.input_id) as any,
    );
  }

  listInputs(nodeExecutionId: string): NodeExecutionInputRecord[] {
    return (this.db.prepare(`
      SELECT * FROM node_execution_inputs
      WHERE node_execution_id = ?
      ORDER BY port_id ASC, member_key ASC, input_identity ASC, accepted_at ASC, input_id ASC
    `).all(nodeExecutionId) as any[]).map((row) => this.rowToInput(row));
  }

  listReceivedInputs(nodeExecutionId: string): NodeExecutionInputRecord[] {
    return this.listInputs(nodeExecutionId).filter((input) => input.state === "received");
  }

  initializeRequiredPortExpectations(
    nodeExecutionId: string,
    ports: Array<{ port_id: string; min_count?: number }>,
  ): void {
    if (!this.getNodeExecution(nodeExecutionId)) {
      throw new ScopeExecutionReferenceError(`NodeExecution '${nodeExecutionId}' does not exist`);
    }
    const insert = this.db.prepare(`
      INSERT INTO node_execution_join_expectations (
        expectation_id, node_execution_id, port_id, expectation_kind,
        expectation_key, member_key, expected_artefact_version_id,
        source_artefact_version_id, match_policy, state, reason_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'required_port', ?, NULL, NULL, NULL,
        'cardinality', 'expected', '{}', ?, ?)
    `);
    for (const port of ports) {
      const minimum = port.min_count ?? 0;
      for (let ordinal = 1; ordinal <= minimum; ordinal += 1) {
        const key = `minimum:${ordinal}`;
        const existing = this.db.prepare(`
          SELECT expectation_id FROM node_execution_join_expectations
          WHERE node_execution_id = ? AND port_id = ?
            AND expectation_kind = 'required_port' AND expectation_key = ?
            AND source_artefact_version_id IS NULL
        `).get(nodeExecutionId, port.port_id, key);
        if (existing) continue;
        const timestamp = nowIso();
        insert.run(`expectation_${randomUUID()}`, nodeExecutionId, port.port_id, key, timestamp, timestamp);
      }
    }
  }

  registerExpectedMembership(input: {
    node_execution_id: string;
    collection_port_id: string;
    member_port_id: string;
    collection_artefact_version_id: string;
    match_policy: "member_key" | "member_key_and_version";
    members: Array<{ member_key: string; member_version_id: string }>;
  }): NodeExecutionExpectedMembershipRecord {
    const node = this.getNodeExecution(input.node_execution_id);
    if (!node) {
      throw new ScopeExecutionReferenceError(`NodeExecution '${input.node_execution_id}' does not exist`);
    }
    const existing = this.db.prepare(`
      SELECT * FROM node_execution_expected_memberships
      WHERE node_execution_id = ? AND collection_port_id = ? AND member_port_id = ?
        AND collection_artefact_version_id = ?
    `).get(
      input.node_execution_id,
      input.collection_port_id,
      input.member_port_id,
      input.collection_artefact_version_id,
    ) as any;
    if (existing) return this.rowToExpectedMembership(existing);
    const active = this.db.prepare(`
      SELECT * FROM node_execution_expected_memberships
      WHERE node_execution_id = ? AND collection_port_id = ? AND member_port_id = ? AND state = 'active'
    `).get(input.node_execution_id, input.collection_port_id, input.member_port_id) as any;
    if (active) {
      throw new ScopeExecutionReferenceError(
        `NodeExecution '${input.node_execution_id}' already pins expected membership from ArtefactVersion '${active.collection_artefact_version_id}'`,
      );
    }
    const keys = new Set<string>();
    for (const member of input.members) {
      if (!member.member_key.trim() || !member.member_version_id.trim()) {
        throw new ScopeExecutionReferenceError("expected collection members require stable keys and exact versions");
      }
      if (keys.has(member.member_key)) {
        throw new ScopeExecutionReferenceError(`expected collection repeats member key '${member.member_key}'`);
      }
      keys.add(member.member_key);
    }
    const timestamp = nowIso();
    const membershipId = `membership_${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO node_execution_expected_memberships (
        membership_id, node_execution_id, collection_port_id, member_port_id,
        collection_artefact_version_id, match_policy, state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(
      membershipId,
      input.node_execution_id,
      input.collection_port_id,
      input.member_port_id,
      input.collection_artefact_version_id,
      input.match_policy,
      timestamp,
    );
    const insert = this.db.prepare(`
      INSERT INTO node_execution_join_expectations (
        expectation_id, node_execution_id, port_id, expectation_kind,
        expectation_key, member_key, expected_artefact_version_id,
        source_artefact_version_id, match_policy, state, reason_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'collection_member', ?, ?, ?, ?, ?, 'expected', '{}', ?, ?)
    `);
    for (const member of [...input.members].sort((left, right) => left.member_key.localeCompare(right.member_key))) {
      insert.run(
        `expectation_${randomUUID()}`,
        input.node_execution_id,
        input.member_port_id,
        `member:${member.member_key}`,
        member.member_key,
        member.member_version_id,
        input.collection_artefact_version_id,
        input.match_policy,
        timestamp,
        timestamp,
      );
    }
    return this.rowToExpectedMembership(
      this.db.prepare(`SELECT * FROM node_execution_expected_memberships WHERE membership_id = ?`)
        .get(membershipId) as any,
    );
  }

  failExpectedMember(input: {
    node_execution_id: string;
    port_id: string;
    member_key: string;
    reason: Record<string, unknown>;
  }): NodeExecutionJoinState {
    const expectation = this.db.prepare(`
      SELECT expectation_id FROM node_execution_join_expectations
      WHERE node_execution_id = ? AND port_id = ? AND member_key = ? AND state = 'expected'
    `).get(input.node_execution_id, input.port_id, input.member_key) as { expectation_id: string } | undefined;
    if (!expectation) {
      throw new ScopeExecutionReferenceError(
        `expected member '${input.member_key}' is unavailable on Port '${input.port_id}'`,
      );
    }
    this.db.prepare(`
      UPDATE node_execution_join_expectations
      SET state = 'failed', reason_json = ?, updated_at = ? WHERE expectation_id = ?
    `).run(json(input.reason), nowIso(), expectation.expectation_id);
    const node = this.getNodeExecution(input.node_execution_id);
    if (node?.status === "collecting") {
      this.setNodeExecutionStatus(node.node_execution_id, "blocked", {
        code: "expected_member_failed",
        port_id: input.port_id,
        member_key: input.member_key,
        ...input.reason,
      });
    }
    return this.getJoinState(input.node_execution_id);
  }

  supersedeInput(input: {
    input_id: string;
    reason: Record<string, unknown>;
  }): NodeExecutionInputRecord {
    const row = this.db.prepare(`SELECT * FROM node_execution_inputs WHERE input_id = ?`).get(input.input_id) as any;
    if (!row) throw new ScopeExecutionReferenceError(`input '${input.input_id}' does not exist`);
    const node = this.getNodeExecution(String(row.node_execution_id));
    if (!node || node.status !== "collecting") {
      throw new ScopeExecutionTransitionError(
        `input '${input.input_id}' can only be superseded while its NodeExecution is collecting`,
      );
    }
    this.db.prepare(`
      UPDATE node_execution_inputs SET state = 'superseded', reason_json = ? WHERE input_id = ?
    `).run(json(input.reason), input.input_id);
    return this.rowToInput(this.db.prepare(`SELECT * FROM node_execution_inputs WHERE input_id = ?`).get(input.input_id) as any);
  }

  getJoinState(nodeExecutionId: string): NodeExecutionJoinState {
    if (!this.getNodeExecution(nodeExecutionId)) {
      throw new ScopeExecutionReferenceError(`NodeExecution '${nodeExecutionId}' does not exist`);
    }
    const inputs = this.listInputs(nodeExecutionId);
    const expectations = (this.db.prepare(`
      SELECT * FROM node_execution_join_expectations
      WHERE node_execution_id = ? ORDER BY port_id, expectation_kind, expectation_key, created_at
    `).all(nodeExecutionId) as any[]).map((row) => this.rowToExpectation(row));
    const memberships = (this.db.prepare(`
      SELECT * FROM node_execution_expected_memberships
      WHERE node_execution_id = ? ORDER BY created_at, membership_id
    `).all(nodeExecutionId) as any[]).map((row) => this.rowToExpectedMembership(row));
    const received = inputs.filter((item) => item.state === "received");
    const expected = expectations.filter((item) => item.state === "expected");
    const missing = expected.filter((item) => !expectationSatisfied(item, received));
    const failed = expectations.filter((item) => item.state === "failed");
    return {
      received,
      expected,
      missing,
      failed,
      late: inputs.filter((item) => item.state === "late"),
      superseded: {
        inputs: inputs.filter((item) => item.state === "superseded"),
        expectations: expectations.filter((item) => item.state === "superseded"),
        memberships: memberships.filter((item) => item.state === "superseded"),
      },
      memberships: memberships.filter((item) => item.state === "active"),
      ready: missing.length === 0 && failed.length === 0,
    };
  }

  startAttempt(input: {
    node_execution_id: string;
    delivery_ids?: string[];
    delivery_bundle_id?: string | null;
    runtime?: Record<string, unknown>;
    status?: "pending" | "running";
  }): ExecutionAttemptRecord {
    if (input.delivery_bundle_id) {
      const existing = this.getAttemptForBundle(input.delivery_bundle_id);
      if (existing) return existing;
    }
    const nodeExecution = this.getNodeExecution(input.node_execution_id);
    if (!nodeExecution) {
      throw new ScopeExecutionReferenceError(`NodeExecution '${input.node_execution_id}' does not exist`);
    }
    if (!["ready", "retrying", "waiting_external"].includes(nodeExecution.status)) {
      throw new ScopeExecutionTransitionError(
        `NodeExecution '${nodeExecution.node_execution_id}' cannot create an attempt while '${nodeExecution.status}'`,
      );
    }
    if ((input.status ?? "running") === "running" && nodeExecution.status !== "active") {
      // Validate before inserting an attempt so a refused transition cannot
      // leave behind a partial durable attempt outside a caller transaction.
      assertNodeStatusTransition(nodeExecution.status, "active");
    }
    const execution = this.getExecution(nodeExecution.execution_id);
    if (!execution) {
      throw new ScopeExecutionReferenceError(`ScopeExecution '${nodeExecution.execution_id}' does not exist`);
    }
    const placement = this.requireNodePlacement(
      nodeExecution.revision_id,
      nodeExecution.node_id,
      execution.workspace_id,
      execution.scope_id,
    );
    if (placement.kind === "actor") {
      this.assertPinnedActorReferences(nodeExecution, placement.resource_id, execution.workspace_id);
      if (hasAnyCommandPin(nodeExecution)) {
        throw new ScopeExecutionReferenceError(
          `Actor NodeExecution '${nodeExecution.node_execution_id}' cannot carry Command pins`,
        );
      }
    } else if (placement.kind === "command") {
      if (hasAnyActorPin(nodeExecution)) {
        throw new ScopeExecutionReferenceError(
          `Command NodeExecution '${nodeExecution.node_execution_id}' cannot carry Actor runtime pins`,
        );
      }
      this.assertPinnedCommandReferences(nodeExecution, placement.resource_id, execution.workspace_id);
    } else if (hasAnyActorPin(nodeExecution)) {
      throw new ScopeExecutionReferenceError(
        `non-Actor node '${nodeExecution.node_id}' cannot carry Actor runtime pins`,
      );
    }
    const ordinal = Number((this.db.prepare(`
      SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM execution_attempts WHERE node_execution_id = ?
    `).get(input.node_execution_id) as { next: number }).next);
    const id = `attempt_${randomUUID()}`;
    const timestamp = nowIso();
    const status = input.status ?? "running";
    this.db.prepare(`
      INSERT INTO execution_attempts (
        attempt_id, node_execution_id, ordinal, delivery_id, delivery_bundle_id,
        actor_definition_revision_id, runtime_profile_revision_id,
        actor_runtime_binding_id, command_definition_revision_id, command_worker_binding_id,
        status, runtime_json, resource_use_json,
        result_json, error_json, created_at, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '{}', '{}', ?, ?)
    `).run(
      id,
      input.node_execution_id,
      ordinal,
      input.delivery_ids?.length === 1 ? input.delivery_ids[0] : null,
      input.delivery_bundle_id ?? null,
      nodeExecution.actor_definition_revision_id,
      nodeExecution.runtime_profile_revision_id,
      nodeExecution.actor_runtime_binding_id,
      nodeExecution.command_definition_revision_id,
      nodeExecution.command_worker_binding_id,
      status,
      json(input.runtime),
      timestamp,
      status === "running" ? timestamp : null,
    );
    const addDelivery = this.db.prepare(`
      INSERT OR IGNORE INTO execution_attempt_deliveries (attempt_id, delivery_id)
      VALUES (?, ?)
    `);
    for (const deliveryId of [...new Set(input.delivery_ids ?? [])].sort()) {
      addDelivery.run(id, deliveryId);
    }
    if (status === "running") this.setNodeExecutionStatus(input.node_execution_id, "active");
    return this.getAttempt(id) as ExecutionAttemptRecord;
  }

  beginAttempt(input: {
    attempt_id: string;
    runtime?: Record<string, unknown>;
  }): ExecutionAttemptRecord {
    const attempt = this.getAttempt(input.attempt_id);
    if (!attempt) {
      throw new ScopeExecutionReferenceError(`ExecutionAttempt '${input.attempt_id}' does not exist`);
    }
    if (attempt.status === "running") return attempt;
    if (attempt.status !== "pending") {
      throw new ScopeExecutionReferenceError(
        `ExecutionAttempt '${input.attempt_id}' is '${attempt.status}' and cannot begin`,
      );
    }
    const nodeExecution = this.getNodeExecution(attempt.node_execution_id);
    if (!nodeExecution) {
      throw new ScopeExecutionReferenceError(
        `NodeExecution '${attempt.node_execution_id}' does not exist`,
      );
    }
    if (nodeExecution.status !== "active") {
      // As above, refuse before changing the attempt. Runtime preparation and
      // activation must remain one coherent restart-safe transition.
      assertNodeStatusTransition(nodeExecution.status, "active");
    }
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE execution_attempts
      SET status = 'running', runtime_json = ?, started_at = ?
      WHERE attempt_id = ? AND status = 'pending'
    `).run(json({ ...attempt.runtime, ...(input.runtime ?? {}) }), timestamp, attempt.attempt_id);
    this.setNodeExecutionStatus(attempt.node_execution_id, "active");
    return this.getAttempt(attempt.attempt_id) as ExecutionAttemptRecord;
  }

  finishAttempt(input: {
    attempt_id: string;
    status: Exclude<ExecutionAttemptStatus, "pending" | "running">;
    resource_use?: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: Record<string, unknown>;
  }): ExecutionAttemptRecord {
    const attempt = this.getAttempt(input.attempt_id);
    if (!attempt) {
      throw new ScopeExecutionReferenceError(`ExecutionAttempt '${input.attempt_id}' does not exist`);
    }
    if (attempt.status === input.status) return attempt;
    if (attempt.status !== "pending" && attempt.status !== "running") {
      throw new ScopeExecutionTransitionError(
        `ExecutionAttempt '${attempt.attempt_id}' cannot move from '${attempt.status}' to '${input.status}'`,
      );
    }
    this.db.prepare(`
      UPDATE execution_attempts
      SET status = ?, resource_use_json = ?, result_json = ?, error_json = ?, completed_at = ?
      WHERE attempt_id = ? AND status IN ('pending', 'running')
    `).run(
      input.status,
      json(input.resource_use),
      json(input.result),
      json(input.error),
      nowIso(),
      input.attempt_id,
    );
    return this.getAttempt(input.attempt_id) as ExecutionAttemptRecord;
  }

  getAttempt(attemptId: string): ExecutionAttemptRecord | null {
    const row = this.db.prepare(`SELECT * FROM execution_attempts WHERE attempt_id = ?`).get(attemptId) as any;
    return row ? this.rowToAttempt(row) : null;
  }

  getAttemptForBundle(deliveryBundleId: string): ExecutionAttemptRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM execution_attempts WHERE delivery_bundle_id = ? ORDER BY ordinal DESC LIMIT 1
    `).get(deliveryBundleId) as any;
    return row ? this.rowToAttempt(row) : null;
  }

  listAttempts(nodeExecutionId: string): ExecutionAttemptRecord[] {
    return (this.db.prepare(`
      SELECT * FROM execution_attempts
      WHERE node_execution_id = ? ORDER BY ordinal ASC
    `).all(nodeExecutionId) as any[]).map((row) => this.rowToAttempt(row));
  }

  listPublications(nodeExecutionId: string): OutputPublicationRecord[] {
    return (this.db.prepare(`
      SELECT * FROM scope_output_publications
      WHERE node_execution_id = ? ORDER BY created_at ASC, publication_id ASC
    `).all(nodeExecutionId) as any[]).map((row) => this.rowToPublication(row));
  }

  listTraversals(executionId: string): ScopeEdgeTraversalRecord[] {
    return this.db.prepare(`
      SELECT t.* FROM scope_edge_traversals t
      JOIN scope_output_publications p ON p.publication_id = t.publication_id
      JOIN node_executions n ON n.node_execution_id = p.node_execution_id
      WHERE n.execution_id = ? ORDER BY t.created_at ASC, t.traversal_id ASC
    `).all(executionId) as ScopeEdgeTraversalRecord[];
  }

  getPublicationByIdempotencyKey(idempotencyKey: string): OutputPublicationRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM scope_output_publications WHERE idempotency_key = ?
    `).get(idempotencyKey) as any;
    return row ? this.rowToPublication(row) : null;
  }

  createPublication(input: {
    node_execution_id: string;
    port_id: string;
    event_id: string;
    idempotency_key: string;
    published_by_endpoint_id?: string | null;
    artefact_versions?: Array<{ artefact_version_id: string; member_key?: string }>;
  }): OutputPublicationRecord {
    const existing = this.getPublicationByIdempotencyKey(input.idempotency_key);
    if (existing) return existing;
    const id = `publication_${randomUUID()}`;
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO scope_output_publications (
        publication_id, node_execution_id, port_id, event_id,
        idempotency_key, published_by_endpoint_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.node_execution_id,
      input.port_id,
      input.event_id,
      input.idempotency_key,
      input.published_by_endpoint_id ?? null,
      timestamp,
    );
    const insertOutput = this.db.prepare(`
      INSERT OR IGNORE INTO node_execution_outputs (publication_id, artefact_version_id, member_key)
      VALUES (?, ?, ?)
    `);
    for (const version of input.artefact_versions ?? []) {
      insertOutput.run(id, version.artefact_version_id, version.member_key ?? "");
    }
    return this.getPublicationByIdempotencyKey(input.idempotency_key) as OutputPublicationRecord;
  }

  recordTraversal(input: {
    publication_id: string;
    edge_id: string;
    delivery_id: string;
    target_node_execution_id: string;
  }): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO scope_edge_traversals (
        traversal_id, publication_id, edge_id, delivery_id, target_node_execution_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      `traversal_${randomUUID()}`,
      input.publication_id,
      input.edge_id,
      input.delivery_id,
      input.target_node_execution_id,
      nowIso(),
    );
  }

  private rowToScopeExecution(row: any): ScopeExecutionRecord {
    return {
      execution_id: String(row.execution_id),
      workspace_id: String(row.workspace_id),
      scope_id: String(row.scope_id),
      revision_id: String(row.revision_id),
      cause_event_id: row.cause_event_id ?? null,
      root_event_id: row.root_event_id ?? null,
      ingress_node_id: String(row.ingress_node_id),
      ingress_port_id: String(row.ingress_port_id),
      initiator_endpoint_id: row.initiator_endpoint_id ?? null,
      idempotency_key: row.idempotency_key ?? null,
      parent_execution_id: row.parent_execution_id ?? null,
      redo_of_node_execution_id: row.redo_of_node_execution_id ?? null,
      state_revision: Number(row.state_revision ?? 1),
      status: row.status as ScopeExecutionStatus,
      environment: parseJson(row.environment_json, {}),
      budget: parseJson(row.budget_json, {}),
      terminal: parseJson(row.terminal_json, {}),
      created_at: String(row.created_at),
      started_at: row.started_at ?? null,
      completed_at: row.completed_at ?? null,
      cancelled_at: row.cancelled_at ?? null,
    };
  }

  private rowToNodeExecution(row: any): NodeExecutionRecord {
    return {
      node_execution_id: String(row.node_execution_id),
      execution_id: String(row.execution_id),
      revision_id: String(row.revision_id),
      node_id: String(row.node_id),
      activation_key: String(row.activation_key),
      join_key: row.join_key == null ? null : String(row.join_key),
      context_id: String(row.context_id),
      actor_definition_revision_id: row.actor_definition_revision_id == null
        ? null
        : String(row.actor_definition_revision_id),
      runtime_profile_revision_id: row.runtime_profile_revision_id == null
        ? null
        : String(row.runtime_profile_revision_id),
      actor_runtime_binding_id: row.actor_runtime_binding_id == null
        ? null
        : String(row.actor_runtime_binding_id),
      command_definition_revision_id: row.command_definition_revision_id == null
        ? null
        : String(row.command_definition_revision_id),
      command_worker_binding_id: row.command_worker_binding_id == null
        ? null
        : String(row.command_worker_binding_id),
      state_revision: Number(row.state_revision ?? 1),
      status: row.status as NodeExecutionStatus,
      assigned_actor_ids: parseJson(row.assigned_actor_ids_json, []),
      failure: parseJson(row.failure_json, {}),
      created_at: String(row.created_at),
      activated_at: row.activated_at ?? null,
      completed_at: row.completed_at ?? null,
      cancelled_at: row.cancelled_at ?? null,
    };
  }

  private rowToInput(row: any): NodeExecutionInputRecord {
    return {
      input_id: String(row.input_id),
      node_execution_id: String(row.node_execution_id),
      port_id: String(row.port_id),
      delivery_id: String(row.delivery_id),
      event_id: String(row.event_id),
      artefact_version_id: row.artefact_version_id ?? null,
      member_key: String(row.member_key),
      input_identity: row.input_identity == null
        ? (row.artefact_version_id
            ? `artefact:${String(row.artefact_version_id)}:member:${String(row.member_key)}`
            : `event:${String(row.event_id)}:member:${String(row.member_key)}`)
        : String(row.input_identity),
      state: row.state === "late" || row.state === "superseded" ? row.state : "received",
      supersedes_input_id: row.supersedes_input_id ?? null,
      reason: parseJson(row.reason_json, {}),
      accepted_at: String(row.accepted_at),
    };
  }

  private rowToExpectation(row: any): NodeExecutionExpectationRecord {
    return {
      expectation_id: String(row.expectation_id),
      node_execution_id: String(row.node_execution_id),
      port_id: String(row.port_id),
      expectation_kind: row.expectation_kind === "collection_member" ? "collection_member" : "required_port",
      expectation_key: String(row.expectation_key),
      member_key: row.member_key == null ? null : String(row.member_key),
      expected_artefact_version_id: row.expected_artefact_version_id == null
        ? null
        : String(row.expected_artefact_version_id),
      source_artefact_version_id: row.source_artefact_version_id == null
        ? null
        : String(row.source_artefact_version_id),
      match_policy: row.match_policy === "member_key"
        ? "member_key"
        : row.match_policy === "member_key_and_version"
          ? "member_key_and_version"
          : "cardinality",
      state: row.state === "failed" || row.state === "superseded" ? row.state : "expected",
      reason: parseJson(row.reason_json, {}),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  private rowToExpectedMembership(row: any): NodeExecutionExpectedMembershipRecord {
    return {
      membership_id: String(row.membership_id),
      node_execution_id: String(row.node_execution_id),
      collection_port_id: String(row.collection_port_id),
      member_port_id: String(row.member_port_id),
      collection_artefact_version_id: String(row.collection_artefact_version_id),
      match_policy: row.match_policy === "member_key_and_version" ? "member_key_and_version" : "member_key",
      state: row.state === "superseded" ? "superseded" : "active",
      created_at: String(row.created_at),
      superseded_at: row.superseded_at ?? null,
    };
  }

  private rowToAttempt(row: any): ExecutionAttemptRecord {
    return {
      attempt_id: String(row.attempt_id),
      node_execution_id: String(row.node_execution_id),
      ordinal: Number(row.ordinal),
      delivery_ids: (this.db.prepare(`
        SELECT delivery_id FROM execution_attempt_deliveries
        WHERE attempt_id = ? ORDER BY delivery_id
      `).all(String(row.attempt_id)) as Array<{ delivery_id: string }>).map((item) => String(item.delivery_id)),
      delivery_id: row.delivery_id ?? null,
      delivery_bundle_id: row.delivery_bundle_id ?? null,
      actor_definition_revision_id: row.actor_definition_revision_id == null
        ? null
        : String(row.actor_definition_revision_id),
      runtime_profile_revision_id: row.runtime_profile_revision_id == null
        ? null
        : String(row.runtime_profile_revision_id),
      actor_runtime_binding_id: row.actor_runtime_binding_id == null
        ? null
        : String(row.actor_runtime_binding_id),
      command_definition_revision_id: row.command_definition_revision_id == null
        ? null
        : String(row.command_definition_revision_id),
      command_worker_binding_id: row.command_worker_binding_id == null
        ? null
        : String(row.command_worker_binding_id),
      status: row.status as ExecutionAttemptStatus,
      runtime: parseJson(row.runtime_json, {}),
      resource_use: parseJson(row.resource_use_json, {}),
      result: parseJson(row.result_json, {}),
      error: parseJson(row.error_json, {}),
      created_at: String(row.created_at),
      started_at: row.started_at ?? null,
      completed_at: row.completed_at ?? null,
    };
  }

  private rowToPublication(row: any): OutputPublicationRecord {
    return {
      publication_id: String(row.publication_id),
      node_execution_id: String(row.node_execution_id),
      port_id: String(row.port_id),
      event_id: String(row.event_id),
      idempotency_key: String(row.idempotency_key),
      published_by_endpoint_id: row.published_by_endpoint_id ?? null,
      created_at: String(row.created_at),
      outputs: (this.db.prepare(`
        SELECT artefact_version_id, member_key
        FROM node_execution_outputs
        WHERE publication_id = ?
        ORDER BY member_key ASC, artefact_version_id ASC
      `).all(String(row.publication_id)) as NodeExecutionOutputRecord[]).map((output) => ({
        artefact_version_id: output.artefact_version_id ?? null,
        member_key: String(output.member_key),
      })),
    };
  }

  private activePause(executionId: string): {
    pause_id: string;
    prior_status: ScopeExecutionStatus;
    prior_terminal_json: string;
  } | null {
    const row = this.db.prepare(`
      SELECT pause_id, prior_status, prior_terminal_json
      FROM scope_execution_pauses
      WHERE execution_id = ? AND resumed_at IS NULL
    `).get(executionId) as {
      pause_id: string;
      prior_status: ScopeExecutionStatus;
      prior_terminal_json: string;
    } | undefined;
    return row ?? null;
  }

  private pauseResult(execution: ScopeExecutionRecord, pauseId: string): ScopeExecutionPauseResult {
    const nodeIds = (this.db.prepare(`
      SELECT node_execution_id FROM scope_execution_pause_nodes
      WHERE pause_id = ? ORDER BY node_execution_id
    `).all(pauseId) as Array<{ node_execution_id: string }>).map((row) => row.node_execution_id);
    const deliveryIds = (this.db.prepare(`
      SELECT queue_id FROM scope_execution_pause_deliveries
      WHERE pause_id = ? ORDER BY queue_id
    `).all(pauseId) as Array<{ queue_id: string }>).map((row) => row.queue_id);
    return {
      execution,
      pause_id: pauseId,
      node_execution_ids: nodeIds,
      delivery_ids: deliveryIds,
    };
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private requireNodePlacement(
    revisionId: string,
    nodeId: string,
    workspaceId: string,
    scopeId: string,
  ): {
    kind: string;
    resource_id: string | null;
  } {
    const placement = this.db.prepare(`
      SELECT n.kind, n.resource_id, r.workspace_id, r.scope_id,
             r.routing_mode, r.published_at, r.withdrawn_at
      FROM scope_node_placements n
      JOIN scope_composition_revisions r ON r.revision_id = n.revision_id
      WHERE n.revision_id = ? AND n.node_id = ?
    `).get(revisionId, nodeId) as {
      kind: string;
      resource_id: string | null;
      workspace_id: string;
      scope_id: string;
      routing_mode: string;
      published_at: string | null;
      withdrawn_at: string | null;
    } | undefined;
    if (!placement || placement.workspace_id !== workspaceId || placement.scope_id !== scopeId
      || placement.routing_mode !== "edge" || !placement.published_at || placement.withdrawn_at) {
      throw new ScopeExecutionReferenceError(
        `NodePlacement '${nodeId}' is unavailable in a retained published design for this Scope`,
      );
    }
    if (placement.kind === "actor" && !placement.resource_id?.trim()) {
      throw new ScopeExecutionReferenceError(`Actor node '${nodeId}' has no Actor reference`);
    }
    if (placement.kind === "command" && !placement.resource_id?.trim()) {
      throw new ScopeExecutionReferenceError(`Command node '${nodeId}' has no Command reference`);
    }
    return placement;
  }

  private resolveCurrentActorPins(workspaceId: string, actorId: string | null): ActorExecutionPins {
    if (!actorId) throw new ScopeExecutionReferenceError("Actor placement has no Actor reference");
    const actor = this.db.prepare(`
      SELECT actor_id, workspace_id, status, current_definition_revision_id
      FROM actors WHERE actor_id = ?
    `).get(actorId) as {
      actor_id: string;
      workspace_id: string;
      status: string;
      current_definition_revision_id: string | null;
    } | undefined;
    if (!actor || actor.workspace_id !== workspaceId || actor.status !== "active"
      || !actor.current_definition_revision_id) {
      throw new ScopeExecutionReferenceError(
        `Actor '${actorId}' is missing, retired, outside this Workspace, or has no published definition`,
      );
    }
    const binding = this.db.prepare(`
      SELECT actor_runtime_binding_id, runtime_profile_revision_id
      FROM actor_runtime_bindings
      WHERE actor_id = ? AND superseded_at IS NULL
    `).get(actorId) as {
      actor_runtime_binding_id: string;
      runtime_profile_revision_id: string;
    } | undefined;
    if (!binding) {
      throw new ScopeExecutionReferenceError(`Actor '${actorId}' has no current runtime binding`);
    }
    const pins: ActorExecutionPins = {
      actor_definition_revision_id: actor.current_definition_revision_id,
      runtime_profile_revision_id: binding.runtime_profile_revision_id,
      actor_runtime_binding_id: binding.actor_runtime_binding_id,
    };
    this.assertActorReferences(workspaceId, actorId, pins, true);
    return pins;
  }

  private assertPinnedActorReferences(
    node: NodeExecutionRecord,
    actorId: string | null,
    workspaceId: string,
  ): void {
    if (!actorId || !hasAllActorPins(node)) {
      throw new ScopeExecutionReferenceError(
        `Actor NodeExecution '${node.node_execution_id}' has no complete immutable Actor/runtime pins`,
      );
    }
    this.assertActorReferences(workspaceId, actorId, node, false);
  }

  private assertActorReferences(
    workspaceId: string,
    actorId: string,
    pins: ActorExecutionPins,
    requireCurrentBinding: boolean,
  ): void {
    const actor = this.db.prepare(`
      SELECT workspace_id, status FROM actors WHERE actor_id = ?
    `).get(actorId) as { workspace_id: string; status: string } | undefined;
    if (!actor || actor.workspace_id !== workspaceId || actor.status !== "active") {
      throw new ScopeExecutionReferenceError(`Actor '${actorId}' is unavailable in this Workspace`);
    }
    const definition = this.db.prepare(`
      SELECT actor_id, workspace_id, published_at, withdrawn_at
      FROM actor_definition_revisions WHERE actor_definition_revision_id = ?
    `).get(pins.actor_definition_revision_id) as {
      actor_id: string;
      workspace_id: string;
      published_at: string | null;
      withdrawn_at: string | null;
    } | undefined;
    if (!definition || definition.actor_id !== actorId || definition.workspace_id !== workspaceId
      || !definition.published_at || definition.withdrawn_at) {
      throw new ScopeExecutionReferenceError(
        `Actor definition revision '${pins.actor_definition_revision_id}' is not retained and published for this Actor`,
      );
    }
    const binding = this.db.prepare(`
      SELECT actor_id, workspace_id, runtime_profile_id,
             runtime_profile_revision_id, status, superseded_at
      FROM actor_runtime_bindings WHERE actor_runtime_binding_id = ?
    `).get(pins.actor_runtime_binding_id) as {
      actor_id: string;
      workspace_id: string;
      runtime_profile_id: string;
      runtime_profile_revision_id: string;
      status: string;
      superseded_at: string | null;
    } | undefined;
    if (!binding || binding.actor_id !== actorId || binding.workspace_id !== workspaceId
      || binding.runtime_profile_revision_id !== pins.runtime_profile_revision_id
      || binding.status !== "resolved" || (requireCurrentBinding && binding.superseded_at)) {
      throw new ScopeExecutionReferenceError(
        `Actor runtime binding '${pins.actor_runtime_binding_id}' is not resolved for this Actor and Workspace`,
      );
    }
    const revision = this.db.prepare(`
      SELECT runtime_profile_id, published_at, withdrawn_at
      FROM runtime_profile_revisions WHERE runtime_profile_revision_id = ?
    `).get(pins.runtime_profile_revision_id) as {
      runtime_profile_id: string;
      published_at: string | null;
      withdrawn_at: string | null;
    } | undefined;
    if (!revision || revision.runtime_profile_id !== binding.runtime_profile_id
      || !revision.published_at || revision.withdrawn_at) {
      throw new ScopeExecutionReferenceError(
        `runtime profile revision '${pins.runtime_profile_revision_id}' is not retained and published`,
      );
    }
    const profile = this.db.prepare(`
      SELECT owner_kind, owner_id, status FROM runtime_profiles WHERE runtime_profile_id = ?
    `).get(binding.runtime_profile_id) as {
      owner_kind: string;
      owner_id: string;
      status: string;
    } | undefined;
    if (!profile || profile.status !== "active"
      || (profile.owner_kind === "workspace" && profile.owner_id !== workspaceId)) {
      throw new ScopeExecutionReferenceError(
        `runtime profile '${binding.runtime_profile_id}' is retired, missing, or outside this Workspace`,
      );
    }
  }

  private assertPinnedCommandReferences(
    node: NodeExecutionRecord,
    commandId: string | null,
    workspaceId: string,
  ): void {
    if (!commandId || !hasAllCommandPins(node)) {
      throw new ScopeExecutionReferenceError(
        `Command NodeExecution '${node.node_execution_id}' has no complete immutable Command/worker pins`,
      );
    }
    const command = this.db.prepare(`
      SELECT owner_kind, owner_id FROM commands WHERE command_id = ?
    `).get(commandId) as { owner_kind: string; owner_id: string } | undefined;
    const definition = this.db.prepare(`
      SELECT command_id, owner_kind, owner_id, published_at, withdrawn_at
      FROM command_definition_revisions WHERE command_definition_revision_id = ?
    `).get(node.command_definition_revision_id) as {
      command_id: string;
      owner_kind: string;
      owner_id: string;
      published_at: string | null;
      withdrawn_at: string | null;
    } | undefined;
    if (!command || !definition || definition.command_id !== commandId
      || definition.owner_kind !== command.owner_kind || definition.owner_id !== command.owner_id
      || !definition.published_at || definition.withdrawn_at
      || (command.owner_kind === "workspace" && command.owner_id !== workspaceId)) {
      throw new ScopeExecutionReferenceError(
        `Command definition revision '${node.command_definition_revision_id}' is not retained and published for this Command and Workspace`,
      );
    }
    const worker = this.db.prepare(`
      SELECT workspace_id, host_id, worker_endpoint_id, status
      FROM command_worker_bindings WHERE command_worker_binding_id = ?
    `).get(node.command_worker_binding_id) as {
      workspace_id: string;
      host_id: string;
      worker_endpoint_id: string;
      status: string;
    } | undefined;
    const endpoint = worker ? this.db.prepare(`
      SELECT workspace_id, bridge_id FROM endpoints WHERE endpoint_id = ?
    `).get(worker.worker_endpoint_id) as { workspace_id: string; bridge_id: string | null } | undefined : undefined;
    if (!worker || worker.workspace_id !== workspaceId || worker.status !== "available"
      || !endpoint || endpoint.workspace_id !== workspaceId || endpoint.bridge_id !== null
      || (command.owner_kind === "host" && command.owner_id !== worker.host_id)) {
      throw new ScopeExecutionReferenceError(
        `Command worker binding '${node.command_worker_binding_id}' is unavailable for this Command and Workspace`,
      );
    }
  }
}

type ActorExecutionPins = Readonly<{
  actor_definition_revision_id: string;
  runtime_profile_revision_id: string;
  actor_runtime_binding_id: string;
}>;

function emptyActorPins(): {
  actor_definition_revision_id: null;
  runtime_profile_revision_id: null;
  actor_runtime_binding_id: null;
} {
  return {
    actor_definition_revision_id: null,
    runtime_profile_revision_id: null,
    actor_runtime_binding_id: null,
  };
}

function hasAnyActorPin(value: Pick<NodeExecutionRecord,
  "actor_definition_revision_id" | "runtime_profile_revision_id" | "actor_runtime_binding_id">): boolean {
  return value.actor_definition_revision_id !== null
    || value.runtime_profile_revision_id !== null
    || value.actor_runtime_binding_id !== null;
}

function hasAllActorPins(value: Pick<NodeExecutionRecord,
  "actor_definition_revision_id" | "runtime_profile_revision_id" | "actor_runtime_binding_id">): value is ActorExecutionPins & typeof value {
  return value.actor_definition_revision_id !== null
    && value.runtime_profile_revision_id !== null
    && value.actor_runtime_binding_id !== null;
}

type CommandExecutionPins = Readonly<{
  command_definition_revision_id: string;
  command_worker_binding_id: string;
}>;

function emptyCommandPins(): {
  command_definition_revision_id: null;
  command_worker_binding_id: null;
} {
  return { command_definition_revision_id: null, command_worker_binding_id: null };
}

function hasAnyCommandPin(value: Pick<NodeExecutionRecord,
  "command_definition_revision_id" | "command_worker_binding_id">): boolean {
  return value.command_definition_revision_id !== null || value.command_worker_binding_id !== null;
}

function hasAllCommandPins(value: Pick<NodeExecutionRecord,
  "command_definition_revision_id" | "command_worker_binding_id">): value is CommandExecutionPins & typeof value {
  return value.command_definition_revision_id !== null && value.command_worker_binding_id !== null;
}

const SCOPE_STATUS_TRANSITIONS: Readonly<Record<ScopeExecutionStatus, readonly ScopeExecutionStatus[]>> = {
  queued: ["active", "paused", "blocked", "failed", "cancelled", "superseded"],
  active: ["waiting_external", "paused", "blocked", "completed", "failed", "cancelled", "superseded"],
  waiting_external: ["active", "paused", "blocked", "completed", "failed", "cancelled", "superseded"],
  paused: ["active", "waiting_external", "blocked", "failed", "cancelled", "superseded"],
  blocked: ["active", "waiting_external", "paused", "failed", "cancelled", "superseded"],
  completed: [],
  failed: [],
  cancelled: [],
  superseded: [],
};

const NODE_STATUS_TRANSITIONS: Readonly<Record<NodeExecutionStatus, readonly NodeExecutionStatus[]>> = {
  collecting: ["ready", "paused", "blocked", "failed", "cancelled", "superseded"],
  ready: ["active", "waiting_external", "paused", "retrying", "blocked", "completed", "failed", "cancelled", "superseded"],
  active: ["waiting_external", "paused", "retrying", "blocked", "completed", "failed", "cancelled", "superseded"],
  waiting_external: ["ready", "active", "paused", "retrying", "blocked", "completed", "failed", "cancelled", "superseded"],
  paused: ["collecting", "ready", "active", "waiting_external", "retrying", "blocked", "failed", "cancelled", "superseded"],
  retrying: ["ready", "active", "waiting_external", "paused", "blocked", "completed", "failed", "cancelled", "superseded"],
  blocked: ["collecting", "ready", "paused", "failed", "cancelled", "superseded"],
  completed: [],
  failed: [],
  cancelled: [],
  superseded: [],
};

function assertScopeStatusTransition(from: ScopeExecutionStatus, to: ScopeExecutionStatus): void {
  if (!SCOPE_STATUS_TRANSITIONS[from]?.includes(to)) {
    throw new ScopeExecutionTransitionError(`ScopeExecution cannot move from '${from}' to '${to}'`);
  }
}

function assertNodeStatusTransition(from: NodeExecutionStatus, to: NodeExecutionStatus): void {
  if (!NODE_STATUS_TRANSITIONS[from]?.includes(to)) {
    throw new ScopeExecutionTransitionError(`NodeExecution cannot move from '${from}' to '${to}'`);
  }
}

function expectationSatisfied(
  expectation: NodeExecutionExpectationRecord,
  inputs: NodeExecutionInputRecord[],
): boolean {
  const portInputs = inputs.filter((input) => input.port_id === expectation.port_id);
  if (expectation.expectation_kind === "required_port") {
    const ordinal = Number(expectation.expectation_key.replace(/^minimum:/, ""));
    return Number.isSafeInteger(ordinal) && ordinal > 0 && portInputs.length >= ordinal;
  }
  return portInputs.some((input) => {
    if (input.member_key !== expectation.member_key) return false;
    return expectation.match_policy !== "member_key_and_version"
      || input.artefact_version_id === expectation.expected_artefact_version_id;
  });
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((existing) => existing.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table));
}
