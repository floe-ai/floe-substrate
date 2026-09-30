/** Shared by the identity tests. */
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { verifyEvent } from "nostr-tools/pure";

export const FAST_SCRYPT = { N: 2 ** 10, r: 8, p: 1 };

/** A v1 identity file as the console wrote it. */
export function legacyConsoleFile(plaintext: Buffer, npub: string, passphrase: string, protection?: "passphrase" | "device") {
  const salt = randomBytes(16);
  const key = scryptSync(protection === "device" ? "" : passphrase, salt, 32, { ...FAST_SCRYPT, maxmem: 64 * 1024 * 1024 });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    npub,
    created_at: "2026-09-16T00:00:00.000Z",
    ...(protection ? { protection } : {}),
    kdf: { name: "scrypt", ...FAST_SCRYPT, salt: salt.toString("base64") },
    cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") },
  };
}



/**
 * An in-memory Bus answering the identity routes the agent uses, faithful to
 * their status codes (floe-bus/src/server.ts). Signatures are really verified.
 */
export class FakeBus {
  identities = new Map<string, { identity_id: string; pubkey_hex: string; display_name: string; revoked_at: string | null; workspaces: Array<{ workspace_id: string; name: string }> }>();
  revokedSessions: string[] = [];
  authentications = 0;
  private counter = 0;
  constructor(private readonly now: () => number = () => Date.now(), readonly hostToken = "host-token") {}

  admit(pubkey: string, display_name: string, workspace: { workspace_id: string; name: string }) {
    let identity = [...this.identities.values()].find((entry) => entry.pubkey_hex === pubkey && !entry.revoked_at);
    if (!identity) {
      identity = { identity_id: `identity:${++this.counter}`, pubkey_hex: pubkey, display_name, revoked_at: null, workspaces: [] };
      this.identities.set(identity.identity_id, identity);
    }
    if (!identity.workspaces.some((w) => w.workspace_id === workspace.workspace_id)) identity.workspaces.push(workspace);
    return identity;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    const host = () => (init?.headers as Record<string, string> | undefined)?.authorization === `Bearer ${this.hostToken}`;
    const signer = () => {
      const event = body.auth_event;
      if (!event || !verifyEvent(event) || event.kind !== 22242) return null;
      return event.pubkey as string;
    };
    if (url.pathname === "/v1/identity/challenge") return json(200, { challenge: `challenge-${++this.counter}`, relay: "ws://fake-bus" });
    if (url.pathname === "/v1/identity/authenticate") {
      const pubkey = signer();
      const identity = [...this.identities.values()].find((entry) => entry.pubkey_hex === pubkey && !entry.revoked_at);
      if (!identity || identity.workspaces.length === 0) return json(401, { error: "not_admitted" });
      const base = { identity: { identity_id: identity.identity_id, display_name: identity.display_name }, workspaces: identity.workspaces };
      let workspaceId = body.workspace_id as string | undefined;
      if (workspaceId && !identity.workspaces.some((w) => w.workspace_id === workspaceId)) return json(403, { error: "not_admitted_to_workspace", ...base });
      if (!workspaceId && identity.workspaces.length > 1) return json(200, base);
      workspaceId ??= identity.workspaces[0]!.workspace_id;
      this.authentications += 1;
      return json(200, {
        ...base,
        bearer_token: `bearer-${++this.counter}`,
        authority_session_id: `authority-session-${this.counter}`,
        workspace_id: workspaceId,
        expires_at: new Date(this.now() + 3_600_000).toISOString(),
      });
    }
    if (url.pathname === "/v1/identity/register-workspace") {
      const pubkey = signer();
      if (!pubkey) return json(401, { error: "invalid_auth_event" });
      const workspace = { workspace_id: `workspace:${body.locator}`, name: String(body.locator).split(/[\\/]/).pop()!, folder_path: String(body.locator) };
      this.admit(pubkey, body.display_name, workspace);
      return json(201, { workspace_id: workspace.workspace_id });
    }
    if (url.pathname === "/v1/identity/workspace-for-folder") {
      const pubkey = signer();
      if (!pubkey) return json(401, { error: "invalid_auth_event" });
      const found = [...this.identities.values()].flatMap((entry) => entry.workspaces).find((w) => w.workspace_id === `workspace:${body.locator}`);
      if (!found) return json(200, { workspace: null, joined: false });
      const joined = [...this.identities.values()].some((entry) => entry.pubkey_hex === pubkey && !entry.revoked_at && entry.workspaces.includes(found));
      return json(200, { workspace: found, joined });
    }
    if (!host()) return json(401, { error: "unauthorized" });
    if (url.pathname === "/v1/clients" && method === "GET") return json(200, { clients: [...this.identities.values()] });
    if (url.pathname === "/v1/identities" && method === "POST") {
      const identity = [...this.identities.values()].flatMap((entry) => entry.workspaces).find((w) => w.workspace_id === body.workspace_id);
      if (!identity) return json(404, { error: "workspace_not_found" });
      this.admit(body.pubkey, body.display_name, identity);
      return json(201, {});
    }
    const session = /^\/v1\/clients\/([^/]+)\/sessions\/([^/]+)$/.exec(url.pathname);
    if (session && method === "DELETE") {
      this.revokedSessions.push(decodeURIComponent(session[2]!));
      return json(200, { revoked: true });
    }
    const client = /^\/v1\/clients\/([^/]+)$/.exec(url.pathname);
    if (client && method === "DELETE") {
      const identity = this.identities.get(decodeURIComponent(client[1]!));
      if (!identity) return json(404, { error: "identity_not_found" });
      identity.revoked_at = new Date(this.now()).toISOString();
      return json(200, {});
    }
    return json(404, { error: "not_found" });
  };
}

/** Timers the test fires by hand, so nothing waits on the clock. */
export class ManualTimers {
  private next = 1;
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  set = (fn: () => void, ms: number) => {
    const id = this.next++;
    this.pending.set(id, { fn, ms });
    return id;
  };
  clear = (id: unknown) => { this.pending.delete(id as number); };
  fireAll(): void {
    const due = [...this.pending.entries()];
    this.pending.clear();
    for (const [, timer] of due) timer.fn();
  }
  delays(): number[] {
    return [...this.pending.values()].map((timer) => timer.ms);
  }
}