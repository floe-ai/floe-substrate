import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type {
  BusClient,
  OperationInvocationResponse,
  OperationRefusal,
  RuntimeOperationAuthoritySession,
  SemanticOperationDescriptor,
} from "../bus-client.js";
import type { ActiveToolTurn, ToolContext } from "./types.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

function failure(message: string, error: string, details: Record<string, unknown> = {}): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    details: { ok: false, error, ...details },
  };
}

/**
 * The Bridge owns only this stable two-tool transport seam. Every operation
 * identity, description, schema, availability decision, authority check,
 * refusal, execution, and receipt comes from the Bus semantic registry.
 */
export function createCapabilityTools(
  bus: BusClient,
  workspaceId: string,
  context: Pick<ToolContext, "getActiveTurn">,
): AgentTool[] {
  const discoverCapabilities: AgentTool = {
    name: "discover_capabilities",
    label: "Discover Capabilities",
    description:
      "Find current Bus operations for a concrete need. Search returns short summaries. Pass an operation_id from a summary to load its exact input contract before using it. Reuse a discovered contract within this turn; rediscover after a version or authority refusal.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "One or two specific keywords. Long sentences match unrelated operations." })),
      operation_id: Type.Optional(Type.String({ description: "Exact operation_id from a search result; returns this operation's authoritative input contract" })),
      include_result_schema: Type.Optional(Type.Boolean({ description: "Include the selected operation's full result schema when needed to build an integration. Ordinary invocation returns its result directly." })),
      category: Type.Optional(Type.String({ description: "Optional category returned by an earlier discovery" })),
      target: Type.Optional(Type.Object({
        kind: Type.String({ description: "Canonical resource kind" }),
        id: Type.String({ description: "Canonical resource id" }),
      }, { description: "Optional selected resource used to evaluate target-specific availability. Omit until the operation's target kind is known from discovery." })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "Maximum matching operations to return" })),
    }),
    execute: async (_toolCallId, params: any) => {
      try {
        const authority = await requireOperationAuthority(bus, context);
        const operationId = typeof params?.operation_id === "string" ? params.operation_id.trim() : "";
        const result = await bus.discoverOperations(workspaceId, authority.bearer_token, {
          query: operationId || (typeof params?.query === "string" ? params.query : undefined),
          category: operationId ? undefined : (typeof params?.category === "string" ? params.category : undefined),
          target: parseTarget(params?.target),
        });
        const limit = typeof params?.limit === "number"
          ? Math.max(1, Math.min(20, Math.trunc(params.limit)))
          : 20;
        const matches = operationId
          ? result.operations.filter(operation => operation.operation_id === operationId)
          : result.operations;
        const operations = matches.slice(0, limit);
        const text = operations.length === 0
          ? operationId
            ? `Operation '${operationId}' is not exposed for this Delivery and target. Search current capabilities before choosing another operation.`
            : "No semantic operation matched that need for this Delivery. Try a shorter outcome-oriented query before concluding that the operation is unavailable."
          : operationId
            ? renderOperation(operations[0], params?.include_result_schema === true)
            : `${operations.map(renderOperationSummary).join("\n\n")}\n\nShowing ${operations.length} of ${matches.length} matches. Load the needed input contract with discover_capabilities({operation_id: "..."}). Narrow query or category if needed.`;
        return {
          content: [{ type: "text", text }],
          details: { ok: true, mode: operationId ? "contract" : "summary", match_count: matches.length, operations },
        };
      } catch (error) {
        return failure(
          `Could not discover operations: ${error instanceof Error ? error.message : String(error)}`,
          "operation_discovery_failed",
        );
      }
    },
  };

  const useCapability: AgentTool = {
    name: "use_capability",
    label: "Use Capability",
    description:
      "Invoke one Bus semantic operation using the exact operation and input-schema versions returned by discover_capabilities. Authority and causal provenance come from the active Delivery, not from this input.",
    parameters: Type.Object({
      operation_id: Type.String({ description: "Exact operation_id returned by discover_capabilities" }),
      operation_version: Type.String({ description: "Exact operation_version returned by discover_capabilities" }),
      input_schema_version: Type.String({ description: "Exact input.version returned by discover_capabilities" }),
      target: Type.Optional(Type.Object({
        kind: Type.String({ description: "Canonical resource kind" }),
        id: Type.String({ description: "Canonical resource id" }),
      }, { description: "Target required by the discovered operation, when applicable" })),
      expected_resource_revision: Type.Optional(Type.String({
        description: "Exact target revision when the operation requires or accepts optimistic concurrency",
      })),
      idempotency_key: Type.Optional(Type.String({
        description: "Stable caller key. Reuse it after a timeout when the operation outcome is unknown.",
      })),
      input: Type.Object({}, {
        additionalProperties: true,
        description: "Input matching the exact discovered input.schema",
      }),
    }),
    execute: async (toolCallId, params: any) => {
      const operationId = String(params?.operation_id ?? "").trim();
      const operationVersion = String(params?.operation_version ?? "").trim();
      const inputSchemaVersion = String(params?.input_schema_version ?? "").trim();
      if (!operationId || !operationVersion || !inputSchemaVersion) {
        return failure(
          "The exact discovered operation_id, operation_version, and input_schema_version are required.",
          "operation_contract_required",
        );
      }
      try {
        const authority = await requireOperationAuthority(bus, context);
        const activeTurn = context.getActiveTurn?.();
        const idempotencyKey = typeof params?.idempotency_key === "string" && params.idempotency_key.trim()
          ? params.idempotency_key.trim()
          : `runtime:${activeTurn?.delivery_id ?? "unknown"}:tool:${toolCallId}`;
        const response = await bus.invokeOperation(workspaceId, authority.bearer_token, {
          operation_id: operationId,
          operation_version: operationVersion,
          input_schema_version: inputSchemaVersion,
          target: parseTarget(params?.target),
          expected_resource_revision:
            typeof params?.expected_resource_revision === "string"
              ? params.expected_resource_revision
              : null,
          idempotency_key: idempotencyKey,
          input: params?.input && typeof params.input === "object" ? params.input : {},
        });
        return renderInvocation(response, operationId);
      } catch (error) {
        return failure(
          `Could not invoke operation '${operationId}': ${error instanceof Error ? error.message : String(error)}`,
          "operation_invocation_failed",
          { operation_id: operationId },
        );
      }
    },
  };

  return [discoverCapabilities, useCapability];
}

