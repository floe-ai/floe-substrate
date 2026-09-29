/**
 * Prove that every git-pinned dependency is what its pin says.
 *
 * A git dependency is pinned by commit in a package.json and recorded by commit
 * in package-lock.json, but neither proves what is on disk: npm can leave an
 * older copy in node_modules while both files name the new commit. A release
 * built from that copy proves and ships code nobody pinned. So this compares
 * the installed files themselves against the files npm would pack from the
 * pinned commit, and names every dependency and file that differs.
 *
 * Usage as a check: node scripts/pinned-dependencies.mjs [repo-root]
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const isWindows = process.platform === "win32";
const COMMIT = /^[0-9a-f]{40}$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isGitSpec(spec) {
  return /^(github:|gitlab:|bitbucket:|git\+|git:)/.test(spec) || /^[\w.-]+\/[\w.-]+#/.test(spec);
}

function commitOf(specOrResolved) {
  const hash = specOrResolved.split("#")[1] ?? "";
  return COMMIT.test(hash) ? hash : null;
}

/** Every git dependency named in the root or a workspace package.json. */
function declaredGitDependencies(root) {
  const rootPkg = readJson(join(root, "package.json"));
  const manifests = [["package.json", rootPkg]];
  for (const workspace of rootPkg.workspaces ?? []) {
    const path = join(root, workspace, "package.json");
    if (existsSync(path)) manifests.push([`${workspace}/package.json`, readJson(path)]);
  }
  const declared = [];
  for (const [file, pkg] of manifests) {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
        if (typeof spec === "string" && isGitSpec(spec)) declared.push({ name, spec, file });
      }
    }
  }
  return declared;
}

/** Every installed location the lockfile records as coming from git. */
function lockedGitPackages(root) {
  const lock = readJson(join(root, "package-lock.json"));
  return Object.entries(lock.packages ?? {})
    .filter(([key, entry]) => key.includes("node_modules/") && typeof entry.resolved === "string"
      && /^git(\+|:)/.test(entry.resolved))
    .map(([key, entry]) => ({ key, name: key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length), resolved: entry.resolved }));
}

/**
 * The pins agree with each other: every declared git dependency names an exact
 * commit and the lockfile resolves it to that same commit. Needs no install.
 */
export function pinProblems(root) {
  const problems = [];
  const locked = lockedGitPackages(root);
  for (const { name, spec, file } of declaredGitDependencies(root)) {
    const pinned = commitOf(spec);
    if (!pinned) {
      problems.push(`${name}: ${file} names '${spec}', which is not pinned to an exact commit.`);
      continue;
    }
    const entries = locked.filter((entry) => entry.name === name);
    if (entries.length === 0) {
      problems.push(`${name}: pinned to ${pinned} in ${file}, but package-lock.json does not record it from git.`);
    }
    for (const entry of entries) {
      const lockedCommit = commitOf(entry.resolved);
      if (lockedCommit !== pinned) {
        problems.push(`${name}: pinned to ${pinned} in ${file}, but package-lock.json resolves ${entry.key} to ${lockedCommit ?? entry.resolved}.`);
      }
    }
  }
  return problems;
}

function run(command, argv, cwd) {
  // npm is a shell shim on Windows, so it runs as one command line there.
  const result = isWindows && command === "npm"
    ? spawnSync([command, ...argv].join(" "), { cwd, encoding: "utf8", shell: true })
    : spawnSync(command, argv, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${argv.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout;
}

// Git may rewrite line endings on either checkout; the content is what matters.
function sameContent(a, b) {
  const text = (path) => readFileSync(path).toString("latin1").replace(/\r\n/g, "\n");
  return text(a) === text(b);
}

function installedFiles(dir, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...installedFiles(path, base));
    else files.push(relative(base, path).replace(/\\/g, "/"));
  }
  return files;
}

/** Differences between an installed git package and what npm packs from its pinned commit. */
function contentProblems(root, { key, name, resolved }) {
  const commit = commitOf(resolved);
  if (!commit) return [`${name}: package-lock.json records '${resolved}', which is not an exact commit.`];
  const installed = join(root, key);
  if (!existsSync(installed)) return [`${name}: pinned to ${commit} but not installed at ${key}.`];
  const work = mkdtempSync(join(tmpdir(), "floe-pinned-"));
  try {
    const url = resolved.split("#")[0].replace(/^git\+/, "");
    run("git", ["init", "--quiet", work], root);
    run("git", ["-C", work, "fetch", "--quiet", "--depth", "1", url, commit], root);
    run("git", ["-C", work, "checkout", "--quiet", "FETCH_HEAD"], root);
    const packed = JSON.parse(run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], work))[0]
      .files.map((file) => file.path);
    const differing = [];
    for (const file of packed) {
      const there = join(installed, file);
      if (!existsSync(there)) differing.push(`${file} (missing)`);
      else if (!sameContent(join(work, file), there)) differing.push(`${file} (differs)`);
    }
    const expected = new Set(packed);
    for (const file of installedFiles(installed)) {
      if (!expected.has(file)) differing.push(`${file} (not in the pinned commit)`);
    }
    if (differing.length === 0) return [];
    const shown = differing.slice(0, 5).join(", ") + (differing.length > 5 ? `, and ${differing.length - 5} more` : "");
    return [`${name}: the installed copy at ${key} is not pinned commit ${commit}: ${shown}.`];
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Every problem with the git-pinned dependencies installed under root: pins
 * that disagree, and installed copies that are not their pinned commit.
 * floe-runtime is checked first because it carries the engine.
 */
export function pinnedDependencyProblems(root) {
  const problems = pinProblems(root);
  const locked = lockedGitPackages(root)
    .sort((a, b) => Number(b.name === "floe-runtime") - Number(a.name === "floe-runtime"));
  for (const entry of locked) problems.push(...contentProblems(root, entry));
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? join(fileURLToPath(new URL("..", import.meta.url))));
  if (!statSync(root).isDirectory()) throw new Error(`${root} is not a directory`);
  const problems = pinnedDependencyProblems(root);
  if (problems.length > 0) {
    console.error("Git-pinned dependencies do not match their pins:\n  - " + problems.join("\n  - "));
    process.exit(1);
  }
  console.log("Every git-pinned dependency matches its pinned commit.");
}
