/**
 * The identity agent: the one Floe process that holds the person's unlocked key
 * (ADR-0016). Surfaces ask it to act; it never hands out the key.
 *
 * - It signs only NIP-42 proofs for the Bus it was started with, and returns
 *   bearers, never signatures.
 * - The key lives in memory from unlock until the person locks it, until no
 *   surface has been connected for the idle period, or until the agent stops.
 * - Everything a surface needs to know is pushed: identity state on every
 *   change, and each session's bearer when minted and when renewed ahead of
 *   expiry (a timer on the known expiry, not polling).
 *
 * This module is transport-free; agent-server.ts carries it over the local
 * channel. All effects are injectable so it is tested without a network.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  loadIdentityFile,
  openIdentity,
  openLegacyConsoleFile,
  parseLegacyConsoleFile,
  saveIdentityFile,
  sealIdentity,
  setAsideIdentityFile,
  WrongPassphraseError,
  type IdentityFile,
  type Protection,
  type ScryptParams,
  type SecretKind,
  identityFilePath,
} from "./identity-file.js";
import {
  generatePhrase,
  isValidPhrase,
  normalizePhrase,
  npubOf,
  nsecOf,
  publicKeyHex,
  secretKeyFromPhrase,
  signAuthEvent,
} from "./keys.js";
import { BusIdentityClient, BusUnreachableError, type Workspace } from "./bus-identity.js";

export type IdentitySummary = {
  npub: string;
  pubkey_hex: string;
  display_name: string;
  protection: Protection;
  secret_kind: SecretKind;
};

export type AgentState =
  | { kind: "none" }
  | ({ kind: "locked" | "unlocked" } & IdentitySummary);

export class AgentError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AgentError";
  }
}

/** One authenticated surface connection. */
export interface AgentConnection {
  readonly surface: string;
  send(message: Record<string, unknown>): void;
}

type Timer = unknown;

export type AgentDeps = {
  home: string;
  busUrl: string;
  version: string | null;
  lockAfterIdleMs: number;
  /** Read (or with `create`, mint) the vault key for device protection; null when absent. */
  deviceKey: (create: boolean) => Promise<Uint8Array | null>;
  /** host_control from the native broker, for re-admission and revocation only. */
  hostToken: () => Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  scrypt?: ScryptParams;
  /** Renew a bearer this long before it expires. */
  renewBeforeExpiryMs?: number;
  log?: (line: string) => void;
};

type Session = {
  id: string;
  conn: AgentConnection;
  workspaceId?: string;
  status: "starting" | "ready" | "selection_required" | "needs_workspace" | "error";
  startedAt: string;
  expiresAt?: string;
  workspace?: Workspace;
  authoritySessionId?: string | null;
  identityId?: string;
  timer?: Timer;
};

const DEFAULT_RENEW_BEFORE_MS = 60_000;

