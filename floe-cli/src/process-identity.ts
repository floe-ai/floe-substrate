/**
 * What the operating system says a pid currently is. A pid alone names a
 * process only until it exits: Windows and Unix both reuse pids, so a recorded
 * pid that "exists" may now be an unrelated program. Callers prove a recorded
 * process is still the one they started with its start time and command line.
 */
import { spawnSync } from "node:child_process";

export type ProcessDescription = {
  /** When the operating system says this process started; null if it does not say. */
  started_at: Date | null;
  command_line: string;
};

/** Whether any process holds this pid. Says nothing about which process it is. */
export function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The start time and command line of the process holding `pid`, or null if none can be read. */
export function describeProcess(pid: number): ProcessDescription | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return process.platform === "win32" ? describeWindowsProcess(pid) : describePosixProcess(pid);
}

function describeWindowsProcess(pid: number): ProcessDescription | null {
  const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; `
    + "if ($p) { [pscustomobject]@{ started = if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') } else { $null }; "
    + "command_line = $p.CommandLine } | ConvertTo-Json -Compress }";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });
  const text = (result.stdout ?? "").trim();
  if (result.status !== 0 || !text) return null;
  try {
    const parsed = JSON.parse(text) as { started?: string | null; command_line?: string | null };
    if (typeof parsed.command_line !== "string") return null;
    return { started_at: parsed.started ? new Date(parsed.started) : null, command_line: parsed.command_line };
  } catch {
    return null;
  }
}

function describePosixProcess(pid: number): ProcessDescription | null {
  // lstart is a fixed-width local time ("Wed Sep 30 16:11:36 2026") on Linux and macOS.
  const result = spawnSync("ps", ["-o", "lstart=", "-o", "args=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    timeout: 20_000,
  });
  const line = (result.stdout ?? "").split("\n").find((item) => item.trim() !== "");
  if (result.status !== 0 || !line) return null;
  const started = new Date(line.slice(0, 24).trim());
  return {
    started_at: Number.isNaN(started.getTime()) ? null : started,
    command_line: line.slice(24).trim(),
  };
}
