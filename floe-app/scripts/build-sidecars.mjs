import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPackagedHosts } from "./verify-packaged-hosts.mjs";
import { verifySubstrateContinuity } from "./check-substrate-continuity.mjs";
import { packageImageRuntime } from "./package-image-runtime.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appVersion = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf8")).version;
let buildSha = null;
try {
  buildSha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: appRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim() || null;
} catch {
  buildSha = null;
}
const rustInfo = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const host = /^host:\s+(\S+)$/m.exec(rustInfo)?.[1];
const target = process.env.TAURI_ENV_TARGET_TRIPLE || host;
if (!target) throw new Error("Could not determine the Rust target triple for the desktop sidecars");

const extension = process.platform === "win32" ? ".exe" : "";
const nodeOutput = resolve(appRoot, "src-tauri", "binaries", `floe-node-${target}${extension}`);
const authorityOutput = resolve(appRoot, "src-tauri", "binaries", `floe-authority-broker-${target}${extension}`);
const scriptOutput = resolve(appRoot, "src-tauri", "resources", "floe-desktop.js");
const promptOutput = resolve(appRoot, "src-tauri", "resources", "prompts");
mkdirSync(dirname(nodeOutput), { recursive: true });
mkdirSync(dirname(scriptOutput), { recursive: true });
mkdirSync(promptOutput, { recursive: true });
copyFileSync(process.execPath, nodeOutput);
chmodSync(nodeOutput, 0o755);
const cargoArgs = ["build", "--release", "--manifest-path", resolve(appRoot, "..", "floe-native-authority", "Cargo.toml")];
if (process.env.TAURI_ENV_TARGET_TRIPLE) cargoArgs.push("--target", target);
execFileSync("cargo", cargoArgs, {
  cwd: appRoot,
  stdio: "inherit",
});
const authorityBuild = process.env.TAURI_ENV_TARGET_TRIPLE
  ? resolve(appRoot, "..", "floe-native-authority", "target", target, "release", `floe-authority-broker${extension}`)
  : resolve(appRoot, "..", "floe-native-authority", "target", "release", `floe-authority-broker${extension}`);
copyFileSync(authorityBuild, authorityOutput);
chmodSync(authorityOutput, 0o755);
for (const name of ["default-floe-agent.md", "substrate-build-skill.md", "substrate-guidance.md"]) {
  copyFileSync(resolve(appRoot, "..", "floe-bridge", "src", "prompts", name), resolve(promptOutput, name));
}
execFileSync(
  "bun",
  [
    "build",
    resolve(appRoot, "src-desktop-sidecar", "index.ts"),
    "--target=node",
    "--external=sharp",
    "--outfile",
    scriptOutput,
    "--define",
    `process.env.FLOE_RELEASE_VERSION=${JSON.stringify(appVersion)}`,
    "--define",
    `process.env.FLOE_BUILD_SHA=${JSON.stringify(buildSha)}`,
  ],
  { cwd: appRoot, stdio: "inherit" },
);

// These processes are launched by adjacent URL from the bundled Bus. Bundle
// them independently so installed execution never relies on source or npm files.
for (const name of ["isolated-command-host-process", "isolated-extension-host-process"]) {
  execFileSync("bun", [
    "build",
    resolve(appRoot, "..", "floe-bus", "src", `${name}.ts`),
    "--target=node",
    "--outfile",
    resolve(dirname(scriptOutput), `${name}.js`),
  ], { cwd: appRoot, stdio: "inherit" });
}

const desktopBundle = readFileSync(scriptOutput, "utf8");
packageImageRuntime(appRoot, dirname(scriptOutput));
for (const providerLogin of ["loginOpenAICodex", "loginGitHubCopilot"]) {
  if (!desktopBundle.includes(providerLogin)) throw new Error(`Desktop bundle omitted Pi OAuth flow: ${providerLogin}`);
}
const oauthRegistration = desktopBundle.lastIndexOf("registerBunOAuthFlows();");
const commandDispatch = desktopBundle.indexOf('if (command === "auth")');
if (oauthRegistration < 0 || commandDispatch < 0 || oauthRegistration > commandDispatch) {
  throw new Error("Desktop bundle registers Pi OAuth flows after command dispatch");
}

await verifyPackagedHosts({ nodePath: nodeOutput, resourcePath: dirname(scriptOutput) });
await verifySubstrateContinuity({ nodePath: nodeOutput, resourcePath: dirname(scriptOutput) });
