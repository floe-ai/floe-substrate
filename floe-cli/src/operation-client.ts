import { isAbsolute, relative, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type OperationTarget = Readonly<{ kind: string; id: string }>;

export type CliOperationBoundary =
  | Readonly<{ kind: "host" }>
  | Readonly<{ kind: "workspace"; workspace_id: string }>;

export type OperationConfirmation = Readonly<{
  required: boolean;
  prompt_id: string;
  title: string;
  description: string;
}>;

/** A client projection of the Bus-owned descriptor, not a second definition. */
export type CliOperationDescriptor = Readonly<{
  operation_id: string;
  operation_version: string;
  category: string;
  title: string;
  description: string;
  effects: Readonly<Record<string, unknown>>;
  target: Readonly<Record<string, unknown>>;
  input: Readonly<{ version: string; schema: Readonly<Record<string, unknown>> }>;
  result: Readonly<{ version: string; schema: Readonly<Record<string, unknown>> }>;
  interaction_constraints: Readonly<{
    confirmation?: OperationConfirmation;
    [key: string]: unknown;
  }>;
  availability: Readonly<{
    available: boolean;
    refusal?: unknown;
  }>;
  [key: string]: unknown;
}>;

export type LocalWorkspaceProjection = Readonly<{
  workspace_id: string;
  name: string;
  binding: Readonly<{
    locator: string;
    normalized_locator?: string;
    state?: string;
  }> | null;
}>;

export type CliProviderAccount = Readonly<{
  provider_id: string;
  secret_ref_id: string;
  connected: boolean;
  generation: number;
}>;

export type DiscoverOperationsInput = Readonly<{
  boundary: CliOperationBoundary;
  query?: string;
  category?: string;
  target?: OperationTarget | null;
}>;

export type InvokeSelectedOperationInput = Readonly<{
  boundary: CliOperationBoundary;
  operation_id: string;
  input: unknown;
  idempotency_key: string;
  target?: OperationTarget | null;
  expected_resource_revision?: string | null;
  confirm?: (confirmation: OperationConfirmation) => Promise<boolean>;
}>;

export type CliOperationInvocation = Readonly<{
  operation_id: string;
  operation_version: string;
  input_schema_version: string;
  target: OperationTarget | null;
  expected_resource_revision?: string | null;
  idempotency_key: string;
  input: unknown;
}>;

/**
 * Trusted local transport supplied by the native authority broker. It exposes
 * only operation discovery/invocation, never reusable host or Workspace
 * bearer material and never a raw endpoint console.
 */
export interface CliOperationAuthorityBroker {
  listLocalWorkspaces(): Promise<unknown>;
  discoverOperations(input: DiscoverOperationsInput): Promise<unknown>;
  invokeOperation(input: Readonly<{
    boundary: CliOperationBoundary;
    invocation: CliOperationInvocation;
  }>): Promise<unknown>;
  confirmAndInvokeHostOperation(input: Readonly<{
    interaction_session_id: string;
    invocation: CliOperationInvocation;
  }>): Promise<unknown>;
  confirmAndInvokeWorkspaceOperation(input: Readonly<{
    workspace_id: string;
    interaction_session_id: string;
    invocation: CliOperationInvocation;
  }>): Promise<unknown>;
}

export class CliAuthorityBrokerUnavailableError extends Error {
  constructor() {
    super(
      "Floe CLI cannot open a trusted local operation session: the native "
      + "authority broker binary was not found. Build it with "
      + "`npm run build --workspace floe-cli` (requires Rust/cargo), which "
      + "compiles floe-native-authority and installs the broker into "
      + "floe-cli/native/.",
    );
    this.name = "CliAuthorityBrokerUnavailableError";
  }
}

export class UnavailableCliOperationAuthorityBroker implements CliOperationAuthorityBroker {
  listLocalWorkspaces(): Promise<never> { return Promise.reject(new CliAuthorityBrokerUnavailableError()); }
  discoverOperations(): Promise<never> { return Promise.reject(new CliAuthorityBrokerUnavailableError()); }
  invokeOperation(): Promise<never> { return Promise.reject(new CliAuthorityBrokerUnavailableError()); }
  confirmAndInvokeHostOperation(): Promise<never> {
    return Promise.reject(new CliAuthorityBrokerUnavailableError());
  }
  confirmAndInvokeWorkspaceOperation(): Promise<never> {
    return Promise.reject(new CliAuthorityBrokerUnavailableError());
  }
}

export type NativeAuthorityCommandRunner = (
  command: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

/**
 * CLI adapter over the same one-shot native authority broker packaged with the
 * desktop. The helper opens the OS vault and returns only semantic operation
 * projections/results; reusable host and Workspace credentials never enter
 * this process.
 */
export class NativeCliOperationAuthorityBroker implements CliOperationAuthorityBroker {
  constructor(private readonly run: NativeAuthorityCommandRunner = runNativeAuthorityCommand) {}

  listLocalWorkspaces(): Promise<unknown> {
    return this.run({ command: "list_local_workspaces" });
  }

  async listProviderAccounts(): Promise<CliProviderAccount[]> {
    const result = await this.run({ command: "list_provider_accounts" });
    if (!Array.isArray(result)) throw new Error("Floe returned an invalid provider account list.");
    return result.map(parseProviderAccount);
  }

  async connectProviderAccount(providerId: string): Promise<CliProviderAccount> {
    const result = await this.run({
      command: "connect_provider_account",
      provider_id: requireText(providerId, "provider id"),
    });
    return parseProviderAccount(result);
  }

  discoverOperations(input: DiscoverOperationsInput): Promise<unknown> {
    return this.run({
      command: "discover_operations",
      boundary: input.boundary,
      ...(input.query ? { query: input.query } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(input.target ? { target: input.target } : {}),
    });
  }

  invokeOperation(input: Readonly<{
    boundary: CliOperationBoundary;
    invocation: CliOperationInvocation;
  }>): Promise<unknown> {
    return this.run({ command: "invoke_operation", ...input });
  }

  confirmAndInvokeHostOperation(input: Readonly<{
    interaction_session_id: string;
    invocation: CliOperationInvocation;
  }>): Promise<unknown> {
    return this.run({ command: "confirm_and_invoke_host_operation", ...input });
  }

  confirmAndInvokeWorkspaceOperation(input: Readonly<{
    workspace_id: string;
    interaction_session_id: string;
    invocation: CliOperationInvocation;
  }>): Promise<unknown> {
    return this.run({ command: "confirm_and_invoke_workspace_operation", ...input });
  }
}

/**
 * CLI projection over the same Bus-owned semantic operations used by the app
 * and Actors. A native broker owns authentication and sessions; this client
 * handles only discovered descriptors and invocation intent.
 */
export class CliOperationClient {
  private readonly interactionSessionId: string;

  constructor(
    private readonly broker: CliOperationAuthorityBroker = new NativeCliOperationAuthorityBroker(),
    interactionSessionId?: string,
  ) {
    this.interactionSessionId = interactionSessionId
      ?? `cli_${randomBytes(18).toString("base64url")}`;
  }

  async listLocalWorkspaces(): Promise<LocalWorkspaceProjection[]> {
    const response = await this.broker.listLocalWorkspaces();
    if (!isRecord(response) || !Array.isArray(response.workspaces)) {
      throw new Error("Floe returned an invalid local Workspace list.");
    }
    return response.workspaces.map(parseLocalWorkspace);
  }

  async discover(input: DiscoverOperationsInput): Promise<CliOperationDescriptor[]> {
    const response = await this.broker.discoverOperations(input);
    if (!isRecord(response) || !Array.isArray(response.operations)) {
      throw new Error("Floe returned an invalid semantic operation catalogue.");
    }
    return response.operations.map(parseOperationDescriptor);
  }

  async describe(
    boundary: CliOperationBoundary,
    operationId: string,
    target?: OperationTarget | null,
  ): Promise<CliOperationDescriptor> {
    const descriptors = await this.discover({ boundary, query: operationId, target });
    const descriptor = descriptors.find((candidate) => candidate.operation_id === operationId);
    if (!descriptor) throw new Error(`Semantic operation '${operationId}' is not available in this authority boundary.`);
    return descriptor;
  }

  async invokeSelected(input: InvokeSelectedOperationInput): Promise<unknown> {
    const descriptor = await this.describe(input.boundary, input.operation_id, input.target);
    const invocation: CliOperationInvocation = {
      operation_id: descriptor.operation_id,
      operation_version: descriptor.operation_version,
      input_schema_version: descriptor.input.version,
      target: input.target ?? null,
      idempotency_key: requireText(input.idempotency_key, "idempotency key"),
      input: input.input,
      ...(input.expected_resource_revision !== undefined
        ? { expected_resource_revision: input.expected_resource_revision }
        : {}),
    };

    const confirmation = descriptor.interaction_constraints.confirmation;
    if (confirmation?.required) {
      if (!input.confirm || !await input.confirm(confirmation)) {
        return {
          kind: "cancelled",
          operation_id: descriptor.operation_id,
          prompt_id: confirmation.prompt_id,
        };
      }
      return input.boundary.kind === "workspace"
        ? this.broker.confirmAndInvokeWorkspaceOperation({
            workspace_id: input.boundary.workspace_id,
            interaction_session_id: this.interactionSessionId,
            invocation,
          })
        : this.broker.confirmAndInvokeHostOperation({
            interaction_session_id: this.interactionSessionId,
            invocation,
          });
    }

    return this.broker.invokeOperation({
      boundary: input.boundary,
      invocation,
    });
  }
}

async function runNativeAuthorityCommand(command: Readonly<Record<string, unknown>>): Promise<unknown> {
  const helper = resolveNativeAuthorityBrokerPath();
  if (!helper) throw new CliAuthorityBrokerUnavailableError();
  const payload = JSON.stringify(command);
  return new Promise((resolveResult, reject) => {
    const child = spawn(helper, [], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error("Floe's native authority broker did not respond."));
      }
    }, 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 2 * 1024 * 1024) {
        child.kill();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.once("error", () => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(new CliAuthorityBrokerUnavailableError());
      }
    });
    child.once("close", () => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (bytes > 2 * 1024 * 1024) {
        reject(new Error("Floe's native authority response was invalid."));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        if (!isRecord(parsed) || typeof parsed.ok !== "boolean") throw new Error();
        if (!parsed.ok) {
          const message = isRecord(parsed.error) && typeof parsed.error.message === "string"
            ? parsed.error.message
            : "Floe's native authority broker refused the request.";
          reject(new Error(message));
          return;
        }
        resolveResult(parsed.result);
      } catch {
        reject(new Error("Floe's native authority response was invalid."));
      }
    });
    child.stdin.end(payload, "utf8");
  });
}

