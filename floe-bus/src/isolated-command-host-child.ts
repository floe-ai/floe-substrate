import type { CommandProcessingContract, CommandHostResult } from "./command-runtime.js";

type InvokeMessage = Readonly<{
  type: "invoke";
  request_id: string;
  implementation_id: string;
  implementation_revision: string;
  entry_point: string;
  contract: CommandProcessingContract;
}>;

/**
 * Trusted, versioned core implementations. The child receives no source code,
 * shell text, filesystem path, environment credential, or downstream target.
 */
const CORE_IMPLEMENTATIONS: Readonly<Record<string, Readonly<{
  revision: string;
  entry_point: string;
  run(contract: CommandProcessingContract): CommandHostResult;
}>>> = Object.freeze({
  "core.command.echo": Object.freeze({
    revision: "1",
    entry_point: "echo",
    run(contract: CommandProcessingContract) {
      const output = contract.outputs.ports[0];
      if (!output) return { outputs: {}, resource_use: { "command.invocation": 1 } };
      return {
        outputs: {
          [output.name]: [{
            value: contract.arguments,
            content: { input: contract.arguments },
            artefact_version_ids: [],
          }],
        },
        resource_use: { "command.invocation": 1 },
      };
    },
  }),
});

export function coreCommandImplementationAvailable(input: Readonly<{
  implementation_id: string;
  implementation_revision: string;
  entry_point: string;
}>): boolean {
  const implementation = CORE_IMPLEMENTATIONS[input.implementation_id];
  return Boolean(implementation
    && implementation.revision === input.implementation_revision
    && implementation.entry_point === input.entry_point);
}

export function runIsolatedCommandHostChild(): void {
  if (typeof process.send !== "function") {
    throw new Error("The isolated Command host requires an authenticated parent IPC channel.");
  }
  process.send({ type: "ready", command_host_protocol: 1 });
  process.on("message", (raw: unknown) => {
    const message = raw as Partial<InvokeMessage>;
    if (message.type !== "invoke" || typeof message.request_id !== "string") return;
    try {
      if (typeof message.implementation_id !== "string"
        || typeof message.implementation_revision !== "string"
        || typeof message.entry_point !== "string"
        || !message.contract) {
        throw commandHostError("command_host_request_invalid", "The Command host request is incomplete.");
      }
      const implementation = CORE_IMPLEMENTATIONS[message.implementation_id];
      if (!implementation
        || implementation.revision !== message.implementation_revision
        || implementation.entry_point !== message.entry_point) {
        throw commandHostError(
          "command_implementation_unavailable",
          "The exact core Command implementation is not installed in this host.",
        );
      }
      const result = implementation.run(message.contract as CommandProcessingContract);
      process.send?.({ type: "response", request_id: message.request_id, ok: true, result });
    } catch (error) {
      process.send?.({
        type: "response",
        request_id: message.request_id,
        ok: false,
        error: {
          code: typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : "command_host_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });
}

function commandHostError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
