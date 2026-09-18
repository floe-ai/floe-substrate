/**
 * Runtime-neutral pulse tools (create/list/pause/resume/cancel_pulse).
 *
 * Pulses are scheduled Events (one-off or cron) that fire canonical
 * `pulse.fired` Events to their subscribers. These functions are the pure
 * (bus, turn, params) → result bodies direct SDK tools expose to the vendor CLI;
 * they carry no transport types. Pulse authority is the authenticated Bridge
 * BusClient's own credential, not an operation-authority bearer: the pulse
 * routes (`/v1/pulses`) are not operation-gated.
 */
import type { BusClient } from "../bus-client.js";
import type { SubstrateToolResult } from "./substrate-capability-tools.js";

/** The subset of the active turn pulse creation reads. */
export type PulseTurn = {
  workspace_id: string;
  context_id: string | null;
  /** Filesystem locator for workspace-persisted state (floe.yaml), or null. */
  workspace_locator: string | null;
};

type PulsePersistence = "workspace" | "local";

type PulseTrigger = { type: string; at?: string; schedule?: string; timezone?: string };

type PulseSubscriber =
  | { kind: "context"; context_id: string }
  | { kind: "endpoint"; endpoint_ref: string; context_id?: string };

const ISO_DURATION_RE = /^p(?:t)?(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/i;
const NATURAL_RELATIVE_RE = /^(?:in\s+)?(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)(?:\s*(?:from\s+now|later))?$/i;

function failure(message: string, error: string, details: Record<string, unknown> = {}): SubstrateToolResult {
  return { content: [{ type: "text", text: message }], details: { ok: false, error, ...details } };
}

function finiteRelativeSeconds(seconds: number): number | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const maxRelativeSeconds = (8.64e15 - Date.now()) / 1000;
  return seconds <= maxRelativeSeconds ? seconds : null;
}

function isRelativeExpression(input: string): boolean {
  const value = input.trim().toLowerCase();
  return ISO_DURATION_RE.test(value) || NATURAL_RELATIVE_RE.test(value);
}

function relativeSeconds(input: unknown): number | null {
  if (typeof input === "number") return finiteRelativeSeconds(input);
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase();
  if (!value) return null;
  const isoDuration = value.match(ISO_DURATION_RE);
  if (isoDuration && (isoDuration[1] || isoDuration[2] || isoDuration[3])) {
    const hours = Number(isoDuration[1] ?? 0);
    const minutes = Number(isoDuration[2] ?? 0);
    const seconds = Number(isoDuration[3] ?? 0);
    return finiteRelativeSeconds(hours * 3600 + minutes * 60 + seconds);
  }
  const natural = value.match(NATURAL_RELATIVE_RE);
  if (!natural) return null;
  const amount = Number(natural[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = natural[2]!;
  if (["s", "sec", "secs", "second", "seconds"].includes(unit)) return finiteRelativeSeconds(amount);
  if (["m", "min", "mins", "minute", "minutes"].includes(unit)) return finiteRelativeSeconds(amount * 60);
  return finiteRelativeSeconds(amount * 3600);
}

function isoFromNow(seconds: number): string {
  return new Date(Date.now() + Math.round(seconds * 1000)).toISOString();
}

function normalizeOnceAt(raw: Record<string, unknown>): string | undefined {
  const at = typeof raw.at === "string" ? raw.at.trim() : "";
  if (at) {
    const seconds = relativeSeconds(at);
    if (seconds !== null) return isoFromNow(seconds);
    return isRelativeExpression(at) ? undefined : at;
  }
  for (const field of ["after_seconds", "delay_seconds", "in_seconds", "seconds_from_now", "after"]) {
    const seconds = relativeSeconds(raw[field]);
    if (seconds !== null) return isoFromNow(seconds);
  }
  return undefined;
}

function normalizePulseTrigger(input: unknown): PulseTrigger | { error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "trigger must be an object with type 'once' or 'cron'." };
  }
  const raw = input as Record<string, unknown>;
  const rawType = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : "";
  const schedule = typeof raw.schedule === "string" ? raw.schedule : undefined;
  const timezone = typeof raw.timezone === "string" ? raw.timezone : undefined;
  if (rawType === "cron") {
    if (!schedule) return { error: "cron pulses require trigger.schedule." };
    return { type: "cron", schedule, timezone };
  }
  const onceAliases = new Set(["once", "one-off", "one_off", "oneoff", "at", "at_time", "at_time_utc", "datetime", "time"]);
  if (rawType === "" || onceAliases.has(rawType)) {
    const at = normalizeOnceAt(raw);
    if (!at) return { error: "one-off pulses require trigger.at or trigger.after_seconds." };
    return { type: "once", at, timezone };
  }
  return { error: `Unsupported trigger.type '${rawType}'. Use 'once' with trigger.at or 'cron' with trigger.schedule.` };
}

