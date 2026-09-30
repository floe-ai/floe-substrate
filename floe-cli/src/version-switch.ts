/**
 * version-switch — a surface asks Floe to run the newest installed version,
 * without the person typing `floe restart`.
 *
 * The Floe that is running cannot do this itself: it is the older code, and it
 * runs from its own stage. The switch is performed by the copy the surface
 * ships, which is the newer code, using exactly the path `floe restart` uses
 * (restartAll: one start under the start lock, the same foreign-Bus check).
 *
 * Rules:
 * - Only a newer copy may switch: never a downgrade, never a same-version
 *   restart dressed up as an upgrade.
 * - Only this install's Floe is restarted; a foreign Bus is refused.
 * - A turn in progress is never interrupted silently. Without
 *   `interrupt_running_work`, the switch is declined and the running turns are
 *   named. With it, the interrupted turns are named in the result. The check is
 *   made under the start lock, immediately before anything stops. Queued and
 *   waiting work is durable and carries over.
 */
import { ensureConfig, type LocalConfig } from "./config.js";
import { thisInstallation } from "./installation.js";
import { fetchHostControlToken } from "./operation-client.js";
import { classifyRunningBus, compareVersions, fetchBusHealth, restartAll } from "./startup.js";

export type RunningTurn = { workspace_id: string; endpoint_id: string; name: string | null };

export type VersionSwitchOutcome =
  | { kind: "switched"; from: string | null; to: string; interrupted: RunningTurn[] }
  | { kind: "already_serving"; version: string }
  | { kind: "work_running"; running: RunningTurn[]; message: string }
  | { kind: "refused"; reason: "not_running" | "would_downgrade" | "not_this_floe" | "unknown_version"; message: string };

export type VersionSwitchOptions = {
  /** Defaults to ~/.floe/config.yaml. */
  configPath?: string;
  /** Switch even though turns are in progress. They are named in the result. */
  interrupt_running_work?: boolean;
};

export type VersionSwitchDependencies = {
  ownVersion(): string | null;
  servingVersion(config: LocalConfig): Promise<{ running: boolean; version: string | null }>;
  isThisFloe(configPath: string, config: LocalConfig): Promise<boolean>;
  runningTurns(config: LocalConfig): Promise<RunningTurn[]>;
  restart(configPath: string, config: LocalConfig, beforeStop: () => Promise<boolean>): Promise<boolean>;
};

export const defaultVersionSwitchDependencies: VersionSwitchDependencies = {
  ownVersion: () => thisInstallation().version,
  servingVersion: async (config) => {
    const health = await fetchBusHealth(config.bus.http_base_url);
    return { running: health !== null, version: health?.version ?? null };
  },
  isThisFloe: async (configPath, config) => (await classifyRunningBus(configPath, config)).state === "mine",
  runningTurns: listRunningTurns,
  restart: restartAll,
};

export async function switchToThisVersion(
  options: VersionSwitchOptions = {},
  deps: VersionSwitchDependencies = defaultVersionSwitchDependencies,
): Promise<VersionSwitchOutcome> {
  const { configPath, config } = ensureConfig(options.configPath);
  const own = deps.ownVersion();
  if (!own) {
    return { kind: "refused", reason: "unknown_version", message: "This copy of Floe does not know its own version, so it cannot tell whether it is newer." };
  }
  const serving = await deps.servingVersion(config);
  if (!serving.running) {
    return { kind: "refused", reason: "not_running", message: "Floe is not running, so there is nothing to switch. Starting Floe runs this version." };
  }
  if (serving.version) {
    const order = compareVersions(own, serving.version);
    if (order === 0) return { kind: "already_serving", version: own };
    if (order < 0) {
      return {
        kind: "refused",
        reason: "would_downgrade",
        message: `Floe ${serving.version} is running, which is newer than this copy (Floe ${own}). Switching would go back a version, so it was not done.`,
      };
    }
  }
  if (!(await deps.isThisFloe(configPath, config))) {
    return {
      kind: "refused",
      reason: "not_this_floe",
      message: `The Floe answering at ${config.bus.http_base_url} was not started from this Floe home, so it is left alone.`,
    };
  }

  let running: RunningTurn[] = [];
  const restarted = await deps.restart(configPath, config, async () => {
    running = await deps.runningTurns(config);
    return running.length === 0 || options.interrupt_running_work === true;
  });
  if (!restarted) {
    return {
      kind: "work_running",
      running,
      message: `${running.length === 1 ? "A turn is" : `${running.length} turns are`} in progress, so Floe was not switched. `
        + "Try again when the work is done, or switch anyway and interrupt it.",
    };
  }
  const after = await deps.servingVersion(config);
  return { kind: "switched", from: serving.version, to: after.version ?? own, interrupted: running };
}

/** The Actors mid-turn right now, in every workspace: what a switch would interrupt. */
export function runningTurns(options: { configPath?: string } = {}): Promise<RunningTurn[]> {
  return listRunningTurns(ensureConfig(options.configPath).config);
}

/**
 * Turns actually executing across every workspace, read as the host through the
 * native broker. Work that is queued, delivered, or waiting on an answer
 * executes nothing, so it is not listed.
 */
async function listRunningTurns(config: LocalConfig): Promise<RunningTurn[]> {
  const base = config.bus.http_base_url.replace(/\/$/, "");
  const token = await fetchHostControlToken(base);
  const response = await fetch(`${base}/v1/local/running-turns`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Floe could not list the work in progress (HTTP ${response.status}), so it was not switched.`);
  const body = (await response.json()) as { running?: RunningTurn[] };
  return body.running ?? [];
}
