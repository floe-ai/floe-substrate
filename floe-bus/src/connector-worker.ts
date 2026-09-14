import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CronExpressionParser } from "cron-parser";

import type { VersionedResourceRef } from "./actor-definitions.js";
import type { CredentialBrokerService } from "./credential-broker.js";
import {
  ConnectorLifecycleConflictError,
  ConnectorNotFoundError,
  ConnectorRevisionConflictError,
  ConnectorStore,
  ConnectorValidationError,
  type ConnectorActionInterface,
  type ConnectorBindingRecord,
  type ConnectorBindingRevision,
  type ConnectorDefinitionRevision,
  type ConnectorEvidenceRef,
  type ConnectorIngressResult,
  type ConnectorIngressVerification,
  type ConnectorOwner,
  type ConnectorSourceInterface,
  type ExternalActionAttempt,
  type ExternalEffectReceipt,
} from "./connectors.js";

export const CONNECTOR_WORKER_SOURCE_OPERATION_ID = "connector.worker.source.observe";
export const CONNECTOR_WORKER_ACTION_OPERATION_ID = "connector.worker.action.execute";
export const CONNECTOR_WORKER_RECONCILE_OPERATION_ID = "connector.worker.action.reconcile";
export const CONNECTOR_WORKER_HEALTH_OPERATION_ID = "connector.worker.health.inspect";

export type ConnectorWorkerPin = Readonly<{
  owner: ConnectorOwner;
  binding: ConnectorBindingRecord;
  binding_revision: ConnectorBindingRevision;
  definition_revision: ConnectorDefinitionRevision;
}>;

export type ConnectorSourceCheckpoint = Readonly<{
  connector_binding_id: string;
  connector_binding_revision_id: string;
  source_interface_id: string;
  state_version: number;
  checkpoint_ref: ConnectorEvidenceRef | null;
  last_observed_at: string | null;
  schedule_cursor_at: string | null;
  next_due_at: string | null;
  updated_at: string;
}>;

export type ConnectorWorkerObservation = Readonly<{
  idempotency_key: string;
  external_identity: string;
  external_revision?: string | null;
  payload_digest: string;
  verification: ConnectorIngressVerification;
  evidence_refs?: readonly ConnectorEvidenceRef[];
  checkpoint_ref?: ConnectorEvidenceRef | null;
  observed_at: string;
}>;

export type ConnectorWorkerMaterializedIngress = Readonly<{
  normalized_event_id: string;
  artefact_version_ids?: readonly string[];
}>;

export type ConnectorWorkerPollResult = Readonly<{
  observations: readonly ConnectorWorkerObservation[];
  /** Exact evidence containing the opaque provider cursor. Floe never stores cursor bytes inline. */
  checkpoint_ref: ConnectorEvidenceRef;
  observed_at: string;
}>;

export type ConnectorWorkerHealthResult = Readonly<{
  status: "healthy" | "degraded" | "unhealthy";
  code?: string | null;
  evidence_refs?: readonly ConnectorEvidenceRef[];
  observed_at: string;
}>;

export type ConnectorWorkerActionResult =
  | Readonly<{
      outcome: "succeeded";
      provider_response_ref?: ConnectorEvidenceRef | null;
      observed_result_ref?: ConnectorEvidenceRef | null;
    }>
  | Readonly<{
      /** The runner proves no external request was sent. */
      outcome: "not_sent";
      code: string;
    }>
  | Readonly<{
      /** The runner cannot prove whether the external effect happened. */
      outcome: "outcome_unknown";
      code: string;
      provider_response_ref?: ConnectorEvidenceRef | null;
    }>;

export type ConnectorWorkerReconciliationResult = Readonly<{
  outcome: "succeeded" | "failed" | "outcome_unknown";
  evidence_ref: ConnectorEvidenceRef;
}>;

export type ConnectorWorkerCredentialAccess = Readonly<{
  withSecret<Result>(
    slotId: string,
    operationId: string,
    use: (material: Readonly<Uint8Array>) => Promise<Result> | Result,
  ): Promise<Result>;
}>;

type ConnectorWorkerBaseRequest = Readonly<{
  pin: ConnectorWorkerPin;
  credentials: ConnectorWorkerCredentialAccess;
}>;

export interface ConnectorWorkerRunner {
  inspectHealth?(request: ConnectorWorkerBaseRequest): Promise<ConnectorWorkerHealthResult>;
  normalizePush?(request: ConnectorWorkerBaseRequest & Readonly<{
    source: ConnectorSourceInterface;
    envelope: unknown;
  }>): Promise<ConnectorWorkerObservation>;
  poll?(request: ConnectorWorkerBaseRequest & Readonly<{
    source: ConnectorSourceInterface;
    checkpoint_ref: ConnectorEvidenceRef | null;
  }>): Promise<ConnectorWorkerPollResult>;
  executeAction?(request: ConnectorWorkerBaseRequest & Readonly<{
    action: ConnectorActionInterface;
    external_effect: ExternalEffectReceipt;
  }>): Promise<ConnectorWorkerActionResult>;
  reconcileAction?(request: ConnectorWorkerBaseRequest & Readonly<{
    action: ConnectorActionInterface;
    external_effect: ExternalEffectReceipt;
  }>): Promise<ConnectorWorkerReconciliationResult>;
}