export class IdentityAgent {
  private secretKey: Uint8Array | null = null;
  private readonly connections = new Set<AgentConnection>();
  private readonly sessions = new Map<string, Session>();
  private idleTimer: Timer | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly bus: BusIdentityClient;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: AgentDeps) {
    this.bus = new BusIdentityClient(deps.busUrl, deps.fetch);
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.log = deps.log ?? (() => {});
  }

  get version(): string | null {
    return this.deps.version;
  }

  // ── connections ────────────────────────────────────────────────────────────

  attach(conn: AgentConnection): void {
    this.connections.add(conn);
    this.cancelIdleLock();
  }

  detach(conn: AgentConnection): void {
    this.connections.delete(conn);
    for (const session of [...this.sessions.values()]) {
      if (session.conn === conn) this.endSession(session, "surface_disconnected", false);
    }
    if (this.connections.size === 0 && this.secretKey) this.scheduleIdleLock();
  }

  state(): AgentState {
    const file = loadIdentityFile(this.deps.home);
    if (!file) return { kind: "none" };
    return { kind: this.secretKey ? "unlocked" : "locked", ...summaryOf(file) };
  }

  /** Dispatch one request. Throws AgentError with a stable code on refusal. */
  async handle(conn: AgentConnection, op: string, args: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case "state": return this.state();
      case "create": return this.serial(() => this.create(args));
      case "unlock": return this.serial(() => this.unlock(optionalString(args, "passphrase") ?? ""));
      case "lock": return this.serial(async () => { this.lock("requested"); return this.state(); });
      case "restore": return this.serial(() => this.restore(args));
      case "reveal": return this.serial(() => this.reveal(args));
      case "replace": return this.serial(() => this.replace(args));
      case "import_legacy": return this.serial(() => this.importLegacy(args));
      case "join_folder": return this.joinFolder(args);
      case "session": return this.startSession(conn, args);
      case "select_workspace": return this.selectWorkspace(conn, args);
      case "end_session": return this.endOwnSession(conn, args);
      case "sessions": return this.listSessions();
      case "revoke_session": return this.revokeSession(args);
      default: throw new AgentError("unknown_op", `The identity agent has no operation '${op}'.`);
    }
  }

  // ── identity lifecycle ─────────────────────────────────────────────────────

  private async create(args: Record<string, unknown>): Promise<unknown> {
    if (loadIdentityFile(this.deps.home)) {
      throw new AgentError("identity_exists", "Floe already has an identity on this machine.", { npub: this.state().kind !== "none" ? (this.state() as IdentitySummary).npub : null });
    }
    const displayName = requireDisplayName(args);
    const passphrase = optionalString(args, "passphrase") ?? "";
    const phrase = generatePhrase();
    const key = secretKeyFromPhrase(phrase);
    await this.store({ secretKind: "phrase", secret: Buffer.from(phrase, "utf8"), key, displayName, passphrase });
    this.adoptKey(key);
    this.log(`created identity ${this.summary().npub} (${passphrase ? "passphrase" : "device"} protected)`);
    this.broadcastState();
    return { npub: this.summary().npub, phrase };
  }

  private async unlock(passphrase: string): Promise<AgentState> {
    const file = this.requireFile();
    this.adoptKey(await this.openKey(file, passphrase));
    this.broadcastState();
    if (this.connections.size === 0) this.scheduleIdleLock();
    return this.state();
  }

  private lock(reason: string): void {
    for (const session of [...this.sessions.values()]) this.endSession(session, "locked", true);
    if (this.secretKey) {
      this.secretKey.fill(0);
      this.secretKey = null;
      this.log(`locked (${reason})`);
    }
    this.cancelIdleLock();
    this.broadcastState();
  }

  private async restore(args: Record<string, unknown>): Promise<unknown> {
    const phrase = requireString(args, "phrase");
    if (!isValidPhrase(phrase)) throw new AgentError("invalid_phrase", "That is not a valid recovery phrase. Check each word and its order.");
    const key = secretKeyFromPhrase(phrase);
    const pubkey = publicKeyHex(key);
    const existing = loadIdentityFile(this.deps.home);
    if (existing && existing.pubkey_hex !== pubkey && args.replace_existing !== true) {
      throw new AgentError("identity_exists", "Floe already has a different identity on this machine.", { npub: existing.npub, restoring_npub: npubOf(pubkey) });
    }
    const displayName = optionalString(args, "display_name")
      ?? (existing && existing.pubkey_hex === pubkey ? existing.display_name : null)
      ?? await this.displayNameFromBus(key);
    if (!displayName) throw new AgentError("display_name_required", "Give this identity a display name.");
    const passphrase = optionalString(args, "passphrase") ?? "";
    this.lock("restoring");
    const setAside = setAsideIdentityFile(this.deps.home);
    await this.store({ secretKind: "phrase", secret: Buffer.from(normalizePhrase(phrase), "utf8"), key, displayName, passphrase });
    this.adoptKey(key);
    this.log(`restored identity ${npubOf(pubkey)} from its recovery phrase`);
    this.broadcastState();
    return { npub: npubOf(pubkey), set_aside_as: setAside };
  }

  private async reveal(args: Record<string, unknown>): Promise<unknown> {
    const file = this.requireFile();
    if (file.protection === "device" && args.confirm !== true) {
      throw new AgentError("confirmation_required", "This identity is guarded only by this device. Confirm to reveal its backup.");
    }
    if (file.protection === "passphrase" && !optionalString(args, "passphrase")) {
      throw new AgentError("passphrase_required", "Enter the passphrase to reveal the backup.");
    }
    const secret = await this.openSecret(file, optionalString(args, "passphrase") ?? "");
    try {
      return file.secret_kind === "phrase"
        ? { secret_kind: "phrase", secret: secret.toString("utf8") }
        : { secret_kind: "nsec", secret: nsecOf(new Uint8Array(secret)) };
    } finally {
      secret.fill(0);
    }
  }

  /**
   * "I forgot my passphrase and have no recovery phrase": re-admission, not
   * recovery. A new identity is made, admitted to every workspace the old one
   * was in, and the old one is revoked on this Floe. The old file is set aside
   * under a dated name, never deleted.
   */
  private async replace(args: Record<string, unknown>): Promise<unknown> {
    const previous = this.requireFile();
    const displayName = optionalString(args, "display_name") ?? previous.display_name;
    const passphrase = optionalString(args, "passphrase") ?? "";
    const phrase = generatePhrase();
    const key = secretKeyFromPhrase(phrase);
    const pubkey = publicKeyHex(key);

    let token: string;
    let clients;
    try {
      token = await this.deps.hostToken();
      clients = await this.bus.listClients(token);
    } catch (error) {
      throw new AgentError("bus_unreachable", `Floe could not reach its bus to carry your workspaces over, so nothing was changed. ${messageOf(error)}`);
    }
    const old = clients.find((client) => client.pubkey_hex === previous.pubkey_hex && !client.revoked_at);
    const workspaces = old?.workspaces ?? [];
    for (const workspace of workspaces) {
      await this.bus.admit(token, { display_name: displayName, pubkey: pubkey, workspace_id: workspace.workspace_id });
    }
    if (old) await this.bus.revokeIdentity(token, old.identity_id);

    this.lock("replacing");
    const setAside = setAsideIdentityFile(this.deps.home);
    await this.store({ secretKind: "phrase", secret: Buffer.from(phrase, "utf8"), key, displayName, passphrase });
    this.adoptKey(key);
    this.log(`replaced identity ${previous.npub} with ${npubOf(pubkey)}; carried ${workspaces.length} workspace(s); old file set aside as ${setAside}`);
    this.broadcastState();
    return {
      npub: npubOf(pubkey),
      phrase,
      previous_npub: previous.npub,
      previous_revoked: Boolean(old),
      workspaces,
      set_aside_as: setAside,
    };
  }

  /**
   * Import an identity file from an earlier surface (the console's format).
   * The surface passes the file's contents and the passphrase the person typed;
   * only the agent decrypts.
   */
  private async importLegacy(args: Record<string, unknown>): Promise<unknown> {
    const legacy = parseLegacyConsoleFile(args.file);
    if (!legacy) throw new AgentError("legacy_file_unrecognised", "That identity file is not a format Floe can import.");
    const passphrase = optionalString(args, "passphrase") ?? "";
    let plaintext: Buffer;
    try {
      plaintext = openLegacyConsoleFile(legacy, passphrase);
    } catch (error) {
      if (error instanceof WrongPassphraseError) throw new AgentError("wrong_passphrase", error.message);
      throw error;
    }
    let secretKind: SecretKind;
    let key: Uint8Array;
    let secret: Buffer;
    const asText = plaintext.toString("utf8");
    if (isValidPhrase(asText)) {
      secretKind = "phrase";
      key = secretKeyFromPhrase(asText);
      secret = Buffer.from(normalizePhrase(asText), "utf8");
    } else if (plaintext.length === 32) {
      // Made before recovery phrases existed: the file held the raw key.
      secretKind = "nsec";
      key = new Uint8Array(plaintext);
      secret = Buffer.from(plaintext);
    } else {
      throw new AgentError("legacy_file_unrecognised", "That identity file decrypted, but its contents are not a key Floe recognises.");
    }
    const pubkey = publicKeyHex(key);
    if (npubOf(pubkey) !== legacy.npub) {
      throw new AgentError("legacy_file_inconsistent", "That identity file's key does not match the identity it names, so it was not imported.");
    }
    const existing = loadIdentityFile(this.deps.home);
    if (existing && existing.pubkey_hex === pubkey) {
      return { npub: existing.npub, secret_kind: existing.secret_kind, already_present: true };
    }
    if (existing && args.replace_existing !== true) {
      throw new AgentError("identity_exists", "Floe already has a different identity on this machine.", { npub: existing.npub, importing_npub: legacy.npub });
    }
    const displayName = optionalString(args, "display_name") ?? await this.displayNameFromBus(key);
    if (!displayName) throw new AgentError("display_name_required", "Give this identity a display name.");
    const protection: Protection = legacy.protection === "device" || passphrase === "" ? "device" : "passphrase";
    this.lock("importing");
    const setAside = setAsideIdentityFile(this.deps.home);
    await this.store({ secretKind, secret, key, displayName, passphrase: protection === "device" ? "" : passphrase });
    this.adoptKey(key);
    this.log(`imported identity ${legacy.npub} (${secretKind === "nsec" ? "no recovery phrase" : "with recovery phrase"})`);
    this.broadcastState();
    return { npub: legacy.npub, secret_kind: secretKind, protection, set_aside_as: setAside };
  }

  // ── acting for the identity ────────────────────────────────────────────────

  private async joinFolder(args: Record<string, unknown>): Promise<unknown> {
    const locator = requireString(args, "locator");
    const file = this.requireFile();
    const key = await this.ensureUnlocked();
    try {
      const { challenge, relay } = await this.bus.challenge();
      const outcome = await this.bus.registerWorkspace(signAuthEvent(key, relay, challenge), {
        locator,
        display_name: file.display_name,
        name: optionalString(args, "name") ?? undefined,
        create_directory: args.create_directory === true,
      });
      if (outcome.kind === "ready" || outcome.kind === "pending") {
        // A session waiting for a workspace can now get a bearer: push it.
        for (const session of this.sessions.values()) {
          if (session.status === "needs_workspace") void this.authenticateSession(session, "joined a folder");
        }
      }
      return outcome;
    } catch (error) {
      throw asAgentError(error);
    } finally {
      key.fill(0);
    }
  }

  private async startSession(conn: AgentConnection, args: Record<string, unknown>): Promise<unknown> {
    this.requireFile();
    const session: Session = {
      id: randomUUID(),
      conn,
      workspaceId: optionalString(args, "workspace_id") ?? undefined,
      status: "starting",
      startedAt: new Date(this.now()).toISOString(),
    };
    this.sessions.set(session.id, session);
    // Answer first, then push: the surface learns the id before any event.
    setImmediate(() => void this.authenticateSession(session, "started"));
    return { session_id: session.id };
  }

  private async selectWorkspace(conn: AgentConnection, args: Record<string, unknown>): Promise<unknown> {
    const session = this.ownSession(conn, args);
    session.workspaceId = requireString(args, "workspace_id");
    setImmediate(() => void this.authenticateSession(session, "workspace selected"));
    return { session_id: session.id };
  }

  private async endOwnSession(conn: AgentConnection, args: Record<string, unknown>): Promise<unknown> {
    this.endSession(this.ownSession(conn, args), "ended_by_surface", true);
    return { ended: true };
  }

  private listSessions(): unknown {
    return {
      sessions: [...this.sessions.values()].map((session) => ({
        session_id: session.id,
        surface: session.conn.surface,
        status: session.status,
        workspace: session.workspace ?? null,
        started_at: session.startedAt,
        expires_at: session.expiresAt ?? null,
      })),
    };
  }

  private async revokeSession(args: Record<string, unknown>): Promise<unknown> {
    const id = requireString(args, "session_id");
    const session = this.sessions.get(id);
    if (!session) throw new AgentError("session_not_found", "There is no live session with that id.");
    await this.revokeBearer(session);
    this.endSession(session, "revoked", false);
    return { revoked: true };
  }

  private async authenticateSession(session: Session, reason: string): Promise<void> {
    if (!this.sessions.has(session.id)) return;
    this.clearSessionTimer(session);
    let key: Uint8Array;
    try {
      key = await this.ensureUnlocked();
    } catch (error) {
      this.pushSession(session, { status: "error", code: asAgentError(error).code, message: messageOf(error) });
      session.status = "error";
      return;
    }
    try {
      const { challenge, relay } = await this.bus.challenge();
      const reply = await this.bus.authenticate(signAuthEvent(key, relay, challenge), session.workspaceId);
      if (!this.sessions.has(session.id)) return;
      if (reply.kind === "bearer") {
        session.status = "ready";
        session.expiresAt = reply.expires_at;
        session.workspace = reply.workspace;
        session.authoritySessionId = reply.authority_session_id;
        session.identityId = reply.identity_id;
        session.workspaceId = reply.workspace.workspace_id;
        this.pushSession(session, {
          status: "ready",
          bearer_token: reply.bearer_token,
          workspace: reply.workspace,
          workspaces: reply.workspaces,
          expires_at: reply.expires_at,
        });
        this.scheduleRenewal(session);
        this.log(`session ${session.id} (${session.conn.surface}): bearer for ${reply.workspace.workspace_id} ${reason}, expires ${reply.expires_at}`);
      } else if (reply.kind === "selection_required") {
        session.status = "selection_required";
        this.pushSession(session, { status: "selection_required", workspaces: reply.workspaces });
      } else if (reply.kind === "not_admitted_to_workspace") {
        session.status = "selection_required";
        session.workspaceId = undefined;
        this.pushSession(session, { status: "selection_required", workspaces: reply.workspaces, message: "This identity is not in that workspace." });
      } else {
        session.status = "needs_workspace";
        this.pushSession(session, { status: "needs_workspace", message: "This identity is not in any workspace yet. Choose a folder to create or join one." });
      }
    } catch (error) {
      session.status = "error";
      this.pushSession(session, { status: "error", code: asAgentError(error).code, message: messageOf(error) });
    } finally {
      key.fill(0);
    }
  }

  private scheduleRenewal(session: Session): void {
    if (!session.expiresAt) return;
    const expires = Date.parse(session.expiresAt);
    if (Number.isNaN(expires)) return;
    const delay = Math.max(0, expires - this.now() - (this.deps.renewBeforeExpiryMs ?? DEFAULT_RENEW_BEFORE_MS));
    session.timer = this.setTimer(() => {
      session.timer = undefined;
      void this.authenticateSession(session, "renewed before expiry");
    }, delay);
  }

  private endSession(session: Session, reason: string, revoke: boolean): void {
    this.clearSessionTimer(session);
    this.sessions.delete(session.id);
    if (reason !== "surface_disconnected") this.pushSession(session, { status: "ended", reason });
    // A bearer should not outlive the reason it was minted.
    if (revoke || reason === "surface_disconnected") void this.revokeBearer(session);
  }

  private async revokeBearer(session: Session): Promise<void> {
    if (!session.authoritySessionId || !session.identityId) return;
    try {
      await this.bus.revokeSession(await this.deps.hostToken(), session.identityId, session.authoritySessionId);
      session.authoritySessionId = null;
    } catch (error) {
      this.log(`could not revoke the bearer of session ${session.id}: ${messageOf(error)}`);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private summary(): IdentitySummary {
    return summaryOf(this.requireFile());
  }

  private requireFile(): IdentityFile {
    const file = loadIdentityFile(this.deps.home);
    if (!file) throw new AgentError("no_identity", "There is no identity on this machine yet.");
    return file;
  }

  /** A copy of the unlocked key; device protection unlocks without asking. */
  private async ensureUnlocked(): Promise<Uint8Array> {
    if (!this.secretKey) {
      const file = this.requireFile();
      if (file.protection !== "device") throw new AgentError("locked", "The identity is locked. Unlock it with its passphrase.");
      this.adoptKey(await this.openKey(file, ""));
      this.broadcastState();
      if (this.connections.size === 0) this.scheduleIdleLock();
    }
    return Uint8Array.from(this.secretKey!);
  }

  private async openSecret(file: IdentityFile, passphrase: string): Promise<Buffer> {
    try {
      if (file.protection === "device") {
        const deviceKey = await this.deps.deviceKey(false);
        if (!deviceKey) {
          throw new AgentError(
            "device_key_unavailable",
            "This identity was protected by a different device or Floe home, so it cannot be opened here. Restore it from its recovery phrase.",
          );
        }
        return openIdentity(file, { deviceKey });
      }
      return openIdentity(file, { passphrase });
    } catch (error) {
      if (error instanceof WrongPassphraseError) {
        throw file.protection === "device"
          ? new AgentError("device_key_unavailable", "This identity was protected by a different device or Floe home, so it cannot be opened here. Restore it from its recovery phrase.")
          : new AgentError("wrong_passphrase", error.message);
      }
      throw error;
    }
  }

  private async openKey(file: IdentityFile, passphrase: string): Promise<Uint8Array> {
    const secret = await this.openSecret(file, passphrase);
    try {
      const key = file.secret_kind === "phrase" ? secretKeyFromPhrase(secret.toString("utf8")) : new Uint8Array(secret);
      if (publicKeyHex(key) !== file.pubkey_hex) {
        throw new AgentError("identity_corrupt", "The stored identity does not match its own public key. Restore it from its recovery phrase.");
      }
      return key;
    } finally {
      secret.fill(0);
    }
  }

  private async store(input: { secretKind: SecretKind; secret: Buffer; key: Uint8Array; displayName: string; passphrase: string }): Promise<void> {
    const protection: Protection = input.passphrase ? "passphrase" : "device";
    const deviceKey = protection === "device" ? await this.deps.deviceKey(true) : undefined;
    if (protection === "device" && !deviceKey) {
      throw new AgentError("device_key_unavailable", "Floe could not reach this machine's credential vault to protect the identity.");
    }
    const pubkey = publicKeyHex(input.key);
    saveIdentityFile(this.deps.home, sealIdentity({
      secretKind: input.secretKind,
      secret: input.secret,
      npub: npubOf(pubkey),
      pubkeyHex: pubkey,
      displayName: input.displayName,
      protection,
      passphrase: protection === "passphrase" ? input.passphrase : undefined,
      deviceKey: deviceKey ?? undefined,
      scrypt: this.deps.scrypt,
    }));
    input.secret.fill(0);
  }

  private async displayNameFromBus(key: Uint8Array): Promise<string | null> {
    try {
      const { challenge, relay } = await this.bus.challenge();
      return await this.bus.displayNameFor(signAuthEvent(key, relay, challenge));
    } catch {
      return null;
    }
  }

  private adoptKey(key: Uint8Array): void {
    if (this.secretKey) this.secretKey.fill(0);
    this.secretKey = key;
  }

  private scheduleIdleLock(): void {
    this.cancelIdleLock();
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = null;
      this.lock(`no surface connected for ${Math.round(this.deps.lockAfterIdleMs / 60_000)} minute(s)`);
    }, this.deps.lockAfterIdleMs);
  }

  private cancelIdleLock(): void {
    if (this.idleTimer !== null) {
      this.clearTimer(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearSessionTimer(session: Session): void {
    if (session.timer !== undefined) {
      this.clearTimer(session.timer);
      session.timer = undefined;
    }
  }

  private ownSession(conn: AgentConnection, args: Record<string, unknown>): Session {
    const session = this.sessions.get(requireString(args, "session_id"));
    if (!session || session.conn !== conn) throw new AgentError("session_not_found", "There is no live session with that id on this connection.");
    return session;
  }

  private pushSession(session: Session, body: Record<string, unknown>): void {
    session.conn.send({ type: "session", session_id: session.id, ...body });
  }

  private broadcastState(): void {
    const state = this.state();
    for (const conn of this.connections) conn.send({ type: "state", state });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** For tests: is the identity file present? */
  hasIdentityFile(): boolean {
    return existsSync(identityFilePath(this.deps.home));
  }
}

function summaryOf(file: IdentityFile): IdentitySummary {
  return {
    npub: file.npub,
    pubkey_hex: file.pubkey_hex,
    display_name: file.display_name,
    protection: file.protection,
    secret_kind: file.secret_kind,
  };
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new AgentError("invalid_request", `'${name}' is required.`);
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new AgentError("invalid_request", `'${name}' must be a string.`);
  return value;
}

function requireDisplayName(args: Record<string, unknown>): string {
  const name = requireString(args, "display_name").trim();
  if (name.length > 200) throw new AgentError("invalid_request", "The display name is too long (200 characters at most).");
  return name;
}

function asAgentError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  if (error instanceof BusUnreachableError) return new AgentError("bus_unreachable", error.message);
  return new AgentError("failed", messageOf(error));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
