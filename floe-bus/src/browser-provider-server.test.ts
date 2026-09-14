import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "./config.js";
import { createBusServer } from "./server.js";
import type { ProviderLoginAdapter, ProviderStatus } from "./pi-provider-login.js";
import { providerAccountSecretRefId } from "./credential-operations.js";

const provider: ProviderStatus = { type: "provider_status", provider: "proof-provider", name: "Proof", auth_name: "Proof subscription", connected: false, profile_id: "proof-provider-subscription", models: [] };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
async function fixture(login: ProviderLoginAdapter["login"]) {
  const directory = mkdtempSync(join(tmpdir(), "floe-browser-provider-"));
  vi.stubEnv("LOCALAPPDATA", directory);
  const config = defaultConfig(directory);
  const path = join(directory, "config.yaml");
  writeFileSync(path, JSON.stringify(config));
  const handle = await createBusServer(path, config, {
    host_control_token: "test-provider-host-token-".repeat(3), local_browser_access: true,
    provider_login_adapter: { list: async () => [provider], login },
  });
  await handle.app.ready();
  cleanups.push(async () => { await handle.app.close(); rmSync(directory, { recursive: true, force: true }); });
  const connect = async () => {
    const headers = { origin: "http://localhost:5379", host: "localhost:5379", cookie: "" };
    const result = await handle.app.inject({ method: "POST", url: "/v1/browser/session/local", headers });
    expect(result.statusCode, result.body).toBe(200);
    headers.cookie = String(result.headers["set-cookie"]).split(";")[0]!;
    return headers;
  };
  return { ...handle, connect };
}

