/**
 * Is the process a service record names still the service Floe started?
 *
 * A pid is not an identity: after a reboot Windows may hand a recorded pid to
 * an unrelated program. So a record is trusted only on proof, strongest first:
 * - the service answers as itself: the Bus echoes the instance id it was
 *   started with, and the Bridge and identity agent answer their channel
 *   (proving the run-file secret) from the recorded pid;
 * - otherwise the operating system confirms the recorded pid is the same
 *   process: it started no later than the record, with the recorded command.
 * Anything else is "not_ours": treated as not running, and never stopped.
 */
import type { LocalConfig } from "./config.js";
import { resolveLocalPath } from "./config.js";
import { fetchBusHealth } from "./bus-health.js";
import { probeAgent } from "./identity/connection.js";
import { readRunFile } from "./identity/protocol.js";
import { probeChannel } from "./local-channel/connection.js";
import { canonicalHome, readChannelRunFile } from "./local-channel/protocol.js";
import { ENGINES_CHANNEL } from "./engines/protocol.js";
import { describeProcess, isPidRunning } from "./process-identity.js";

export type RecordedService = {
  pid: number;
  started_at: string;
  command: string;
  args: string[];
  instance_id?: string;
};

/**
 * - "answering": the service answered as itself from the recorded process.
 * - "silent": the recorded process is provably the one Floe started, but it is not answering.
 * - "not_ours": nothing proves the recorded pid is still Floe's service.
 */
export type ServiceOwnership = "answering" | "silent" | "not_ours";

/** How far the operating system's start time may trail the recorded one (clock granularity). */
const START_TOLERANCE_MS = 2_000;

export async function recordedServiceOwnership(
  configPath: string,
  config: LocalConfig,
  service: "bus" | "bridge" | "identity",
  record: RecordedService,
): Promise<ServiceOwnership> {
  if (!record.pid || !isPidRunning(record.pid)) return "not_ours";
  if (await answersAsItself(configPath, config, service, record)) return "answering";
  return operatingSystemConfirms(record) ? "silent" : "not_ours";
}

async function answersAsItself(
  configPath: string,
  config: LocalConfig,
  service: "bus" | "bridge" | "identity",
  record: RecordedService,
): Promise<boolean> {
  if (service === "bus") {
    const health = await fetchBusHealth(config.bus.http_base_url);
    return Boolean(record.instance_id && health?.instance_id === record.instance_id);
  }
  const home = canonicalHome(resolveLocalPath(configPath, config.home, "."));
  if (service === "bridge") {
    return readChannelRunFile(ENGINES_CHANNEL, home)?.pid === record.pid && (await probeChannel(ENGINES_CHANNEL, home)) !== null;
  }
  return readRunFile(home)?.pid === record.pid && (await probeAgent(home)) !== null;
}

/** The recorded pid started no later than the record says, running the recorded command. */
export function operatingSystemConfirms(record: RecordedService): boolean {
  const recordedStart = Date.parse(record.started_at);
  if (Number.isNaN(recordedStart)) return false;
  const actual = describeProcess(record.pid);
  if (!actual?.started_at) return false;
  if (actual.started_at.getTime() > recordedStart + START_TOLERANCE_MS) return false;
  return [record.command, ...record.args].every((part) => actual.command_line.includes(part));
}