/**
 * Obtain the Bus host-control credential from the native broker so the CLI can
 * boot the Bus as the trusted native owner the Bus requires at startup.
 *
 * The broker is the sole owner of this credential in the OS keyring. The
 * returned value must be injected into the Bus process environment only and
 * must never be logged, echoed into an error, or written to disk.
 */
export async function fetchHostControlToken(): Promise<string> {
  const result = await runNativeAuthorityCommand({ command: "provide_host_control_token" });
  if (!isRecord(result) || typeof result.token !== "string" || !result.token) {
    throw new Error("Floe's native authority broker did not provide a host-control credential.");
  }
  return result.token;
}

/**
 * Register the current directory as a local Workspace and select it, through
 * the native broker. Registration is a host-control bootstrap route, so the CLI
 * authenticates through the broker rather than an unauthenticated HTTP call.
 */
export async function registerLocalWorkspaceViaBroker(
  locator: string,
  initAuthorized: boolean,
): Promise<{ workspace_id: string; name: string }> {
  const result = await runNativeAuthorityCommand({
    command: "register_workspace",
    locator,
    init_authorized: initAuthorized,
  });
  if (
    !isRecord(result)
    || !isRecord(result.workspace)
    || typeof result.workspace.workspace_id !== "string"
    || typeof result.workspace.name !== "string"
  ) {
    throw new Error("Floe returned an invalid Workspace registration.");
  }
  return { workspace_id: result.workspace.workspace_id, name: result.workspace.name };
}

