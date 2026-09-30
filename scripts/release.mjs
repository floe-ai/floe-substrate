#!/usr/bin/env node
/**
 * @invariant A release cannot publish until the installed artifact completes
 * its real identity and Actor turns and 20 consecutive mid-command pauses
 * produce no completion marker after Floe reports paused. Every resumed turn
 * must settle as completed; a pushed failure ends the gate immediately.
 *
 * Floe release — assemble the single installable Floe package and prove it runs.
 *
 * Floe is authored as three source packages (floe-cli, floe-bus, floe-bridge) in
 * one workspace, but they are never independently useful and always the same
 * version. Distributing them as three packages is what every install problem so
 * far has come from: a workspaces root cannot be installed globally, a git
 * subdirectory cannot be installed at all, and three sibling packages have to
 * find each other. So the shipped artifact collapses them into ONE plain package
 * (no `workspaces` field) with one `floe` bin, each of the three bundled into its
 * own sibling subdirectory, and a generated package.json whose dependencies are
 * only the packages the bundles must leave installed (see EXTERNAL).
 *
 * This script is the source of truth for what a user receives. A person can run
 * it locally and inspect the staged package before anything is published; CI on a
 * version tag calls this and nothing more, so the release path can never drift
 * from what you get by hand.
 *
 * Order of operations (each a gate — a failure aborts, nothing is published):
 *   0. source: clone the commit being released (HEAD; with --publish it must be
 *      on origin/main) into a temporary folder, refuse git dependencies whose
 *      package.json pin and lockfile disagree, install with `npm ci`, and rerun
 *      this script inside the clone. There it refuses unless the clone is
 *      unmodified and every git-pinned dependency's installed files are exactly
 *      its pinned commit (scripts/pinned-dependencies.mjs). Nothing below reads
 *      this machine's working tree or node_modules;
 *   1. build every service package from source (a package whose dist did not
 *      build cannot ship);
 *   2. assemble the single package: bundle each service, generate package.json;
 *   3. GUARD: pack it, install it globally into an isolated prefix from a working
 *      directory unrelated to this checkout, start Floe from that install, invoke
 *      one real operation through its `floe operations invoke` CLI, and
 *      complete one real turn through its own Bridge as this machine's Copilot
 *      account in a committed git workspace, leaving git status clean, create,
 *      publish and bind a new Actor and see its own real turn
 *      complete, then pause a real turn mid-command and resume it — refuse to
 *      publish an artifact that installs but cannot start, cannot run a turn,
 *      dirties the person's tracked files during a turn,
 *      cannot host an Actor created at runtime, or cannot interrupt and resume
 *      a turn;
 *   4. publish (only with --publish): commit the generated artifact to a clone of
 *      the distribution repo, tag it v<version>, and push both. A version that
 *      is already tagged there is refused before anything is built.
 *
 * Usage:
 *   node scripts/release.mjs [--version <v>] [--out <dir>] [--publish]
 *                            [--dist-repo <path-or-url>]
 *
 * The generated package.json is generated every run and never hand-edited: it is
 * derived from the source packages, so it takes whatever the services become.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
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
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pinnedDependencyProblems, pinProblems } from "./pinned-dependencies.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_COMMIT_ENV = "FLOE_RELEASE_SOURCE_COMMIT";
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

// ── 0. source: one commit, cleanly installed ─────────────────────────────────

function git(argv, cwd = repoRoot) {
  return execFileSync("git", argv, { cwd, encoding: "utf8" }).trim();
}

function failWithProblems(heading, problems) {
  fail(`${heading}\n  - ${problems.join("\n  - ")}`);
}

function releaseFromCleanClone() {
  const commit = git(["rev-parse", "HEAD"]);
  if (git(["status", "--porcelain"])) {
    log("source", "this checkout has uncommitted changes; they are not part of the release, which is built from the commit alone");
  }
  if (doPublish) {
    git(["fetch", "--quiet", "origin", "main"]);
    const onMain = spawnSync("git", ["merge-base", "--is-ancestor", commit, "origin/main"], { cwd: repoRoot }).status === 0;
    if (!onMain) fail(`commit ${commit} is not on origin/main. Merge it before publishing, so the release is a commit anyone can check out.`);
  }
  const workRoot = mkdtempSync(join(tmpdir(), "floe-release-source-"));
  const source = join(workRoot, "floe");
  log("source", `cloning commit ${commit} into ${source}`);
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", "--no-checkout", repoRoot, source], { stdio: "inherit" });
  execFileSync("git", ["checkout", "--quiet", "--detach", commit], { cwd: source, stdio: "inherit" });
  const pins = pinProblems(source);
  if (pins.length > 0) {
    rmSync(workRoot, { recursive: true, force: true });
    failWithProblems(`commit ${commit} pins git dependencies inconsistently:`, pins);
  }
  log("source", "installing exactly what package-lock.json records (npm ci)");
  try {
    runNpm(["ci", "--no-audit", "--no-fund"], source);
  } catch (error) {
    rmSync(workRoot, { recursive: true, force: true });
    fail(`a clean install of commit ${commit} failed: ${error.message}`);
  }
  const innerArgs = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--out") i += 1;
    else innerArgs.push(args[i]);
  }
  const inner = spawnSync(process.execPath, [join(source, "scripts", "release.mjs"), ...innerArgs, "--out", outDir], {
    cwd: source,
    stdio: "inherit",
    env: { ...process.env, [SOURCE_COMMIT_ENV]: commit },
  });
  if (inner.status === 0) rmSync(workRoot, { recursive: true, force: true });
  else log("source", `the release failed; its clone is kept at ${source} for inspection`);
  process.exit(inner.status ?? 1);
}

function requireCleanSource() {
  const commit = process.env[SOURCE_COMMIT_ENV];
  if (git(["rev-parse", "HEAD"]) !== commit || git(["status", "--porcelain"])) {
    fail(`this run must be inside an unmodified clone of commit ${commit}. Run \`npm run release\` from a checkout; it makes the clone.`);
  }
  log("source", "checking every git-pinned dependency installed here against its pinned commit");
  const problems = pinnedDependencyProblems(repoRoot);
  if (problems.length > 0) failWithProblems("git-pinned dependencies do not match their pins, so this build would not be what was pinned:", problems);
  log("source", "PASS — every git-pinned dependency is its pinned commit");
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

// ── 4. assemble the single package ───────────────────────────────────────────

// Each service ships as bundles, not as its dist tree plus node_modules. A first
// start reads every file a service loads, and on Windows each freshly installed
// file is scanned on first read: unbundled, the bus alone read ~2,000 files and
// took 4.8s to load cold against 0.34s as one bundle. Fewer files also make the
// run stage (floe-cli/src/staging.ts) cheap to build.
//
// Entries are the files something starts by path: the bin, each service, the
// library a surface imports, and any sibling script a module launches via
// `new URL("./x.js", import.meta.url)` (found by scanning, so a new one is
// picked up). Every bundle is written where its unbundled file was, so lookups
// relative to a module's own file (prompts, the native broker, host scripts)
// resolve exactly as before. Code shared between entries is split into chunks
// beside them rather than duplicated.
const ENTRIES = {
  "floe-cli": ["index.js", "identity/agent-main.js", "identity/client.js", "engines/client.js"],
  "floe-bus": ["index.js", "actor-definition-contract.js"],
  "floe-bridge": ["index.js"],
};
// Packages the bundles must not absorb, with why. They stay real installed
// packages and become the artifact's only dependencies.
const EXTERNAL = {
  "@github/copilot-sdk": "locates and loads its platform package's native runtime (runtime.node) by resolution",
  // The official CLI Floe launches for the vendor's own sign-in. Its native
  // binary lives in a platform package npm picks at install time.
  "@github/copilot": "the Bridge resolves its platform binary by package resolution",
};
// Imported only in development, behind a guard: left unresolved in the bundle,
// exactly as it is absent from an install.
const DEV_ONLY = ["@jitl/quickjs-singlefile-mjs-debug-asyncify"];

function launchedSiblings(distDir) {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".js") && !entry.name.includes(".test.")) {
        for (const match of readFileSync(path, "utf8").matchAll(/new URL\(\s*["'](\.\/[\w./-]+\.js)["']\s*,\s*import\.meta\.url\s*\)/g)) {
          found.add(relative(distDir, join(dirname(path), match[1])).replace(/\\/g, "/"));
        }
      }
    }
  };
  walk(distDir);
  return [...found];
}

function bundle() {
  const require = createRequire(join(repoRoot, "package.json"));
  const esbuild = require("esbuild");
  for (const pkg of SERVICE_PACKAGES) {
    const distDir = join(repoRoot, pkg, "dist");
    const entries = [...new Set([...ENTRIES[pkg], ...launchedSiblings(distDir)])];
    const result = esbuild.buildSync({
      entryPoints: entries.map((entry) => ({ in: join(distDir, entry), out: entry.replace(/\.js$/, "") })),
      outdir: join(outDir, pkg, "dist"),
      bundle: true,
      splitting: true,
      format: "esm",
      platform: "node",
      target: `node${process.versions.node.split(".")[0]}`,
      // Chunks sit at the dist root: shared code that resolves paths from its own
      // file (import.meta.url) must see the same directory it was built for.
      chunkNames: "[name]-[hash]",
      external: [...Object.keys(EXTERNAL), ...DEV_ONLY],
      // CommonJS dependencies inside an ES module bundle still call require().
      banner: { js: "import { createRequire as __floeCreateRequire } from 'node:module'; const require = __floeCreateRequire(import.meta.url);" },
      logLevel: "silent",
      metafile: true,
    });
    for (const warning of result.warnings) console.warn(`[release:bundle] ${pkg}: ${warning.text}`);
    log("bundle", `${pkg}: ${entries.join(", ")} → ${Object.keys(result.metafile.outputs).length} files`);
  }
  // Pin each external to the exact version this build resolved and tested.
  const pinned = {};
  for (const name of Object.keys(EXTERNAL)) {
    const manifest = join(repoRoot, "node_modules", ...name.split("/"), "package.json");
    if (!existsSync(manifest)) fail(`external package ${name} is not installed in the checkout; run npm install.`);
    pinned[name] = readJson(manifest).version;
  }
  return pinned;
}

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
      // Built JavaScript is not copied: bundle() replaces it with one bundle per
      // entry. Everything else a dist carries (prompts, declarations) ships.
      cpSync(from, join(outDir, pkg, asset), {
        recursive: true,
        filter: (path) =>
          !/\.js(\.map)?$/.test(path)
          && !/\.test\.d\.ts$/.test(path)
          && (
            pkg !== "floe-bus"
            || !path.endsWith(".d.ts")
            || path.endsWith("actor-definition-contract.d.ts")
          ),
      });
    }
  }
  const external = bundle();

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
    // Public library entries used by surfaces. `./package.json` stays exported:
    // surfaces resolve it to find the bin.
    exports: {
      "./identity": {
        types: `./${BIN_PACKAGE}/dist/identity/client.d.ts`,
        default: `./${BIN_PACKAGE}/dist/identity/client.js`,
      },
      // Engine readiness and sign-in (docs/reference/engine-control-protocol.md).
      "./engines": {
        types: `./${BIN_PACKAGE}/dist/engines/client.d.ts`,
        default: `./${BIN_PACKAGE}/dist/engines/client.js`,
      },
      "./actors": {
        types: "./floe-bus/dist/actor-definition-contract.d.ts",
        default: "./floe-bus/dist/actor-definition-contract.js",
      },
      "./package.json": "./package.json",
    },
    engines: { node: ">=20" },
    // Only what the bundles leave external is installed by npm: packages that
    // must stay packages (see EXTERNAL), at the exact versions this build used.
    dependencies: external,
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

async function guard(version) {
  log("guard", "packing, installing into an isolated prefix, and starting Floe from that install");
  const workRoot = mkdtempSync(join(tmpdir(), "floe-release-guard-"));
  const prefix = join(workRoot, "prefix");
  const home = join(workRoot, "home");
  const neutralCwd = join(workRoot, "elsewhere");
  mkdirSync(prefix, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(neutralCwd, { recursive: true });
  // A release must complete a real turn, built by the installed Bridge exactly
  // as a user's is. The install's own Copilot folder gets this machine's login
  // pointer (which account, never a token and never a sign-in); a machine with
  // no Copilot login cannot release.
  const { pointAtMachineLogin } = await import(
    pathToFileURL(join(repoRoot, "floe-bridge", "dist", "test-support", "machine-copilot-login.js")).href
  );
  const account = pointAtMachineLogin(join(home, "bridge", "copilot"));
  log("guard", `the installed Bridge will run its real turn as ${account.label}`);

  // Anything else that looks for a Copilot home gets an isolated one: the guard
  // must never change the operator's Copilot sign-in.
  process.env.COPILOT_HOME = join(workRoot, "copilot-home");
  mkdirSync(process.env.COPILOT_HOME, { recursive: true });

  // A config isolated from the operator's ~/.floe: its own home, and a distinct
  // port so a bus the operator is already running is not disturbed and cannot
  // masquerade as ours.
  const port = Number.parseInt(process.env.FLOE_RELEASE_GUARD_PORT || "5399", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("FLOE_RELEASE_GUARD_PORT must be a valid TCP port.");
  }
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

    // The identity agent is Floe's fourth service. `floe status` must see it
    // answering, and a real surface — a separate package that depends on this
    // artifact and imports only its public `floe/identity` entry — must be able
    // to create, lock, unlock and get a working bearer through it.
    const status = spawnSync(floeBin, ["--config", configPath, "status"], { cwd: neutralCwd, encoding: "utf8", shell: isWindows });
    process.stdout.write(status.stdout ?? "");
    if (!/identity agent: answering/.test(status.stdout ?? "")) {
      dumpLog(home, "identity");
      throw new Error("`floe status` does not show the identity agent answering after `floe start`.");
    }
    requireBridgeRunning({ floeBin, configPath, neutralCwd, home, when: "after `floe start`" });
    requireCopilotCli(home);
    log("guard", "PASS — the official Copilot CLI shipped with the artifact and runs from the install");
    guardReusedBridgePid({ floeBin, configPath, neutralCwd, home });
    log("guard", "PASS — with the Bridge's recorded pid reused by an unrelated live program, `floe start` brought the Bridge back and left that program untouched");
    guardSurface({ workRoot, tarball: join(workRoot, tarball), configPath, port, neutralCwd, home, account, floeBin });
    log("guard", `PASS — a surface depending on the artifact used the identity agent, a real turn completed as ${account.label} and left git status clean, an Actor recalled its Context after a Bridge restart, an Actor created at runtime completed its own real turn and its next stop ran on its own model, a person read each Actor's tools and access, a failing step was pushed as failed with a safe reason, a step's reply was handed on as its one required output, a step missing output got one reminder then completed or failed, a judge's reply matched its Port's schema, routes with a misspelt schema or a judge that is its builder were refused, a route start waited for a person's approval, a real turn paused mid-command and resumed with its tool call pushed live and its model and tools readable afterwards, and a version switch saw the running turn`);
    guardUpgradeWhileRunning({ tarball: join(workRoot, tarball), prefix, port, neutralCwd, home });
    requireBridgeRunning({ floeBin, configPath, neutralCwd, home, when: "after npm removed and reinstalled the package" });
    log("guard", "PASS — npm removed and reinstalled the package while Floe kept serving from its stage");
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
  dumpLog(home, "bus");
}

function dumpLog(home, service) {
  const log = join(home, "logs", service, `${service}.log`);
  console.error(`\n[release:guard] ${service} log (${log}):`);
  console.error(existsSync(log) ? readFileSync(log, "utf8") : `(no ${service} log written)`);
}

/**
 * Sign-in runs the official Copilot CLI, a pinned dependency. The bridge logs
 * the binary it resolved from its own install; that binary must exist inside
 * the installed package and run.
 */
