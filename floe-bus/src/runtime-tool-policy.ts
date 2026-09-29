import type { OperationEffects } from "./operations.js";
import type { PolicyEvaluationRecord } from "./policies.js";
import {
  toolNetworkDestination,
  type ToolCallPolicyFacts,
  type ToolNetworkDestination,
} from "./tool-policy-facts.js";
import { ENGINE_TOOL_OPERATIONS, type ToolAuthorityDecision } from "./tool-policy.js";

/**
 * What an engine adapter reports about one attempted built-in call. Paths are
 * already resolved by the Bridge (which owns the filesystem) to canonical
 * workspace-relative form, or null when unresolved or outside the Workspace.
 */
export type RuntimeToolCallRequest = Readonly<{
  operation_id: string;
  tool_call_id: string | null;
  engine: string;
  manifest_version: string;
  native_tools: readonly string[];
  paths: readonly (string | null)[];
  /** One entry per parsed shell segment; null when the engine could not classify it. */
  executables: readonly (string | null)[];
  /** Every destination the call may reach, including redirect origins. Never stored. */
  urls: readonly string[];
  write_redirection: boolean;
  sandbox_bypass: boolean;
  argument_digest: string;
}>;

export type RuntimeToolRefusal = Readonly<{
  code: "tool_policy_denied";
  tool_call_id: string | null;
  operation_id: string;
  rule_id: string;
  reason: string;
}>;

export type RuntimeToolDecision = Readonly<{
  evaluation_id: string;
  decision: PolicyEvaluationRecord["decision"];
  refusal: RuntimeToolRefusal | null;
  approval_requirements: PolicyEvaluationRecord["approval_requirements"];
}>;

export function toolFactsFromRequest(
  request: RuntimeToolCallRequest,
  actorDefinitionRevisionId: string,
): ToolCallPolicyFacts {
  const destinations: ToolNetworkDestination[] = [];
  let invalidUrls = 0;
  for (const url of request.urls) {
    const destination = toolNetworkDestination(url);
    if (destination) destinations.push(destination);
    else invalidUrls += 1;
  }
  return {
    actor_definition_revision_id: actorDefinitionRevisionId,
    tool_call_id: request.tool_call_id,
    engine: request.engine,
    manifest_version: request.manifest_version,
    native_tools: request.native_tools,
    paths: request.paths.filter((path): path is string => path !== null),
    unresolved_path_count: request.paths.filter((path) => path === null).length,
    executables: request.executables.filter((name): name is string => name !== null),
    unclassified_segment_count: request.executables.filter((name) => name === null).length,
    destinations,
    invalid_url_count: invalidUrls,
    write_redirection: request.write_redirection,
    sandbox_bypass: request.sandbox_bypass,
    argument_digest: request.argument_digest,
  };
}

export function toolOperationEffects(operationId: string): OperationEffects {
  switch (operationId) {
    case ENGINE_TOOL_OPERATIONS.filesystem_read:
      return { mode: "read", reversibility: "none", external: false, secret_access: "none" };
    case ENGINE_TOOL_OPERATIONS.network_fetch:
      return { mode: "read", reversibility: "none", external: true, secret_access: "none" };
    case ENGINE_TOOL_OPERATIONS.filesystem_write:
      return { mode: "write", reversibility: "irreversible", external: false, secret_access: "none" };
    default:
      return { mode: "write", reversibility: "irreversible", external: true, secret_access: "none" };
  }
}

export function runtimeToolDecision(
  evaluation: PolicyEvaluationRecord,
  operationId: string,
  toolCallId: string | null,
  authority: ToolAuthorityDecision,
): RuntimeToolDecision {
  let refusal: RuntimeToolRefusal | null = null;
  if (evaluation.decision === "deny") {
    const rule = evaluation.matched_rules.find((item) => item.effect.kind === "deny");
    refusal = {
      code: "tool_policy_denied",
      tool_call_id: toolCallId,
      operation_id: operationId,
      rule_id: authority.allowed ? rule?.rule_id ?? "policy" : `authority.${authority.code}`,
      reason: evaluation.denial_reasons[0] ?? "Denied by policy.",
    };
  }
  return {
    evaluation_id: evaluation.evaluation_id,
    decision: evaluation.decision,
    refusal,
    approval_requirements: evaluation.approval_requirements,
  };
}

/** The pushed, redacted record of one tool decision. */
export function policyDecisionEvent(
  evaluation: PolicyEvaluationRecord,
  context: Readonly<{ delivery_id: string; endpoint_id: string; actor_id: string; rule_id: string | null }>,
): Record<string, unknown> {
  const facts = evaluation.facts!;
  const tool = facts.tool!;
  return {
    evaluation_id: evaluation.evaluation_id,
    workspace_id: evaluation.workspace_id,
    actor_id: context.actor_id,
    actor_definition_revision_id: tool.actor_definition_revision_id,
    endpoint_id: context.endpoint_id,
    delivery_id: context.delivery_id,
    execution_attempt_id: facts.provenance.execution_attempt_id,
    engine: tool.engine,
    manifest_version: tool.manifest_version,
    tool_call_id: tool.tool_call_id,
    operation_id: facts.operation_id,
    native_tools: tool.native_tools,
    paths: tool.paths,
    executables: tool.executables,
    domains: tool.destinations.map((destination) => destination.host),
    argument_digest: tool.argument_digest,
    evaluated_policy_revision_ids: evaluation.evaluated_policy_revision_ids,
    matched_rule_ids: evaluation.matched_rules.map((rule) => rule.rule_id),
    denied_by: context.rule_id,
    decision: evaluation.decision,
    evaluated_at: evaluation.evaluated_at,
  };
}
