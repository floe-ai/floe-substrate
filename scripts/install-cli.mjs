// install-cli — put `floe` on PATH as a real, independent global install that
// can actually start the substrate.
//
// `npm install -g ./floe-cli` symlinks (junctions on Windows) a local folder,
// which is just `npm link` under another name: it breaks if the checkout moves
// and reflects uncommitted files. Installing packed tarballs instead extracts
// real copies, so `floe` is genuinely installed rather than linked.
//
// The CLI alone is not enough: `floe start` launches the bus and bridge by
// running their built entry (floe-bus/dist/index.js, floe-bridge/dist/index.js)
// with node. Those packages must therefore be installed *alongside* floe-cli so
// node can resolve them from the global node_modules. A previous version shipped
// only the CLI and started the services with `npm run dev --workspace floe-bus`
// — a monorepo dev script that does not exist in an installed package — so the
// global install could put `floe` on PATH but never start Floe. We install all
// three tarballs together in one `npm install -g` so they land as siblings in
// the global node_modules and resolve each other with no monorepo present.
//
// One documented command: `npm run install:cli` from the repo root.
import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// The three packages that must be installed together. floe-cli carries the
// `floe` bin; floe-bus and floe-bridge are the substrate services it starts.
const packages = ["floe-cli", "floe-bus", "floe-bridge"];

// npm is a shell shim on Windows, so run it through a shell. Quote any argument
// containing whitespace so paths survive; join into one command string to avoid
// the args+shell deprecation.
const quote = (arg) => (/\s/.test(arg) ? `"${arg}"` : arg);
const npmCommand = (args) => `${npm} ${args.map(quote).join(" ")}`;

function run(args, cwd = repoRoot) {
  execSync(npmCommand(args), { cwd, stdio: "inherit" });
}

// 1. Build each package's shipped dist (floe-cli's build also builds the native
//    broker). The tarballs carry dist/, so a stale dist would ship stale code.
//    A build failure here is fatal on purpose: shipping a package whose dist did
//    not build (or is stale) is exactly the kind of quiet install that starts
//    but cannot run. Fail loudly, naming the package, rather than packing
//    whatever dist happened to be left on disk.
for (const pkg of packages) {
  try {
    run(["run", "build", "--workspace", pkg]);
  } catch {
    console.error(
      `\nInstall aborted: ${pkg} failed to build, so it cannot be installed.\n` +
        `A global install must ship freshly built code, not a stale or missing dist.\n` +
        `Fix ${pkg}'s build (see the compiler output above) and re-run \`npm run install:cli\`.`,
    );
    process.exit(1);
  }
}

// 2. Pack all three into a throwaway directory and install those tarballs
//    globally in a single command, so they are installed as sibling packages.
const stage = mkdtempSync(join(tmpdir(), "floe-pack-"));
try {
  for (const pkg of packages) {
    execSync(npmCommand(["pack", "--pack-destination", stage]), { cwd: join(repoRoot, pkg), stdio: "inherit" });
  }
  const tarballs = readdirSync(stage)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => join(stage, name));
  if (tarballs.length !== packages.length) {
    throw new Error(`expected ${packages.length} tarballs, npm pack produced ${tarballs.length}`);
  }
  run(["install", "-g", ...tarballs]);
} finally {
  rmSync(stage, { recursive: true, force: true });
}

console.log("\nfloe is installed. Open a new shell and run: floe");
