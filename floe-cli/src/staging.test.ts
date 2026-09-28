import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dependencyClosure, ensureStage, isNpmInstalled, pruneStages, runtimeDir, stageOf } from "./staging.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "floe-stage-"));
  roots.push(dir);
  return dir;
}

function pkg(dir: string, name: string, dependencies: Record<string, string> = {}, files: Record<string, string> = {}): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", dependencies }), "utf8");
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), body, "utf8");
  }
  return dir;
}

/** A surface installed globally with floe nested and floe's deps hoisted beside it. */
function consoleInstall(): { prefix: string; floe: string; home: string } {
  const base = root();
  const modules = join(base, "prefix", "node_modules");
  pkg(join(modules, "floe-console"), "floe-console", { floe: "*" });
  const nested = join(modules, "floe-console", "node_modules");
  const floe = pkg(join(nested, "floe"), "floe", { fastify: "*", "@scope/util": "*" }, {
    "floe-bus/dist/index.js": "bus",
    "floe-bus/dist/index.d.ts": "types",
    "floe-bus/dist/index.js.map": "map",
    "floe-cli/dist/cli.js": "cli",
  });
  pkg(join(nested, "fastify"), "fastify", { tiny: "*" }, { "index.js": "fastify" });
  pkg(join(nested, "@scope", "util"), "@scope/util", {}, { "index.js": "util" });
  // Resolved by walking up past floe-console, as Node does.
  pkg(join(modules, "tiny"), "tiny", {}, { "index.js": "tiny" });
  // Not a dependency of floe: must not be staged.
  pkg(join(nested, "ink"), "ink", {}, { "index.js": "ink" });
  return { prefix: join(base, "prefix"), floe, home: join(base, "home", ".floe") };
}

describe("staging", () => {
  it("stages only an npm-installed copy, never a checkout", async () => {
    const { floe } = consoleInstall();
    expect(isNpmInstalled(floe)).toBe(true);
    expect(isNpmInstalled(pkg(join(root(), "floe", "floe-cli"), "floe-cli"))).toBe(false);
  });

  it("resolves the runtime closure the way Node does, including hoisted and scoped packages", async () => {
    const { floe } = consoleInstall();
    const names = dependencyClosure(floe).map((dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name);
    expect(names.sort()).toEqual(["@scope/util", "fastify", "floe", "tiny"]);
  });

  it("mirrors the closure so staged packages keep resolving each other through node_modules", async () => {
    const { floe, prefix, home } = consoleInstall();
    const stage = await ensureStage(home, { packageDir: floe, version: "0.3.1", dependencyOf: "floe-console" });
    const tree = join(stage.dir, "tree");
    const staged = stage.map(join(floe, "floe-bus", "dist", "index.js"));
    expect(staged).toBe(join(tree, "node_modules", "floe-console", "node_modules", "floe", "floe-bus", "dist", "index.js"));
    expect(readFileSync(staged, "utf8")).toBe("bus");
    expect(existsSync(join(tree, "node_modules", "floe-console", "node_modules", "fastify", "index.js"))).toBe(true);
    expect(existsSync(join(tree, "node_modules", "floe-console", "node_modules", "@scope", "util", "index.js"))).toBe(true);
    expect(existsSync(join(tree, "node_modules", "tiny", "index.js"))).toBe(true);
    expect(existsSync(join(tree, "node_modules", "floe-console", "node_modules", "ink"))).toBe(false);
    // Every file is staged, including ones Node never executes.
    expect(readFileSync(`${staged.slice(0, -3)}.d.ts`, "utf8")).toBe("types");
    expect(existsSync(`${staged}.map`)).toBe(true);
    // Hard links: the staged file is the installed file, not a second copy.
    expect(statSync(staged).ino).toBe(statSync(join(floe, "floe-bus", "dist", "index.js")).ino);
    expect(stage.dir.startsWith(runtimeDir(home))).toBe(true);
    expect(prefix).toBeTruthy();
  });

  it("records the copy it snapshots, so a staged service reports that copy", async () => {
    const { floe, home } = consoleInstall();
    const stage = await ensureStage(home, { packageDir: floe, version: "0.3.1", dependencyOf: "floe-console" });
    const manifest = stageOf(stage.map(join(floe, "floe-bus", "dist", "index.js")));
    expect(manifest).toMatchObject({ kind: "floe-stage", version: "0.3.1", dependency_of: "floe-console" });
    expect(stageOf(join(floe, "floe-bus", "dist", "index.js"))).toBeNull();
  });

  it("reuses a complete stage and makes a new one when the installed files change", async () => {
    const { floe, home } = consoleInstall();
    const source = { packageDir: floe, version: "0.3.1", dependencyOf: null };
    const first = await ensureStage(home, source);
    expect((await ensureStage(home, source)).dir).toBe(first.dir);
    writeFileSync(join(floe, "floe-bus", "dist", "index.js"), "bus, reinstalled", "utf8");
    expect((await ensureStage(home, source)).dir).not.toBe(first.dir);
  });

  it("prunes stages nothing runs from, and keeps the current one and any in use", async () => {
    const { floe, home } = consoleInstall();
    const source = { packageDir: floe, version: "0.3.0", dependencyOf: null };
    const old = await ensureStage(home, source);
    writeFileSync(join(floe, "floe-cli", "dist", "cli.js"), "cli 2", "utf8");
    const inUse = await ensureStage(home, source);
    writeFileSync(join(floe, "floe-cli", "dist", "cli.js"), "cli 3", "utf8");
    const current = await ensureStage(home, source);
    const removed = pruneStages(home, current.dir, [join(inUse.dir, "tree", "x", "index.js")]);
    expect(removed).toEqual([old.dir]);
    expect(existsSync(inUse.dir)).toBe(true);
    expect(existsSync(current.dir)).toBe(true);
  });
});
