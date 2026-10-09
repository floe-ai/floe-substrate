/**
 * @invariant This file is the provider-neutral public Actor definition contract.
 * It must not depend on Bus storage, transport, runtime, or Node-only APIs.
 */

export type VersionedResourceRef = Readonly<{
  kind: string;
  id: string;
  revision: string | null;
}>;

export type ActorResponsibility = Readonly<{
  responsibility_id: string;
  title: string;
  description: string;
}>;

export type ActorEscalationRule = Readonly<{
  rule_id: string;
  when: string;
  action: "decline" | "delegate" | "escalate" | "signal_unowned";
  target_actor_id?: string | null;
}>;

export type ActorScope = Readonly<{ paths: readonly string[] }>;

export type ActorDefinitionContent = Readonly<{
  label: string;
  charter: string;
  responsibilities: readonly ActorResponsibility[];
  instructions: string;
  knowledge_refs: readonly VersionedResourceRef[];
  capability_grant_ids: readonly string[];
  policy_refs: Readonly<{
    budget: VersionedResourceRef | null;
    trust: VersionedResourceRef | null;
    approval: VersionedResourceRef | null;
  }>;
  escalation_rules: readonly ActorEscalationRule[];
  /**
   * Workspace-relative folders that bound this Actor's filesystem authority.
   * Absent means no filesystem authority at all; grants never widen it.
   */
  scope?: ActorScope;
  /** Names of the Workspace's Extensions whose tools and skills this Actor uses. */
  extensions?: readonly string[];
}>;

/** An Extension name: its folder under `.floe/extensions/` and its tool-name prefix. */
export const EXTENSION_NAME_PATTERN = "^[a-z0-9][a-z0-9-]{0,39}$";
const EXTENSION_NAME = new RegExp(EXTENSION_NAME_PATTERN);

export class ActorDefinitionValidationError extends Error {
  readonly code = "E_ACTOR_DEFINITION_INVALID" as const;
  constructor(readonly reason: string) {
    super(`Invalid Actor definition: ${reason}`);
    this.name = "ActorDefinitionValidationError";
  }
}

/**
 * Canonical workspace-relative scope path: forward slashes, no leading "./",
 * no trailing slash, and "." for the Workspace root. Returns null when the
 * path is absolute or climbs out of the Workspace.
 */
export function canonicalActorScopePath(value: string): string | null {
  const segments: string[] = [];
  const text = value.trim().replace(/\\/g, "/");
  if (!text || text.startsWith("/") || /^[a-z]:/i.test(text)) return null;
  for (const segment of text.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    segments.push(segment);
  }
  return segments.length ? segments.join("/") : ".";
}

export function validateActorDefinition(content: ActorDefinitionContent): void {
  nonEmpty("label", content.label);
  nonEmpty("charter", content.charter);
  nonEmpty("instructions", content.instructions);
  unique(content.responsibilities.map((item) => item.responsibility_id), "responsibility id");
  for (const responsibility of content.responsibilities) {
    nonEmpty("responsibility title", responsibility.title);
    nonEmpty("responsibility description", responsibility.description);
  }
  unique(content.capability_grant_ids, "CapabilityGrant id");
  unique(content.escalation_rules.map((item) => item.rule_id), "escalation rule id");
  for (const ref of content.knowledge_refs) validateRef(ref, "knowledge reference");
  for (const [name, ref] of Object.entries(content.policy_refs)) {
    if (ref) validateRef(ref, `${name} policy reference`);
  }
  if (content.scope !== undefined) {
    if (!content.scope || !Array.isArray(content.scope.paths) || content.scope.paths.length === 0) {
      throw new ActorDefinitionValidationError("scope.paths must list at least one workspace-relative folder");
    }
    for (const path of content.scope.paths) {
      if (typeof path !== "string" || canonicalActorScopePath(path) !== path) {
        throw new ActorDefinitionValidationError(
          `scope path '${String(path)}' must be canonical and stay within the Workspace (for example '.' or 'src/app')`,
        );
      }
    }
    unique(content.scope.paths, "scope path");
  }
  if (content.extensions !== undefined) {
    if (!Array.isArray(content.extensions)) {
      throw new ActorDefinitionValidationError("extensions must be a list of Extension names");
    }
    for (const name of content.extensions) {
      if (typeof name !== "string" || !EXTENSION_NAME.test(name)) {
        throw new ActorDefinitionValidationError(
          `Extension name '${String(name)}' must use lowercase letters, digits and hyphens (for example 'todo')`,
        );
      }
    }
    unique(content.extensions, "Extension name");
  }
  for (const rule of content.escalation_rules) {
    nonEmpty("escalation condition", rule.when);
    if (rule.action === "delegate" && !rule.target_actor_id?.trim()) {
      throw new ActorDefinitionValidationError(`delegation rule '${rule.rule_id}' must name a target Actor`);
    }
    if (rule.action !== "delegate" && rule.target_actor_id != null) {
      throw new ActorDefinitionValidationError(`only delegation rule '${rule.rule_id}' may name a target Actor`);
    }
  }
}

function validateRef(ref: VersionedResourceRef, label: string): void {
  nonEmpty(`${label} kind`, ref.kind);
  nonEmpty(`${label} id`, ref.id);
  if (ref.revision !== null) nonEmpty(`${label} revision`, ref.revision);
}

function unique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    nonEmpty(label, value);
    if (seen.has(value)) throw new ActorDefinitionValidationError(`duplicate ${label} '${value}'`);
    seen.add(value);
  }
}

function nonEmpty(label: string, value: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new ActorDefinitionValidationError(`${label} must not be empty`);
  }
}
