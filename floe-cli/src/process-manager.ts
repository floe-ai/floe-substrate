import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import type { LocalConfig } from "./config.js";
import { resolveLocalPath } from "./config.js";

export type ServiceName = "bus" | "bridge";

type ServiceRecord = {
  pid: number;
  started_at: string;
  command: string;
  args: string[];
  log_file: string;
};

type ServiceRecords = Partial<Record<ServiceName, ServiceRecord>>;

export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function recordsPath(configPath: string, config: LocalConfig): string {
  return join(resolveLocalPath(configPath, config.home, "."), "services.json");
}

export function readRecords(configPath: string, config: LocalConfig): ServiceRecords {
  const path = recordsPath(configPath, config);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as ServiceRecords;
}

export function writeRecords(configPath: string, config: LocalConfig, records: ServiceRecords): void {
  const path = recordsPath(configPath, config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(records, null, 2), "utf8");
}

export function serviceLogPath(configPath: string, config: LocalConfig, service: ServiceName): string {
  const dir = service === "bus"
    ? config.bus.log_dir
    : config.bridge.log_dir;
  return join(resolveLocalPath(configPath, config.home, dir), `${service}.log`);
}

export function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function npmCommand(): string {
  return "npm";
}

export function commandForNpm(args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command: "npm", args };
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", ["npm", ...args.map(quoteCmdArg)].join(" ")]
  };
}

function quoteCmdArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@\\-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

export async function startService(configPath: string, config: LocalConfig, service: ServiceName, extraEnv: Readonly<Record<string, string>> = {}): Promise<ServiceRecord> {
  const records = readRecords(configPath, config);
  const existing = records[service];
  if (existing && isPidRunning(existing.pid)) return existing;

  const root = repoRoot();
  const workspace = service === "bus" ? "floe-bus" : "floe-bridge";
  const args = ["run", "dev", "--workspace", workspace, "--", "--config", configPath];
  const commandLine = commandForNpm(args);
  const defaultLogFile = serviceLogPath(configPath, config, service);
  mkdirSync(dirname(defaultLogFile), { recursive: true });
  const { logFile, logFd } = openServiceLog(defaultLogFile, service);
  const child = spawn(commandLine.command, commandLine.args, {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    env: {
      ...process.env,
      FLOE_CONFIG: configPath,
      FLOE_BUS_HTTP_URL: config.bus.http_base_url,
      FLOE_BUS_WS_URL: config.bus.ws_base_url,
      ...(service === "bridge" && config.bridge.runtime_adapter
        ? { FLOE_RUNTIME_ADAPTER: config.bridge.runtime_adapter }
        : {}),
      ...extraEnv
    }
  });
  closeSync(logFd);
  child.unref();

  const record: ServiceRecord = {
    pid: child.pid ?? 0,
    started_at: new Date().toISOString(),
    command: commandLine.command,
    args: commandLine.args,
    log_file: logFile
  };
  records[service] = record;
  writeRecords(configPath, config, records);
  return record;
}

function openServiceLog(defaultLogFile: string, service: ServiceName): { logFile: string; logFd: number } {
  const marker = `\n[${new Date().toISOString()}] starting ${service}\n`;
  try {
    const fd = openSync(defaultLogFile, "a");
    writeSync(fd, marker);
    return { logFile: defaultLogFile, logFd: fd };
  } catch (error: any) {
    if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    const fallback = join(dirname(defaultLogFile), `${service}-${Date.now()}.log`);
    const fd = openSync(fallback, "a");
    writeSync(fd, marker);
    return { logFile: fallback, logFd: fd };
  }
}

export function stopService(configPath: string, config: LocalConfig, service: ServiceName): boolean {
  const records = readRecords(configPath, config);
  const record = records[service];
  if (!record) return false;
  let stopped = false;
  if (isPidRunning(record.pid)) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(record.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(-record.pid, "SIGTERM");
      }
      stopped = true;
    } catch {
      try {
        process.kill(record.pid);
        stopped = true;
      } catch {
        stopped = false;
      }
    }
  }
  delete records[service];
  writeRecords(configPath, config, records);
  return stopped;
}

export function clearRecords(configPath: string, config: LocalConfig): void {
  const path = recordsPath(configPath, config);
  if (existsSync(path)) unlinkSync(path);
}
