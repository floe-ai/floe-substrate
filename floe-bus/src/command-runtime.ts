import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { CommandDefinitionRevision, CommandRecord } from "./command-definitions.js";
import type { ExtensionEntryPointExecution } from "./extension-operations.js";
import type {
  ExtensionInstallation,
  ExtensionPackageVersion,
  ExtensionStore,
} from "./extensions.js";
import type { JsonValue } from "./isolated-extension-runtime.js";
import type { ScopeNodePlacement, ScopePort } from "./scope-compositions.js";
import type {
  ExecutionAttemptRecord,
  NodeExecutionRecord,
  ScopeExecutionRecord,
} from "./scope-executions.js";
import { coreCommandImplementationAvailable } from "./isolated-command-host-child.js";

export type CommandWorkerBindingRecord = Readonly<{
  command_worker_binding_id: string;
  workspace_id: string;
  host_id: string;
  worker_endpoint_id: string;
  worker_principal_id: string;
  status: "available" | "unavailable" | "retired";
  supported_implementation_kinds: readonly ("core_command_implementation" | "extension_package_version")[];
  created_at: string;
  updated_at: string;
}>;

export type CommandProcessingInputValue = Readonly<{
  input_id: string;
  delivery_id: string;
  member_key: string;
  event: Readonly<{
    event_id: string;
    type: string;
    content: Readonly<Record<string, unknown>>;
    artefact_version_ids: readonly string[];
  }>;
  artefact_version_id: string | null;
}>;

/**
 * Persisted, provider-neutral input to one exact Command attempt. It contains
 * no Edge or downstream target, and no mutable implementation lookup.
 */
export type CommandProcessingContract = Readonly<{
  contract_kind: "command_node";
  contract_version: 1;
  processing_contract_id: string;
  semantic_digest: string;
  workspace_id: string;
  scope_execution: ScopeExecutionRecord;
  node_execution: NodeExecutionRecord;
  execution_attempt: ExecutionAttemptRecord;
  placement: ScopeNodePlacement;
  command: Readonly<{
    identity: CommandRecord;
    definition: CommandDefinitionRevision;
  }>;
  worker: CommandWorkerBindingRecord;
  context: Readonly<{
    context_id: string;
    inspect_operation_id: "context.inspect";
  }>;
  operation_authority: Readonly<{
    principal_id: string;
    capability_grant_ids: readonly string[];
  }>;
  /** Values validated against the exact published Command input schema. */
  arguments: Readonly<Record<string, unknown>>;
  /** Immutable Delivery/Event/Artefact evidence from which arguments came. */
  input: Readonly<Record<string, readonly CommandProcessingInputValue[]>>;
  outputs: Readonly<{
    publish_operation_id: "scope.node-output.publish";
    ports: readonly ScopePort[];
  }>;
  idempotency_key: string;
  timeout_at: string;
}>;

export type CommandOutputValue = Readonly<{
  /** Value validated under this named output property. */
  value?: unknown;
  event_type?: string;
  content: Readonly<Record<string, unknown>>;
  artefact_version_ids?: readonly string[];
  member_key?: string;
}>;

export type CommandHostResult = Readonly<{
  outputs: Readonly<Record<string, readonly CommandOutputValue[]>>;
  resource_use?: Readonly<Record<string, number>>;
  evidence_refs?: readonly Readonly<{ kind: string; id: string; revision?: string | null }>[];
  /** Exact canonical ExternalEffectReceipt refs returned by brokered operations. */
  external_effect_receipt_ids?: readonly string[];
}>;

export type ResolvedCommandImplementation =
  | Readonly<{
      kind: "core_command_implementation";
      implementation_id: string;
      implementation_revision: string;
      entry_point: string;
    }>
  | Readonly<{
      kind: "extension_package_version";
      installation: ExtensionInstallation;
      package_version: ExtensionPackageVersion;
      entry_point_id: string;
    }>;

export type CommandHostInvocation = Readonly<{
  definition: CommandDefinitionRevision;
  implementation: ResolvedCommandImplementation;
  contract: CommandProcessingContract;
}>;

