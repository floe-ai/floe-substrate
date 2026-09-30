/**
 * `floe/engines` — whether an engine is ready to run work, and signing in
 * without the person typing a command.
 *
 *   import { connectEngines } from "floe/engines";
 *   const engines = await connectEngines({ surface: "my-surface" });
 *   render(engines.state);
 *   engines.onState(render);
 *   engines.onSignIn(renderSignInProgress);
 *   await engines.signIn("copilot"); // the vendor opens its own sign-in window
 *
 * The Bridge pushes every change; a surface never polls. Credentials never
 * reach a surface. The wire protocol is in docs/reference/engine-control-protocol.md.
 */
import { ChannelClient } from "../local-channel/client.js";
export type { RunningTurn, VersionSwitchOutcome } from "../local-channel/client.js";
import { connectChannel, type ChannelConnectOptions } from "../local-channel/connect.js";
import { ChannelUnavailableError, type Channel } from "../local-channel/connection.js";
import { ENGINES_CHANNEL, type EngineState, type EnginesSnapshot, type SignInEvent, type SignInMode } from "./protocol.js";

export type { EngineAction, EnginePhase, EngineState, EnginesSnapshot, SignInEvent, SignInMode, SignInStatus } from "./protocol.js";
export { ChannelUnavailableError as EnginesUnavailableError };

/** A refusal from engine control, with a stable `code` (see the protocol reference). */
export class EnginesError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "EnginesError";
  }
}

export type ConnectEnginesOptions = ChannelConnectOptions;

export async function connectEngines(options: ConnectEnginesOptions): Promise<EnginesClient> {
  return new EnginesClient(await connectChannel(ENGINES_CHANNEL, options));
}

export class EnginesClient extends ChannelClient {
  private engines: Record<string, EngineState>;
  private readonly stateListeners = new Set<(state: Record<string, EngineState>, changed: EngineState) => void>();
  private readonly signInListeners = new Set<(event: SignInEvent) => void>();

  /** @internal Use connectEngines. */
  constructor(channel: Channel) {
    super(channel, ENGINES_CHANNEL, (code, message, details) => new EnginesError(code, message, details));
    this.engines = { ...((channel.welcomeState as Partial<EnginesSnapshot>).engines ?? {}) };
  }

  /** Every engine this Floe runs work on, by name. */
  get state(): Record<string, EngineState> {
    return this.engines;
  }

  /** Called with the full map and the engine that changed, on every change. */
  onState(listener: (state: Record<string, EngineState>, changed: EngineState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Progress of every sign-in, from `starting` to `succeeded`, `failed` or `cancelled`. */
  onSignIn(listener: (event: SignInEvent) => void): () => void {
    this.signInListeners.add(listener);
    return () => this.signInListeners.delete(listener);
  }

  /** Check an engine again now. The result also arrives through onState. */
  refresh(engine: string): Promise<EngineState> {
    return this.request("refresh", { engine });
  }

  /** Start the vendor's own sign-in. Progress arrives through onSignIn. */
  signIn(engine: string, options: { mode?: SignInMode } = {}): Promise<{ operation_id: string }> {
    return this.request("sign_in", { engine, ...(options.mode ? { mode: options.mode } : {}) });
  }

  cancelSignIn(operationId: string): Promise<{ cancelled: true }> {
    return this.request("cancel_sign_in", { operation_id: operationId });
  }

  protected onPush(message: Record<string, unknown>): void {
    if (message.type === "state" && message.state && typeof message.state === "object") {
      const changed = message.state as EngineState;
      this.engines = { ...this.engines, [changed.engine]: changed };
      for (const listener of this.stateListeners) listener(this.engines, changed);
      return;
    }
    if (message.type === "sign_in" && typeof message.operation_id === "string") {
      const { type: _type, ...event } = message;
      for (const listener of this.signInListeners) listener(event as unknown as SignInEvent);
    }
  }
}
