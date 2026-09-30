/**
 * @invariant A turn inspection is read-only and shows only names, states and
 * decisions: tool arguments, results and prose never cross it.
 * @invariant Tool runs and Floe's decisions are listed separately. The engine
 * gives a decision no id shared with the run it allowed, so they are never
 * joined by guesswork.
 */
import type { PolicyEvaluationRecord } from "./policies.js";
import type { SemanticOperationDefinition } from "./operations.js";

export const INSPECT_RUNTIME_DELIVERY_OPERATION_ID = "runtime.delivery.inspect";

export type RuntimeTurnTelemetry = Readonly<{ kind: string; payload: Record<string, unknown>; created_at: string }>;

/** One tool call as the engine reported it running. */
export type RuntimeTurnTool = {
  tool_call_id: string | null;
  name: string | null;
  status: "started" | "completed" | "failed";
  started_at: string | null;
  ended_at: string | null;
};

/** One engine tool call Floe decided before it could run. */
export type RuntimeTurnToolDecision = {
  policy_evaluation_id: string;
  native_tools: readonly string[];
  operation_id: string;
  decision: PolicyEvaluationRecord["decision"];
  evaluated_at: string;
};

export type RuntimeTurnInspection = {
  delivery_id: string;
  state: string;
  endpoint_id: string;
  context_id: string | null;
  trigger_event_id: string;
  model: string | null;
  models: string[];
  tools: RuntimeTurnTool[];
  tool_decisions: RuntimeTurnToolDecision[];
};

export type RuntimeTurnFacts = Readonly<{
  delivery: Readonly<{ delivery_id: string; state: string; endpoint_id: string; context_id: string | null; trigger_event_id: string }>;
  telemetry: readonly RuntimeTurnTelemetry[];
  evaluations: readonly PolicyEvaluationRecord[];
}>;

const text = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;

/** The model(s) a turn ran on, as the engine's own usage records name them. */
function turnModels(telemetry: readonly RuntimeTurnTelemetry[]): { model: string | null; models: string[] } {
  const models: string[] = [];
  let model: string | null = null;
  for (const record of telemetry) {
    if (record.kind !== "usage") continue;
    const usage = record.payload.usage as Record<string, unknown> | null | undefined;
    const calls = Array.isArray(usage?.modelCalls) ? usage.modelCalls as Array<Record<string, unknown>> : [];
    for (const name of [...calls.map((call) => text(call?.model)), text(usage?.model)]) {
      if (name && !models.includes(name)) models.push(name);
    }
    model = text(usage?.model) ?? model;
  }
  return { model, models };
}

/** Each tool call's live start and end, folded into one entry per call. */
function turnTools(telemetry: readonly RuntimeTurnTelemetry[]): RuntimeTurnTool[] {
  const tools: RuntimeTurnTool[] = [];
  const byCall = new Map<string, RuntimeTurnTool>();
  for (const record of telemetry) {
    if (record.kind !== "tool_activity") continue;
    const status = record.payload.status;
    if (status !== "started" && status !== "completed" && status !== "failed") continue;
    const toolCallId = text(record.payload.tool_call_id);
    let tool = toolCallId ? byCall.get(toolCallId) : undefined;
    if (!tool) {
      tool = { tool_call_id: toolCallId, name: null, status, started_at: null, ended_at: null };
      tools.push(tool);
      if (toolCallId) byCall.set(toolCallId, tool);
    }
    tool.name = text(record.payload.name) ?? tool.name;
    tool.status = status;
    const at = text(record.payload.at) ?? record.created_at;
    if (status === "started") tool.started_at = at;
    else tool.ended_at = at;
  }
  return tools;
}

export function inspectRuntimeTurn(facts: RuntimeTurnFacts): RuntimeTurnInspection {
  return {
    ...facts.delivery,
    ...turnModels(facts.telemetry),
    tools: turnTools(facts.telemetry),
    tool_decisions: facts.evaluations.map((evaluation) => ({
      policy_evaluation_id: evaluation.evaluation_id,
      native_tools: evaluation.facts?.tool?.native_tools ?? [],
      operation_id: evaluation.facts?.operation_id ?? "",
      decision: evaluation.decision,
      evaluated_at: evaluation.evaluated_at,
    })),
  };
}

const nullableText = { type: ["string", "null"] };

export function inspectRuntimeDeliveryOperation(backend: {
  inspect(workspaceId: string, deliveryId: string): RuntimeTurnInspection;
}): SemanticOperationDefinition<Record<string, never>, RuntimeTurnInspection> {
  return {
    operation_id: INSPECT_RUNTIME_DELIVERY_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "runtime",
    title: "Inspect response",
    description: "Read one runtime response (turn): the model(s) it actually ran on, from the engine's usage records, each tool it ran with its state, and Floe's decision on each engine tool call. Never shows tool arguments, results or prose.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [INSPECT_RUNTIME_DELIVERY_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["runtime_delivery"], expected_revision: "not_applicable" },
    input: { version: "1", schema: { type: "object", additionalProperties: false } },
    result: { version: "1", schema: {
      type: "object", additionalProperties: false,
      required: ["delivery_id", "state", "endpoint_id", "context_id", "trigger_event_id", "model", "models", "tools", "tool_decisions"],
      properties: {
        delivery_id: { type: "string" }, state: { type: "string" }, endpoint_id: { type: "string" },
        context_id: nullableText, trigger_event_id: { type: "string" }, model: nullableText,
        models: { type: "array", items: { type: "string" } },
        tools: { type: "array", items: {
          type: "object", additionalProperties: false,
          required: ["tool_call_id", "name", "status", "started_at", "ended_at"],
          properties: {
            tool_call_id: nullableText, name: nullableText, status: { type: "string" },
            started_at: nullableText, ended_at: nullableText,
          },
        } },
        tool_decisions: { type: "array", items: {
          type: "object", additionalProperties: false,
          required: ["policy_evaluation_id", "native_tools", "operation_id", "decision", "evaluated_at"],
          properties: {
            policy_evaluation_id: { type: "string" }, native_tools: { type: "array", items: { type: "string" } },
            operation_id: { type: "string" }, decision: { type: "string" }, evaluated_at: { type: "string" },
          },
        } },
      },
    } },
    availability: () => ({ available: true }),
    handler: context => {
      const workspaceId = (context.target!.state as { workspace_id: string }).workspace_id;
      return {
        state: "completed",
        result: backend.inspect(workspaceId, context.target!.ref.id),
        changed_refs: [],
        audit_ref: { kind: "operation_invocation", id: context.invocation_id, revision: null },
      };
    },
  };
}
