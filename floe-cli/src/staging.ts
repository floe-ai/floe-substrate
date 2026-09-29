/**
 * staging — run Floe's long-lived services from a snapshot, not the installed package.
 *
 * Windows locks a directory that a running process uses as its working
 * directory, and any native image it has loaded. npm replaces a package by
 * renaming its folder, so a Floe running from inside node_modules makes every
 * `npm install -g` of floe (or of a surface that depends on it) fail with EBUSY.
 *
 * So an npm-installed copy stages itself before starting a service: the package
 * and every package it resolves at runtime are mirrored under
 * `<home>/runtime/<version>-<fingerprint>/tree`, and the service runs from
 * there. Files are hard links, so a stage costs almost no disk and scanners see
 * files they have already seen; Windows lets npm delete the package's name for
 * a file while a process holds the staged name open. Copying is the fallback
 * when linking is impossible (e.g. another volume).
 *
 * A stage is a run snapshot of the copy that made it, never a copy of its own:
 * its stage.json records which copy that was, and `thisInstallation()` reports
 * that copy. Old stages are removed on the next start once nothing runs from them.
 *
 * A source checkout is never staged: nobody npm-installs over it, and its build
 * rewrites files in place, which would change a running stage through its links.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { copyFile, link } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { basename, dirname, join, relative, sep } from "node:path";

export const STAGE_MANIFEST = "stage.json";

export type StageManifest = {
  kind: "floe-stage";
  version: string | null;
  /** The installed package directory this stage snapshots. */
  source: string;
  /** The package whose node_modules held that copy, when it was a dependency. */
  dependency_of: string | null;
  /** Directory the mirrored tree is relative to. */
  root: string;
  created_at: string;
};

export type Stage = {
  dir: string;
  manifest: StageManifest;
  /** Map a file inside the snapshotted closure to its staged path. */
  map(path: string): string;
};

export type StageSource = {
  packageDir: string;
  version: string | null;
  dependencyOf: string | null;
};

/** Whether this copy runs from an npm install (and so must stage) rather than a checkout. */
export function isNpmInstalled(packageDir: string): boolean {
  return realpathSync(packageDir).split(sep).includes("node_modules");
}

export function runtimeDir(home: string): string {
  return join(home, "runtime");
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Resolve a package the way Node does from `fromDir`: nearest node_modules walking up. */
function resolvePackage(name: string, fromDir: string): string | null {
  let dir = fromDir;
  for (;;) {
    if (basename(dir) !== "node_modules") {
      const candidate = join(dir, "node_modules", ...name.split("/"));
      if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The package and every package it can load at runtime, as real directories. */
export function dependencyClosure(packageDir: string): string[] {
  const root = realpathSync(packageDir);
  const seen = new Set<string>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    const pkg = readJson(join(dir, "package.json")) ?? {};
    const names = new Set<string>([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]);
    for (const name of names) {
      const found = resolvePackage(name, dir);
      if (found && !seen.has(found)) {
        seen.add(found);
        queue.push(found);
      }
    }
  }
  return [...seen].sort();
}

function commonAncestor(dirs: string[]): string {
  let common = dirs[0]!.split(sep);
  for (const dir of dirs.slice(1)) {
    const parts = dir.split(sep);
    let i = 0;
    while (i < common.length && i < parts.length && common[i]!.toLowerCase() === parts[i]!.toLowerCase()) i++;
    common = common.slice(0, i);
  }
  let ancestor = common.join(sep) || sep;
  // Mirror from above any node_modules folder so staged packages keep resolving
  // each other through node_modules exactly as they did where npm put them.
  const at = ancestor.split(sep).indexOf("node_modules");
  if (at >= 0) ancestor = ancestor.split(sep).slice(0, at).join(sep);
  return ancestor;
}

/** Files of one package, excluding its own node_modules (those are closure members). */
function* packageFiles(dir: string, top = dir): Generator<{ path: string; entry: Dirent }> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === top && entry.name === "node_modules") continue;
      yield* packageFiles(path, top);
    } else if (entry.isFile()) {
      yield { path, entry };
    }
  }
}

/**
 * Every file of every package is staged: "Node never executes it" is not "no one
 * reads it" (the bridge reads its prompts, which are markdown), and a partial
 * snapshot fails only when that path runs.
 */

/**
 * Identify exactly what would be staged: every package by location and version,
 * and the stage-owning package's own files by path, size and mtime (a reinstall
 * of the same version still yields a new stage).
 */
function fingerprint(closure: string[], root: string, packageDir: string): string {
  const hash = createHash("sha256");
  for (const dir of closure) {
    hash.update(`${relative(root, dir)}@${readJson(join(dir, "package.json"))?.version ?? ""}\n`);
  }
  for (const { path } of packageFiles(packageDir)) {
    const stat = statSync(path);
    hash.update(`${relative(packageDir, path)}:${stat.size}:${stat.mtimeMs}\n`);
  }
  return hash.digest("hex").slice(0, 12);
}

async function placeFile(from: string, to: string): Promise<void> {
  try {
    await link(from, to);
  } catch (error: any) {
    if (error?.code === "EEXIST") return;
    await copyFile(from, to);
  }
}

/**
 * Link every runtime file into the tree. Creating a link is cheap for the disk
 * but each one waits on the filesystem (and any scanner watching it), so they
 * are placed concurrently rather than one after another.
 */
