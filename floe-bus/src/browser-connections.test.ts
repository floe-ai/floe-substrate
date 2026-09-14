import { describe, expect, it, vi } from "vitest";
import { BrowserConnections, type BrowserWorkspaceSession } from "./browser-connections.js";

const origin = "http://localhost:5379";
const request = (cookie = "", requestOrigin = origin) => ({ headers: { origin: requestOrigin, cookie } });
const cookieHeader = (cookie: string) => cookie.split(";", 1)[0]!;

function fixture() {
  let now = Date.now();
  const revoke = vi.fn();
  const adapter = new BrowserConnections(new Set([origin, "https://floe.example"]), revoke, () => now);
  const session: BrowserWorkspaceSession = { bearer_token: "private-bearer", authority_session_id: "session:one", principal_id: "principal:one", workspace_id: "workspace:one", expires_at: new Date(now + 3_600_000).toISOString() };
  return { adapter, session, revoke, advance: (ms: number) => { now += ms; } };
}

describe("browser connection transport", () => {
  it("renews local workspace authority on use without another pairing request", () => {
    let now = Date.now();
    const revoke = vi.fn();
    let issued = 0;
    const issue = vi.fn((workspaceId = "workspace:one") => ({
      bearer_token: `private-${++issued}`, authority_session_id: `session:${issued}`,
      principal_id: "principal:one", workspace_id: workspaceId, expires_at: new Date(now + 3_600_000).toISOString(),
    }));
    const adapter = new BrowserConnections(new Set([origin]), revoke, () => now, { origins: new Set([origin]), issueSession: issue });
    const req = { ip: "127.0.0.1", headers: { origin, host: "localhost:5379", cookie: "" } };
    req.headers.cookie = cookieHeader(adapter.connectLocal(req));
    const first = adapter.session(req)!;
    expect(adapter.session(req)).toEqual(first);
    now += 3_600_001;
    expect(adapter.session(req)?.authority_session_id).not.toBe(first.authority_session_id);
    expect(revoke).toHaveBeenCalledWith(first.authority_session_id);
    expect(adapter.list()).toEqual([]);
    expect(issue).toHaveBeenCalledTimes(2);
    expect(adapter.mode(req)).toBe("local");
  });

  it("requires native approval and the requesting browser cookie; the code grants no access", () => {
    const { adapter, session } = fixture();
    const started = adapter.start(request());
    const pending = cookieHeader(started.cookie!);
    expect(started.cookie).toContain("HttpOnly; SameSite=Strict");
    expect(() => adapter.claim(request(pending))).toThrow("Allow this connection");
    adapter.approve(started.connection.code, () => session);
    expect(() => adapter.claim(request(`floe_browser_pending=${started.connection.code}`))).toThrow();
    const claimed = adapter.claim(request(pending));
    expect(adapter.session(request(cookieHeader(claimed)))).toEqual(session);
    expect(JSON.stringify(started.connection)).not.toContain("bearer");
    expect(claimed).not.toContain(session.bearer_token);
  });

  it("refuses another origin, including an otherwise allowed origin, and ambiguous cookies", () => {
    const { adapter, session } = fixture();
    expect(() => adapter.start(request("", "https://attacker.example"))).toThrow();
    const started = adapter.start(request());
    const pending = cookieHeader(started.cookie!);
    adapter.approve(started.connection.code, () => session);
    expect(() => adapter.claim(request(pending, "https://floe.example"))).toThrow();
    const cookie = cookieHeader(adapter.claim(request(pending)));
    expect(adapter.session(request(cookie, "https://floe.example"))).toBeNull();
    expect(adapter.session(request(`${cookie}; ${cookie}`))).toBeNull();
    expect(() => adapter.session({ headers: { cookie } })).toThrow();
  });

  it("retains the exact claim after a lost response, then revokes it on disconnect", () => {
    const { adapter, session, revoke } = fixture();
    const started = adapter.start(request());
    const pending = cookieHeader(started.cookie!);
    adapter.approve(started.connection.code, () => session);
    const first = adapter.claim(request(pending));
    expect(adapter.claim(request(pending))).toBe(first);
    expect(() => adapter.approve(started.connection.code, () => session)).toThrow("already been approved");
    adapter.disconnect(request(`${pending}; ${cookieHeader(first)}`));
    expect(revoke).toHaveBeenCalledWith(session.authority_session_id);
    expect(adapter.session(request(cookieHeader(first)))).toBeNull();
    expect(() => adapter.claim(request(pending))).toThrow();
  });

  it("expires pending requests, bounds memory, and revokes unused approved sessions", () => {
    const { adapter, session, revoke, advance } = fixture();
    const started = adapter.start(request());
    adapter.approve(started.connection.code, () => session);
    for (let i = 1; i < 32; i++) adapter.start(request());
    expect(() => adapter.start(request())).toThrow("too many");
    advance(300_001);
    expect(adapter.list()).toEqual([]);
    expect(revoke).toHaveBeenCalledWith(session.authority_session_id);
    expect(adapter.start(request()).connection.code).toHaveLength(8);
  });

  it("expires active sessions and marks HTTPS cookies Secure", () => {
    const { adapter, session, revoke, advance } = fixture();
    const secureRequest = request("", "https://floe.example");
    const started = adapter.start(secureRequest);
    expect(started.cookie).toContain("; Secure");
    adapter.approve(started.connection.code, () => session);
    const cookie = cookieHeader(adapter.claim(request(cookieHeader(started.cookie!), "https://floe.example")));
    advance(3_600_001);
    expect(adapter.session(request(cookie, "https://floe.example"))).toBeNull();
    expect(revoke).toHaveBeenCalledWith(session.authority_session_id);
  });
});
