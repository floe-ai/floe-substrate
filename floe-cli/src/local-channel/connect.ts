/**
 * How a surface library reaches a Floe local channel: connect first, and start
 * Floe only when nothing answers and this machine allows a surface to start it.
 * A running service is used as it is, whatever its version, and never
 * restarted; versionNote says so plainly when versions differ.
 */
import { ensureConfig } from "../config.js";
import { thisInstallation } from "../installation.js";
import { ensureSubstrateForClient, floeHome } from "../startup.js";
import { ChannelUnavailableError, openChannel, type Channel } from "./connection.js";
import type { ChannelSpec } from "./protocol.js";

export type ChannelConnectOptions = {
  /** Shown to the person, so they can tell surfaces apart. */
  surface: string;
  /** Defaults to ~/.floe/config.yaml. */
  configPath?: string;
  /**
   * Start Floe when the service is not answering, if the machine's
   * services.start_on_demand allows it. Default true.
   */
  start?: boolean;
};

export async function connectChannel(spec: ChannelSpec, options: ChannelConnectOptions): Promise<Channel> {
  const { configPath, config } = ensureConfig(options.configPath);
  const home = floeHome(configPath, config);
  try {
    return withConfig(await openChannel(spec, home, options.surface), options.configPath);
  } catch (error) {
    if (!(error instanceof ChannelUnavailableError) || error.reason !== "not_running" || options.start === false) throw error;
  }
  const plan = await ensureSubstrateForClient(configPath, config);
  if (plan === "blocked") {
    throw new ChannelUnavailableError(
      "not_running",
      `${spec.label} is not running, and this machine does not let a surface start Floe `
        + "(services.start_on_demand is false). Start Floe with `floe start`.",
    );
  }
  return withConfig(await openChannel(spec, home, options.surface), options.configPath);
}

function withConfig(channel: Channel, configPath: string | undefined): Channel {
  if (configPath) channel.configPath = configPath;
  return channel;
}

/** Set when the serving process is a different Floe version from this copy. */
export function versionNote(spec: ChannelSpec, servingVersion: string | null): string | null {
  const own = thisInstallation().version;
  if (!own || servingVersion === own) return null;
  return `Connected to ${spec.label} from ${servingVersion ? `Floe ${servingVersion}` : "an older Floe"}, but this surface ships Floe ${own}. `
    + "It was already running, so it is left as is and keeps serving until Floe restarts.";
}
