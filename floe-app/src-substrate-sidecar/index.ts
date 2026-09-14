#!/usr/bin/env bun
/**
 * Packaged local substrate for the desktop app.
 *
 * The installed application starts this companion only when the bus is not
 * already listening. It deliberately reuses the real bus and bridge rather
 * than introducing a desktop-only runtime path.
 */
import { createBusServer } from "../../floe-bus/src/server.ts";
import { applyLocalFloeDelegationPolicy, applyLocalFloeExportPolicy, applyLocalFloeApprovalResponsePolicy, localProductWorkspacePolicy } from "../../floe-bus/src/local-product-policy.ts";
import { ensureConfig as ensureBusConfig } from "../../floe-bus/src/config.ts";
import { BridgeDaemon } from "../../floe-bridge/src/daemon.ts";
import { ensureConfig as ensureBridgeConfig } from "../../floe-bridge/src/config.ts";

export async function runSubstrate(): Promise<void> {
  // The desktop owns the readers of these pipes, not the service lifetime.
  // Node's console can emit EPIPE on a later write after the desktop exits.
  // Ignore only that disconnected diagnostic sink; other I/O failures remain fatal.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error;
    });
  }
  const hostControlToken = process.env.FLOE_HOST_CONTROL_TOKEN;
  delete process.env.FLOE_HOST_CONTROL_TOKEN;
  if (!hostControlToken || hostControlToken.length < 32) {
    throw new Error("The desktop host credential was not supplied. Refusing to start an unauthenticated substrate.");
  }
  const configuredPath = process.env.FLOE_CONFIG;
  const { configPath, config: busConfig } = ensureBusConfig(configuredPath);
  const bus = await createBusServer(configPath, busConfig, { host_control_token: hostControlToken, local_browser_access: true, workspace_configuration_policy: localProductWorkspacePolicy });
  applyLocalFloeDelegationPolicy(bus.store);
  applyLocalFloeExportPolicy(bus.store);
  applyLocalFloeApprovalResponsePolicy(bus.store);
  await bus.listen();

  const { config: bridgeConfig } = ensureBridgeConfig(configPath);
  const bridgeId = process.env.FLOE_BRIDGE_ID?.trim() || "bridge:local";
  let bridgeServiceToken = bus.replaceBridgeServiceCredential(bridgeId).bearer_token;
  const bridge = new BridgeDaemon(configPath, bridgeConfig, {
    bridge_id: bridgeId,
    transport_authority: {
      audience: "bridge_service",
      bearer_token: bridgeServiceToken,
    },
  });
  // The Bridge owns the only remaining process-local reference. Never place
  // this credential in argv, stdout, config, or the WebView.
  bridgeServiceToken = "";
  await bridge.start();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await bridge.stop();
    await bus.app.close();
  };

  process.on("SIGINT", () => void stop().finally(() => process.exit(0)));
  process.on("SIGTERM", () => void stop().finally(() => process.exit(0)));
}
