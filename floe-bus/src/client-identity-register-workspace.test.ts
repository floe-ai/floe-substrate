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
  let bridgeToken: string;
  const BRIDGE_ID = "bridge:register-join-test";

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "floe-register-join-"));
    const cfgPath = join(root, "config.yaml");
    const cfg: LocalConfig = defaultConfig(root);
    writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
    // Short materialisation bound: these in-process tests have no real bridge,
    // so the register-and-join call reaches its honest "pending" quickly unless
    // a simulated bridge report is driven in.
    handle = await createBusServer(cfgPath, cfg, {
      host_control_token: HOST_TOKEN,
      workspace_materialization_timeout_ms: 300,
    });
    await handle.app.ready();
    // A simulated bridge: real bridge-service credential + registration, so the
    // attachment-result route accepts the reports that stand in for on-disk
    // materialisation the out-of-process bridge would perform.
    bridgeToken = handle.issueBridgeServiceCredential(BRIDGE_ID).bearer_token;
    const registered = await handle.app.inject({
      method: "POST",
      url: "/v1/bridges/register",
      headers: bearerHeader(bridgeToken),
      payload: { capabilities: {} },
    });
    expect(registered.statusCode).toBe(201);
  });

  afterAll(async () => {
    try { await handle.app.close(); } catch { /* ignore */ }
  });

  /**
   * Stand in for the out-of-process bridge reporting what it found when it tried
   * to materialise the folder's on-disk `.floe`. Correlates on the current
   * (workspace, binding) exactly as the real bridge does.
   */
  async function reportBridgeAttachment(workspaceId: string, status: string) {
    const binding = handle.store.workspaceIdentityStore.getCurrentBinding(workspaceId, handle.store.localHostId);
    return handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/attachment-result`,
      headers: bearerHeader(bridgeToken),
      payload: { bridge_id: BRIDGE_ID, binding_id: binding?.binding_id, status },
    });
  }

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

  it("a fresh key registers a folder, is admitted, and can immediately act (materialisation pending)", async () => {
    const secretKey = privateKeyFromSeedWords(generateSeedWords());
    const locator = mkdtempSync(join(tmpdir(), "floe-ws-fresh-"));

    // No mint here: register-and-join returns only workspace_id + identity echo.
    // With no bridge to confirm on-disk materialisation, the honest answer is
    // 202 "pending" — not a 201 that claims a ready folder. Admission is still
    // durable, which is what the rest of this test proves.
    const registered = await registerAndJoin(secretKey, { locator, display_name: "Jamie" });
    expect(registered.statusCode).toBe(202);
    const body = registered.json();
    expect(body.materialization.status).toBe("pending");
    const workspaceId = body.workspace_id as string;
    expect(workspaceId).toBeTruthy();
    expect(body.bearer_token).toBeUndefined();
    expect(body.expires_at).toBeUndefined();
    expect(body.workspaces).toBeUndefined();
    expect(body.identity.display_name).toBe("Jamie");
    expect(body.identity.pubkey_hex).toBe(getPublicKey(secretKey));
    expect(body.identity.npub).toMatch(/^npub1/);

    // Admission is durable before the response even while materialisation is
    // pending: an immediate authenticate must succeed and, with exactly one
    // membership, mint without a selection step.
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
    expect(first.statusCode).toBe(202);
    const workspaceId = first.json().workspace_id as string;

    // A different fresh key register-and-joins the SAME locator: the existing
    // identity is reused (import), not a second workspace, and B is admitted.
    const keyB = privateKeyFromSeedWords(generateSeedWords());
    const second = await registerAndJoin(keyB, { locator, display_name: "Joiner B" });
    expect(second.statusCode).toBe(202);
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
    expect(first.statusCode).toBe(202);
    const workspaceId = first.json().workspace_id as string;

    const again = await registerAndJoin(secretKey, { locator, display_name: "Rerun" });
    expect(again.statusCode).toBe(202);
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

    // With create_directory it succeeds (materialisation pending: no bridge).
    const created = await registerAndJoin(secretKey, {
      locator: missing,
      display_name: "Nope",
      create_directory: true,
    });
    expect(created.statusCode).toBe(202);
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
    expect(first.statusCode).toBe(202);
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

  // --- Materialisation outcomes -------------------------------------------
  // Choosing a folder is the first thing a person does at first run, so the
  // on-disk `.floe` must actually be ready when we answer. That materialisation
  // is done by the bridge in a separate process; the route awaits its report
  // rather than trusting the register broadcast was emitted. Three honest,
  // distinct outcomes — never a 201 that claims a folder is ready when it is not.

  it("resolves ready when the bridge reports attached while the call waits", async () => {
    // The true cross-process rendezvous: register with no report yet, start
    // awaiting, then the bridge reports attached — the waiter resolves without
    // polling. Driven at the store to keep the concurrency deterministic.
    const locator = mkdtempSync(join(tmpdir(), "floe-ws-live-"));
    const workspace = handle.store.workspaceOperationBackend.register({ locator, init_authorized: true });
    const binding = handle.store.workspaceIdentityStore.getCurrentBinding(
      workspace.workspace_id, handle.store.localHostId,
    );

    const awaited = handle.store.awaitWorkspaceMaterialization(workspace.workspace_id, { timeout_ms: 2_000 });
    handle.store.reportAttachment({
      workspace_id: workspace.workspace_id,
      binding_id: binding!.binding_id,
      bridge_id: BRIDGE_ID,
      status: "attached",
      config_hash: null,
      error_code: null,
    }, handle.broadcast);

    const result = await awaited;
    expect(result.outcome).toBe("ready");
  });

  it("returns 201 ready once the folder is materialised (durable re-run)", async () => {
    const secretKey = privateKeyFromSeedWords(generateSeedWords());
    const locator = mkdtempSync(join(tmpdir(), "floe-ws-ready-"));

    // First run with no bridge report: pending.
    const pending = await registerAndJoin(secretKey, { locator, display_name: "Ready" });
    expect(pending.statusCode).toBe(202);
    const workspaceId = pending.json().workspace_id as string;

    // The bridge materialises the folder and reports attached.
    const report = await reportBridgeAttachment(workspaceId, "attached");
    expect(report.statusCode).toBe(200);

    // Re-running first run now reads the durable terminal status (the bridge
    // dedupes and will not re-report) and answers 201 ready immediately.
    const ready = await registerAndJoin(secretKey, { locator, display_name: "Ready" });
    expect(ready.statusCode).toBe(201);
    expect(ready.json().materialization.status).toBe("ready");
    expect(ready.json().workspace_id).toBe(workspaceId);
  });

  it("surfaces an unreadable folder as a distinct 422, not a wait", async () => {
    const secretKey = privateKeyFromSeedWords(generateSeedWords());
    const locator = mkdtempSync(join(tmpdir(), "floe-ws-inacc-"));

    const pending = await registerAndJoin(secretKey, { locator, display_name: "Inacc" });
    expect(pending.statusCode).toBe(202);
    const workspaceId = pending.json().workspace_id as string;

    const report = await reportBridgeAttachment(workspaceId, "workspace_inaccessible");
    expect(report.statusCode).toBe(200);

    const failed = await registerAndJoin(secretKey, { locator, display_name: "Inacc" });
    expect(failed.statusCode).toBe(422);
    expect(failed.json().materialization).toMatchObject({ status: "failed", reason: "workspace_inaccessible" });
  });

  it("surfaces invalid config as a distinct 422, told apart from an unreadable folder", async () => {
    const secretKey = privateKeyFromSeedWords(generateSeedWords());
    const locator = mkdtempSync(join(tmpdir(), "floe-ws-badcfg-"));

    const pending = await registerAndJoin(secretKey, { locator, display_name: "BadCfg" });
    expect(pending.statusCode).toBe(202);
    const workspaceId = pending.json().workspace_id as string;

    const report = await reportBridgeAttachment(workspaceId, "config_invalid");
    expect(report.statusCode).toBe(200);

    const failed = await registerAndJoin(secretKey, { locator, display_name: "BadCfg" });
    expect(failed.statusCode).toBe(422);
    expect(failed.json().materialization).toMatchObject({ status: "failed", reason: "config_invalid" });
  });
});
