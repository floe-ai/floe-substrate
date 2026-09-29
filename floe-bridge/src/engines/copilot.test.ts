import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FloeRuntimeAdapter } from "../adapters/floe-runtime-adapter.js";
import { copilotEnvironment, copilotHome, packagedCopilotCliPath } from "./copilot.js";
import { defaultConfig } from "../config.js";

const TOKENS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;
const saved = Object.fromEntries(TOKENS.map((name) => [name, process.env[name]]));
afterEach(() => {
  for (const name of TOKENS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("the official Copilot CLI ships with Floe", () => {
  it("resolves to this platform's native binary, which runs", () => {
    const cliPath = packagedCopilotCliPath();
    expect(cliPath).toBeTruthy();
    expect(existsSync(cliPath!)).toBe(true);
    const copilotHome = mkdtempSync(join(tmpdir(), "floe-copilot-home-"));
    try {
      const result = spawnSync(cliPath!, ["--version"], {
        encoding: "utf8",
        timeout: 60_000,
        env: copilotEnvironment(copilotHome),
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
    } finally {
      rmSync(copilotHome, { recursive: true, force: true });
    }
  }, 90_000);
});

describe("a token in Floe's environment never reaches the engine", () => {
  it("is removed from the environment the turn runtime starts Copilot with", () => {
    for (const name of TOKENS) process.env[name] = `leaked-${name}`;
    const home = mkdtempSync(join(tmpdir(), "floe-copilot-home-"));
    try {
      const runtime = (new FloeRuntimeAdapter({ copilotHome: home }) as any).runtimeFactory({ expectedAccount: { label: "tester", host: "https://github.com" } });
      const env = runtime.clientOptions.env as Record<string, string | undefined>;
      for (const name of TOKENS) expect(env[name], name).toBeUndefined();
      expect(env.PATH ?? env.Path).toBe(process.env.PATH ?? process.env.Path);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("turns, readiness and sign-in share Floe's own Copilot folder", () => {
  it("is the Bridge's data folder, never the user's own Copilot home", () => {
    const floeHome = mkdtempSync(join(tmpdir(), "floe-home-"));
    try {
      const home = copilotHome(join(floeHome, "config.yaml"), defaultConfig(floeHome));
      expect(home).toBe(join(floeHome, "bridge", "copilot"));
      const adapter = new FloeRuntimeAdapter({ copilotHome: home }) as any;
      const runtime = adapter.runtimeFactory({ expectedAccount: { label: "tester", host: "https://github.com" } });
      expect(runtime.clientOptions.baseDirectory).toBe(home);
      expect(runtime.clientOptions.env.COPILOT_HOME).toBe(home);
      const account = adapter.createEngineAccount();
      expect(account.clientOptions.baseDirectory).toBe(home);
      expect(account.environment.COPILOT_HOME).toBe(home);
      expect(existsSync(home)).toBe(true);
    } finally {
      rmSync(floeHome, { recursive: true, force: true });
    }
  });
});
