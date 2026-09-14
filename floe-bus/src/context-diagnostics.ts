import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BusStore } from "./store.js";

type RuntimeStatus = {
  bridge: {
    online: boolean;
    runtime_adapter: string | null;
    release_version: string | null;
    build_sha: string | null;
  };
};

type DeliveryRow = {
  delivery_id: string;
  endpoint_id: string;
  trigger_event_id: string;
  state: string;
  lease_expires_at: string | null;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  claimed_at: string | null;
};

type TelemetryRow = {
  telemetry_id: string;
  endpoint_id: string;
  delivery_id: string | null;
  kind: string;
  payload_json: string;
  created_at: string;
};

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return { diagnostic_parse_error: true };
  }
}

const TELEMETRY_CORRELATION_FIELDS = [
  "runtime_turn_id",
  "delivery_id",
  "delivery_attempt_id",
  "endpoint_id",
  "thread_id",
  "scope_id",
  "started_at",
  "trigger_event_id",
  "context_id",
] as const;

const TELEMETRY_DIAGNOSTIC_FIELDS = [
  "phase",
  "status",
  "outcome",
  "reason",
  "code",
  "note",
  "error_message",
  "http_status",
  "provider",
  "model",
  "stop_reason",
  "usage",
] as const;

/**
 * Runtime telemetry is richer than a support report should be. In particular,
 * BeforeToolUse payloads can contain full tool arguments. Export only stable
 * operational fields, plus non-content tool outcome metadata, so tool input,
 * output, visible prose, and scratch reasoning never cross this API boundary.
 */
function projectTelemetryPayload(kind: string, payloadJson: string): Record<string, unknown> {
  const payload = parseObject(payloadJson);
  const allowed = new Set<string>([
    ...TELEMETRY_CORRELATION_FIELDS,
    ...TELEMETRY_DIAGNOSTIC_FIELDS,
    ...(kind === "BeforeToolUse" || kind === "AfterToolUse" || kind === "ToolUseFailed"
      ? ["toolName", "isError", "duration_ms"]
      : []),
  ]);
  return Object.fromEntries(Object.entries(payload).filter(([key]) => allowed.has(key)));
}

/**
 * A bounded, read-only support projection. This is an API representation over
 * existing Bus truth, not a new substrate primitive or persistence model.
 */
export function registerContextDiagnosticRoutes(
  app: FastifyInstance,
  store: BusStore,
  getRuntimeStatus: () => RuntimeStatus,
): void {
  app.get("/v1/workspaces/:workspace_id/diagnostics/contexts/:context_id", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string().min(1),
      context_id: z.string().min(1),
    }).parse(request.params);
    const query = z.object({
      event_limit: z.coerce.number().int().min(1).max(100).default(30),
      delivery_limit: z.coerce.number().int().min(1).max(100).default(30),
      telemetry_limit: z.coerce.number().int().min(1).max(300).default(100),
    }).parse(request.query);

    const workspace = store.getWorkspace(params.workspace_id);
    if (!workspace) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    const context = store.contextStore.getContext(params.context_id);
    if (!context || context.workspace_id !== params.workspace_id) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.context_id });
    }

    const eventPage = store.listEvents({
      workspace_id: params.workspace_id,
      context_id: params.context_id,
      direction: "backward",
      limit: query.event_limit + 1,
    });
    const deliveryPage = store.listContextDeliveries({
      workspace_id: params.workspace_id,
      context_id: params.context_id,
      limit: query.delivery_limit + 1,
    }) as DeliveryRow[];
    const deliveries = deliveryPage.slice(-query.delivery_limit);
    const telemetryPage = store.listDeliveryTelemetry({
      workspace_id: params.workspace_id,
      delivery_ids: deliveries.map((delivery) => delivery.delivery_id),
      exclude_kinds: ["visible_output"],
      limit: query.telemetry_limit + 1,
    }) as TelemetryRow[];
    const participants = store.contextStore.getContextParticipants(params.context_id);
    const endpoints = participants.map((endpointId) => store.getEndpoint(endpointId)).filter(Boolean);

    return {
      schema: "floe.context-diagnostic.v1",
      generated_at: new Date().toISOString(),
      source: {
        component: "floe-bus",
        release_version: process.env.FLOE_RELEASE_VERSION ?? null,
        build_sha: process.env.FLOE_BUILD_SHA ?? null,
      },
      workspace: { workspace_id: params.workspace_id },
      context: {
        ...context,
        participants,
        endpoints: endpoints.map((endpoint) => ({
          endpoint_id: String(endpoint.endpoint_id),
          name: String(endpoint.name),
          agent_id: endpoint.agent_id == null ? null : String(endpoint.agent_id),
          bridge_id: endpoint.bridge_id == null ? null : String(endpoint.bridge_id),
          status: String(endpoint.status),
        })),
      },
      events: eventPage.slice(-query.event_limit),
      deliveries: deliveries.map((delivery) => ({
        delivery_id: delivery.delivery_id,
        endpoint_id: delivery.endpoint_id,
        trigger_event_id: delivery.trigger_event_id,
        state: delivery.state,
        lease_expires_at: delivery.lease_expires_at,
        attempt_count: delivery.attempt_count,
        last_error: delivery.last_error,
        created_at: delivery.created_at,
        claimed_at: delivery.claimed_at,
      })),
      telemetry: telemetryPage.slice(-query.telemetry_limit).map((record) => ({
        telemetry_id: record.telemetry_id,
        endpoint_id: record.endpoint_id,
        delivery_id: record.delivery_id,
        kind: record.kind,
        payload: projectTelemetryPayload(record.kind, record.payload_json),
        created_at: record.created_at,
      })),
      runtime: getRuntimeStatus(),
      operations: store.operationRegistry.listCurrentOperationMetadata({
        interaction_mode: "unattended",
        boundary_kind: "workspace",
      }).map((operation) => ({
        operation_id: operation.operation_id,
        operation_version: operation.operation_version,
        category: operation.category,
        title: operation.title,
        effects: operation.effects,
      })),
      limits: {
        events: query.event_limit,
        deliveries: query.delivery_limit,
        telemetry: query.telemetry_limit,
        events_truncated: eventPage.length > query.event_limit,
        deliveries_truncated: deliveryPage.length > query.delivery_limit,
        telemetry_truncated: telemetryPage.length > query.telemetry_limit,
      },
    };
  });
}
