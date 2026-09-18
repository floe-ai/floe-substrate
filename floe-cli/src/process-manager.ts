import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
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
  /** Identity of this exact process, echoed by the bus at /health (bus only). */
  instance_id?: string;
};

type ServiceRecords = Partial<Record<ServiceName, ServiceRecord>>;

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

export function serviceEntry(service: ServiceName): string {
  const pkg = service === "bus" ? "floe-bus" : "floe-bridge";
  const require = createRequire(import.meta.url);
  // Layout 1 — sibling package: a dev workspace, or a global install that placed
  // floe-bus/floe-bridge as real node_modules packages beside floe-cli. Resolve
  // them by name so npm's own resolution finds the installed version.
  try {
    return require.resolve(`${pkg}/dist/index.js`);
  } catch {
    // Layout 2 — single-package artifact: the release bundles all three service
    // packages as sibling subdirectories of one installed package, so the bus and
    // bridge are not node_modules packages. floe-cli's own module lives at
    // <root>/floe-cli/dist/*, so the bus/bridge dist sits at <root>/floe-<name>/dist.
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const artifactRoot = resolve(moduleDirectory, "..", "..");
    const bundled = join(artifactRoot, pkg, "dist", "index.js");
    if (existsSync(bundled)) return bundled;
    throw new Error(
      `Floe cannot find the ${pkg} service. Its built entry (${pkg}/dist/index.js) is not ` +
        `resolvable from the floe CLI, and no bundled copy was found at ${bundled}. This means ` +
        `the install is incomplete: ${pkg} must ship with the CLI. In a dev checkout, run ` +
        `\`npm install\` then \`npm run build\`; a released install already bundles the bus and ` +
        `bridge alongside the CLI.`
    );
  }
}

export async function startService(configPath: string, config: LocalConfig, service: ServiceName, extraEnv: Readonly<Record<string, string>> = {}, instanceId?: string): Promise<ServiceRecord> {
  const records = readRecords(configPath, config);
  const existing = records[service];
  if (existing && isPidRunning(existing.pid)) return existing;

  const entry = serviceEntry(service);
  const command = process.execPath;
  const args = [entry, "daemon", "--config", configPath];
  const defaultLogFile = serviceLogPath(configPath, config, service);
  mkdirSync(dirname(defaultLogFile), { recursive: true });
  const { logFile, logFd } = openServiceLog(defaultLogFile, service);
  const child = spawn(command, args, {
    cwd: dirname(entry),
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    env: {
      ...process.env,
      FLOE_CONFIG: configPath,
      FLOE_BUS_HTTP_URL: config.bus.http_base_url,
      FLOE_BUS_WS_URL: config.bus.ws_base_url,
      ...(service === "bus" && instanceId ? { FLOE_BUS_INSTANCE_ID: instanceId } : {}),
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
    command,
    args,
    log_file: logFile,
    ...(service === "bus" && instanceId ? { instance_id: instanceId } : {})
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
