import { AuditStore, type AuditRecord } from "./audit.js";
import {
  operationAuthorityBoundaryId,
  sameOperationAuthorityBoundary,
  type JsonSchema,
  type OperationAuthorityBoundary,
  type OperationResourceIdentity,
  type ResolvedOperationResource,
  type SemanticOperationDefinition,
  type SemanticOperationRegistry,
} from "./operations.js";

export const LIST_AUDIT_RECORDS_OPERATION_ID = "audit.list";
export const INSPECT_AUDIT_RECORD_OPERATION_ID = "audit.inspect";

const text: JsonSchema = { type: "string", minLength: 1 };
const nullableText: JsonSchema = { oneOf: [text, { type: "null" }] };
const auditRecordSchema: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["request", "outcome"],
  properties: {
    request: {
      type: "object",
      additionalProperties: true,
      required: ["audit_id", "invocation_id", "principal_id", "operation_id", "request_digest", "started_at"],
      properties: {
        audit_id: text,
        workspace_id: nullableText,
        invocation_id: text,
        principal_id: text,
        operation_id: text,
        request_digest: text,
        started_at: text,
      },
    },
    outcome: { oneOf: [{ type: "object" }, { type: "null" }] },
  },
};

function readEffects() {
  return { mode: "read" as const, reversibility: "none" as const, external: false, secret_access: "none" as const };
}

function auditRef(record: AuditRecord) {
  return {
    kind: "audit_record",
    id: record.request.audit_id,
    revision: record.outcome?.completed_at ?? record.request.started_at,
  };
}

function invocationAuditRef(invocationId: string) {
  return { kind: "operation_invocation", id: invocationId, revision: null };
}

export function auditOperationDefinitions(store: AuditStore): readonly SemanticOperationDefinition[] {
  return [
    {
      operation_id: LIST_AUDIT_RECORDS_OPERATION_ID,
      operation_version: "1",
      authority_boundary_kinds: ["workspace", "host"],
      category: "audit",
      title: "List operation audit",
      description: "List immutable operation requests and outcomes inside the authenticated authority boundary.",
      effects: readEffects(),
      required_grants: [LIST_AUDIT_RECORDS_OPERATION_ID],
      interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
      target: { resource_kinds: [], expected_revision: "not_applicable" },
      input: {
        version: "1",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            principal_id: text,
            operation_id: text,
            state: { enum: ["accepted", "completed", "refused", "outcome_unknown"] },
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
        },
      },
      result: {
        version: "1",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["records"],
          properties: { records: { type: "array", items: auditRecordSchema } },
        },
      },
      handler: (context, input: unknown) => {
        const value = input as {
          principal_id?: string;
          operation_id?: string;
          state?: NonNullable<AuditRecord["outcome"]>["state"];
          limit?: number;
        };
        const boundary = context.authority.boundary;
        const records = store.list({
          workspace_id: boundary.kind === "workspace" ? boundary.workspace_id : null,
          ...(value.principal_id ? { principal_id: value.principal_id } : {}),
          ...(value.operation_id ? { operation_id: value.operation_id } : {}),
          ...(value.state ? { state: value.state } : {}),
          ...(value.limit ? { limit: value.limit } : {}),
        }).filter((record) => sameOperationAuthorityBoundary(record.request.authority_boundary, boundary));
        return {
          state: "completed",
          result: { records },
          audit_ref: invocationAuditRef(context.invocation_id),
        };
      },
    },
    {
      operation_id: INSPECT_AUDIT_RECORD_OPERATION_ID,
      operation_version: "1",
      authority_boundary_kinds: ["workspace", "host"],
      category: "audit",
      title: "Inspect operation audit",
      description: "Inspect one immutable operation request and its retained outcome.",
      effects: readEffects(),
      required_grants: [INSPECT_AUDIT_RECORD_OPERATION_ID],
      interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
      target: { resource_kinds: ["audit_record"], expected_revision: "not_applicable" },
      input: { version: "1", schema: { type: "object", additionalProperties: false } },
      result: { version: "1", schema: auditRecordSchema },
      handler: (context) => ({
        state: "completed",
        result: store.require(context.target!.ref.id),
        audit_ref: invocationAuditRef(context.invocation_id),
      }),
    },
  ];
}

export function registerAuditOperations(registry: SemanticOperationRegistry, store: AuditStore): SemanticOperationRegistry {
  for (const definition of auditOperationDefinitions(store)) registry.register(definition);
  return registry;
}

export function resolveAuditOperationResource(
  store: AuditStore,
  boundary: OperationAuthorityBoundary,
  target: OperationResourceIdentity,
): ResolvedOperationResource | null {
  if (target.kind !== "audit_record") return null;
  const record = store.get(target.id);
  if (!record || !sameOperationAuthorityBoundary(record.request.authority_boundary, boundary)) return null;
  return { ref: auditRef(record), state: record };
}

export function auditBoundaryKey(boundary: OperationAuthorityBoundary): string {
  return `${boundary.kind}:${operationAuthorityBoundaryId(boundary)}`;
}

