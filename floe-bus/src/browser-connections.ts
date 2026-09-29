import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";

import { isLoopbackBrowserOrigin, normalizeBrowserOrigin } from "./browser-origin.js";
import type { BrowserPassRecord, BrowserPassStore } from "./browser-pass.js";

export type BrowserWorkspaceSession = Readonly<{
  bearer_token: string;
  authority_session_id: string;
  principal_id: string;
  workspace_id: string;
  expires_at: string;
}>;

type Connection = {
  connection_id: string;
  code: string;
  origin: string;
  expires_at: string;
  approved?: { pass_id: string; token: string; credential_expires_at: string };
};
type BrowserSession = {
  origin: string;
  session: BrowserWorkspaceSession | null;
  workspaces: Map<string, BrowserWorkspaceSession>;
  expires_at: string;
};
type BrowserRequest = Pick<FastifyRequest, "headers"> & { ip?: string };

export type LocalBrowserAccess = Readonly<{
  origins: ReadonlySet<string>;
  /** Supplied only by the authenticated local application host. */
  issueSession: (workspaceId?: string) => BrowserWorkspaceSession | null;
}>;

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

const LOOPBACK_BROWSER_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"];

/**
 * The loopback subset of the trusted browser origins. A local browser client is
 * a lens over the substrate that configures its own origin (via the trusted
 * origin set); the substrate does not know that any particular app exists, only
 * that these loopback origins are trusted to open a session without pairing.
 */
export function loopbackBrowserOrigins(origins: Iterable<string>): ReadonlySet<string> {
  const result = new Set<string>();
  for (const origin of origins) {
    let hostname: string;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      continue;
    }
    if (LOOPBACK_BROWSER_HOSTNAMES.includes(hostname)) result.add(origin);
  }
  return result;
}
const PENDING_COOKIE = "floe_browser_pending";
const SESSION_COOKIE = "floe_browser_session";
const PASS_COOKIE = "floe_browser_pass";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");

export class BrowserConnectionError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type PendingBrowserConnection = Readonly<{ connection_id: string; code: string; origin: string; expires_at: string }>;

/**
 * Browser transport. A paired browser holds a durable pass (see BrowserPassStore);
 * a local browser holds an in-memory session for this process. Either way the
 * cookie only references canonical authority, verified on every use. No host
 * credential, session bearer, or local path reaches browser JavaScript.
 */
export class BrowserConnections {
  private readonly pending = new Map<string, Connection>();
  private readonly sessions = new Map<string, BrowserSession>();

  constructor(
    private readonly origins: ReadonlySet<string>,
    private readonly revoke: (id: string) => void,
    private readonly passes: BrowserPassStore,
    private readonly now: () => number = () => Date.now(),
    private readonly local?: LocalBrowserAccess,
  ) {}

  private prune(): void {
    for (const [key, connection] of this.pending) {
      if (Date.parse(connection.expires_at) > this.now()) continue;
      if (connection.approved) this.passes.revoke(connection.approved.pass_id, "never_claimed");
      this.pending.delete(key);
    }
    for (const [key, entry] of this.sessions) {
      if (Date.parse(entry.expires_at) > this.now()) continue;
      for (const session of entry.workspaces.values()) this.revoke(session.authority_session_id);
      this.sessions.delete(key);
    }
  }

  private rawOrigin(request: Pick<FastifyRequest, "headers">): string {
    let origin = request.headers.origin;
    if (!origin && request.headers.referer) {
      try { origin = new URL(request.headers.referer).origin; } catch { /* denied by callers */ }
    }
    return origin ?? "";
  }

  /** A built-in trusted origin, or the exact origin an active pass is bound to. */
  origin(request: Pick<FastifyRequest, "headers">): string {
    const origin = this.rawOrigin(request);
    if (this.origins.has(origin)) return origin;
    const exact = normalizeBrowserOrigin(origin);
    if (exact && this.passes.hasActiveOrigin(exact)) return exact;
    throw new BrowserConnectionError(403, "This browser origin is not allowed to connect to Floe.");
  }

  /**
   * The origin a cookie may be honoured for, or null. Browsers send Floe's
   * cookies to Floe whatever local page made the request, so a cookie left
   * from another loopback origin reads as no cookie here and never blocks that
   * origin from pairing. Any other origin is still refused outright.
   */
  private cookieOrigin(request: Pick<FastifyRequest, "headers">): string | null {
    try {
      return this.origin(request);
    } catch (error) {
      const exact = normalizeBrowserOrigin(this.rawOrigin(request));
      if (exact && isLoopbackBrowserOrigin(exact)) return null;
      throw error;
    }
  }

  /** Pairing also accepts a loopback origin that has no pass yet, long enough to ask for one. */
  private pairingOrigin(request: Pick<FastifyRequest, "headers">): string {
    const origin = this.rawOrigin(request);
    if (this.origins.has(origin)) return origin;
    const exact = normalizeBrowserOrigin(origin);
    if (exact && isLoopbackBrowserOrigin(exact)) return exact;
    throw new BrowserConnectionError(403, "This browser origin is not allowed to connect to Floe.");
  }

