/**
 * installation — what this copy of Floe is, read from where it actually lives.
 *
 * Two copies of Floe can exist on one machine: one a person installed directly
 * (`npm install -g github:floe-ai/floe`, or a source checkout), and one that
 * arrived as a dependency of a surface (e.g. inside floe-console's
 * node_modules). Both can serve and connect. Only the direct copy may install
 * anything the machine owns (start-at-login first), because a dependency's copy
 * disappears when its parent is uninstalled and would silently break it.
 *
 * Rule: a copy is a dependency when its package directory sits in a
 * node_modules folder that belongs to another package — the folder holding that
 * node_modules has a package.json. A global install's node_modules belongs to
 * the npm prefix, which is not a package; a checkout is not in node_modules at
 * all. Nothing is passed in: location is the only input, so it cannot be lied to.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Installation = {
  /** Directory of the package this copy shipped in. */
  packageDir: string;
  version: string | null;
  /** The package whose node_modules holds this copy, when it is a dependency. */
  dependencyOf: string | null;
};

/** Nearest ancestor directory containing a package.json. */
function nearestPackageDir(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readPackage(dir: string): { name?: string; version?: string } {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return {};
  }
}

/** Classify a package directory by its location. Exported for tests. */
export function classifyPackageDir(packageDir: string): Installation {
  const pkg = readPackage(packageDir);
  const version = typeof pkg.version === "string" ? pkg.version : null;
  // A scoped package lives at node_modules/@scope/name.
  let holder = dirname(packageDir);
  if (basename(holder).startsWith("@")) holder = dirname(holder);
  if (basename(holder) !== "node_modules") return { packageDir, version, dependencyOf: null };
  const owner = dirname(holder);
  if (!existsSync(join(owner, "package.json"))) return { packageDir, version, dependencyOf: null };
  const ownerName = readPackage(owner).name;
  return { packageDir, version, dependencyOf: typeof ownerName === "string" ? ownerName : owner };
}

let cached: Installation | undefined;

export function thisInstallation(): Installation {
  if (cached) return cached;
  const moduleDir = realpathSync(dirname(fileURLToPath(import.meta.url)));
  const packageDir = nearestPackageDir(moduleDir) ?? moduleDir;
  cached = classifyPackageDir(packageDir);
  return cached;
}

export function directInstallRequiredMessage(installation: Installation): string {
  return (
    `This copy of Floe was installed as part of ${installation.dependencyOf}, so it cannot set up\n`
    + `start-at-login: uninstalling ${installation.dependencyOf} would remove it and silently break\n`
    + `start-at-login. Install Floe directly for that, then run \`floe service install\`:\n`
    + `  npm install -g github:floe-ai/floe`
  );
}