export interface CommandRuntimeHost {
  supports(input: CommandHostInvocation): boolean;
  invoke(input: CommandHostInvocation): Promise<CommandHostResult>;
  cancel(attemptId: string): boolean;
  terminateAll(): void;
}

export class CommandRuntimeContractError extends Error {
  readonly code = "E_COMMAND_RUNTIME_CONTRACT_INVALID" as const;
  constructor(readonly reason: string) {
    super(`Command runtime contract invalid: ${reason}`);
    this.name = "CommandRuntimeContractError";
  }
}

export function applyCommandRuntimeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS command_worker_bindings (
      command_worker_binding_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      worker_endpoint_id TEXT NOT NULL UNIQUE,
      worker_principal_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'unavailable', 'retired')),
      supported_implementation_kinds_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, host_id)
    );

    CREATE INDEX IF NOT EXISTS idx_command_worker_bindings_workspace
      ON command_worker_bindings(workspace_id, status, host_id);

    CREATE TABLE IF NOT EXISTS command_attempt_contracts (
      attempt_id TEXT PRIMARY KEY,
      processing_contract_id TEXT NOT NULL UNIQUE,
      semantic_digest TEXT NOT NULL,
      command_definition_revision_id TEXT NOT NULL,
      command_worker_binding_id TEXT NOT NULL,
      contract_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

/** Host-local execution infrastructure. Command identity never lives here. */
export class CommandWorkerBindingStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    applyCommandRuntimeSchema(db);
  }

  ensureDefault(workspaceId: string, hostId: string): CommandWorkerBindingRecord {
    const existing = this.getForWorkspace(workspaceId, hostId);
    if (existing) return existing;
    const suffix = createHash("sha256").update(`${hostId}\0${workspaceId}`).digest("hex").slice(0, 32);
    const bindingId = `command_worker_binding_${suffix}`;
    const endpointId = `command_worker_endpoint_${suffix}`;
    const principalId = `command_worker_principal_${suffix}`;
    const at = this.now();
    const kinds = ["core_command_implementation", "extension_package_version"] as const;
    this.db.exec("SAVEPOINT ensure_command_worker");
    try {
      this.db.prepare(`
        INSERT INTO endpoints (
          endpoint_id, workspace_id, name, agent_id, bridge_id, status,
          metadata_json, created_at, updated_at
        ) VALUES (?, ?, 'Floe Command worker', NULL, NULL, 'idle', ?, ?, ?)
        ON CONFLICT(endpoint_id) DO NOTHING
      `).run(endpointId, workspaceId, JSON.stringify({
        endpoint_kind: "command_worker",
        command_worker_binding_id: bindingId,
        host_id: hostId,
      }), at, at);
      const endpoint = this.db.prepare(`
        SELECT workspace_id, bridge_id, metadata_json FROM endpoints WHERE endpoint_id = ?
      `).get(endpointId) as { workspace_id: string; bridge_id: string | null; metadata_json: string } | undefined;
      const metadata = endpoint ? JSON.parse(endpoint.metadata_json) as Record<string, unknown> : {};
      if (!endpoint || endpoint.workspace_id !== workspaceId || endpoint.bridge_id !== null
        || metadata.command_worker_binding_id !== bindingId) {
        throw new CommandRuntimeContractError("the derived Command worker Endpoint conflicts with another Endpoint");
      }
      this.db.prepare(`
        INSERT INTO command_worker_bindings (
          command_worker_binding_id, workspace_id, host_id, worker_endpoint_id,
          worker_principal_id, status, supported_implementation_kinds_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'available', ?, ?, ?)
      `).run(bindingId, workspaceId, hostId, endpointId, principalId, JSON.stringify(kinds), at, at);
      this.db.exec("RELEASE ensure_command_worker");
    } catch (error) {
      this.db.exec("ROLLBACK TO ensure_command_worker");
      this.db.exec("RELEASE ensure_command_worker");
      throw error;
    }
    return this.require(bindingId);
  }

  get(bindingId: string): CommandWorkerBindingRecord | null {
    const row = this.db.prepare(`SELECT * FROM command_worker_bindings WHERE command_worker_binding_id = ?`)
      .get(bindingId) as any;
    return row ? rowToWorker(row) : null;
  }

  require(bindingId: string): CommandWorkerBindingRecord {
    const worker = this.get(bindingId);
    if (!worker) throw new CommandRuntimeContractError(`Command worker binding '${bindingId}' does not exist`);
    return worker;
  }

  getForWorkspace(workspaceId: string, hostId: string): CommandWorkerBindingRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM command_worker_bindings WHERE workspace_id = ? AND host_id = ?
    `).get(workspaceId, hostId) as any;
    return row ? rowToWorker(row) : null;
  }

  getByEndpoint(endpointId: string): CommandWorkerBindingRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM command_worker_bindings WHERE worker_endpoint_id = ?
    `).get(endpointId) as any;
    return row ? rowToWorker(row) : null;
  }
}

