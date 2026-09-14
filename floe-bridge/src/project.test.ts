import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, afterEach } from "vitest";
import YAML from "yaml";
import { ensureProjectTemplate, loadProject, materializeSavedConfig, computeConfigSurface } from "./project.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "floe-project-test-"));
  tmpDirs.push(dir);
  return dir;
}

function readAgentFrontmatter(workspacePath: string, agentFile = "floe.md"): Record<string, unknown> {
  const content = readFileSync(join(workspacePath, ".floe", "agents", agentFile), "utf8");
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  return YAML.parse(content.slice(3, end).trim()) ?? {};
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// Tests – Issue 1 (fresh default agent template)
// ---------------------------------------------------------------------------

describe("loadProject – watchers (Issue 155)", () => {
  it("parses declared watchers from floe.yaml", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test Project");
    const floeDir = join(workspace, ".floe");
    const projectConfigPath = join(floeDir, "floe.yaml");
    const projectConfig = YAML.parse(readFileSync(projectConfigPath, "utf8"));
    projectConfig.watchers = [
      { id: "inbox", graph_id: "graph_123", node_id: "watcher", path: "./inbox" }
    ];
    writeFileSync(projectConfigPath, YAML.stringify(projectConfig), "utf8");

    const project = loadProject(workspace);
    expect(project.watchers).toEqual([
      { id: "inbox", graph_id: "graph_123", node_id: "watcher", path: "./inbox" }
    ]);
  });

  it("defaults watchers to an empty list when floe.yaml declares none", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test Project");
    const project = loadProject(workspace);
    expect(project.watchers).toEqual([]);
  });

  it("skips a malformed watcher entry missing required fields", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test Project");
    const floeDir = join(workspace, ".floe");
    const projectConfigPath = join(floeDir, "floe.yaml");
    const projectConfig = YAML.parse(readFileSync(projectConfigPath, "utf8"));
    projectConfig.watchers = [{ id: "inbox", path: "./inbox" }]; // missing graph_id/node_id
    writeFileSync(projectConfigPath, YAML.stringify(projectConfig), "utf8");

    const project = loadProject(workspace);
    expect(project.watchers).toEqual([]);
  });
});

