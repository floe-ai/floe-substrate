/**
 * startup — the single reusable Floe start sequence.
 *
 * This is the exact path `floe start` runs: obtain the Bus host-control
 * credential from the native broker, start the Bus with it, wait for health,
 * then mint the Bridge service credential on the same broker trust path and
 * start the Bridge with it. It is extracted here (rather than living privately
 * in the CLI entrypoint) so anything that must bring up a real Floe instance —
 * including the vertical-slice test harness — reuses the product path instead
 * of hand-assembling a divergent one.
 */
import type { LocalConfig } from "./config.js";
import { startService } from "./process-manager.js";
import { fetchHostControlToken, fetchBridgeServiceToken } from "./operation-client.js";

export async function isHealthy(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForHealth(baseUrl: string, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (await isHealthy(baseUrl)) return;
    await sleep(500);
  }
  throw new Error(`${label} did not become healthy at ${baseUrl}`);
}

export async function startAll(configPath: string, config: LocalConfig): Promise<void> {
  if (!(await isHealthy(config.bus.http_base_url))) {
    // The Bus refuses to start without the host-control credential owned by the
    // native broker. Obtain it and hand it to the Bus via its environment only;
    // it is never logged or written to disk.
    const hostControlToken = await fetchHostControlToken();
    await startService(configPath, config, "bus", { FLOE_HOST_CONTROL_TOKEN: hostControlToken });
  }
  await waitForHealth(config.bus.http_base_url, "floe-bus");
  // The Bridge authenticates to the Bus as a transport peer. Its ephemeral
  // service credential is minted by the Bus and obtained through the native
  // broker on the same trust path as the host-control token, then handed to the
  // Bridge process environment only — never set by the operator, never on disk.
  const bridgeServiceToken = await fetchBridgeServiceToken();
  await startService(configPath, config, "bridge", { FLOE_BRIDGE_SERVICE_TOKEN: bridgeServiceToken });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
