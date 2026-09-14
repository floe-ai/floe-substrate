import type { DatabaseSync } from "node:sqlite";

import {
  DESTROY_CONTEXT_PERMANENTLY_OPERATION_ID,
  type ContextDestructionOutcome,
  type ContextOperationBackend,
  type ContextRetainedReference,
  type DirectContextCommunicationIntent,
  type DirectContextCommunicationOutcome,
} from "./context-operations.js";
import type { CanonicalContextRecord } from "./contexts/store.js";
import type { BusStore } from "./store.js";

type Broadcast = (type: string, payload?: Record<string, unknown>) => void;

const retainedReferenceGuard = Symbol("context-retained-reference-guard");

/**
 * Bus-owned adapter for cross-resource Context rules. ContextStore deliberately
 * cannot decide whether an external canonical record must retain a Context.
 */
export class BusContextOperationBackend implements ContextOperationBackend {
  readonly contexts;

  constructor(
    private readonly store: BusStore,
    private readonly broadcast: Broadcast,
  ) {
    this.contexts = store.contextStore;
  }

  participantExists(workspaceId: string, participantId: string): boolean {
    const endpoint = this.store.getEndpoint(participantId) as { workspace_id?: string } | null;
    if (endpoint?.workspace_id === workspaceId) return true;
    const actor = this.store.actorDefinitionStore.getActor(participantId);
    return actor?.workspace_id === workspaceId && actor.status === "active";
  }

  scopeExists(workspaceId: string, scopeId: string): boolean {
    const scope = this.store.scopeStore.getScope(workspaceId, scopeId);
    return Boolean(scope && scope.status !== "retired");
  }

  publishContextChange(
    type: "created" | "archived" | "restored" | "participant_changed" | "tombstoned",
    context: CanonicalContextRecord,
    details: Readonly<Record<string, unknown>> = {},
  ): void {
    this.broadcast(`context_${type}`, { context, ...details });
  }

  listRetainedReferences(workspaceId: string, contextId: string): readonly ContextRetainedReference[] {
    return this.collectRetainedReferences(workspaceId, contextId, null);
  }

  destroyContextPermanently(input: Readonly<{
    workspace_id: string;
    context_id: string;
    expected_revision: number;
    principal_id: string;
    reason: string;
    invocation_id: string;
  }>): ContextDestructionOutcome {
    let retained: readonly ContextRetainedReference[] = [];
    try {
      const result = this.contexts.tombstoneContext({
        context_id: input.context_id,
        expected_revision: input.expected_revision,
        tombstoned_by_principal_id: input.principal_id,
        reason: input.reason,
        assert_no_retained_references: () => {
          retained = this.collectRetainedReferences(
            input.workspace_id,
            input.context_id,
            input.invocation_id,
          );
          if (retained.length > 0) throw retainedReferenceGuard;
        },
      });
      return { destroyed: true, ...result };
    } catch (error) {
      if (error === retainedReferenceGuard) {
        return { destroyed: false, retained_references: retained };
      }
      throw error;
    }
  }

  emitDirectContextCommunication(
    intent: DirectContextCommunicationIntent,
  ): DirectContextCommunicationOutcome {
    const context = this.contexts.getContext(intent.context_id);
    if (
      !context
      || context.workspace_id !== intent.workspace_id
      || context.lifecycle_state !== "active"
    ) {
      return {
        emitted: false,
        code: "context_not_active",
        message: "This Context is not available for communication.",
        retryable: false,
      };
    }
    if (intent.recipient_participant_id) {
      const endpoint = this.store.getEndpoint(intent.recipient_participant_id) as {
        workspace_id?: string;
        status?: string;
      } | null;
      if (
        !endpoint
        || endpoint.workspace_id !== intent.workspace_id
        || endpoint.status === "retired"
      ) {
        return {
          emitted: false,
          code: "context_recipient_unavailable",
          message: "The selected Context participant does not currently have an addressable Endpoint.",
          retryable: true,
        };
      }
    }
    const submitted = this.store.submitPrincipalContextCommunication({
      workspace_id: intent.workspace_id,
      context_id: intent.context_id,
      principal_id: intent.principal_id,
      type: intent.event_type,
      recipient_endpoint_id: intent.recipient_participant_id,
      content: intent.content,
      artefact_version_ids: intent.artefact_version_ids,
      attachment_ingress_ids: intent.attachment_ingress_ids,
      response_expected: intent.response_expected,
      // The registry's stable invocation identity includes the authenticated
      // principal and authority boundary. Caller keys are only locally unique.
      idempotency_key: `operation:${intent.invocation_id}`,
      provenance: intent.provenance,
    }, this.broadcast);
    const event = submitted.event;
    return {
      emitted: true,
      event_ref: { kind: "event", id: event.event_id, revision: event.created_at },
      artefact_version_refs: submitted.attached_artefact_version_ids.map((id) => ({
        kind: "artefact_version",
        id,
        revision: null,
      })),
    };
  }

