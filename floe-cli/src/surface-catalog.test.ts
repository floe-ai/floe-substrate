import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { defaultConfig } from "./config.js";
import { registerSurface } from "./surfaces.js";
import { buildSurfaceCatalog } from "./surface-catalog.js";
import { hasBeenAsked, markAsked } from "./prompt-state.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function environment() {
  const home = tempDir("floe-catalog-");
  const config = defaultConfig(home);
  const configPath = join(home, "config.yaml");
  writeFileSync(configPath, YAML.stringify(config), "utf8");
  return { configPath, config, packageRoot: tempDir("floe-global-") };
}

/** Write an installed package under a fake global node_modules. */
function installPackage(root: string, name: string, manifest: Record<string, unknown>, binFiles: Record<string, string> = {}): string {
  const dir = join(root, ...name.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }), "utf8");
  for (const [file, body] of Object.entries(binFiles)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), body, "utf8");
  }
  return dir;
}

const surfacePkg = (surfaceName: string, bin = "run") => ({
  bin: { [bin]: "./dist/main.js" },
  floe: { surface: { name: surfaceName, label: `The ${surfaceName}`, bin } },
});

describe("surface catalog", () => {
  it("detects a surface from an installed package that was never launched", () => {
    const { configPath, config, packageRoot } = environment();
    const dir = installPackage(packageRoot, "floe-console", surfacePkg("console", "floe-console"), { "dist/main.js": "" });

    const catalog = buildSurfaceCatalog(configPath, config, packageRoot);

    expect(catalog.surfaces).toEqual([{
      name: "console",
      label: "The console",
      launch: { command: process.execPath, args: [join(dir, "dist", "main.js")] },
      source: { kind: "package", package: "floe-console" },
    }]);
  });

  it("detects scoped packages and ignores packages that declare nothing", () => {
    const { configPath, config, packageRoot } = environment();
    installPackage(packageRoot, "@acme/map", surfacePkg("star-map"), { "dist/main.js": "" });
    installPackage(packageRoot, "left-pad", { main: "index.js" });

    const names = buildSurfaceCatalog(configPath, config, packageRoot).surfaces.map((s) => s.name);
    expect(names).toEqual(["star-map"]);
  });

  it("merges registry files, and the installed package wins a shared name", () => {
    const { configPath, config, packageRoot } = environment();
    installPackage(packageRoot, "floe-console", surfacePkg("console"), { "dist/main.js": "" });
    registerSurface(configPath, config, { name: "console", label: "stale", launch: { command: "old", args: [] } });
    registerSurface(configPath, config, { name: "script", label: "A script", launch: { command: "sh", args: [] } });

    const catalog = buildSurfaceCatalog(configPath, config, packageRoot);

    expect(catalog.surfaces.map((s) => [s.name, s.source.kind])).toEqual([["console", "package"], ["script", "registry"]]);
    expect(catalog.shadowed).toEqual([{ name: "console", byPackage: "floe-console" }]);
  });

  it("offers neither package when two claim the same name", () => {
    const { configPath, config, packageRoot } = environment();
    installPackage(packageRoot, "one", surfacePkg("console"), { "dist/main.js": "" });
    installPackage(packageRoot, "two", surfacePkg("console"), { "dist/main.js": "" });

    const catalog = buildSurfaceCatalog(configPath, config, packageRoot);

    expect(catalog.surfaces).toEqual([]);
    expect(catalog.conflicts).toEqual([{ name: "console", packages: ["one", "two"] }]);
  });

  it("reports a declaration whose bin is not one of the package's bins", () => {
    const { configPath, config, packageRoot } = environment();
    installPackage(packageRoot, "bad", { bin: { a: "./a.js" }, floe: { surface: { name: "bad", label: "Bad", bin: "b" } } }, { "a.js": "" });

    const catalog = buildSurfaceCatalog(configPath, config, packageRoot);

    expect(catalog.surfaces).toEqual([]);
    expect(catalog.brokenManifests[0]).toMatchObject({ package: "bad" });
    expect(catalog.brokenManifests[0]!.reason).toContain("not one of this package's bins");
  });

  it("launches a non-node bin directly", () => {
    const { configPath, config, packageRoot } = environment();
    const dir = installPackage(packageRoot, "native-surface",
      { bin: { go: "./bin/go" }, floe: { surface: { name: "go", label: "Go", bin: "go" } } },
      { "bin/go": "\u0000binary" });

    const [surface] = buildSurfaceCatalog(configPath, config, packageRoot).surfaces;
    expect(surface!.launch).toEqual({ command: join(dir, "bin", "go"), args: [] });
  });

  it("works with no global package root", () => {
    const { configPath, config } = environment();
    expect(buildSurfaceCatalog(configPath, config, null).surfaces).toEqual([]);
  });
});

describe("prompt state", () => {
  it("records that a question was asked, independent of config creation", () => {
    const { configPath, config } = environment();
    expect(hasBeenAsked(configPath, config, "start_at_login")).toBe(false);
    markAsked(configPath, config, "start_at_login");
    expect(hasBeenAsked(configPath, config, "start_at_login")).toBe(true);
  });
});