function parseTarget(value: unknown): { kind: string; id: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind.trim() : "";
  const id = typeof record.id === "string" ? record.id.trim() : "";
  return kind && id ? { kind, id } : null;
}

function renderOperationSummary(operation: SemanticOperationDescriptor): string {
  const availability = operation.availability.available
    ? "available"
    : `unavailable — ${operation.availability.refusal.code}: ${operation.availability.refusal.message}`;
  return [
    `operation_id: ${operation.operation_id}\noperation_version: ${operation.operation_version}\n${operation.title}`,
    operation.description,
    `Availability: ${availability}`,
    `Target: ${JSON.stringify(operation.target)}`,
    `Effects: ${operation.effects.mode}, ${operation.effects.reversibility}${operation.effects.external ? ", external" : ""}`,
    `Category: ${operation.category}`,
  ].join("\n");
}

function renderOperation(operation: SemanticOperationDescriptor, includeResultSchema: boolean): string {
  return [
    renderOperationSummary(operation),
    `Input schema ${operation.input.version}: ${JSON.stringify(operation.input.schema)}`,
    ...(includeResultSchema ? [`Result schema ${operation.result.version}: ${JSON.stringify(operation.result.schema)}`] : []),
  ].join("\n");
}

function renderInvocation(response: OperationInvocationResponse, operationId: string): ToolResult {
  if (response.kind === "rejected") {
    return failure(renderRefusal(response.refusal), response.refusal.code, {
      operation_id: operationId,
      refusal: response.refusal,
    });
  }
  if (response.kind === "conflict") {
    return failure(renderRefusal(response.refusal, response.existing_receipt.receipt_id), response.refusal.code, {
      operation_id: operationId,
      refusal: response.refusal,
      existing_receipt: response.existing_receipt,
    });
  }

  const { receipt } = response;
  if (receipt.state === "refused" && receipt.refusal) {
    return failure(renderRefusal(receipt.refusal, receipt.receipt_id), receipt.refusal.code, {
      operation_id: operationId,
      receipt,
    });
  }
  const renderedResult = JSON.stringify({
    ...(receipt.state === "awaiting_approval" ? {
      refusal: receipt.refusal,
      approval_request_ids: receipt.governance.approval_request_ids,
      retry: { operation_id: receipt.operation_id, operation_version: receipt.operation_version,
        idempotency_key: receipt.idempotency_key, expected_resource_revision: receipt.expected_resource_revision },
    } : {}),
    ...(receipt.result === null ? {} : { result: receipt.result }),
    ...(receipt.target ? { target: receipt.target } : {}),
    ...(receipt.changed_refs.length ? { changed_refs: receipt.changed_refs } : {}),
    ...(receipt.progress_ref ? { progress_ref: receipt.progress_ref } : {}),
    ...(receipt.cancel_ref ? { cancel_ref: receipt.cancel_ref } : {}),
    ...(receipt.audit_ref ? { audit_ref: receipt.audit_ref } : {}),
  });
  return {
    content: [{
      type: "text",
      text: `Operation '${operationId}' ${receipt.state}. Receipt: ${receipt.receipt_id}\n\n${renderedResult}`,
    }],
    details: {
      ok: true,
      operation_id: operationId,
      replayed: response.replayed,
      receipt,
    },
  };
}

function renderRefusal(refusal: OperationRefusal, receiptId?: string): string {
  // Structured tool details are not model input. Preserve the Bus's safe recovery
  // contract in content so the Actor can retry without guessing hidden evidence.
  return `${refusal.message}\n\n${JSON.stringify({
    code: refusal.code,
    retryable: refusal.retryable,
    required_action: refusal.required_action,
    details: refusal.details,
    ...(receiptId ? { receipt_id: receiptId } : {}),
  })}`;
}

export async function requireOperationAuthority(
  bus: BusClient,
  context: Pick<ToolContext, "getActiveTurn">,
): Promise<RuntimeOperationAuthoritySession> {
  const turn = context.getActiveTurn?.() as ActiveToolTurn | undefined;
  if (!turn?.delivery_id) {
    throw new Error("No active Delivery is bound to this runtime tool call.");
  }

  let session = turn.operation_authority_session;
  const expiresAt = session ? Date.parse(session.expires_at) : Number.NaN;
  if (!session || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60_000) {
    const prepared = await bus.prepareRuntimeDelivery(turn.delivery_id);
    if (
      turn.processing_contract_id
      && prepared.processing_contract.processing_contract_id !== turn.processing_contract_id
    ) {
      throw new Error("Runtime preparation returned a different immutable processing contract for the active Delivery.");
    }
    session = prepared.operation_authority_session;
    turn.operation_authority_session = session;
    turn.processing_contract_id = prepared.processing_contract.processing_contract_id;
  }
  return session;
}