function resolveNativeAuthorityBrokerPath(): string | null {
  const executable = process.platform === "win32" ? "floe-authority-broker.exe" : "floe-authority-broker";
  const configured = process.env.FLOE_AUTHORITY_BROKER_PATH?.trim();
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    configured,
    resolve(moduleDirectory, "..", "native", executable),
    resolve(dirname(process.execPath), executable),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function selectLocalWorkspace(
  workspaces: readonly LocalWorkspaceProjection[],
  explicitWorkspaceId: string | undefined,
  cwd = process.cwd(),
): LocalWorkspaceProjection {
  if (explicitWorkspaceId) {
    const exact = workspaces.find((workspace) => workspace.workspace_id === explicitWorkspaceId);
    if (!exact) throw new Error(`Workspace '${explicitWorkspaceId}' is not attached to this Floe host.`);
    return exact;
  }

  const resolvedCwd = resolve(cwd);
  const matches = workspaces.filter((workspace) => {
    if (!workspace.binding || workspace.binding.state === "superseded") return false;
    const resolvedLocator = resolve(workspace.binding.locator);
    const rel = relative(resolvedLocator, resolvedCwd);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }).sort((left, right) =>
    resolve(right.binding!.locator).length - resolve(left.binding!.locator).length);
  if (matches.length > 0) return matches[0]!;
  throw new Error("No attached Workspace contains the current directory. Use --workspace <workspace-id>.");
}

function parseLocalWorkspace(value: unknown): LocalWorkspaceProjection {
  if (!isRecord(value) || typeof value.workspace_id !== "string" || typeof value.name !== "string") {
    throw new Error("Floe returned an invalid local Workspace list.");
  }
  let binding: LocalWorkspaceProjection["binding"] = null;
  // The native broker returns /v1/local/workspaces' local record projection.
  // Locator and binding identity are top-level fields in that wire contract.
  if (value.binding_id !== null) {
    if (typeof value.binding_id !== "string" || !value.binding_id
      || typeof value.locator !== "string" || !value.locator) {
      throw new Error("Floe returned an invalid local Workspace binding.");
    }
    binding = { locator: value.locator };
  } else if (value.locator !== null) {
    throw new Error("Floe returned a locator without a current local Workspace binding.");
  }
  return { workspace_id: value.workspace_id, name: value.name, binding };
}

function parseProviderAccount(value: unknown): CliProviderAccount {
  if (
    !isRecord(value)
    || typeof value.provider_id !== "string"
    || typeof value.secret_ref_id !== "string"
    || typeof value.connected !== "boolean"
    || typeof value.generation !== "number"
    || !Number.isInteger(value.generation)
  ) {
    throw new Error("Floe returned an invalid provider account status.");
  }
  return {
    provider_id: value.provider_id,
    secret_ref_id: value.secret_ref_id,
    connected: value.connected,
    generation: value.generation,
  };
}

function parseOperationDescriptor(value: unknown): CliOperationDescriptor {
  if (
    !isRecord(value)
    || typeof value.operation_id !== "string"
    || typeof value.operation_version !== "string"
    || typeof value.category !== "string"
    || typeof value.title !== "string"
    || typeof value.description !== "string"
    || !isRecord(value.effects)
    || !isRecord(value.target)
    || !isVersionedSchema(value.input)
    || !isVersionedSchema(value.result)
    || !isRecord(value.interaction_constraints)
    || !isRecord(value.availability)
    || typeof value.availability.available !== "boolean"
  ) {
    throw new Error("Floe returned an invalid semantic operation descriptor.");
  }
  const confirmation = value.interaction_constraints.confirmation;
  if (confirmation !== undefined && !isOperationConfirmation(confirmation)) {
    throw new Error("Floe returned an invalid semantic operation confirmation.");
  }
  return value as CliOperationDescriptor;
}

function isVersionedSchema(value: unknown): value is { version: string; schema: Record<string, unknown> } {
  return isRecord(value) && typeof value.version === "string" && isRecord(value.schema);
}

function isOperationConfirmation(value: unknown): value is OperationConfirmation {
  return isRecord(value)
    && typeof value.required === "boolean"
    && typeof value.prompt_id === "string"
    && typeof value.title === "string"
    && typeof value.description === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value: string, label: string): string {
  if (!value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`The ${label} is invalid.`);
  return value;
}
