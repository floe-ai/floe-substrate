import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { listAuthModels } from "./auth.js";
import { defaultConfig } from "./config.js";

describe("credential metadata boundary", () => {
  const directories: string[] = [];

  afterEach(() => {
    directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
  });

  it("lists model metadata without opening, refreshing, or probing legacy credentials", async () => {
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
    const fetch = vi.fn(async () => {
      throw new Error("model listing must not make a credentialled provider request");
    });

    const models = await listAuthModels(configPath, config, "openai", fetch);

    expect(models.length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(readFileSync(authPath, "utf8")).toBe(legacy);
    expect(JSON.stringify(models)).not.toContain("must-remain-migration-only");
  });
});
