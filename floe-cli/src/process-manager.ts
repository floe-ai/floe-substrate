import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import type { LocalConfig } from "./config.js";
import { resolveLocalPath } from "./config.js";
import { readRunFile, runFilePath } from "./identity/protocol.js";
import { thisInstallation } from "./installation.js";
import { ensureStage, isNpmInstalled, pruneStages } from "./staging.js";
import { isPidRunning } from "./process-identity.js";
import { recordedServiceOwnership } from "./service-ownership.js";

export type ServiceName = "bus" | "bridge" | "identity";

/** Start order; stop in reverse. */
export const SERVICE_NAMES: readonly ServiceName[] = ["bus", "bridge", "identity"];

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
    : service === "bridge"
      ? config.bridge.log_dir
      : "./logs/identity";
  return join(resolveLocalPath(configPath, config.home, dir), `${service}.log`);
}

export { isPidRunning } from "./process-identity.js";

export function serviceEntry(service: ServiceName): string {
  if (service === "identity") {
    // The identity agent ships inside the CLI package itself. CLI source run
    // directly in a checkout (tsx, vitest) uses the built agent beside it.
    const here = dirname(fileURLToPath(import.meta.url));
    const entry = join(here, "identity", "agent-main.js");
    const built = resolve(here, "..", "dist", "identity", "agent-main.js");
    if (existsSync(entry)) return entry;
    if (existsSync(built)) return built;
    throw new Error(
      `Floe cannot find its identity agent at ${entry}. The install is incomplete. In a dev ` +
        `checkout, run \`npm run build --workspace floe-cli\`; a released install already includes it.`
    );
  }
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
  if (existing) {
    const ownership = await recordedServiceOwnership(configPath, config, service, existing);
    if (ownership === "answering") return existing;
    // Floe's own process, alive but not serving: replace it rather than run two.
    // A pid that is no longer provably Floe's is left alone and simply forgotten.
    if (ownership === "silent") killProcessTree(existing.pid);
  }

  const entry = await runnableEntry(configPath, config, records, serviceEntry(service));
  const command = process.execPath;
  const args = [entry, "daemon", "--config", configPath, ...(service === "bus" && instanceId ? ["--instance-id", instanceId] : [])];
  const defaultLogFile = serviceLogPath(configPath, config, service);
  mkdirSync(dirname(defaultLogFile), { recursive: true });
  const { logFile, logFd } = openServiceLog(defaultLogFile, service);
  const child = spawn(command, args, {
    cwd: dirname(entry),
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    // Services read everything from the config named by --config. The only
    // values passed through the environment are per-start secrets (extraEnv),
    // which must not appear on a command line.
    env: {
      ...process.env,
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

/**
 * Where a service actually runs from. An npm-installed copy runs its services
 * from a stage under the Floe home, so npm can replace the package while they
 * run (see staging.ts); a checkout runs in place. Stages that no live service
 * runs from are removed here, so they never pile up.
 */
async function runnableEntry(configPath: string, config: LocalConfig, records: ServiceRecords, entry: string): Promise<string> {
  const installation = thisInstallation();
  if (!isNpmInstalled(installation.packageDir)) return entry;
  const home = resolveLocalPath(configPath, config.home, ".");
  const stage = await ensureStage(home, installation);
  const inUse = Object.values(records)
    .filter((record): record is ServiceRecord => Boolean(record && isPidRunning(record.pid)))
    .map((record) => record.args[0] ?? "");
  pruneStages(home, stage.dir, inUse);
  return stage.map(entry);
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

/**
 * Stop a service only if its recorded process is provably the one Floe started
 * (service-ownership.ts). A pid now held by an unrelated program is never
 * killed; its stale record is simply removed.
 */
export async function stopService(configPath: string, config: LocalConfig, service: ServiceName): Promise<boolean> {
  const records = readRecords(configPath, config);
  const record = records[service];
  if (!record) return false;
  const ownership = await recordedServiceOwnership(configPath, config, service, record);
  const stopped = ownership !== "not_ours" && killProcessTree(record.pid);
  const current = readRecords(configPath, config);
  delete current[service];
  writeRecords(configPath, config, current);
  if (service === "identity") {
    // A forced stop skips the agent's own cleanup; its run file would point at a dead agent.
    const home = resolveLocalPath(configPath, config.home, ".");
    if (readRunFile(home)?.pid === record.pid) rmSync(runFilePath(home), { force: true });
  }
  return stopped;
}

function killProcessTree(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      return spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }).status === 0;
    }
    process.kill(-pid, "SIGTERM");
    return true;
  } catch {
    try {
      process.kill(pid);
      return true;
    } catch {
      return false;
    }
  }
}

export function clearRecords(configPath: string, config: LocalConfig): void {
  const path = recordsPath(configPath, config);
  if (existsSync(path)) unlinkSync(path);
}
