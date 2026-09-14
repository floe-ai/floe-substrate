import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";

import type {
  CommandHostInvocation,
  CommandHostResult,
  CommandRuntimeHost,
} from "./command-runtime.js";

type ActiveInvocation = {
  child: ChildProcess;
  reject: (error: CommandRuntimeHostError) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
};

export class CommandRuntimeHostError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CommandRuntimeHostError";
  }
}

/**
 * One fresh OS process per core Command attempt. The child has no filesystem,
 * network, child-process or secret permission and receives only canonical JSON.
 */
export class IsolatedCoreCommandProcessHost implements CommandRuntimeHost {
  private readonly active = new Map<string, ActiveInvocation>();

  constructor(private readonly scriptPath: string) {}

  supports(input: CommandHostInvocation): boolean {
    return input.definition.content.implementation_ref.kind === "core_command_implementation";
  }

  invoke(input: CommandHostInvocation): Promise<CommandHostResult> {
    const ref = input.definition.content.implementation_ref;
    if (ref.kind !== "core_command_implementation" || !ref.revision) {
      return Promise.reject(new CommandRuntimeHostError(
        "command_implementation_unavailable",
        "The Command does not reference an exact core implementation.",
      ));
    }
    const requestId = `command_host_request_${randomUUID()}`;
    const child = spawn(process.execPath, [
      "--permission",
      `--allow-fs-read=${dirname(this.scriptPath)}`,
      this.scriptPath,
    ], {
      cwd: undefined,
      env: minimalEnvironment(),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });

    return new Promise<CommandHostResult>((resolve, reject) => {
      const record: ActiveInvocation = {
        child,
        reject,
        settled: false,
        timer: setTimeout(() => {
          if (record.settled) return;
          record.settled = true;
          this.active.delete(input.contract.execution_attempt.attempt_id);
          child.kill();
          reject(new CommandRuntimeHostError("command_timeout", "The Command exceeded its declared timeout."));
        }, input.definition.content.timeout_ms),
      };
      this.active.set(input.contract.execution_attempt.attempt_id, record);
      let ready = false;
      const settle = (fn: () => void): void => {
        if (record.settled) return;
        record.settled = true;
        clearTimeout(record.timer);
        this.active.delete(input.contract.execution_attempt.attempt_id);
        child.kill();
        fn();
      };
      child.on("message", (raw: any) => {
        if (raw?.type === "ready" && raw.command_host_protocol === 1 && !ready) {
          ready = true;
          child.send({
            type: "invoke",
            request_id: requestId,
            implementation_id: ref.id,
            implementation_revision: ref.revision,
            entry_point: input.definition.content.entry_point,
            contract: input.contract,
          });
          return;
        }
        if (raw?.type !== "response" || raw.request_id !== requestId) return;
        if (raw.ok) {
          settle(() => resolve(raw.result as CommandHostResult));
        } else {
          settle(() => reject(new CommandRuntimeHostError(
            typeof raw.error?.code === "string" ? raw.error.code : "command_host_failed",
            typeof raw.error?.message === "string" ? raw.error.message : "The Command host failed.",
          )));
        }
      });
      child.once("error", (error) => settle(() => reject(new CommandRuntimeHostError(
        "command_host_unavailable",
        error.message,
      ))));
      child.once("exit", (code, signal) => {
        if (record.settled) return;
        settle(() => reject(new CommandRuntimeHostError(
          "command_worker_lost",
          `The isolated Command host stopped unexpectedly (${signal ?? code ?? "unknown"}).`,
        )));
      });
    });
  }

  cancel(attemptId: string): boolean {
    const active = this.active.get(attemptId);
    if (!active || active.settled) return false;
    active.settled = true;
    clearTimeout(active.timer);
    this.active.delete(attemptId);
    active.child.kill();
    active.reject(new CommandRuntimeHostError("command_cancelled", "The Command was cancelled."));
    return true;
  }

  terminateAll(): void {
    for (const attemptId of [...this.active.keys()]) this.cancel(attemptId);
  }
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of process.platform === "win32" ? ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"] : ["PATH", "TMPDIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
