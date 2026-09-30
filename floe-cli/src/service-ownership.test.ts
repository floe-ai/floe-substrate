import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { defaultConfig, type LocalConfig } from "./config.js";
import { describeProcess, isPidRunning } from "./process-identity.js";
import { readRecords, stopService, writeRecords } from "./process-manager.js";
import { operatingSystemConfirms, recordedServiceOwnership } from "./service-ownership.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const step of cleanup.splice(0).reverse()) step(); });

function unrelatedProcess(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
  cleanup.push(() => { if (child.pid && isPidRunning(child.pid)) child.kill(); });
  return child;
}

function isolatedConfig(): { configPath: string; config: LocalConfig } {
  const home = mkdtempSync(join(tmpdir(), "floe-ownership-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const config = defaultConfig();
  config.home = home;
  // Nothing answers here, so only the operating system can prove a record.
  config.bus.http_base_url = "http://127.0.0.1:1";
  const configPath = join(home, "config.yaml");
  writeFileSync(configPath, YAML.stringify(config), "utf8");
  return { configPath, config };
}

describe("a recorded pid is trusted only if it is provably Floe's process", () => {
  it("reads a live process's start time and command line from the operating system", () => {
    const described = describeProcess(process.pid);
    expect(described?.command_line).toContain(process.execPath);
    expect(described!.started_at!.getTime()).toBeLessThanOrEqual(Date.now());
  }, 30_000);

  it("confirms the process a record names, with its recorded command and start", async () => {
    const child = unrelatedProcess();
    const record = { pid: child.pid!, started_at: new Date().toISOString(), command: process.execPath, args: ["-e", "setInterval(() => {}, 60000)"] };
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(operatingSystemConfirms(record)).toBe(true);
  }, 30_000);

  it("treats a reused pid as not running, and floe stop never kills it", async () => {
    // The incident: after a reboot, the Bridge's recorded pid belonged to an unrelated program.
    const unrelated = unrelatedProcess();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { configPath, config } = isolatedConfig();
    writeRecords(configPath, config, {
      bridge: {
        pid: unrelated.pid!,
        started_at: "2026-09-30T00:25:58.349Z",
        command: process.execPath,
        args: ["C:\\old\\floe-bridge\\dist\\index.js", "daemon", "--config", configPath],
        log_file: join(config.home, "bridge.log"),
      },
    });
    const record = readRecords(configPath, config).bridge!;
    expect(await recordedServiceOwnership(configPath, config, "bridge", record)).toBe("not_ours");
    expect(await stopService(configPath, config, "bridge")).toBe(false);
    expect(isPidRunning(unrelated.pid!)).toBe(true);
    expect(readRecords(configPath, config).bridge).toBeUndefined();
  }, 30_000);
});
