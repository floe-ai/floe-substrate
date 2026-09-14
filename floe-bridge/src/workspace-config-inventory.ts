import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import type { AgentConfig, ProjectLoadResult } from "./project.js";

export type WorkspaceRuntimeObservation = Readonly<{
  agent_id: string;
  adapter_id: string;
  backing_kind?: "human" | "model" | "service" | "team";
  provider?: string | null;
  model?: string | null;
  thinking_level?: string | null;
  credential_requirement?: "none" | "required";
  required_configuration_keys?: readonly string[];
  required_capability_ids?: readonly string[];
  checkpoint_policy?: Readonly<{
    mode: "none" | "provider_neutral" | "required";
    schema_ref: string | null;
  }>;
  resource_policy?: Readonly<Record<string, unknown>>;
}>;

export type WorkspaceConfigurationInventory = Readonly<{
  schema: "floe.workspace-configuration-inventory.v1";
  importer_version: "1";
  binding_id: string;
  config_hash: string;
  source: Readonly<{
    kind: "workspace_files";
    manifest_ref: ".floe/floe.yaml";
  }>;
  validation: Readonly<{
    ok: boolean;
    issues: readonly Readonly<{
      severity: "warning" | "error";
      code: string;
      source_ref: string | null;
    }>[];
  }>;
  actors: readonly WorkspaceConfigurationActorInventory[];
}>;

export type WorkspaceConfigurationActorInventory = Readonly<{
  source_actor_id: string;
  source: Readonly<{
    kind: "workspace_actor_file";
    path: string;
    source_fingerprint: string;
  }>;
  definition: Readonly<{
    label: string;
    charter: string;
    responsibilities: readonly Readonly<{
      responsibility_id: string;
      title: string;
      description: string;
    }>[];
    instructions: string;
    knowledge_refs: readonly Readonly<{
      kind: string;
      id: string;
      revision: string | null;
    }>[];
    policy_refs: Readonly<{
      budget: Readonly<{ kind: string; id: string; revision: string | null }> | null;
      trust: Readonly<{ kind: string; id: string; revision: string | null }> | null;
      approval: Readonly<{ kind: string; id: string; revision: string | null }> | null;
    }>;
    escalation_rules: readonly Readonly<{
      rule_id: string;
      when: string;
      action: "decline" | "delegate" | "escalate" | "signal_unowned";
      target_actor_id?: string | null;
    }>[];
  }>;
  runtime: Readonly<{
    label: string;
    backing_kind: "human" | "model" | "service" | "team";
    adapter_id: string;
    configuration: Readonly<Record<string, unknown>>;
    required_capability_ids: readonly string[];
    checkpoint_policy: Readonly<{
      mode: "none" | "provider_neutral" | "required";
      schema_ref: string | null;
    }>;
    resource_policy: Readonly<Record<string, unknown>>;
    credential_requirement: "none" | "required";
    required_configuration_keys: readonly string[];
  }>;
}>;

export class WorkspaceConfigurationInventoryError extends Error {
  readonly code = "workspace_configuration_inventory_invalid" as const;

  constructor(readonly reason: string) {
    super(`Workspace configuration inventory is invalid: ${reason}`);
    this.name = "WorkspaceConfigurationInventoryError";
  }
}

/**
 * Converts the host-readable Workspace files and effective legacy runtime
 * selection into a deterministic, secret-free import inventory. The Bridge
 * observes files and local references only; the Bus owns every identity,
 * permission, lifecycle decision, and canonical record created from it.
 */
export function buildWorkspaceConfigurationInventory(input: Readonly<{
  binding_id: string;
  project: ProjectLoadResult;
  runtimes: readonly WorkspaceRuntimeObservation[];
}>): WorkspaceConfigurationInventory {
  const bindingId = requiredText(input.binding_id, "binding_id");
  const configHash = requiredText(input.project.config_hash, "config_hash");
  if (!/^sha256:[a-f0-9]{64}$/i.test(configHash)) {
    throw new WorkspaceConfigurationInventoryError("config_hash must be a SHA-256 digest");
  }

  const runtimeByActor = new Map<string, WorkspaceRuntimeObservation>();
  for (const runtime of input.runtimes) {
    const agentId = requiredText(runtime.agent_id, "runtime agent_id");
    if (runtimeByActor.has(agentId)) {
      throw new WorkspaceConfigurationInventoryError(`duplicate runtime observation for Actor '${agentId}'`);
    }
    runtimeByActor.set(agentId, runtime);
  }

  const seenActors = new Set<string>();
  const actors = input.project.agents.map((agent) => {
    const sourceActorId = requiredText(agent.agent_id, "Actor id");
    if (seenActors.has(sourceActorId)) {
      throw new WorkspaceConfigurationInventoryError(`duplicate Actor '${sourceActorId}'`);
    }
    seenActors.add(sourceActorId);
    const runtime = runtimeByActor.get(sourceActorId);
    if (!runtime) {
      throw new WorkspaceConfigurationInventoryError(`runtime observation is missing for Actor '${sourceActorId}'`);
    }
    return actorInventory(agent, runtime);
  }).sort((left, right) => left.source_actor_id.localeCompare(right.source_actor_id));

  for (const agentId of runtimeByActor.keys()) {
    if (!seenActors.has(agentId)) {
      throw new WorkspaceConfigurationInventoryError(`runtime observation names unknown Actor '${agentId}'`);
    }
  }

  return {
    schema: "floe.workspace-configuration-inventory.v1",
    importer_version: "1",
    binding_id: bindingId,
    config_hash: configHash.toLowerCase(),
    source: { kind: "workspace_files", manifest_ref: ".floe/floe.yaml" },
    validation: normalizeValidation(input.project.validation),
    actors,
  };
}

