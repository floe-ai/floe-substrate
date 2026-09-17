/**
 * service — installing Floe so the machine starts it, not a person.
 *
 * Floe's start-on-demand policy (services.start_on_demand) decides whether a
 * client may start the substrate on demand. That is a desktop convenience and
 * is deliberately wrong for a managed deployment, where the substrate is owned
 * by the machine and a client quietly starting its own copy is a correctness
 * problem. So the honest answer, when a person keeps hitting "not running", is
 * to have the machine start Floe for them — a real platform auto-start
 * mechanism.
 *
 * This module owns that install. It is honest about reach: only Windows is
 * built and proven here. Linux (systemd) and macOS (launchd) are designed —
 * the command exists and reports plainly that they are not yet implemented —
 * rather than writing an unproven unit or plist and reporting a false success.
 *
 * The Windows mechanism is a per-user logon Scheduled Task that runs the Floe
 * CLI directly (node + this CLI's own entry, never through a package-manager
 * wrapper). It needs no administrator rights. A machine-wide service that runs
 * before any logon is a separate, elevation-requiring concern and is not built
 * here; we do not fake it.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How the running CLI re-invokes itself unattended. `command` is the node
 *  binary; `prefixArgs` are the args that reproduce "run this CLI" — the node
 *  exec args (e.g. `--import tsx` when run from source) followed by the entry
 *  script; `workingDirectory` is where it runs, so bare module specifiers (the
 *  entry's imports and any `--import` loader) resolve against node_modules. */
export interface CliInvocation {
  command: string;
  prefixArgs: string[];
  workingDirectory: string;
}

/** The default Windows Scheduled Task name. Overridable so tests use a throwaway. */
export const WINDOWS_TASK_NAME = "FloeSubstrate";

export interface ServiceStatus {
  platform: NodeJS.Platform;
  /** Is an auto-start mechanism actually built for this platform? */
  supported: boolean;
  /** Is Floe currently installed to auto-start? */
  installed: boolean;
  detail: string;
}

export interface ServiceResult {
  ok: boolean;
  message: string;
}

export function serviceStatus(taskName: string = WINDOWS_TASK_NAME): ServiceStatus {
  if (process.platform !== "win32") {
    return {
      platform: process.platform,
      supported: false,
      installed: false,
      detail: `Auto-start is not built for ${process.platform} yet — only Windows is implemented.`,
    };
  }
  const installed = windowsTaskExists(taskName);
  return {
    platform: "win32",
    supported: true,
    installed,
    detail: installed
      ? `Installed: scheduled task '${taskName}' starts Floe when you log in.`
      : "Not installed. Floe will not start automatically.",
  };
}

export function installService(
  configPath: string,
  cli: CliInvocation,
  taskName: string = WINDOWS_TASK_NAME,
): ServiceResult {
  if (process.platform !== "win32") {
    return {
      ok: false,
      message:
        `Auto-start is not built for ${process.platform} yet. On Windows, Floe installs a per-user logon `
        + "task. A systemd unit (Linux) and a launchd agent (macOS) are designed but not yet implemented, "
        + "so nothing was installed rather than reporting a service that does not exist.",
    };
  }
  return installWindows(configPath, cli, taskName);
}

export function uninstallService(taskName: string = WINDOWS_TASK_NAME): ServiceResult {
  if (process.platform !== "win32") {
    return { ok: false, message: `Nothing to uninstall on ${process.platform} — auto-start is not built there.` };
  }
  if (!windowsTaskExists(taskName)) {
    return { ok: true, message: `Auto-start was not installed (no scheduled task '${taskName}').` };
  }
  try {
    execFileSync("schtasks", ["/Delete", "/TN", taskName, "/F"], { stdio: "ignore" });
    return { ok: true, message: `Removed auto-start (scheduled task '${taskName}').` };
  } catch (error) {
    return { ok: false, message: `Could not remove scheduled task '${taskName}': ${errorText(error)}` };
  }
}

function windowsTaskExists(taskName: string): boolean {
  try {
    execFileSync("schtasks", ["/Query", "/TN", taskName], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function installWindows(configPath: string, cli: CliInvocation, taskName: string): ServiceResult {
  const user = process.env.USERNAME;
  if (!user) {
    return { ok: false, message: "Could not determine the current Windows account (USERNAME is not set)." };
  }
  const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
  const argv = [...cli.prefixArgs, "--config", configPath, "start"];
  const argumentLine = argv.map(quoteArg).join(" ");
  const xml = buildWindowsTaskXml(account, cli.command, argumentLine, cli.workingDirectory);

  const dir = mkdtempSync(join(tmpdir(), "floe-service-"));
  const xmlPath = join(dir, "task.xml");
  try {
    // Task Scheduler requires UTF-16; write a BOM + UTF-16LE body.
    writeFileSync(xmlPath, `\uFEFF${xml}`, "utf16le");
    execFileSync("schtasks", ["/Create", "/TN", taskName, "/XML", xmlPath, "/F"], { stdio: "ignore" });
    return {
      ok: true,
      message: `Installed. Floe will start automatically when you log in (scheduled task '${taskName}').`,
    };
  } catch (error) {
    return { ok: false, message: `Could not create scheduled task '${taskName}': ${errorText(error)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A per-user logon task that runs the CLI directly, in its own directory so
 * bare module specifiers resolve. LeastPrivilege + InteractiveToken means it
 * needs no administrator rights; it runs as the logged-in person, exactly as
 * if they had typed `floe start` themselves.
 */
export function buildWindowsTaskXml(
  account: string,
  command: string,
  argumentLine: string,
  workingDirectory: string,
): string {
  const a = xmlEscape(account);
  return [
    `<?xml version="1.0" encoding="UTF-16"?>`,
    `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
    `  <RegistrationInfo>`,
    `    <Description>Start the Floe substrate when the user logs in.</Description>`,
    `  </RegistrationInfo>`,
    `  <Triggers>`,
    `    <LogonTrigger><Enabled>true</Enabled><UserId>${a}</UserId></LogonTrigger>`,
    `  </Triggers>`,
    `  <Principals>`,
    `    <Principal id="Author">`,
    `      <UserId>${a}</UserId>`,
    `      <LogonType>InteractiveToken</LogonType>`,
    `      <RunLevel>LeastPrivilege</RunLevel>`,
    `    </Principal>`,
    `  </Principals>`,
    `  <Settings>`,
    `    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`,
    `    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`,
    `    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`,
    `    <StartWhenAvailable>true</StartWhenAvailable>`,
    `    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`,
    `  </Settings>`,
    `  <Actions Context="Author">`,
    `    <Exec>`,
    `      <Command>${xmlEscape(command)}</Command>`,
    `      <Arguments>${xmlEscape(argumentLine)}</Arguments>`,
    `      <WorkingDirectory>${xmlEscape(workingDirectory)}</WorkingDirectory>`,
    `    </Exec>`,
    `  </Actions>`,
    `</Task>`,
  ].join("\n");
}

function quoteArg(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
