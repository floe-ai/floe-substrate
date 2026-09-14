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
  createAuthRuntime,
  findProfile,
  getAuthStatusLabel,
  listProviderOptions,
  removeProfile,
  saveProfiles,
  suggestProfileId,
  type ProfilesDocument,
  upsertProfile,
  validateProfileId
} from "./auth.js";
import {
  clearRecords,
  isPidRunning,
  readRecords,
  serviceLogPath,
  startService,
  stopService,
  type ServiceName
} from "./process-manager.js";
import { registerOperationsCommand } from "./operations-command.js";
import { confirmInTerminal } from "./operations-command.js";
import { NativeCliOperationAuthorityBroker } from "./operation-client.js";
import { fetchHostControlToken, registerLocalWorkspaceViaBroker } from "./operation-client.js";
import { disconnectProviderAccount } from "./provider-account-command.js";

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

program
  .command("login")
  .description("Connect a provider account through Floe's protected local broker")
  .requiredOption("--provider <provider>", "subscription provider id")
  .action(async (options) => {
    const { configPath, config } = ensureConfig(program.opts().config);
    const providerId = String(options.provider ?? "").trim();
    if (!providerId) throw new Error("Provider id is required.");
    const account = await new NativeCliOperationAuthorityBroker().connectProviderAccount(providerId);
    if (!account.connected) throw new Error("Floe did not confirm the provider account connection.");
    if (config.bridge.runtime_adapter !== "pi-agent-core") {
      config.bridge.runtime_adapter = "pi-agent-core";
      saveConfig(configPath, config);
      console.log("Runtime adapter: pi-agent-core");
    }
    console.log(`Connected provider '${account.provider_id}' using protected Windows credential storage.`);
  });

const authCommand = program.command("auth").description("Inspect Floe provider accounts");
authCommand.command("list").description("List connected Floe provider accounts").action(async () => {
  const accounts = await new NativeCliOperationAuthorityBroker().listProviderAccounts();
  if (accounts.length === 0) {
    console.log("No Floe provider accounts are configured.");
    return;
  }
  for (const account of accounts) {
    console.log(`${account.provider_id} | ${account.connected ? "connected" : "missing"}`);
  }
});

authCommand.command("doctor").description("Validate Floe auth/profile setup").action(async () => {
  const accounts = await new NativeCliOperationAuthorityBroker().listProviderAccounts();
  const missing = accounts.filter((account) => !account.connected);
  if (accounts.length > 0 && missing.length === 0) {
    console.log("Provider account health: OK");
    return;
  }
  if (accounts.length === 0) console.log("Provider account health: no accounts configured");
  for (const account of missing) console.log(`Provider '${account.provider_id}' is not connected.`);
  process.exitCode = 1;
});

program
  .command("logout")
  .argument("<provider>", "provider id")
  .description("Disconnect a Floe provider account")
  .action(async (provider: string) => {
    const result = await disconnectProviderAccount(provider, { confirm: confirmInTerminal });
    if (result.kind === "cancelled") {
      console.log("Provider account left connected.");
      return;
    }
    if (result.kind === "already_disconnected") {
      console.log(`Provider '${result.account.provider_id}' is already disconnected.`);
      return;
    }
    console.log(`Disconnected provider '${result.account.provider_id}'.`);
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

async function resolveProviderOption(
  options: Array<{ id: string; name: string; auth_type: "oauth" | "api_key" }>,
  providerFlag?: string
): Promise<{ id: string; name: string; auth_type: "oauth" | "api_key" }> {
  if (providerFlag) {
    const explicit = options.find((option) => option.id === providerFlag);
    if (!explicit) {
      throw new Error(`Unknown provider '${providerFlag}'. Run 'floe auth list' and 'floe auth doctor' for details.`);
    }
    return explicit;
  }

  const rl = createInterface({ input, output });
  try {
    console.log("Select provider:");
    for (const [index, option] of options.entries()) {
      console.log(`  ${index + 1}. ${option.name} (${option.id}, ${option.auth_type})`);
    }
    const answer = (await rl.question(`Enter number (1-${options.length}): `)).trim();
    const parsed = Number(answer);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > options.length) {
      throw new Error("Invalid provider selection.");
    }
    return options[parsed - 1];
  } finally {
    rl.close();
  }
}

async function resolveProfileId(profiles: ProfilesDocument, provider: string, profileFlag?: string): Promise<string> {
  if (profileFlag) return validateProfileId(profileFlag);
  const suggested = suggestProfileId(profiles, provider);
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`Profile id [${suggested}]: `)).trim();
    return validateProfileId(answer || suggested);
  } finally {
    rl.close();
  }
}

