import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FloeRuntimeAdapter } from "../adapters/floe-runtime-adapter.js";
import { copilotEnvironment, packagedCopilotCliPath } from "./copilot.js";

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
        env: { ...copilotEnvironment(), COPILOT_HOME: copilotHome },
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
    const runtime = (new FloeRuntimeAdapter() as any).runtimeFactory();
    const env = runtime.clientOptions.env as Record<string, string | undefined>;
    for (const name of TOKENS) expect(env[name], name).toBeUndefined();
    expect(env.PATH ?? env.Path).toBe(process.env.PATH ?? process.env.Path);
  });
});
