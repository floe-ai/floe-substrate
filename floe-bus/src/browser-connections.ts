import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";

export type BrowserWorkspaceSession = Readonly<{
  bearer_token: string;
  authority_session_id: string;
  principal_id: string;
  workspace_id: string;
  expires_at: string;
}>;

type Connection = {
  code: string;
  origin: string;
  expires_at: string;
  approved?: BrowserWorkspaceSession;
  claimed_cookie?: string;
};
type BrowserSession = {
  origin: string;
  mode: "local" | "remote";
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
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");

export class BrowserConnectionError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * Ephemeral browser transport, not another authority store. Cookies reference
 * canonical Workspace sessions; their current grants are verified on every use.
 * No host credential, session bearer, or local path reaches browser JavaScript.
 */
export class BrowserConnections {
  private readonly pending = new Map<string, Connection>();
  private readonly sessions = new Map<string, BrowserSession>();

  constructor(
    private readonly origins: ReadonlySet<string>,
    private readonly revoke: (id: string) => void,
    private readonly now: () => number = Date.now,
    private readonly local?: LocalBrowserAccess,
  ) {}

  private prune(): void {
    for (const [key, connection] of this.pending) {
      if (Date.parse(connection.expires_at) > this.now()) continue;
      if (connection.approved && !connection.claimed_cookie) this.revoke(connection.approved.authority_session_id);
      this.pending.delete(key);
    }
    for (const [key, entry] of this.sessions) {
      if (Date.parse(entry.expires_at) > this.now()) continue;
      for (const session of entry.workspaces.values()) this.revoke(session.authority_session_id);
      this.sessions.delete(key);
    }
  }

  origin(request: Pick<FastifyRequest, "headers">): string {
    let origin = request.headers.origin;
    if (!origin && request.headers.referer) {
      try { origin = new URL(request.headers.referer).origin; } catch { /* denied below */ }
    }
    if (!origin || !this.origins.has(origin)) throw new BrowserConnectionError(403, "This browser origin is not allowed to connect to Floe.");
    return origin;
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
    if (existing?.mode === "local" && existing.origin === origin) {
      existing.expires_at = new Date(this.now() + 86_400_000).toISOString();
      return this.setCookie(SESSION_COOKIE, existingToken, origin, 86_400);
    }
    if (this.sessions.size >= 64) throw new BrowserConnectionError(429, "Floe has too many browser connections.");
    const session = this.local!.issueSession();
    const token = secret();
    this.sessions.set(digest(token), {
      origin, mode: "local", session,
      workspaces: new Map(session ? [[session.workspace_id, session]] : []),
      expires_at: new Date(this.now() + 86_400_000).toISOString(),
    });
    return this.setCookie(SESSION_COOKIE, token, origin, 86_400);
  }

  mode(request: BrowserRequest): "local" | "remote" | null {
    this.prune();
    const entry = this.sessions.get(digest(this.cookie(request, SESSION_COOKIE)));
    if (!entry || entry.origin !== this.origin(request)) return null;
    if (entry.mode === "local") this.localOrigin(request);
    return entry.mode;
  }

  localOwner(request: BrowserRequest): string {
    if (this.mode(request) !== "local") throw new BrowserConnectionError(403, "This action is available through Floe on this computer.");
    return digest(this.cookie(request, SESSION_COOKIE));
  }

  start(request: Pick<FastifyRequest, "headers">) {
    this.prune();
    const origin = this.origin(request);
    const previous = this.pending.get(digest(this.cookie(request, PENDING_COOKIE)));
    if (previous?.origin === origin) return { connection: this.project(previous), cookie: null };
    if (this.pending.size >= 32 || this.sessions.size >= 64) throw new BrowserConnectionError(429, "Floe has too many browser connections. Close an unused connection and try again.");
    const token = secret();
    let code: string;
    do { code = randomBytes(4).toString("hex").toUpperCase(); }
    while ([...this.pending.values()].some(item => item.code === code));
    const entry = { code, origin, expires_at: new Date(this.now() + 300_000).toISOString() };
    this.pending.set(digest(token), entry);
    return { connection: this.project(entry), cookie: this.setCookie(PENDING_COOKIE, token, origin, 300) };
  }

  list() {
    this.prune();
    return [...this.pending.values()].filter(entry => !entry.approved).map(entry => this.project(entry));
  }

  approve(code: string, issue: () => BrowserWorkspaceSession): void {
    this.prune();
    const entry = [...this.pending.values()].find(item => item.code === code);
    if (!entry) throw new BrowserConnectionError(404, "This browser connection expired. Start a new connection in the browser.");
    if (entry.approved) throw new BrowserConnectionError(409, "This browser connection has already been approved.");
    if (this.sessions.size >= 64) throw new BrowserConnectionError(429, "Floe has too many browser connections.");
    entry.approved = issue();
  }

  claim(request: Pick<FastifyRequest, "headers">) {
    this.prune();
    const origin = this.origin(request);
    const entry = this.pending.get(digest(this.cookie(request, PENDING_COOKIE)));
    if (!entry || entry.origin !== origin) throw new BrowserConnectionError(401, "Start a new connection to Floe.");
    if (!entry.approved) throw new BrowserConnectionError(409, "Allow this connection in the Floe app first.");
    if (Date.parse(entry.approved.expires_at) <= this.now()) throw new BrowserConnectionError(401, "This connection expired.");
    if (!entry.claimed_cookie) {
      if (this.sessions.size >= 64) throw new BrowserConnectionError(429, "Floe has too many browser connections.");
      entry.claimed_cookie = secret();
      this.sessions.set(digest(entry.claimed_cookie), {
        origin, mode: "remote", session: entry.approved,
        workspaces: new Map([[entry.approved.workspace_id, entry.approved]]), expires_at: entry.approved.expires_at,
      });
    }
    return this.setCookie(SESSION_COOKIE, entry.claimed_cookie, origin, Math.max(0, Math.floor((Date.parse(entry.approved.expires_at) - this.now()) / 1_000)));
  }

  session(request: BrowserRequest, workspaceId?: string): BrowserWorkspaceSession | null {
    this.prune();
    const token = this.cookie(request, SESSION_COOKIE);
    if (!token) return null;
    const origin = this.origin(request);
    const entry = this.sessions.get(digest(token));
    if (entry?.origin !== origin) return null;
    if (entry.mode === "remote") return !workspaceId || workspaceId === entry.session?.workspace_id ? entry.session : null;
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

  disconnect(request: BrowserRequest): string[] {
    const origin = this.origin(request);
    const sessionKey = digest(this.cookie(request, SESSION_COOKIE));
    const entry = this.sessions.get(sessionKey);
    if (entry?.origin === origin) for (const session of entry.workspaces.values()) this.revoke(session.authority_session_id);
    this.sessions.delete(sessionKey);
    const pendingKey = digest(this.cookie(request, PENDING_COOKIE));
    const pending = this.pending.get(pendingKey);
    if (pending?.origin === origin) {
      if (pending.approved) this.revoke(pending.approved.authority_session_id);
      this.pending.delete(pendingKey);
    }
    return [this.setCookie(SESSION_COOKIE, "", origin, 0), this.setCookie(PENDING_COOKIE, "", origin, 0)];
  }

  close(): void {
    for (const entry of this.sessions.values()) for (const session of entry.workspaces.values()) this.revoke(session.authority_session_id);
    for (const entry of this.pending.values()) if (entry.approved) this.revoke(entry.approved.authority_session_id);
    this.sessions.clear();
    this.pending.clear();
  }

  private project(entry: Connection) {
    return { code: entry.code, origin: entry.origin, expires_at: entry.expires_at };
  }
}
