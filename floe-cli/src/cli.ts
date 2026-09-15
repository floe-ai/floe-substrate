import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";
import { Command } from "commander";
import { ensureConfig, resolveLocalPath, saveConfig, type LocalConfig } from "./config.js";
import { buildResetPlan, executeReset } from "./reset.js";
import { seedDefaultActor } from "./actor-seed.js";
import {
  clearRecords,
  isPidRunning,
  readRecords,
  serviceLogPath,
  stopService,
  type ServiceName
} from "./process-manager.js";
import { registerOperationsCommand } from "./operations-command.js";
import { registerIdentityCommand } from "./identity-command.js";
import { registerLocalWorkspaceViaBroker, fetchHostControlToken } from "./operation-client.js";
import { startAll, waitForHealth, isHealthy } from "./startup.js";

const program = new Command();

program
  .name("floe")
  .description("Launch and manage the local Floe substrate")
  .option("--config <path>", "config path");

program
  .command("setup")
  .description("Create config, optionally enable autostart, start services, and verify health")
  .option("--yes", "accept setup defaults")
  .option("--no-autostart", "do not enable user-level autostart")
  .option("--repair", "reconcile local service records")
  .action(async (options) => {
    const { configPath, config, created } = ensureConfig(program.opts().config);
    if (options.repair) clearRecords(configPath, config);
    if (created || options.yes || options.autostart === false) {
      await applyAutostartChoice(configPath, config, options);
    }
    await startAll(configPath, config);
    await verifyHealth(config);
    const currentWorkspace = findAncestorWithFloe(process.cwd());
    if (currentWorkspace) {
      await registerCurrentWorkspace(config, currentWorkspace, true);
    }
    console.log(`Floe services are running: ${config.bus.http_base_url}`);
  });

program
  .command("status")
  .description("Show service health and configured URLs")
  .action(async () => {
    const { configPath, config } = ensureConfig(program.opts().config);
    await printStatus(configPath, config);
  });

program.command("start").description("Start local Floe services").action(async () => {
  const { configPath, config } = ensureConfig(program.opts().config);
  await startAll(configPath, config);
  console.log("Started Floe services.");
});

program.command("stop").description("Stop local Floe services").action(async () => {
  const { configPath, config } = ensureConfig(program.opts().config);
  for (const service of ["bridge", "bus"] as ServiceName[]) stopService(configPath, config, service);
  console.log("Stopped Floe services.");
});

program.command("restart").description("Restart local Floe services").action(async () => {
  const { configPath, config } = ensureConfig(program.opts().config);
  for (const service of ["bridge", "bus"] as ServiceName[]) stopService(configPath, config, service);
  await startAll(configPath, config);
  console.log("Restarted Floe services.");
});

program
  .command("logs")
  .argument("[service]", "bus or bridge")
  .description("Print service logs")
  .action((service?: ServiceName) => {
    const { configPath, config } = ensureConfig(program.opts().config);
    const services = service ? [service] : ["bus", "bridge"] as ServiceName[];
    for (const item of services) {
      const path = serviceLogPath(configPath, config, item);
      console.log(`\n== ${item}: ${path} ==`);
      console.log(existsSync(path) ? tail(readFileSync(path, "utf8"), 200) : "(no log file)");
    }
  });
program.command("doctor").description("Diagnose local Floe setup").action(async () => {
  const { configPath, config } = ensureConfig(program.opts().config);
  await printStatus(configPath, config);
  console.log(`Config: ${configPath}`);
  console.log(`Home: ${resolveLocalPath(configPath, config.home, ".")}`);
});

const configCommand = program.command("config").description("Inspect local config");
configCommand.command("path").description("Print active config path").action(() => {
  const { configPath } = ensureConfig(program.opts().config);
  console.log(configPath);
});
configCommand.command("edit").description("Open config in EDITOR or print path").action(() => {
  const { configPath } = ensureConfig(program.opts().config);
  const editor = process.env.EDITOR || process.env.VISUAL;
  if (!editor) {
    console.log(configPath);
    return;
  }
  spawn(editor, [configPath], { stdio: "inherit", shell: true });
});

const autostart = program.command("autostart").description("Manage user-level autostart");
autostart.command("on").description("Enable user-level autostart").action(() => {
  const { configPath, config } = ensureConfig(program.opts().config);
  config.services.autostart = true;
  saveConfig(configPath, config);
  installAutostart(configPath);
  console.log("Autostart enabled.");
});
autostart.command("off").description("Disable user-level autostart").action(() => {
  const { configPath, config } = ensureConfig(program.opts().config);
  config.services.autostart = false;
  saveConfig(configPath, config);
  uninstallAutostart();
  console.log("Autostart disabled.");
});

program.command("uninstall").description("Remove autostart entries and stop services; preserve ~/.floe data").action(async () => {
  const { configPath, config } = ensureConfig(program.opts().config);
  for (const service of ["bridge", "bus"] as ServiceName[]) stopService(configPath, config, service);
  uninstallAutostart();
  console.log("Removed Floe service entries. Local data is preserved.");
});

