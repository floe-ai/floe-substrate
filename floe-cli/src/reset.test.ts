import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { defaultConfig, type LocalConfig } from "./config.js";
import { buildResetPlan, executeReset } from "./reset.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), "floe-reset-test-"));
}

function makeConfigPath(home: string): string {
  return join(home, "config.yaml");
}

function writeConfig(home: string, config: LocalConfig): string {
  const cfgPath = makeConfigPath(home);
  mkdirSync(home, { recursive: true });
  writeFileSync(cfgPath, YAML.stringify(config), "utf8");
  return cfgPath;
}

function scaffoldDirs(configPath: string, config: LocalConfig, home: string): void {
  // Create all the data dirs so tests can verify they are removed
  const dirs = [
    config.bus.data_dir,
    config.bus.log_dir,
    config.bridge.data_dir,
    config.bridge.log_dir,
    config.library.configs_dir,
    config.library.skills_dir,
    config.library.extensions_dir,
    config.library.mcp_dir,
    config.library.templates_dir,
  ];
  for (const rel of dirs) {
    mkdirSync(join(home, rel), { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildResetPlan", () => {
  let home: string;
  let config: LocalConfig;
  let configPath: string;

  beforeEach(() => {
    home = makeTempHome();
    config = defaultConfig(home);
    configPath = writeConfig(home, config);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("includes all data directories in the wipe list", () => {
    const plan = buildResetPlan(configPath, config);
    const wipePaths = plan.wipe.map((t) => t.path);

    // Every data/log dir must be scheduled for deletion
    expect(wipePaths).toContain(join(home, "bus"));
    expect(wipePaths).toContain(join(home, "logs", "bus"));
    expect(wipePaths).toContain(join(home, "bridge"));
    expect(wipePaths).toContain(join(home, "logs", "bridge"));
    expect(wipePaths).toContain(join(home, "configs"));
    expect(wipePaths).toContain(join(home, "skills"));
    expect(wipePaths).toContain(join(home, "extensions"));
    expect(wipePaths).toContain(join(home, "mcp"));
    expect(wipePaths).toContain(join(home, "templates"));
  });

  it("includes services.json in the wipe list", () => {
    const plan = buildResetPlan(configPath, config);
    const wipePaths = plan.wipe.map((t) => t.path);
    expect(wipePaths).toContain(join(home, "services.json"));
  });

  it("preserves config.yaml", () => {
    const plan = buildResetPlan(configPath, config);
    const preservePaths = plan.preserve.map((t) => t.path);
    expect(preservePaths).toContain(configPath);
  });

  it("preserves the auth directory", () => {
    const plan = buildResetPlan(configPath, config);
    const preservePaths = plan.preserve.map((t) => t.path);
    expect(preservePaths).toContain(join(home, "auth"));
  });

  it("does not include auth directory in wipe list", () => {
    const plan = buildResetPlan(configPath, config);
    const wipePaths = plan.wipe.map((t) => t.path);
    expect(wipePaths).not.toContain(join(home, "auth"));
    // No wipe path should start with the auth dir
    for (const p of wipePaths) {
      expect(p.startsWith(join(home, "auth"))).toBe(false);
    }
  });

  it("does not include config.yaml in wipe list", () => {
    const plan = buildResetPlan(configPath, config);
    const wipePaths = plan.wipe.map((t) => t.path);
    expect(wipePaths).not.toContain(configPath);
  });

  it("deduplicates paths when two config keys resolve to the same directory", () => {
    // Force bus data_dir and bridge data_dir to the same path to trigger dedup
    const cfg = defaultConfig(home);
    cfg.bus.data_dir = "./shared";
    cfg.bridge.data_dir = "./shared";
    const cfgPath2 = makeConfigPath(home);
    writeFileSync(cfgPath2, YAML.stringify(cfg), "utf8");

    const plan = buildResetPlan(cfgPath2, cfg);
    const wipePaths = plan.wipe.map((t) => t.path);
    // resolveLocalPath resolves relative to config.home
    const sharedPath = join(home, "shared");
    const occurrences = wipePaths.filter((p) => p === sharedPath).length;
    expect(occurrences).toBe(1);
  });
});

describe("executeReset", () => {
  let home: string;
  let config: LocalConfig;
  let configPath: string;

  beforeEach(() => {
    home = makeTempHome();
    config = defaultConfig(home);
    configPath = writeConfig(home, config);
    scaffoldDirs(configPath, config, home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("deletes all data directories", () => {
    // Place sentinel files inside each data dir to confirm they are removed
    writeFileSync(join(home, "bus", "floe-bus.sqlite"), "fake-db", "utf8");
    writeFileSync(join(home, "bridge", "state.json"), "{}", "utf8");

    executeReset(configPath, config);

    // sentinel files must be gone
    expect(existsSync(join(home, "bus", "floe-bus.sqlite"))).toBe(false);
    expect(existsSync(join(home, "bridge", "state.json"))).toBe(false);
  });

  it("deletes library directories", () => {
    writeFileSync(join(home, "extensions", "my-ext.json"), "{}", "utf8");
    writeFileSync(join(home, "configs", "agent.md"), "# agent", "utf8");

    executeReset(configPath, config);

    expect(existsSync(join(home, "extensions", "my-ext.json"))).toBe(false);
    expect(existsSync(join(home, "configs", "agent.md"))).toBe(false);
  });

  it("deletes services.json", () => {
    writeFileSync(join(home, "services.json"), '{"bus":{"pid":999}}', "utf8");

    executeReset(configPath, config);

    expect(existsSync(join(home, "services.json"))).toBe(false);
  });

  it("preserves config.yaml", () => {
    const originalContent = readFileSync(configPath, "utf8");

    executeReset(configPath, config);

    expect(existsSync(configPath)).toBe(true);
    expect(readFileSync(configPath, "utf8")).toBe(originalContent);
  });

  it("preserves auth directory and its contents", () => {
    const authDir = join(home, "auth");
    mkdirSync(authDir, { recursive: true });
    const authJson = join(authDir, "auth.json");
    writeFileSync(authJson, '{"github-copilot":{"type":"oauth","access_token":"tok_abc"}}', "utf8");

    executeReset(configPath, config);

    expect(existsSync(authJson)).toBe(true);
    expect(readFileSync(authJson, "utf8")).toContain("tok_abc");
  });

  it("recreates empty data directories after wipe (idempotent boot)", () => {
    executeReset(configPath, config);

    // Dirs must exist again (empty) so the next floe boot does not fail
    expect(existsSync(join(home, "bus"))).toBe(true);
    expect(existsSync(join(home, "bridge"))).toBe(true);
    expect(existsSync(join(home, "logs", "bus"))).toBe(true);
    expect(existsSync(join(home, "logs", "bridge"))).toBe(true);
  });

  it("is idempotent — running reset twice does not error", () => {
    executeReset(configPath, config);
    expect(() => executeReset(configPath, config)).not.toThrow();

    // config still intact after second run
    expect(existsSync(configPath)).toBe(true);
  });

  it("preserves auth even when auth dir does not exist yet", () => {
    // auth dir was never created — reset must not throw and must not create it either
    const authDir = join(home, "auth");
    expect(existsSync(authDir)).toBe(false);

    expect(() => executeReset(configPath, config)).not.toThrow();
    // auth dir absence is fine; we never create it — that's auth setup's job
  });
});
