#!/usr/bin/env node
/**
 * Floe release — assemble the single installable Floe package and prove it runs.
 *
 * Floe is authored as three source packages (floe-cli, floe-bus, floe-bridge) in
 * one workspace, but they are never independently useful and always the same
 * version. Distributing them as three packages is what every install problem so
 * far has come from: a workspaces root cannot be installed globally, a git
 * subdirectory cannot be installed at all, and three sibling packages have to
 * find each other. So the shipped artifact collapses them into ONE plain package
 * (no `workspaces` field) with one `floe` bin, the built dist of all three as
 * sibling subdirectories, and a generated package.json whose dependencies are the
 * real union of the three — the thing npm actually resolves on install.
 *
 * This script is the source of truth for what a user receives. A person can run
 * it locally and inspect the staged package before anything is published; CI on a
 * version tag calls this and nothing more, so the release path can never drift
 * from what you get by hand.
 *
 * Order of operations (each a gate — a failure aborts, nothing is published):
 *   1. build every service package from source (a package whose dist did not
 *      build cannot ship);
 *   2. assemble the single package with a generated union-deps package.json;
 *   3. GUARD: pack it, install it globally into an isolated prefix from a working
 *      directory unrelated to this checkout, and start Floe from that install —
 *      refuse to publish an artifact that installs but cannot start;
 *   4. publish (only with --publish): commit the generated artifact to a clone of
 *      the distribution repo and push.
 *
 * Usage:
 *   node scripts/release.mjs [--version <v>] [--out <dir>] [--publish]
 *                            [--dist-repo <path-or-url>] [--keep]
 *
 * The generated package.json is generated every run and never hand-edited: it is
 * derived from the source packages, so it takes whatever the services become.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const isWindows = process.platform === "win32";

// The source packages that compose the single shipped artifact. floe-cli carries
// the `floe` bin; floe-bus and floe-bridge are the substrate services it starts.
// Their identity is stable; their contents and dependencies are read live below,
// so the artifact takes whatever the services become.
const SERVICE_PACKAGES = ["floe-cli", "floe-bus", "floe-bridge"];
const BIN_PACKAGE = "floe-cli";
const PACKAGE_NAME = "floe";
// Which built assets each source package contributes to the artifact. Everything
// runtime deps provide (fastify, sharp, quickjs, …) is resolved by npm from the
// generated package.json, not copied here.
const SHIPPED = {
  "floe-cli": ["dist", "native", "README.md"],
  "floe-bus": ["dist"],
  "floe-bridge": ["dist"],
};

// ── argument parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name) {
  return args.includes(`--${name}`);
}
function value(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const doPublish = flag("publish");
const keepStaging = flag("keep");
const distRepo = value("dist-repo", "https://github.com/floe-ai/floe.git");
const outDir = resolve(value("out", join(repoRoot, "dist-release")));

// ── helpers ──────────────────────────────────────────────────────────────────

function log(step, message) {
  console.log(`\n[release:${step}] ${message}`);
}

function fail(message) {
  console.error(`\n[release] ABORTED — ${message}`);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function runNpm(argv, cwd, opts = {}) {
  // npm is a shell shim on Windows; execFileSync with shell handles the .cmd.
  const result = spawnSync(npm, argv, { cwd, stdio: "inherit", shell: isWindows, ...opts });
  if (result.status !== 0) {
    throw new Error(`npm ${argv.join(" ")} failed (exit ${result.status ?? "signal"})`);
  }
}

// ── 1. resolve version ───────────────────────────────────────────────────────

function resolveVersion() {
  const explicit = value("version");
  if (explicit) return explicit.replace(/^v/, "");
  // Fall back to the bin package's version so a local run always produces a
  // valid, inspectable artifact without needing a tag.
  const pkg = readJson(join(repoRoot, BIN_PACKAGE, "package.json"));
  return pkg.version;
}

// ── 2. build every service from source ───────────────────────────────────────

function buildServices() {
  for (const pkg of SERVICE_PACKAGES) {
    log("build", `building ${pkg}…`);
    try {
      // Workspaces are enabled here (we run from the checkout), so the workspace
      // toolchain builds each package. A build failure is fatal: shipping a
      // package whose dist did not build is exactly the silent install that
      // starts but cannot run.
      runNpm(["run", "build", "--workspace", pkg], repoRoot);
    } catch {
      fail(
        `${pkg} failed to build, so the release cannot ship it. Fix ${pkg}'s build ` +
          `(see the compiler output above) and re-run the release.`,
      );
    }
  }
}

// ── 3. compute the union of runtime dependencies ─────────────────────────────

function unionDependencies() {
  const merged = {};
  for (const pkg of SERVICE_PACKAGES) {
    const deps = readJson(join(repoRoot, pkg, "package.json")).dependencies ?? {};
    for (const [name, range] of Object.entries(deps)) {
      // A source package never depends on a sibling by name (the CLI resolves the
      // bus and bridge by path inside the artifact), so drop any that appear.
      if (SERVICE_PACKAGES.includes(name)) continue;
      if (merged[name] && merged[name] !== range) {
        fail(
          `dependency version conflict for ${name}: ${merged[name]} vs ${range}. ` +
            `The single package cannot carry two versions — align it in the source ` +
            `package.json files before releasing.`,
        );
      }
      merged[name] = range;
    }
  }
  // Deterministic key order so the generated file is stable across runs.
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
}

// ── 4. assemble the single package ───────────────────────────────────────────

function assemble(version) {
  log("assemble", `staging the single \`${PACKAGE_NAME}\` package at ${outDir}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  for (const pkg of SERVICE_PACKAGES) {
    for (const asset of SHIPPED[pkg]) {
      const from = join(repoRoot, pkg, asset);
      if (!existsSync(from)) {
        if (asset === "README.md") continue; // optional
        fail(`expected built asset ${pkg}/${asset} is missing after build.`);
      }
      cpSync(from, join(outDir, pkg, asset), { recursive: true });
    }
  }

  // The bin lives inside the bin package's shipped dist. Point the generated
  // package.json at that path within the artifact.
  const binEntry = `${BIN_PACKAGE}/dist/index.js`;
  if (!existsSync(join(outDir, binEntry))) {
    fail(`bin entry ${binEntry} is missing from the staged artifact.`);
  }

  const generated = {
    name: PACKAGE_NAME,
    version,
    description: "Floe — the local substrate and its command line, as one installable package.",
    license: "UNLICENSED",
    // Not private: this is the shipped artifact and must be installable/publishable.
    private: false,
    type: "module",
    bin: { [PACKAGE_NAME]: binEntry },
    engines: { node: ">=20" },
    // The real, resolvable union of the source packages' runtime dependencies —
    // this is what npm installs, and what the sibling-tarball path provided that
    // a workspaces-root git install never could.
    dependencies: unionDependencies(),
  };
  writeFileSync(
    join(outDir, "package.json"),
    JSON.stringify(generated, null, 2) + "\n",
    "utf8",
  );

  // A short README so a stranger landing in the artifact repo is not staring at
  // an opaque bundle. Generated, like everything else here.
  writeFileSync(
    join(outDir, "README.md"),
    `# Floe\n\nGenerated distribution artifact — do not edit by hand.\n\n` +
      `Install:\n\n    npm install -g github:floe-ai/floe\n\nThen open a new shell and run \`floe\`.\n\n` +
      `This package is produced by \`npm run release\` in floe-ai/floe-substrate; ` +
      `its source lives there, not here.\n`,
    "utf8",
  );

  log("assemble", `staged ${PACKAGE_NAME}@${version} with ${Object.keys(generated.dependencies).length} runtime deps`);
  return generated;
}

// ── 5. guard: install the artifact and prove it starts ───────────────────────

function guard(version) {
  log("guard", "packing, installing into an isolated prefix, and starting Floe from that install");
  const workRoot = mkdtempSync(join(tmpdir(), "floe-release-guard-"));
  const prefix = join(workRoot, "prefix");
  const home = join(workRoot, "home");
  const neutralCwd = join(workRoot, "elsewhere");
  mkdirSync(prefix, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(neutralCwd, { recursive: true });

  // A config isolated from the operator's ~/.floe: its own home, and a distinct
  // port so a bus the operator is already running is not disturbed and cannot
  // masquerade as ours.
  const port = 5399;
  const configPath = join(workRoot, "config.yaml");
  writeFileSync(
    configPath,
    [
      "schema: floe.local.v1",
      "version: 1",
      `home: ${JSON.stringify(home)}`,
      "services:",
      "  start_on_demand: true",
      "  manager: auto",
      "bus:",
      `  listen: 127.0.0.1:${port}`,
      `  http_base_url: http://127.0.0.1:${port}`,
      `  ws_base_url: ws://127.0.0.1:${port}`,
      "  data_dir: ./bus",
      "  log_dir: ./logs/bus",
      "bridge:",
      "  data_dir: ./bridge",
      "  log_dir: ./logs/bridge",
      `  bus_url: ws://127.0.0.1:${port}`,
      "  workspace_access:",
      "    local_paths: true",
      "library:",
      "  configs_dir: ./configs",
      "  skills_dir: ./skills",
      "  extensions_dir: ./extensions",
      "  mcp_dir: ./mcp",
      "  templates_dir: ./templates",
      "",
    ].join("\n"),
    "utf8",
  );

  try {
    // Pack the staged package, then install THAT tarball globally into the
    // isolated prefix — a real extracted install, not a link to the checkout.
    runNpm(["pack", "--pack-destination", workRoot], outDir);
    const tarball = readdirSync(workRoot).find((n) => n.endsWith(".tgz"));
    if (!tarball) throw new Error("npm pack produced no tarball");
    runNpm(["install", "-g", join(workRoot, tarball), `--prefix`, prefix], neutralCwd);

    const floeBin = isWindows ? join(prefix, "floe.cmd") : join(prefix, "bin", "floe");
    if (!existsSync(floeBin)) throw new Error(`installed floe bin not found at ${floeBin}`);

    // Start Floe FROM THE INSTALL, in a directory unrelated to the repo — the
    // exact thing that masked the last false green. `start` brings the bus up
    // (health-gated) and then the bridge.
    log("guard", `starting Floe from ${floeBin} (cwd: ${neutralCwd})`);
    const started = spawnSync(floeBin, ["--config", configPath, "start"], {
      cwd: neutralCwd,
      stdio: "inherit",
      shell: isWindows,
    });

    // The substrate is served by the bus; confirm real health rather than a
    // spawned process. This is the claim the install exists to make good.
    const healthy = checkBusHealth(port);
    if (!healthy) {
      dumpBusLog(home);
      throw new Error(
        `Floe did not become healthy at http://127.0.0.1:${port} after installing the ` +
          `artifact and running \`floe start\` from a neutral directory.`,
      );
    }
    if (started.status !== 0) {
      dumpBusLog(home);
      throw new Error(
        `\`floe start\` exited ${started.status} even though the bus became healthy — ` +
          `the substrate did not come up completely from the installed artifact.`,
      );
    }
    log("guard", "PASS — Floe installed from the artifact and came up healthy from a neutral directory");
  } finally {
    // Best-effort stop, then remove all isolated state.
    try {
      const floeBin = isWindows ? join(prefix, "floe.cmd") : join(prefix, "bin", "floe");
      if (existsSync(floeBin)) {
        spawnSync(floeBin, ["--config", configPath, "stop"], { cwd: neutralCwd, stdio: "ignore", shell: isWindows });
      }
    } catch {}
    rmSync(workRoot, { recursive: true, force: true });
  }
}

function checkBusHealth(port) {
  // Poll /health briefly. This is a client of an HTTP server that has no push
  // readiness channel to a separate process, so polling is the honest mechanism
  // here — stated plainly rather than dressed up.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const res = spawnSync(
      process.execPath,
      ["-e", `fetch('http://127.0.0.1:${port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`],
      { stdio: "ignore" },
    );
    if (res.status === 0) return true;
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{}, 500)"], { stdio: "ignore" });
  }
  return false;
}

function dumpBusLog(home) {
  const log = join(home, "logs", "bus", "bus.log");
  console.error(`\n[release:guard] bus log (${log}):`);
  console.error(existsSync(log) ? readFileSync(log, "utf8") : "(no bus log written)");
}

// ── 6. publish ───────────────────────────────────────────────────────────────

function publish(version) {
  log("publish", `committing the generated artifact to ${distRepo}`);
  const workRoot = mkdtempSync(join(tmpdir(), "floe-release-publish-"));
  const clone = join(workRoot, "floe");
  try {
    execFileSync("git", ["clone", "--depth", "1", distRepo, clone], { stdio: "inherit" });
    // Replace everything tracked except .git with the freshly staged artifact.
    for (const entry of readdirSync(clone)) {
      if (entry === ".git") continue;
      rmSync(join(clone, entry), { recursive: true, force: true });
    }
    for (const entry of readdirSync(outDir)) {
      cpSync(join(outDir, entry), join(clone, entry), { recursive: true });
    }
    execFileSync("git", ["add", "-A"], { cwd: clone, stdio: "inherit" });
    execFileSync("git", ["commit", "-m", `Release floe ${version}`], { cwd: clone, stdio: "inherit" });
    execFileSync("git", ["push", "origin", "HEAD"], { cwd: clone, stdio: "inherit" });
    log("publish", `pushed floe ${version} to ${distRepo}`);
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const version = resolveVersion();
log("start", `building floe ${version} (publish: ${doPublish ? "yes" : "no"})`);
buildServices();
assemble(version);
guard(version);
if (doPublish) {
  publish(version);
} else {
  log("done", `staged and verified at ${outDir}. Re-run with --publish to push to the distribution repo.`);
}
if (!keepStaging && !doPublish) {
  // Leave the staging dir for inspection unless asked otherwise; --keep is the
  // default-friendly no-op kept for symmetry with publish runs.
}
