// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBusServer } from "../../../floe-bus/src/server.ts";
import { defaultConfig } from "../../../floe-bus/src/config.ts";
import { registerExecutableActorFixture } from "../../../floe-bus/src/executable-actor-test-fixture.ts";
import { loadActorModel, saveActorModel } from "./actorModel.ts";
import type { ModelProviderStatus } from "../providers/modelProviders.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
const workspaceId = "workspace:model-choice";
const actorId = "actor:model-choice";
const endpointId = "endpoint:distinct-from-actor";
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "floe-model-choice-"));
  vi.stubEnv("LOCALAPPDATA", directory);
  const config = defaultConfig(directory);
  const configPath = join(directory, "config.yaml");
  writeFileSync(configPath, JSON.stringify(config));
  const catalog: ModelProviderStatus = { type: "provider_status", provider: "test-provider", name: "Proof", auth_name: "Proof", connected: false, profile_id: "test-provider", models: [{ id: "test-model", name: "Test model", is_default: true, reasoning_efforts: ["high"] }] };
  const handle = await createBusServer(configPath, config, { host_control_token: "model-choice-host-".repeat(4), local_browser_access: true, provider_login_adapter: {
    list: async () => [catalog], login: async (_provider, _interaction, consume) => { const bytes = Buffer.from('{"type":"oauth","access":"proof-only"}'); try { await consume(bytes); } finally { bytes.fill(0); } },
  } });
  cleanups.push(async () => { await handle.app.close(); rmSync(directory, { recursive: true, force: true }); });
  await handle.app.ready();
  const { store } = handle;
  const now = new Date().toISOString();
  store.workspaceIdentityStore.restoreWorkspace({ snapshot: { workspace_id: workspaceId, name: "Model choice", creation_kind: "created", source_workspace_id: null, created_at: now, updated_at: now }, binding: { host_id: store.localHostId, platform: "windows", locator: join(directory, "workspace"), init_authorized: true } });
  registerExecutableActorFixture(store, workspaceId, actorId);
  store.registerBridge({ bridge_id: "bridge:model-choice" }, () => {});
  store.registerEndpoint({ endpoint_id: endpointId, workspace_id: workspaceId, name: "Model collaborator", bridge_id: "bridge:model-choice", status: "runtime_unconfigured" }, () => {});
  const original = store.runtimeProfileStore.getCurrentActorBinding(actorId)!;
  store.runtimeProfileStore.bindActor({ actor_id: actorId, runtime_profile_revision_id: original.runtime_profile_revision_id, endpoint_id: endpointId, status: "unresolved", unresolved_reasons: ["runtime_configuration_missing:model", "runtime_credential_unresolved", "runtime_credential_reference_missing"], expected_current_binding_id: original.actor_runtime_binding_id, created_by_principal_id: "fixture" });
  const headers = { origin: "http://localhost:5379", host: "localhost:5379", cookie: "" };
  const session = await handle.app.inject({ method: "POST", url: "/v1/browser/session/local", headers });
  headers.cookie = String(session.headers["set-cookie"]).split(";")[0]!;
  const login = await handle.app.inject({ method: "POST", url: "/v1/browser/providers/test-provider/connect", headers });
  const provider = JSON.parse(login.body.trim().split("\n").at(-1)!) as ModelProviderStatus;
  expect(provider.connected, login.body).toBe(true);
  const operations = {
    listOperations: async (workspace: string, target?: { kind: string; id: string }) => {
      const query = target ? `?target_kind=${target.kind}&target_id=${encodeURIComponent(target.id)}` : "";
      const result = await handle.app.inject({ url: `/v1/workspaces/${encodeURIComponent(workspace)}/operations${query}`, headers });
      expect(result.statusCode, result.body).toBe(200); return result.json().operations;
    },
    invokeOperation: async (workspace: string, request: Parameters<typeof import("../bus-client/client.ts").invokeOperation>[1]) => {
      const result = await handle.app.inject({ method: "POST", url: `/v1/workspaces/${encodeURIComponent(workspace)}/operations/invoke`, headers, payload: request });
      expect(result.statusCode, result.body).toBeLessThan(300); return result.json().receipt;
    },
  };
  const authorize = async (_provider: ModelProviderStatus, workspace: string, actor: string) => {
    const response = await handle.app.inject({ method: "POST", url: "/v1/browser/providers/test-provider/runtime-access", headers, payload: { workspace_id: workspace, actor_id: actor, expires_at: "2099-01-01T00:00:00.000Z" } });
    if (response.statusCode !== 200) throw new Error(response.json().message);
    return response.json().grant_id as string;
  };
  return { ...handle, headers, provider, operations, authorize };
}

