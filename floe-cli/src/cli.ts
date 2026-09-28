import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";
import { Command } from "commander";
import { ensureConfig, resolveLocalPath, type LocalConfig } from "./config.js";
import { buildResetPlan, executeReset } from "./reset.js";
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
import { registerLocalWorkspaceViaBroker } from "./operation-client.js";
import { startAll, waitForBusHealth, isHealthy, ensureSubstrateForClient, runningBusVersion, describeVersionMismatch } from "./startup.js";
import { thisInstallation, directInstallRequiredMessage } from "./installation.js";
import {
  registerSurface,
  removeSurface,
  launchSurface,
  type SurfaceEntry,
} from "./surfaces.js";
import { buildSurfaceCatalog, type SurfaceCatalog } from "./surface-catalog.js";
import { hasBeenAsked, markAsked } from "./prompt-state.js";
import {
  serviceStatus,
  installService,
  uninstallService,
  type CliInvocation,
} from "./service.js";

const program = new Command();

program
  .name("floe")
  .description("Launch and manage the local Floe substrate")
  .option("--config <path>", "config path");

program
  .command("setup")
  .description("Create config, start services, verify health, and offer to install auto-start")
  .option("--yes", "accept setup defaults (install auto-start without prompting)")
  .option("--no-autostart", "do not offer to install auto-start")
  .option("--repair", "reconcile local service records")
  .action(async (options) => {
    const { configPath, config } = ensureConfig(program.opts().config);
    if (options.repair) clearRecords(configPath, config);
    await startAll(configPath, config);
    await verifyHealth(configPath, config);
    const currentWorkspace = findAncestorWithFloe(process.cwd());
    if (currentWorkspace) {
      await registerCurrentWorkspace(config, currentWorkspace, true);
    }
    console.log(`Floe services are running: ${config.bus.http_base_url}`);
    if (options.autostart !== false) {
      if (await offerServiceInstall(configPath, { assumeYes: options.yes === true })) {
        markAsked(configPath, config, "start_at_login");
      }
    }
    printSurfacesSummary(configPath, config);
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

// Start-at-login the machine can own: install Floe as a real OS start-at-login so
// a person does not have to type anything. Honest about platform reach — see
// service.ts. This is distinct from the services.start_on_demand policy (which
// only governs whether a client may start the substrate on demand).
const service = program.command("service").description("Install/remove Floe auto-start on this machine");
service.command("install").description("Install Floe to start automatically on this machine").action(() => {
  const installation = thisInstallation();
  if (installation.dependencyOf) {
    console.error(directInstallRequiredMessage(installation));
    process.exitCode = 1;
    return;
  }
  const { configPath } = ensureConfig(program.opts().config);
  const result = installService(configPath, cliInvocation());
  console.log(result.message);
  if (!result.ok) process.exitCode = 1;
});
service.command("uninstall").description("Remove Floe auto-start from this machine").action(() => {
  const result = uninstallService();
  console.log(result.message);
  if (!result.ok) process.exitCode = 1;
});
service.command("status").description("Show whether Floe is installed to auto-start").action(() => {
  const status = serviceStatus();
  console.log(status.detail);
});

program.command("uninstall").description("Remove auto-start and stop services; preserve ~/.floe data").action(async () => {
  const { configPath, config } = ensureConfig(program.opts().config);
  for (const service of ["bridge", "bus"] as ServiceName[]) stopService(configPath, config, service);
  const removal = uninstallService();
  console.log(removal.message);
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

// The surfaces a person can use Floe through: installed packages that declare
// themselves, plus registry files for surfaces that are not packages. Floe never
// names a surface; these commands only read what is installed or on disk.
const surfaceCommand = program.command("surface").description("List and manage surfaces (how you use Floe)");

surfaceCommand
  .command("list")
  .description("List detected and registered surfaces")
  .action(() => {
    const { configPath, config } = ensureConfig(program.opts().config);
    const catalog = buildSurfaceCatalog(configPath, config);
    reportCatalogProblems(catalog);
    if (catalog.surfaces.length === 0) {
      printNoSurfaces(config);
    }
    for (const surface of catalog.surfaces) {
      const from = surface.source.kind === "package" ? `package ${surface.source.package}` : "registry file";
      console.log(`${surface.name}  —  ${surface.label}  (${from})`);
    }
    for (const item of catalog.shadowed) {
      console.log(`(registry file '${item.name}.yaml' is unused: installed package ${item.byPackage} declares the same surface)`);
    }
  });

surfaceCommand
  .command("register")
  .description("Register a surface that is not an npm package (packages declare floe.surface in package.json instead)")
  .requiredOption("--name <name>", "stable id a person can type (lowercase, digits, hyphens)")
  .requiredOption("--label <label>", "human label shown when choosing a surface")
  .requiredOption("--command <command>", "command that launches the surface")
  .option("--arg <arg>", "launch argument (repeat for several)", collectArg, [])
  .action((options) => {
    const { configPath, config } = ensureConfig(program.opts().config);
    try {
      const entry = registerSurface(configPath, config, {
        name: options.name,
        label: options.label,
        launch: { command: options.command, args: options.arg },
      });
      console.log(`Registered surface '${entry.name}'. Run \`floe\` (or \`floe ${entry.name}\`) to launch it.`);
    } catch (error) {
      console.error(`Could not register surface: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

surfaceCommand
  .command("remove")
  .description("Remove a surface from the registry")
  .argument("<name>", "surface name")
  .action((name: string) => {
    const { configPath, config } = ensureConfig(program.opts().config);
    if (removeSurface(configPath, config, name)) {
      console.log(`Removed surface '${name}'.`);
      return;
    }
    const fromPackage = buildSurfaceCatalog(configPath, config).surfaces
      .find((surface) => surface.name === name && surface.source.kind === "package");
    console.log(fromPackage && fromPackage.source.kind === "package"
      ? `Surface '${name}' comes from the installed package ${fromPackage.source.package}. Uninstall it with: npm rm -g ${fromPackage.source.package}`
      : `No surface named '${name}' is registered.`);
  });

// `floe up` — the connect-first door for anything that needs the substrate but
// is not a surface (e.g. a surface's own binary that starts Floe then runs).
// It shares the exact readiness path the launcher uses, so "ensure Floe is up"
// is written once.
program
  .command("up")
  .description("Ensure the Floe substrate is reachable (starting it if this machine allows), without launching anything")
  .action(async () => {
    await runUp();
  });

// The handler for `floe` (no surface) and `floe <surface>`. Both make the
// substrate reachable connect-first (reusing a running one, or starting it only
// if policy allows) before handing over to a surface. This is a normal command;
// routeSurfaceLaunch (below) injects it so an unknown first token is treated as
// a surface name rather than erroring.
program
  .command("launch [surface]")
  .description("Ensure the substrate is reachable, then launch a surface (the default action)")
  .action(async (surface?: string) => {
    await runLauncher(surface);
  });

await program.parseAsync(routeSurfaceLaunch(normalizeLegacyCommandArgs(process.argv)));

async function runUp(): Promise<void> {
  const { configPath, config } = ensureConfig(program.opts().config);
  const plan = await ensureSubstrateForClient(configPath, config);
  if (plan === "blocked") {
    printServiceNotRunning(config);
    await offerServiceInstall(configPath, { assumeYes: false });
    process.exitCode = 1;
    return;
  }
  if (plan === "connect") await reportVersionMismatch(config);
  console.log(`Floe is running: ${config.bus.http_base_url}`);
}

/** Say plainly when the serving Floe is a different version; never restart it. */
async function reportVersionMismatch(config: LocalConfig): Promise<void> {
  const message = describeVersionMismatch(
    config.bus.http_base_url,
    thisInstallation().version,
    await runningBusVersion(config.bus.http_base_url),
  );
  if (message) console.warn(message);
}

async function runLauncher(surfaceName?: string): Promise<void> {
  const { configPath, config } = ensureConfig(program.opts().config);

  // Connect-first: use a running substrate and spawn nothing; start one only if
  // this machine's policy allows; otherwise say plainly it is not running.
  const plan = await ensureSubstrateForClient(configPath, config);
  if (plan === "blocked") {
    printServiceNotRunning(config);
    await offerServiceInstall(configPath, { assumeYes: false });
    process.exitCode = 1;
    return;
  }
  if (plan === "connect") await reportVersionMismatch(config);
  await registerCwdWorkspaceBestEffort(config);
  if (!hasBeenAsked(configPath, config, "start_at_login")) {
    // First launch means the person has never been asked — not that the config
    // file is new (a surface may have created it first).
    if (await offerServiceInstall(configPath, { assumeYes: false })) {
      markAsked(configPath, config, "start_at_login");
    }
  }

  const catalog = buildSurfaceCatalog(configPath, config);
  reportCatalogProblems(catalog);
  const { surfaces } = catalog;

  if (surfaceName) {
    const found = surfaces.find((surface) => surface.name === surfaceName);
    if (!found) {
      console.error(`No surface named '${surfaceName}' is installed.`);
      if (surfaces.length > 0) {
        console.error(`Installed surfaces: ${surfaces.map((surface) => surface.name).join(", ")}`);
      } else {
        printNoSurfaces(config);
      }
      process.exitCode = 1;
      return;
    }
    await launchAndPropagate(found);
    return;
  }

  if (surfaces.length === 0) {
    console.log(`Floe services are running: ${config.bus.http_base_url}`);
    console.log("");
    printNoSurfaces(config);
    return;
  }
  if (surfaces.length === 1) {
    // Asking a person to choose from a list of one is noise.
    await launchAndPropagate(surfaces[0]);
    return;
  }
  const chosen = await promptChooseSurface(surfaces);
  if (chosen) await launchAndPropagate(chosen);
}

/**
 * Register the current directory's workspace if there is one. Best-effort:
 * under connect-first we may be talking to a substrate this install does not
 * own (e.g. a managed service), where host-control registration is not ours to
 * do. A failure here must not stop a surface from launching.
 */
async function registerCwdWorkspaceBestEffort(config: LocalConfig): Promise<void> {
  const currentWorkspace = findAncestorWithFloe(process.cwd());
  if (!currentWorkspace) return;
  try {
    await registerCurrentWorkspace(config, currentWorkspace, true);
  } catch (error) {
    console.warn(`Note: could not register the current workspace: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function printServiceNotRunning(config: LocalConfig): void {
  console.error(`The Floe substrate is not running at ${config.bus.http_base_url}.`);
  console.error("This machine is set not to start it on demand (services.start_on_demand is off),");
  console.error("so Floe is expected to be running as a managed service here.");
  console.error("Start it now with `floe start`, or have this machine start it for you:");
}

/**
 * Offer to install real OS auto-start. Skips silently when it is already
 * installed or when there is no terminal to answer; on a platform where
 * auto-start is not built, it says so rather than pretending. Returns true when
 * the person was actually told or asked something, so a caller can record it.
 */
async function offerServiceInstall(configPath: string, opts: { assumeYes: boolean }): Promise<boolean> {
  const installation = thisInstallation();
  if (installation.dependencyOf) {
    // A dependency's copy must never install anything the machine owns. Not
    // recorded as "asked": the direct copy should still ask on its own launch.
    console.log(directInstallRequiredMessage(installation));
    return false;
  }
  const status = serviceStatus();
  if (status.installed) return false;
  if (!status.supported) {
    console.log(status.detail);
    return true;
  }
  let yes = opts.assumeYes;
  if (!yes) {
    if (!input.isTTY) return false;
    const rl = createInterface({ input, output });
    const answer = await rl.question("Install Floe to start automatically on this machine? [Y/n] ");
    rl.close();
    yes = !answer.trim().toLowerCase().startsWith("n");
  }
  if (!yes) return true;
  const result = installService(configPath, cliInvocation());
  console.log(result.message);
  return true;
}

/** How this CLI re-invokes itself unattended: node + the exec args and entry
 *  script that reproduce however it was launched (dist entry, or tsx from
 *  source), run from the entry's directory so module resolution works. */
function cliInvocation(): CliInvocation {
  const entry = resolve(process.argv[1]);
  return { command: process.execPath, prefixArgs: [...process.execArgv, entry], workingDirectory: dirname(entry) };
}

async function launchAndPropagate(entry: SurfaceEntry): Promise<void> {
  console.log(`Launching ${entry.label}…`);
  try {
    process.exitCode = await launchSurface(entry);
  } catch (error) {
    console.error(`Could not launch ${entry.label}: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`Check its launch command: ${[entry.launch.command, ...entry.launch.args].join(" ")}`);
    process.exitCode = 1;
  }
}

async function promptChooseSurface(surfaces: SurfaceEntry[]): Promise<SurfaceEntry | null> {
  console.log("Which surface would you like to open?");
  surfaces.forEach((surface, index) => console.log(`  ${index + 1}. ${surface.label}  (${surface.name})`));
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question("Enter a number or name: ")).trim();
    const byIndex = Number.parseInt(answer, 10);
    if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= surfaces.length) return surfaces[byIndex - 1];
    const byName = surfaces.find((surface) => surface.name === answer);
    if (byName) return byName;
    console.error(`'${answer}' did not match a surface.`);
    return null;
  } finally {
    rl.close();
  }
}

function printSurfacesSummary(configPath: string, config: LocalConfig): void {
  const catalog = buildSurfaceCatalog(configPath, config);
  reportCatalogProblems(catalog);
  const { surfaces } = catalog;
  if (surfaces.length === 0) {
    console.log("");
    printNoSurfaces(config);
    return;
  }
  console.log(`Installed surfaces: ${surfaces.map((surface) => surface.name).join(", ")}. Run \`floe\` to launch.`);
}

function printNoSurfaces(_config: LocalConfig): void {
  console.log("Surfaces are how you use Floe — a surface is what you actually interact with.");
  console.log("None are installed yet. Install a surface globally with npm, then run `floe`.");
  console.log("A surface that is not an npm package can be registered by hand:");
  console.log("  floe surface register --name <name> --label \"<label>\" --command <command>");
}

function reportCatalogProblems(catalog: SurfaceCatalog): void {
  for (const item of catalog.brokenFiles) {
    console.warn(`Ignoring unreadable surface file '${item.file}': ${item.reason}`);
  }
  for (const item of catalog.brokenManifests) {
    console.warn(`Ignoring package ${item.package}: its floe.surface declaration is invalid (${item.reason})`);
  }
  for (const item of catalog.conflicts) {
    console.warn(`Not offering surface '${item.name}': it is declared by more than one installed package (${item.packages.join(", ")}). Uninstall all but one.`);
  }
}

function collectArg(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function verifyHealth(configPath: string, config: LocalConfig): Promise<void> {
  await waitForBusHealth(configPath, config);
}

async function printStatus(configPath: string, config: LocalConfig): Promise<void> {
  const records = readRecords(configPath, config);
  for (const service of ["bus", "bridge"] as ServiceName[]) {
    const record = records[service];
    const running = record ? isPidRunning(record.pid) : false;
    console.log(`${service}: ${running ? "running" : "not running"}${record ? ` pid=${record.pid}` : ""}`);
  }
  const busVersion = await runningBusVersion(config.bus.http_base_url);
  const healthy = await isHealthy(config.bus.http_base_url);
  console.log(`bus: ${config.bus.http_base_url} ${healthy ? `healthy${busVersion ? ` (Floe ${busVersion})` : ""}` : "unreachable"}`);
  const installation = thisInstallation();
  console.log(`this copy: Floe ${installation.version ?? "(unknown version)"}${installation.dependencyOf ? `, installed as part of ${installation.dependencyOf}` : ""}`);
}

async function registerCurrentWorkspace(config: LocalConfig, locator: string, initAuthorized: boolean): Promise<void> {
  // Registration and selection are host-control bootstrap routes. The broker
  // owns the host-control credential, so the CLI registers through it rather
  // than an unauthenticated HTTP call. The Bus provisions the workspace's
  // operator Actor as part of registration (see local-operator-actor), so the
  // CLI does not seed anything itself.
  await registerLocalWorkspaceViaBroker(locator, initAuthorized, config.bus.http_base_url);
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

function tail(text: string, lines: number): string {
  const parts = text.split(/\r?\n/);
  return parts.slice(Math.max(0, parts.length - lines)).join("\n");
}

/**
 * Route bare `floe` and `floe <surface>` to the launch command. The launch
 * command is normal (not a commander default) because a default command
 * greedily captures global options and positionals. Here we look at argv
 * ourselves: skip global options, find the first positional, and if it is not
 * one of Floe's own commands, treat it as a surface name by injecting `launch`
 * in front of it. With no positional at all, append `launch` so bare `floe`
 * runs the launcher. Floe never hardcodes a surface — only its own command
 * names are reserved.
 */
function routeSurfaceLaunch(argv: string[]): string[] {
  const known = new Set<string>();
  for (const command of program.commands) {
    known.add(command.name());
    for (const alias of command.aliases()) known.add(alias);
  }
  const head = argv.slice(0, 2);
  const rest = argv.slice(2);
  const optionsTakingValue = new Set(["--config"]);
  const passthrough = new Set(["--help", "-h", "--version", "-V"]);

  let index = 0;
  while (index < rest.length) {
    const token = rest[index];
    if (passthrough.has(token)) return argv; // let commander show help/version
    if (token.startsWith("-")) {
      index += optionsTakingValue.has(token) ? 2 : 1;
      continue;
    }
    break; // first positional token
  }

  if (index >= rest.length) return [...head, ...rest, "launch"];
  if (known.has(rest[index])) return argv; // a real command
  return [...head, ...rest.slice(0, index), "launch", ...rest.slice(index)];
}

function normalizeLegacyCommandArgs(argv: string[]): string[] {
  const map: Record<string, string> = {
    "--start": "start",
    "--stop": "stop",
    "--status": "status",
    "--doctor": "doctor",
    "--restart": "restart",
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
