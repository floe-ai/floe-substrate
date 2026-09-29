/**
 * Live-tier support: gives a fresh Floe Copilot folder this machine's existing
 * Copilot login, the way a person's own sign-in would, without signing in.
 *
 * Only the account pointer (which login, on which host) is copied. The token
 * itself stays in the OS credential store, where the official CLI put it.
 * A machine with no login fails loudly; FLOE_LIVE_RUNTIME_TIER=off is the one
 * deliberate, announced way to skip a real engine.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LIVE_ENGINE_DISABLED = process.env.FLOE_LIVE_RUNTIME_TIER === "off";

type Login = { host: string; login: string };

export function pointAtMachineLogin(folder: string): { label: string; host: string } {
  const machineHome = process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
  let login: Login | undefined;
  try {
    // The CLI writes comment lines at the top of its managed config.
    const text = readFileSync(join(machineHome, "config.json"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    login = (JSON.parse(text) as { lastLoggedInUser?: Login }).lastLoggedInUser;
  } catch { /* reported below */ }
  if (!login?.login || !login.host) {
    throw new Error(
      `This test runs a real Copilot turn, and this machine has no Copilot login in ${machineHome}. ` +
      "Sign in with the official Copilot CLI, or opt out deliberately with FLOE_LIVE_RUNTIME_TIER=off.",
    );
  }
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "config.json"), JSON.stringify({ loggedInUsers: [login], lastLoggedInUser: login }, null, 2));
  return { label: login.login, host: login.host };
}