export class CommandProcessingContractStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    applyCommandRuntimeSchema(db);
  }

  persist(contract: Omit<CommandProcessingContract, "semantic_digest">): CommandProcessingContract {
    const withoutDigest = JSON.parse(JSON.stringify(contract)) as Omit<CommandProcessingContract, "semantic_digest">;
    const digest = sha256(canonicalJson(withoutDigest));
    const complete = Object.freeze({ ...withoutDigest, semantic_digest: digest }) as CommandProcessingContract;
    const existing = this.get(contract.execution_attempt.attempt_id);
    if (existing) {
      if (existing.semantic_digest !== digest) {
        throw new CommandRuntimeContractError(
          `ExecutionAttempt '${contract.execution_attempt.attempt_id}' already has another processing contract`,
        );
      }
      return existing;
    }
    this.db.prepare(`
      INSERT INTO command_attempt_contracts (
        attempt_id, processing_contract_id, semantic_digest,
        command_definition_revision_id, command_worker_binding_id,
        contract_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      contract.execution_attempt.attempt_id,
      contract.processing_contract_id,
      digest,
      contract.command.definition.command_definition_revision_id,
      contract.worker.command_worker_binding_id,
      JSON.stringify(complete),
      this.now(),
    );
    return complete;
  }

  get(attemptId: string): CommandProcessingContract | null {
    const row = this.db.prepare(`
      SELECT contract_json, semantic_digest FROM command_attempt_contracts WHERE attempt_id = ?
    `).get(attemptId) as { contract_json: string; semantic_digest: string } | undefined;
    if (!row) return null;
    const contract = JSON.parse(row.contract_json) as CommandProcessingContract;
    const stored = contract.semantic_digest;
    const { semantic_digest: _discard, ...withoutDigest } = contract;
    if (stored !== row.semantic_digest || sha256(canonicalJson(withoutDigest)) !== row.semantic_digest) {
      throw new CommandRuntimeContractError(`Command processing contract for '${attemptId}' failed its digest check`);
    }
    return contract;
  }
}

export function resolveCommandImplementation(
  definition: CommandDefinitionRevision,
  workspaceId: string,
  extensions: ExtensionStore,
): ResolvedCommandImplementation {
  const ref = definition.content.implementation_ref;
  if (!ref.revision) {
    throw new CommandRuntimeContractError("the Command implementation reference is not exact");
  }
  if (ref.kind === "core_command_implementation") {
    if (!coreCommandImplementationAvailable({
      implementation_id: ref.id,
      implementation_revision: ref.revision,
      entry_point: definition.content.entry_point,
    })) {
      throw new CommandRuntimeContractError(
        `core Command implementation '${ref.id}@${ref.revision}' is not installed`,
      );
    }
    return {
      kind: "core_command_implementation",
      implementation_id: ref.id,
      implementation_revision: ref.revision,
      entry_point: definition.content.entry_point,
    };
  }
  if (ref.kind !== "extension_package_version") {
    throw new CommandRuntimeContractError(`unsupported Command implementation kind '${ref.kind}'`);
  }
  const packageVersion = extensions.getPackageVersion(ref.id);
  if (!packageVersion || packageVersion.workspace_id !== workspaceId
    || (ref.revision !== packageVersion.content_digest && ref.revision !== packageVersion.record_digest)) {
    throw new CommandRuntimeContractError(`Extension package '${ref.id}@${ref.revision}' is unavailable in this Workspace`);
  }
  const entryPoint = packageVersion.definition.entry_points.find((entry) =>
    entry.entry_point_id === definition.content.entry_point && entry.kind === "command"
  );
  if (!entryPoint) {
    throw new CommandRuntimeContractError(
      `Extension package '${ref.id}' has no Command entry point '${definition.content.entry_point}'`,
    );
  }
  const installation = extensions.getInstallationForExtension(packageVersion.extension_id);
  const active = installation?.lifecycle === "enabled"
    || (installation?.lifecycle === "rolled_back" && installation.deactivation_receipt_ref === null);
  if (!installation || installation.workspace_id !== workspaceId || !active
    || installation.installed_package_version_id !== packageVersion.extension_package_version_id
    || !installation.isolation_host_id) {
    throw new CommandRuntimeContractError(`Extension package '${ref.id}' is not active in this Workspace`);
  }
  return {
    kind: "extension_package_version",
    installation,
    package_version: packageVersion,
    entry_point_id: entryPoint.entry_point_id,
  };
}

/** Routes exact core and Extension implementations through isolated hosts. */
export class CanonicalCommandRuntimeHost implements CommandRuntimeHost {
  constructor(
    private readonly core: CommandRuntimeHost,
    private readonly extensions: ExtensionStore,
    private readonly extensionExecution: ExtensionEntryPointExecution,
  ) {}

  supports(input: CommandHostInvocation): boolean {
    return input.implementation.kind === "core_command_implementation"
      ? this.core.supports(input)
      : true;
  }

  async invoke(input: CommandHostInvocation): Promise<CommandHostResult> {
    if (input.implementation.kind === "core_command_implementation") {
      return this.core.invoke(input);
    }
    const exact = input.implementation;
    this.extensions.pinPackageForExecution({
      workspace_id: input.contract.workspace_id,
      execution_attempt_id: input.contract.execution_attempt.attempt_id,
      extension_installation_id: exact.installation.extension_installation_id,
      extension_package_version_id: exact.package_version.extension_package_version_id,
      invocation_id: input.contract.processing_contract_id,
    });
    const result = await this.extensionExecution.invoke({
      extension_installation_id: exact.installation.extension_installation_id,
      extension_package_version_id: exact.package_version.extension_package_version_id,
      entry_point_id: exact.entry_point_id,
      request: JSON.parse(JSON.stringify({ contract: input.contract })) as JsonValue,
      context: {
        workspace_id: input.contract.workspace_id,
        authorized_principal_id: input.contract.worker.worker_principal_id,
        operation_invocation_id: input.contract.processing_contract_id,
        extension_id: exact.package_version.extension_id,
        extension_package_version_id: exact.package_version.extension_package_version_id,
        entry_point_id: exact.entry_point_id,
        execution_attempt_id: input.contract.execution_attempt.attempt_id,
        capability_grant_ids: input.contract.operation_authority.capability_grant_ids,
      },
    });
    return result as unknown as CommandHostResult;
  }

  cancel(attemptId: string): boolean {
    return this.core.cancel(attemptId)
      || this.extensionExecution.cancelExecutionAttempt?.(attemptId) === true;
  }

  terminateAll(): void {
    this.core.terminateAll();
  }
}

function rowToWorker(row: any): CommandWorkerBindingRecord {
  return {
    command_worker_binding_id: String(row.command_worker_binding_id),
    workspace_id: String(row.workspace_id),
    host_id: String(row.host_id),
    worker_endpoint_id: String(row.worker_endpoint_id),
    worker_principal_id: String(row.worker_principal_id),
    status: String(row.status) as CommandWorkerBindingRecord["status"],
    supported_implementation_kinds: JSON.parse(String(row.supported_implementation_kinds_json)),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
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

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
