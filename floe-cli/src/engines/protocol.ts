/**
 * Engine control: the Bridge's local channel for engine readiness and sign-in.
 * The wire protocol is documented in docs/reference/engine-control-protocol.md.
 * Credentials never cross it: a surface sees readiness, an account label, safe
 * messages and sign-in progress only.
 */
import type { ChannelSpec } from "../local-channel/protocol.js";

export const ENGINES_CHANNEL: ChannelSpec = {
  name: "engines",
  label: "Floe's engine control",
  runFile: "engines.json",
  socketFile: "engines.sock",
};

export type EnginePhase = "checking" | "ready" | "action_required" | "unavailable";
export type EngineAction = "sign_in" | "check_subscription" | "contact_admin" | "retry";

export type EngineState = {
  /** "copilot"; later "codex" or "claude". */
  engine: string;
  phase: EnginePhase;
  authentication: "unknown" | "signed_out" | "signed_in" | "not_required";
  access: "unknown" | "entitled" | "not_entitled" | "policy_blocked";
  reachability: "unknown" | "reachable" | "unreachable";
  account?: { label: string; host?: string };
  action?: EngineAction;
  /** Safe to show to a person. */
  message: string;
  checked_at: string;
  revision: number;
};

/** Welcome state and the `state` operation's result. */
export type EnginesSnapshot = { engines: Record<string, EngineState> };

export type SignInStatus = "starting" | "waiting_for_person" | "succeeded" | "failed" | "cancelled";

export type SignInEvent = {
  operation_id: string;
  engine: string;
  status: SignInStatus;
  message: string;
};

// Device-code sign-in is not offered: the vendor CLI prints its one-time code
// to Floe's background log, where the person can never see it.
export type SignInMode = "browser";
