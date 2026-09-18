import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { z } from "zod";

const LocalConfigSchema = z.object({
  schema: z.literal("floe.local.v1"),
  version: z.number().int(),
  home: z.string(),
  services: z.object({
    // start_on_demand is the client start policy: may Floe start the substrate
    // itself when it is not already reachable? true on a personal machine
    // (typing `floe` just works); set false where Floe runs as an externally
    // managed service, so a client reports "not running" instead of starting a
    // rogue copy. It does not by itself install any OS start-at-login: that is
    // read from the OS, never a config key (see `floe service`).
    start_on_demand: z.boolean(),
    manager: z.string()
  }),
  bus: z.object({
    listen: z.string(),
    http_base_url: z.string(),
    ws_base_url: z.string(),
    data_dir: z.string(),
    log_dir: z.string()
  }),
  bridge: z.object({
    data_dir: z.string(),
    log_dir: z.string(),
    bus_url: z.string(),
    workspace_access: z.object({ local_paths: z.boolean() }),
    runtime_adapter: z.string().optional()
  }),
  library: z.object({
    configs_dir: z.string(),
    skills_dir: z.string(),
    extensions_dir: z.string(),
    mcp_dir: z.string(),
    templates_dir: z.string()
  }),
  runtime: z.object({
    default_auth_profile: z.string().optional()
  }).optional()
}).strict();

export type LocalConfig = z.infer<typeof LocalConfigSchema>;

export function defaultConfig(home = join(homedir(), ".floe")): LocalConfig {
  return {
    schema: "floe.local.v1",
    version: 1,
    home,
    services: { start_on_demand: true, manager: "auto" },
    bus: {
      listen: "127.0.0.1:5377",
      http_base_url: "http://127.0.0.1:5377",
      ws_base_url: "ws://127.0.0.1:5377",
      data_dir: "./bus",
      log_dir: "./logs/bus"
    },
    bridge: {
      data_dir: "./bridge",
      log_dir: "./logs/bridge",
      bus_url: "ws://127.0.0.1:5377",
      workspace_access: { local_paths: true }
    },
    library: {
      configs_dir: "./configs",
      skills_dir: "./skills",
      extensions_dir: "./extensions",
      mcp_dir: "./mcp",
      templates_dir: "./templates"
    }
  };
}

export function expandHome(pathValue: string): string {
  if (pathValue === "~") return homedir();
  if (pathValue.startsWith("~/") || pathValue.startsWith("~\\")) return join(homedir(), pathValue.slice(2));
  return pathValue;
}

export function resolveConfigPath(explicitPath?: string): string {
  return resolve(expandHome(explicitPath ?? process.env.FLOE_CONFIG ?? join(homedir(), ".floe", "config.yaml")));
}

export function resolveLocalPath(configPath: string, home: string, pathValue: string): string {
  const expanded = expandHome(pathValue);
  if (isAbsolute(expanded)) return resolve(expanded);
  return resolve(home ? expandHome(home) : dirname(configPath), expanded);
}

function rejectRetiredKeys(raw: unknown, configPath: string): void {
  const services = (raw as { services?: Record<string, unknown> } | null)?.services;
  if (services && Object.prototype.hasOwnProperty.call(services, "autostart")) {
    throw new Error(
      `Floe config at ${configPath} uses the retired key \`services.autostart\`.\n` +
        `It carried two different meanings and was split into two independent settings:\n` +
        `  - \`services.start_on_demand\` (config, default true): may a client start the\n` +
        `    substrate when it is unreachable.\n` +
        `  - start-at-login: no longer a config key — Floe reads it from the OS. Manage it\n` +
        `    with \`floe service install\` / \`floe service uninstall\`.\n` +
        `Remove \`services.autostart\`; to disable on-demand start set \`services.start_on_demand: false\`.\n` +
        `Then re-run setup:\n` +
        `  floe setup`
    );
  }
}

function parseLocalConfig(raw: unknown, configPath: string): LocalConfig {
  rejectRetiredKeys(raw, configPath);
  const result = LocalConfigSchema.safeParse(raw);
  if (result.success) return result.data;
  const details = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(
    `Floe config at ${configPath} is incompatible with this version of Floe.\n` +
      `Floe is in early development, so breaking config changes are expected and there is no automatic migration.\n` +
      `Reset your local config and re-run setup:\n` +
      `  rm -rf ~/.floe            # or: rm ${configPath}\n` +
      `  floe setup\n` +
      `Details: ${details}`
  );
}

export function ensureConfig(explicitPath?: string): { configPath: string; config: LocalConfig; created: boolean } {
  const configPath = resolveConfigPath(explicitPath);
  let created = false;
  if (!existsSync(configPath)) {
    const config = defaultConfig(join(homedir(), ".floe"));
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    created = true;
  }
  const raw = YAML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown> | null;
  const config = parseLocalConfig(raw, configPath);
  ensureLocalDirs(configPath, config);
  return { configPath, config, created };
}

export function saveConfig(configPath: string, config: LocalConfig): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, YAML.stringify(config), "utf8");
}

export function ensureLocalDirs(configPath: string, config: LocalConfig): void {
  const paths = [
    config.bus.data_dir,
    config.bus.log_dir,
    config.bridge.data_dir,
    config.bridge.log_dir,
    config.library.configs_dir,
    config.library.skills_dir,
    config.library.extensions_dir,
    config.library.mcp_dir,
    config.library.templates_dir
  ];
  for (const path of paths) mkdirSync(resolveLocalPath(configPath, config.home, path), { recursive: true });
}