  private collectRetainedReferences(
    workspaceId: string,
    contextId: string,
    excludedInvocationId: string | null,
  ): readonly ContextRetainedReference[] {
    const db = this.store.db;
    const refs = new Map<string, ContextRetainedReference>();
    const add = (kind: string, id: string, relationship: string, revision: string | null = null) => {
      const key = `${kind}\u0000${id}\u0000${relationship}`;
      refs.set(key, { kind, id, revision, relationship });
    };
    const has = (table: string) => tableExists(db, table);

    if (has("contexts")) {
      const children = db.prepare(`
        SELECT context_id, state_revision FROM contexts
        WHERE workspace_id = ? AND parent_context_id = ? AND lifecycle_state <> 'tombstoned'
      `).all(workspaceId, contextId) as Array<{ context_id: string; state_revision: number }>;
      for (const row of children) add("context", row.context_id, "child_context", String(row.state_revision));
    }

    if (has("node_executions") && has("scope_executions")) {
      const rows = db.prepare(`
        SELECT ne.node_execution_id
        FROM node_executions ne
        JOIN scope_executions se ON se.execution_id = ne.execution_id
        WHERE se.workspace_id = ? AND ne.context_id = ?
      `).all(workspaceId, contextId) as Array<{ node_execution_id: string }>;
      for (const row of rows) add("node_execution", row.node_execution_id, "execution_context");
    }
    if (has("node_context_bindings")) {
      const rows = db.prepare(`
        SELECT scope_id, node_id, binding_key FROM node_context_bindings
        WHERE workspace_id = ? AND context_id = ?
      `).all(workspaceId, contextId) as Array<{ scope_id: string; node_id: string; binding_key: string }>;
      for (const row of rows) {
        add("context_binding", `${row.scope_id}:${row.node_id}:${row.binding_key}`, "persistent_node_context_binding");
      }
    }

    if (has("scope_graphs")) {
      const rows = db.prepare(`
        SELECT graph_id FROM scope_graphs WHERE workspace_id = ? AND context_id = ?
      `).all(workspaceId, contextId) as Array<{ graph_id: string }>;
      for (const row of rows) add("scope_graph", row.graph_id, "legacy_scope_context");
    }
    if (has("scope_node_placements") && has("scope_composition_revisions")) {
      const rows = db.prepare(`
        SELECT snp.revision_id, snp.node_id, snp.kind, snp.resource_id,
               snp.config_json, snp.bindings_json, snp.activation_json,
               snp.context_policy_json
        FROM scope_node_placements snp
        JOIN scope_composition_revisions scr ON scr.revision_id = snp.revision_id
        WHERE scr.workspace_id = ?
      `).all(workspaceId) as Array<{
        revision_id: string;
        node_id: string;
        kind: string;
        resource_id: string | null;
        config_json: string;
        bindings_json: string;
        activation_json: string;
        context_policy_json: string;
      }>;
      for (const row of rows) {
        if (row.kind === "context" && row.resource_id === contextId) {
          add("scope_composition_revision", row.revision_id, `context_node:${row.node_id}`);
        }
        if (containsExactString(safeJson(row.context_policy_json), contextId)) {
          add("scope_composition_revision", row.revision_id, `node_context_policy:${row.node_id}`);
        }
        for (const [field, value] of [
          ["config", row.config_json],
          ["bindings", row.bindings_json],
          ["activation", row.activation_json],
        ] as const) {
          if (containsTypedResourceRef(safeJson(value), "context", contextId)) {
            add("scope_composition_revision", row.revision_id, `node_${field}:${row.node_id}`);
          }
        }
      }
    }

    if (has("actor_definition_revisions")) {
      const rows = db.prepare(`
        SELECT actor_definition_revision_id, content_json
        FROM actor_definition_revisions
        WHERE workspace_id = ?
      `).all(workspaceId) as Array<{
        actor_definition_revision_id: string;
        content_json: string;
      }>;
      for (const row of rows) {
        if (containsTypedResourceRef(safeJson(row.content_json), "context", contextId)) {
          add(
            "actor_definition_revision",
            row.actor_definition_revision_id,
            "definition_context_reference",
            row.actor_definition_revision_id,
          );
        }
      }
    }

    if (has("pulse_delivery_contexts")) {
      const rows = db.prepare(`
        SELECT pulse_id, subscriber_key FROM pulse_delivery_contexts
        WHERE workspace_id = ? AND context_id = ?
      `).all(workspaceId, contextId) as Array<{ pulse_id: string; subscriber_key: string }>;
      for (const row of rows) add("pulse", row.pulse_id, `delivery_context:${row.subscriber_key}`);
    }
    if (has("pulse_subscribers") && has("pulses")) {
      const rows = db.prepare(`
        SELECT ps.pulse_id, ps.subscriber_json
        FROM pulse_subscribers ps JOIN pulses p ON p.pulse_id = ps.pulse_id
        WHERE p.workspace_id = ?
      `).all(workspaceId) as Array<{ pulse_id: string; subscriber_json: string }>;
      for (const row of rows) {
        if (containsExactString(safeJson(row.subscriber_json), contextId)) {
          add("pulse", row.pulse_id, "context_subscriber");
        }
      }
    }

    if (has("approval_requests")) {
      const rows = db.prepare(`
        SELECT approval_request_id, status, state_revision
        FROM approval_requests
        WHERE workspace_id = ? AND context_id = ?
      `).all(workspaceId, contextId) as Array<{
        approval_request_id: string;
        status: string;
        state_revision: number;
      }>;
      for (const row of rows) {
        add(
          "approval_request",
          row.approval_request_id,
          `approval_context:${row.status}`,
          String(row.state_revision),
        );
      }
    }

    const eventIds = has("events")
      ? (db.prepare(`SELECT event_id, type FROM events WHERE workspace_id = ? AND context_id = ?`)
          .all(workspaceId, contextId) as Array<{ event_id: string; type: string }>)
      : [];
    const eventIdSet = new Set(eventIds.map((row) => row.event_id));
    for (const row of eventIds) {
      if (/(?:^|[._:-])(decision|approval)(?:$|[._:-])/i.test(row.type)) {
        add("event", row.event_id, "decision_or_approval_evidence");
      }
      if (row.type === "context.scope_assigned") {
        add("event", row.event_id, "context_assignment_audit");
      }
    }

    if (has("events")) {
      const incoming = db.prepare(`
        SELECT event_id FROM events
        WHERE workspace_id = ? AND context_id <> ?
          AND json_extract(destination_json, '$.kind') = 'context'
          AND json_extract(destination_json, '$.context_id') = ?
      `).all(workspaceId, contextId, contextId) as Array<{ event_id: string }>;
      for (const row of incoming) add("event", row.event_id, "addresses_context");

      const metadataRows = db.prepare(`
        SELECT event_id, metadata_json FROM events WHERE workspace_id = ? AND context_id <> ?
      `).all(workspaceId, contextId) as Array<{ event_id: string; metadata_json: string }>;
      for (const row of metadataRows) {
        if (knownEventMetadataReferencesContext(safeJson(row.metadata_json), contextId)) {
          add("event", row.event_id, "event_metadata_context_reference");
        }
      }
    }

    if (eventIdSet.size > 0) {
      const placeholders = [...eventIdSet].map(() => "?").join(", ");
      const eventParams = [...eventIdSet];
      if (has("scope_executions")) {
        const rows = db.prepare(`
          SELECT execution_id FROM scope_executions
          WHERE workspace_id = ? AND (cause_event_id IN (${placeholders}) OR root_event_id IN (${placeholders}))
        `).all(workspaceId, ...eventParams, ...eventParams) as Array<{ execution_id: string }>;
        for (const row of rows) add("scope_execution", row.execution_id, "execution_event_evidence");
      }
      if (has("node_execution_inputs")) {
        const rows = db.prepare(`
          SELECT node_execution_id, input_id FROM node_execution_inputs WHERE event_id IN (${placeholders})
        `).all(...eventParams) as Array<{ node_execution_id: string; input_id: string }>;
        for (const row of rows) add("node_execution", row.node_execution_id, `input_event:${row.input_id}`);
      }
      if (has("scope_output_publications")) {
        const rows = db.prepare(`
          SELECT publication_id FROM scope_output_publications WHERE event_id IN (${placeholders})
        `).all(...eventParams) as Array<{ publication_id: string }>;
        for (const row of rows) add("output_publication", row.publication_id, "published_event");
      }
      if (has("event_queue")) {
        const rows = db.prepare(`
          SELECT queue_id, state FROM event_queue WHERE event_id IN (${placeholders})
        `).all(...eventParams) as Array<{ queue_id: string; state: string }>;
        for (const row of rows) {
          const relationship = ["held", "queued", "reserved", "delivered_to_bridge", "injected_to_runtime"]
            .includes(row.state) ? "pending_work" : "delivery_audit";
          add("delivery", row.queue_id, relationship);
        }
      }
      if (has("pending_responses")) {
        const rows = db.prepare(`
          SELECT pending_id, status FROM pending_responses WHERE source_event_id IN (${placeholders})
        `).all(...eventParams) as Array<{ pending_id: string; status: string }>;
        for (const row of rows) add("pending_response", row.pending_id, row.status === "pending" ? "pending_work" : "response_audit");
      }
      if (has("delivery_bundles")) {
        const rows = db.prepare(`SELECT delivery_id, trigger_event_id, events_json FROM delivery_bundles WHERE workspace_id = ?`)
          .all(workspaceId) as Array<{ delivery_id: string; trigger_event_id: string; events_json: string }>;
        for (const row of rows) {
          const bundled = safeJson(row.events_json);
          if (eventIdSet.has(row.trigger_event_id) || containsAnyEventId(bundled, eventIdSet)) {
            add("delivery", row.delivery_id, "delivery_audit");
          }
        }
      }
      if (has("artefact_associations") && has("artefact_versions") && has("artefacts")) {
        const rows = db.prepare(`
          SELECT aa.artefact_version_id
          FROM artefact_associations aa
          JOIN artefact_versions av ON av.artefact_version_id = aa.artefact_version_id
          JOIN artefacts a ON a.artefact_id = av.artefact_id
          WHERE a.workspace_id = ? AND aa.target_kind = 'event' AND aa.target_id IN (${placeholders})
        `).all(workspaceId, ...eventParams) as Array<{ artefact_version_id: string }>;
        for (const row of rows) add("artefact_version", row.artefact_version_id, "associated_event", row.artefact_version_id);
      }
    }

    if (has("artefact_associations") && has("artefact_versions") && has("artefacts")) {
      const rows = db.prepare(`
        SELECT aa.artefact_version_id, aa.role
        FROM artefact_associations aa
        JOIN artefact_versions av ON av.artefact_version_id = aa.artefact_version_id
        JOIN artefacts a ON a.artefact_id = av.artefact_id
        WHERE a.workspace_id = ? AND aa.target_kind = 'context' AND aa.target_id = ?
      `).all(workspaceId, contextId) as Array<{ artefact_version_id: string; role: string }>;
      for (const row of rows) add("artefact_version", row.artefact_version_id, `context_${row.role}`, row.artefact_version_id);
    }

    if (has("operation_invocation_ledger")) {
      const rows = db.prepare(`
        SELECT invocation_id, receipt_json FROM operation_invocation_ledger
        WHERE boundary_kind = 'workspace' AND boundary_id = ?
          AND (? IS NULL OR invocation_id <> ?)
      `).all(workspaceId, excludedInvocationId, excludedInvocationId) as Array<{ invocation_id: string; receipt_json: string }>;
      for (const row of rows) {
        const receipt = safeJson(row.receipt_json);
        if (isIdentityOnlyDestructionChallenge(receipt, contextId)) continue;
        if (containsExactString(receipt, contextId)) {
          add("operation_invocation", row.invocation_id, "operation_audit_context_snapshot");
        }
      }
    }
    if (has("capability_grant_targets") && has("capability_grants")) {
      const rows = db.prepare(`
        SELECT cgt.grant_id FROM capability_grant_targets cgt
        JOIN capability_grants cg ON cg.grant_id = cgt.grant_id
        WHERE cg.boundary_kind = 'workspace' AND cg.boundary_id = ?
          AND cgt.target_kind = 'context' AND cgt.target_id = ?
      `).all(workspaceId, contextId) as Array<{ grant_id: string }>;
      for (const row of rows) add("capability_grant", row.grant_id, "authority_target");
    }

    this.collectUnknownDirectContextReferences(db, contextId, add);
    return [...refs.values()].sort((left, right) =>
      `${left.kind}:${left.id}:${left.relationship}`.localeCompare(`${right.kind}:${right.id}:${right.relationship}`));
  }

