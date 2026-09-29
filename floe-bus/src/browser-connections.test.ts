import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { BrowserConnections } from "./browser-connections.js";
import { applyBrowserPassSchema, BrowserPassStore } from "./browser-pass.js";
import { applyCapabilityGrantSchema, SqliteCapabilityGrantStore } from "./capability-grants.js";
import { applyOperationAuthoritySessionSchema, SqliteOperationAuthoritySessionStore } from "./operation-authority-sessions.js";

const origin = "http://localhost:5379";
const request = (cookie = "", requestOrigin = origin) => ({ headers: { origin: requestOrigin, cookie } });
const cookieHeader = (cookie: string) => cookie.split(";", 1)[0]!;
const passCookie = (cookies: string[]) => cookieHeader(cookies.find(item => item.startsWith("floe_browser_pass="))!);

function fixture() {
  let now = Date.now();
  const iso = () => new Date(now).toISOString();
  const db = new DatabaseSync(":memory:");
  applyCapabilityGrantSchema(db);
  applyOperationAuthoritySessionSchema(db);
  applyBrowserPassSchema(db);
  const grants = new SqliteCapabilityGrantStore(db, { now: iso });
  const sessions = new SqliteOperationAuthoritySessionStore(db, grants, { now: iso });
  const passes = new BrowserPassStore(db, grants, sessions, () => {}, () => now);
  const root = grants.issueGrant({ principal_id: "identity:a", boundary: { kind: "workspace", workspace_id: "workspace:one" },
    operation_ids: ["actor.list", "context.inspect"], expires_at: null, issuer_id: "test", evidence: [{ kind: "test", ref: "root" }] });
  const revoke = vi.fn();
  const adapter = new BrowserConnections(new Set([origin, "https://floe.example"]), revoke, passes, () => now);
  const issue = (exactOrigin: string) => passes.issue({ identity_id: "a", principal_id: "identity:a", workspace_id: "workspace:one",
    exact_origin: exactOrigin, source_grant_id: root.grant_id, operation_ids: ["actor.list"], expires_at: null,
    evidence: [{ kind: "test", ref: "approve" }] });
  return { adapter, passes, grants, sessions, root, issue, advance: (ms: number) => { now += ms; } };
}

