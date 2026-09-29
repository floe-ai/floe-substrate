import {
  EXECUTABLE_TARGET_KIND,
  FILESYSTEM_PATH_TARGET_KIND,
  NETWORK_DOMAIN_TARGET_KIND,
  targetContains,
  type CapabilityGrantRecord,
} from "./capability-grants.js";
import type { ToolCallPolicyFacts } from "./tool-policy-facts.js";

/** Canonical operations an engine adapter may map a native built-in tool onto. */
export const ENGINE_TOOL_OPERATIONS = {
  filesystem_read: "engine.tool.filesystem.read",
  filesystem_write: "engine.tool.filesystem.write",
  process_execute: "engine.tool.process.execute",
  network_fetch: "engine.tool.network.fetch",
} as const;

export type EngineToolOperationId = typeof ENGINE_TOOL_OPERATIONS[keyof typeof ENGINE_TOOL_OPERATIONS];

const TOOL_OPERATION_IDS = new Set<string>(Object.values(ENGINE_TOOL_OPERATIONS));
const TOOL_TARGET_KINDS = new Set([FILESYSTEM_PATH_TARGET_KIND, EXECUTABLE_TARGET_KIND, NETWORK_DOMAIN_TARGET_KIND]);
const FETCH_SCHEMES = new Set(["http", "https"]);

export type ToolAuthorityGrant = Pick<CapabilityGrantRecord, "grant_id" | "operation_ids" | "targets">;

export type ToolAuthorityDecision =
  | Readonly<{ allowed: true; grant_id: string }>
  | Readonly<{ allowed: false; code: ToolAuthorityDenialCode; reason: string }>;

export type ToolAuthorityDenialCode =
  | "tool_operation_unknown"
  | "tool_sandbox_bypass"
  | "tool_grant_missing"
  | "tool_path_missing"
  | "tool_path_unresolved"
  | "tool_scope_missing"
  | "tool_path_outside_scope"
  | "tool_target_not_granted"
  | "tool_shell_ambiguous"
  | "tool_network_not_granted";

export function isEngineToolOperation(operationId: string): operationId is EngineToolOperationId {
  return TOOL_OPERATION_IDS.has(operationId);
}

/**
 * The authority half of a tool decision: the intersection of the Actor's live
 * exercisable grants and its filesystem scope, judged on the engine's
 * normalized evidence. Anything missing, unresolved, or ambiguous is refused;
 * policy may then restrict what remains but can never widen it.
 */
