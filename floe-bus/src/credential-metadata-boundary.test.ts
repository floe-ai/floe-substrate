import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { listAuthModels } from "./auth.js";
import { defaultConfig } from "./config.js";

describe("credential metadata boundary", () => {
  const directories: string[] = [];

  afterEach(() => {
    directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
  });

  it("lists declared model metadata without opening or migrating stored credentials", async () => {
    const directory = mkdtempSync(join(tmpdir(), "floe-model-metadata-"));
    directories.push(directory);
    const config = defaultConfig(directory);
    const configPath = join(directory, "config.yaml");
    const authDirectory = join(directory, "auth");
    mkdirSync(authDirectory, { recursive: true });
    const authPath = join(authDirectory, "auth.json");
    const legacy = JSON.stringify({
      openai: { type: "api_key", key: "must-remain-migration-only" },
    });
    writeFileSync(authPath, legacy, "utf8");
    writeFileSync(join(authDirectory, "models.json"), JSON.stringify({
      providers: { openai: { models: [{ id: "gpt-x", name: "GPT X", reasoning: false }] } },
    }), "utf8");

    const models = await listAuthModels(configPath, config, "openai");

    expect(models).toEqual([
      expect.objectContaining({ id: "gpt-x", provider: "openai" }),
    ]);
    expect(readFileSync(authPath, "utf8")).toBe(legacy);
    expect(JSON.stringify(models)).not.toContain("must-remain-migration-only");
  });
});