function requireCopilotCli(home) {
  const logFile = join(home, "logs", "bridge", "bridge.log");
  const text = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  const match = /\[floe-bridge\] copilot sign-in cli: (.+)$/m.exec(text);
  if (!match || /^not found/.test(match[1])) {
    dumpLog(home, "bridge");
    throw new Error("the installed bridge did not find the official Copilot CLI shipped with the artifact.");
  }
  const cliPath = match[1].trim();
  const version = spawnSync(cliPath, ["--version"], { encoding: "utf8", timeout: 120_000 });
  if (version.status !== 0) {
    throw new Error(`the shipped Copilot CLI at ${cliPath} did not run: ${version.stderr || version.error}`);
  }
  log("guard", `Copilot CLI ${version.stdout.trim()} at ${cliPath}`);
}

/**
 * `floe start` returns once it has launched the bridge, and a bridge that dies
 * on its first line looks like a clean start. The guard asks `floe status`.
 */
function requireBridgeRunning({ floeBin, configPath, neutralCwd, home, when }) {
  const status = spawnSync(floeBin, ["--config", configPath, "status"], { cwd: neutralCwd, encoding: "utf8", shell: isWindows });
  if (!/^bridge: running/m.test(status.stdout ?? "")) {
    process.stdout.write(status.stdout ?? "");
    dumpLog(home, "bridge");
    throw new Error(`the bridge is not running ${when}.`);
  }
}

/**
 * After a reboot the operating system may give a recorded service pid to an
 * unrelated program. Floe must treat that pid as not running: `floe start`
 * fills in the missing Bridge beside the running Bus, and never touches the
 * unrelated program.
 */
function guardReusedBridgePid({ floeBin, configPath, neutralCwd, home }) {
  const recordsFile = join(home, "services.json");
  const records = JSON.parse(readFileSync(recordsFile, "utf8"));
  if (!records.bridge?.pid) throw new Error("no Bridge is recorded after `floe start`.");
  if (isWindows) spawnSync("taskkill", ["/PID", String(records.bridge.pid), "/T", "/F"], { stdio: "ignore" });
  else process.kill(-records.bridge.pid, "SIGTERM");
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
  try {
    writeFileSync(recordsFile, JSON.stringify({ ...records, bridge: { ...records.bridge, pid: unrelated.pid } }, null, 2), "utf8");
    const started = spawnSync(floeBin, ["--config", configPath, "start"], { cwd: neutralCwd, stdio: "inherit", shell: isWindows });
    if (started.status !== 0) {
      dumpLog(home, "bridge");
      throw new Error(`\`floe start\` exited ${started.status} when the Bridge's recorded pid belonged to an unrelated program.`);
    }
    if (unrelated.exitCode !== null || unrelated.signalCode !== null) {
      throw new Error("`floe start` killed the unrelated program that held the Bridge's recorded pid.");
    }
    try { process.kill(unrelated.pid, 0); } catch {
      throw new Error("the unrelated program that held the Bridge's recorded pid is no longer running.");
    }
    const bridge = JSON.parse(readFileSync(recordsFile, "utf8")).bridge;
    if (!bridge?.pid || bridge.pid === unrelated.pid) {
      throw new Error("`floe start` still records the unrelated program as the Bridge: " + JSON.stringify(bridge));
    }
    requireBridgeRunning({ floeBin, configPath, neutralCwd, home, when: "after `floe start` with a reused Bridge pid" });
  } finally {
    unrelated.kill();
  }
}

/**
 * Upgrading must never require stopping Floe. On Windows a running process
 * locks its working directory and loaded images, so a Floe running from inside
 * the package makes npm fail with EBUSY. Floe's services run from a stage under
 * the Floe home instead: prove it by removing the package outright while Floe
 * runs (the harshest form of an upgrade), checking Floe still serves, then
 * reinstalling it.
 */
function guardUpgradeWhileRunning({ tarball, prefix, port, neutralCwd, home }) {
  const records = JSON.parse(readFileSync(join(home, "services.json"), "utf8"));
  const runtime = join(home, "runtime").toLowerCase();
  for (const [service, record] of Object.entries(records)) {
    if (!String(record.args?.[0] ?? "").toLowerCase().startsWith(runtime)) {
      throw new Error(`the ${service} service runs from ${record.args?.[0]}, not from a stage under ${join(home, "runtime")}.`);
    }
  }
  runNpm(["uninstall", "-g", PACKAGE_NAME, "--prefix", prefix], neutralCwd);
  if (!checkBusHealth(port)) throw new Error("Floe stopped serving when npm removed the package it was installed from.");
  runNpm(["install", "-g", tarball, "--prefix", prefix], neutralCwd);
}

/**
 * Install a throwaway surface package that depends on the packed artifact the
 * way a real surface does, verify its public Actor contract, and drive the
 * identity agent through `floe/identity`.
 */