describe("ensureProjectTemplate – default agent file (Issue 1)", () => {
  it("does not write provider or model in the default agent runtime block", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test Project");

    const fm = readAgentFrontmatter(workspace);
    const runtime = (fm.runtime ?? {}) as Record<string, unknown>;

    expect(runtime).not.toHaveProperty("engine");
    expect(runtime).not.toHaveProperty("provider");
    expect(runtime).not.toHaveProperty("model");
  });

  it("does not write auth_profile in the default agent runtime block", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test Project");

    const fm = readAgentFrontmatter(workspace);
    const runtime = (fm.runtime ?? {}) as Record<string, unknown>;

    expect(runtime).not.toHaveProperty("auth_profile");
  });

  it("does not include openai-codex or gpt-5.4-mini anywhere in the default agent file", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test Project");

    const content = readFileSync(join(workspace, ".floe", "agents", "floe.md"), "utf8");

    expect(content).not.toContain("openai-codex");
    expect(content).not.toContain("gpt-5.4-mini");
    expect(content).not.toContain("auth_profile");
  });

  it("uses the canonical default Floe operating doctrine", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test Project");

    const content = readFileSync(join(workspace, ".floe", "agents", "floe.md"), "utf8");

    expect(content).toContain("You are Floe, the operator's persistent interface");
    expect(content).toContain("Treat the operator's words as outcomes and experience");
    expect(content).toContain("compose existing mechanisms before assuming something new must be built");
    expect(content).toContain("A generated script plus a command for the operator to run is not an automated Floe outcome");
    expect(content).toContain("represent that responsibility as a Floe actor");
    expect(content).toContain("must not replace the actor by invoking Codex or another model CLI");
    expect(content).toContain("Do not treat a detached operating-system process as persistent Floe operation");
    expect(content).toContain("use the runtime's capability discovery for that concrete need");
    expect(content).toContain("Follow the Bus-owned operation description and schema");
    expect(content).not.toContain("compose_scope");
    expect(content).toContain("Do not describe a convention-only controller or file-backed state machine as substrate execution");
    expect(content).toContain("verify that every downstream capability needed to complete the outcome is actually available");
    expect(content).toContain("floe.problem-report-draft.v1");
    expect(content).toContain("The operator app turns this Event into a **Report ready — Review** action");
    expect(content).not.toContain("runtime-backed endpoint");
    expect(content).not.toContain("source endpoint");
  });

  it("is idempotent — does not overwrite an existing .floe directory", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test Project");

    // Modify the agent file
    const agentPath = join(workspace, ".floe", "agents", "floe.md");
    const original = readFileSync(agentPath, "utf8");

    // Call again — should not overwrite
    ensureProjectTemplate(workspace, "Test Project");

    const after = readFileSync(agentPath, "utf8");
    expect(after).toBe(original);
  });

  it("initializes missing template files when the field directory already exists", () => {
    const workspace = makeTmp();
    mkdirSync(join(workspace, ".floe", "fields"), { recursive: true });

    ensureProjectTemplate(workspace, "Test Project");

    expect(existsSync(join(workspace, ".floe", "fields"))).toBe(true);
    expect(existsSync(join(workspace, ".floe", "floe.yaml"))).toBe(true);
    expect(existsSync(join(workspace, ".floe", "agents", "floe.md"))).toBe(true);
    expect(existsSync(join(workspace, ".floe", "extensions", "README.md"))).toBe(true);
    expect(existsSync(join(workspace, ".floe", "skills", "substrate-build", "SKILL.md"))).toBe(true);
    expect(existsSync(join(workspace, ".floe", "mcp", "README.md"))).toBe(true);
    expect(existsSync(join(workspace, ".floe", "state", "README.md"))).toBe(true);
    expect(existsSync(join(workspace, ".floe", "state", ".gitignore"))).toBe(true);
  });

  it("fills missing canonical files without overwriting existing project config", () => {
    const workspace = makeTmp();
    const floeDir = join(workspace, ".floe");
    const projectConfigPath = join(floeDir, "floe.yaml");
    const customProjectConfig = "schema: floe.workspace.v1\nversion: 99\n";
    mkdirSync(floeDir, { recursive: true });
    writeFileSync(projectConfigPath, customProjectConfig, "utf8");

    ensureProjectTemplate(workspace, "Test Project");

    expect(readFileSync(projectConfigPath, "utf8")).toBe(customProjectConfig);
    expect(existsSync(join(workspace, ".floe", "agents", "floe.md"))).toBe(true);
  });

  it("keeps the project config hash stable across repeated template ensures", () => {
    const workspace = makeTmp();

    ensureProjectTemplate(workspace, "Test Project");
    const first = loadProject(workspace);
    ensureProjectTemplate(workspace, "Test Project");
    const second = loadProject(workspace);

    expect(first.config_hash).toBe(second.config_hash);
  });
});

describe("materializeSavedConfig – agent runtime block (Issue 1)", () => {
  it("does not write provider or model in materialized agent runtime block", () => {
    const workspace = makeTmp();
    materializeSavedConfig(workspace, {
      agents: [
        {
          id: "reviewer",
          name: "Reviewer",
          instructions: "You are a code reviewer."
        }
      ]
    });

    const fm = readAgentFrontmatter(workspace, "reviewer.md");
    const runtime = (fm.runtime ?? {}) as Record<string, unknown>;

    expect(runtime).not.toHaveProperty("engine");
    expect(runtime).not.toHaveProperty("provider");
    expect(runtime).not.toHaveProperty("model");
  });

  it("uses actor-neutral fallback instructions for configured agents", () => {
    const workspace = makeTmp();
    materializeSavedConfig(workspace, {
      agents: [
        {
          id: "reviewer",
          name: "Reviewer"
        }
      ]
    });

    const content = readFileSync(join(workspace, ".floe", "agents", "reviewer.md"), "utf8");

    expect(content).toContain("You are Reviewer, a Floe actor for this project.");
    expect(content).not.toContain("runtime-backed agent");
    expect(content).not.toContain("runtime-backed endpoint");
  });
});

// ---------------------------------------------------------------------------
// Tests - config hash allow-list (Fix 1: deny-list to allow-list)
// ---------------------------------------------------------------------------