describe("browser provider connection through protected host operations", () => {
  it("requires the local connection and does not forward provider failure details", async () => {
    const login = vi.fn(async () => { throw new Error("provider-secret-in-error"); });
    const handle = await fixture(login);
    expect((await handle.app.inject({ url: "/v1/browser/providers" })).statusCode).toBe(403);
    const headers = await handle.connect();
    expect((await handle.app.inject({ url: "/v1/browser/providers", headers: { ...headers, "x-forwarded-for": "192.168.1.2" } })).statusCode).toBe(403);
    expect((await handle.app.inject({ url: "/v1/browser/providers", headers })).json().providers[0].connected).toBe(false);
    const result = await handle.app.inject({ method: "POST", url: "/v1/browser/providers/proof-provider/connect", headers });
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain("Sign-in did not complete");
    expect(result.body).not.toContain("provider-secret-in-error");
    expect(handle.store.secretRefStore.listSecretRefs()).toHaveLength(1);
    expect(handle.store.secretRefStore.listSecretRefs()[0]!.resolution).toBe("unresolved");
  });

  it.runIf(process.platform === "win32")("binds credentials through the canonical operation and returns only safe account status", async () => {
    const material = Buffer.from(JSON.stringify({ type: "oauth", access: "secret-access-proof", refresh: "secret-refresh-proof", expires: Date.now() + 3600000 }));
    const handle = await fixture(async (_provider, interaction, consume) => {
      interaction.notify({ type: "progress", message: "Connecting account" });
      await consume(material);
    });
    const { store } = handle;
    const workspaceId = "workspace:provider-runtime";
    const bridgeId = "bridge:provider-runtime";
    const now = new Date().toISOString();
    store.workspaceIdentityStore.restoreWorkspace({
      snapshot: { workspace_id: workspaceId, name: "Provider runtime proof", creation_kind: "legacy_retained", source_workspace_id: null, created_at: now, updated_at: now },
      binding: { host_id: store.localHostId, platform: "windows", locator: join(tmpdir(), "floe-provider-runtime-fixture"), init_authorized: true },
    });
    const bridge = handle.issueBridgeServiceCredential(bridgeId);
    store.secretRefStore.createSecretRef({ secret_ref_id: providerAccountSecretRefId(store.localHostId, provider.provider), owner: { kind: "host", host_id: store.localHostId }, resource: { kind: "provider_account", id: provider.provider }, secret_kind: "runtime_authentication", label: provider.name });
    const imported = await handle.app.inject({
      method: "POST", url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/import-config`,
      headers: { authorization: `Bearer ${bridge.bearer_token}` },
      payload: {
        schema: "floe.workspace-configuration-inventory.v1", importer_version: "1",
        binding_id: store.workspaceIdentityStore.getCurrentBinding(workspaceId, store.localHostId)!.binding_id,
        config_hash: `sha256:${"a".repeat(64)}`, source: { kind: "workspace_files", manifest_ref: ".floe/floe.yaml" },
        validation: { ok: true, issues: [] },
        actors: [{
          source_actor_id: "floe", source: { kind: "workspace_actor_file", path: "agents/floe.md", source_fingerprint: `sha256:${"b".repeat(64)}` },
          definition: { label: "Floe", charter: "Complete the test outcome.", responsibilities: [], instructions: "Use the assigned provider.", knowledge_refs: [], policy_refs: { budget: null, trust: null, approval: null }, escalation_rules: [] },
          runtime: { label: "Floe model", backing_kind: "model", adapter_id: "pi-agent-core", configuration: { provider: provider.provider, model: "proof-model" }, required_capability_ids: [], checkpoint_policy: { mode: "none", schema_ref: null }, resource_policy: {}, credential_requirement: "required", required_configuration_keys: ["model"], credential_reference: { source_kind: "provider_account", provider_id: provider.provider, secret_kind: "runtime_authentication" } },
        }],
      },
    });
    expect(imported.statusCode, imported.body).toBe(200);
    const actorId = imported.json().import_result.receipt.imported_actors[0].actor_id as string;
    expect(store.runtimeProfileStore.getCurrentActorBinding(actorId)?.unresolved_reasons).toEqual(["runtime_credential_unresolved"]);
    const headers = await handle.connect();
    const result = await handle.app.inject({ method: "POST", url: "/v1/browser/providers/proof-provider/connect", headers });
    expect(result.statusCode).toBe(200);
    expect(result.body).not.toMatch(/secret-access-proof|secret-refresh-proof|bearer_token/);
    const lines = result.body.trim().split("\n").map((line: string) => JSON.parse(line));
    expect(lines.at(-1)).toMatchObject({ type: "provider_status", connected: true, provider: "proof-provider" });
    const ref = handle.store.secretRefStore.listSecretRefs()[0]!;
    expect(ref.resolution).toBe("resolved");
    const rows = handle.store.db.prepare("SELECT receipt_json FROM operation_invocation_ledger WHERE operation_id = 'credential.bind'").all() as Array<{ receipt_json: string }>;
    expect(rows.some(row => JSON.parse(row.receipt_json).state === "completed")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("secret-access-proof");
    const repeat = await handle.app.inject({ url: "/v1/browser/providers", headers });
    expect(repeat.json().providers[0].connected).toBe(true);
    expect(store.runtimeProfileStore.getCurrentActorBinding(actorId)?.status).toBe("resolved");
    store.db.prepare("INSERT INTO bridges (bridge_id, status, capabilities_json, last_seen_at, created_at) VALUES (?, 'online', '{}', ?, ?)").run(bridgeId, now, now);
    store.registerEndpoint({ endpoint_id: actorId, workspace_id: workspaceId, name: "Floe", bridge_id: bridgeId, status: "idle" }, () => {});
    store.registerEndpoint({ endpoint_id: "operator:provider-proof", workspace_id: workspaceId, name: "Operator" }, () => {});
    store.submitEvent({ type: "message", workspace_id: workspaceId, source_endpoint_id: "operator:provider-proof", destination: { kind: "endpoint", endpoint_id: actorId }, thread_id: "", correlation_id: null, content: { text: "Use the connected account." }, metadata: {}, idempotency_key: null }, () => {});
    const delivery = store.claimDeliveries(bridgeId, 1, () => {})[0]!;
    expect(delivery).toBeTruthy();
    store.prepareRuntimeDelivery({ bridge_id: bridgeId, delivery_id: delivery.delivery_id }, () => {});
    store.reportDeliveryStatus({ bridge_id: bridgeId, delivery_id: delivery.delivery_id, state: "injected_to_runtime" }, () => {});
    const use = () => store.withRuntimeCredential({ bridge_id: bridgeId, delivery_id: delivery.delivery_id, secret_ref_id: ref.secret_ref_id, operation_id: "credential.use", operation: bytes => bytes.length });
    expect(await use()).toBe(material.length);
    const definition = store.actorDefinitionStore.requireRevision(store.actorDefinitionStore.getActor(actorId)!.current_definition_revision_id!);
    const credentialGrant = definition.content.capability_grant_ids.find(id => store.capabilityGrantStore.getGrant(id)?.operation_ids.includes("credential.use"))!;
    store.capabilityGrantStore.revokeGrant(credentialGrant);
    await expect(use()).rejects.toThrow();
    material.fill(0);
  });

  it("binds prompts to the initiating browser and aborts login when its stream closes", async () => {
    let aborted = false;
    const handle = await fixture(async (_provider, interaction) => {
      interaction.signal!.addEventListener("abort", () => { aborted = true; });
      await interaction.prompt({ type: "manual_code", message: "Enter sign-in code", signal: interaction.signal });
    });
    const headers = await handle.connect();
    const other = await handle.connect();
    const address = await handle.app.listen({ host: "127.0.0.1", port: 0 });
    // The browser proxy preserves Host. Node fetch replaces it, so use HTTP directly.
    const stream = httpRequest(`${address}/v1/browser/providers/proof-provider/connect`, { method: "POST", headers });
    cleanups.push(async () => { stream.destroy(); });
    const promptReceived = new Promise<{ connection_id: string; prompt_id: string }>((resolve, reject) => {
      stream.on("error", reject);
      stream.on("response", response => {
        if (response.statusCode !== 200) { response.resume(); reject(new Error(`Sign-in returned ${response.statusCode}`)); return; }
        let pending = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          pending += chunk;
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const event = JSON.parse(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
            if (event.type === "prompt") resolve(event);
          }
        });
        response.on("end", () => reject(new Error("Sign-in ended before its prompt")));
      });
      stream.setTimeout(5000, () => { stream.destroy(new Error("Sign-in prompt timed out")); });
    });
    stream.end();
    const prompt = await promptReceived;
    const answer = await handle.app.inject({ method: "POST", url: `/v1/browser/provider-connections/${prompt.connection_id}/answer`, headers: other, payload: { prompt_id: prompt.prompt_id, value: "guessed" } });
    expect(answer.statusCode).toBe(404);
    const duplicate = await handle.app.inject({ method: "POST", url: "/v1/browser/providers/proof-provider/connect", headers });
    expect(duplicate.statusCode).toBe(409);
    stream.destroy();
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(handle.store.secretRefStore.listSecretRefs()[0]!.resolution).toBe("unresolved");
  });
});
