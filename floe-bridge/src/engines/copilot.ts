/**
 * The Copilot engine as the Bridge runs it: the SDK for turns and readiness,
 * and the official Copilot CLI (a pinned dependency, never a global install)
 * for the vendor's own sign-in.
 *
 * Neither ever sees a credential from Floe's environment: GitHub gives
 * COPILOT_GITHUB_TOKEN, GH_TOKEN and GITHUB_TOKEN precedence over the signed-in
 * account, so they are removed from every child's environment.
 */
import { createRequire } from "node:module";
import { CopilotEngineAccountAdapter, copilotChildEnvironment } from "floe-runtime/adapters/copilot";
import type { EngineAccount } from "./engine-control.js";

/**
 * The official CLI's native binary for this platform. Its npm entry is a
 * launcher that runs the binary as a second process, so stopping the launcher
 * would leave a cancelled sign-in running; Floe launches the binary itself,
 * chosen the way the launcher chooses it.
 */
export function packagedCopilotCliPath(): string | null {
  const require = createRequire(import.meta.url);
  let launcher: string;
  try {
    launcher = require.resolve("@github/copilot/package.json");
  } catch {
    return null;
  }
  const fromLauncher = createRequire(launcher);
  // npm installs only the platform package whose os, cpu and libc match.
  const platforms = process.platform === "linux" ? ["linuxmusl", "linux"] : [process.platform];
  for (const platform of platforms) {
    try {
      return fromLauncher.resolve(`@github/copilot-${platform}-${process.arch}`);
    } catch { /* not this platform */ }
  }
  return null;
}

/** The environment every Copilot child (SDK runtime or CLI) is given. */
export function copilotEnvironment(environment: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  return copilotChildEnvironment(environment);
}

export function createCopilotAccount(options: { environment?: NodeJS.ProcessEnv; cliPath?: string | null } = {}): EngineAccount {
  const cliPath = options.cliPath === undefined ? packagedCopilotCliPath() : options.cliPath;
  // The release guard reads this line to prove the installed CLI runs.
  if (cliPath) console.log(`[floe-bridge] copilot sign-in cli: ${cliPath}`);
  else console.warn("[floe-bridge] copilot sign-in cli: not found; @github/copilot for this platform is not installed");
  return new CopilotEngineAccountAdapter({
    environment: options.environment ?? process.env,
    ...(cliPath ? { cliPath } : {}),
  });
}
