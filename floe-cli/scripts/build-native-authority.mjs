#!/usr/bin/env node
/**
 * Build the native authority broker and place it where the CLI resolves it.
 *
 * floe-cli talks to the substrate through a trusted local broker binary
 * (`floe-authority-broker`). It used to be produced and positioned by the
 * Tauri desktop packaging; that packaging is gone. The CLI is now the only
 * front door, so the CLI's own build must produce and place the broker.
 *
 * The broker is compiled from the independent `floe-native-authority` Rust
 * crate and copied to `floe-cli/native/`, which `resolveNativeAuthorityBrokerPath`
 * checks relative to both `src/` (dev) and `dist/` (built).
 *
 * This is a build/install step, not a runtime feature. If Rust/cargo is
 * absent it fails with an actionable message rather than a stand-in.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const crateRoot = resolve(cliRoot, "..", "floe-native-authority");
const manifest = resolve(crateRoot, "Cargo.toml");
const extension = process.platform === "win32" ? ".exe" : "";
const binaryName = `floe-authority-broker${extension}`;
const nativeDir = resolve(cliRoot, "native");
const destination = resolve(nativeDir, binaryName);

function fail(message) {
  console.error(`\nfloe-cli: cannot build the native authority broker.\n${message}\n`);
  process.exit(1);
}

try {
  execFileSync("cargo", ["--version"], { stdio: "ignore" });
} catch {
  fail(
    "Rust's `cargo` was not found on PATH. The broker is compiled from the\n"
    + "floe-native-authority crate. Install Rust (https://rustup.rs) and retry\n"
    + "`npm run build --workspace floe-cli`.",
  );
}

try {
  execFileSync("cargo", ["build", "--release", "--manifest-path", manifest], { stdio: "inherit" });
} catch {
  fail("The floe-native-authority crate failed to compile. See the cargo output above.");
}

const built = resolve(crateRoot, "target", "release", binaryName);
mkdirSync(nativeDir, { recursive: true });
try {
  copyFileSync(built, destination);
  if (process.platform !== "win32") chmodSync(destination, 0o755);
} catch (error) {
  fail(`Built the broker but could not place it at ${destination}: ${String(error)}`);
}

console.log(`floe-cli: native authority broker ready at ${destination}`);
