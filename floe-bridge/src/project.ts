import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import YAML from "yaml";
import { readPromptAsset } from "./prompt-assets.js";

export type AgentConfig = {
  agent_id: string;
  name: string;
  file: string;
  frontmatter: Record<string, unknown>;
  body: string;
  extensions: string[];
};

export type PulseConfig = {
  id: string;
  persistence?: "workspace" | "local";
  scope_id?: string;
  trigger: { type: string; at?: string; schedule?: string; timezone?: string };
  content: Record<string, unknown>;
  subscribers?: Array<{ endpoint_ref: string }>;
};

/**
 * A watched folder is a deterministic monitor: it observes a path and fires
 * an existing Scope Graph trigger node when a file arrives or changes. It is
 * not a new wake mechanism — it is a config for the existing
 * fireScopeGraphTrigger emit path, exactly like a trigger node's event_type
 * is config for emitTriggerEvent. No bespoke primitive is introduced here.
 */
export type WatcherConfig = {
  id: string;
  graph_id: string;
  node_id: string;
  /** Path relative to the workspace root. */
  path: string;
  extensions?: string[];
  settle_ms?: number;
};

export type ProjectLoadResult = {
  config_hash: string;
  agents: AgentConfig[];
  pulses: PulseConfig[];
  watchers: WatcherConfig[];
  validation: {
    ok: boolean;
    warnings: string[];
    errors: string[];
  };
};

export type SavedProjectConfig = {
  agents?: Array<{
    id?: string;
    agent_id?: string;
    name?: string;
    instructions?: string;
    skills?: string[];
  }>;
};

const DEFAULT_FLOE_AGENT_BODY = readPromptAsset("default-floe-agent.md");
const DEFAULT_SUBSTRATE_BUILD_SKILL = readPromptAsset("substrate-build-skill.md");

export function ensureProjectTemplate(workspacePath: string, workspaceName: string): void {
  const floeDir = join(workspacePath, ".floe");
  mkdirSync(join(floeDir, "agents"), { recursive: true });
  mkdirSync(join(floeDir, "extensions"), { recursive: true });
  mkdirSync(join(floeDir, "skills", "substrate-build"), { recursive: true });
  mkdirSync(join(floeDir, "mcp"), { recursive: true });
  mkdirSync(join(floeDir, "state"), { recursive: true });

  writeIfMissing(join(floeDir, "floe.yaml"), YAML.stringify({
    schema: "floe.workspace.v1",
    version: 1,
    applied_config: {
      config_id: "cfg_composition_floe_default",
      version: 1,
      source: "initial_template"
    },
    agents: [
      {
        id: "floe",
        path: "./agents/floe.md"
      }
    ],
    pulse: {
      default: "off",
      after_idle: "30m",
      min_interval: "30m"
    },
    state: {
      path: "./state"
    }
  }), "utf8");

  writeIfMissing(join(floeDir, "agents", "floe.md"), `---
schema: floe.agent.v1
agent_id: floe
label: Floe
applied_from:
  config_id: cfg_composition_floe_default
  version: 1
extensions: []
skills:
  - ../skills/substrate-build
mcp: []
pulse:
  inherit: true
scope:
  paths:
    - ./
  services: []
---
${DEFAULT_FLOE_AGENT_BODY}
`, "utf8");

  writeIfMissing(join(floeDir, "extensions", "README.md"), "# Extensions\n\nProject-local Floe extensions can be placed here.\n", "utf8");
  writeIfMissing(join(floeDir, "skills", "substrate-build", "SKILL.md"), `${DEFAULT_SUBSTRATE_BUILD_SKILL}\n`, "utf8");
  writeIfMissing(join(floeDir, "mcp", "README.md"), "# MCP\n\nReference or copy runtime-native MCP profiles here when needed.\n", "utf8");
  writeIfMissing(join(floeDir, "state", "README.md"), "# State\n\nEphemeral project-local Floe runtime state may be placed here.\n", "utf8");
  writeIfMissing(join(floeDir, "state", ".gitignore"), "*\n!.gitignore\n!README.md\n", "utf8");
}