export type ConnectorWorkerDependencies = Readonly<{
  connector_store: ConnectorStore;
  checkpoint_store: ConnectorWorkerCheckpointStore;
  credential_broker: Pick<CredentialBrokerService, "useSecret">;
  principal_id: string;
  /** Canonical restore holds fail closed before any Workspace Connector effect. */
  workspace_effects_allowed: (workspaceId: string) => boolean;
  resolve_runner: (implementation: VersionedResourceRef) => ConnectorWorkerRunner | null;
  resolve_secret_grant: (input: Readonly<{
    owner: ConnectorOwner;
    principal_id: string;
    connector_binding_id: string;
    connector_binding_revision_id: string;
    secret_ref_id: string;
    candidate_grant_ids: readonly string[];
    operation_id: string;
    purpose: string;
  }>) => string | null;
  /**
   * Atomically verifies and consumes every required canonical ApprovalReceipt
   * and moves the ExternalEffectReceipt from requested/failed to running by
   * creating its attempt. A deterministic expected approval ID is never proof.
   */
  begin_action_attempt: (input: Readonly<{
    operation_id: typeof CONNECTOR_WORKER_ACTION_OPERATION_ID;
    principal_id: string;
    pin: ConnectorWorkerPin;
    action: ConnectorActionInterface;
    external_effect: ExternalEffectReceipt;
    request_evidence_ref: ConnectorEvidenceRef;
    approval_receipt_ids: readonly string[];
    checked_at: string;
  }>) => Promise<ExternalActionAttempt>;
  /**
   * Materializes by ConnectorIngressReceipt identity. It must be idempotent
   * across process loss: the same receipt always resolves to the same Event.
   */
  materialize_ingress: (input: Readonly<{
    pin: ConnectorWorkerPin;
    source: ConnectorSourceInterface;
    ingress: ConnectorIngressResult;
  }>) => Promise<ConnectorWorkerMaterializedIngress>;
  write_evidence: (input: Readonly<{
    kind: string;
    facts: Readonly<Record<string, string | number | boolean | null | readonly string[]>>;
  }>) => Promise<ConnectorEvidenceRef>;
  inspect_schedule_activity: (input: Readonly<{
    pin: ConnectorWorkerPin;
    source: ConnectorSourceInterface;
  }>) => Promise<Readonly<{ active_fire_count: number }>>;
  /** Arms or clears one exact wake. This is not a recurring poll loop. */
  arm_schedule_wake: (input: Readonly<{
    pin: ConnectorWorkerPin;
    source: ConnectorSourceInterface;
    next_due_at: string | null;
  }>) => Promise<void>;
  now?: () => string;
}>;

export class ConnectorWorkerError extends Error {
  readonly code = "E_CONNECTOR_WORKER" as const;

  constructor(readonly reason: string) {
    super(`Connector worker could not continue: ${reason}`);
    this.name = "ConnectorWorkerError";
  }
}

export class ConnectorCheckpointConflictError extends Error {
  readonly code = "E_CONNECTOR_CHECKPOINT_CONFLICT" as const;

  constructor(
    readonly connector_binding_revision_id: string,
    readonly source_interface_id: string,
  ) {
    super("Connector source checkpoint changed before this worker could commit it.");
    this.name = "ConnectorCheckpointConflictError";
  }
}

/**
 * Durable Connector-worker continuation state. It stores exact evidence refs,
 * never provider cursor bytes, and is pinned to one ConnectorBindingRevision.
 * It is runtime state owned by the Connector binding, not another queue.
 */
export class ConnectorWorkerCheckpointStore {
  constructor(
    readonly db: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    applyConnectorWorkerCheckpointSchema(db);
  }

  get(
    connectorBindingRevisionId: string,
    sourceInterfaceId: string,
  ): ConnectorSourceCheckpoint | null {
    const row = this.db.prepare(`
      SELECT * FROM connector_source_checkpoints
      WHERE connector_binding_revision_id = ? AND source_interface_id = ?
    `).get(
      requireWorkerText(connectorBindingRevisionId, "connector_binding_revision_id"),
      requireWorkerText(sourceInterfaceId, "source_interface_id"),
    ) as ConnectorSourceCheckpointRow | undefined;
    return row ? checkpointFromRow(row) : null;
  }

  advance(input: Readonly<{
    pin: ConnectorWorkerPin;
    source_interface_id: string;
    expected_state_version: number;
    checkpoint_ref: ConnectorEvidenceRef | null;
    last_observed_at: string | null;
    schedule_cursor_at: string | null;
    next_due_at: string | null;
  }>): ConnectorSourceCheckpoint {
    const sourceId = requireWorkerText(input.source_interface_id, "source_interface_id");
    requirePinnedSource(input.pin, sourceId, false);
    const expected = requireNonNegativeInteger(input.expected_state_version, "expected_state_version");
    const checkpointRef = input.checkpoint_ref === null
      ? null
      : normalizeEvidenceRef(input.checkpoint_ref, "checkpoint_ref");
    const lastObservedAt = nullableTimestamp(input.last_observed_at, "last_observed_at");
    const scheduleCursorAt = nullableTimestamp(input.schedule_cursor_at, "schedule_cursor_at");
    const nextDueAt = nullableTimestamp(input.next_due_at, "next_due_at");
    const updatedAt = requireTimestamp(this.now(), "updated_at");

    const existing = this.get(input.pin.binding_revision.connector_binding_revision_id, sourceId);
    if (!existing) {
      if (expected !== 0) {
        throw new ConnectorCheckpointConflictError(
          input.pin.binding_revision.connector_binding_revision_id,
          sourceId,
        );
      }
      this.db.prepare(`
        INSERT INTO connector_source_checkpoints (
          connector_binding_id, connector_binding_revision_id, source_interface_id,
          state_version, checkpoint_ref_json, last_observed_at,
          schedule_cursor_at, next_due_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
      `).run(
        input.pin.binding.connector_binding_id,
        input.pin.binding_revision.connector_binding_revision_id,
        sourceId,
        checkpointRef === null ? null : JSON.stringify(checkpointRef),
        lastObservedAt,
        scheduleCursorAt,
        nextDueAt,
        updatedAt,
      );
    } else {
      const result = this.db.prepare(`
        UPDATE connector_source_checkpoints
        SET state_version = state_version + 1, checkpoint_ref_json = ?,
            last_observed_at = ?, schedule_cursor_at = ?, next_due_at = ?,
            updated_at = ?
        WHERE connector_binding_revision_id = ? AND source_interface_id = ?
          AND state_version = ?
      `).run(
        checkpointRef === null ? null : JSON.stringify(checkpointRef),
        lastObservedAt,
        scheduleCursorAt,
        nextDueAt,
        updatedAt,
        input.pin.binding_revision.connector_binding_revision_id,
        sourceId,
        expected,
      );
      if (Number(result.changes) !== 1) {
        throw new ConnectorCheckpointConflictError(
          input.pin.binding_revision.connector_binding_revision_id,
          sourceId,
        );
      }
    }
    return this.get(input.pin.binding_revision.connector_binding_revision_id, sourceId)!;
  }
}

export function applyConnectorWorkerCheckpointSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connector_source_checkpoints (
      connector_binding_id TEXT NOT NULL REFERENCES connector_bindings(connector_binding_id),
      connector_binding_revision_id TEXT NOT NULL REFERENCES connector_binding_revisions(connector_binding_revision_id),
      source_interface_id TEXT NOT NULL,
      state_version INTEGER NOT NULL CHECK (state_version > 0),
      checkpoint_ref_json TEXT,
      last_observed_at TEXT,
      schedule_cursor_at TEXT,
      next_due_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (connector_binding_revision_id, source_interface_id)
    );

    CREATE INDEX IF NOT EXISTS idx_connector_source_checkpoints_binding
      ON connector_source_checkpoints(connector_binding_id, source_interface_id, updated_at DESC);
  `);
}

export class ConnectorWorkerHost {
  private readonly now: () => string;
  private readonly activePolls = new Set<string>();
  private readonly activeIngress = new Map<string, Promise<ConnectorWorkerMaterializedIngress>>();

  constructor(private readonly dependencies: ConnectorWorkerDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  pinEnabledBinding(connectorBindingId: string, owner: ConnectorOwner): ConnectorWorkerPin {
    this.assertOwnerEffectsAllowed(owner);
    const binding = this.dependencies.connector_store.requireBindingForOwner(connectorBindingId, owner);
    if (binding.status !== "enabled") {
      throw new ConnectorLifecycleConflictError(binding.connector_binding_id, "it is not enabled");
    }
    return this.pinExactRevision(binding, binding.current_revision_id, owner);
  }

  async inspectHealth(connectorBindingId: string, owner: ConnectorOwner) {
    const pin = this.pinEnabledBinding(connectorBindingId, owner);
    const runner = this.requireRunner(pin);
    const guard = new SecretEchoGuard();
    try {
      if (!runner.inspectHealth) throw new ConnectorWorkerError("its implementation has no health check");
      const result = await runner.inspectHealth({
        pin,
        credentials: this.credentialAccess(
          pin,
          pin.definition_revision.content.credential_slots.map((slot) => slot.slot_id),
          [pin.definition_revision.content.health.check_capability_id, CONNECTOR_WORKER_HEALTH_OPERATION_ID],
          guard,
        ),
      });
      guard.assertNoEcho(result);
      return this.dependencies.connector_store.recordHealth({
        connector_binding_id: pin.binding.connector_binding_id,
        connector_binding_revision_id: pin.binding_revision.connector_binding_revision_id,
        owner: pin.owner,
        status: result.status,
        code: result.code == null ? null : safeWorkerCode(result.code),
        message: healthMessage(result.status),
        evidence_refs: result.evidence_refs ?? [],
        observed_at: result.observed_at,
      });
    } catch (error) {
      if (error instanceof ConnectorRevisionConflictError || error instanceof ConnectorLifecycleConflictError) throw error;
      return this.dependencies.connector_store.recordHealth({
        connector_binding_id: pin.binding.connector_binding_id,
        connector_binding_revision_id: pin.binding_revision.connector_binding_revision_id,
        owner: pin.owner,
        status: "unhealthy",
        code: "connector_worker_unavailable",
        message: "The Connector worker did not complete its declared health check.",
        evidence_refs: [],
        observed_at: this.now(),
      });
    }
  }

  async receivePush(
    connectorBindingId: string,
    owner: ConnectorOwner,
    sourceInterfaceId: string,
    envelope: unknown,
  ): Promise<ConnectorIngressResult> {
    const pin = this.pinEnabledBinding(connectorBindingId, owner);
    const source = requirePinnedSource(pin, sourceInterfaceId, false);
    if (source.observation_mode !== "push") {
      throw new ConnectorWorkerError("the selected source is not push-driven");
    }
    const runner = this.requireRunner(pin);
    if (!runner.normalizePush) throw new ConnectorWorkerError("its implementation cannot accept push observations");
    const guard = new SecretEchoGuard();
    let observation: ConnectorWorkerObservation;
    try {
      observation = await runner.normalizePush({
        pin,
        source,
        envelope,
        credentials: this.credentialAccess(
          pin,
          source.credential_slot_ids,
          [...source.required_capability_ids, CONNECTOR_WORKER_SOURCE_OPERATION_ID],
          guard,
        ),
      });
      guard.assertNoEcho(observation);
    } catch {
      throw new ConnectorWorkerError("the push observation could not be verified or normalized");
    }
    return this.ingest(pin, source, observation);
  }

  /**
   * Runs one provider-owned polling turn. Nothing in core calls this on an
   * interval: the Connector worker decides when to invoke another bounded turn.
   */
  async pollOnce(
    connectorBindingId: string,
    owner: ConnectorOwner,
    sourceInterfaceId: string,
  ): Promise<Readonly<{
    ingress: readonly ConnectorIngressResult[];
    checkpoint: ConnectorSourceCheckpoint;
  }>> {
    const pin = this.pinEnabledBinding(connectorBindingId, owner);
    const source = requirePinnedSource(pin, sourceInterfaceId, false);
    if (source.observation_mode !== "connector_poll") {
      throw new ConnectorWorkerError("the selected source is not Connector-owned polling");
    }
    const key = `${pin.binding_revision.connector_binding_revision_id}\0${source.interface_id}`;
    if (this.activePolls.has(key)) throw new ConnectorWorkerError("a polling turn is already active for this pinned source");
    const runner = this.requireRunner(pin);
    if (!runner.poll) throw new ConnectorWorkerError("its implementation has no polling adapter");
    const before = this.dependencies.checkpoint_store.get(
      pin.binding_revision.connector_binding_revision_id,
      source.interface_id,
    );
    const guard = new SecretEchoGuard();
    this.activePolls.add(key);
    try {
      const polled = await runner.poll({
        pin,
        source,
        checkpoint_ref: before?.checkpoint_ref ?? null,
        credentials: this.credentialAccess(
          pin,
          source.credential_slot_ids,
          [...source.required_capability_ids, CONNECTOR_WORKER_SOURCE_OPERATION_ID],
          guard,
        ),
      });
      guard.assertNoEcho(polled);
      const ingress: ConnectorIngressResult[] = [];
      for (const observation of polled.observations) {
        ingress.push(await this.ingest(pin, source, observation));
      }
      this.assertSourcePinCurrent(pin, source.interface_id);
      const checkpoint = this.dependencies.checkpoint_store.advance({
        pin,
        source_interface_id: source.interface_id,
        expected_state_version: before?.state_version ?? 0,
        checkpoint_ref: normalizeEvidenceRef(polled.checkpoint_ref, "poll checkpoint_ref"),
        last_observed_at: polled.observed_at,
        schedule_cursor_at: before?.schedule_cursor_at ?? null,
        next_due_at: before?.next_due_at ?? null,
      });
      return { ingress, checkpoint };
    } catch (error) {
      if (error instanceof ConnectorCheckpointConflictError
        || error instanceof ConnectorRevisionConflictError
        || error instanceof ConnectorLifecycleConflictError
        || error instanceof ConnectorValidationError) throw error;
      throw new ConnectorWorkerError("the polling turn did not complete; its prior checkpoint remains active");
    } finally {
      this.activePolls.delete(key);
    }
  }

  async runScheduleWake(input: Readonly<{
    connector_binding_id: string;
    owner: ConnectorOwner;
    source_interface_id: string;
    now?: string;
  }>): Promise<Readonly<{
    plan: DurableSchedulePlan;
    ingress: readonly ConnectorIngressResult[];
    checkpoint: ConnectorSourceCheckpoint;
  }>> {
    const pin = this.pinEnabledBinding(input.connector_binding_id, input.owner);
    const source = requirePinnedSource(pin, input.source_interface_id, false);
    if (source.source_kind !== "core:schedule" || source.observation_mode !== "push") {
      throw new ConnectorWorkerError("the selected source is not a schedule Connector");
    }
    const contract = scheduleContractFromBinding(pin.binding_revision, source.interface_id);
    const activity = await this.dependencies.inspect_schedule_activity({ pin, source });
    const before = this.dependencies.checkpoint_store.get(
      pin.binding_revision.connector_binding_revision_id,
      source.interface_id,
    );
    const now = requireTimestamp(input.now ?? this.now(), "schedule now");
    const plan = planDurableSchedule({
      contract,
      cursor_at: before?.schedule_cursor_at ?? pin.binding.enabled_at ?? pin.binding.created_at,
      now,
      active_fire_count: activity.active_fire_count,
      identity_seed: canonicalWorkerJson([
        pin.binding_revision.connector_binding_revision_id,
        source.interface_id,
      ]),
    });
    const ingress: ConnectorIngressResult[] = [];
    for (const fire of plan.fires) {
      const evidence = await this.dependencies.write_evidence({
        kind: "connector_schedule_occurrence",
        facts: {
          connector_binding_id: pin.binding.connector_binding_id,
          connector_binding_revision_id: pin.binding_revision.connector_binding_revision_id,
          source_interface_id: source.interface_id,
          fire_id: fire.fire_id,
          scheduled_for: fire.scheduled_for,
          timezone: contract.timezone,
        },
      });
      ingress.push(await this.ingest(pin, source, {
        idempotency_key: fire.fire_id,
        external_identity: fire.fire_id,
        external_revision: fire.scheduled_for,
        payload_digest: sha256Text(canonicalWorkerJson({
          fire_id: fire.fire_id,
          scheduled_for: fire.scheduled_for,
          timezone: contract.timezone,
        })),
        verification: {
          origin: "not_applicable",
          signature: "not_applicable",
          schema: "valid",
          issues: [],
        },
        evidence_refs: [evidence],
        observed_at: now,
      }));
    }
    this.assertSourcePinCurrent(pin, source.interface_id);
    const checkpoint = this.dependencies.checkpoint_store.advance({
      pin,
      source_interface_id: source.interface_id,
      expected_state_version: before?.state_version ?? 0,
      checkpoint_ref: before?.checkpoint_ref ?? null,
      last_observed_at: now,
      schedule_cursor_at: plan.advance_through,
      next_due_at: plan.next_due_at,
    });
    await this.dependencies.arm_schedule_wake({
      pin,
      source,
      next_due_at: checkpoint.next_due_at,
    });
    return { plan, ingress, checkpoint };
  }

  async executeExternalAction(
    externalEffectReceiptId: string,
    owner: ConnectorOwner,
  ): Promise<Readonly<{
    receipt: ExternalEffectReceipt;
    attempt_id: string;
  }>> {
    this.assertOwnerEffectsAllowed(owner);
    const receipt = this.dependencies.connector_store.requireExternalEffectReceiptForOwner(
      externalEffectReceiptId,
      owner,
    );
    const binding = this.dependencies.connector_store.requireBindingForOwner(receipt.connector_binding_id, owner);
    if (binding.status !== "enabled") {
      throw new ConnectorLifecycleConflictError(binding.connector_binding_id, "it is not enabled");
    }
    const pin = this.pinExactRevision(binding, receipt.connector_binding_revision_id, owner);
    const action = requirePinnedAction(pin, receipt.action_interface_id);
    const runner = this.requireRunner(pin);
    if (!runner.executeAction) throw new ConnectorWorkerError("its implementation cannot execute external actions");
    const requestEvidence = await this.dependencies.write_evidence({
      kind: "connector_action_request",
      facts: {
        external_effect_receipt_id: receipt.external_effect_receipt_id,
        connector_binding_id: receipt.connector_binding_id,
        connector_binding_revision_id: receipt.connector_binding_revision_id,
        action_interface_id: receipt.action_interface_id,
        idempotency_key: receipt.idempotency_key,
        input_digest: receipt.input_digest,
        input_refs: receipt.input_refs.map((ref) => `${ref.kind}:${ref.id}@${ref.revision}`),
      },
    });
    const attempt = await this.dependencies.begin_action_attempt({
      operation_id: CONNECTOR_WORKER_ACTION_OPERATION_ID,
      principal_id: this.dependencies.principal_id,
      pin,
      action,
      external_effect: receipt,
      request_evidence_ref: requestEvidence,
      approval_receipt_ids: receipt.approval_receipt_ids,
      checked_at: this.now(),
    });
    if (
      attempt.external_effect_receipt_id !== receipt.external_effect_receipt_id
      || attempt.status !== "started"
    ) {
      throw new ConnectorWorkerError("the approved action boundary returned the wrong attempt");
    }
    const guard = new SecretEchoGuard();
    try {
      const result = await runner.executeAction({
        pin,
        action,
        external_effect: receipt,
        credentials: this.credentialAccess(
          pin,
          action.credential_slot_ids,
          [...action.required_capability_ids, CONNECTOR_WORKER_ACTION_OPERATION_ID],
          guard,
        ),
      });
      guard.assertNoEcho(result);
      const completed = this.dependencies.connector_store.completeExternalActionAttempt({
        external_action_attempt_id: attempt.external_action_attempt_id,
        owner,
        outcome: result.outcome === "not_sent" ? "failed" : result.outcome,
        provider_response_ref: result.outcome === "succeeded" || result.outcome === "outcome_unknown"
          ? result.provider_response_ref ?? null
          : null,
        observed_result_ref: result.outcome === "succeeded"
          ? result.observed_result_ref ?? null
          : null,
        error_code: result.outcome === "succeeded" ? null : safeWorkerCode(result.code),
        error_message: result.outcome === "not_sent"
          ? "The Connector worker proved that no external request was sent."
          : result.outcome === "outcome_unknown"
            ? "The Connector worker cannot prove whether the external effect happened."
            : null,
      });
      return {
        receipt: completed.receipt,
        attempt_id: completed.attempt.external_action_attempt_id,
      };
    } catch {
      const completed = this.dependencies.connector_store.completeExternalActionAttempt({
        external_action_attempt_id: attempt.external_action_attempt_id,
        owner,
        outcome: "outcome_unknown",
        error_code: "connector_worker_lost",
        error_message: "The Connector worker ended after the external attempt began; its outcome must be reconciled.",
      });
      return {
        receipt: completed.receipt,
        attempt_id: completed.attempt.external_action_attempt_id,
      };
    }
  }

  async reconcileExternalAction(
    externalEffectReceiptId: string,
    owner: ConnectorOwner,
  ): Promise<ExternalEffectReceipt> {
    this.assertOwnerEffectsAllowed(owner);
    const receipt = this.dependencies.connector_store.requireExternalEffectReceiptForOwner(
      externalEffectReceiptId,
      owner,
    );
    if (receipt.status !== "outcome_unknown") {
      throw new ConnectorWorkerError("only an uncertain external effect can be reconciled");
    }
    const binding = this.dependencies.connector_store.requireBindingForOwner(receipt.connector_binding_id, owner);
    const pin = this.pinExactRevision(binding, receipt.connector_binding_revision_id, owner);
    const action = requirePinnedAction(pin, receipt.action_interface_id);
    const runner = this.requireRunner(pin);
    if (!runner.reconcileAction) throw new ConnectorWorkerError("its implementation cannot reconcile external actions");
    const guard = new SecretEchoGuard();
    let result: ConnectorWorkerReconciliationResult;
    try {
      result = await runner.reconcileAction({
        pin,
        action,
        external_effect: receipt,
        credentials: this.credentialAccess(
          pin,
          action.credential_slot_ids,
          [...action.required_capability_ids, CONNECTOR_WORKER_RECONCILE_OPERATION_ID],
          guard,
        ),
      });
      guard.assertNoEcho(result);
    } catch {
      throw new ConnectorWorkerError("the uncertain external effect could not be reconciled");
    }
    return this.dependencies.connector_store.reconcileExternalAction({
      external_effect_receipt_id: receipt.external_effect_receipt_id,
      owner,
      outcome: result.outcome,
      evidence_ref: result.evidence_ref,
      reconciled_by_principal_id: this.dependencies.principal_id,
    }).receipt;
  }

  private async ingest(
    pin: ConnectorWorkerPin,
    source: ConnectorSourceInterface,
    observation: ConnectorWorkerObservation,
  ): Promise<ConnectorIngressResult> {
    this.assertSourcePinCurrent(pin, source.interface_id);
    const ingress = this.dependencies.connector_store.recordIngress({
      connector_binding_id: pin.binding.connector_binding_id,
      connector_binding_revision_id: pin.binding_revision.connector_binding_revision_id,
      owner: pin.owner,
      source_interface_id: source.interface_id,
      idempotency_key: observation.idempotency_key,
      external_identity: observation.external_identity,
      external_revision: observation.external_revision ?? null,
      payload_digest: observation.payload_digest,
      verification: observation.verification,
      evidence_refs: observation.evidence_refs ?? [],
      checkpoint_ref: observation.checkpoint_ref ?? null,
      observed_at: observation.observed_at,
    });
    if (ingress.receipt.status !== "accepted") return ingress;
    let materialized: ConnectorWorkerMaterializedIngress;
    try {
      materialized = await this.materializeIngressOnce(pin, source, ingress);
    } catch {
      throw new ConnectorWorkerError("the accepted observation is safe but has not yet materialized as an Event");
    }
    this.dependencies.connector_store.attachIngressOutcome({
      connector_ingress_receipt_id: ingress.receipt.connector_ingress_receipt_id,
      owner: pin.owner,
      normalized_event_id: materialized.normalized_event_id,
      artefact_version_ids: materialized.artefact_version_ids ?? [],
    });
    return {
      ...ingress,
      receipt: this.dependencies.connector_store.requireIngressReceiptForOwner(
        ingress.receipt.connector_ingress_receipt_id,
        pin.owner,
      ),
    };
  }

  private async materializeIngressOnce(
    pin: ConnectorWorkerPin,
    source: ConnectorSourceInterface,
    ingress: ConnectorIngressResult,
  ): Promise<ConnectorWorkerMaterializedIngress> {
    const key = ingress.receipt.connector_ingress_receipt_id;
    const active = this.activeIngress.get(key);
    if (active) return active;
    const pending = Promise.resolve().then(() =>
      this.dependencies.materialize_ingress({ pin, source, ingress })
    );
    this.activeIngress.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.activeIngress.get(key) === pending) this.activeIngress.delete(key);
    }
  }

  private pinExactRevision(
    binding: ConnectorBindingRecord,
    bindingRevisionId: string,
    owner: ConnectorOwner,
  ): ConnectorWorkerPin {
    const bindingRevision = this.dependencies.connector_store.requireBindingRevisionForOwner(bindingRevisionId, owner);
    if (bindingRevision.connector_binding_id !== binding.connector_binding_id) {
      throw new ConnectorNotFoundError("ConnectorBindingRevision", bindingRevisionId);
    }
    const definitionRevision = this.dependencies.connector_store.requireDefinitionRevisionForOwner(
      bindingRevision.connector_definition_revision_id,
      owner,
    );
    return {
      owner,
      binding,
      binding_revision: bindingRevision,
      definition_revision: definitionRevision,
    };
  }

  private requireRunner(pin: ConnectorWorkerPin): ConnectorWorkerRunner {
    const runner = this.dependencies.resolve_runner(pin.definition_revision.content.implementation_ref);
    if (!runner) throw new ConnectorWorkerError("its pinned implementation is unavailable");
    return runner;
  }

  private assertOwnerEffectsAllowed(owner: ConnectorOwner): void {
    if (owner.kind === "workspace" && !this.dependencies.workspace_effects_allowed(owner.id)) {
      throw new ConnectorWorkerError("the restored Workspace is held while local bindings are reconnected");
    }
  }

  private assertSourcePinCurrent(pin: ConnectorWorkerPin, sourceInterfaceId: string): void {
    const current = this.dependencies.connector_store.requireBindingForOwner(
      pin.binding.connector_binding_id,
      pin.owner,
    );
    if (current.status !== "enabled") {
      throw new ConnectorLifecycleConflictError(current.connector_binding_id, "it is no longer enabled");
    }
    if (current.current_revision_id !== pin.binding_revision.connector_binding_revision_id) {
      throw new ConnectorRevisionConflictError(
        current.connector_binding_id,
        pin.binding_revision.connector_binding_revision_id,
        current.current_revision_id,
      );
    }
    requirePinnedSource(pin, sourceInterfaceId, false);
  }

  private credentialAccess(
    pin: ConnectorWorkerPin,
    permittedSlotIds: readonly string[],
    permittedOperationIds: readonly string[],
    guard: SecretEchoGuard,
  ): ConnectorWorkerCredentialAccess {
    const permittedSlots = new Set(permittedSlotIds);
    const permittedOperations = new Set(permittedOperationIds);
    return {
      withSecret: async <Result>(
        slotId: string,
        operationId: string,
        use: (material: Readonly<Uint8Array>) => Promise<Result> | Result,
      ): Promise<Result> => {
        if (pin.owner.kind !== "workspace") {
          throw new ConnectorWorkerError("this credential broker requires Workspace authority");
        }
        if (!permittedSlots.has(slotId)) throw new ConnectorWorkerError("the credential slot is not declared by this interface");
        if (!permittedOperations.has(operationId)) throw new ConnectorWorkerError("the credential operation is not declared by this interface");
        const secretBinding = pin.binding_revision.content.secret_bindings.find((item) => item.slot_id === slotId);
        const credentialSlot = pin.definition_revision.content.credential_slots.find((item) => item.slot_id === slotId);
        if (!secretBinding || !credentialSlot) throw new ConnectorWorkerError("the credential slot is unresolved");
        const grantId = this.dependencies.resolve_secret_grant({
          owner: pin.owner,
          principal_id: this.dependencies.principal_id,
          connector_binding_id: pin.binding.connector_binding_id,
          connector_binding_revision_id: pin.binding_revision.connector_binding_revision_id,
          secret_ref_id: secretBinding.secret_ref_id,
          candidate_grant_ids: pin.binding_revision.content.capability_grant_ids,
          operation_id: operationId,
          purpose: credentialSlot.purpose,
        });
        if (!grantId || !pin.binding_revision.content.capability_grant_ids.includes(grantId)) {
          throw new ConnectorWorkerError("no active credential grant matches this Connector use");
        }
        return this.dependencies.credential_broker.useSecret({
          secret_ref_id: secretBinding.secret_ref_id,
          grant_id: grantId,
          principal_id: this.dependencies.principal_id,
          authority_boundary: { kind: "workspace", workspace_id: pin.owner.id },
          resource: { kind: "connector_binding", id: pin.binding.connector_binding_id },
          purpose: credentialSlot.purpose,
          operation_id: operationId,
        }, async (material) => {
          guard.observe(material);
          const result = await use(material);
          guard.assertNoEcho(result);
          return result;
        });
      },
    };
  }
}

export type DurableScheduleContract = Readonly<{
  cron: string;
  timezone: string;
  missed_fire_policy: "skip" | "latest" | "catch_up";
  catch_up_limit: number;
  overlap_policy: "allow" | "skip" | "wait";
}>;

export type DurableScheduleFire = Readonly<{
  fire_id: string;
  scheduled_for: string;
}>;

export type DurableSchedulePlan = Readonly<{
  fires: readonly DurableScheduleFire[];
  skipped_scheduled_for: readonly string[];
  waiting_for_active_fire: boolean;
  advance_through: string;
  next_due_at: string | null;
}>;

export function scheduleContractFromBinding(
  revision: ConnectorBindingRevision,
  sourceInterfaceId: string,
): DurableScheduleContract {
  const configuration = revision.content.configuration;
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    throw new ConnectorWorkerError("the schedule Connector configuration is missing");
  }
  const sourceSettings = (configuration as Record<string, unknown>).source_settings;
  if (!sourceSettings || typeof sourceSettings !== "object" || Array.isArray(sourceSettings)) {
    throw new ConnectorWorkerError("the schedule Connector source settings are missing");
  }
  const settings = (sourceSettings as Record<string, unknown>)[sourceInterfaceId];
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new ConnectorWorkerError("the selected schedule source has no canonical settings");
  }
  const candidate = settings as Record<string, unknown>;
  return normalizeScheduleContract({
    cron: candidate.cron as string,
    timezone: candidate.timezone as string,
    missed_fire_policy: candidate.missed_fire_policy as DurableScheduleContract["missed_fire_policy"],
    catch_up_limit: candidate.catch_up_limit as number,
    overlap_policy: candidate.overlap_policy as DurableScheduleContract["overlap_policy"],
  });
}

/**
 * Pure schedule decision. An existing one-shot wake mechanism may call it at
 * `next_due_at`; this function never owns an interval or liveness loop.
 */
export function planDurableSchedule(input: Readonly<{
  contract: DurableScheduleContract;
  cursor_at: string;
  now: string;
  active_fire_count: number;
  identity_seed: string;
}>): DurableSchedulePlan {
  const contract = normalizeScheduleContract(input.contract);
  const cursorAt = requireTimestamp(input.cursor_at, "schedule cursor_at");
  const now = requireTimestamp(input.now, "schedule now");
  if (Date.parse(now) < Date.parse(cursorAt)) throw new ConnectorWorkerError("schedule time moved before its durable cursor");
  const activeFireCount = requireNonNegativeInteger(input.active_fire_count, "active_fire_count");
  const identitySeed = requireWorkerText(input.identity_seed, "identity_seed");
  const due = scheduleDueOccurrences(contract, cursorAt, now);
  const latestDue = latestDueOccurrence(contract, cursorAt, now);

  if (latestDue === null) {
    return {
      fires: [],
      skipped_scheduled_for: [],
      waiting_for_active_fire: false,
      advance_through: cursorAt,
      next_due_at: nextScheduleOccurrence(contract, cursorAt),
    };
  }

  if (activeFireCount > 0 && contract.overlap_policy === "wait") {
    return {
      fires: [],
      skipped_scheduled_for: [],
      waiting_for_active_fire: true,
      advance_through: cursorAt,
      next_due_at: null,
    };
  }

  if (contract.missed_fire_policy === "skip"
    || (activeFireCount > 0 && contract.overlap_policy === "skip")) {
    return {
      fires: [],
      skipped_scheduled_for: [latestDue],
      waiting_for_active_fire: false,
      advance_through: latestDue,
      next_due_at: nextScheduleOccurrence(contract, latestDue),
    };
  }

  const selected = contract.missed_fire_policy === "latest" ? [latestDue] : due;
  const advanceThrough = selected[selected.length - 1] ?? cursorAt;
  return {
    fires: selected.map((scheduledFor) => ({
      fire_id: `schedule_fire_${sha256Text(`${identitySeed}\0${scheduledFor}`)}`,
      scheduled_for: scheduledFor,
    })),
    skipped_scheduled_for: [],
    waiting_for_active_fire: false,
    advance_through: advanceThrough,
    next_due_at: nextScheduleOccurrence(contract, advanceThrough),
  };
}

type ConnectorSourceCheckpointRow = Readonly<{
  connector_binding_id: string;
  connector_binding_revision_id: string;
  source_interface_id: string;
  state_version: number;
  checkpoint_ref_json: string | null;
  last_observed_at: string | null;
  schedule_cursor_at: string | null;
  next_due_at: string | null;
  updated_at: string;
}>;

class SecretEchoGuard {
  private readonly forbidden = new Set<string>();

  observe(material: Readonly<Uint8Array>): void {
    const bytes = Uint8Array.from(material);
    const utf8 = new TextDecoder().decode(bytes);
    if (utf8.length >= 4 && !utf8.includes("\uFFFD")) this.forbidden.add(utf8);
    if (bytes.byteLength > 0) {
      this.forbidden.add(Buffer.from(bytes).toString("base64"));
      this.forbidden.add(Buffer.from(bytes).toString("hex"));
    }
    bytes.fill(0);
  }

  assertNoEcho(value: unknown): void {
    if (this.forbidden.size === 0) return;
    if (value === undefined || value === null) return;
    let serialized: string;
    try {
      const encoded = typeof value === "string" ? value : JSON.stringify(value);
      if (typeof encoded !== "string") return;
      serialized = encoded;
    } catch {
      throw new ConnectorWorkerError("the worker returned an unreadable result");
    }
    for (const secret of this.forbidden) {
      if (secret.length >= 4 && serialized.includes(secret)) {
        throw new ConnectorWorkerError("the worker attempted to return credential material");
      }
    }
  }
}

function requirePinnedSource(
  pin: ConnectorWorkerPin,
  sourceInterfaceId: string,
  requireCurrent: boolean,
): ConnectorSourceInterface {
  if (requireCurrent && pin.binding.current_revision_id !== pin.binding_revision.connector_binding_revision_id) {
    throw new ConnectorRevisionConflictError(
      pin.binding.connector_binding_id,
      pin.binding_revision.connector_binding_revision_id,
      pin.binding.current_revision_id,
    );
  }
  const source = pin.definition_revision.content.source_interfaces.find((candidate) =>
    candidate.interface_id === sourceInterfaceId
  );
  if (!source || !pin.binding_revision.content.enabled_source_interface_ids.includes(sourceInterfaceId)) {
    throw new ConnectorValidationError(`source interface '${sourceInterfaceId}' is not enabled by this pinned binding`);
  }
  return source;
}

function requirePinnedAction(pin: ConnectorWorkerPin, actionInterfaceId: string): ConnectorActionInterface {
  const action = pin.definition_revision.content.action_interfaces.find((candidate) =>
    candidate.interface_id === actionInterfaceId
  );
  if (!action || !pin.binding_revision.content.enabled_action_interface_ids.includes(actionInterfaceId)) {
    throw new ConnectorValidationError(`action interface '${actionInterfaceId}' is not enabled by this pinned binding`);
  }
  return action;
}

function checkpointFromRow(row: ConnectorSourceCheckpointRow): ConnectorSourceCheckpoint {
  return {
    connector_binding_id: row.connector_binding_id,
    connector_binding_revision_id: row.connector_binding_revision_id,
    source_interface_id: row.source_interface_id,
    state_version: Number(row.state_version),
    checkpoint_ref: row.checkpoint_ref_json === null
      ? null
      : normalizeEvidenceRef(JSON.parse(row.checkpoint_ref_json), "stored checkpoint_ref"),
    last_observed_at: row.last_observed_at,
    schedule_cursor_at: row.schedule_cursor_at,
    next_due_at: row.next_due_at,
    updated_at: row.updated_at,
  };
}

function normalizeEvidenceRef(value: unknown, label: string): ConnectorEvidenceRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectorWorkerError(`${label} is not an exact evidence reference`);
  }
  const candidate = value as Record<string, unknown>;
  return {
    kind: requireWorkerText(candidate.kind, `${label}.kind`),
    id: requireWorkerText(candidate.id, `${label}.id`),
    revision: requireWorkerText(candidate.revision, `${label}.revision`),
  };
}

function normalizeScheduleContract(contract: DurableScheduleContract): DurableScheduleContract {
  const cron = requireWorkerText(contract.cron, "schedule cron");
  const timezone = requireWorkerText(contract.timezone, "schedule timezone");
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: timezone }).format(new Date(0));
    CronExpressionParser.parse(cron, { currentDate: new Date(0), tz: timezone });
  } catch {
    throw new ConnectorWorkerError("the schedule expression or timezone is invalid");
  }
  if (!["skip", "latest", "catch_up"].includes(contract.missed_fire_policy)) {
    throw new ConnectorWorkerError("the missed-fire policy is invalid");
  }
  if (!["allow", "skip", "wait"].includes(contract.overlap_policy)) {
    throw new ConnectorWorkerError("the overlap policy is invalid");
  }
  const catchUpLimit = requireNonNegativeInteger(contract.catch_up_limit, "catch_up_limit");
  if (catchUpLimit < 1 || catchUpLimit > 100) {
    throw new ConnectorWorkerError("catch_up_limit must be between 1 and 100");
  }
  return { ...contract, cron, timezone, catch_up_limit: catchUpLimit };
}

function scheduleDueOccurrences(
  contract: DurableScheduleContract,
  cursorAt: string,
  now: string,
): string[] {
  const expression = CronExpressionParser.parse(contract.cron, {
    currentDate: new Date(cursorAt),
    tz: contract.timezone,
  });
  const due: string[] = [];
  const limit = contract.missed_fire_policy === "catch_up" ? contract.catch_up_limit : 1;
  while (due.length < limit) {
    const next = expression.next().toDate().toISOString();
    if (Date.parse(next) > Date.parse(now)) break;
    due.push(next);
  }
  return due;
}

function latestDueOccurrence(
  contract: DurableScheduleContract,
  cursorAt: string,
  now: string,
): string | null {
  const expression = CronExpressionParser.parse(contract.cron, {
    currentDate: new Date(Date.parse(now) + 1),
    tz: contract.timezone,
  });
  const previous = expression.prev().toDate().toISOString();
  return Date.parse(previous) > Date.parse(cursorAt) ? previous : null;
}

function nextScheduleOccurrence(contract: DurableScheduleContract, after: string): string {
  return CronExpressionParser.parse(contract.cron, {
    currentDate: new Date(after),
    tz: contract.timezone,
  }).next().toDate().toISOString();
}

function healthMessage(status: ConnectorWorkerHealthResult["status"]): string {
  if (status === "healthy") return "The Connector worker completed its declared health check.";
  if (status === "degraded") return "The Connector worker completed its health check with a degraded result.";
  return "The Connector worker completed its health check with an unhealthy result.";
}

function safeWorkerCode(value: unknown): string {
  const code = requireWorkerText(value, "worker outcome code", 128);
  if (!/^[a-z][a-z0-9_.-]*$/.test(code)) throw new ConnectorWorkerError("the worker outcome code is invalid");
  return code;
}

function requireWorkerText(value: unknown, label: string, maximum = 2048): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new ConnectorWorkerError(`${label} must be non-empty text`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireWorkerText(value, label, 128);
  if (!Number.isFinite(Date.parse(timestamp))) throw new ConnectorWorkerError(`${label} must be an ISO timestamp`);
  return new Date(timestamp).toISOString();
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : requireTimestamp(value, label);
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ConnectorWorkerError(`${label} must be a non-negative integer`);
  }
  return value;
}

function canonicalWorkerJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ConnectorWorkerError("worker facts must contain finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalWorkerJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalWorkerJson(item)}`)
      .join(",")}}`;
  }
  throw new ConnectorWorkerError("worker facts must contain JSON values only");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