async function buildTree(closure: string[], root: string, tree: string): Promise<void> {
  const files: Array<[string, string]> = [];
  for (const dir of closure) {
    for (const { path } of packageFiles(dir)) files.push([path, join(tree, relative(root, path))]);
  }
  for (const target of new Set(files.map(([, to]) => dirname(to)))) mkdirSync(target, { recursive: true });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const [from, to] = files[next++]!;
      await placeFile(from, to);
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
}

function makeStage(dir: string, manifest: StageManifest): Stage {
  const tree = join(dir, "tree");
  return {
    dir,
    manifest,
    map(path: string): string {
      const real = realpathSync(path);
      const rel = relative(manifest.root, real);
      if (rel.startsWith("..")) throw new Error(`Floe cannot stage ${real}: it is outside ${manifest.root}.`);
      return join(tree, rel);
    },
  };
}

/** Create (or reuse) the stage for this copy of Floe. */
export async function ensureStage(home: string, source: StageSource): Promise<Stage> {
  const packageDir = realpathSync(source.packageDir);
  const closure = dependencyClosure(packageDir);
  const root = commonAncestor(closure);
  const id = `${source.version ?? "unversioned"}-${fingerprint(closure, root, packageDir)}`;
  const runtime = runtimeDir(home);
  const dir = join(runtime, id);
  const existing = readJson(join(dir, STAGE_MANIFEST)) as StageManifest | null;
  if (existing?.kind === "floe-stage") return makeStage(dir, existing);

  const manifest: StageManifest = {
    kind: "floe-stage",
    version: source.version,
    source: packageDir,
    dependency_of: source.dependencyOf,
    root,
    created_at: new Date().toISOString(),
  };
  // Unique per call: concurrent starts, in one process or several, each build
  // their own copy and never touch another's. The pid stays last for pruneStages.
  const partial = join(runtime, `.partial-${id}-${randomBytes(4).toString("hex")}-${process.pid}`);
  mkdirSync(partial, { recursive: true });
  await buildTree(closure, root, join(partial, "tree"));
  // The manifest is written last: a stage without one is incomplete.
  writeFileSync(join(partial, STAGE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const placed = await placeStage(partial, dir);
  return makeStage(dir, placed ?? manifest);
}

/** How long a start keeps retrying a rename that Windows refuses because a file is briefly held. */
const RENAME_PATIENCE_MS = 30_000;

/**
 * Move a finished copy into place. Returns the manifest of a stage another
 * start placed first (this copy is then discarded), or null when this copy
 * became the stage. Windows refuses a directory rename while any file in it is
 * held (a scanner reading fresh files, another start linking the same ones), so
 * a refusal is retried until the stage exists or the patience runs out.
 */
async function placeStage(partial: string, dir: string): Promise<StageManifest | null> {
  const deadline = Date.now() + RENAME_PATIENCE_MS;
  for (let wait = 25; ; wait = Math.min(wait * 2, 1_000)) {
    try {
      renameSync(partial, dir);
      return null;
    } catch (error: any) {
      const placed = readJson(join(dir, STAGE_MANIFEST)) as StageManifest | null;
      if (placed?.kind === "floe-stage") {
        discard(partial);
        return placed;
      }
      if (!["EPERM", "EACCES", "EBUSY", "ENOTEMPTY", "EEXIST"].includes(error?.code) || Date.now() >= deadline) {
        discard(partial);
        throw new Error(
          `Floe could not finish preparing its runtime copy in ${dir}: another program kept its files in use ` +
            `(${error?.code ?? "unknown"}). Close anything scanning or using that folder, then start Floe again.`,
          { cause: error },
        );
      }
      await sleep(wait);
    }
  }
}

/** Remove an unused copy. Failure is harmless: pruneStages removes it on a later start. */
function discard(partial: string): void {
  try {
    rmSync(partial, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Still held; a later start removes it.
  }
}

/**
 * The stage a module path runs from, if any: the nearest ancestor holding a
 * stage manifest with a `tree` beside it that contains the path.
 */
export function stageOf(path: string): StageManifest | null {
  let dir = path;
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) return null;
    if (basename(dir) === "tree") {
      const manifest = readJson(join(parent, STAGE_MANIFEST)) as StageManifest | null;
      if (manifest?.kind === "floe-stage") return manifest;
    }
    dir = parent;
  }
}

/**
 * Remove stages nothing runs from. `inUse` holds paths live services run from;
 * a stage containing any of them, or the current stage, is kept. Removal that
 * fails means a process still holds it; the next start tries again.
 */
export function pruneStages(home: string, keep: string, inUse: readonly string[]): string[] {
  const runtime = runtimeDir(home);
  if (!existsSync(runtime)) return [];
  const removed: string[] = [];
  const live = inUse.map((p) => p.toLowerCase());
  for (const name of readdirSync(runtime)) {
    const dir = join(runtime, name);
    if (dir.toLowerCase() === keep.toLowerCase()) continue;
    const partialPid = /^\.partial-.*-(\d+)$/.exec(name)?.[1];
    if (partialPid && isAlive(Number(partialPid))) continue;
    const prefix = `${dir}${sep}`.toLowerCase();
    if (live.some((p) => p.startsWith(prefix))) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // Still held by a process; a later start removes it.
    }
  }
  return removed;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
