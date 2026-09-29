import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorkspaceConfigurationInventory } from "./workspace-config-inventory.js";
import { ensureProjectTemplate, loadProject } from "./project.js";
import { migrateTemplateDefaultScope } from "./template-scope-migration.js";

const BODY = "# Floe\n\nA person's own instructions stay exactly as written.\n";
// Two of the frontmatters Floe's template wrote (90dc8d1 and e859d1a).
const LATEST_SCOPED = `schema: floe.agent.v1
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
  services: []`;
const PI_SCOPED = `schema: floe.agent.v1
agent_id: floe
label: Floe
runtime:
  engine: pi
  provider: configured_by_pi_ai
  options: {}
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
  services: []`;

describe("template folder scope migration", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function workspaceWith(frontmatter: string, eol = "\n"): string {
    const root = mkdtempSync(join(tmpdir(), "floe-scope-migration-"));
    roots.push(root);
    ensureProjectTemplate(root, "Test");
    writeFileSync(floeMd(root), `---\n${frontmatter}\n---\n${BODY}`.replace(/\n/g, eol), "utf8");
    return root;
  }
  const floeMd = (root: string) => join(root, ".floe", "agents", "floe.md");

  it.each([["latest", LATEST_SCOPED], ["pi engine", PI_SCOPED]])("removes the %s template scope and nothing else", (_name, frontmatter) => {
    const root = workspaceWith(frontmatter);
    expect(migrateTemplateDefaultScope(root).outcome).toBe("removed");
    const expected = frontmatter.replace("\nscope:\n  paths:\n    - ./\n  services: []", "");
    expect(readFileSync(floeMd(root), "utf8")).toBe(`---\n${expected}\n---\n${BODY}`);
    expect(migrateTemplateDefaultScope(root).outcome).toBe("no_scope");
    const inventory = buildWorkspaceConfigurationInventory({ binding_id: "binding", project: loadProject(root),
      runtimes: [{ agent_id: "floe", adapter_id: "fake", model: "gpt-5.6" }] });
    expect(inventory.actors.find(actor => actor.source_actor_id === "floe")?.definition).not.toHaveProperty("scope");
  });

  it("keeps Windows line endings", () => {
    const root = workspaceWith(LATEST_SCOPED, "\r\n");
    expect(migrateTemplateDefaultScope(root).outcome).toBe("removed");
    const content = readFileSync(floeMd(root), "utf8");
    expect(content).not.toContain("scope:");
    expect(content.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("keeps and reports a whole-folder scope when any setting differs from the template", () => {
    const root = workspaceWith(LATEST_SCOPED.replace("label: Floe", "label: Builder"));
    const before = readFileSync(floeMd(root), "utf8");
    expect(migrateTemplateDefaultScope(root)).toMatchObject({ outcome: "kept_uncertain", reason: expect.stringContaining("person may have chosen") });
    expect(readFileSync(floeMd(root), "utf8")).toBe(before);
  });

  it("keeps a scope a person set without reporting it", () => {
    const root = workspaceWith(LATEST_SCOPED.replace("    - ./", "    - ./src"));
    const before = readFileSync(floeMd(root), "utf8");
    expect(migrateTemplateDefaultScope(root).outcome).toBe("person_set");
    expect(readFileSync(floeMd(root), "utf8")).toBe(before);
  });

  it("leaves today's template untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "floe-scope-migration-"));
    roots.push(root);
    ensureProjectTemplate(root, "Test");
    const before = readFileSync(floeMd(root), "utf8");
    expect(migrateTemplateDefaultScope(root).outcome).toBe("no_scope");
    expect(readFileSync(floeMd(root), "utf8")).toBe(before);
  });
});