function actorInventory(
  agent: AgentConfig,
  runtime: WorkspaceRuntimeObservation,
): WorkspaceConfigurationActorInventory {
  const sourcePath = safeWorkspacePath(agent.file);
  const label = requiredText(agent.name, `Actor '${agent.agent_id}' label`);
  const instructions = requiredText(agent.body, `Actor '${agent.agent_id}' instructions`);
  const adapterId = requiredText(runtime.adapter_id, `Actor '${agent.agent_id}' runtime adapter`);
  const frontmatter = agent.frontmatter ?? {};
  const configuration: Record<string, unknown> = {};
  if (cleanText(runtime.provider)) configuration.provider = cleanText(runtime.provider);
  if (cleanText(runtime.model)) configuration.model = cleanText(runtime.model);
  if (cleanText(runtime.thinking_level)) configuration.thinking_level = cleanText(runtime.thinking_level);
  assertSafeJson(runtime.resource_policy ?? {}, "resource_policy");

  const definition = {
    label,
    charter: cleanText(frontmatter.charter)
      ?? `Carry out the responsibilities assigned to ${label} in this Workspace.`,
    responsibilities: parseResponsibilities(frontmatter.responsibilities),
    instructions,
    knowledge_refs: parseRefs(frontmatter.knowledge_refs),
    policy_refs: parsePolicyRefs(frontmatter.policy_refs),
    escalation_rules: parseEscalationRules(frontmatter.escalation_rules),
  };
  const checkpointPolicy = normalizeCheckpointPolicy(runtime.checkpoint_policy);
  const runtimeInventory = {
    label: `${label} runtime`,
    backing_kind: runtime.backing_kind ?? "model",
    adapter_id: adapterId,
    configuration,
    required_capability_ids: normalizeTextSet(runtime.required_capability_ids ?? []),
    checkpoint_policy: checkpointPolicy,
    resource_policy: runtime.resource_policy ?? {},
    credential_requirement: runtime.credential_requirement
      ?? (runtime.backing_kind === "human" ? "none" : "required"),
    required_configuration_keys: normalizeTextSet(
      runtime.required_configuration_keys
        ?? ((runtime.backing_kind ?? "model") === "model" ? ["model"] : []),
    ),
  };

  return {
    source_actor_id: requiredText(agent.agent_id, "Actor id"),
    source: {
      kind: "workspace_actor_file",
      path: sourcePath,
      source_fingerprint: sha256(canonicalJson({
        file: sourcePath,
        name: label,
        frontmatter,
        body: instructions,
      })),
    },
    definition,
    runtime: runtimeInventory,
  };
}

function normalizeValidation(validation: ProjectLoadResult["validation"]): WorkspaceConfigurationInventory["validation"] {
  const issues: Array<{ severity: "warning" | "error"; code: string; source_ref: string | null }> = [];
  for (const warning of validation.warnings) {
    issues.push(classifyValidationIssue("warning", warning));
  }
  for (const error of validation.errors) {
    issues.push(classifyValidationIssue("error", error));
  }
  return {
    ok: validation.ok && issues.every((issue) => issue.severity !== "error"),
    issues: issues.sort((left, right) =>
      left.severity.localeCompare(right.severity)
      || left.code.localeCompare(right.code)
      || (left.source_ref ?? "").localeCompare(right.source_ref ?? "")),
  };
}

function classifyValidationIssue(
  severity: "warning" | "error",
  message: string,
): { severity: "warning" | "error"; code: string; source_ref: string | null } {
  if (message === ".floe folder is missing") {
    return { severity, code: "workspace_config_directory_missing", source_ref: ".floe" };
  }
  if (message === ".floe/floe.yaml is missing") {
    return { severity, code: "workspace_manifest_missing", source_ref: ".floe/floe.yaml" };
  }
  if (message.includes("schema is not floe.workspace.v1")) {
    return { severity, code: "workspace_manifest_schema_legacy", source_ref: ".floe/floe.yaml" };
  }
  if (message.startsWith("Unable to parse .floe/floe.yaml")) {
    return { severity, code: "workspace_manifest_invalid", source_ref: ".floe/floe.yaml" };
  }
  if (message.startsWith("Agent file is missing:")) {
    const ref = message.slice("Agent file is missing:".length).trim();
    return {
      severity,
      code: "actor_definition_missing",
      source_ref: ref ? safeWorkspacePath(ref) : null,
    };
  }
  return { severity, code: "workspace_config_validation_issue", source_ref: null };
}

