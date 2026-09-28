/**
 * `floe/identity` — how a surface acts as the person without holding their key.
 *
 *   import { connectIdentity } from "floe/identity";
 *   const identity = await connectIdentity({ surface: "my-surface" });
 *   identity.onState((state) => render(state));
 *   const session = await identity.session({}, (event) => {
 *     if (event.status === "ready") useBearer(event.bearer_token);
 *   });
 *
 * The agent pushes identity state on every change and each session's bearer
 * when minted and again before it expires. A surface never polls. The wire
 * protocol is documented in docs/reference/identity-agent-protocol.md.
 */
import { ensureConfig, type LocalConfig } from "../config.js";
import { thisInstallation } from "../installation.js";
import { ensureSubstrateForClient, floeHome } from "../startup.js";
import { AgentUnavailableError, openAgentChannel, type AgentChannel } from "./connection.js";

export type Protection = "passphrase" | "device";
export type SecretKind = "phrase" | "nsec";

export type IdentityState =
  | { kind: "none" }
  | {
    kind: "locked" | "unlocked";
    npub: string;
    pubkey_hex: string;
    display_name: string;
    protection: Protection;
    /** "nsec" when imported from before recovery phrases existed: there are no words to show. */
    secret_kind: SecretKind;
  };

export type Workspace = { workspace_id: string; name: string };

export type SessionEvent =
  | { status: "ready"; bearer_token: string; workspace: Workspace; workspaces: Workspace[]; expires_at: string }
  | { status: "selection_required"; workspaces: Workspace[]; message?: string }
  | { status: "needs_workspace"; message: string }
  | { status: "error"; code: string; message: string }
  | { status: "ended"; reason: "locked" | "revoked" | "ended_by_surface" | string };

export type JoinOutcome =
  | { kind: "ready" | "pending"; workspace_id: string }
  | { kind: "failed"; workspace_id: string; reason: string }
  | { kind: "invalid"; error: string; message: string }
  | { kind: "refused"; message: string };

export type IdentitySession = {
  readonly id: string;
  /** Answer a selection_required event. */
  select(workspaceId: string): Promise<void>;
  end(): Promise<void>;
};

/** A refusal from the agent, with a stable `code` (see the protocol reference). */
export class IdentityError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "IdentityError";
  }
}

export { AgentUnavailableError };

export type ConnectOptions = {
  /** Shown in `floe identity sessions`, so the person can tell surfaces apart. */
  surface: string;
  /** Defaults to FLOE_CONFIG, then ~/.floe/config.yaml. */
  configPath?: string;
  /**
   * Start Floe (bus, bridge and agent) when the agent is not answering, if the
   * machine's services.start_on_demand allows it. Default true.
   */
  start?: boolean;
};

export async function connectIdentity(options: ConnectOptions): Promise<IdentityClient> {
  const { configPath, config } = ensureConfig(options.configPath);
  const home = floeHome(configPath, config);
  let channel: AgentChannel;
  try {
    channel = await openAgentChannel(home, options.surface);
  } catch (error) {
    if (!(error instanceof AgentUnavailableError) || error.reason !== "not_running" || options.start === false) throw error;
    await startFloe(configPath, config);
    channel = await openAgentChannel(home, options.surface);
  }
  return new IdentityClient(channel);
}

async function startFloe(configPath: string, config: LocalConfig): Promise<void> {
  const plan = await ensureSubstrateForClient(configPath, config);
  if (plan === "blocked") {
    throw new AgentUnavailableError(
      "not_running",
      "Floe's identity agent is not running, and this machine does not let a surface start Floe "
        + "(services.start_on_demand is false). Start Floe with `floe start`.",
    );
  }
}

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

export class IdentityClient {
  private current: IdentityState;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly stateListeners = new Set<(state: IdentityState) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly sessionListeners = new Map<string, (event: SessionEvent) => void>();
  private readonly early = new Map<string, SessionEvent[]>();
  private closed = false;

  /** @internal Use connectIdentity. */
  constructor(private readonly channel: AgentChannel) {
    this.current = channel.welcomeState as IdentityState;
    channel.onMessage((message) => this.receive(message));
    channel.socket.on("close", () => this.handleClose());
  }

  get state(): IdentityState {
    return this.current;
  }

  /** The Floe version of the agent serving this machine. */
  get agentVersion(): string | null {
    return this.channel.agentVersion;
  }

  /**
   * Set when the agent is a different Floe version from the copy this surface
   * depends on. Connect-first: the running agent is used as is, never restarted.
   */
  get versionNote(): string | null {
    const own = thisInstallation().version;
    const agent = this.channel.agentVersion;
    if (!own || agent === own) return null;
    return `Connected to the identity agent of ${agent ? `Floe ${agent}` : "an older Floe"}, but this surface ships Floe ${own}. `
      + "It was already running, so it is left as is and keeps serving until Floe restarts.";
  }

