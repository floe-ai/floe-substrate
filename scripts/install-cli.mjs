// install-cli — put `floe` on PATH as a real, independent global install.
//
// `npm install -g ./floe-cli` symlinks (junctions on Windows) a local folder,
// which is just `npm link` under another name: it breaks if the checkout moves
// and reflects uncommitted files. Installing a packed tarball instead extracts a
// real copy, so `floe` is genuinely installed rather than linked.
//
// One documented command: `npm run install:cli` from the repo root.
import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliDir = join(repoRoot, "floe-cli");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// npm is a shell shim on Windows, so run it through a shell. Quote any argument
// containing whitespace so paths survive; join into one command string to avoid
// the args+shell deprecation.
const quote = (arg) => (/\s/.test(arg) ? `"${arg}"` : arg);
const npmCommand = (args) => `${npm} ${args.map(quote).join(" ")}`;

function run(args, cwd = repoRoot) {
  execSync(npmCommand(args), { cwd, stdio: "inherit" });
}

// 1. Build the native broker and the dist the tarball ships.
run(["run", "build", "--workspace", "floe-cli"]);

// 2. Pack floe-cli into a throwaway directory and install that tarball globally.
const stage = mkdtempSync(join(tmpdir(), "floe-cli-pack-"));
try {
  execSync(npmCommand(["pack", "--pack-destination", stage]), { cwd: cliDir, stdio: "inherit" });
  const tarball = readdirSync(stage).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack did not produce a tarball");
  run(["install", "-g", join(stage, tarball)]);
} finally {
  rmSync(stage, { recursive: true, force: true });
}

console.log("\nfloe is installed. Open a new shell and run: floe");
