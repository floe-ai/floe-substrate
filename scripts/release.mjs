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
 *   1. build every service package from source (a package whose dist did not
 *      build cannot ship);
 *   2. assemble the single package: bundle each service, generate package.json;
 *   3. GUARD: pack it, install it globally into an isolated prefix from a working
 *      directory unrelated to this checkout, start Floe from that install, and
 *      complete one real turn through its own Bridge as this machine's Copilot
 *      account, then pause a second real turn mid-command and resume it —
 *      refuse to publish an artifact that installs but cannot start, cannot run
 *      a turn, or cannot interrupt and resume one;
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
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

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
    guardSurface({ workRoot, tarball: join(workRoot, tarball), configPath, port, neutralCwd, home, account });
    log("guard", `PASS — a surface depending on the artifact used the identity agent, a real turn completed as ${account.label}, and a real turn paused mid-command and resumed`);
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
function guardSurface({ workRoot, tarball, configPath, port, neutralCwd, home, account }) {
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
const joined = await identity.joinFolder({ locator: ${JSON.stringify(folder)}, create_directory: true });
if (joined.kind !== "ready" && joined.kind !== "pending") throw new Error("joining a folder failed: " + JSON.stringify(joined));
step("joined " + joined.workspace_id);
const ready = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("no bearer was pushed within 15s")), 15000);
  identity.session({ workspace_id: joined.workspace_id }, (event) => {
    if (event.status === "ready") { clearTimeout(timer); resolve(event); }
    else if (event.status !== "selection_required") { clearTimeout(timer); reject(new Error("session: " + JSON.stringify(event))); }
  });
});
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
engines.close();
if (copilot.phase !== "ready" || copilot.account?.label?.toLowerCase() !== ${JSON.stringify(account.label.toLowerCase())}) {
  throw new Error("the installed Bridge's engine is not ready as ${account.label}: " + JSON.stringify(copilot));
}

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
const until = (match, label, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("no " + label + " within " + ms / 1000 + "s")), ms);
  const look = () => {
    const found = pushes.find(match);
    if (found) { clearTimeout(timer); arrived = () => {}; resolve(found); }
    else if (closed) { clearTimeout(timer); reject(new Error(closed + " before " + label + "; received " + JSON.stringify(pushes.map((push) => push.type)))); }
  };
  arrived = look;
  look();
});
await until((push) => push.type === "caught_up", "stream catch-up", 15000);
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

// Pause a real turn mid-flight, then resume it. The Floe Actor runs one Scope
// node whose shell command writes a marker, waits, then writes a second file.
// The gate pauses the moment the marker appears, so the engine is inside the
// command. A real interrupt stops the command, so the second file never
// appears; the rerun after resume finds the marker and finishes at once.
const { existsSync, watch } = await import("node:fs");
const { join } = await import("node:path");
const started = join(${JSON.stringify(folder)}, "guard-pause-started.txt");
const finished = join(${JSON.stringify(folder)}, "guard-pause-finished.txt");
const HOLD_SECONDS = 20;
const command = process.platform === "win32"
  ? "if (Test-Path '" + started + "') { 'second run' } else { Set-Content -Path '" + started + "' -Value started; Start-Sleep -Seconds " + HOLD_SECONDS + "; Set-Content -Path '" + finished + "' -Value finished }"
  : "if [ -f '" + started + "' ]; then echo second run; else echo started > '" + started + "'; sleep " + HOLD_SECONDS + "; echo finished > '" + finished + "'; fi";
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
const markerSeen = new Promise((resolve, reject) => {
  const timer = setTimeout(() => { watcher.close(); reject(new Error("the Actor never started the command within 180s")); }, 180000);
  const watcher = watch(${JSON.stringify(folder)}, () => {
    if (!existsSync(started)) return;
    clearTimeout(timer); watcher.close(); resolve();
  });
});
const run = (await invokeAs("accepted", { operation_id: "scope.execution.start", idempotency_key: "guard-run",
  target: { kind: "scope", id: scope.scope_id }, expected_resource_revision: draft.revision_id,
  input: { ingress_node_id: "ingress", output_port_id: "ingress:out", content: {
    request: "Use your shell tool to run exactly this command once, then reply with the single word: done. Command: " + command,
  } } })).execution;
step("started a Scope run with the Floe Actor");
await markerSeen;
const commandStarted = Date.now();
step("the real turn is inside its shell command; pausing");
// The execution's revision is its pinned plan, counter, status and end stamps (scope-execution-contract.ts).
const revisionOf = (execution) => [execution.revision_id, execution.state_revision, execution.status,
  execution.completed_at ?? "", execution.cancelled_at ?? ""].join(":");
const current = async (key) => (await invokeAs("completed", { operation_id: "scope.execution.inspect", idempotency_key: key,
  target: { kind: "scope_execution", id: run.execution_id }, input: {} })).execution;
const nodeReached = (status, label, ms) => until((push) => push.type === "node_execution_state_changed"
  && push.payload.scope_execution_id === run.execution_id && push.payload.node_id === "worker"
  && push.payload.to_status === status, label, ms);
await invokeAs("accepted", { operation_id: "scope.execution.pause", idempotency_key: "guard-pause",
  target: { kind: "scope_execution", id: run.execution_id }, expected_resource_revision: revisionOf(await current("guard-inspect-1")), input: {} });
await nodeReached("paused", "the interrupted node pausing", 60000);
await until((push) => push.type === "scope_execution_paused" && push.payload.execution.execution_id === run.execution_id, "the run pausing", 60000);
if (pushes.some((push) => push.type === "node_execution_state_changed" && push.payload.scope_execution_id === run.execution_id
  && push.payload.node_id === "worker" && push.payload.to_status === "completed")) throw new Error("the node completed instead of being interrupted");
step("paused mid-turn: the engine stopped the turn " + (Date.now() - commandStarted) + "ms into the command");
await invokeAs("accepted", { operation_id: "scope.execution.resume", idempotency_key: "guard-resume",
  target: { kind: "scope_execution", id: run.execution_id }, expected_resource_revision: revisionOf(await current("guard-inspect-2")), input: {} });
await nodeReached("completed", "the resumed node completing", 180000);
step("resumed: the node reran and completed");
await new Promise((resolve) => setTimeout(resolve, Math.max(0, commandStarted + (HOLD_SECONDS + 5) * 1000 - Date.now())));
if (existsSync(finished)) throw new Error("the interrupted command kept running after pause: the engine did not stop it");
step("the interrupted command never finished");
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
    throw new Error(`the guard surface could not complete the identity flow, a real turn, and a real pause and resume through the installed artifact: ${reason.trim()}`);
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
    execFileSync("git", ["commit", "-m", `Release floe ${version}`], { cwd: clone, stdio: "inherit" });
    execFileSync("git", ["tag", "-a", tag, "-m", `floe ${version}`], { cwd: clone, stdio: "inherit" });
    execFileSync("git", ["push", "origin", "HEAD", `refs/tags/${tag}`], { cwd: clone, stdio: "inherit" });
    log("publish", `pushed floe ${version} to ${distRepo}, tagged ${tag}`);
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const version = resolveVersion();
log("start", `building floe ${version} (publish: ${doPublish ? "yes" : "no"})`);
if (doPublish) refuseExistingTag(version);
buildServices();
assemble(version);
await guard(version);
if (doPublish) {
  publish(version);
} else {
  log("done", `staged and verified at ${outDir}. Re-run with --publish to push to the distribution repo.`);
}
