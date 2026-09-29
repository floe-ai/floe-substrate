import type { ApprovalAction, ApprovalRequestRecord } from "./approvals.js";
import type { PolicyEvaluationRecord } from "./policies.js";
import type { ToolCallPolicyFacts } from "./tool-policy-facts.js";

/** How one engine tool call that needed a decision finally ended. */
export type ToolApprovalOutcome = "pending" | "allowed" | "denied" | "cancelled" | "unavailable";

/** Why a waiting Bridge stopped waiting before anyone answered. */
export type ToolApprovalAbandonReason = "cancelled" | "unavailable";

export const TOOL_APPROVAL_TARGET_KIND = "runtime_delivery";

/**
 * The exact action an approver sees: one tool call, identified by its
 * redacted argument digest, inside one running Delivery. Changed arguments
 * produce a different action and need a new decision.
 */
export function toolApprovalAction(input: Readonly<{
  evaluation: PolicyEvaluationRecord;
  delivery_id: string;
  grant_id: string;
  scope_execution_id: string | null;
  node_execution_id: string | null;
}>): ApprovalAction {
  const facts = input.evaluation.facts!;
  const tool = facts.tool!;
  const target = { kind: TOOL_APPROVAL_TARGET_KIND, id: input.delivery_id };
  return {
    operation_id: facts.operation_id,
    authorized_principal_id: facts.principal_id,
    target,
    input_digest: tool.argument_digest,
    artefact_version_ids: [],
    composition_revision_id: facts.scope_composition_revision_id,
    node_placement_id: facts.node_placement_id,
    scope_execution_id: input.scope_execution_id,
    node_execution_id: input.node_execution_id,
    connector_binding_revision_id: null,
    extension_package_version_id: null,
    approval_policy_ref: {
      kind: "policy_evaluation",
      id: input.evaluation.evaluation_id,
      revision: input.evaluation.facts_digest,
    },
    capability_grant_ids: [input.grant_id],
    expected_effect: {
      summary: toolCallSummary(facts.operation_id, tool),
      external: facts.effects.external,
      reversibility: facts.effects.reversibility,
      resource_refs: [target],
    },
  };
}

function toolCallSummary(operationId: string, tool: ToolCallPolicyFacts): string {
  const parts = [`${tool.native_tools.join(", ") || operationId} (${operationId})`];
  if (tool.paths.length > 0) parts.push(`paths: ${tool.paths.join(", ")}`);
  if (tool.executables.length > 0) parts.push(`runs: ${tool.executables.join(", ")}`);
  if (tool.destinations.length > 0) parts.push(`reaches: ${tool.destinations.map((item) => item.host).join(", ")}`);
  if (tool.write_redirection) parts.push("writes via redirection");
  return parts.join("; ");
}

/** Every requirement must approve; any refusal or loss ends the call. */
export function toolApprovalOutcome(requests: readonly ApprovalRequestRecord[]): ToolApprovalOutcome {
  if (requests.length === 0) return "unavailable";
  if (requests.some((request) => request.status === "rejected")) return "denied";
  if (requests.some((request) => request.status === "cancelled")) return "cancelled";
  if (requests.some((request) => request.status === "invalidated")) return "unavailable";
  if (requests.some((request) => request.status === "pending")) return "pending";
  return "allowed";
}
