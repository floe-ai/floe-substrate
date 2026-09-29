#!/usr/bin/env node
import { canonicalHome, serveChannel } from "floe-cli/local-channel";
import { ENGINES_CHANNEL } from "floe-cli/engines/protocol";
import { ensureConfig, resolveLocalPath } from "./config.js";
import { BridgeDaemon } from "./daemon.js";

function getArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const match = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "daemon";
  if (command !== "daemon") {
    console.error(`Unknown floe-bridge command: ${command}`);
    process.exit(1);
  }
  const { configPath, config } = ensureConfig(getArgValue("--config"));
  const daemon = new BridgeDaemon(configPath, config);
  // Surfaces reach engine readiness and sign-in here, even before the Bus is up.
  const engineChannel = await serveChannel(ENGINES_CHANNEL, daemon.engines, {
    home: canonicalHome(resolveLocalPath(configPath, config.home, ".")),
    log: (line) => console.log(`[floe-bridge] engine control ${line}`),
  });
  daemon.engines.start();
  const stop = () => void daemon.stop().finally(() => engineChannel.close()).finally(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await daemon.start();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