export function decideToolAuthority(input: Readonly<{
  operation_id: string;
  facts: ToolCallPolicyFacts;
  /** Canonical Actor scope paths; null when the Actor declares no scope. */
  scope_paths: readonly string[] | null;
  grants: readonly ToolAuthorityGrant[];
}>): ToolAuthorityDecision {
  const { operation_id: operationId, facts } = input;
  if (!isEngineToolOperation(operationId)) {
    return deny("tool_operation_unknown", `'${operationId}' is not a governed engine tool operation.`);
  }
  if (facts.sandbox_bypass) {
    return deny("tool_sandbox_bypass", "The engine asked to bypass its sandbox; Floe never allows that.");
  }
  const candidates = input.grants.filter((grant) => grant.operation_ids.includes(operationId));
  if (candidates.length === 0) {
    return deny("tool_grant_missing", `This Actor holds no live grant for '${operationId}'.`);
  }

  const readsOrWritesFiles = operationId === ENGINE_TOOL_OPERATIONS.filesystem_read
    || operationId === ENGINE_TOOL_OPERATIONS.filesystem_write;
  if (facts.unresolved_path_count > 0) {
    return deny("tool_path_unresolved", "A path could not be resolved inside the Workspace.");
  }
  if (readsOrWritesFiles && facts.paths.length === 0) {
    return deny("tool_path_missing", "The engine did not report which path this call touches.");
  }
  if (facts.paths.length > 0) {
    if (input.scope_paths === null) {
      return deny("tool_scope_missing", "This Actor declares no filesystem scope, so it may not touch files.");
    }
    const outside = facts.paths.find((path) => !input.scope_paths!.some((scope) =>
      targetContains({ kind: FILESYSTEM_PATH_TARGET_KIND, id: scope }, { kind: FILESYSTEM_PATH_TARGET_KIND, id: path })));
    if (outside !== undefined) {
      return deny("tool_path_outside_scope", `'${outside}' is outside this Actor's scope.`);
    }
  }

  if (operationId === ENGINE_TOOL_OPERATIONS.network_fetch) {
    if (facts.invalid_url_count > 0 || facts.destinations.length === 0) {
      return deny("tool_network_not_granted", "The fetch destination could not be determined.");
    }
    const unsupported = facts.destinations.find((destination) => !FETCH_SCHEMES.has(destination.scheme));
    if (unsupported) {
      return deny("tool_network_not_granted", `The '${unsupported.scheme}' scheme is not allowed for fetches.`);
    }
  }

  if (operationId === ENGINE_TOOL_OPERATIONS.process_execute) {
    const ambiguity = shellAmbiguity(facts);
    if (ambiguity) return deny("tool_shell_ambiguous", ambiguity);
  }

  const covering = candidates.find((grant) => grantCovers(grant, facts, operationId));
  if (!covering) {
    return deny("tool_target_not_granted", `No live grant for '${operationId}' covers every path, command, and destination in this call.`);
  }

  if (operationId === ENGINE_TOOL_OPERATIONS.process_execute && facts.destinations.length > 0) {
    const fetchable = facts.destinations.every((destination) => FETCH_SCHEMES.has(destination.scheme))
      && input.grants.some((grant) =>
        grant.operation_ids.includes(ENGINE_TOOL_OPERATIONS.network_fetch)
        && grantCovers(grant, { ...facts, paths: [], executables: [] }, ENGINE_TOOL_OPERATIONS.network_fetch));
    if (!fetchable) {
      return deny("tool_network_not_granted", "The command reaches a network destination this Actor may not fetch.");
    }
  }
  return { allowed: true, grant_id: covering.grant_id };
}

function shellAmbiguity(facts: ToolCallPolicyFacts): string | null {
  if (facts.executables.length === 0 || facts.unclassified_segment_count > 0) {
    return "The engine could not identify every command in this shell call.";
  }
  if (facts.write_redirection) {
    return "The command redirects output into a file, which shell grants do not allow.";
  }
  if (facts.invalid_url_count > 0) {
    return "The command mentions a network destination that could not be parsed.";
  }
  return null;
}

function grantCovers(grant: ToolAuthorityGrant, facts: ToolCallPolicyFacts, operationId: string): boolean {
  if (grant.targets.some((target) => !TOOL_TARGET_KINDS.has(target.kind))) return false;
  const ofKind = (kind: string) => grant.targets.filter((target) => target.kind === kind);
  const within = (kind: string, ids: readonly string[]) => {
    const allowed = ofKind(kind);
    return ids.every((id) => allowed.some((target) => targetContains(target, { kind, id })));
  };
  if (ofKind(FILESYSTEM_PATH_TARGET_KIND).length > 0 && !within(FILESYSTEM_PATH_TARGET_KIND, facts.paths)) return false;
  if (operationId === ENGINE_TOOL_OPERATIONS.process_execute) {
    // Automatic shell execution needs an explicit executable allowlist.
    if (ofKind(EXECUTABLE_TARGET_KIND).length === 0 || !within(EXECUTABLE_TARGET_KIND, facts.executables)) return false;
  }
  if (operationId === ENGINE_TOOL_OPERATIONS.network_fetch && ofKind(NETWORK_DOMAIN_TARGET_KIND).length > 0) {
    if (!within(NETWORK_DOMAIN_TARGET_KIND, facts.destinations.map((destination) => destination.host))) return false;
  }
  return true;
}

function deny(code: ToolAuthorityDenialCode, reason: string): ToolAuthorityDecision {
  return { allowed: false, code, reason };
}
