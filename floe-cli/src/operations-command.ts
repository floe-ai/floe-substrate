import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Command } from "commander";

import { CliRequestError } from "./cli-error.js";
import {
  CliOperationClient,
  selectLocalWorkspace,
  type CliOperationBoundary,
  type CliOperationDescriptor,
  type OperationConfirmation,
  type OperationTarget,
} from "./operation-client.js";

type CommonOptions = {
  host?: boolean;
  workspace?: string;
  query?: string;
  category?: string;
  targetKind?: string;
  targetId?: string;
  json?: boolean;
};

type InvokeOptions = CommonOptions & {
  input: string;
  idempotencyKey?: string;
  expectedRevision?: string;
};

export type OperationsCommandDependencies = Readonly<{
  cwd?: () => string;
  client: () => CliOperationClient;
  confirm?: (confirmation: OperationConfirmation) => Promise<boolean>;
  output?: (message: string) => void;
  error_output?: (message: string) => void;
  read_file?: (path: string) => string;
}>;

export function registerOperationsCommand(
  program: Command,
  dependencies: OperationsCommandDependencies,
): void {
  const operations = program
    .command("operations")
    .description("Discover and use Floe's canonical semantic operations");

  addCommonOptions(operations
    .command("list")
    .description("List operations allowed by the current Floe authority"))
    .option("--query <text>", "find operations by outcome or name")
    .option("--category <category>", "limit operations to one Bus category")
    .option("--json", "print the exact Bus descriptor projection")
    .action(async (options: CommonOptions) => {
      const client = createClient(dependencies);
      const boundary = await resolveBoundary(client, options, dependencies);
      const target = parseTarget(options);
      const descriptors = await client.discover({
        boundary,
        query: options.query,
        category: options.category,
        target,
      });
      write(dependencies, options.json
        ? JSON.stringify({ operations: descriptors }, null, 2)
        : formatOperationList(descriptors));
    });

  addCommonOptions(operations
    .command("describe")
    .argument("<operation-id>", "exact semantic operation id")
    .description("Show one live Bus-owned operation contract"))
    .action(async (operationId: string, options: CommonOptions) => {
      const client = createClient(dependencies);
      const boundary = await resolveBoundary(client, options, dependencies);
      const descriptor = await client.describe(boundary, operationId, parseTarget(options));
      write(dependencies, JSON.stringify(descriptor, null, 2));
    });

  addCommonOptions(operations
    .command("invoke")
    .argument("<operation-id>", "exact semantic operation id")
    .description("Invoke one discovered operation using JSON intent"))
    .requiredOption("--input <json-or-@file>", "JSON operation intent, or @path to a JSON file")
    .option("--idempotency-key <key>", "stable key so a retry of a write is safe to replay; reads do not need one")
    .option("--expected-revision <revision>", "expected target revision for compare-and-swap")
    .action(async (operationId: string, options: InvokeOptions) => {
      // The caller's own input is checked before Floe is contacted at all.
      const input = parseJsonIntent(options.input, dependencies.read_file);
      const target = parseTarget(options);
      const client = createClient(dependencies);
      const boundary = await resolveBoundary(client, options, dependencies);
      const result = await client.invokeSelected({
        boundary,
        operation_id: operationId,
        input,
        ...(options.idempotencyKey !== undefined
          ? { idempotency_key: options.idempotencyKey }
          : {}),
        target,
        ...(options.expectedRevision !== undefined
          ? { expected_resource_revision: options.expectedRevision }
          : {}),
        confirm: dependencies.confirm ?? confirmInTerminal,
      });
      write(dependencies, JSON.stringify(result, null, 2));
      const failure = invocationFailure(result);
      if (failure) {
        (dependencies.error_output ?? console.error)(failure);
        process.exitCode = 1;
      }
    });
}

/**
 * The receipt is always printed in full; a refused or unsettled invocation
 * also fails the command, so a script never mistakes it for success.
 */
