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
import { existsSync, readFileSync } from "node:fs";
import type { LocalConfig } from "./config.js";
import { readRecords, isPidRunning, startService, serviceLogPath } from "./process-manager.js";
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

/**
 * Wait for the Bus to become healthy, but stay honest about failure. A silent
 * "did not become healthy" with an empty log is exactly the false-signal this
 * project keeps hitting, so this checks two things each loop: is the Bus
 * answering /health, and is the process we started still alive? If the process
 * has exited, we stop waiting immediately and raise with the tail of its log,
 * so the person is told what actually happened instead of watching a spawned-
 * but-dead process time out. This is startup synchronisation against a real
 * readiness signal (/health), not architectural polling of ongoing state.
 */
export async function waitForBusHealth(configPath: string, config: LocalConfig): Promise<void> {
  const baseUrl = config.bus.http_base_url;
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (await isHealthy(baseUrl)) return;
    const record = readRecords(configPath, config).bus;
    if (record && record.pid && !isPidRunning(record.pid)) {
      const logPath = record.log_file ?? serviceLogPath(configPath, config, "bus");
      throw new Error(
        `floe-bus started but exited before becoming healthy (pid ${record.pid}). `
        + `Last lines of ${logPath}:\n${readLogTail(logPath)}`,
      );
    }
    await sleep(500);
  }
  const record = readRecords(configPath, config).bus;
  const logPath = record?.log_file ?? serviceLogPath(configPath, config, "bus");
  const running = record ? isPidRunning(record.pid) : false;
  throw new Error(
    `floe-bus did not become healthy at ${baseUrl} within 30s `
    + `(process ${running ? "is still running but not answering" : "is not running"}). `
    + `Last lines of ${logPath}:\n${readLogTail(logPath)}`,
  );
}

function readLogTail(path: string, lines = 25): string {
  try {
    if (!existsSync(path)) return "(no log output was written)";
    const text = readFileSync(path, "utf8").trimEnd();
    if (!text) return "(log file is empty)";
    return text.split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "(log file could not be read)";
  }
}

/**
 * What a client should do about the substrate before using it. A surface (and
 * the launcher) depends on a reachable bus endpoint, not on a process being
 * spawned for it, so the first question is always "is it already serving?".
 *
 * - "connect": something is already serving on the bus URL; use it, spawn
 *    nothing. This is the normal case once Floe has been started once.
 * - "start":  nothing is serving and this machine's policy allows a client to
 *    start the substrate itself (a personal machine).
 * - "blocked": nothing is serving and policy forbids self-start. Floe here is a
 *    managed service; a client must not start a rogue copy and should say so.
 */
export type SubstratePlan = "connect" | "start" | "blocked";

export function planSubstrateStart(reachable: boolean, startOnDemand: boolean): SubstratePlan {
  if (reachable) return "connect";
  return startOnDemand ? "start" : "blocked";
}

/**
 * Connect-first: if the bus is already serving, do nothing and report
 * "connect". Otherwise consult the machine's start_on_demand policy — start the
 * substrate ("start") or refuse and report "blocked". This is the single
 * client-side readiness path shared by the launcher, `floe up`, and
 * `floe <surface>`.
 */
export async function ensureSubstrateForClient(configPath: string, config: LocalConfig): Promise<SubstratePlan> {
  const reachable = await isHealthy(config.bus.http_base_url);
  const plan = planSubstrateStart(reachable, config.services.start_on_demand);
  if (plan === "start") await startAll(configPath, config);
  return plan;
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
    await waitForBusHealth(configPath, config);
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
