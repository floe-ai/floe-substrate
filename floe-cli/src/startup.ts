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
 *
 * The Bus has one name: config.bus.http_base_url. "Already running" is never
 * decided by whether *something* answers /health on that URL — only by whether
 * the process answering is the exact bus this install started. A different
 * install (or a stale predecessor) answering on the same URL is a foreign bus:
 * we refuse to register or seed into it and fail loudly, because seeding into
 * someone else's live bus while reporting success is the defect this guards.
 */
import { randomUUID } from "node:crypto";
import type { LocalConfig } from "./config.js";
import { readRecords, isPidRunning, startService } from "./process-manager.js";
import { fetchHostControlToken, fetchBridgeServiceToken } from "./operation-client.js";

export class ForeignBusError extends Error {
  readonly code = "E_FOREIGN_BUS" as const;
  constructor(readonly url: string, detail: string) {
    super(
      `Something is already answering at ${url}, but it is not this install's Floe bus (${detail}). `
      + `Refusing to register or seed into it. If this is a stale Floe process, stop it and retry; `
      + `if another Floe install owns this URL, change bus.http_base_url in your config.`,
    );
    this.name = "ForeignBusError";
  }
}

type BusHealth = { ok: boolean; instance_id: string | null };

async function fetchBusHealth(baseUrl: string): Promise<BusHealth | null> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/health`);
    if (!response.ok) return null;
    const body = (await response.json()) as { ok?: boolean; instance_id?: string | null };
    return { ok: body.ok === true, instance_id: body.instance_id ?? null };
  } catch {
    return null;
  }
}

export async function isHealthy(baseUrl: string): Promise<boolean> {
  return (await fetchBusHealth(baseUrl)) !== null;
}

/**
 * Classify what, if anything, is answering on the Bus URL.
 * - "absent": nothing healthy is there; we may start our own bus.
 * - "mine": the process we recorded is running and its /health instance id
 *    matches the record — proven to be our bus.
 * - "foreign": something healthy is answering, but we cannot prove it is the
 *    process we started (different install, or a stale predecessor). Refuse.
 */
async function classifyRunningBus(
  configPath: string,
  config: LocalConfig,
): Promise<{ state: "absent" } | { state: "mine" } | { state: "foreign"; detail: string }> {
  const health = await fetchBusHealth(config.bus.http_base_url);
  if (!health) return { state: "absent" };
  const record = readRecords(configPath, config).bus;
  if (
    record
    && record.instance_id
    && isPidRunning(record.pid)
    && health.instance_id === record.instance_id
  ) {
    return { state: "mine" };
  }
  const detail = !record
    ? "no local record shows this install started it"
    : health.instance_id !== record.instance_id
      ? "its instance id does not match the bus this install started"
      : "the bus process this install started is no longer running";
  return { state: "foreign", detail };
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
  const busUrl = config.bus.http_base_url;
  const before = await classifyRunningBus(configPath, config);
  if (before.state === "foreign") throw new ForeignBusError(busUrl, before.detail);

  if (before.state === "absent") {
    // The Bus refuses to start without the host-control credential owned by the
    // native broker. Obtain it and hand it to the Bus via its environment only;
    // it is never logged or written to disk. Mint a fresh instance id so that,
    // once healthy, we can prove the process answering is the one we launched.
    const instanceId = randomUUID();
    const hostControlToken = await fetchHostControlToken(busUrl);
    await startService(configPath, config, "bus", { FLOE_HOST_CONTROL_TOKEN: hostControlToken }, instanceId);
    await waitForHealth(busUrl, "floe-bus");
    // Re-verify: the healthy bus must be the one we just started. If a foreign
    // process raced onto the URL, or ours died and a stale one answers, fail
    // loudly rather than seed into it.
    const after = await classifyRunningBus(configPath, config);
    if (after.state !== "mine") {
      throw new ForeignBusError(
        busUrl,
        after.state === "foreign" ? after.detail : "it stopped answering immediately after start",
      );
    }
  }

  // The Bridge authenticates to the Bus as a transport peer. Its ephemeral
  // service credential is minted by the Bus and obtained through the native
  // broker on the same trust path as the host-control token, then handed to the
  // Bridge process environment only — never set by the operator, never on disk.
  const bridgeServiceToken = await fetchBridgeServiceToken("bridge:local", busUrl);
  await startService(configPath, config, "bridge", { FLOE_BRIDGE_SERVICE_TOKEN: bridgeServiceToken });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