function writeIfMissing(path: string, data: string, encoding: BufferEncoding): void {
  if (existsSync(path)) return;
  writeFileSync(path, data, encoding);
}

export function loadProject(workspacePath: string): ProjectLoadResult {
  const floeDir = join(workspacePath, ".floe");
  const warnings: string[] = [];
  const errors: string[] = [];
  if (!existsSync(floeDir)) {
    return {
      config_hash: "",
      agents: [],
      pulses: [],
      watchers: [],
      validation: { ok: false, warnings, errors: [".floe folder is missing"] }
    };
  }

  const projectConfigPath = join(floeDir, "floe.yaml");
  if (!existsSync(projectConfigPath)) errors.push(".floe/floe.yaml is missing");
  let projectConfig: any = {};
  if (existsSync(projectConfigPath)) {
    try {
      projectConfig = YAML.parse(readFileSync(projectConfigPath, "utf8")) ?? {};
      if (projectConfig.schema !== "floe.workspace.v1") warnings.push(".floe/floe.yaml schema is not floe.workspace.v1");
    } catch (error) {
      errors.push(`Unable to parse .floe/floe.yaml: ${(error as Error).message}`);
    }
  }

  const agentEntries = Array.isArray(projectConfig.agents) ? projectConfig.agents : [{ id: "floe", file: "agents/floe.md" }];
  const agents: AgentConfig[] = [];
  for (const entry of agentEntries) {
    const file = typeof entry.file === "string"
      ? entry.file
      : typeof entry.path === "string"
        ? entry.path
        : `agents/${entry.id ?? "floe"}.md`;
    let resolvedPath = join(floeDir, file);
    // Support directory-based agents: agents/<name>/agent.md
    if (!existsSync(resolvedPath) && !file.endsWith(".md")) {
      const dirAgent = join(floeDir, file, "agent.md");
      if (existsSync(dirAgent)) resolvedPath = dirAgent;
    }
    if (!existsSync(resolvedPath)) {
      // Try directory fallback: agents/<id>/agent.md
      const dirFallback = join(floeDir, "agents", entry.id ?? "floe", "agent.md");
      if (existsSync(dirFallback)) {
        resolvedPath = dirFallback;
      } else {
        errors.push(`Agent file is missing: ${file}`);
        continue;
      }
    }
    const parsed = parseAgentFile(readFileSync(resolvedPath, "utf8"));
    const agentId = String(parsed.frontmatter.agent_id ?? entry.id ?? basename(resolvedPath, ".md"));
    if ("endpoint_id" in parsed.frontmatter) {
      warnings.push(`${file} contains endpoint_id; canonical project files should omit workspace-specific endpoint ids`);
    }
    agents.push({
      agent_id: agentId,
      name: String(parsed.frontmatter.name ?? titleCase(agentId)),
      file,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      extensions: Array.isArray(parsed.frontmatter.extensions)
        ? parsed.frontmatter.extensions.map(String)
        : []
    });
  }

  const pulses: PulseConfig[] = Array.isArray(projectConfig.pulses)
    ? projectConfig.pulses.map((p: any) => ({
        id: String(p.id ?? ""),
        persistence: p.persistence === "local" ? "local" : "workspace",
        scope_id: typeof p.scope_id === "string" ? p.scope_id : undefined,
        trigger: p.trigger ?? { type: "once" },
        content: p.content ?? {},
        subscribers: Array.isArray(p.subscribers) ? p.subscribers : [],
      }))
    : [];

  const watchers: WatcherConfig[] = Array.isArray(projectConfig.watchers)
    ? projectConfig.watchers
        .filter((w: any) => w && typeof w.graph_id === "string" && typeof w.node_id === "string" && typeof w.path === "string")
        .map((w: any) => ({
          id: String(w.id ?? `${w.graph_id}:${w.node_id}`),
          graph_id: String(w.graph_id),
          node_id: String(w.node_id),
          path: String(w.path),
          extensions: Array.isArray(w.extensions) ? w.extensions.map(String) : undefined,
          settle_ms: Number.isInteger(w.settle_ms) ? Number(w.settle_ms) : undefined
        }))
    : [];

  return {
    config_hash: hashFloeDir(floeDir),
    agents,
    pulses,
    watchers,
    validation: {
      ok: errors.length === 0,
      warnings,
      errors
    }
  };
}

