/**
 * Normalized, redacted evidence for one engine built-in tool call. Native tool
 * names are evidence only; authority and policy key on the canonical
 * operation. Full URLs, file contents, and command text are never stored.
 */
export type ToolCallPolicyFacts = Readonly<{
  actor_definition_revision_id: string;
  tool_call_id: string | null;
  engine: string;
  manifest_version: string;
  native_tools: readonly string[];
  /** Canonical workspace-relative paths ("." is the Workspace root). */
  paths: readonly string[];
  /** Paths the engine reported that could not be resolved inside the Workspace. */
  unresolved_path_count: number;
  /** Lowercase executable identifiers from parsed shell segments. */
  executables: readonly string[];
  /** Shell segments the engine could not classify. */
  unclassified_segment_count: number;
  destinations: readonly ToolNetworkDestination[];
  /** URLs the engine reported that could not be parsed. */
  invalid_url_count: number;
  write_redirection: boolean;
  sandbox_bypass: boolean;
  argument_digest: string;
}>;

export type ToolNetworkDestination = Readonly<{ scheme: string; host: string }>;

export class ToolCallFactsError extends Error {
  readonly code = "E_TOOL_CALL_FACTS_INVALID" as const;
  constructor(reason: string) {
    super(`Invalid tool call facts: ${reason}`);
    this.name = "ToolCallFactsError";
  }
}

export function normalizeToolCallPolicyFacts(facts: ToolCallPolicyFacts): ToolCallPolicyFacts {
  return {
    actor_definition_revision_id: text(facts.actor_definition_revision_id, "actor_definition_revision_id"),
    tool_call_id: facts.tool_call_id == null ? null : text(facts.tool_call_id, "tool_call_id"),
    engine: text(facts.engine, "engine"),
    manifest_version: text(facts.manifest_version, "manifest_version"),
    native_tools: sortedUnique(facts.native_tools.map((name) => text(name, "native tool"))),
    paths: sortedUnique(facts.paths.map((path) => text(path, "path"))),
    unresolved_path_count: count(facts.unresolved_path_count, "unresolved_path_count"),
    executables: sortedUnique(facts.executables.map((name) => text(name, "executable").toLowerCase())),
    unclassified_segment_count: count(facts.unclassified_segment_count, "unclassified_segment_count"),
    destinations: [...new Map(facts.destinations.map((destination) => {
      const value = {
        scheme: text(destination.scheme, "destination scheme").toLowerCase(),
        host: text(destination.host, "destination host").toLowerCase(),
      };
      return [`${value.scheme}://${value.host}`, value] as const;
    })).entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value),
    invalid_url_count: count(facts.invalid_url_count, "invalid_url_count"),
    write_redirection: facts.write_redirection === true,
    sandbox_bypass: facts.sandbox_bypass === true,
    argument_digest: text(facts.argument_digest, "argument_digest"),
  };
}

/** Reduces a URL to its scheme and host; null when it cannot be parsed. */
export function toolNetworkDestination(url: string): ToolNetworkDestination | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (!host) return null;
    return { scheme: parsed.protocol.replace(/:$/, "").toLowerCase(), host };
  } catch {
    return null;
  }
}

function text(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ToolCallFactsError(`${label} is required`);
  return value.trim();
}

function count(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new ToolCallFactsError(`${label} must be a non-negative integer`);
  return value;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
