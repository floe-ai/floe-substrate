/**
 * Entry point of the identity agent process, started by `floe start` as
 * Floe's fourth service: `node agent-main.js daemon --config <path>`.
 */
import { DEFAULT_IDENTITY_LOCK_AFTER_IDLE_MINUTES, ensureConfig, resolveLocalPath } from "../config.js";
import { thisInstallation } from "../installation.js";
import { fetchHostControlToken, fetchIdentityDeviceKey, forgetIdentityDeviceKey } from "../operation-client.js";
import { IdentityAgent } from "./agent.js";
import { AgentAddressInUseError, serveAgent } from "./agent-server.js";
import { canonicalHome } from "./protocol.js";

function log(line: string): void {
  process.stdout.write(`${new Date().toISOString()} identity-agent: ${line}\n`);
}

async function main(argv: string[]): Promise<void> {
  if (argv[0] !== "daemon") {
    process.stderr.write("usage: agent-main daemon --config <path>\n");
    process.exit(2);
  }
  const configIndex = argv.indexOf("--config");
  const { configPath, config } = ensureConfig(configIndex >= 0 ? argv[configIndex + 1] : undefined);
  const home = canonicalHome(resolveLocalPath(configPath, config.home, "."));
  const busUrl = config.bus.http_base_url;
  const minutes = config.identity?.lock_after_idle_minutes ?? DEFAULT_IDENTITY_LOCK_AFTER_IDLE_MINUTES;

  const agent = new IdentityAgent({
    home,
    busUrl,
    version: thisInstallation().version,
    lockAfterIdleMs: minutes * 60_000,
    deviceKey: (create) => fetchIdentityDeviceKey(home, create),
    forgetDeviceKey: () => forgetIdentityDeviceKey(home),
    hostToken: () => fetchHostControlToken(busUrl),
    log,
  });

  let server;
  try {
    server = await serveAgent(agent, { home, log });
  } catch (error) {
    if (error instanceof AgentAddressInUseError) {
      log(error.message);
      process.exit(3);
    }
    throw error;
  }
  log(`serving ${home} for the bus at ${busUrl} (locks after ${minutes} idle minute(s))`);

  const shutdown = async (signal: string) => {
    log(`stopping (${signal})`);
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main(process.argv.slice(2)).catch((error) => {
  log(`failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