function parseResponsibilities(value: unknown): WorkspaceConfigurationActorInventory["definition"]["responsibilities"] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const object = plainObject(item, `responsibilities[${index}]`);
    return {
      responsibility_id: requiredText(object.responsibility_id, `responsibilities[${index}].responsibility_id`),
      title: requiredText(object.title, `responsibilities[${index}].title`),
      description: requiredText(object.description, `responsibilities[${index}].description`),
    };
  });
}

function parseRefs(value: unknown): WorkspaceConfigurationActorInventory["definition"]["knowledge_refs"] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => parseRef(item, `knowledge_refs[${index}]`));
}

function parsePolicyRefs(value: unknown): WorkspaceConfigurationActorInventory["definition"]["policy_refs"] {
  if (value === undefined || value === null) return { budget: null, trust: null, approval: null };
  const object = plainObject(value, "policy_refs");
  return {
    budget: object.budget == null ? null : parseRef(object.budget, "policy_refs.budget"),
    trust: object.trust == null ? null : parseRef(object.trust, "policy_refs.trust"),
    approval: object.approval == null ? null : parseRef(object.approval, "policy_refs.approval"),
  };
}

function parseRef(value: unknown, label: string): { kind: string; id: string; revision: string | null } {
  const object = plainObject(value, label);
  return {
    kind: requiredText(object.kind, `${label}.kind`),
    id: requiredText(object.id, `${label}.id`),
    revision: object.revision == null ? null : requiredText(object.revision, `${label}.revision`),
  };
}

function parseEscalationRules(value: unknown): WorkspaceConfigurationActorInventory["definition"]["escalation_rules"] {
  if (!Array.isArray(value)) return [];
  const actions = new Set(["decline", "delegate", "escalate", "signal_unowned"]);
  return value.map((item, index) => {
    const object = plainObject(item, `escalation_rules[${index}]`);
    const action = requiredText(object.action, `escalation_rules[${index}].action`);
    if (!actions.has(action)) {
      throw new WorkspaceConfigurationInventoryError(`escalation_rules[${index}].action is invalid`);
    }
    return {
      rule_id: requiredText(object.rule_id, `escalation_rules[${index}].rule_id`),
      when: requiredText(object.when, `escalation_rules[${index}].when`),
      action: action as "decline" | "delegate" | "escalate" | "signal_unowned",
      ...(object.target_actor_id == null
        ? {}
        : { target_actor_id: requiredText(object.target_actor_id, `escalation_rules[${index}].target_actor_id`) }),
    };
  });
}

function normalizeCheckpointPolicy(
  value: WorkspaceRuntimeObservation["checkpoint_policy"],
): WorkspaceConfigurationActorInventory["runtime"]["checkpoint_policy"] {
  if (!value) return { mode: "none", schema_ref: null };
  if (value.mode === "required" && !cleanText(value.schema_ref)) {
    throw new WorkspaceConfigurationInventoryError("required checkpoint policy must name a schema_ref");
  }
  if (value.mode === "none" && value.schema_ref !== null) {
    throw new WorkspaceConfigurationInventoryError("disabled checkpoint policy cannot name a schema_ref");
  }
  return {
    mode: value.mode,
    schema_ref: value.schema_ref == null ? null : requiredText(value.schema_ref, "checkpoint schema_ref"),
  };
}

function safeWorkspacePath(value: unknown): string {
  const path = requiredText(value, "workspace-relative source path").replace(/\\/g, "/");
  if (isAbsolute(path) || path.startsWith("/") || path.split("/").includes("..")) {
    throw new WorkspaceConfigurationInventoryError("source path must stay within the Workspace");
  }
  return path.replace(/^\.\//, "");
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceConfigurationInventoryError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkspaceConfigurationInventoryError(`${label} must be non-empty text`);
  }
  return value.trim();
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeTextSet(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => requiredText(value, "runtime capability id")))]
    .sort((left, right) => left.localeCompare(right));
}

function assertSafeJson(value: unknown, path: string): void {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeJson(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    throw new WorkspaceConfigurationInventoryError(`${path} must contain JSON data only`);
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token|authorization|client[_-]?secret|private[_-]?key|password|secret|credential/i.test(key)) {
      throw new WorkspaceConfigurationInventoryError(`${path}.${key} must not contain secret material`);
    }
    assertSafeJson(item, `${path}.${key}`);
  }
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