function guardSurface({ workRoot, tarball, configPath, port, neutralCwd, home, account, floeBin }) {
  const surfaceDir = join(workRoot, "surface");
  mkdirSync(surfaceDir, { recursive: true });
  writeFileSync(join(surfaceDir, "package.json"), JSON.stringify({
    name: "floe-release-guard-surface",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: { [PACKAGE_NAME]: `file:${tarball.replace(/\\/g, "/")}` },
  }, null, 2) + "\n", "utf8");
  runNpm(["install", "--no-audit", "--no-fund"], surfaceDir);
  const folder = join(workRoot, "guard-workspace");
  // An Actor work log where Floe used to write it, beside committed
  // configuration: joining must move it into the git-ignored .floe/state.
  const legacyWorkLogs = join(folder, ".floe", "agents", "floe", "worklogs");
  mkdirSync(legacyWorkLogs, { recursive: true });
  writeFileSync(join(legacyWorkLogs, "2000-01-01.md"), "## Turn legacy-guard\n", "utf8");
  writeFileSync(join(surfaceDir, "surface.mjs"), `
import { connectIdentity } from "${PACKAGE_NAME}/identity";
import { validateActorDefinition } from "${PACKAGE_NAME}/actors";
const step = (message) => console.log("[surface] " + message);
validateActorDefinition({
  label: "Release Guard", charter: "Prove the public package contract.",
  responsibilities: [], instructions: "Validate only.", knowledge_refs: [],
  capability_grant_ids: [], policy_refs: { budget: null, trust: null, approval: null },
  escalation_rules: [],
});
step("Actor definition contract imported and validated");
const identity = await connectIdentity({ surface: "release-guard", configPath: ${JSON.stringify(configPath)} });
if (identity.state.kind !== "none") throw new Error("expected no identity, found " + identity.state.kind);
const created = await identity.create({ display_name: "Release Guard", passphrase: "guard passphrase" });
step("created " + created.npub + " (" + created.phrase.split(" ").length + " recovery words)");
await identity.lock();
if (identity.state.kind !== "locked") throw new Error("lock did not lock");
step("locked");
const refused = await identity.unlock("not the passphrase").then(() => null, (error) => error.code);
if (refused !== "wrong_passphrase") throw new Error("a wrong passphrase was not refused distinctly: " + refused);
step("wrong passphrase refused as wrong_passphrase");
await identity.unlock("guard passphrase");
if (identity.state.kind !== "unlocked") throw new Error("unlock did not unlock");
step("unlocked");
const unregisteredBefore = await identity.workspaceForFolder({ locator: ${JSON.stringify(folder)} });
if (unregisteredBefore.kind !== "none") throw new Error("an unregistered folder was looked up as " + JSON.stringify(unregisteredBefore));
const joined = await identity.joinFolder({ locator: ${JSON.stringify(folder)}, create_directory: true });
if (joined.kind !== "ready" && joined.kind !== "pending") throw new Error("joining a folder failed: " + JSON.stringify(joined));
step("joined " + joined.workspace_id);
{
  const sameFolder = (a, b) => typeof a === "string" && a.replace(/[\\\\/]+$/, "").toLowerCase() === b.replace(/[\\\\/]+$/, "").toLowerCase();
  const found = await identity.workspaceForFolder({ locator: ${JSON.stringify(folder)} });
  if (found.kind !== "workspace" || found.workspace.workspace_id !== joined.workspace_id || !found.joined || !sameFolder(found.workspace.folder_path, ${JSON.stringify(folder)})) {
    throw new Error("the joined folder was not looked up as its workspace: " + JSON.stringify(found));
  }
  const elsewhere = ${JSON.stringify(join(surfaceDir, "not-a-workspace"))};
  const none = await identity.workspaceForFolder({ locator: elsewhere });
  const recheck = await identity.workspaceForFolder({ locator: elsewhere });
  if (none.kind !== "none" || recheck.kind !== "none") throw new Error("an unregistered folder was not looked up as none, or the lookup registered it: " + JSON.stringify(recheck));
  step("folder lookup: the joined folder is its workspace; an unregistered folder is none and stays unregistered");
  const sessionsBeforeList = (await identity.sessions()).sessions.length;
  const plainList = await identity.listWorkspaces();
  if (!plainList.some((w) => w.workspace_id === joined.workspace_id && sameFolder(w.folder_path, ${JSON.stringify(folder)}))) {
    throw new Error("listWorkspaces did not list the joined folder: " + JSON.stringify(plainList));
  }
  if ((await identity.sessions()).sessions.length !== sessionsBeforeList) throw new Error("listing workspaces opened a session");
  step("listed " + plainList.length + " workspace(s) with no session opened");
}

// The CLI is a front door to the substrate: the installed floe binary invokes
// one real operation in the joined folder and sees it complete, and malformed
// input is refused with the person's own mistake, never an internal error.
{
  const { spawnSync: runCli } = await import("node:child_process");
  const { writeFileSync: writeInput } = await import("node:fs");
  const inputFile = ${JSON.stringify(join(surfaceDir, "cli-input.json"))};
  writeInput(inputFile, "{}", "utf8");
  const cli = (...args) => runCli(${JSON.stringify(floeBin)}, ["--config", ${JSON.stringify(configPath)}, "operations", "invoke", ...args],
    { cwd: ${JSON.stringify(folder)}, encoding: "utf8", shell: process.platform === "win32" });
  const read = cli("artefact.search", "--input", "@" + inputFile);
  let receipt = null;
  try { receipt = JSON.parse(read.stdout).receipt; } catch {}
  if (read.status !== 0 || receipt?.state !== "completed") {
    throw new Error("floe operations invoke did not complete a read: exit " + read.status + "\\n" + read.stdout + read.stderr);
  }
  step("the installed CLI invoked artefact.search and it completed (" + receipt.receipt_id + ")");
  const malformed = cli("artefact.search", "--input", "{bad");
  if (malformed.status === 0 || !malformed.stderr.includes("Operation input is not valid JSON") || malformed.stderr.includes("internal error")) {
    throw new Error("malformed CLI input was not refused plainly: exit " + malformed.status + "\\n" + malformed.stderr);
  }
  step("the installed CLI refused malformed input plainly: " + malformed.stderr.split(/\\r?\\n/, 1)[0]);

  // A surface Floe launches receives exactly one extra, final argument naming
  // the launch; Floe passes nothing through the environment.
  const probeScript = ${JSON.stringify(join(surfaceDir, "launch-probe.cjs"))};
  const probeOut = ${JSON.stringify(join(surfaceDir, "launch-probe.json"))};
  writeInput(probeScript, "require('node:fs').writeFileSync(" + JSON.stringify(probeOut) + ", JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env).filter((k) => /LAUNCH/i.test(k)) }))", "utf8");
  const floeCmd = (...args) => runCli(${JSON.stringify(floeBin)}, ["--config", ${JSON.stringify(configPath)}, ...args],
    { cwd: ${JSON.stringify(folder)}, encoding: "utf8", shell: process.platform === "win32" });
  const registered = floeCmd("surface", "register", "--name", "launch-probe", "--label", "Launch probe", "--command", "node", "--arg", probeScript, "--arg", "own-arg");
  if (registered.status !== 0) throw new Error("could not register the launch probe surface: " + registered.stdout + registered.stderr);
  const launched = floeCmd("launch-probe");
  floeCmd("surface", "remove", "launch-probe");
  const { readFileSync: readProbe } = await import("node:fs");
  let seen = null;
  try { seen = JSON.parse(readProbe(probeOut, "utf8")); } catch {}
  if (launched.status !== 0 || JSON.stringify(seen?.argv) !== JSON.stringify(["own-arg", "--launched-by=floe"]) || seen.env.length !== 0) {
    throw new Error("a surface launched by Floe did not receive exactly its own args then --launched-by=floe: exit " + launched.status + " " + JSON.stringify(seen) + "\\n" + launched.stdout + launched.stderr);
  }
  step("a surface launched through the installed floe received its own args, then --launched-by=floe, and no launch environment variable");
}
const ready = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("no bearer was pushed within 15s")), 15000);
  identity.session({ workspace_id: joined.workspace_id }, (event) => {
    if (event.status === "ready") { clearTimeout(timer); resolve(event); }
    else if (event.status !== "selection_required") { clearTimeout(timer); reject(new Error("session: " + JSON.stringify(event))); }
  });
});
{
  const listed = ready.workspaces.find((w) => w.workspace_id === joined.workspace_id);
  if (!listed?.folder_path || !listed.last_used_at || Number.isNaN(Date.parse(listed.last_used_at))) {
    throw new Error("the workspace list lacks folder path or last-used time: " + JSON.stringify(ready.workspaces));
  }
  step("workspace list carries folder " + listed.folder_path + " and last used " + listed.last_used_at);
}
const response = await fetch("http://127.0.0.1:${port}/v1/pending-responses?workspace_id=" + encodeURIComponent(joined.workspace_id), {
  headers: { authorization: "Bearer " + ready.bearer_token },
});
if (response.status !== 200) throw new Error("the pushed bearer was refused by the bus: " + response.status);
step("bearer pushed and accepted by the bus (expires " + ready.expires_at + ")");
// The bearer lives as long as this identity connection; it stays open for the turn.

const { connectEngines } = await import("${PACKAGE_NAME}/engines");
const engines = await connectEngines({ surface: "release-guard", configPath: ${JSON.stringify(configPath)} });
const settled = (state) => state && state.phase !== "checking";
const copilot = settled(engines.state.copilot) ? engines.state.copilot : await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("engine state still checking after 60s: " + JSON.stringify(engines.state))), 60000);
  engines.onState((_all, changed) => {
    if (changed.engine === "copilot" && settled(changed)) { clearTimeout(timer); resolve(changed); }
  });
});
step("engine copilot: " + copilot.phase + " (" + copilot.message + ")");
if (copilot.phase !== "ready" || copilot.account?.label?.toLowerCase() !== ${JSON.stringify(account.label.toLowerCase())}) {
  engines.close();
  throw new Error("the installed Bridge's engine is not ready as ${account.label}: " + JSON.stringify(copilot));
}
// A surface offers the person a choice of model from the engine's own list.
const modelList = await engines.models("copilot");
engines.close();
const usableModels = modelList.models.filter((model) => model.enabled !== false);
if (usableModels.length === 0) throw new Error("the engine listed no model an Actor can run on: " + JSON.stringify(modelList));
step("the engine listed " + usableModels.length + " model(s) an Actor can run on, e.g. " + usableModels.slice(0, 3).map((model) => model.id).join(", "));

// One real turn through the installed Bridge: the default Floe Actor answers a
// message. The engine refuses any session not signed in as the readiness
// account, so a completed turn ran as ${account.label}.
const bus = "http://127.0.0.1:${port}";
const auth = { authorization: "Bearer " + ready.bearer_token, "content-type": "application/json" };
const invoke = async (body) => {
  const response = await fetch(bus + "/v1/workspaces/" + encodeURIComponent(joined.workspace_id) + "/operations/invoke", {
    method: "POST", headers: auth, body: JSON.stringify(body),
  });
  const json = await response.json();
  if (response.status !== 200 || json.receipt?.state !== "completed") throw new Error(body.operation_id + " failed: " + JSON.stringify(json));
  return json.receipt.result;
};
const floe = "actor:" + joined.workspace_id + ":floe";
const context = (await invoke({
  operation_id: "context.create", operation_version: "1", input_schema_version: "1", idempotency_key: "guard-context",
  input: { participants: [{ participant_id: floe }] },
})).context;
const socket = new WebSocket(bus.replace("http:", "ws:") + "/v1/events/stream");
const pushes = [];
let arrived = () => {};
let closed = null;
socket.addEventListener("message", (message) => { pushes.push(JSON.parse(String(message.data))); arrived(); });
socket.addEventListener("close", (event) => { closed = "the event stream closed (" + event.code + " " + event.reason + ")"; arrived(); });
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
socket.send(JSON.stringify({ type: "authenticate", bearer_token: ready.bearer_token, workspace_id: joined.workspace_id }));
const waiters = new Set();
arrived = () => { for (const look of [...waiters]) look(); };
const until = (match, label, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { waiters.delete(look); reject(new Error("no " + label + " within " + ms / 1000 + "s")); }, ms);
  const look = () => {
    const found = pushes.find(match);
    if (found) { clearTimeout(timer); waiters.delete(look); resolve(found); }
    else if (closed) { clearTimeout(timer); waiters.delete(look); reject(new Error(closed + " before " + label + "; received " + JSON.stringify(pushes.map((push) => push.type)))); }
  };
  waiters.add(look);
  look();
});
await until((push) => push.type === "caught_up", "stream catch-up", 15000);
// The person commits their workspace, as they would before relying on it. A
// full Actor turn must then leave git status clean: Floe's runtime output
// belongs in the git-ignored .floe/state, never beside committed configuration.
const { execFileSync } = await import("node:child_process");
const { existsSync: exists, readFileSync: read, watch: watchFolder } = await import("node:fs");
const { join: joinPath } = await import("node:path");
const git = (...args) => execFileSync("git", ["-c", "user.email=guard@floe.invalid", "-c", "user.name=Release Guard", ...args],
  { cwd: ${JSON.stringify(folder)}, encoding: "utf8" });
const stateLogs = joinPath(${JSON.stringify(folder)}, ".floe", "state", "agents", "floe", "worklogs");
if (exists(joinPath(${JSON.stringify(folder)}, ".floe", "agents", "floe", "worklogs", "2000-01-01.md"))) {
  throw new Error("joining left an Actor work log beside committed configuration");
}
if (!exists(joinPath(stateLogs, "2000-01-01.md")) || !read(joinPath(stateLogs, "2000-01-01.md"), "utf8").includes("legacy-guard")) {
  throw new Error("joining did not move the existing Actor work log into .floe/state");
}
step("the existing Actor work log moved into .floe/state when the folder was joined");
git("init", "-q");
git("add", "-A");
git("commit", "-qm", "workspace");
const todayLog = joinPath(stateLogs, new Date().toISOString().slice(0, 10) + ".md");
const logWritten = new Promise((resolve, reject) => {
  const timer = setTimeout(() => { watcher.close(); reject(new Error("the turn wrote no work log into .floe/state within 180s")); }, 180000);
  const watcher = watchFolder(stateLogs, () => {
    if (exists(todayLog)) { clearTimeout(timer); watcher.close(); resolve(); }
  });
});
const sent = await invoke({
  operation_id: "context.communication.emit", operation_version: "1", input_schema_version: "2",
  target: { kind: "context", id: context.context_id }, expected_resource_revision: String(context.state_revision),
  idempotency_key: "guard-turn",
  input: { event_type: "message", recipient_participant_id: floe, content: { text: "Reply with the single word: ready" }, response_expected: true },
});
step("asked the default Floe Actor for a reply");
const result = await until((push) => push.type === "event_submitted"
  && push.payload?.event?.content?.data?.origin === "runtime_turn_result"
  && push.payload.event.content.data.cause_event_id === sent.event_ref.id, "turn result", 180000);
const turn = result.payload.event.content;
if (turn.data.outcome !== "completed") throw new Error("the real turn did not complete: " + JSON.stringify(turn));
step("real turn completed as ${account.label}: " + JSON.stringify(turn.text.slice(0, 80)));
await logWritten;
const dirty = git("status", "--porcelain", "--untracked-files=all");
if (dirty !== "") throw new Error("a full Actor turn changed the person's tracked workspace:\\n" + dirty);
step("the turn's work log is in .floe/state and git status is clean");

// An Actor's memory of a Context survives a Bridge restart: Floe rebuilds it
// from the Context's own Events, never from a resumed vendor session. Only the
// Bridge restarts; the Bus, identity agent and this event stream keep serving.
const { randomBytes } = await import("node:crypto");
const codeword = "floe-" + randomBytes(4).toString("hex");
const memoryContext = (await invoke({
  operation_id: "context.create", operation_version: "1", input_schema_version: "1", idempotency_key: "guard-memory-context",
  input: { participants: [{ participant_id: floe }] },
})).context;
const askInMemoryContext = async (key, text, label) => {
  const latest = (await invoke({ operation_id: "context.get", operation_version: "1", input_schema_version: "1",
    idempotency_key: key + "-get", target: { kind: "context", id: memoryContext.context_id }, input: {} })).context;
  const asked = await invoke({
    operation_id: "context.communication.emit", operation_version: "1", input_schema_version: "2",
    target: { kind: "context", id: memoryContext.context_id }, expected_resource_revision: String(latest.state_revision),
    idempotency_key: key,
    input: { event_type: "message", recipient_participant_id: floe, content: { text }, response_expected: true },
  });
  const answered = await until((push) => push.type === "event_submitted"
    && push.payload?.event?.content?.data?.origin === "runtime_turn_result"
    && push.payload.event.content.data.cause_event_id === asked.event_ref.id, label, 180000);
  const answer = answered.payload.event.content;
  if (answer.data.outcome !== "completed") throw new Error(label + " did not complete: " + JSON.stringify(answer));
  return answer.text;
};
await askInMemoryContext("guard-memory-tell", "Remember this codeword for later: " + codeword + ". Reply with the single word: noted",
  "the turn that was told the codeword");
step("told the Floe Actor a codeword in its own Context");
const bridgeRecord = JSON.parse(read(${JSON.stringify(join(home, "services.json"))}, "utf8")).bridge;
if (!bridgeRecord?.pid) throw new Error("no running Bridge is recorded in services.json");
if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(bridgeRecord.pid), "/T", "/F"], { stdio: "ignore" });
else process.kill(-bridgeRecord.pid, "SIGTERM");
execFileSync(${JSON.stringify(floeBin)}, ["--config", ${JSON.stringify(configPath)}, "start"],
  { cwd: ${JSON.stringify(neutralCwd)}, stdio: "ignore", shell: process.platform === "win32" });
const restartedRecord = JSON.parse(read(${JSON.stringify(join(home, "services.json"))}, "utf8")).bridge;
if (!restartedRecord?.pid || restartedRecord.pid === bridgeRecord.pid) throw new Error("the Bridge did not restart");
step("restarted only the Bridge (pid " + bridgeRecord.pid + " -> " + restartedRecord.pid + ")");
const recalled = await askInMemoryContext("guard-memory-recall",
  "What codeword did I ask you to remember earlier in this conversation? Reply with only the codeword.",
  "the turn after the Bridge restart");
if (!recalled.toLowerCase().includes(codeword)) {
  throw new Error("after a Bridge restart the Actor did not recall its Context: expected " + codeword + ", got " + JSON.stringify(recalled.slice(0, 200)));
}
step("after the Bridge restart the Actor recalled the codeword from its Context: " + JSON.stringify(recalled.slice(0, 80)));

// An Actor created at runtime must be reachable like one Floe was installed with:
// set it up in one step (create, bind to the Floe Actor's runtime, publish), send
// it work, and see its own real turn complete. An Actor that is created but never
// hosted silently swallows every request sent to it. It is set up with no tool
// access, because an Actor without permissions must still take turns; it just
// cannot use tools.
const floeBinding = (await invoke({ operation_id: "actor.runtime-binding.inspect", operation_version: "1", input_schema_version: "1",
  idempotency_key: "guard-floe-binding", target: { kind: "actor", id: floe }, input: {} })).current_binding;
if (!floeBinding) throw new Error("the Floe Actor has no runtime binding to reuse");
const guardActor = await invoke({ operation_id: "actor.setup", operation_version: "1", input_schema_version: "1",
  idempotency_key: "guard-actor-setup", input: { actor_id: "guard-greeter", engine_tool_operation_ids: [],
    runtime_profile_revision_id: floeBinding.runtime_profile_revision_id, definition: {
    label: "Guard Greeter", charter: "Answer the release guard.", responsibilities: [],
    instructions: "Reply briefly to whatever you are asked.", knowledge_refs: [], capability_grant_ids: [],
    policy_refs: { budget: null, trust: null, approval: null }, escalation_rules: [],
  } } });
if (guardActor.revision.content.capability_grant_ids.length !== 0) throw new Error("the guard's created Actor was meant to hold no permissions");
if (!guardActor.revision.published_at || guardActor.binding.runtime_profile_revision_id !== floeBinding.runtime_profile_revision_id) {
  throw new Error("actor.setup did not leave a published Actor bound to the Floe Actor's runtime: " + JSON.stringify(guardActor));
}
step("set up " + guardActor.actor.actor_id + " in one operation: created, bound and published");
// A person can read an Actor's tools and access: the created Actor holds none,
// the Floe Actor holds the engine tools.
const accessOf = async (actorId, key) => (await invoke({ operation_id: "actor.inspect", operation_version: "1", input_schema_version: "1",
  idempotency_key: key, target: { kind: "actor", id: actorId }, input: {} })).access;
const greeterAccess = await accessOf(guardActor.actor.actor_id, "guard-greeter-access");
if (!greeterAccess || greeterAccess.engine_tool_operation_ids.length !== 0 || greeterAccess.active_grants.length !== 0) {
  throw new Error("actor.inspect did not show the created Actor holding no tools: " + JSON.stringify(greeterAccess));
}
const floeAccess = await accessOf(floe, "guard-floe-access");
if (!floeAccess?.engine_tool_operation_ids.includes("engine.tool.process.execute") || floeAccess.active_grants.length === 0) {
  throw new Error("actor.inspect did not show the Floe Actor's engine tools: " + JSON.stringify(floeAccess));
}
step("actor.inspect shows the created Actor with no tools and the Floe Actor with " + floeAccess.engine_tool_operation_ids.join(", "));
// The Bridge hosts the new Actor in response to the binding; its endpoint is pushed when it is addressable.
await until((push) => push.type === "endpoint_registered" && push.payload?.endpoint?.endpoint_id === guardActor.actor.actor_id,
  "the Bridge hosting the created Actor", 30000);
step("the Bridge is hosting " + guardActor.actor.actor_id);
const guardContext = (await invoke({
  operation_id: "context.create", operation_version: "1", input_schema_version: "1", idempotency_key: "guard-actor-context",
  input: { participants: [{ participant_id: guardActor.actor.actor_id }] },
})).context;
const guardSent = await invoke({
  operation_id: "context.communication.emit", operation_version: "1", input_schema_version: "2",
  target: { kind: "context", id: guardContext.context_id }, expected_resource_revision: String(guardContext.state_revision),
  idempotency_key: "guard-actor-turn",
  input: { event_type: "message", recipient_participant_id: guardActor.actor.actor_id,
    content: { text: "Reply with the single word: hello" }, response_expected: true },
});
const guardResult = await until((push) => push.type === "event_submitted"
  && push.payload?.event?.content?.data?.origin === "runtime_turn_result"
  && push.payload.event.content.data.cause_event_id === guardSent.event_ref.id, "the created Actor's turn result", 180000);
const guardTurn = guardResult.payload.event.content;
if (guardTurn.data.outcome !== "completed") throw new Error("the created Actor's turn did not complete: " + JSON.stringify(guardTurn));
step("the created Actor, holding no permissions, completed its own real turn: " + JSON.stringify(guardTurn.text.slice(0, 80)));

// An Actor can run on its own model, chosen from the engine's list. A change
// takes effect from the Actor's next stop: the stop already taken keeps the
// model it ran on. The engine's own usage record names the model each turn ran on.
const modelRanOn = async (triggerEventId, label) => {
  const usage = await until((push) => push.type === "runtime_telemetry" && push.payload?.telemetry?.kind === "usage"
    && push.payload.telemetry.payload?.trigger_event_id === triggerEventId, label, 60000);
  const model = usage.payload.telemetry.payload.usage?.model;
  if (typeof model !== "string" || model === "") throw new Error(label + " named no model: " + JSON.stringify(usage.payload.telemetry.payload));
  return model;
};
const firstModel = await modelRanOn(guardSent.event_ref.id, "the created Actor's first usage record");
const preferred = ["gpt-5-mini", "gpt-4.1", "claude-haiku-4.5", "gpt-5.4-mini"];
const ownModel = usableModels.find((model) => preferred.includes(model.id) && model.id !== firstModel)
  ?? usableModels.find((model) => model.id !== firstModel);
if (!ownModel) throw new Error("the engine listed no model other than " + firstModel + " to give the created Actor");
const greeterBinding = (await invoke({ operation_id: "actor.runtime-binding.inspect", operation_version: "1", input_schema_version: "1",
  idempotency_key: "guard-greeter-binding", target: { kind: "actor", id: guardActor.actor.actor_id }, input: {} })).current_binding;
const rebound = (await invoke({ operation_id: "actor.runtime-binding.replace", operation_version: "1", input_schema_version: "1",
  idempotency_key: "guard-greeter-model", target: { kind: "actor_runtime_binding", id: greeterBinding.actor_runtime_binding_id },
  expected_resource_revision: greeterBinding.actor_runtime_binding_id,
  input: { runtime_profile_revision_id: greeterBinding.runtime_profile_revision_id, status: greeterBinding.status, model: ownModel.id } })).binding;
if (rebound.model !== ownModel.id) throw new Error("the created Actor's binding did not take its own model: " + JSON.stringify(rebound));
const guardContextNow = (await invoke({ operation_id: "context.get", operation_version: "1", input_schema_version: "1",
  idempotency_key: "guard-actor-context-get", target: { kind: "context", id: guardContext.context_id }, input: {} })).context;
const ownModelSent = await invoke({
  operation_id: "context.communication.emit", operation_version: "1", input_schema_version: "2",
  target: { kind: "context", id: guardContext.context_id }, expected_resource_revision: String(guardContextNow.state_revision),
  idempotency_key: "guard-actor-own-model-turn",
  input: { event_type: "message", recipient_participant_id: guardActor.actor.actor_id,
    content: { text: "Reply with the single word: again" }, response_expected: true },
});
const ownModelResult = await until((push) => push.type === "event_submitted"
  && push.payload?.event?.content?.data?.origin === "runtime_turn_result"
  && push.payload.event.content.data.cause_event_id === ownModelSent.event_ref.id, "the created Actor's turn on its own model", 180000);
if (ownModelResult.payload.event.content.data.outcome !== "completed") {
  throw new Error("the created Actor's turn on its own model did not complete: " + JSON.stringify(ownModelResult.payload.event.content));
}
const secondModel = await modelRanOn(ownModelSent.event_ref.id, "the created Actor's usage on its own model");
if (secondModel !== ownModel.id) throw new Error("the created Actor was given " + ownModel.id + " but its next stop ran on " + secondModel);
step("the created Actor's first stop ran on " + firstModel + "; given its own model " + ownModel.id + ", its next stop ran on " + secondModel);


// Pause 20 real turns mid-flight, then resume each one. Every interrupted shell
// writes a unique start marker, waits, then writes a completion marker. The
// gate must observe zero completion markers after Floe reports paused.
const { existsSync, watch } = await import("node:fs");
const { join } = await import("node:path");
const HOLD_SECONDS = 20;
const PAUSE_RUNS = 20;
const invokeAs = async (state, body) => {
  const response = await fetch(bus + "/v1/workspaces/" + encodeURIComponent(joined.workspace_id) + "/operations/invoke", {
    method: "POST", headers: auth, body: JSON.stringify({ operation_version: "1", input_schema_version: "1", ...body }),
  });
  const json = await response.json();
  if (response.status !== 200 || json.receipt?.state !== state) throw new Error(body.operation_id + " failed: " + JSON.stringify(json));
  return json.receipt.result;
};
const scope = (await invokeAs("completed", { operation_id: "scope.create", idempotency_key: "guard-scope", input: { title: "Release guard" } })).scope;
const ingress = (await invokeAs("completed", { operation_id: "context.create", idempotency_key: "guard-ingress",
  input: { scope_id: scope.scope_id, title: "Release guard input", participants: [] } })).context;
const draft = (await invokeAs("completed", { operation_id: "scope.composition.draft.create", idempotency_key: "guard-draft",
  target: { kind: "scope", id: scope.scope_id }, expected_resource_revision: "none",
  input: { content: {
    nodes: [
      { node_id: "ingress", kind: "event", config: { event_type: "work.requested" }, context_policy: { mode: "fixed", context_id: ingress.context_id } },
      { node_id: "worker", kind: "actor", resource_id: floe, activation: { mode: "per_delivery" }, context_policy: { mode: "new_per_execution" } },
    ],
    ports: [
      { port_id: "ingress:out", node_id: "ingress", name: "work", direction: "output", event_types: ["work.requested"] },
      { port_id: "worker:in", node_id: "worker", name: "work", direction: "input", event_types: ["work.requested"], min_count: 1 },
      { port_id: "worker:out", node_id: "worker", name: "result", direction: "output", event_types: ["work.completed"] },
    ],
    edges: [{ edge_id: "ingress-to-worker", source_port_id: "ingress:out", target_port_id: "worker:in" }],
  } } })).revision;
const draftTarget = { kind: "scope_composition_revision", id: draft.revision_id };
const impact = await invokeAs("completed", { operation_id: "scope.composition.impact.inspect", idempotency_key: "guard-impact",
  target: draftTarget, expected_resource_revision: draft.semantic_digest, input: {} });
await invokeAs("completed", { operation_id: "scope.composition.publish", idempotency_key: "guard-publish",
  target: draftTarget, expected_resource_revision: draft.semantic_digest,
  input: { expected_current_published_revision_id: null, expected_impact_digest: impact.impact_digest } });
// The execution's revision is its pinned plan, counter, status and end stamps (scope-execution-contract.ts).
const revisionOf = (execution) => [execution.revision_id, execution.state_revision, execution.status,
  execution.completed_at ?? "", execution.cancelled_at ?? ""].join(":");
const current = async ({ executionId, idempotencyKey }) => (await invokeAs("completed", {
  operation_id: "scope.execution.inspect", idempotency_key: idempotencyKey,
  target: { kind: "scope_execution", id: executionId }, input: {},
})).execution;
// A step whose attempt fails without handing anything on must still say so:
// its NodeExecution moves to failed, and the failure is pushed with a safe
// reason. The failing Actor runs on a copy of the Floe Actor's runtime with a
// setting the Bridge refuses, so its attempt fails on the production path
// after the step has started. (An unknown model is not a failure: the engine
// silently answers with its default model.)
const floeRuntime = (await invokeAs("completed", { operation_id: "runtime-profile.revision.get", idempotency_key: "guard-floe-runtime",
  target: { kind: "runtime_profile_revision", id: floeBinding.runtime_profile_revision_id }, input: {} })).revision;
const failingDraft = (await invokeAs("completed", { operation_id: "runtime-profile.create", idempotency_key: "guard-failing-runtime",
  input: { content: { ...floeRuntime.content, label: "Release guard: a setting the Bridge refuses",
    configuration: { ...floeRuntime.content.configuration, thinking_level: "floe-release-guard-unsupported" } } } })).draft;
const failingRuntime = (await invokeAs("completed", { operation_id: "runtime-profile.publish", idempotency_key: "guard-failing-runtime-publish",
  target: { kind: "runtime_profile_revision", id: failingDraft.runtime_profile_revision_id },
  expected_resource_revision: failingDraft.semantic_digest, input: { expected_current_revision_id: null } })).revision;
const failingActor = (await invokeAs("completed", { operation_id: "actor.setup", idempotency_key: "guard-failing-setup",
  input: { actor_id: "guard-failing", engine_tool_operation_ids: [],
    runtime_profile_revision_id: failingRuntime.runtime_profile_revision_id, definition: {
    label: "Guard Failing Step", charter: "Fail before its turn for the release guard.", responsibilities: [],
    instructions: "Reply briefly.", knowledge_refs: [], capability_grant_ids: [],
    policy_refs: { budget: null, trust: null, approval: null }, escalation_rules: [],
  } } })).actor;
await until((push) => push.type === "endpoint_registered" && push.payload?.endpoint?.endpoint_id === failingActor.actor_id,
  "the Bridge hosting the failing Actor", 30000);
const failScope = (await invokeAs("completed", { operation_id: "scope.create", idempotency_key: "guard-fail-scope", input: { title: "Release guard failure" } })).scope;
const failIngress = (await invokeAs("completed", { operation_id: "context.create", idempotency_key: "guard-fail-ingress",
  input: { scope_id: failScope.scope_id, title: "Release guard failure input", participants: [] } })).context;
const failDraft = (await invokeAs("completed", { operation_id: "scope.composition.draft.create", idempotency_key: "guard-fail-draft",
  target: { kind: "scope", id: failScope.scope_id }, expected_resource_revision: "none",
  input: { content: {
    nodes: [
      { node_id: "ingress", kind: "event", config: { event_type: "work.requested" }, context_policy: { mode: "fixed", context_id: failIngress.context_id } },
      { node_id: "worker", kind: "actor", resource_id: failingActor.actor_id, activation: { mode: "per_delivery" }, context_policy: { mode: "new_per_execution" } },
    ],
    ports: [
      { port_id: "ingress:out", node_id: "ingress", name: "work", direction: "output", event_types: ["work.requested"] },
      { port_id: "worker:in", node_id: "worker", name: "work", direction: "input", event_types: ["work.requested"], min_count: 1 },
      { port_id: "worker:out", node_id: "worker", name: "result", direction: "output", event_types: ["work.completed"], min_count: 1 },
    ],
    edges: [{ edge_id: "ingress-to-worker", source_port_id: "ingress:out", target_port_id: "worker:in" }],
  } } })).revision;
const failDraftTarget = { kind: "scope_composition_revision", id: failDraft.revision_id };
const failImpact = await invokeAs("completed", { operation_id: "scope.composition.impact.inspect", idempotency_key: "guard-fail-impact",
  target: failDraftTarget, expected_resource_revision: failDraft.semantic_digest, input: {} });
await invokeAs("completed", { operation_id: "scope.composition.publish", idempotency_key: "guard-fail-publish",
  target: failDraftTarget, expected_resource_revision: failDraft.semantic_digest,
  input: { expected_current_published_revision_id: null, expected_impact_digest: failImpact.impact_digest } });
const failRun = (await invokeAs("accepted", { operation_id: "scope.execution.start", idempotency_key: "guard-fail-run",
  target: { kind: "scope", id: failScope.scope_id }, expected_resource_revision: failDraft.revision_id,
  input: { ingress_node_id: "ingress", output_port_id: "ingress:out", content: { request: "Reply with the single word: done" } } })).execution;
const failedPush = await until((push) => push.type === "node_execution_state_changed"
  && push.payload.scope_execution_id === failRun.execution_id && push.payload.node_id === "worker"
  && ["failed", "completed", "waiting_external", "blocked"].includes(push.payload.to_status), "the failing step settling", 180000);
const failure = failedPush.payload.failure;
if (failedPush.payload.to_status !== "failed") {
  throw new Error("a step whose attempt failed was reported as " + failedPush.payload.to_status + ", not failed: " + JSON.stringify(failedPush.payload));
}
if (!failure || typeof failure.code !== "string" || typeof failure.message !== "string" || failure.message.trim() === "") {
  throw new Error("the failed step's push carries no failure reason: " + JSON.stringify(failedPush.payload));
}
if (/[\\r\\n]/.test(failure.message) || /\\bat .+:\\d+:\\d+/.test(failure.message) || failure.message.length > 300) {
  throw new Error("the failed step's pushed reason is not safe to show: " + JSON.stringify(failure.message));
}
const failedExecution = await current({ executionId: failRun.execution_id, idempotencyKey: "guard-fail-inspect" });
if (failedExecution.status !== "failed") throw new Error("the route with a failed step is " + failedExecution.status + ", not failed");
step("a step whose attempt failed without handing anything on was pushed as failed (" + failure.code + "): " + JSON.stringify(failure.message));

// Required output is never waited on silently. A step with one required output
// hands on its reply; otherwise Floe sends one visible reminder, then the step
// either completes or fails with "required output not handed on".
const handOnRoute = async (key, outputs, request, schema) => {
  const routeScope = (await invokeAs("completed", { operation_id: "scope.create", idempotency_key: "guard-" + key + "-scope", input: { title: "Release guard " + key } })).scope;
  const routeIngress = (await invokeAs("completed", { operation_id: "context.create", idempotency_key: "guard-" + key + "-ingress",
    input: { scope_id: routeScope.scope_id, title: "Release guard " + key + " input", participants: [] } })).context;
  const routeDraft = (await invokeAs("completed", { operation_id: "scope.composition.draft.create", idempotency_key: "guard-" + key + "-draft",
    target: { kind: "scope", id: routeScope.scope_id }, expected_resource_revision: "none",
    input: { content: {
      nodes: [
        { node_id: "ingress", kind: "event", config: { event_type: "work.requested" }, context_policy: { mode: "fixed", context_id: routeIngress.context_id } },
        { node_id: "worker", kind: "actor", resource_id: floe, activation: { mode: "per_delivery" }, context_policy: { mode: "new_per_execution" } },
      ],
      ports: [
        { port_id: "ingress:out", node_id: "ingress", name: "work", direction: "output", event_types: ["work.requested"] },
        { port_id: "worker:in", node_id: "worker", name: "work", direction: "input", event_types: ["work.requested"], min_count: 1 },
        ...outputs.map((name) => ({ port_id: "worker:" + name, node_id: "worker", name, direction: "output", event_types: ["work.completed"], min_count: 1,
          ...(schema ? { schema } : {}) })),
      ],
      edges: [{ edge_id: "ingress-to-worker", source_port_id: "ingress:out", target_port_id: "worker:in" }],
    } } })).revision;
  const routeTarget = { kind: "scope_composition_revision", id: routeDraft.revision_id };
  const routeImpact = await invokeAs("completed", { operation_id: "scope.composition.impact.inspect", idempotency_key: "guard-" + key + "-impact",
    target: routeTarget, expected_resource_revision: routeDraft.semantic_digest, input: {} });
  await invokeAs("completed", { operation_id: "scope.composition.publish", idempotency_key: "guard-" + key + "-publish",
    target: routeTarget, expected_resource_revision: routeDraft.semantic_digest,
    input: { expected_current_published_revision_id: null, expected_impact_digest: routeImpact.impact_digest } });
  const run = (await invokeAs("accepted", { operation_id: "scope.execution.start", idempotency_key: "guard-" + key + "-run",
    target: { kind: "scope", id: routeScope.scope_id }, expected_resource_revision: routeDraft.revision_id,
    input: { ingress_node_id: "ingress", output_port_id: "ingress:out", content: { request } } })).execution;
  const settled = await until((push) => push.type === "node_execution_state_changed"
    && push.payload.scope_execution_id === run.execution_id && push.payload.node_id === "worker"
    && ["failed", "completed", "waiting_external", "blocked", "cancelled"].includes(push.payload.to_status), "the " + key + " step settling", 420000);
  const reminders = pushes.filter((push) => push.type === "event_submitted"
    && push.payload?.event?.content?.data?.origin === "scope_output_reminder"
    && push.payload.event.content.data.scope_execution_id === run.execution_id);
  const inspected = await invokeAs("completed", { operation_id: "scope.execution.inspect", idempotency_key: "guard-" + key + "-inspect",
    target: { kind: "scope_execution", id: run.execution_id }, input: { include_outputs: true } });
  return { settled: settled.payload, reminders: reminders.length, outputs: inspected.output_publications ?? [] };
};
const verdictSchema = { type: "object", required: ["text"],
  properties: { text: { type: "string", pattern: "^(PASS|FAIL|UNSURE)([^A-Za-z]|$)" } } };
const [single, reminded, stubborn, judged] = await Promise.all([
  handOnRoute("reply-output", ["result"],
    "Reply with the single word: done. Do not hand on or publish any output through any operation; your reply is enough."),
  handOnRoute("reminded-output", ["first", "second"],
    "Do not hand on any output in this turn; only reply with the word: ready. If Floe later reminds you about missing output, "
    + "follow the reminder exactly: hand on output first with text one and output second with text two."),
  handOnRoute("stubborn-output", ["first", "second"],
    "Reply with the single word: no. Never hand on or publish any output through any operation, even if Floe reminds you."),
  handOnRoute("judged-output", ["verdict"],
    "Judge whether 2 + 2 equals 4. Reply with PASS, FAIL or UNSURE as the first word of your first line, then one short reason. "
    + "Do not hand on or publish any output through any operation; your reply is enough.", verdictSchema),
]);
const replyOutput = single.outputs.find((output) => output.port_id === "worker:result");
if (single.settled.to_status !== "completed" || replyOutput?.event?.metadata?.output_source !== "turn_reply" || !String(replyOutput.event.content?.text ?? "").trim()) {
  throw new Error("a step with one required output did not hand on its reply: " + JSON.stringify({ settled: single.settled, outputs: single.outputs }));
}
if (single.reminders !== 0) throw new Error("a step whose reply was its output was still reminded");
step("a step with one required output handed on its reply as that output: " + JSON.stringify(String(replyOutput.event.content.text).slice(0, 40)));
if (reminded.settled.to_status !== "completed" || reminded.reminders !== 1
  || !["worker:first", "worker:second"].every((port) => reminded.outputs.some((output) => output.port_id === port))) {
  throw new Error("a reminded step did not complete after exactly one reminder: " + JSON.stringify({ settled: reminded.settled, reminders: reminded.reminders, outputs: reminded.outputs.map((output) => output.port_id) }));
}
step("a step missing required output got exactly one visible reminder, then handed both outputs on and completed");
if (stubborn.settled.to_status !== "failed" || stubborn.reminders !== 1 || stubborn.settled.failure?.code !== "required_output_not_handed_on"
  || !String(stubborn.settled.failure?.message ?? "").includes("required output not handed on")) {
  throw new Error("a step that ignored its reminder did not fail with its reason: " + JSON.stringify({ settled: stubborn.settled, reminders: stubborn.reminders }));
}
step("a step that ignored its one reminder failed, never looped: " + JSON.stringify(stubborn.settled.failure.message));
const verdict = judged.outputs.find((output) => output.port_id === "worker:verdict");
if (judged.settled.to_status !== "completed" || !/^PASS([^A-Za-z]|$)/.test(String(verdict?.event?.content?.text ?? ""))) {
  throw new Error("a judge's PASS reply was not accepted by its Port's schema: " + JSON.stringify({ settled: judged.settled, outputs: judged.outputs }));
}
step("a judge's reply matched its Port's schema and was handed on as its verdict: " + JSON.stringify(String(verdict.event.content.text).slice(0, 40)));

// A route that breaks its own rules is refused before anything runs.
const invokeRaw = async (body) => {
  const response = await fetch(bus + "/v1/workspaces/" + encodeURIComponent(joined.workspace_id) + "/operations/invoke", {
    method: "POST", headers: auth, body: JSON.stringify({ operation_version: "1", input_schema_version: "1", ...body }),
  });
  return { status: response.status, json: await response.json() };
};
const refusedWith = async (body, expected, label) => {
  const { status, json } = await invokeRaw(body);
  const text = JSON.stringify(json);
  if (json.receipt?.state === "completed" || !text.includes(expected)) {
    throw new Error(label + " was not refused with '" + expected + "': " + status + " " + text);
  }
};
const rulesScope = (await invokeAs("completed", { operation_id: "scope.create", idempotency_key: "guard-rules-scope", input: { title: "Release guard rules" } })).scope;
const rulesIngress = (await invokeAs("completed", { operation_id: "context.create", idempotency_key: "guard-rules-ingress",
  input: { scope_id: rulesScope.scope_id, title: "Release guard rules input", participants: [] } })).context;
const ingressNode = { node_id: "ingress", kind: "event", config: { event_type: "work.requested" }, context_policy: { mode: "fixed", context_id: rulesIngress.context_id } };
const ingressPort = { port_id: "ingress:out", node_id: "ingress", name: "work", direction: "output", event_types: ["work.requested"] };
await refusedWith({ operation_id: "scope.composition.draft.create", idempotency_key: "guard-bad-schema-draft",
  target: { kind: "scope", id: rulesScope.scope_id }, expected_resource_revision: "none",
  input: { content: {
    nodes: [ingressNode, { node_id: "worker", kind: "actor", resource_id: floe, activation: { mode: "per_delivery" }, context_policy: { mode: "new_per_execution" } }],
    ports: [ingressPort,
      { port_id: "worker:in", node_id: "worker", name: "work", direction: "input", event_types: ["work.requested"], min_count: 1 },
      { port_id: "worker:out", node_id: "worker", name: "result", direction: "output", event_types: ["work.completed"], schema: { type: "object", requird: ["text"] } }],
    edges: [{ edge_id: "ingress-to-worker", source_port_id: "ingress:out", target_port_id: "worker:in" }],
  } } }, "schema is not usable", "a route whose output schema is misspelt");
step("a route whose output schema is misspelt was refused, naming the Port");
await refusedWith({ operation_id: "scope.composition.draft.create", idempotency_key: "guard-same-judge-draft",
  target: { kind: "scope", id: rulesScope.scope_id }, expected_resource_revision: "none",
  input: { content: {
    nodes: [ingressNode,
      { node_id: "builder", kind: "actor", resource_id: floe, activation: { mode: "per_delivery" }, context_policy: { mode: "new_per_execution" } },
      { node_id: "judge", kind: "actor", resource_id: floe, activation: { mode: "per_delivery" }, context_policy: { mode: "new_per_execution" }, distinct_actor_from: ["builder"] }],
    ports: [ingressPort,
      { port_id: "builder:in", node_id: "builder", name: "work", direction: "input", event_types: ["work.requested"], min_count: 1 },
      { port_id: "judge:in", node_id: "judge", name: "work", direction: "input", event_types: ["work.requested"], min_count: 1 }],
    edges: [
      { edge_id: "ingress-to-builder", source_port_id: "ingress:out", target_port_id: "builder:in" },
      { edge_id: "ingress-to-judge", source_port_id: "ingress:out", target_port_id: "judge:in" }],
  } } }, "must have different Actors", "a route whose judge is its builder");
step("a route whose judge is the same Actor as its builder was refused");

// A person can hold a route's start for their approval with an ordinary Policy.
// Nothing starts until they approve; the request and the decision are pushed.
const policyDraft = (await invokeAs("completed", { operation_id: "policy.create", idempotency_key: "guard-approval-policy",
  input: { category: "operation", content: { label: "Release guard approval", description: "The person approves the route before it starts.",
    rules: [{ rule_id: "approve-start", priority: 50, match: { operation_ids: ["scope.execution.start"], scope_ids: [rulesScope.scope_id] },
      effect: { kind: "require_approval", reason: "The person approves the checks first.", approvers: { mode: "any", principal_ids: ["identity:guard-unset"], roles: [] } } }] } } })).draft;
const person = policyDraft.created_by_principal_id;
const namedDraft = await invokeAs("completed", { operation_id: "policy.draft.replace", idempotency_key: "guard-approval-policy-name",
  target: { kind: "policy_revision", id: policyDraft.policy_revision_id }, expected_resource_revision: policyDraft.semantic_digest,
  input: { content: { ...policyDraft.content, rules: policyDraft.content.rules.map((rule) => ({ ...rule,
    effect: { ...rule.effect, approvers: { mode: "any", principal_ids: [person], roles: [] } } })) } } });
const publishedPolicy = (await invokeAs("completed", { operation_id: "policy.publish", idempotency_key: "guard-approval-policy-publish",
  target: { kind: "policy_revision", id: namedDraft.policy_revision_id }, expected_resource_revision: namedDraft.semantic_digest,
  input: { expected_current_revision_id: null } })).revision;
await invokeAs("completed", { operation_id: "policy.bind", idempotency_key: "guard-approval-policy-bind",
  target: { kind: "policy_revision", id: publishedPolicy.policy_revision_id }, expected_resource_revision: publishedPolicy.semantic_digest,
  input: { subject: { kind: "workspace", id: joined.workspace_id } } });
const approvalDraft = (await invokeAs("completed", { operation_id: "scope.composition.draft.create", idempotency_key: "guard-approval-draft",
  target: { kind: "scope", id: rulesScope.scope_id }, expected_resource_revision: "none",
  input: { content: {
    nodes: [ingressNode, { node_id: "worker", kind: "actor", resource_id: floe, activation: { mode: "per_delivery" }, context_policy: { mode: "new_per_execution" } }],
    ports: [ingressPort,
      { port_id: "worker:in", node_id: "worker", name: "work", direction: "input", event_types: ["work.requested"], min_count: 1 },
      { port_id: "worker:out", node_id: "worker", name: "result", direction: "output", event_types: ["work.completed"], min_count: 1 }],
    edges: [{ edge_id: "ingress-to-worker", source_port_id: "ingress:out", target_port_id: "worker:in" }],
  } } })).revision;
const approvalTarget = { kind: "scope_composition_revision", id: approvalDraft.revision_id };
const approvalImpact = await invokeAs("completed", { operation_id: "scope.composition.impact.inspect", idempotency_key: "guard-approval-impact",
  target: approvalTarget, expected_resource_revision: approvalDraft.semantic_digest, input: {} });
await invokeAs("completed", { operation_id: "scope.composition.publish", idempotency_key: "guard-approval-publish",
  target: approvalTarget, expected_resource_revision: approvalDraft.semantic_digest,
  input: { expected_current_published_revision_id: null, expected_impact_digest: approvalImpact.impact_digest } });
const approvalStart = { operation_id: "scope.execution.start", idempotency_key: "guard-approval-run",
  target: { kind: "scope", id: rulesScope.scope_id }, expected_resource_revision: approvalDraft.revision_id,
  input: { ingress_node_id: "ingress", output_port_id: "ingress:out", content: { request: "Reply with the single word: approved" } } };
const held = await invokeRaw(approvalStart);
const approvalId = held.json.receipt?.governance?.approval_request_ids?.[0];
if (held.json.receipt?.state !== "awaiting_approval" || !approvalId) {
  throw new Error("a route start under an approval Policy was not held for approval: " + held.status + " " + JSON.stringify(held.json));
}
await until((push) => push.type === "approval_requested" && push.payload?.request?.approval_request_id === approvalId, "the approval request push", 15000);
step("a route start under an approval Policy was held, and the approval request was pushed");
await invokeAs("completed", { operation_id: "approval.decide", idempotency_key: "guard-approve",
  target: { kind: "approval_request", id: approvalId }, input: { decision: "approved", reason: "Checks look right." } });
await until((push) => push.type === "approval_decided" && JSON.stringify(push.payload).includes(approvalId), "the approval decision push", 15000);
const approvedRun = (await invokeAs("accepted", approvalStart)).execution;
await until((push) => push.type === "node_execution_state_changed" && push.payload.scope_execution_id === approvedRun.execution_id
  && push.payload.node_id === "worker" && ["completed", "failed"].includes(push.payload.to_status), "the approved route's step settling", 180000);
step("once the person approved, the decision was pushed and the same start set the route out (" + approvedRun.execution_id + ")");

const readinessPushes = [];
let readinessArrived = () => {};
const stopFollowing = await identity.followSwitchReadiness((readiness) => { readinessPushes.push(readiness); readinessArrived(); });
const readinessUntil = (check, label, ms) => {
  const found = () => readinessPushes.find(check);
  if (found()) return Promise.resolve(found());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no switch readiness push for " + label + " within " + ms + "ms: " + JSON.stringify(readinessPushes))), ms);
    readinessArrived = () => { const hit = found(); if (hit) { clearTimeout(timer); resolve(hit); } };
  });
};

for (let pauseRun = 1; pauseRun <= PAUSE_RUNS; pauseRun += 1) {
  const suffix = String(pauseRun).padStart(2, "0");
  const started = join(${JSON.stringify(folder)}, "guard-pause-started-" + suffix + ".txt");
  const finished = join(${JSON.stringify(folder)}, "guard-pause-finished-" + suffix + ".txt");
  const command = process.platform === "win32"
    ? "if (Test-Path '" + started + "') { 'second run' } else { Set-Content -Path '" + started + "' -Value started; Start-Sleep -Seconds " + HOLD_SECONDS + "; Set-Content -Path '" + finished + "' -Value finished }"
    : "if [ -f '" + started + "' ]; then echo second run; else echo started > '" + started + "'; sleep " + HOLD_SECONDS + "; echo finished > '" + finished + "'; fi";
  const markerSeen = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { watcher.close(); reject(new Error("pause run " + pauseRun + " never started its command within 180s")); }, 180000);
    const watcher = watch(${JSON.stringify(folder)}, () => {
      if (!existsSync(started)) return;
      clearTimeout(timer); watcher.close(); resolve();
    });
  });
  const run = (await invokeAs("accepted", { operation_id: "scope.execution.start", idempotency_key: "guard-run-" + suffix,
    target: { kind: "scope", id: scope.scope_id }, expected_resource_revision: draft.revision_id,
    input: { ingress_node_id: "ingress", output_port_id: "ingress:out", content: {
      request: "Use your shell tool to run exactly this command once, then reply with the single word: done. Command: " + command,
    } } })).execution;
  await markerSeen;
  const commandStarted = Date.now();
  let toolPush = null;
  if (pauseRun === 1) {
    toolPush = await until((push) => push.type === "runtime_telemetry" && push.payload?.telemetry?.kind === "tool_activity"
      && push.payload.telemetry.payload?.scope_execution_id === run.execution_id && push.payload.telemetry.payload.status === "started",
      "a live push of the running tool call", 15000);
    if ("arguments" in toolPush.payload.telemetry.payload) throw new Error("a live tool push carried the tool's arguments");
    step("mid-command, the running tool call was pushed live: " + toolPush.payload.telemetry.payload.name + " started");
    const turns = await identity.runningTurns();
    if (!turns.some((turn) => turn.workspace_id === joined.workspace_id)) {
      throw new Error("a turn was mid-command but runningTurns() did not name it, so a version switch could interrupt it silently: " + JSON.stringify(turns));
    }
    step("mid-command, runningTurns() named the turn a version switch would interrupt: " + turns.map((turn) => turn.endpoint_id).join(", "));
    const busy = await readinessUntil((readiness) => readiness.following && !readiness.ready
      && readiness.running.some((turn) => turn.workspace_id === joined.workspace_id), "the mid-command turn", 30000);
    step("mid-command, switch readiness was pushed as not ready, naming " + busy.running.map((turn) => turn.endpoint_id).join(", "));
    readinessPushes.length = 0;
  }
  const nodeReached = (status, label, ms) => until((push) => push.type === "node_execution_state_changed"
    && push.payload.scope_execution_id === run.execution_id && push.payload.node_id === "worker"
    && push.payload.to_status === status, label, ms);
  await invokeAs("accepted", { operation_id: "scope.execution.pause", idempotency_key: "guard-pause-" + suffix,
    target: { kind: "scope_execution", id: run.execution_id },
    expected_resource_revision: revisionOf(await current({ executionId: run.execution_id, idempotencyKey: "guard-inspect-pause-" + suffix })), input: {} });
  await nodeReached("paused", "pause run " + pauseRun + " node pausing", 60000);
  await until((push) => push.type === "scope_execution_paused" && push.payload.execution.execution_id === run.execution_id,
    "pause run " + pauseRun + " execution pausing", 60000);
  if (pushes.some((push) => push.type === "node_execution_state_changed" && push.payload.scope_execution_id === run.execution_id
    && push.payload.node_id === "worker" && push.payload.to_status === "completed")) {
    throw new Error("pause run " + pauseRun + " completed instead of being interrupted");
  }
  const pausedAt = Date.now();
  if (pauseRun === 1) {
    await readinessUntil((readiness) => readiness.following && readiness.ready, "the paused turn stopping", 60000);
    step("once the turn stopped, switch readiness was pushed as ready, with nothing running");
    await stopFollowing();
  }
  await invokeAs("accepted", { operation_id: "scope.execution.resume", idempotency_key: "guard-resume-" + suffix,
    target: { kind: "scope_execution", id: run.execution_id },
    expected_resource_revision: revisionOf(await current({ executionId: run.execution_id, idempotencyKey: "guard-inspect-resume-" + suffix })), input: {} });
  const resumed = await until((push) => push.type === "node_execution_state_changed"
    && push.payload.scope_execution_id === run.execution_id && push.payload.node_id === "worker"
    && ["completed", "failed"].includes(push.payload.to_status),
    "pause run " + pauseRun + " resumed node settling", 180000);
  if (resumed.payload.to_status !== "completed") {
    throw new Error("pause run " + pauseRun + " resumed turn failed: " + JSON.stringify(resumed.payload));
  }
  if (pauseRun === 1) {
    // A person can read afterwards which model the resumed turn ran on and which
    // tools it used, with Floe's decision on each, and never the arguments.
    const pausedDelivery = toolPush.payload.telemetry.delivery_id;
    const resumedDelivery = pushes.find((push) => push.type === "runtime_telemetry" && push.payload?.telemetry?.kind === "tool_activity"
      && push.payload.telemetry.payload?.scope_execution_id === run.execution_id && push.payload.telemetry.delivery_id !== pausedDelivery)
      ?.payload.telemetry.delivery_id;
    if (!resumedDelivery) throw new Error("the resumed turn pushed no tool call, so its tools cannot be read back");
    const turn = await invoke({ operation_id: "runtime.delivery.inspect", operation_version: "1", input_schema_version: "1",
      idempotency_key: "guard-turn-inspect", target: { kind: "runtime_delivery", id: resumedDelivery }, input: {} });
    const ran = turn.tools.find((tool) => tool.name && tool.status === "completed");
    const decided = turn.tool_decisions.find((decision) => decision.decision === "allow" && decision.operation_id === "engine.tool.process.execute");
    if (typeof turn.model !== "string" || turn.model === "" || !ran || !decided) {
      throw new Error("runtime.delivery.inspect did not show the resumed turn's model, a completed tool and an allowed shell decision: " + JSON.stringify(turn));
    }
    if (JSON.stringify(turn).includes("guard-pause-started")) throw new Error("runtime.delivery.inspect showed a tool's arguments");
    step("runtime.delivery.inspect read the resumed turn: ran on " + turn.model + ", ran " + ran.name + ", " + turn.tool_decisions.length + " tool decision(s) for this turn only");
  }
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, commandStarted + (HOLD_SECONDS + 5) * 1000 - Date.now())));
  if (existsSync(finished)) {
    throw new Error("pause run " + pauseRun + " wrote its completion marker after paused was reported at " + new Date(pausedAt).toISOString());
  }
  step("pause run " + pauseRun + "/" + PAUSE_RUNS + " stopped without a late completion marker in " + (pausedAt - commandStarted) + "ms");
}
step(PAUSE_RUNS + " consecutive real mid-command pauses completed with zero leaks");
const sameVersion = await identity.switchToThisVersion();
if (sameVersion.kind !== "already_serving") throw new Error("asking the serving version to switch to itself did not answer already_serving: " + JSON.stringify(sameVersion));
step("a version switch request to the version already serving changed nothing (already_serving " + sameVersion.version + ")");
socket.close();
identity.close();
`, "utf8");
  const run = spawnSync(process.execPath, [join(surfaceDir, "surface.mjs")], {
    cwd: neutralCwd, stdio: ["ignore", "inherit", "pipe"], encoding: "utf8",
  });
  process.stderr.write(run.stderr ?? "");
  if (run.status !== 0) {
    dumpLog(home, "identity");
    dumpLog(home, "bridge");
    // The logs are long; restate the surface's own failure last so it is never lost.
    const reason = (run.stderr ?? "").split(/\r?\n/).find((line) => /^\w*Error:/.test(line.trim())) ?? `exit ${run.status}`;
    throw new Error(`the guard surface could not complete the identity flow, a real turn, a created Actor's real turn, and a real pause and resume through the installed artifact: ${reason.trim()}`);
  }
}

