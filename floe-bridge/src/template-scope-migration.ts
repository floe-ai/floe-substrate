import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

/**
 * Floe's own floe.md template used to write a `./` folder scope. That scope
 * was Floe's default, not a person's choice, so it is removed. Only a file
 * whose whole frontmatter is byte-identical to a template Floe once wrote is
 * changed; the body is never read or changed. A `./` scope in any other
 * frontmatter may have been chosen by a person, so it is kept and reported.
 */
export type TemplateScopeMigration =
  | Readonly<{ outcome: "removed" | "no_scope" | "person_set"; path: string }>
  | Readonly<{ outcome: "kept_uncertain"; path: string; reason: string }>;

const TEMPLATE_SCOPE_BLOCK = ["scope:", "  paths:", "    - ./", "  services: []"];
const TEMPLATE_TAIL = ["extensions: []", "skills:", "  - ../skills/substrate-build", "mcp: []", "pulse:", "  inherit: true"];
const TEMPLATE_APPLIED = ["applied_from:", "  config_id: cfg_composition_floe_default", "  version: 1"];
const TEMPLATE_HEAD = ["schema: floe.agent.v1", "agent_id: floe", "label: Floe"];

/** Every scope-bearing floe.md frontmatter Floe's template has written (e859d1a to 90dc8d1). */
const SCOPED_TEMPLATE_FRONTMATTERS = [
  [],
  ["runtime:", "  engine: pi"],
  ["runtime:", "  engine: pi", "  provider: openai-codex", "  model: gpt-5.4-mini"],
  ["runtime:", "  engine: pi", "  provider: openai-codex", "  model: gpt-5.4-mini", "  auth_profile: default"],
  ["runtime:", "  engine: pi", "  provider: configured_by_pi_ai", "  options: {}"],
].map(runtime => [...TEMPLATE_HEAD, ...runtime, ...TEMPLATE_APPLIED, ...TEMPLATE_TAIL, ...TEMPLATE_SCOPE_BLOCK].join("\n"));

const WHOLE_FOLDER = new Set(["./", ".", ""]);

export function migrateTemplateDefaultScope(workspacePath: string): TemplateScopeMigration {
  const path = join(workspacePath, ".floe", "agents", "floe.md");
  if (!existsSync(path)) return { outcome: "no_scope", path };
  const content = readFileSync(path, "utf8");
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  if (end < 0) return { outcome: "no_scope", path };
  const frontmatter = lines.slice(1, end).map(line => line.trimEnd());
  const scopeIndex = frontmatter.findIndex(line => /^scope\s*:/.test(line));
  if (scopeIndex < 0) return { outcome: "no_scope", path };

  if (SCOPED_TEMPLATE_FRONTMATTERS.includes(frontmatter.join("\n"))) {
    const kept = [lines[0]!, ...frontmatter.slice(0, -TEMPLATE_SCOPE_BLOCK.length), ...lines.slice(end)];
    writeFileSync(path, kept.join(eol), "utf8");
    return { outcome: "removed", path };
  }
  if (!declaresWholeFolder(frontmatter.join("\n"))) return { outcome: "person_set", path };
  return {
    outcome: "kept_uncertain",
    path,
    reason: "floe.md declares the whole-folder scope, but its settings differ from every template Floe wrote, so a person may have chosen it.",
  };
}

function declaresWholeFolder(frontmatter: string): boolean {
  try {
    const paths = (YAML.parse(frontmatter) as { scope?: { paths?: unknown } } | null)?.scope?.paths;
    return Array.isArray(paths) && paths.length > 0 && paths.every(path => WHOLE_FOLDER.has(String(path).trim()));
  } catch {
    return false;
  }
}
