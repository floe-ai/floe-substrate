import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { generateSeedWords, privateKeyFromSeedWords } from "nostr-tools/nip06";

import { createBusServer } from "./server.js";
import { defaultConfig, type LocalConfig } from "./config.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

const HOST_TOKEN = "h".repeat(48);
// Assembled so the literal auth scheme + token never appears in source (avoids
// static credential-redaction mangling the file).
const hostAuth = { authorization: ["Be", "arer", " ", HOST_TOKEN].join("") };

function signAuthEvent(secretKey: Uint8Array, relay: string, challenge: string) {
  return finalizeEvent(
    {
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["relay", relay], ["challenge", challenge]],
      content: "",
    },
    secretKey,
  );
}

describe("Client identity credential path (ADR-0015)", () => {
  let handle: ServerHandle;
  let workspaceId: string;
  const secretKey = privateKeyFromSeedWords(generateSeedWords());
  const pubkeyHex = getPublicKey(secretKey);

  beforeAll(async () => {
    const tmp = mkdtempSync(join(tmpdir(), "floe-identity-"));
    const cfgPath = join(tmp, "config.yaml");
    const cfg: LocalConfig = defaultConfig(tmp);
    writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
    handle = await createBusServer(cfgPath, cfg, { host_control_token: HOST_TOKEN });
    await handle.app.ready();
    workspaceId = (handle.store.registerWorkspace(
      { locator: tmp, name: "Identity proof" },
      handle.broadcast,
    ) as { workspace_id: string }).workspace_id;
  });

  afterAll(async () => {
    try { await handle.app.close(); } catch { /* ignore */ }
  });

  async function admit(): Promise<string> {
    const response = await handle.app.inject({
      method: "POST",
      url: "/v1/identities",
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
      payload: { display_name: "Jamie", pubkey: pubkeyHex, workspace_id: workspaceId },
    });
    expect(response.statusCode).toBe(201);
    return response.json().identity.identity_id as string;
  }

  async function authenticate(): Promise<{ status: number; bearer?: string }> {
    const challengeResponse = await handle.app.inject({
      method: "GET",
      url: `/v1/identity/challenge?workspace_id=${workspaceId}`,
    });
    expect(challengeResponse.statusCode).toBe(200);
    const { challenge, relay } = challengeResponse.json();
    const authResponse = await handle.app.inject({
      method: "POST",
      url: "/v1/identity/authenticate",
      payload: { workspace_id: workspaceId, auth_event: signAuthEvent(secretKey, relay, challenge) },
    });
    return { status: authResponse.statusCode, bearer: authResponse.json()?.bearer_token };
  }

  it("mints a workspace_operation bearer from an admitted key, with no host_control", async () => {
    await admit();
    const authenticated = await authenticate();
    expect(authenticated.status).toBe(200);
    expect(authenticated.bearer).toBeTruthy();

    // The bearer works on a workspace_operation route with no host authority.
    const pending = await handle.app.inject({
      method: "GET",
      url: `/v1/pending-responses?workspace_id=${workspaceId}`,
      headers: { authorization: `Bearer ${authenticated.bearer}` },
    });
    expect(pending.statusCode).toBe(200);
  });

  it("rejects a replayed challenge (single-use)", async () => {
    const challengeResponse = await handle.app.inject({
      method: "GET",
      url: `/v1/identity/challenge?workspace_id=${workspaceId}`,
    });
    const { challenge, relay } = challengeResponse.json();
    const event = signAuthEvent(secretKey, relay, challenge);
    const first = await handle.app.inject({
      method: "POST", url: "/v1/identity/authenticate",
      payload: { workspace_id: workspaceId, auth_event: event },
    });
    expect(first.statusCode).toBe(200);
    const replay = await handle.app.inject({
      method: "POST", url: "/v1/identity/authenticate",
      payload: { workspace_id: workspaceId, auth_event: event },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("rejects a forged signature", async () => {
    const challengeResponse = await handle.app.inject({
      method: "GET",
      url: `/v1/identity/challenge?workspace_id=${workspaceId}`,
    });
    const { challenge, relay } = challengeResponse.json();
    const forged = signAuthEvent(privateKeyFromSeedWords(generateSeedWords()), relay, challenge);
    // Claim the admitted pubkey but sign with a different key.
    forged.pubkey = pubkeyHex;
    const response = await handle.app.inject({
      method: "POST", url: "/v1/identity/authenticate",
      payload: { workspace_id: workspaceId, auth_event: forged },
    });
    expect(response.statusCode).toBe(401);
  });

  it("revocation kills a live bearer and blocks re-authentication", async () => {
    const identityId = await admit();
    const authenticated = await authenticate();
    expect(authenticated.status).toBe(200);

    const bearerWorks = await handle.app.inject({
      method: "GET",
      url: `/v1/pending-responses?workspace_id=${workspaceId}`,
      headers: { authorization: `Bearer ${authenticated.bearer}` },
    });
    expect(bearerWorks.statusCode).toBe(200);

    const revoke = await handle.app.inject({
      method: "DELETE",
      url: `/v1/clients/${identityId}`,
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
    });
    expect(revoke.statusCode).toBe(200);

    // The live bearer is now dead.
    const bearerDead = await handle.app.inject({
      method: "GET",
      url: `/v1/pending-responses?workspace_id=${workspaceId}`,
      headers: { authorization: `Bearer ${authenticated.bearer}` },
    });
    expect(bearerDead.statusCode).toBe(401);

    // A revoked pubkey cannot re-authenticate.
    const reauth = await authenticate();
    expect(reauth.status).toBe(401);
  });

  it("reports admitted workspaces and requires selection when there is more than one (ADR-0015 F3)", async () => {
    // A fresh identity admitted to two workspaces.
    const sk2 = privateKeyFromSeedWords(generateSeedWords());
    const pk2 = getPublicKey(sk2);
    const wsB = (handle.store.registerWorkspace(
      { locator: join(tmpdir(), "floe-identity-workspace-b"), name: "Second workspace" },
      handle.broadcast,
    ) as { workspace_id: string }).workspace_id;
    for (const ws of [workspaceId, wsB]) {
      const admitted = await handle.app.inject({
        method: "POST", url: "/v1/identities",
        headers: hostAuth,
        payload: { display_name: "Multi", pubkey: pk2, workspace_id: ws },
      });
      expect(admitted.statusCode).toBe(201);
    }

    // Authenticate with no workspace_id: the substrate reports both workspaces
    // and declines to mint until the client chooses.
    const ch1 = await handle.app.inject({ method: "GET", url: "/v1/identity/challenge" });
    const undirected = await handle.app.inject({
      method: "POST", url: "/v1/identity/authenticate",
      payload: { auth_event: signAuthEvent(sk2, ch1.json().relay, ch1.json().challenge) },
    });
    expect(undirected.statusCode).toBe(200);
    expect(undirected.json().bearer_token).toBeNull();
    expect(undirected.json().workspace_selection_required).toBe(true);
    expect(new Set((undirected.json().workspaces as Array<{ workspace_id: string }>).map((w) => w.workspace_id)))
      .toEqual(new Set([workspaceId, wsB]));

    // Authenticate naming one of them: a bearer scoped to that workspace.
    const ch2 = await handle.app.inject({ method: "GET", url: "/v1/identity/challenge" });
    const directed = await handle.app.inject({
      method: "POST", url: "/v1/identity/authenticate",
      payload: { workspace_id: wsB, auth_event: signAuthEvent(sk2, ch2.json().relay, ch2.json().challenge) },
    });
    expect(directed.statusCode).toBe(200);
    expect(directed.json().bearer_token).toBeTruthy();
    expect(directed.json().workspace_id).toBe(wsB);

    // Authenticate naming a workspace it was never admitted to: refused.
    const ch3 = await handle.app.inject({ method: "GET", url: "/v1/identity/challenge" });
    const foreign = await handle.app.inject({
      method: "POST", url: "/v1/identity/authenticate",
      payload: { workspace_id: "workspace_never", auth_event: signAuthEvent(sk2, ch3.json().relay, ch3.json().challenge) },
    });
    expect(foreign.statusCode).toBe(403);
  });
});
