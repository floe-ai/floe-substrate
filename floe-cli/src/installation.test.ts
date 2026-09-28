import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPackageDir } from "./installation.js";
import { describeVersionMismatch } from "./startup.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function pkg(dir: string, name: string, version = "1.0.0"): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }), "utf8");
  return dir;
}

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "floe-install-"));
  roots.push(dir);
  return dir;
}

describe("installation location rule", () => {
  it("treats a global install as direct (the prefix holding node_modules is not a package)", () => {
    const floe = pkg(join(root(), "prefix", "node_modules", "floe"), "floe", "0.2.1");
    expect(classifyPackageDir(floe)).toMatchObject({ version: "0.2.1", dependencyOf: null });
  });

  it("treats a copy inside another package's node_modules as a dependency", () => {
    const global = join(root(), "prefix", "node_modules");
    pkg(join(global, "floe-console"), "floe-console");
    const nested = pkg(join(global, "floe-console", "node_modules", "floe"), "floe", "0.2.0");
    expect(classifyPackageDir(nested)).toMatchObject({ version: "0.2.0", dependencyOf: "floe-console" });
  });

  it("sees through a scope directory", () => {
    const owner = pkg(join(root(), "app"), "@acme/app");
    const nested = pkg(join(owner, "node_modules", "@floe", "floe"), "@floe/floe");
    expect(classifyPackageDir(nested).dependencyOf).toBe("@acme/app");
  });

  it("treats a source checkout as direct", () => {
    const checkout = pkg(join(root(), "floe", "floe-cli"), "floe-cli");
    expect(classifyPackageDir(checkout).dependencyOf).toBeNull();
  });
});

describe("version mismatch", () => {
  const url = "http://127.0.0.1:5377";

  it("says nothing when versions match", () => {
    expect(describeVersionMismatch(url, "0.2.1", "0.2.1")).toBeNull();
  });

  it("names both versions and does not offer to restart", () => {
    const message = describeVersionMismatch(url, "0.2.1", "0.3.0")!;
    expect(message).toContain("Floe 0.3.0");
    expect(message).toContain("this copy is Floe 0.2.1");
    expect(message).toContain("left as is");
  });

  it("tells the person a newer Floe is installed after an upgrade, and how to switch", () => {
    const message = describeVersionMismatch(url, "0.3.1", "0.3.0")!;
    expect(message).toContain("a newer Floe is installed");
    expect(message).toContain("Floe 0.3.0 is still running");
    expect(message).toContain("`floe restart`");
  });

  it("reports a bus too old to state its version", () => {
    expect(describeVersionMismatch(url, "0.2.1", null)).toContain("does not report its version");
  });
});