// ── 6. publish ───────────────────────────────────────────────────────────────

function tagFor(version) {
  return `v${version}`;
}

/**
 * A released version is immutable: surfaces depend on the tag, so the same tag
 * must never point at two different artifacts. Checked before building so a
 * forgotten version bump fails in seconds, not after a full build and guard.
 */
function refuseExistingTag(version) {
  const tag = tagFor(version);
  const out = execFileSync("git", ["ls-remote", "--tags", distRepo, `refs/tags/${tag}`], { encoding: "utf8" });
  if (out.trim()) {
    fail(`${distRepo} already has release ${tag}. Bump the version in the source packages before releasing.`);
  }
}

function publish(version) {
  const tag = tagFor(version);
  log("publish", `committing the generated artifact to ${distRepo} as ${tag}`);
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
    execFileSync("git", ["commit", "-m", `Release floe ${version}\n\nBuilt from floe-ai/floe-substrate commit ${process.env[SOURCE_COMMIT_ENV]}.`], { cwd: clone, stdio: "inherit" });
    execFileSync("git", ["tag", "-a", tag, "-m", `floe ${version}`], { cwd: clone, stdio: "inherit" });
    execFileSync("git", ["push", "origin", "HEAD", `refs/tags/${tag}`], { cwd: clone, stdio: "inherit" });
    log("publish", `pushed floe ${version} to ${distRepo}, tagged ${tag}`);
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

// A release proves and ships one commit, never this machine's working tree or
// node_modules: the outer run clones the commit, installs exactly what its
// lockfile records, and reruns this script inside that clone.
if (process.env[SOURCE_COMMIT_ENV]) {
  requireCleanSource();
} else {
  releaseFromCleanClone();
}
const version = resolveVersion();
log("start", `building floe ${version} from commit ${process.env[SOURCE_COMMIT_ENV]} (publish: ${doPublish ? "yes" : "no"})`);
if (doPublish) refuseExistingTag(version);
buildServices();
assemble(version);
await guard(version);
if (doPublish) {
  publish(version);
} else {
  log("done", `staged and verified at ${outDir}. Re-run with --publish to push to the distribution repo.`);
}