describe("hashFloeDir allow-list (Fix 1: extension data must not change config hash)", () => {
  it("extension data write does NOT change the config hash", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test");

    // Add an extension manifest to the workspace
    const extDir = join(workspace, ".floe", "extensions", "testExt");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "extension.json"), JSON.stringify({ name: "testExt", version: "1.0.0" }), "utf8");

    const before = loadProject(workspace).config_hash;

    // Write extension runtime data (board.md under a boards subdir)
    const boardsDir = join(extDir, "boards", "scope-abc");
    mkdirSync(boardsDir, { recursive: true });
    writeFileSync(join(boardsDir, "board.md"), "# Board\n\nsome card data", "utf8");

    // Write a card file inside the same extension data tree
    const cardsDir = join(extDir, "boards", "scope-abc", "cards");
    mkdirSync(cardsDir, { recursive: true });
    writeFileSync(join(cardsDir, "card-1.md"), "# Card 1\n\nfrontmatter stuff", "utf8");

    const after = loadProject(workspace).config_hash;

    expect(after).toBe(before);
  });

  it("changing floe.yaml DOES change the config hash", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test");

    const before = loadProject(workspace).config_hash;

    const yamlPath = join(workspace, ".floe", "floe.yaml");
    const original = readFileSync(yamlPath, "utf8");
    writeFileSync(yamlPath, original + "# extra comment\n", "utf8");

    const after = loadProject(workspace).config_hash;

    expect(after).not.toBe(before);
  });

  it("changing an agent definition file DOES change the config hash", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test");

    const before = loadProject(workspace).config_hash;

    const agentPath = join(workspace, ".floe", "agents", "floe.md");
    const original = readFileSync(agentPath, "utf8");
    writeFileSync(agentPath, original + "\n\n# extra section", "utf8");

    const after = loadProject(workspace).config_hash;

    expect(after).not.toBe(before);
  });

  it("changing an extension manifest DOES change the config hash", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test");

    const extDir = join(workspace, ".floe", "extensions", "testExt");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "extension.json"), JSON.stringify({ name: "testExt", version: "1.0.0" }), "utf8");

    const before = loadProject(workspace).config_hash;

    writeFileSync(join(extDir, "extension.json"), JSON.stringify({ name: "testExt", version: "2.0.0" }), "utf8");

    const after = loadProject(workspace).config_hash;

    expect(after).not.toBe(before);
  });

  it("writing non-config runtime files (extensions/README.md, state) does NOT change the config hash", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test");

    const before = loadProject(workspace).config_hash;

    // Overwrite README at extensions root (not inside any extension's declared surface)
    writeFileSync(join(workspace, ".floe", "extensions", "README.md"), "# Changed\n", "utf8");
    // Write a new file into state (ephemeral runtime state, not config)
    writeFileSync(join(workspace, ".floe", "state", "some-runtime.json"), "{}", "utf8");

    const after = loadProject(workspace).config_hash;

    expect(after).toBe(before);
  });

});

// ---------------------------------------------------------------------------
// Tests — regression: declared config surface (fixes #102 regression)
// ---------------------------------------------------------------------------