export function materializeSavedConfig(workspacePath: string, config: SavedProjectConfig): ProjectLoadResult {
  ensureProjectTemplate(workspacePath, basename(workspacePath));
  const floeDir = join(workspacePath, ".floe");
  const projectConfigPath = join(floeDir, "floe.yaml");
  const projectConfig = YAML.parse(readFileSync(projectConfigPath, "utf8")) ?? {};
  const agents = Array.isArray(projectConfig.agents) ? [...projectConfig.agents] : [];
  const configuredAgents = Array.isArray(config.agents) ? config.agents : [];

  for (const agent of configuredAgents) {
    const agentId = slug(String(agent.agent_id ?? agent.id ?? ""));
    if (!agentId) continue;
    const name = String(agent.name ?? titleCase(agentId));
    const file = `agents/${agentId}.md`;
    const skills = Array.isArray(agent.skills) ? agent.skills.map(String) : [];
    const body = String(agent.instructions ?? `You are ${name}, a Floe actor for this project.`);
    const frontmatter = {
      schema: "floe.agent.v1",
      agent_id: agentId,
      name,
      skills
    };
    writeFileSync(join(floeDir, file), `---\n${YAML.stringify(frontmatter).trim()}\n---\n# ${name}\n\n${body.trim()}\n`, "utf8");
    const existing = agents.find((entry: any) => entry.id === agentId);
    if (existing) existing.file = file;
    else agents.push({ id: agentId, file });
  }

  projectConfig.agents = agents;
  writeFileSync(projectConfigPath, YAML.stringify(projectConfig), "utf8");
  return loadProject(workspacePath);
}

function parseAgentFile(content: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!content.startsWith("---")) return { frontmatter: {}, body: content };
  const marker = "\n---";
  const end = content.indexOf(marker, 3);
  if (end < 0) return { frontmatter: {}, body: content };
  const raw = content.slice(3, end).trim();
  const body = content.slice(end + marker.length).replace(/^\r?\n/, "");
  return {
    frontmatter: YAML.parse(raw) ?? {},
    body
  };
}

/**
 * Hash the declared config surface.
 *
 * Delegates to computeConfigSurface() so the set of hashed files is always
 * exactly the set the loader declared as config — never more, never less.
 */