  /**
   * Future direct Context foreign keys must not accidentally bypass the
   * destruction guard. Known owned rows are intentionally excluded.
   */
  private collectUnknownDirectContextReferences(
    db: DatabaseSync,
    contextId: string,
    add: (kind: string, id: string, relationship: string, revision?: string | null) => void,
  ): void {
    const owned = new Set([
      "contexts.context_id", "contexts.parent_context_id",
      "context_participants.context_id", "context_subscriptions.context_id",
      "events.context_id", "node_executions.context_id", "node_context_bindings.context_id",
      "pulse_delivery_contexts.context_id", "scope_graphs.context_id",
      "approval_requests.context_id", "approval_receipts.context_id",
    ]);
    const tables = db.prepare(`
      SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<{ name: string }>;
      for (const column of columns) {
        if (!/(^|_)context_id$/.test(column.name) || owned.has(`${name}.${column.name}`)) continue;
        const row = db.prepare(`
          SELECT rowid AS retained_rowid FROM ${quoteIdentifier(name)}
          WHERE ${quoteIdentifier(column.name)} = ? LIMIT 1
        `).get(contextId) as { retained_rowid: number } | undefined;
        if (row) add("retention_surface", `${name}:${row.retained_rowid}`, `unclassified:${column.name}`);
      }
    }
  }
}

/**
 * A refused confirmation challenge contains only the target identity, which
 * remains resolvable through the Context tombstone. Its audit is redacted and
 * carries no Context content, so it must not make the confirmed invocation
 * retain itself forever.
 */
function isIdentityOnlyDestructionChallenge(value: unknown, contextId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const target = receipt.target;
  const refusal = receipt.refusal;
  return receipt.operation_id === DESTROY_CONTEXT_PERMANENTLY_OPERATION_ID
    && receipt.state === "refused"
    && receipt.result == null
    && Array.isArray(receipt.changed_refs)
    && receipt.changed_refs.length === 0
    && Boolean(target && typeof target === "object" && !Array.isArray(target)
      && (target as Record<string, unknown>).kind === "context"
      && (target as Record<string, unknown>).id === contextId)
    && Boolean(refusal && typeof refusal === "object" && !Array.isArray(refusal)
      && (refusal as Record<string, unknown>).code === "operation_confirmation_required");
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?`).get(table));
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function containsExactString(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsExactString(item, expected));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .some((item) => containsExactString(item, expected));
  }
  return false;
}

function containsTypedResourceRef(value: unknown, kind: string, id: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsTypedResourceRef(item, kind, id));
  }
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === kind && candidate.id === id) return true;
  return Object.values(candidate).some((item) => containsTypedResourceRef(item, kind, id));
}

function knownEventMetadataReferencesContext(value: unknown, contextId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  return [
    "request_return_context_id",
    "result_context_id",
    "parent_context_id",
    "current_context_id",
  ].some((key) => metadata[key] === contextId);
}

function containsAnyEventId(value: unknown, eventIds: ReadonlySet<string>): boolean {
  if (typeof value === "string") return eventIds.has(value);
  if (Array.isArray(value)) return value.some((item) => containsAnyEventId(item, eventIds));
  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.event_id === "string" && eventIds.has(candidate.event_id)) return true;
    return Object.values(candidate).some((item) => containsAnyEventId(item, eventIds));
  }
  return false;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