export function invocationFailure(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  const receipt = record.receipt && typeof record.receipt === "object"
    ? record.receipt as Record<string, unknown>
    : null;
  const refusal = (record.kind === "rejected" ? record.refusal : receipt?.refusal) as
    | Record<string, unknown>
    | null
    | undefined;
  const reason = typeof refusal?.message === "string" ? ` ${refusal.message}` : "";
  if (record.kind === "rejected" || receipt?.state === "refused") {
    return `Floe refused the operation.${reason}`;
  }
  if (receipt?.state === "outcome_unknown") {
    return `Floe could not confirm the operation's outcome.${reason}`;
  }
  return null;
}

function addCommonOptions(command: Command): Command {
  return command
    .option("--workspace <workspace-id>", "use an exact attached Workspace identity")
    .option("--host", "use local host authority instead of a Workspace")
    .option("--target-kind <kind>", "target resource kind from the discovered contract")
    .option("--target-id <id>", "target resource identity from the discovered contract");
}

async function resolveBoundary(
  client: CliOperationClient,
  options: CommonOptions,
  dependencies: OperationsCommandDependencies,
): Promise<CliOperationBoundary> {
  if (options.host) {
    if (options.workspace) throw new CliRequestError("Use either --host or --workspace, not both.");
    return { kind: "host" };
  }
  const workspaces = await client.listLocalWorkspaces();
  const workspace = selectLocalWorkspace(
    workspaces,
    options.workspace,
    dependencies.cwd?.() ?? process.cwd(),
  );
  return { kind: "workspace", workspace_id: workspace.workspace_id };
}

export function parseTarget(options: Pick<CommonOptions, "targetKind" | "targetId">): OperationTarget | null {
  if (Boolean(options.targetKind) !== Boolean(options.targetId)) {
    throw new CliRequestError("--target-kind and --target-id must be supplied together.");
  }
  return options.targetKind && options.targetId
    ? { kind: options.targetKind, id: options.targetId }
    : null;
}

export function parseJsonIntent(
  value: string,
  readFile: ((path: string) => string) | undefined = (path) => readFileSync(path, "utf8"),
): unknown {
  const source = value.startsWith("@")
    ? readInputFile(value.slice(1), readFile)
    : value;
  if (!source.trim()) throw new CliRequestError("Operation input must contain JSON intent.");
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new CliRequestError(
      `Operation input is not valid JSON: ${(error as Error).message}`,
      "Pass valid JSON to --input, or put it in a file and pass --input @path.",
    );
  }
}

function readInputFile(path: string, readFile: (path: string) => string): string {
  try {
    return readFile(path);
  } catch {
    throw new CliRequestError(
      `Operation input file '${path}' could not be read.`,
      "Check the path after @, then run the command again.",
    );
  }
}

export function formatOperationList(descriptors: readonly CliOperationDescriptor[]): string {
  if (descriptors.length === 0) return "No matching semantic operations are available.";
  return descriptors.map((descriptor) => {
    const effect = typeof descriptor.effects.mode === "string" ? descriptor.effects.mode : "unknown";
    const availability = descriptor.availability.available
      ? "available"
      : refusalMessage(descriptor.availability.refusal);
    return `${descriptor.operation_id} | ${descriptor.category} | ${effect} | ${availability}\n  ${descriptor.title}`;
  }).join("\n");
}

export async function confirmInTerminal(confirmation: OperationConfirmation): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`\n${confirmation.title}\n${confirmation.description}\n`);
    const answer = (await rl.question("Continue? [y/N] ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function createClient(dependencies: OperationsCommandDependencies): CliOperationClient {
  return dependencies.client();
}

function write(dependencies: OperationsCommandDependencies, message: string): void {
  (dependencies.output ?? console.log)(message);
}

function refusalMessage(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === "string" && message) return `unavailable: ${message}`;
  }
  return "unavailable";
}