  onState(listener: (state: IdentityState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Create an identity. An empty passphrase protects it with this device instead. */
  create(input: { display_name: string; passphrase: string }): Promise<{ npub: string; phrase: string }> {
    return this.request("create", input);
  }

  unlock(passphrase = ""): Promise<IdentityState> {
    return this.request("unlock", { passphrase });
  }

  lock(): Promise<IdentityState> {
    return this.request("lock", {});
  }

  restore(input: { phrase: string; passphrase: string; display_name?: string; replace_existing?: boolean }): Promise<{ npub: string; set_aside_as: string | null }> {
    return this.request("restore", input);
  }

  /** The backup: the recovery phrase, or an nsec for an identity that has none. */
  reveal(input: { passphrase?: string; confirm?: boolean }): Promise<{ secret_kind: SecretKind; secret: string }> {
    return this.request("reveal", input);
  }

  /** Forgot the passphrase and have no phrase: a new identity, carried into the old one's workspaces. */
  replace(input: { passphrase: string; display_name?: string }): Promise<{
    npub: string;
    phrase: string;
    previous_npub: string;
    previous_revoked: boolean;
    workspaces: Workspace[];
    set_aside_as: string | null;
  }> {
    return this.request("replace", input);
  }

  /** Import an identity file written by an earlier surface. Pass its parsed JSON. */
  importLegacy(input: { file: unknown; passphrase: string; display_name?: string; replace_existing?: boolean }): Promise<{
    npub: string;
    secret_kind: SecretKind;
    protection?: Protection;
    already_present?: boolean;
    set_aside_as?: string | null;
  }> {
    return this.request("import_legacy", input);
  }

  /** Create or join the workspace for a folder. Sessions waiting for a workspace then receive a bearer. */
  joinFolder(input: { locator: string; create_directory?: boolean; name?: string }): Promise<JoinOutcome> {
    return this.request("join_folder", input);
  }

  /**
   * Ask for a bearer. The listener receives `ready` with the bearer, then `ready`
   * again with a fresh one before each expiry, until the session ends.
   */
  async session(options: { workspace_id?: string }, listener: (event: SessionEvent) => void): Promise<IdentitySession> {
    const { session_id: id } = await this.request<{ session_id: string }>("session", options);
    this.sessionListeners.set(id, listener);
    for (const event of this.early.get(id) ?? []) this.dispatchSession(id, event);
    this.early.delete(id);
    return {
      id,
      select: async (workspaceId) => { await this.request("select_workspace", { session_id: id, workspace_id: workspaceId }); },
      end: async () => {
        await this.request("end_session", { session_id: id });
        this.sessionListeners.delete(id);
      },
    };
  }

  sessions(): Promise<{ sessions: Array<{ session_id: string; surface: string; status: string; workspace: Workspace | null; started_at: string; expires_at: string | null }> }> {
    return this.request("sessions", {});
  }

  revokeSession(sessionId: string): Promise<{ revoked: boolean }> {
    return this.request("revoke_session", { session_id: sessionId });
  }

  close(): void {
    this.channel.socket.end();
  }

  private request<T = any>(op: string, args: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new AgentUnavailableError("not_running", "The connection to Floe's identity agent is closed."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.channel.send({ type: "request", id, op, args });
    });
  }

  private receive(message: Record<string, unknown>): void {
    if (message.type === "response") {
      const pending = this.pending.get(message.id as number);
      if (!pending) return;
      this.pending.delete(message.id as number);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        const { code, message: text, ...details } = (message.error ?? {}) as Record<string, unknown>;
        pending.reject(new IdentityError(String(code ?? "failed"), String(text ?? "The identity agent refused."), details));
      }
      return;
    }
    if (message.type === "state") {
      this.current = message.state as IdentityState;
      for (const listener of this.stateListeners) listener(this.current);
      return;
    }
    if (message.type === "session" && typeof message.session_id === "string") {
      const { type: _type, session_id: id, ...event } = message;
      this.dispatchSession(id as string, event as unknown as SessionEvent);
    }
  }

  private dispatchSession(id: string, event: SessionEvent): void {
    const listener = this.sessionListeners.get(id);
    if (!listener) {
      // The push can overtake the reply that names the session.
      this.early.set(id, [...(this.early.get(id) ?? []), event]);
      return;
    }
    if (event.status === "ended") this.sessionListeners.delete(id);
    listener(event);
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new AgentUnavailableError("not_running", "The connection to Floe's identity agent closed."));
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
  }
}