describe.runIf(process.platform === "win32")("canonical model selection through the local browser", () => {
  it("saves one exact binding, keeps instructions and existing grants, and reuses account access", async () => {
    const { app, store, operations, provider, authorize } = await fixture();
    const current = await loadActorModel(workspaceId, endpointId, operations);
    expect(current.actor.actor.actor_id).toBe(actorId);
    const result = await saveActorModel(workspaceId, current, provider, "test-model", "high", operations, authorize);
    expect(result.binding).toMatchObject({ actor_id: actorId, endpoint_id: endpointId, status: "resolved", unresolved_reasons: [] });
    expect(store.getEndpoint(endpointId).status).toBe("idle");
    store.registerEndpoint({ endpoint_id: endpointId, workspace_id: workspaceId, name: "Model collaborator", bridge_id: "bridge:model-choice", status: "runtime_unconfigured" }, () => {});
    expect(store.getEndpoint(endpointId).status).toBe("idle");
    expect(result.profile.content).toMatchObject({ adapter_id: "pi-agent-core", configuration: { provider: "test-provider", model: "test-model", thinking_level: "high" }, secret_ref_ids: [provider.secret_ref_id] });
    expect(result.actor.current_definition!.content.instructions).toBe(current.actor.current_definition!.content.instructions);
    expect(result.actor.current_definition!.content.capability_grant_ids).toEqual(expect.arrayContaining(current.actor.current_definition!.content.capability_grant_ids));
    const access = await authorize(provider, workspaceId, actorId);
    expect(result.actor.current_definition!.content.capability_grant_ids).toContain(access);
    const grant = store.capabilityGrantStore.getGrant(access)!;
    expect(grant.operation_ids).toEqual(["credential.refresh", "credential.use"]);
    expect(grant.targets).toEqual(expect.arrayContaining([{ kind: "secret_ref", id: provider.secret_ref_id }, { kind: "provider_account", id: provider.provider }]));
    expect((await loadActorModel(workspaceId, endpointId, operations)).binding.actor_runtime_binding_id).toBe(result.binding.actor_runtime_binding_id);
    expect(store.runtimeProfileStore.requireActorBinding(current.binding.actor_runtime_binding_id).superseded_at).not.toBeNull();
    await expect(saveActorModel(workspaceId, current, provider, "test-model", "high", operations, authorize)).rejects.toThrow();
    const revoked = await app.inject({ method: "POST", url: "/v1/local/operations/invoke", headers: { authorization: `Bearer ${"model-choice-host-".repeat(4)}` }, payload: {
      operation_id: "credential.runtime-access.revoke", operation_version: "1", input_schema_version: "1", idempotency_key: "revoke-model-access", target: { kind: "secret_ref", id: provider.secret_ref_id }, expected_resource_revision: provider.credential_revision, input: { grant_id: access },
    } });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json().receipt.state).toBe("completed");
    expect(store.capabilityGrantStore.getGrant(access)!.revoked_at).not.toBeNull();
    expect(store.runtimeProfileStore.getCurrentActorBinding(actorId)?.unresolved_reasons).toEqual(["runtime_credential_authority_unresolved"]);
    expect(store.getEndpoint(endpointId).status).toBe("runtime_unconfigured");
  });
  it("refuses cross-Workspace and unauthenticated account grants", async () => {
    const { app, provider, authorize } = await fixture();
    await expect(authorize(provider, "workspace:other", actorId)).rejects.toThrow(/workspace/i);
    await expect(authorize(provider, workspaceId, "actor:elsewhere")).rejects.toThrow(/Workspace/);
    const response = await app.inject({ method: "POST", url: "/v1/browser/providers/test-provider/runtime-access", payload: { workspace_id: workspaceId, actor_id: actorId, expires_at: "2099-01-01T00:00:00.000Z" } });
    expect(response.statusCode).toBe(403);
  });
});
