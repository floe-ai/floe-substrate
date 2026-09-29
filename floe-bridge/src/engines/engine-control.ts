/**
 * Engine control: the Bridge owns engine readiness because it owns engine
 * execution. Each engine's account adapter checks readiness and drives the
 * vendor's own sign-in; this service publishes that to surfaces over the
 * engines local channel and gates work on it.
 *
 * Readiness is checked on start, after a sign-in, after an engine failure and
 * when a surface asks. It is never polled. Credentials never pass through here.
 */
import { ChannelError, type ChannelPeer, type ChannelService } from "floe-cli/local-channel";
import type { EngineState, EnginesSnapshot, SignInEvent, SignInMode } from "floe-cli/engines/protocol";

/** What an engine's account adapter provides (floe-runtime's CopilotEngineAccountAdapter is one). */
export interface EngineAccount {
  currentState(): EngineState;
  check(): Promise<EngineState>;
  signIn?(input: { mode?: SignInMode }): Promise<{ id: string }>;
  cancelSignIn?(id: string): Promise<void>;
  close?(): Promise<void>;
  on(event: "state", listener: (state: EngineState) => void): unknown;
  on(event: "sign_in", listener: (progress: { operationId: string; engine: string; status: SignInEvent["status"]; message: string }) => void): unknown;
}

export class EngineControl implements ChannelService {
  private readonly peers = new Set<ChannelPeer>();
  private readonly operations = new Map<string, string>();
  private readonly readyListeners = new Set<(engine: string) => void>();

  constructor(
    private readonly accounts: ReadonlyMap<string, EngineAccount>,
    readonly version: string | null,
    private readonly log: (line: string, detail?: Record<string, unknown>) => void = () => {},
  ) {
    for (const [engine, account] of accounts) {
      let wasReady = account.currentState().phase === "ready";
      account.on("state", (state) => {
        this.broadcast({ type: "state", engine, state });
        const ready = state.phase === "ready";
        if (ready && !wasReady) for (const listener of this.readyListeners) listener(engine);
        wasReady = ready;
      });
      account.on("sign_in", (progress) => {
        if (progress.status === "starting") this.operations.set(progress.operationId, engine);
        else if (progress.status !== "waiting_for_person") this.operations.delete(progress.operationId);
        this.log("engine sign-in", { engine, operation_id: progress.operationId, status: progress.status });
        this.broadcast({
          type: "sign_in",
          operation_id: progress.operationId,
          engine,
          status: progress.status,
          message: progress.message,
        });
      });
    }
  }

  /** The engines this Bridge runs work on. */
  get engines(): string[] {
    return [...this.accounts.keys()];
  }

  /** One readiness check per engine at start. Deliveries wait on it through gate(). */
  start(): void {
    for (const engine of this.accounts.keys()) void this.recheck(engine);
  }

  /** Check an engine again, e.g. after one of its turns failed. */
  recheck(engine: string): Promise<EngineState | null> {
    const account = this.accounts.get(engine);
    if (!account) return Promise.resolve(null);
    return account.check().catch((error: unknown) => {
      this.log("engine check failed", { engine, error: error instanceof Error ? error.message : String(error) });
      return null;
    });
  }

  /**
   * The state work for this engine must see before it runs. A check in progress
   * (or none yet) is awaited, never skipped: work never runs on a guess.
   */
  async gate(engine: string): Promise<EngineState> {
    const account = this.require(engine);
    const current = account.currentState();
    return current.phase === "checking" ? account.check() : current;
  }

  /** Called once each time an engine becomes ready. */
  onReady(listener: (engine: string) => void): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  state(): EnginesSnapshot {
    const engines: Record<string, EngineState> = {};
    for (const [engine, account] of this.accounts) engines[engine] = account.currentState();
    return { engines };
  }

  attach(peer: ChannelPeer): void {
    this.peers.add(peer);
  }

  detach(peer: ChannelPeer): void {
    this.peers.delete(peer);
  }

  async handle(_peer: ChannelPeer, op: string, args: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case "state":
        return this.state();
      case "refresh":
        return this.require(stringArg(args, "engine")).check();
      case "sign_in": {
        const engine = stringArg(args, "engine");
        const account = this.require(engine);
        if (!account.signIn) throw new ChannelError("sign_in_unsupported", `The ${engine} engine has no sign-in.`);
        const mode = args.mode === undefined ? undefined : args.mode;
        if (mode !== undefined && mode !== "browser") {
          throw new ChannelError("invalid_sign_in_mode", "mode must be \"browser\"; device-code sign-in is not available.");
        }
        const { id } = await vendor(() => account.signIn!({ mode }));
        return { operation_id: id };
      }
      case "cancel_sign_in": {
        const operationId = stringArg(args, "operation_id");
        const engine = this.operations.get(operationId);
        const account = engine ? this.accounts.get(engine) : undefined;
        if (!account?.cancelSignIn) throw new ChannelError("sign_in_not_found", `Sign-in '${operationId}' is not active.`);
        await vendor(() => account.cancelSignIn!(operationId));
        return { cancelled: true };
      }
      default:
        throw new ChannelError("unknown_op", `Engine control has no operation '${op}'.`);
    }
  }

  async close(): Promise<void> {
    for (const account of this.accounts.values()) await account.close?.().catch(() => {});
  }

  private require(engine: string): EngineAccount {
    const account = this.accounts.get(engine);
    if (!account) throw new ChannelError("unknown_engine", `This Floe runs no engine named '${engine}'.`, { engines: this.engines });
    return account;
  }

  private broadcast(message: Record<string, unknown>): void {
    for (const peer of this.peers) peer.send(message);
  }
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new ChannelError("invalid_request", `${name} is required.`);
  return value.trim();
}

/** A vendor adapter's refusal (floe-runtime's RuntimeFault) keeps its code. */
async function vendor<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new ChannelError(typeof code === "string" ? code : "failed", error instanceof Error ? error.message : String(error));
  }
}