describe("browser connection transport", () => {
  it("renews local workspace authority on use without another pairing request", () => {
    let now = Date.now();
    const revoke = vi.fn();
    let issued = 0;
    const issueSession = vi.fn((workspaceId = "workspace:one") => ({
      bearer_token: `private-${++issued}`, authority_session_id: `session:${issued}`,
      principal_id: "principal:one", workspace_id: workspaceId, expires_at: new Date(now + 3_600_000).toISOString(),
    }));
    const { passes } = fixture();
    const adapter = new BrowserConnections(new Set([origin]), revoke, passes, () => now, { origins: new Set([origin]), issueSession });
    const req = { ip: "127.0.0.1", headers: { origin, host: "localhost:5379", cookie: "" } };
    req.headers.cookie = cookieHeader(adapter.connectLocal(req));
    const first = adapter.session(req)!;
    expect(adapter.session(req)).toEqual(first);
    now += 3_600_001;
    expect(adapter.session(req)?.authority_session_id).not.toBe(first.authority_session_id);
    expect(revoke).toHaveBeenCalledWith(first.authority_session_id);
    expect(adapter.list()).toEqual([]);
    expect(issueSession).toHaveBeenCalledTimes(2);
    expect(adapter.mode(req)).toBe("local");
  });

  it("needs a person's approval and the requesting browser's cookie; the code grants nothing", () => {
    const { adapter, issue } = fixture();
    const started = adapter.start(request());
    const pending = cookieHeader(started.cookie!);
    expect(started.cookie).toContain("HttpOnly; SameSite=Strict");
    expect(() => adapter.claim(request(pending))).toThrow("Allow this connection");
    adapter.approve(started.connection.connection_id, issue);
    expect(() => adapter.claim(request(`floe_browser_pending=${started.connection.code}`))).toThrow();
    const claimed = adapter.claim(request(pending));
    const session = adapter.session(request(passCookie(claimed)))!;
    expect(session).toMatchObject({ principal_id: "identity:a", workspace_id: "workspace:one" });
    expect(JSON.stringify(started.connection)).not.toContain("bearer");
    expect(claimed.join(";")).not.toContain(session.bearer_token);
    // The pending secret is spent by the claim.
    expect(() => adapter.claim(request(pending))).toThrow("Start a new connection");
  });

  it("pairs an unlisted loopback origin and binds the pass to exactly that origin", () => {
    const { adapter, issue } = fixture();
    const starMap = "http://127.0.0.1:43127";
    expect(() => adapter.start(request("", "https://attacker.example"))).toThrow();
    expect(() => adapter.start(request("", "http://192.168.1.4:43127"))).toThrow();
    expect(() => adapter.start(request("", "null"))).toThrow();
    expect(adapter.corsAllows(starMap, "/v1/browser/connections")).toBe(true);
    expect(adapter.corsAllows(starMap, "/v1/workspaces/workspace%3Aone/operations")).toBe(false);
    const started = adapter.start(request("", starMap));
    adapter.approve(started.connection.connection_id, issue);
    const cookie = passCookie(adapter.claim(request(cookieHeader(started.cookie!), starMap)));
    expect(adapter.corsAllows(starMap, "/v1/workspaces/workspace%3Aone/operations")).toBe(true);
    expect(adapter.session(request(cookie, starMap))?.workspace_id).toBe("workspace:one");
    // An origin with no pass of its own is refused outright; a trusted one just finds no pass.
    expect(() => adapter.session(request(cookie, "http://127.0.0.1:43128"))).toThrow("not allowed");
    expect(adapter.session(request(cookie, origin))).toBeNull();
    expect(adapter.session(request(cookie, starMap), "workspace:two")).toBeNull();
    expect(adapter.session(request(`${cookie}; ${cookie}`, starMap))).toBeNull();
    expect(() => adapter.session({ headers: { cookie } })).toThrow();
  });

  it("renews the short session and rotates the cookie without a new approval", () => {
    const { adapter, issue, advance, passes } = fixture();
    const started = adapter.start(request());
    adapter.approve(started.connection.connection_id, issue);
    const cookie = passCookie(adapter.claim(request(cookieHeader(started.cookie!))));
    const first = adapter.resolve(request(cookie), undefined, true)!;
    expect(first.cookie).toBeNull();
    advance(15 * 60_000 + 1);
    const second = adapter.resolve(request(cookie), undefined, true)!;
    expect(second.session.authority_session_id).not.toBe(first.session.authority_session_id);
    advance(86_400_000);
    const renewed = adapter.resolve(request(cookie), undefined, true)!;
    expect(renewed.cookie).toMatch(/^floe_browser_pass=[A-Za-z0-9_-]{43}; .*Max-Age=2592000/);
    const next = cookieHeader(renewed.cookie!);
    expect(next).not.toBe(cookie);
    // A request already in flight with the old cookie still lands, briefly.
    expect(adapter.session(request(cookie))).not.toBeNull();
    advance(60_001);
    expect(adapter.session(request(cookie))).toBeNull();
    expect(adapter.session(request(next))).not.toBeNull();
    expect(passes.list("identity:a", "workspace:one")).toHaveLength(1);
  });

  it("ends the pass when its person's authority ends, and on disconnect", () => {
    const { adapter, issue, grants, root, passes } = fixture();
    const connect = () => {
      const started = adapter.start(request());
      adapter.approve(started.connection.connection_id, issue);
      return passCookie(adapter.claim(request(cookieHeader(started.cookie!))));
    };
    const first = connect();
    adapter.disconnect(request(first));
    expect(adapter.session(request(first))).toBeNull();
    expect(passes.list("identity:a", "workspace:one")[0]).toMatchObject({ status: "revoked", revocation_reason: "disconnected" });
    const second = connect();
    expect(adapter.session(request(second))).not.toBeNull();
    grants.revokeGrant(root.grant_id);
    expect(adapter.session(request(second))).toBeNull();
    expect(passes.list("identity:a", "workspace:one").every(pass => pass.status === "revoked")).toBe(true);
  });

  it("refuses to approve twice, expires pending requests, and ends unclaimed passes", () => {
    const { adapter, issue, passes, advance } = fixture();
    const started = adapter.start(request());
    adapter.approve(started.connection.connection_id, issue);
    expect(() => adapter.approve(started.connection.connection_id, issue)).toThrow("already been approved");
    for (let i = 1; i < 32; i++) adapter.start(request());
    expect(() => adapter.start(request())).toThrow("too many");
    advance(300_001);
    expect(adapter.list()).toEqual([]);
    expect(passes.list("identity:a", "workspace:one")[0]).toMatchObject({ status: "revoked", revocation_reason: "never_claimed" });
    expect(adapter.start(request()).connection.code).toHaveLength(8);
  });

  it("refuses a pass wider than the person's authority, and marks HTTPS cookies Secure", () => {
    const { adapter, passes, root } = fixture();
    const secure = "https://floe.example";
    const started = adapter.start(request("", secure));
    expect(started.cookie).toContain("; Secure");
    expect(() => adapter.approve(started.connection.connection_id, (exact) => passes.issue({ identity_id: "a",
      principal_id: "identity:a", workspace_id: "workspace:one", exact_origin: exact, source_grant_id: root.grant_id,
      operation_ids: ["workspace.delete"], expires_at: null, evidence: [{ kind: "test", ref: "wide" }] }))).toThrow("subset");
  });
});