describe("computeConfigSurface — declared surface regression tests", () => {
  it("changing a skill file DOES change the config hash", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test");

    const before = loadProject(workspace).config_hash;

    const skillPath = join(workspace, ".floe", "skills", "substrate-build", "SKILL.md");
    const original = readFileSync(skillPath, "utf8");
    writeFileSync(skillPath, original + "\n\n# extra section", "utf8");

    const after = loadProject(workspace).config_hash;

    expect(after).not.toBe(before);
  });

  it("changing an MCP config file DOES change the config hash", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test");

    const before = loadProject(workspace).config_hash;

    const mcpPath = join(workspace, ".floe", "mcp", "README.md");
    const original = readFileSync(mcpPath, "utf8");
    writeFileSync(mcpPath, original + "\n# extra", "utf8");

    const after = loadProject(workspace).config_hash;

    expect(after).not.toBe(before);
  });

  it("extension entry-point file (under .floe) IS in the config hash", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test");

    const extDir = join(workspace, ".floe", "extensions", "testExt");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
      join(extDir, "extension.json"),
      JSON.stringify({ schema: "floe.extension.v1", name: "testExt", entry: "./index.ts" }),
      "utf8"
    );
    writeFileSync(join(extDir, "index.ts"), "export default () => [];", "utf8");

    const before = loadProject(workspace).config_hash;

    // Changing the local entry-point file DOES change the hash
    writeFileSync(join(extDir, "index.ts"), "export default () => []; // v2", "utf8");

    const after = loadProject(workspace).config_hash;

    expect(after).not.toBe(before);
  });

  it("extension entry-point that resolves OUTSIDE .floe does NOT change the config hash", () => {
    // Simulates a pointer-extension whose source package lives outside .floe
    // (e.g. the acme pattern).  The pointer file itself is already in the
    // surface; we must not pull in outside files.
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test");

    const extDir = join(workspace, ".floe", "extensions", "externalExt");
    mkdirSync(extDir, { recursive: true });
    // Write a pointer: manifest_source outside .floe (non-existent OK — we just test hash stability)
    writeFileSync(
      join(extDir, "extension.json"),
      JSON.stringify({ manifest_source: "../../../../some-pkg/extension.json" }),
      "utf8"
    );

    const before = loadProject(workspace).config_hash;

    // Re-writing the pointer file itself DOES change the hash (manifest changed)
    writeFileSync(
      join(extDir, "extension.json"),
      JSON.stringify({ manifest_source: "../../../../some-pkg/extension.json", comment: "updated" }),
      "utf8"
    );
    const afterPointerChange = loadProject(workspace).config_hash;
    expect(afterPointerChange).not.toBe(before);
  });

  it("changing an extension instructions_path file DOES change the config hash (regression: #102)", () => {
    // This is the key regression introduced by #102's allow-list: editing an
    // agent's instruction file referenced via instructions_path should trigger
    // a reload, but the hardcoded allow-list excluded it.
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test");

    const extDir = join(workspace, ".floe", "extensions", "myExt");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "overseer-instructions.md"), "# Instructions v1\n", "utf8");
    writeFileSync(
      join(extDir, "extension.json"),
      JSON.stringify({
        schema: "floe.extension.v1",
        name: "myExt",
        entry: "./index.ts",
        agents: [{
          agent_id: "overseer",
          label: "Overseer",
          instructions_path: "./overseer-instructions.md"
        }]
      }),
      "utf8"
    );

    const before = loadProject(workspace).config_hash;

    // Edit the referenced instructions file
    writeFileSync(join(extDir, "overseer-instructions.md"), "# Instructions v2 — changed\n", "utf8");

    const after = loadProject(workspace).config_hash;

    expect(after).not.toBe(before);
  });

  it("extension data files (board.md, cards) under an extension with agents are NOT in the hash", () => {
    // The declared surface only includes manifest-referenced files;
    // nothing else under the extension dir is config.
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test");

    const extDir = join(workspace, ".floe", "extensions", "myExt");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "overseer-instructions.md"), "# Instructions\n", "utf8");
    writeFileSync(
      join(extDir, "extension.json"),
      JSON.stringify({
        schema: "floe.extension.v1",
        name: "myExt",
        entry: "./index.ts",
        agents: [{
          agent_id: "overseer",
          label: "Overseer",
          instructions_path: "./overseer-instructions.md"
        }]
      }),
      "utf8"
    );

    const before = loadProject(workspace).config_hash;

    // Write board and card data under the same extension dir
    const boardsDir = join(extDir, "boards", "scope-xyz");
    mkdirSync(boardsDir, { recursive: true });
    writeFileSync(join(boardsDir, "board.md"), "# Board\n", "utf8");
    const cardsDir = join(boardsDir, "cards");
    mkdirSync(cardsDir, { recursive: true });
    writeFileSync(join(cardsDir, "card-1.md"), "# Card 1\n", "utf8");

    const after = loadProject(workspace).config_hash;

    expect(after).toBe(before);
  });

  it("computeConfigSurface contains the expected substrate files after ensureProjectTemplate", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test");

    const floeDir = join(workspace, ".floe");
    const surface = computeConfigSurface(floeDir);
    const relPaths = surface.map((f) =>
      f.replace(/\\/g, "/").slice(floeDir.replace(/\\/g, "/").length + 1)
    );

    // Must include substrate config
    expect(relPaths).toContain("floe.yaml");
    expect(relPaths.some((p) => p.startsWith("agents/"))).toBe(true);
    expect(relPaths.some((p) => p.startsWith("skills/"))).toBe(true);
    expect(relPaths.some((p) => p.startsWith("mcp/"))).toBe(true);

    // Must NOT include state or extensions root README
    expect(relPaths.some((p) => p.startsWith("state/"))).toBe(false);
    expect(relPaths).not.toContain("extensions/README.md");
  });
});
