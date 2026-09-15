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
      payload: { display_name: "Jamie", pubkey: pubkeyHex },
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
});
