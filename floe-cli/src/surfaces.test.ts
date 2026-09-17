import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { defaultConfig } from "./config.js";
import {
  getSurface,
  launchSurface,
  listSurfaces,
  registerSurface,
  removeSurface,
  surfacesDir,
} from "./surfaces.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function environment(): { configPath: string; config: ReturnType<typeof defaultConfig> } {
  const home = mkdtempSync(join(tmpdir(), "floe-surfaces-"));
  roots.push(home);
  const config = defaultConfig(home);
  const configPath = join(home, "config.yaml");
  writeFileSync(configPath, YAML.stringify(config), "utf8");
  return { configPath, config };
}

describe("surfaces registry", () => {
  it("reports no surfaces when the directory does not exist", () => {
    const { configPath, config } = environment();
    expect(listSurfaces(configPath, config)).toEqual({ surfaces: [], broken: [] });
  });

  it("registers a surface and reads it back, sorted by name", () => {
    const { configPath, config } = environment();

    registerSurface(configPath, config, {
      name: "map",
      label: "Star Map",
      launch: { command: "star-map", args: [] },
    });
    registerSurface(configPath, config, {
      name: "console",
      label: "Console",
      launch: { command: "node", args: ["console.mjs"] },
    });

    const { surfaces, broken } = listSurfaces(configPath, config);
    expect(broken).toEqual([]);
    expect(surfaces.map((s) => s.name)).toEqual(["console", "map"]);
    expect(getSurface(configPath, config, "map")?.label).toBe("Star Map");
    expect(getSurface(configPath, config, "absent")).toBeNull();
  });

  it("overwrites an existing entry on re-registration", () => {
    const { configPath, config } = environment();
    registerSurface(configPath, config, { name: "map", label: "Old", launch: { command: "x", args: [] } });
    registerSurface(configPath, config, { name: "map", label: "New", launch: { command: "y", args: [] } });

    const { surfaces } = listSurfaces(configPath, config);
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0].label).toBe("New");
  });

  it("removes a surface and reports whether one was present", () => {
    const { configPath, config } = environment();
    registerSurface(configPath, config, { name: "map", label: "Star Map", launch: { command: "x", args: [] } });

    expect(removeSurface(configPath, config, "map")).toBe(true);
    expect(removeSurface(configPath, config, "map")).toBe(false);
    expect(listSurfaces(configPath, config).surfaces).toEqual([]);
  });

  it("surfaces a broken entry rather than hiding it (bad yaml)", () => {
    const { configPath, config } = environment();
    const dir = surfacesDir(configPath, config);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "junk.yaml"), "name: junk\nlabel:\n  - not a string\n", "utf8");

    const { surfaces, broken } = listSurfaces(configPath, config);
    expect(surfaces).toEqual([]);
    expect(broken).toHaveLength(1);
    expect(broken[0].file).toBe("junk.yaml");
  });

  it("surfaces an entry whose name does not match its filename", () => {
    const { configPath, config } = environment();
    const dir = surfacesDir(configPath, config);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "aardvark.yaml"),
      YAML.stringify({ name: "zebra", label: "Zebra", launch: { command: "x", args: [] } }),
      "utf8",
    );

    const { surfaces, broken } = listSurfaces(configPath, config);
    expect(surfaces).toEqual([]);
    expect(broken).toHaveLength(1);
    expect(broken[0].reason).toContain("does not match filename");
  });

  it("rejects an invalid name at registration", () => {
    const { configPath, config } = environment();
    expect(() =>
      registerSurface(configPath, config, { name: "Not Valid", label: "x", launch: { command: "x", args: [] } }),
    ).toThrow();
  });

  it("launches a surface as a real process and resolves its exit code", async () => {
    const { config } = environment();
    // A tiny node program that exits with a known non-zero code, proving the
    // exit status is propagated (not swallowed) and that no shell is involved.
    const code = await launchSurface({
      name: "probe",
      label: "Probe",
      launch: { command: process.execPath, args: ["-e", "process.exit(7)"] },
    });
    expect(code).toBe(7);
    void config;
  });

  it("rejects when the launch command does not exist", async () => {
    await expect(
      launchSurface({
        name: "probe",
        label: "Probe",
        launch: { command: "definitely-not-a-real-binary-xyz", args: [] },
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});