program
  .command("reset")
  .description("Factory reset: wipe all Floe state (workspaces, contexts, boards, agents) while preserving provider credentials and service config")
  .option("--yes", "skip confirmation prompt")
  .action(async (options) => {
    const { configPath, config } = ensureConfig(program.opts().config);

    // Stop running services before wiping their databases
    for (const service of ["bridge", "bus"] as ServiceName[]) stopService(configPath, config, service);

    const plan = buildResetPlan(configPath, config);

    console.log("\nFloe Factory Reset");
    console.log("==================");
    console.log("\nWILL WIPE:");
    for (const target of plan.wipe) {
      console.log(`  - ${target.label}`);
      console.log(`    ${target.path}`);
    }
    console.log("\nWILL PRESERVE:");
    for (const target of plan.preserve) {
      console.log(`  + ${target.label}`);
      console.log(`    ${target.path}`);
    }
    console.log("");

    if (!options.yes) {
      const rl = createInterface({ input, output });
      try {
        const answer = (await rl.question("This is destructive and cannot be undone. Continue? [y/N] ")).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          console.log("Reset cancelled.");
          process.exit(0);
        }
      } finally {
        rl.close();
      }
    }

    executeReset(configPath, config);
    console.log("\nReset complete. Run \`floe setup\` or \`floe start\` to start fresh.");
  });

registerOperationsCommand(program, {});
registerIdentityCommand(program, {});

program.action(async () => {
  const { configPath, config, created } = ensureConfig(program.opts().config);
  if (created) {
    await applyAutostartChoice(configPath, config, { yes: false, autostart: undefined });
  }
  await startAll(configPath, config);
  await verifyHealth(config);
  const currentWorkspace = findAncestorWithFloe(process.cwd());
  if (currentWorkspace) {
    await registerCurrentWorkspace(config, currentWorkspace, true);
  }
  console.log(`Floe services are running: ${config.bus.http_base_url}`);
});

await program.parseAsync(normalizeLegacyCommandArgs(process.argv));

async function applyAutostartChoice(configPath: string, config: LocalConfig, options: any): Promise<void> {
  let enable = options.autostart !== false;
  if (!options.yes && options.autostart !== false) {
    const rl = createInterface({ input, output });
    const answer = await rl.question("Start Floe automatically when you log in? (recommended) [Y/n] ");
    rl.close();
    enable = !answer.trim().toLowerCase().startsWith("n");
  }
  config.services.autostart = enable;
  saveConfig(configPath, config);
  if (enable) installAutostart(configPath);
  else uninstallAutostart();
}

async function verifyHealth(config: LocalConfig): Promise<void> {
  await waitForHealth(config.bus.http_base_url, "floe-bus");
}

async function printStatus(configPath: string, config: LocalConfig): Promise<void> {
  const records = readRecords(configPath, config);
  for (const service of ["bus", "bridge"] as ServiceName[]) {
    const record = records[service];
    const running = record ? isPidRunning(record.pid) : false;
    console.log(`${service}: ${running ? "running" : "not running"}${record ? ` pid=${record.pid}` : ""}`);
  }
  console.log(`bus: ${config.bus.http_base_url} ${await isHealthy(config.bus.http_base_url) ? "healthy" : "unreachable"}`);
}

async function registerCurrentWorkspace(config: LocalConfig, locator: string, initAuthorized: boolean): Promise<void> {
  // Registration and selection are host-control bootstrap routes. The broker
  // owns the host-control credential, so the CLI registers through it rather
  // than an unauthenticated HTTP call.
  const { workspace_id: workspaceId } = await registerLocalWorkspaceViaBroker(locator, initAuthorized, config.bus.http_base_url);
  // Seed a default human operator actor if none exists yet. Seeding a
  // self-owned actor is a native-host-owner capability, so authorize it with
  // the broker-owned host-control credential — the same trust path registration
  // uses. Stored bus-DB-only (no workspace file written) so git status stays clean.
  const hostControlToken = await fetchHostControlToken(config.bus.http_base_url);
  const seedResult = await seedDefaultActor(config.bus.http_base_url, workspaceId, hostControlToken);
  if (seedResult.seeded) {
    console.log(`Seeded default actor: ${seedResult.endpoint_id}`);
  }
}

function findAncestorWithFloe(start: string): string | null {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".floe"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function installAutostart(configPath: string): void {
  if (process.platform !== "win32") {
    const marker = join(dirname(configPath), "autostart.json");
    writeFileSync(marker, JSON.stringify({ enabled: true, note: "Autostart installation is implemented for Windows first." }, null, 2), "utf8");
    return;
  }
  const startupDir = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  mkdirSync(startupDir, { recursive: true });
  const script = join(startupDir, "floe.cmd");
  writeFileSync(script, `@echo off\r\ncd /d "${process.cwd()}"\r\nnpm run floe -- --config "${configPath}" start\r\n`, "utf8");
}

function uninstallAutostart(): void {
  if (process.platform !== "win32") return;
  const script = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "floe.cmd");
  if (existsSync(script)) rmSync(script);
}

function tail(text: string, lines: number): string {
  const parts = text.split(/\r?\n/);
  return parts.slice(Math.max(0, parts.length - lines)).join("\n");
}

function normalizeLegacyCommandArgs(argv: string[]): string[] {
  const map: Record<string, string> = {
    "--start": "start",
    "--stop": "stop",
    "--status": "status",
    "--doctor": "doctor",
    "--restart": "restart",
    "--open": "open",
    "--setup": "setup",
    "--logs": "logs",
    "--uninstall": "uninstall"
  };
  let commandInjected = false;
  const normalized = [...argv.slice(0, 2)];
  for (const token of argv.slice(2)) {
    if (!commandInjected && map[token]) {
      normalized.push(map[token]);
      commandInjected = true;
      continue;
    }
    normalized.push(token);
  }
  return normalized;
}