function hashFloeDir(floeDir: string): string {
  const hash = createHash("sha256");
  for (const file of computeConfigSurface(floeDir)) {
    try {
      const rel = relative(floeDir, file).replace(/\\/g, "/");
      hash.update(rel);
      hash.update("\0");
      hash.update(readFileSync(file));
      hash.update("\0");
    } catch { /* file disappeared between surface computation and hashing */ }
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Compute the declared config surface for hashing.
 *
 * Returns a sorted, deduplicated list of absolute file paths that constitute
 * the workspace configuration.  Only files in this set contribute to the
 * config hash; everything else (extension runtime data, state, worklogs, …)
 * is excluded.
 *
 * Surface composition:
 *
 * 1. Substrate-owned config
 *    - floe.yaml
 *    - agents/**   (all agent definition files at any depth)
 *    - skills/**   (all skill files — a skill change should trigger reload)
 *    - mcp/**      (all MCP config files — an MCP server change should trigger reload)
 *
 * 2. Per-extension declared config — for each extensions/<name>/extension.json:
 *    - the extension.json file itself (local pointer or direct manifest)
 *    - the resolved `entry` file, if it resolves under .floe
 *    - each `agents[].instructions_path`, if it resolves under .floe
 *
 *    Pointer files (manifest_source) are followed so that instruction files
 *    referenced by an external manifest are still captured when they happen to
 *    live under .floe.  Everything else under extensions/<name>/ is treated as
 *    extension runtime data and excluded — no glob over extension dirs.
 *
 * Note on skills/mcp inclusion: neither directory is currently read by
 * loadProject() itself, but both are genuinely config — editing a skill
 * instruction or an MCP server config changes agent behaviour.  Including them
 * matches the principle that under-reloading is worse than over-reloading for
 * infrequently-changing config directories.
 */
export function computeConfigSurface(floeDir: string): string[] {
  const files = new Set<string>();

  const addIfExists = (p: string) => {
    const abs = resolve(p);
    if (existsSync(abs)) files.add(abs);
  };

  const addAllUnder = (dir: string) => {
    const abs = resolve(dir);
    if (existsSync(abs)) {
      for (const f of listFiles(abs)) files.add(f);
    }
  };

  // 1. Workspace manifest
  addIfExists(join(floeDir, "floe.yaml"));

  // 2. Agent definition files
  addAllUnder(join(floeDir, "agents"));

  // 3. Skill files (changes here should trigger reload)
  addAllUnder(join(floeDir, "skills"));

  // 4. MCP config files (changes here should trigger reload)
  addAllUnder(join(floeDir, "mcp"));

  // 5. Extension declared surface
  const extensionsDir = join(floeDir, "extensions");
  let extEntries: string[];
  try { extEntries = readdirSync(extensionsDir); } catch { extEntries = []; }

  for (const dirName of extEntries) {
    const extDir = join(extensionsDir, dirName);
    try { if (!statSync(extDir).isDirectory()) continue; } catch { continue; }

    const manifestPath = join(extDir, "extension.json");
    if (!existsSync(manifestPath)) continue;

    // Always include the local extension.json (pointer or direct manifest)
    files.add(resolve(manifestPath));

    // Parse to find referenced files
    let rawManifest: Record<string, unknown>;
    let manifestBaseDir = extDir;
    try {
      rawManifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
    } catch { continue; }

    // Follow pointer if present
    if (rawManifest !== null && typeof rawManifest.manifest_source === "string") {
      const sourcePath = resolve(extDir, rawManifest.manifest_source);
      manifestBaseDir = dirname(sourcePath);
      // Include canonical manifest if it resolves under .floe
      if (isUnderDir(sourcePath, floeDir)) addIfExists(sourcePath);
      // Re-read as the canonical manifest to find referenced files
      try {
        rawManifest = JSON.parse(readFileSync(sourcePath, "utf-8")) as Record<string, unknown>;
      } catch { continue; }
    }

    // Include entry file if it resolves under .floe
    if (typeof rawManifest.entry === "string") {
      const entryPath = resolve(manifestBaseDir, rawManifest.entry);
      if (isUnderDir(entryPath, floeDir)) addIfExists(entryPath);
    }

    // Include each bundled-agent instructions_path if it resolves under .floe
    if (Array.isArray(rawManifest.agents)) {
      for (const agent of rawManifest.agents) {
        if (agent !== null && typeof agent === "object" &&
            typeof (agent as Record<string, unknown>).instructions_path === "string") {
          const instrPath = resolve(manifestBaseDir, (agent as Record<string, unknown>).instructions_path as string);
          if (isUnderDir(instrPath, floeDir)) addIfExists(instrPath);
        }
      }
    }
  }

  return [...files].sort();
}

/** Returns true iff `filePath` is at or below `dir` (both resolved). */
function isUnderDir(filePath: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(filePath));
  return !rel.startsWith("..") && !isAbsolute(rel);
}

function listFiles(root: string): string[] {
  const results: string[] = [];
  for (const name of readdirSync(root)) {
    const path = resolve(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) results.push(...listFiles(path));
    if (stat.isFile()) results.push(path);
  }
  return results.sort();
}

function titleCase(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}
