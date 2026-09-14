/**
 * Floe workspace tool — run_command
 *
 * Executes a shell command in the workspace directory.
 * Platform-aware: uses cmd.exe on Windows, /bin/bash on Unix.
 * Workspace-cwd (runs in workspace root but NOT path-contained).
 * Environment is sanitised to strip Floe-managed secrets.
 * Output is bounded (2000 lines / 50KB, tail-truncated).
 *
 * Key design decisions:
 * - Bash is cwd-scoped, NOT strictly contained (unlike file tools)
 * - Agent can specify an optional timeout
 * - Output includes both stdout and stderr (interleaved)
 * - Exit code is always returned
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import { sanitiseEnvironment } from "./env-sanitise.js";
import { truncateOutput } from "./truncation.js";
import type { ToolContext } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_TIMEOUT_MS = 600_000; // 10 minutes
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;

type ShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  outputLimited: boolean;
};

function terminateProcessTree(child: ChildProcess, isWindows: boolean): void {
  if (isWindows && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.unref();
    return;
  }
  child.kill("SIGTERM");
}

/** Run without blocking the bridge/bus event loop, so live progress can still flow. */
function runShellCommand(input: {
  shell: string;
  shellArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  isWindows: boolean;
}): Promise<ShellResult> {
  return new Promise(resolve => {
    const child = spawn(input.shell, input.shellArgs, {
      cwd: input.cwd,
      env: input.env,
      windowsHide: true,
      // Match Node's cmd.exe shell invocation: preserve the complete command
      // instead of escaping its nested quotes as ordinary argv strings.
      windowsVerbatimArguments: input.isWindows,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let outputLimited = false;
    let settled = false;

    const capture = (target: Buffer[], chunk: Buffer): void => {
      const remaining = MAX_CAPTURE_BYTES - capturedBytes;
      if (remaining <= 0) {
        if (!outputLimited) {
          outputLimited = true;
          terminateProcessTree(child, input.isWindows);
        }
        return;
      }
      const kept = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      target.push(kept);
      capturedBytes += kept.byteLength;
      if (kept.byteLength < chunk.byteLength && !outputLimited) {
        outputLimited = true;
        terminateProcessTree(child, input.isWindows);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, input.isWindows);
    }, input.timeoutMs);

    const finish = (exitCode: number, spawnError?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (spawnError) stderr.push(Buffer.from(spawnError.message));
      resolve({
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
        exitCode,
        timedOut,
        outputLimited,
      });
    };

    child.once("error", error => finish(1, error));
    child.once("close", code => finish(code ?? 1));
  });
}

export function createBashTool(ctx: ToolContext): AgentTool {
  const isWindowsHost = platform() === "win32";
  const shellLabel = isWindowsHost ? "Windows Command Prompt (cmd.exe)" : "Bash (/bin/bash)";
  return {
    name: "run_command",
    label: "Run Command",
    description:
      `Execute a command in the workspace directory using ${shellLabel}. ` +
      (isWindowsHost
        ? "This is not Bash: use Windows cmd.exe syntax and commands. "
        : "Use Bash syntax and commands. ") +
      "Returns stdout+stderr and exit code. " +
      "Optional timeout in seconds (default 120, max 600). " +
      "Environment is sanitised — Floe auth tokens and API keys are stripped. " +
      "The command runs with the workspace root as the working directory.",
    parameters: Type.Object({
      command: Type.String({ description: `Command to execute with ${shellLabel}` }),
      timeout: Type.Optional(
        Type.Number({ description: "Timeout in seconds (default 120, max 600)" })
      ),
    }),
    execute: async (toolCallId, params: any) => {
      const startTime = Date.now();
      const command = String(params?.command ?? "");
      const timeoutSec = params?.timeout != null ? Number(params.timeout) : undefined;

      if (!command.trim()) {
        enrichToolActivity(ctx, toolCallId, "run_command — no command provided", true, [], startTime);
        return { content: [{ type: "text", text: "Error: command is required." }], details: { ok: false } };
      }

      const timeoutMs = timeoutSec != null
        ? Math.min(Math.max(Math.round(timeoutSec * 1000), 1000), MAX_TIMEOUT_MS)
        : DEFAULT_TIMEOUT_MS;

      const env = sanitiseEnvironment();
      const isWindows = isWindowsHost;
      const shell = isWindows ? "cmd.exe" : "/bin/bash";
      const shellArgs = isWindows ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command];

      const proc = await runShellCommand({
        shell,
        shellArgs,
        cwd: ctx.workspaceRoot,
        env,
        timeoutMs,
        isWindows,
      });

      const output = (proc.stdout + (proc.stderr ? "\n" + proc.stderr : "")).trimEnd();
      const exitCode = proc.exitCode;
      const timedOut = proc.timedOut;

      const truncated = truncateOutput(output);
      const durationMs = Date.now() - startTime;

      const commandPreview = command.length > 60 ? command.slice(0, 57) + "..." : command;
      const statusLabel = timedOut
        ? "timeout"
        : proc.outputLimited
          ? "output limit"
          : exitCode === 0 ? "ok" : `exit ${exitCode}`;
      const summary = `run_command [${shell}]: ${commandPreview} (${statusLabel}, ${durationMs}ms)`;
      enrichToolActivity(ctx, toolCallId, summary, exitCode !== 0 || timedOut || proc.outputLimited, [], startTime);

      const header = timedOut
        ? `Shell: ${shell}\nCommand timed out after ${Math.round(timeoutMs / 1000)}s (exit code ${exitCode})`
        : proc.outputLimited
          ? `Shell: ${shell}\nCommand exceeded the ${Math.round(MAX_CAPTURE_BYTES / 1024 / 1024)}MB output limit (exit code ${exitCode})`
        : `Shell: ${shell}\nExit code: ${exitCode}`;
      const responseText = truncated.truncated
        ? `${header}\n[output truncated: ${truncated.original_lines} lines → ${truncated.text.split("\n").length} lines]\n\n${truncated.text}`
        : `${header}\n\n${truncated.text}`;

      return {
        content: [{ type: "text", text: responseText }],
        details: {
          ok: exitCode === 0 && !timedOut && !proc.outputLimited,
          exit_code: exitCode,
          timed_out: timedOut,
          output_limited: proc.outputLimited,
          shell,
          duration_ms: durationMs,
          truncated: truncated.truncated,
        },
      };
    },
  };
}

function enrichToolActivity(
  ctx: ToolContext,
  toolCallId: string,
  summary: string,
  isError: boolean,
  filesTouched: string[],
  startTime: number
): void {
  const turn = ctx.getActiveTurn?.();
  if (!turn) return;
  const entry = turn.tool_activity.find((t) => t.call_id === toolCallId);
  if (entry) {
    entry.summary = summary;
    entry.is_error = isError;
    entry.files_touched = filesTouched;
    entry.duration_ms = Date.now() - startTime;
  }
}
