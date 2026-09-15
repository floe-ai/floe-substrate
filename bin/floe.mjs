#!/usr/bin/env node
// Launcher for the floe CLI when running from source.
//
// Running the CLI through `npm run floe -- ...` is unsafe: npm consumes any
// flag it recognises (--help, --workspace, -w, --version) before it ever
// reaches the CLI, so those flags are silently dropped. This shim re-execs
// the TypeScript entry through tsx and forwards argv untouched, so every
// flag reaches the CLI exactly as typed.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../floe-cli/src/index.ts", import.meta.url));
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", entry, ...process.argv.slice(2)],
  { stdio: "inherit" },
);

if (result.error) {
  console.error("Failed to launch the floe CLI:", result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
