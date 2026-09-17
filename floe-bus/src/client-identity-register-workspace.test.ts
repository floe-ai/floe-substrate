import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { generateSeedWords, privateKeyFromSeedWords } from "nostr-tools/nip06";

import { createBusServer } from "./server.js";
import { defaultConfig, type LocalConfig } from "./config.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

const HOST_TOKEN = "h".repeat(48);
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

// Assemble the auth scheme from parts so the literal token never appears in
// source (avoids static credential redaction mangling this file).
function bearerHeader(token: string) {
  return { authorization: ["Be", "arer", " ", token].join("") };
}

/**
 * The register-and-join gate (first run). A brand-new identity, admitted to
 * nothing, registers a folder and genuinely ends up able to act in it — proven
 * through the real challenge/authenticate/act routes with a real minted bearer,
 * never by planting a roster row.
 */
describe("Register-and-join first run (ADR-0015)", () => {
  let handle: ServerHandle;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "floe-register-join-"));
    const cfgPath = join(root, "config.yaml");
    const cfg: LocalConfig = defaultConfig(root);
    writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
    handle = await createBusServer(cfgPath, cfg, { host_control_token: HOST_TOKEN });
    await handle.app.ready();
  });

  afterAll(async () => {
    try { await handle.app.close(); } catch { /* ignore */ }
  });

  async function proveKey(secretKey: Uint8Array) {
    const ch = await handle.app.inject({ method: "GET", url: "/v1/identity/challenge" });
    expect(ch.statusCode).toBe(200);
    const { challenge, relay } = ch.json();
    return signAuthEvent(secretKey, relay, challenge);
  }

  async function registerAndJoin(
    secretKey: Uint8Array,
    payload: Record<string, unknown>,
  ) {
    return handle.app.inject({
      method: "POST",
      url: "/v1/identity/register-workspace",
      payload: { auth_event: await proveKey(secretKey), ...payload },
    });
  }

  async function authenticate(secretKey: Uint8Array) {
    const ch = await handle.app.inject({ method: "GET", url: "/v1/identity/challenge" });
    const { challenge, relay } = ch.json();
    return handle.app.inject({
      method: "POST",
      url: "/v1/identity/authenticate",
      payload: { auth_event: signAuthEvent(secretKey, relay, challenge) },
    });
  }

  it("a fresh key registers a folder, is admitted, and can immediately act", async () => {
    const secretKey = privateKeyFromSeedWords(generateSeedWords());
    const locator = mkdtempSync(join(tmpdir(), "floe-ws-fresh-"));

    // No mint here: register-and-join returns only workspace_id + identity echo.
    const registered = await registerAndJoin(secretKey, { locator, display_name: "Jamie" });
    expect(registered.statusCode).toBe(201);
    const body = registered.json();
    const workspaceId = body.workspace_id as string;
    expect(workspaceId).toBeTruthy();
    expect(body.bearer_token).toBeUndefined();
    expect(body.expires_at).toBeUndefined();
    expect(body.workspaces).toBeUndefined();
    expect(body.identity.display_name).toBe("Jamie");
    expect(body.identity.pubkey_hex).toBe(getPublicKey(secretKey));
    expect(body.identity.npub).toMatch(/^npub1/);

    // Admission is durable before the 201: an immediate authenticate must
    // succeed and, with exactly one membership, mint without a selection step.
    const authed = await authenticate(secretKey);
    expect(authed.statusCode).toBe(200);
    const bearer = authed.json().bearer_token as string;
    expect(bearer).toBeTruthy();
    expect(authed.json().workspace_id).toBe(workspaceId);
    expect(authed.json().workspace_selection_required).not.toBe(true);

    // The minted bearer genuinely acts on a workspace_operation route, with no
    // host authority — proof the key ended up able to act in the workspace.
    const acted = await handle.app.inject({
      method: "GET",
      url: `/v1/pending-responses?workspace_id=${workspaceId}`,
      headers: bearerHeader(bearer),
    });
    expect(acted.statusCode).toBe(200);
  });

  it("imports an already-registered folder rather than minting a new identity", async () => {
    // A folder that is already a project on disk, with content the bus must not
    // clobber (the on-disk .floe template belongs to the bridge, not the bus).
    const locator = mkdtempSync(join(tmpdir(), "floe-ws-existing-"));
    mkdirSync(join(locator, ".floe"), { recursive: true });
    const floeYaml = join(locator, ".floe", "floe.yaml");
    writeFileSync(floeYaml, "name: existing-project\nmarker: keep-me\n", "utf8");

    // First key establishes the workspace identity for this locator.
    const keyA = privateKeyFromSeedWords(generateSeedWords());
    const first = await registerAndJoin(keyA, { locator, display_name: "Owner A" });
    expect(first.statusCode).toBe(201);
    const workspaceId = first.json().workspace_id as string;

    // A different fresh key register-and-joins the SAME locator: the existing
    // identity is reused (import), not a second workspace, and B is admitted.
    const keyB = privateKeyFromSeedWords(generateSeedWords());
    const second = await registerAndJoin(keyB, { locator, display_name: "Joiner B" });
    expect(second.statusCode).toBe(201);
    expect(second.json().workspace_id).toBe(workspaceId);

    const authedB = await authenticate(keyB);
    expect(authedB.statusCode).toBe(200);
    expect(authedB.json().workspace_id).toBe(workspaceId);
    expect(authedB.json().bearer_token).toBeTruthy();

    // The bus imported the folder without rewriting the pre-existing project.
    expect(readFileSync(floeYaml, "utf8")).toContain("marker: keep-me");
  });

  it("re-running first run is idempotent: same key, same folder, same workspace", async () => {
    const secretKey = privateKeyFromSeedWords(generateSeedWords());
    const locator = mkdtempSync(join(tmpdir(), "floe-ws-idem-"));

    const first = await registerAndJoin(secretKey, { locator, display_name: "Rerun" });
    expect(first.statusCode).toBe(201);
    const workspaceId = first.json().workspace_id as string;

    const again = await registerAndJoin(secretKey, { locator, display_name: "Rerun" });
    expect(again.statusCode).toBe(201);
    expect(again.json().workspace_id).toBe(workspaceId);

    // Still admitted exactly once, to the same workspace.
    const authed = await authenticate(secretKey);
    expect(authed.statusCode).toBe(200);
    expect(authed.json().workspace_id).toBe(workspaceId);
    expect(authed.json().workspace_selection_required).not.toBe(true);
  });

  it("creates a missing folder only when create_directory is set", async () => {
    const secretKey = privateKeyFromSeedWords(generateSeedWords());
    const missing = join(tmpdir(), `floe-ws-absent-${Date.now()}`);

    // Missing folder without create_directory is a client error, not an auth
    // failure: 400, distinct from 401.
    const denied = await registerAndJoin(secretKey, { locator: missing, display_name: "Nope" });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error).toBe("workspace_directory_not_found");

    // With create_directory it succeeds.
    const created = await registerAndJoin(secretKey, {
      locator: missing,
      display_name: "Nope",
      create_directory: true,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().workspace_id).toBeTruthy();
  });

  it("rejects a relative locator as a client error, not an auth failure", async () => {
    const secretKey = privateKeyFromSeedWords(generateSeedWords());
    const response = await registerAndJoin(secretKey, {
      locator: "relative/not/absolute",
      display_name: "Rel",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("workspace_locator_invalid");
  });

  it("rejects a bad, replayed, or forged proof with 401", async () => {
    const secretKey = privateKeyFromSeedWords(generateSeedWords());
    const locator = mkdtempSync(join(tmpdir(), "floe-ws-proof-"));

    // Replay: consume a challenge with one call, reuse the same event.
    const ch = await handle.app.inject({ method: "GET", url: "/v1/identity/challenge" });
    const { challenge, relay } = ch.json();
    const event = signAuthEvent(secretKey, relay, challenge);
    const first = await handle.app.inject({
      method: "POST", url: "/v1/identity/register-workspace",
      payload: { auth_event: event, locator, display_name: "Once" },
    });
    expect(first.statusCode).toBe(201);
    const replay = await handle.app.inject({
      method: "POST", url: "/v1/identity/register-workspace",
      payload: { auth_event: event, locator, display_name: "Once" },
    });
    expect(replay.statusCode).toBe(401);

    // Forged: claim one pubkey but sign with another key over a live challenge.
    const ch2 = await handle.app.inject({ method: "GET", url: "/v1/identity/challenge" });
    const forged = signAuthEvent(privateKeyFromSeedWords(generateSeedWords()), ch2.json().relay, ch2.json().challenge);
    forged.pubkey = getPublicKey(secretKey);
    const forgedResponse = await handle.app.inject({
      method: "POST", url: "/v1/identity/register-workspace",
      payload: { auth_event: forged, locator, display_name: "Forged" },
    });
    expect(forgedResponse.statusCode).toBe(401);
  });

  it("keeps display_name required so every admitted key stays legible", async () => {
    const secretKey = privateKeyFromSeedWords(generateSeedWords());
    const locator = mkdtempSync(join(tmpdir(), "floe-ws-noname-"));
    const response = await handle.app.inject({
      method: "POST",
      url: "/v1/identity/register-workspace",
      payload: { auth_event: await proveKey(secretKey), locator },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("identity_register_request_invalid");
  });
});