function normalizePulseSubscribers(input: unknown): PulseSubscriber[] | { error: string } {
  if (!Array.isArray(input)) return [];
  const subscribers: PulseSubscriber[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { error: "subscribers must contain objects." };
    const raw = item as Record<string, unknown>;
    const kind = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : "";
    if (kind === "context") {
      if (typeof raw.context_id !== "string" || !raw.context_id.trim()) return { error: "context subscribers require context_id." };
      subscribers.push({ kind: "context", context_id: raw.context_id });
      continue;
    }
    if (kind === "" || kind === "endpoint") {
      if (typeof raw.endpoint_ref !== "string" || !raw.endpoint_ref.trim()) return { error: "endpoint subscribers require endpoint_ref." };
      subscribers.push({
        kind: "endpoint",
        endpoint_ref: raw.endpoint_ref,
        context_id: typeof raw.context_id === "string" ? raw.context_id : undefined,
      });
      continue;
    }
    return { error: `Unsupported subscriber.kind '${kind}'. Use 'context' or 'endpoint'.` };
  }
  return subscribers;
}

function resolvedScopeIdFromCreatePulseResult(result: unknown): string | undefined {
  const candidate = result && typeof result === "object" && "pulse" in result
    ? (result as { pulse?: unknown }).pulse
    : result;
  if (!candidate || typeof candidate !== "object") return undefined;
  const scopeId = (candidate as { scope_id?: unknown }).scope_id;
  return typeof scopeId === "string" && scopeId ? scopeId : undefined;
}

/**
 * Persist a workspace-backed pulse into `.floe/floe.yaml` so it survives as
 * committed project configuration. Loaded lazily: `yaml` and node:fs are only
 * needed on the workspace-persistence path.
 */
async function writePulseToFloeYaml(
  workspaceLocator: string,
  pulseDef: { pulse_id: string; persistence: PulsePersistence; scope_id?: string; trigger: PulseTrigger; event: { type: "pulse.fired"; content: Record<string, unknown> }; subscribers: PulseSubscriber[] },
): Promise<void> {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const YAML = (await import("yaml")).default;
  const yamlPath = join(workspaceLocator, ".floe", "floe.yaml");
  const doc = YAML.parseDocument(readFileSync(yamlPath, "utf8"));
  if (!doc.get("pulses")) doc.set("pulses", doc.createNode([]));
  const entry: Record<string, unknown> = {
    id: pulseDef.pulse_id,
    persistence: pulseDef.persistence,
    trigger: pulseDef.trigger,
    event: pulseDef.event,
  };
  if (pulseDef.scope_id) entry.scope_id = pulseDef.scope_id;
  if (pulseDef.subscribers.length > 0) entry.subscribers = pulseDef.subscribers;
  (doc.get("pulses") as { add: (n: unknown) => void }).add(doc.createNode(entry));
  writeFileSync(yamlPath, doc.toString(), "utf8");
}

/**
 * Create a scheduled pulse (one-off or cron) that fires canonical `pulse.fired`
 * Events for its subscribers. Workspace persistence writes the pulse into the
 * committed `.floe/floe.yaml`; local persistence keeps it runtime-backed.
 */
