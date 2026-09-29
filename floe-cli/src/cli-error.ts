/**
 * @invariant Cell: floe-cli.cli-process-manager
 * @invariant Module: floe-cli.cli-process-manager.main
 * @invariant Owns the terminal contract for failures that escape a Floe command.
 * @invariant Only the CLI entrypoint may turn an unhandled failure into terminal output.
 * @invariant Full failure detail is written to a Floe log before a summary is shown.
 * @invariant Stack traces reach the terminal only when explicit debug output is enabled.
 * @invariant Update this block in the same turn when the structural contract changes.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { resolveConfigPath, resolveLocalPath } from "./config.js";

type CliFailureOptions = Readonly<{
  argv: readonly string[];
  debug: boolean;
}>;

export type CliFailureReport = Readonly<{
  summary: string;
  nextAction: string;
  logFile: string;
  debugDetail: string | null;
}>;

export function reportCliFailure(error: unknown, options: CliFailureOptions): CliFailureReport {
  const configPath = configPathFromArgv(options.argv);
  const detail = fullErrorDetail(error);
  const logFile = writeFailureLog(configPath, detail);
  const { summary, nextAction } = explainFailure(error, configPath);
  return {
    summary,
    nextAction,
    logFile,
    debugDetail: options.debug ? detail : null,
  };
}

export function printCliFailure(report: CliFailureReport): void {
  console.error(report.summary);
  console.error(`Next: ${report.nextAction}`);
  console.error(`Full error details were saved to ${report.logFile}`);
  if (report.debugDetail) console.error(`\nDebug details:\n${report.debugDetail}`);
}

function configPathFromArgv(argv: readonly string[]): string {
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--config" && argv[index + 1]) return resolveConfigPath(argv[index + 1]);
    if (value.startsWith("--config=")) return resolveConfigPath(value.slice("--config=".length));
  }
  return resolveConfigPath();
}

function cliLogPath(configPath: string): string {
  try {
    const raw = YAML.parse(readFileSync(configPath, "utf8")) as { home?: unknown } | null;
    if (typeof raw?.home === "string") {
      return join(resolveLocalPath(configPath, raw.home, "."), "logs", "cli.log");
    }
  } catch {
    // A broken config still needs a predictable error log beside that config.
  }
  return join(dirname(configPath), "logs", "cli.log");
}

function writeFailureLog(configPath: string, detail: string): string {
  const preferred = cliLogPath(configPath);
  try {
    append(preferred, detail);
    return preferred;
  } catch (preferredError) {
    const fallback = join(tmpdir(), "floe-cli.log");
    append(fallback, `${detail}\n\nCLI log fallback reason:\n${fullErrorDetail(preferredError)}`);
    return fallback;
  }
}

function append(path: string, detail: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `\n[${new Date().toISOString()}] Floe command failed\n${detail}\n`, "utf8");
}

function explainFailure(error: unknown, configPath: string): { summary: string; nextAction: string } {
  const record = asRecord(error);
  const detail = fullErrorDetail(error);

  if (record.code === "E_FOREIGN_BUS") {
    return {
      summary: "Floe could not start because another Floe bus is already using its configured address.",
      nextAction: "Stop the stale Floe process, or choose a different bus address in the config, then try again.",
    };
  }
  if (hasCode(error, "EADDRINUSE")) {
    return {
      summary: "Floe could not start because its configured address is already in use.",
      nextAction: "Stop the program using that address, or choose a different address in the config, then try again.",
    };
  }
  if (record.name === "ChannelUnavailableError" && record.reason === "not_running") {
    return {
      summary: "Floe could not complete this command because the required local service is not running.",
      nextAction: "Start Floe through the normal app or service for this machine, then try again.",
    };
  }
  if (
    record.name === "YAMLParseError"
    || detail.includes(`Floe config at ${configPath}`)
    || detail.includes("Implicit keys need to be on a single line")
  ) {
    return {
      summary: "Floe could not read its config file.",
      nextAction: `Fix or replace ${configPath}, then try again.`,
    };
  }

  const message = error instanceof Error ? error.message.trim().split(/\r?\n/, 1)[0] : "";
  const safeMessage = message && message.length <= 240 && !/\b(?:at |E[A-Z]{3,}|node:|file:)/.test(message)
    ? `: ${message}`
    : " because an internal error occurred.";
  return {
    summary: `Floe could not complete this command${safeMessage}`,
    nextAction: "Try again. If it still fails, use the log below to diagnose the problem.",
  };
}

function hasCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record.code === code) return true;
    current = record.cause;
  }
  return fullErrorDetail(error).includes(code);
}

function fullErrorDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    parts.push(current.stack ?? `${current.name}: ${current.message}`);
    current = current.cause;
    if (current instanceof Error) parts.push("Caused by:");
  }
  return parts.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
