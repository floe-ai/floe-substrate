import {
  EXECUTABLE_TARGET_KIND,
  FILESYSTEM_PATH_TARGET_KIND,
  NETWORK_DOMAIN_TARGET_KIND,
  targetContains,
  type CapabilityGrantRecord,
  type CapabilityGrantTarget,
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
  | "tool_path_outside_scope"
  | "tool_target_not_granted"
  | "tool_shell_ambiguous"
  | "tool_network_not_granted"
  | "tool_shell_unconfined";

export function isEngineToolOperation(operationId: string): operationId is EngineToolOperationId {
  return TOOL_OPERATION_IDS.has(operationId);
}

/**
 * The authority half of a tool decision. Holding a grant for the operation is
 * enough: an untargeted grant and no declared scope leave the call
 * unrestricted. Restrictions are opt-in (grant targets, the Actor's
 * `scope.paths`); a call is checked only against the restrictions chosen, and
 * is refused when the engine's evidence cannot show that it complies.
 * Policy may then restrict what remains but can never widen it.
 */
export function decideToolAuthority(input: Readonly<{
  operation_id: string;
  facts: ToolCallPolicyFacts;
  /** Canonical Actor scope paths; null when the Actor chose no folder limit. */
  scope_paths: readonly string[] | null;
  grants: readonly ToolAuthorityGrant[];
}>): ToolAuthorityDecision {
  const { operation_id: operationId, facts, scope_paths: scope } = input;
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
  if (operationId === ENGINE_TOOL_OPERATIONS.process_execute) return decideShell(candidates, facts, scope, input.grants);

  if (scope !== null && touchesFiles(facts, operationId)) {
    const refusal = pathsRefusal(facts, scope.map((id) => ({ kind: FILESYSTEM_PATH_TARGET_KIND, id })), "this Actor's scope", "tool_path_outside_scope");
    if (refusal) return refusal;
  }
  const refusals = candidates.map((grant) => grantRefusal(grant, facts, operationId));
  const index = refusals.findIndex((refusal) => refusal === null);
  return index >= 0 ? { allowed: true, grant_id: candidates[index]!.grant_id } : refusals[0]!;
}

/**
 * Shell is unrestricted unless a person chose limits. Engines report only
 * command names for shell calls, so a folder limit can never be shown to hold
 * and refuses every shell call; a command allowlist is checked on those names.
 */
function decideShell(
  candidates: readonly ToolAuthorityGrant[],
  facts: ToolCallPolicyFacts,
  scope: readonly string[] | null,
  grants: readonly ToolAuthorityGrant[],
): ToolAuthorityDecision {
  if (scope !== null) {
    return deny("tool_shell_unconfined", "This Actor is limited to chosen folders, and this engine does not report which"
      + " files a shell command touches, so its shell calls cannot be shown to stay inside them.");
  }
  let first: ToolAuthorityDecision | null = null;
  for (const grant of candidates) {
    const refusal = grantRefusal(grant, facts, ENGINE_TOOL_OPERATIONS.process_execute);
    if (!refusal) {
      const network = shellNetworkRefusal(facts, grants);
      return network ?? { allowed: true, grant_id: grant.grant_id };
    }
    first ??= refusal;
  }
  return first!;
}

/** A shell command's reported destinations must satisfy any fetch limits the Actor has. */
function shellNetworkRefusal(facts: ToolCallPolicyFacts, grants: readonly ToolAuthorityGrant[]): ToolAuthorityDecision | null {
  if (facts.destinations.length === 0 && facts.invalid_url_count === 0) return null;
  const fetch = grants.filter((grant) => grant.operation_ids.includes(ENGINE_TOOL_OPERATIONS.network_fetch));
  if (fetch.some((grant) => grantRefusal(grant, { ...facts, paths: [], unresolved_path_count: 0 }, ENGINE_TOOL_OPERATIONS.network_fetch) === null)) {
    return null;
  }
  return deny("tool_network_not_granted", "The command reaches a network destination this Actor may not fetch.");
}

function grantRefusal(grant: ToolAuthorityGrant, facts: ToolCallPolicyFacts, operationId: string): ToolAuthorityDecision | null {
  if (grant.targets.some((target) => !TOOL_TARGET_KINDS.has(target.kind))) {
    return deny("tool_target_not_granted", `This Actor's grant for '${operationId}' has limits that do not apply to engine tools.`);
  }
  const ofKind = (kind: string) => grant.targets.filter((target) => target.kind === kind);
  const folders = ofKind(FILESYSTEM_PATH_TARGET_KIND);
  if (folders.length > 0) {
    if (operationId === ENGINE_TOOL_OPERATIONS.process_execute) {
      return deny("tool_shell_unconfined", "This Actor's shell access is limited to chosen folders, and this engine does not"
        + " report which files a shell command touches.");
    }
    if (touchesFiles(facts, operationId)) {
      const refusal = pathsRefusal(facts, folders, "the folders this Actor was granted", "tool_target_not_granted");
      if (refusal) return refusal;
    }
  }
  const commands = ofKind(EXECUTABLE_TARGET_KIND);
  if (operationId === ENGINE_TOOL_OPERATIONS.process_execute && commands.length > 0) {
    const ambiguity = shellAmbiguity(facts);
    if (ambiguity) return deny("tool_shell_ambiguous", ambiguity);
    const unlisted = facts.executables.find((name) => !commands.some((target) => targetContains(target, { kind: EXECUTABLE_TARGET_KIND, id: name })));
    if (unlisted !== undefined) return deny("tool_target_not_granted", `'${unlisted}' is not one of the commands this Actor may run.`);
  }
  const domains = ofKind(NETWORK_DOMAIN_TARGET_KIND);
  if (operationId === ENGINE_TOOL_OPERATIONS.network_fetch && domains.length > 0) {
    if (facts.invalid_url_count > 0 || facts.destinations.length === 0) {
      return deny("tool_network_not_granted", "The fetch destination could not be determined.");
    }
    const unsupported = facts.destinations.find((destination) => !FETCH_SCHEMES.has(destination.scheme));
    if (unsupported) return deny("tool_network_not_granted", `The '${unsupported.scheme}' scheme is not allowed for fetches.`);
    const outside = facts.destinations.find((destination) => !domains.some((target) =>
      targetContains(target, { kind: NETWORK_DOMAIN_TARGET_KIND, id: destination.host })));
    if (outside) return deny("tool_target_not_granted", `'${outside.host}' is not one of the domains this Actor may fetch.`);
  }
  return null;
}

function touchesFiles(facts: ToolCallPolicyFacts, operationId: string): boolean {
  return operationId === ENGINE_TOOL_OPERATIONS.filesystem_read || operationId === ENGINE_TOOL_OPERATIONS.filesystem_write
    || facts.paths.length > 0 || facts.unresolved_path_count > 0;
}

function pathsRefusal(
  facts: ToolCallPolicyFacts,
  folders: readonly CapabilityGrantTarget[],
  label: string,
  code: "tool_path_outside_scope" | "tool_target_not_granted",
): ToolAuthorityDecision | null {
  if (facts.unresolved_path_count > 0) {
    return deny("tool_path_unresolved", `A path could not be resolved inside the Workspace, so it cannot be shown to be within ${label}.`);
  }
  if (facts.paths.length === 0) {
    return deny("tool_path_missing", `The engine did not report which path this call touches, so it cannot be shown to be within ${label}.`);
  }
  const outside = facts.paths.find((path) => !folders.some((folder) =>
    targetContains(folder, { kind: FILESYSTEM_PATH_TARGET_KIND, id: path })));
  return outside === undefined ? null : deny(code, `'${outside}' is outside ${label}.`);
}

function shellAmbiguity(facts: ToolCallPolicyFacts): string | null {
  if (facts.executables.length === 0 || facts.unclassified_segment_count > 0) {
    return "The engine could not identify every command in this shell call.";
  }
  if (facts.write_redirection) {
    return "The command redirects output into a file, which a command allowlist does not cover.";
  }
  return null;
}

function deny(code: ToolAuthorityDenialCode, reason: string): ToolAuthorityDecision {
  return { allowed: false, code, reason };
}
