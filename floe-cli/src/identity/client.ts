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
import { ChannelClient } from "../local-channel/client.js";
import type { SwitchReadiness } from "./agent.js";
export type { SwitchReadiness };
export type { RunningTurn, VersionSwitchOutcome } from "../local-channel/client.js";
import { connectChannel } from "../local-channel/connect.js";
import { AgentUnavailableError, type AgentChannel } from "./connection.js";
import { IDENTITY_CHANNEL } from "./protocol.js";

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

export type Workspace = {
  workspace_id: string;
  name: string;
  /** The folder on this machine the workspace is bound to. */
  folder_path: string | null;
  /** When this identity last opened it; null if never. Lists come most recent first. */
  last_used_at: string | null;
};

/** One identity Floe holds. Unreadable ones have null details but can still be deleted. */
export type HeldIdentity = {
  id: string;
  current: boolean;
  readable: boolean;
  display_name: string | null;
  created_at: string | null;
  set_aside_at: string | null;
  protection: Protection | null;
  has_recovery_phrase: boolean | null;
  npub?: string | null;
};

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

export type FolderLookup =
  | { kind: "workspace"; workspace: { workspace_id: string; name: string; folder_path: string | null }; joined: boolean }
  | { kind: "none" }
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
  /** Defaults to ~/.floe/config.yaml. */
  configPath?: string;
  /**
   * Start Floe (bus, bridge and agent) when the agent is not answering, if the
   * machine's services.start_on_demand allows it. Default true.
   */
  start?: boolean;
};

export async function connectIdentity(options: ConnectOptions): Promise<IdentityClient> {
  const channel = await connectChannel(IDENTITY_CHANNEL, options);
  if (Object.keys(channel.welcomeState).length === 0) channel.welcomeState = { kind: "none" };
  return new IdentityClient(channel);
}

export class IdentityClient extends ChannelClient {
  private current: IdentityState;
  private readonly stateListeners = new Set<(state: IdentityState) => void>();
  private readonly sessionListeners = new Map<string, (event: SessionEvent) => void>();
  private readonly early = new Map<string, SessionEvent[]>();
  private readonly readinessListeners = new Set<(readiness: SwitchReadiness) => void>();

  /** @internal Use connectIdentity. */
  constructor(channel: AgentChannel) {
    super(channel, IDENTITY_CHANNEL, (code, message, details) => new IdentityError(code, message, details));
    this.current = channel.welcomeState as IdentityState;
  }

  get state(): IdentityState {
    return this.current;
  }

  onState(listener: (state: IdentityState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
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

  /** The identity's workspaces, most recently used first. Opens no session and mints nothing. */
  async listWorkspaces(): Promise<Workspace[]> {
    return (await this.request<{ workspaces: Workspace[] }>("list_workspaces", {})).workspaces;
  }

  /**
   * Which workspace a folder already is: `workspace` (with `joined` saying whether
   * this identity is in it) or `none`. Read-only: it never registers or joins.
   */
  workspaceForFolder(input: { locator: string }): Promise<FolderLookup> {
    return this.request("workspace_for_folder", input);
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

  /** Every identity Floe holds here: the current one and each one set aside. */
  listIdentities(input: { include_npub?: boolean } = {}): Promise<{ identities: HeldIdentity[] }> {
    return this.request("list_identities", input);
  }

  /**
   * Delete one identity for good. The current one also needs `revoke_admissions`
   * (the person's choice) and, when passphrase protected, its passphrase.
   */
  deleteIdentity(input: { id: string; confirm: true; revoke_admissions?: boolean; passphrase?: string }): Promise<{
    deleted: string;
    revoked_admissions: { revoked: boolean; workspaces: Workspace[] } | null;
    device_key_removed: boolean;
  }> {
    return this.request("delete_identity", input);
  }

  /**
   * Follow whether switching Floe to this version would interrupt work. The
   * listener gets the current readiness, then each change, by push: wait for
   * `ready: true` before `switchToThisVersion()`. `following: false` means the
   * watch ended (for example Floe stopped); call again to resume. Returns a
   * function that stops following.
   */
  async followSwitchReadiness(listener: (readiness: SwitchReadiness) => void): Promise<() => Promise<void>> {
    this.readinessListeners.add(listener);
    try {
      await this.request("watch_switch_readiness", {});
    } catch (error) {
      this.readinessListeners.delete(listener);
      throw error;
    }
    return async () => {
      if (!this.readinessListeners.delete(listener) || this.readinessListeners.size > 0) return;
      await this.request("unwatch_switch_readiness", {});
    };
  }

  protected onPush(message: Record<string, unknown>): void {
    if (message.type === "switch_readiness") {
      const readiness = message.readiness as SwitchReadiness;
      for (const listener of this.readinessListeners) listener(readiness);
      if (!readiness.following) this.readinessListeners.clear();
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
}
