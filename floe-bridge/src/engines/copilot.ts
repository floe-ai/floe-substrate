/**
 * The Copilot engine as the Bridge runs it: the SDK for turns and readiness,
 * and the official Copilot CLI (a pinned dependency, never a global install)
 * for the vendor's own sign-in.
 *
 * Neither ever sees a credential from Floe's environment: GitHub gives
 * COPILOT_GITHUB_TOKEN, GH_TOKEN and GITHUB_TOKEN precedence over the signed-in
 * account, so they are removed from every child's environment.
 *
 * All three (turns, the readiness check and sign-in) share one Floe-owned
 * Copilot folder, so the account a turn runs as is the account readiness
 * reported and sign-in recorded. This module is the only place a real Copilot
 * runtime is constructed; copilot-construction.test.ts enforces that.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  CopilotEngineAccountAdapter,
  CopilotRuntime,
  copilotChildEnvironment,
  type CopilotRuntimeOptions,
} from "floe-runtime/adapters/copilot";
import { resolveLocalPath, type LocalConfig } from "../config.js";
import type { EngineModel } from "floe-cli/engines/protocol";
import type { EngineAccount } from "./engine-control.js";

/**
 * Floe's own Copilot folder: the signed-in account pointer, the engine's
 * configuration and its session state. It lives with the Bridge's data and
 * is never the user's personal ~/.copilot.
 */
export function copilotHome(configPath: string, config: LocalConfig): string {
  return join(resolveLocalPath(configPath, config.home, config.bridge.data_dir), "copilot");
}

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
  // npm may install both Linux builds, so ask the launcher's own libc check.
  const platforms = process.platform !== "linux" ? [process.platform]
    : (fromLauncher("detect-libc") as { isNonGlibcLinuxSync(): boolean }).isNonGlibcLinuxSync() ? ["linuxmusl", "linux"] : ["linux"];
  for (const platform of platforms) {
    try {
      return fromLauncher.resolve(`@github/copilot-${platform}-${process.arch}`);
    } catch { /* not this platform */ }
  }
  return null;
}

/** The environment every Copilot child (SDK runtime or CLI) is given: no credentials, and Floe's folder as its home. */
export function copilotEnvironment(home: string, environment: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  return copilotChildEnvironment({ ...environment, COPILOT_HOME: home });
}

function ownedFolder(home: string): string {
  mkdirSync(home, { recursive: true });
  return home;
}

/** The one production construction of the runtime a real turn runs on. */
export function createCopilotRuntime(
  home: string,
  options: Pick<CopilotRuntimeOptions, "permissionPolicy" | "beforeToolUse" | "expectedAccount">,
): CopilotRuntime {
  const folder = ownedFolder(home);
  return new CopilotRuntime({
    ...options,
    clientOptions: { env: copilotEnvironment(folder), baseDirectory: folder },
  });
}

export function createCopilotAccount(home: string, options: { cliPath?: string | null } = {}): EngineAccount {
  const folder = ownedFolder(home);
  const cliPath = options.cliPath === undefined ? packagedCopilotCliPath() : options.cliPath;
  // The release guard reads this line to prove the installed CLI runs.
  if (cliPath) console.log(`[floe-bridge] copilot sign-in cli: ${cliPath}`);
  else console.warn("[floe-bridge] copilot sign-in cli: not found; @github/copilot for this platform is not installed");
  const account: EngineAccount = new CopilotEngineAccountAdapter({
    environment: { ...process.env, COPILOT_HOME: folder },
    clientOptions: { baseDirectory: folder },
    ...(cliPath ? { cliPath } : {}),
  });
  account.models = async () => {
    const signedIn = account.currentState().account;
    if (!signedIn) {
      throw Object.assign(new Error("Copilot is not signed in, so it cannot list its models. Sign in first."), { code: "copilot_models_unavailable" });
    }
    return listCopilotModels(folder, signedIn);
  };
  return account;
}

/**
 * The engine's own model list, read through the same runtime, Copilot folder
 * and readiness account a turn uses, so it is the list a turn's model is
 * checked against.
 */
async function listCopilotModels(home: string, signedIn: { label: string; host?: string }): Promise<EngineModel[]> {
  const runtime = createCopilotRuntime(home, { expectedAccount: signedIn });
  try {
    return (await runtime.models()).map(copilotModel);
  } finally {
    await runtime.close().catch(() => {});
  }
}

export function copilotModel(model: Record<string, unknown>): EngineModel {
  const id = String(model.modelId ?? model.id);
  const capabilities = (model.capabilities ?? {}) as { supports?: { vision?: unknown }; limits?: { max_context_window_tokens?: unknown } };
  const policy = (model.policy ?? {}) as { state?: unknown };
  const billing = (model.billing ?? {}) as { multiplier?: unknown };
  const efforts = model.supportedReasoningEfforts;
  return {
    id,
    name: typeof model.name === "string" && model.name ? model.name : id,
    enabled: policy.state === "enabled" ? true : policy.state === "disabled" ? false : null,
    ...(typeof billing.multiplier === "number" ? { cost_multiplier: billing.multiplier } : {}),
    ...(typeof capabilities.limits?.max_context_window_tokens === "number"
      ? { context_window_tokens: capabilities.limits.max_context_window_tokens } : {}),
    ...(typeof capabilities.supports?.vision === "boolean" ? { vision: capabilities.supports.vision } : {}),
    ...(Array.isArray(efforts) ? { reasoning_efforts: efforts.filter((e): e is string => typeof e === "string") } : {}),
    ...(typeof model.defaultReasoningEffort === "string" ? { default_reasoning_effort: model.defaultReasoningEffort } : {}),
  };
}
