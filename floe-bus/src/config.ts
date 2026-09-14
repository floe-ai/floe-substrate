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
    autostart: z.boolean(),
    manager: z.string(),
    start_app: z.boolean().optional()
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
    workspace_access: z.object({
      local_paths: z.boolean()
    })
  }),
  // floe-app is no longer part of the substrate. The bus still reads config.app
  // for the loopback browser-origin set and the local-config status projection
  // (removal is P5), so keep it optional with a default rather than requiring
  // it in the shared config the CLI now writes without an app block.
  app: z.object({
    listen: z.string(),
    bus_http_url: z.string(),
    bus_ws_url: z.string(),
    data_dir: z.string(),
    log_dir: z.string()
  }).default({
    listen: "127.0.0.1:5379",
    bus_http_url: "http://127.0.0.1:5377",
    bus_ws_url: "ws://127.0.0.1:5377",
    data_dir: "./app",
    log_dir: "./logs/app"
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
});

export type LocalConfig = z.infer<typeof LocalConfigSchema>;

export function defaultConfig(home = join(homedir(), ".floe")): LocalConfig {
  return {
    schema: "floe.local.v1",
    version: 1,
    home,
    services: {
      autostart: true,
      manager: "auto",
      start_app: true
    },
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
      workspace_access: {
        local_paths: true
      }
    },
    app: {
      listen: "127.0.0.1:5379",
      bus_http_url: "http://127.0.0.1:5377",
      bus_ws_url: "ws://127.0.0.1:5377",
      data_dir: "./app",
      log_dir: "./logs/app"
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
  if (pathValue.startsWith("~/") || pathValue.startsWith("~\\")) {
    return join(homedir(), pathValue.slice(2));
  }
  return pathValue;
}

export function resolveConfigPath(explicitPath?: string): string {
  const configured = explicitPath ?? process.env.FLOE_CONFIG ?? join(homedir(), ".floe", "config.yaml");
  return resolve(expandHome(configured));
}

export function resolveLocalPath(configPath: string, home: string, pathValue: string): string {
  const expanded = expandHome(pathValue);
  if (isAbsolute(expanded)) return resolve(expanded);
  const base = home ? resolve(expandHome(home)) : dirname(configPath);
  return resolve(base, expanded);
}

function parseLocalConfig(raw: unknown, configPath: string): LocalConfig {
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

export function ensureConfig(explicitPath?: string): { configPath: string; config: LocalConfig } {
  const configPath = resolveConfigPath(explicitPath);
  if (!existsSync(configPath)) {
    const config = defaultConfig(join(homedir(), ".floe"));
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, YAML.stringify(config), "utf8");
  }
  const raw = YAML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown> | null;
  const parsed = parseLocalConfig(raw, configPath);
  mkdirSync(resolveLocalPath(configPath, parsed.home, parsed.bus.data_dir), { recursive: true });
  mkdirSync(resolveLocalPath(configPath, parsed.home, parsed.bus.log_dir), { recursive: true });
  mkdirSync(resolveLocalPath(configPath, parsed.home, parsed.library.configs_dir), { recursive: true });
  return { configPath, config: parsed };
}

export function parseListen(value: string): { host: string; port: number } {
  const index = value.lastIndexOf(":");
  if (index < 0) throw new Error(`Invalid listen address: ${value}`);
  const host = value.slice(0, index);
  const port = Number(value.slice(index + 1));
  if (!host || !Number.isInteger(port)) throw new Error(`Invalid listen address: ${value}`);
  return { host, port };
}
