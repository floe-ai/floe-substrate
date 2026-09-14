import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";

/** Ship sharp's installed production dependency closure, including this host's decoder. */
export function packageImageRuntime(appRoot, resourcePath) {
  const expectedResources = resolve(appRoot, "src-tauri", "resources");
  assert.equal(realpathSync(resourcePath), realpathSync(expectedResources));
  const output = resolve(resourcePath, "node_modules");
  assert.equal(dirname(output), resolve(expectedResources));
  assert(output.startsWith(resolve(appRoot) + sep));
  // This is only the checked build-output directory, never the checkout's npm tree.
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const packages = new Map();
  function copy(name, from, optional = false) {
    const path = createRequire(from).resolve.paths(name)
      ?.map(base => join(base, name, "package.json")).find(existsSync);
    if (!path) {
      if (optional) return;
      throw new Error(`Missing installed image dependency: ${name}`);
    }
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (optional && ((manifest.os && !manifest.os.includes(process.platform))
      || (manifest.cpu && !manifest.cpu.includes(process.arch)))) return;
    if (packages.has(name)) {
      assert.equal(packages.get(name), manifest.version, `Conflicting image dependency versions: ${name}`);
      return;
    }
    packages.set(name, manifest.version);
    cpSync(dirname(path), join(output, name), { recursive: true });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) copy(dependency, path);
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) copy(dependency, path, true);
  }
  copy("sharp", resolve(appRoot, "..", "floe-bridge", "package.json"));
  return packages;
}