async function loginWithOAuth(runtime: ReturnType<typeof createAuthRuntime>, providerId: string, providerName: string): Promise<void> {
  const rl = createInterface({ input, output });
  try {
    await runtime.authStorage.login(providerId, {
      notify: (event) => {
        if (event.type === "auth_url") {
          console.log(`Open this URL to authenticate ${providerName}:`);
          console.log(event.url);
          if (event.instructions) console.log(event.instructions);
          openUrl(event.url);
        } else if (event.type === "device_code") {
          console.log(`Device code: ${event.userCode}`);
          console.log(`Verify at: ${event.verificationUri}`);
          openUrl(event.verificationUri);
        } else if (event.type === "progress" || event.type === "info") {
          console.log(event.message);
        }
      },
      prompt: async (prompt) => {
        if (prompt.type === "select") {
          console.log(prompt.message);
          prompt.options.forEach((option, index) => console.log(`  ${index + 1}. ${option.label}`));
          const answer = (await rl.question("Select option number: ")).trim();
          const selected = prompt.options[parseInt(answer, 10) - 1];
          if (!selected) throw new Error("Invalid selection");
          return selected.id;
        }
        const hint = prompt.placeholder ? ` (${prompt.placeholder})` : "";
        return rl.question(`${prompt.message}${hint}: `);
      },
    });
  } finally {
    rl.close();
  }
}

async function resolveApiKey(apiKeyEnv?: string): Promise<string> {
  if (apiKeyEnv) {
    const value = process.env[apiKeyEnv];
    if (!value) throw new Error(`Environment variable '${apiKeyEnv}' is not set.`);
    if (!value.trim()) throw new Error(`Environment variable '${apiKeyEnv}' is empty.`);
    return value.trim();
  }
  const rl = createInterface({ input, output });
  try {
    const entered = (await rl.question("API key: ")).trim();
    if (!entered) throw new Error("API key cannot be empty.");
    return entered;
  } finally {
    rl.close();
  }
}

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

async function startAll(configPath: string, config: LocalConfig): Promise<void> {
  if (!(await isHealthy(config.bus.http_base_url))) {
    // The Bus refuses to start without the host-control credential owned by the
    // native broker. Obtain it and hand it to the Bus via its environment only;
    // it is never logged or written to disk.
    const hostControlToken = await fetchHostControlToken();
    await startService(configPath, config, "bus", { FLOE_HOST_CONTROL_TOKEN: hostControlToken });
  }
  await waitForHealth(config.bus.http_base_url, "floe-bus");
  await startService(configPath, config, "bridge");
}

async function verifyHealth(config: LocalConfig): Promise<void> {
  await waitForHealth(config.bus.http_base_url, "floe-bus");
}

async function waitForHealth(baseUrl: string, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (await isHealthy(baseUrl)) return;
    await sleep(500);
  }
  throw new Error(`${label} did not become healthy at ${baseUrl}`);
}

async function isHealthy(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/health`);
    return response.ok;
  } catch {
    return false;
  }
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

function openUrl(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

async function registerCurrentWorkspace(config: LocalConfig, locator: string, initAuthorized: boolean): Promise<void> {
  // Registration and selection are host-control bootstrap routes. The broker
  // owns the host-control credential, so the CLI registers through it rather
  // than an unauthenticated HTTP call.
  const { workspace_id: workspaceId } = await registerLocalWorkspaceViaBroker(locator, initAuthorized);
  // Seed a default human operator actor if none exists yet.
  // Stored bus-DB-only (no workspace file written) so git status stays clean.
  const seedResult = await seedDefaultActor(config.bus.http_base_url, workspaceId);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