  /** True when CORS may answer this origin on this path. CORS never grants authority by itself. */
  corsAllows(origin: string, path: string): boolean {
    if (this.origins.has(origin)) return true;
    const exact = normalizeBrowserOrigin(origin);
    if (!exact) return false;
    if (isLoopbackBrowserOrigin(exact) && PAIRING_PATHS.has(path)) return true;
    return this.passes.hasActiveOrigin(exact);
  }

  private cookie(request: Pick<FastifyRequest, "headers">, name: string): string {
    const values = (request.headers.cookie ?? "").split(";").map(item => item.trim()).filter(item => item.startsWith(`${name}=`));
    if (values.length !== 1) return "";
    const value = values[0]!.slice(name.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : "";
  }

  private setCookie(name: string, value: string, origin: string, maxAge: number): string {
    return `${name}=${value}; Path=/v1; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${origin.startsWith("https:") ? "; Secure" : ""}`;
  }

  private passCookie(token: string, origin: string, expiresAt: string): string {
    return this.setCookie(PASS_COOKIE, token, origin, Math.max(0, Math.floor((Date.parse(expiresAt) - this.now()) / 1_000)));
  }

  private localOrigin(request: BrowserRequest): string {
    const origin = this.origin(request);
    // This is the local application's explicit access policy. Remote clients,
    // forwarded requests and other websites cannot use it to obtain sessions.
    const forwarded = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"]
      .some(header => request.headers[header] !== undefined);
    if (!this.local?.origins.has(origin) || !isLoopbackAddress(request.ip)
      || forwarded || request.headers.host !== new URL(origin).host
      || (request.headers["sec-fetch-site"] !== undefined && request.headers["sec-fetch-site"] !== "same-origin")) {
      throw new BrowserConnectionError(403, "This connection requires remote pairing.");
    }
    return origin;
  }

  connectLocal(request: BrowserRequest): string {
    this.prune();
    const origin = this.localOrigin(request);
    const existingToken = this.cookie(request, SESSION_COOKIE);
    const existing = this.sessions.get(digest(existingToken));
    if (existing?.origin === origin) {
      existing.expires_at = new Date(this.now() + 86_400_000).toISOString();
      return this.setCookie(SESSION_COOKIE, existingToken, origin, 86_400);
    }
    if (this.sessions.size >= 64) throw new BrowserConnectionError(429, "Floe has too many browser connections.");
    const session = this.local!.issueSession();
    const token = secret();
    this.sessions.set(digest(token), {
      origin, session,
      workspaces: new Map(session ? [[session.workspace_id, session]] : []),
      expires_at: new Date(this.now() + 86_400_000).toISOString(),
    });
    return this.setCookie(SESSION_COOKIE, token, origin, 86_400);
  }

  mode(request: BrowserRequest): "local" | "remote" | null {
    this.prune();
    const localToken = this.cookie(request, SESSION_COOKIE);
    const token = this.cookie(request, PASS_COOKIE);
    if (!localToken && !token) return null;
    const origin = this.cookieOrigin(request);
    if (!origin) return null;
    const local = this.sessions.get(digest(localToken));
    if (local && local.origin === origin) {
      this.localOrigin(request);
      return "local";
    }
    return token && this.passes.use(token, origin, undefined) ? "remote" : null;
  }

  localOwner(request: BrowserRequest): string {
    if (this.mode(request) !== "local") throw new BrowserConnectionError(403, "This action is available through Floe on this computer.");
    return digest(this.cookie(request, SESSION_COOKIE));
  }

  start(request: Pick<FastifyRequest, "headers">): { connection: PendingBrowserConnection; cookie: string | null } {
    this.prune();
    const origin = this.pairingOrigin(request);
    const previous = this.pending.get(digest(this.cookie(request, PENDING_COOKIE)));
    if (previous?.origin === origin && !previous.approved) return { connection: this.project(previous), cookie: null };
    if (this.pending.size >= 32) throw new BrowserConnectionError(429, "Floe has too many browser connections. Close an unused connection and try again.");
    const token = secret();
    let code: string;
    do { code = randomBytes(4).toString("hex").toUpperCase(); }
    while ([...this.pending.values()].some(item => item.code === code));
    const entry: Connection = { connection_id: `browserconn_${randomUUID()}`, code, origin,
      expires_at: new Date(this.now() + 300_000).toISOString() };
    this.pending.set(digest(token), entry);
    return { connection: this.project(entry), cookie: this.setCookie(PENDING_COOKIE, token, origin, 300) };
  }

  list(): PendingBrowserConnection[] {
    this.prune();
    return [...this.pending.values()].filter(entry => !entry.approved).map(entry => this.project(entry));
  }

  /** Approves a waiting browser by issuing its pass; the browser collects it by claiming. */
  approve(connectionId: string, issue: (origin: string) => { pass: BrowserPassRecord; token: string }): BrowserPassRecord {
    this.prune();
    const entry = [...this.pending.values()].find(item => item.connection_id === connectionId);
    if (!entry) throw new BrowserConnectionError(404, "This browser connection expired. Start a new connection in the browser.");
    if (entry.approved) throw new BrowserConnectionError(409, "This browser connection has already been approved.");
    const { pass, token } = issue(entry.origin);
    entry.approved = { pass_id: pass.pass_id, token, credential_expires_at: pass.credential_expires_at };
    return pass;
  }

  claim(request: Pick<FastifyRequest, "headers">): string[] {
    this.prune();
    const origin = this.pairingOrigin(request);
    const key = digest(this.cookie(request, PENDING_COOKIE));
    const entry = this.pending.get(key);
    if (!entry || entry.origin !== origin) throw new BrowserConnectionError(401, "Start a new connection to Floe.");
    if (!entry.approved) throw new BrowserConnectionError(409, "Allow this connection in Floe first.");
    // The pending secret is spent: the pass cookie is the only credential from here.
    this.pending.delete(key);
    this.passes.markClaimed(entry.approved.pass_id);
    return [this.passCookie(entry.approved.token, origin, entry.approved.credential_expires_at),
      this.setCookie(PENDING_COOKIE, "", origin, 0)];
  }

  /**
   * The Workspace session behind this request's cookie, plus a replacement
   * cookie when a pass was renewed. Null when the cookie does not apply here.
   */
  resolve(request: BrowserRequest, workspaceId?: string, renew = false): { session: BrowserWorkspaceSession; cookie: string | null } | null {
    this.prune();
    const localToken = this.cookie(request, SESSION_COOKIE);
    const passToken = this.cookie(request, PASS_COOKIE);
    if (!localToken && !passToken) return null;
    const origin = this.cookieOrigin(request);
    if (!origin) return null;
    const entry = localToken ? this.sessions.get(digest(localToken)) : undefined;
    if (entry?.origin === origin) {
      const session = this.localSession(request, entry, workspaceId);
      return session ? { session, cookie: null } : null;
    }
    const used = this.passes.use(passToken, origin, workspaceId, renew);
    if (!used) return null;
    return { session: used.session,
      cookie: used.renewed_token ? this.passCookie(used.renewed_token, origin, used.pass.credential_expires_at) : null };
  }

  session(request: BrowserRequest, workspaceId?: string): BrowserWorkspaceSession | null {
    return this.resolve(request, workspaceId)?.session ?? null;
  }

  private localSession(request: BrowserRequest, entry: BrowserSession, workspaceId?: string): BrowserWorkspaceSession | null {
    this.localOrigin(request);
    const requested = workspaceId ?? entry.session?.workspace_id;
    let session = requested ? entry.workspaces.get(requested) : undefined;
    if (!session || Date.parse(session.expires_at) <= this.now()) {
      // Expired entries are reclaimed on use, without a recurring timer.
      for (const [id, cached] of entry.workspaces) {
        if (Date.parse(cached.expires_at) <= this.now()) {
          this.revoke(cached.authority_session_id);
          entry.workspaces.delete(id);
        }
      }
      if (entry.workspaces.size >= 128) throw new BrowserConnectionError(429, "Too many workspaces are open in this browser connection.");
      session = this.local!.issueSession(requested) ?? undefined;
      if (session) {
        entry.workspaces.set(session.workspace_id, session);
        if (!entry.session) entry.session = session;
      }
    }
    return session ?? null;
  }

  /** Disconnecting a paired browser revokes its pass, not just this process's memory of it. */
  disconnect(request: BrowserRequest): string[] {
    const origin = this.origin(request);
    const sessionKey = digest(this.cookie(request, SESSION_COOKIE));
    const entry = this.sessions.get(sessionKey);
    if (entry?.origin === origin) for (const session of entry.workspaces.values()) this.revoke(session.authority_session_id);
    this.sessions.delete(sessionKey);
    this.passes.revokeByToken(this.cookie(request, PASS_COOKIE), origin, "disconnected");
    const pendingKey = digest(this.cookie(request, PENDING_COOKIE));
    const pending = this.pending.get(pendingKey);
    if (pending?.origin === origin) {
      if (pending.approved) this.passes.revoke(pending.approved.pass_id, "disconnected");
      this.pending.delete(pendingKey);
    }
    return [this.setCookie(SESSION_COOKIE, "", origin, 0), this.setCookie(PASS_COOKIE, "", origin, 0),
      this.setCookie(PENDING_COOKIE, "", origin, 0)];
  }

  close(): void {
    for (const entry of this.sessions.values()) for (const session of entry.workspaces.values()) this.revoke(session.authority_session_id);
    this.sessions.clear();
    // An approved pass not yet claimed has no reachable cookie after this process ends.
    for (const entry of this.pending.values()) if (entry.approved) this.passes.revoke(entry.approved.pass_id, "never_claimed");
    this.pending.clear();
  }

  private project(entry: Connection): PendingBrowserConnection {
    return { connection_id: entry.connection_id, code: entry.code, origin: entry.origin, expires_at: entry.expires_at };
  }
}

const PAIRING_PATHS = new Set(["/v1/browser/connections", "/v1/browser/connections/claim", "/v1/browser/session"]);