export async function executeCreatePulse(bus: BusClient, turn: PulseTurn, params: any): Promise<SubstrateToolResult> {
  if (params?.persistence !== undefined && params.persistence !== "workspace" && params.persistence !== "local") {
    return failure("Cannot create pulse: use persistence 'workspace' or 'local'.", "invalid_persistence");
  }
  const persistence: PulsePersistence = params?.persistence === "workspace" ? "workspace" : "local";
  const scopeId = typeof params?.scope_id === "string" && params.scope_id.trim() ? params.scope_id : undefined;
  const pulseId = typeof params?.pulse_id === "string" ? params.pulse_id.trim() : "";
  if (!pulseId) return failure("Cannot create pulse: a unique pulse_id is required.", "invalid_pulse_id");

  const trigger = normalizePulseTrigger(params?.trigger);
  if ("error" in trigger) return failure(`Cannot create pulse: ${trigger.error}`, "invalid_trigger", { message: trigger.error });
  const subscribers = normalizePulseSubscribers(params?.subscribers);
  if ("error" in subscribers) return failure(`Cannot create pulse: ${subscribers.error}`, "invalid_subscribers", { message: subscribers.error });

  const eventContent =
    params?.event && typeof params.event === "object" && params.event.content && typeof params.event.content === "object"
      ? params.event.content
      : params?.content && typeof params.content === "object"
      ? params.content
      : {};

  try {
    const result = await bus.createPulse({
      pulse_id: pulseId,
      workspace_id: turn.workspace_id,
      persistence,
      scope_id: scopeId,
      current_context_id: turn.context_id ?? undefined,
      trigger,
      event: { type: "pulse.fired", content: eventContent },
      content: eventContent,
      subscribers,
      created_by: "actor",
    });
    const resolvedScopeId = scopeId ?? resolvedScopeIdFromCreatePulseResult(result);
    if (persistence === "workspace" && turn.workspace_locator) {
      try {
        await writePulseToFloeYaml(turn.workspace_locator, {
          pulse_id: pulseId, persistence, scope_id: resolvedScopeId, trigger,
          event: { type: "pulse.fired", content: eventContent }, subscribers,
        });
      } catch (err) {
        console.error("[bridge] pulse write-back to floe.yaml failed", { pulse_id: pulseId, error: err });
      }
    }
    return {
      content: [{
        type: "text",
        text: `Pulse '${pulseId}' created (persistence: ${persistence}${resolvedScopeId ? `, scope_id: ${resolvedScopeId}` : ""}).\n${JSON.stringify(result, null, 2)}`,
      }],
      details: { ok: true, pulse_id: pulseId, persistence, scope_id: resolvedScopeId },
    };
  } catch (error) {
    return failure(
      `Could not create pulse '${pulseId}': ${error instanceof Error ? error.message : String(error)}`,
      "pulse_create_failed",
      { pulse_id: pulseId },
    );
  }
}

/** List pulses registered for this workspace, optionally filtered by status. */
export async function executeListPulses(bus: BusClient, turn: PulseTurn, params: any): Promise<SubstrateToolResult> {
  try {
    const result = await bus.listPulses({
      workspace_id: turn.workspace_id,
      status: typeof params?.status === "string" && params.status.trim() ? params.status.trim() : undefined,
    });
    const pulses = result.pulses ?? [];
    return {
      content: [{ type: "text", text: pulses.length === 0 ? "No pulses found for this workspace." : JSON.stringify(pulses, null, 2) }],
      details: { ok: true, count: pulses.length },
    };
  } catch (error) {
    return failure(`Could not list pulses: ${error instanceof Error ? error.message : String(error)}`, "pulse_list_failed");
  }
}

async function transitionPulse(
  bus: BusClient,
  params: any,
  verb: "pause" | "resume" | "cancel",
  call: (bus: BusClient, pulseId: string) => Promise<unknown>,
): Promise<SubstrateToolResult> {
  const pulseId = typeof params?.pulse_id === "string" ? params.pulse_id.trim() : "";
  if (!pulseId) return failure(`Cannot ${verb} pulse: the pulse_id is required.`, "invalid_pulse_id");
  try {
    const result = await call(bus, pulseId);
    const past = verb === "cancel" ? "cancelled" : `${verb}d`;
    return {
      content: [{ type: "text", text: `Pulse '${pulseId}' ${past}.\n${JSON.stringify(result, null, 2)}` }],
      details: { ok: true, pulse_id: pulseId },
    };
  } catch (error) {
    return failure(
      `Could not ${verb} pulse '${pulseId}': ${error instanceof Error ? error.message : String(error)}`,
      `pulse_${verb}_failed`,
      { pulse_id: pulseId },
    );
  }
}

/** Pause an active pulse; it can be resumed later. */
export function executePausePulse(bus: BusClient, params: any): Promise<SubstrateToolResult> {
  return transitionPulse(bus, params, "pause", (b, id) => b.pausePulse(id));
}

/** Resume a paused pulse; cron pulses recompute their next fire from now. */
export function executeResumePulse(bus: BusClient, params: any): Promise<SubstrateToolResult> {
  return transitionPulse(bus, params, "resume", (b, id) => b.resumePulse(id));
}

/** Permanently cancel a pulse; this cannot be undone. */
export function executeCancelPulse(bus: BusClient, params: any): Promise<SubstrateToolResult> {
  return transitionPulse(bus, params, "cancel", (b, id) => b.cancelPulse(id));
}
