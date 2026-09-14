import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  BridgeAuthStorage,
  BrokeredDeliveryCredentialStore,
  resolveBrokeredRuntimeAuth,
  resolveRuntimeAuth,
  RuntimeAuthError,
} from "./auth.js";
import type { BridgeAuthRuntime, ModelThinkingCapability } from "./auth.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(provider: string, modelId: string) {
  return {
    id: modelId,
    name: modelId,
    api: "openai-responses" as const,
    provider,
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"] as ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096
  };
}

function makeAuthRuntime(
  profiles: Array<{ id: string; provider: string; model?: string }>,
  apiKeysByProvider: Record<string, string>,
  modelsByProviderAndId: Record<string, Record<string, ReturnType<typeof makeModel>>>
): BridgeAuthRuntime {
  return {
    paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
    authStorage: {} as any,
    modelRegistry: {
      find(provider: string, modelId: string) {
        return modelsByProviderAndId[provider]?.[modelId];
      },
      async getApiKeyForProvider(provider: string) {
        return apiKeysByProvider[provider];
      }
    } as any,
    profiles: {
      version: 1,
      profiles
    }
  } as BridgeAuthRuntime;
}

const copilotProfile = { id: "copilot-atvi", provider: "github-copilot", model: "copilot-model-1" };
const codexProfile = { id: "codex-default", provider: "openai-codex", model: "gpt-5.4-mini" };

const copilotModel = makeModel("github-copilot", "copilot-model-1");
const codexModel = makeModel("openai-codex", "gpt-5.4-mini");

const authRuntime = makeAuthRuntime(
  [copilotProfile, codexProfile],
  { "github-copilot": "ghp_fake", "openai-codex": "sk_fake" },
  {
    "github-copilot": { "copilot-model-1": copilotModel },
    "openai-codex": { "gpt-5.4-mini": codexModel }
  }
);

// ---------------------------------------------------------------------------
// Issue 1 tests
// ---------------------------------------------------------------------------

describe("resolveRuntimeAuth – provider/profile coherence (Issue 1)", () => {
  it("resolves coherently when workspace binding provides copilot-atvi profile (no project provider)", async () => {
    // Simulates: no project provider/model, local workspace binding selected copilot-atvi
    const result = await resolveRuntimeAuth(authRuntime, {
      auth_profile: "copilot-atvi",
      auth_profile_source: "workspace_binding"
    });

    expect(result.provider).toBe("github-copilot");
    expect(result.modelId).toBe("copilot-model-1");
    expect(result.authProfileId).toBe("copilot-atvi");
    expect(result.apiKey).toBe("ghp_fake");
  });

  it("resolves coherently when agent binding provides copilot-atvi profile (no project provider)", async () => {
    // Simulates: no project provider/model, agent-level binding selected copilot-atvi
    const result = await resolveRuntimeAuth(authRuntime, {
      auth_profile: "copilot-atvi",
      auth_profile_source: "agent_binding"
    });

    expect(result.provider).toBe("github-copilot");
    expect(result.modelId).toBe("copilot-model-1");
    expect(result.authProfileId).toBe("copilot-atvi");
  });

  it("local binding wins: project openai-codex provider does NOT leak when workspace binding is copilot-atvi", async () => {
    // Simulates the reported bug: project file has provider=openai-codex, but workspace binding selected copilot-atvi
    const result = await resolveRuntimeAuth(authRuntime, {
      provider: "openai-codex",
      model: "gpt-5.4-mini",
      auth_profile: "copilot-atvi",
      auth_profile_source: "workspace_binding"
    });

    // Local binding wins: provider must come from the copilot-atvi profile
    expect(result.provider).toBe("github-copilot");
    expect(result.provider).not.toBe("openai-codex");
    // Incompatible project model is stripped; profile model is used
    expect(result.modelId).toBe("copilot-model-1");
    expect(result.authProfileId).toBe("copilot-atvi");
    expect(result.apiKey).toBe("ghp_fake");
  });

  it("local binding wins: agent override copilot-atvi overrides project openai-codex", async () => {
    const result = await resolveRuntimeAuth(authRuntime, {
      provider: "openai-codex",
      model: "gpt-5.4-mini",
      auth_profile: "copilot-atvi",
      auth_profile_source: "agent_binding"
    });

    expect(result.provider).toBe("github-copilot");
    expect(result.provider).not.toBe("openai-codex");
    expect(result.authProfileId).toBe("copilot-atvi");
  });

  it("project runtime with provider matching profile resolves correctly with no local binding", async () => {
    // Project declares openai-codex and selects codex-default profile — compatible
    const result = await resolveRuntimeAuth(authRuntime, {
      provider: "openai-codex",
      model: "gpt-5.4-mini",
      auth_profile: "codex-default",
      auth_profile_source: "project_runtime"
    });

    expect(result.provider).toBe("openai-codex");
    expect(result.modelId).toBe("gpt-5.4-mini");
    expect(result.authProfileId).toBe("codex-default");
  });

  it("surfaces runtime_profile_provider_mismatch when project provider conflicts with profile provider (no local binding)", async () => {
    // Project explicitly declares openai-codex provider AND copilot-atvi profile (different provider) — error case
    await expect(
      resolveRuntimeAuth(authRuntime, {
        provider: "openai-codex",
        auth_profile: "copilot-atvi"
        // auth_profile_source absent → not a local binding
      })
    ).rejects.toSatisfy((e: unknown) => {
      return e instanceof RuntimeAuthError && e.code === "runtime_profile_provider_mismatch";
    });
  });

  it("throws runtime_profile_required when no auth_profile is configured at all", async () => {
    await expect(
      resolveRuntimeAuth(authRuntime, { provider: "github-copilot" })
    ).rejects.toSatisfy((e: unknown) => {
      return e instanceof RuntimeAuthError && e.code === "runtime_profile_required";
    });
  });

  it("throws runtime_profile_required for an unknown profile id", async () => {
    await expect(
      resolveRuntimeAuth(authRuntime, { auth_profile: "nonexistent-profile" })
    ).rejects.toSatisfy((e: unknown) => {
      return e instanceof RuntimeAuthError && e.code === "runtime_profile_required";
    });
  });

  it("resolved provider comes from profile when project runtime is provider-neutral (engine-only)", async () => {
    // Fresh default agent: runtime: { engine: pi } only — no provider/model in project file
    const result = await resolveRuntimeAuth(authRuntime, {
      // provider: undefined, model: undefined — provider-neutral project
      auth_profile: "copilot-atvi",
      auth_profile_source: "workspace_binding"
    });

    expect(result.provider).toBe("github-copilot");
    expect(result.modelId).toBe("copilot-model-1");
  });

  it("configured_by_pi_ai placeholder provider is treated as absent and profile provider wins", async () => {
    const result = await resolveRuntimeAuth(authRuntime, {
      provider: "configured_by_pi_ai",
      auth_profile: "copilot-atvi",
      auth_profile_source: "workspace_binding"
    });

    expect(result.provider).toBe("github-copilot");
  });
});

// ---------------------------------------------------------------------------
// Model selection tests
// ---------------------------------------------------------------------------

describe("resolveRuntimeAuth – model selection (model discovery)", () => {
  const copilotWithoutDefaultModel = { id: "copilot-atvi", provider: "github-copilot" };
  const claudeModel = makeModel("github-copilot", "claude-sonnet-4.6");
  const haiku = makeModel("github-copilot", "claude-haiku-4.5");

  const runtimeNoProfileModel = makeAuthRuntime(
    [copilotWithoutDefaultModel],
    { "github-copilot": "ghp_fake" },
    { "github-copilot": { "claude-sonnet-4.6": claudeModel, "claude-haiku-4.5": haiku } }
  );

  it("throws runtime_model_required when auth profile has no model and binding provides no model", async () => {
    await expect(
      resolveRuntimeAuth(runtimeNoProfileModel, {
        auth_profile: "copilot-atvi",
        auth_profile_source: "workspace_binding"
        // model: undefined — nothing selected
      })
    ).rejects.toSatisfy((e: unknown) => {
      return e instanceof RuntimeAuthError && e.code === "runtime_model_required";
    });
  });

  it("binding model resolves correctly when workspace binding specifies model", async () => {
    const result = await resolveRuntimeAuth(runtimeNoProfileModel, {
      auth_profile: "copilot-atvi",
      auth_profile_source: "workspace_binding",
      model: "claude-sonnet-4.6",
      model_source: "workspace_binding"
    });

    expect(result.provider).toBe("github-copilot");
    expect(result.modelId).toBe("claude-sonnet-4.6");
    expect(result.model.id).toBe("claude-sonnet-4.6");
    expect(result.apiKey).toBe("ghp_fake");
  });

  it("binding model resolves correctly when agent binding specifies model", async () => {
    const result = await resolveRuntimeAuth(runtimeNoProfileModel, {
      auth_profile: "copilot-atvi",
      auth_profile_source: "agent_binding",
      model: "claude-haiku-4.5",
      model_source: "agent_binding"
    });

    expect(result.provider).toBe("github-copilot");
    expect(result.modelId).toBe("claude-haiku-4.5");
  });

  it("binding model takes priority over profile model", async () => {
    const runtimeWithProfileModel = makeAuthRuntime(
      [{ id: "copilot-atvi", provider: "github-copilot", model: "claude-haiku-4.5" }],
      { "github-copilot": "ghp_fake" },
      { "github-copilot": { "claude-sonnet-4.6": claudeModel, "claude-haiku-4.5": haiku } }
    );

    const result = await resolveRuntimeAuth(runtimeWithProfileModel, {
      auth_profile: "copilot-atvi",
      auth_profile_source: "workspace_binding",
      model: "claude-sonnet-4.6",  // binding explicitly selects sonnet
      model_source: "workspace_binding"
    });

    expect(result.modelId).toBe("claude-sonnet-4.6");  // binding wins over profile's haiku
  });

  it("binding model is NOT stripped when project provider conflicts with profile provider", async () => {
    // User selected copilot-atvi profile (github-copilot) AND explicitly chose a model via the binding.
    // Even though the project file declared openai-codex, the binding model must be preserved.
    const result = await resolveRuntimeAuth(runtimeNoProfileModel, {
      provider: "openai-codex",  // project-declared provider (conflicts)
      auth_profile: "copilot-atvi",
      auth_profile_source: "workspace_binding",
      model: "claude-sonnet-4.6",  // explicitly selected via UI
      model_source: "workspace_binding"
    });

    expect(result.provider).toBe("github-copilot");
    expect(result.modelId).toBe("claude-sonnet-4.6");  // NOT stripped
  });

  it("throws runtime_model_unknown for a model id not in the registry", async () => {
    await expect(
      resolveRuntimeAuth(runtimeNoProfileModel, {
        auth_profile: "copilot-atvi",
        auth_profile_source: "workspace_binding",
        model: "nonexistent-model-xyz",
        model_source: "workspace_binding"
      })
    ).rejects.toSatisfy((e: unknown) => {
      return e instanceof RuntimeAuthError && e.code === "runtime_model_unknown";
    });
  });
});

// ---------------------------------------------------------------------------
// thinkingCapability propagation (FIX 2)
// ---------------------------------------------------------------------------

describe("resolveRuntimeAuth – thinkingCapability propagation (FIX 2)", () => {
  function makeRuntimeWithCapability(capability: ModelThinkingCapability | undefined): BridgeAuthRuntime {
    const thinkingCapabilities = new Map<string, ModelThinkingCapability>();
    if (capability !== undefined) thinkingCapabilities.set("anthropic/claude-haiku-4-5", capability);

    return {
      paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
      authStorage: {} as any,
      modelRegistry: {
        find(provider: string, modelId: string) {
          if (provider === "anthropic" && modelId === "claude-haiku-4-5") {
            return makeModel("anthropic", "claude-haiku-4-5");
          }
          return undefined;
        },
        getThinkingCapability(provider: string, modelId: string) {
          return thinkingCapabilities.get(`${provider}/${modelId}`);
        },
        async getApiKeyForProvider(provider: string) {
          if (provider === "anthropic") return "sk-ant-fake";
          return undefined;
        }
      } as any,
      profiles: {
        version: 1,
        profiles: [{ id: "anthropic-profile", provider: "anthropic", model: "claude-haiku-4-5" }]
      }
    } as BridgeAuthRuntime;
  }

  it("resolves thinkingCapability from registry for declared model", async () => {
    const runtime = makeRuntimeWithCapability("budget");
    const result = await resolveRuntimeAuth(runtime, {
      auth_profile: "anthropic-profile",
      auth_profile_source: "workspace_binding"
    });
    expect(result.thinkingCapability).toBe("budget");
  });

  it("resolves thinkingCapability as undefined when no declaration exists", async () => {
    const runtime = makeRuntimeWithCapability(undefined);
    const result = await resolveRuntimeAuth(runtime, {
      auth_profile: "anthropic-profile",
      auth_profile_source: "workspace_binding"
    });
    expect(result.thinkingCapability).toBeUndefined();
  });

  it("resolves thinkingCapability as always-on for fable-style models", async () => {
    const runtime = makeRuntimeWithCapability("always-on");
    const result = await resolveRuntimeAuth(runtime, {
      auth_profile: "anthropic-profile",
      auth_profile_source: "workspace_binding"
    });
    expect(result.thinkingCapability).toBe("always-on");
  });
});

// ---------------------------------------------------------------------------
// BridgeAuthStorage – OAuth credential staleness race fix
// ---------------------------------------------------------------------------

describe("BridgeAuthStorage – reload-before-use picks up external writes", () => {
  function makeTempAuthJson(contents: object): string {
    const dir = mkdtempSync(join(tmpdir(), "floe-bridge-auth-test-"));
    const path = join(dir, "auth.json");
    writeFileSync(path, JSON.stringify(contents), "utf8");
    return path;
  }

  it("(a) oauth path: external rewrite between constructor and getApiKey is picked up", async () => {
    // far-future expires so getOAuthApiKey will NOT attempt a network refresh
    const farFuture = Date.now() + 3_600_000;

    const initialCredential = {
      type: "oauth",
      access: "access-token-OLD",
      refresh: "refresh-token-OLD",
      expires: farFuture
    };

    const path = makeTempAuthJson({ "anthropic": initialCredential });
    const storage = new BridgeAuthStorage(path);

    // Simulate the bus writing a fresher credential after the bridge was constructed
    const fresherCredential = {
      type: "oauth",
      access: "access-token-NEW",
      refresh: "refresh-token-NEW",
      expires: farFuture
    };
    writeFileSync(path, JSON.stringify({ "anthropic": fresherCredential }), "utf8");

    // getApiKey must reload from disk and return the new access token
    // (pi's getOAuthApiKey returns credential.access when not expired — no network call)
    const apiKey = await storage.getApiKey("anthropic");
    expect(apiKey).toBe("access-token-NEW");
  });

  it("(b) api_key path: external rewrite between constructor and getApiKey is picked up", async () => {
    const path = makeTempAuthJson({ "openai": { type: "api_key", key: "sk-OLD" } });
    const storage = new BridgeAuthStorage(path);

    // External writer updates the key
    writeFileSync(path, JSON.stringify({ "openai": { type: "api_key", key: "sk-NEW" } }), "utf8");

    const apiKey = await storage.getApiKey("openai");
    expect(apiKey).toBe("sk-NEW");
  });
});

describe("Delivery-scoped credential brokering", () => {
  it("reads only the exact provider credential and clears the transport bytes", async () => {
    const material = Buffer.from(JSON.stringify({ type: "api_key", key: "brokered-key" }), "utf8");
    const bus = {
      async readRuntimeCredential(deliveryId: string, secretRefId: string) {
        expect(deliveryId).toBe("delivery:1");
        expect(secretRefId).toBe("secret:1");
        return material;
      },
      async replaceRuntimeCredential() {
        throw new Error("not expected");
      },
    };
    const store = new BrokeredDeliveryCredentialStore(
      bus as any,
      "delivery:1",
      "secret:1",
      "openai",
    );

    await expect(store.read("anthropic")).rejects.toMatchObject({
      code: "runtime_credential_unresolved",
    });
    await expect(store.read("openai")).resolves.toMatchObject({
      type: "api_key",
      key: "brokered-key",
    });
    expect([...material].every((byte) => byte === 0)).toBe(true);
  });

  it("persists OAuth refresh only through the exact Delivery channel", async () => {
    const farFuture = Date.now() + 3_600_000;
    let stored = Buffer.from(JSON.stringify({
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: farFuture,
    }), "utf8");
    const writes: Uint8Array[] = [];
    const bus = {
      async readRuntimeCredential() {
        return Buffer.from(stored);
      },
      async replaceRuntimeCredential(deliveryId: string, secretRefId: string, material: Uint8Array) {
        expect(deliveryId).toBe("delivery:refresh");
        expect(secretRefId).toBe("secret:oauth");
        writes.push(Uint8Array.from(material));
        stored.fill(0);
        stored = Buffer.from(material);
      },
    };
    const store = new BrokeredDeliveryCredentialStore(
      bus as any,
      "delivery:refresh",
      "secret:oauth",
      "openai-codex",
    );

    const result = await store.modify("openai-codex", async () => ({
      type: "oauth",
      access: "new-access",
      refresh: "new-refresh",
      expires: farFuture + 1_000,
    }));

    expect(result).toMatchObject({ type: "oauth", access: "new-access" });
    expect(writes).toHaveLength(1);
    expect(JSON.parse(Buffer.from(writes[0]).toString("utf8"))).toMatchObject({
      type: "oauth",
      access: "new-access",
    });
  });

  it("resolves a pinned provider without consulting legacy or ambient auth", async () => {
    const runtime = makeAuthRuntime(
      [],
      { openai: "legacy-key-must-not-be-read" },
      { openai: { "gpt-5.4-mini": makeModel("openai", "gpt-5.4-mini") } },
    );
    const reads: string[] = [];
    const credentialStore = {
      async read(providerId: string) {
        reads.push(providerId);
        return { type: "api_key" as const, key: "delivery-key" };
      },
      async list() { return []; },
      async modify(_providerId: string, fn: any) {
        return fn({ type: "api_key", key: "delivery-key" });
      },
      async delete() {},
    };

    const result = await resolveBrokeredRuntimeAuth(runtime, {
      provider: "openai",
      model: "gpt-5.4-mini",
      auth_profile: "legacy-profile-must-be-ignored",
    }, credentialStore);

    expect(result.apiKey).toBe("delivery-key");
    expect(result.authProfileId).toBeNull();
    expect(result.usedEnvFallback).toBe(false);
    await expect(result.getApiKey()).resolves.toBe("delivery-key");
    expect(reads).toEqual(["openai", "openai"]);
  });

  it("blocks when the Delivery credential is absent instead of falling back", async () => {
    const runtime = makeAuthRuntime(
      [],
      { openai: "legacy-key-must-not-be-read" },
      { openai: { "gpt-5.4-mini": makeModel("openai", "gpt-5.4-mini") } },
    );
    const unavailableStore = {
      async read() { throw new Error("missing"); },
      async list() { return []; },
      async modify() { return undefined; },
      async delete() {},
    };

    await expect(resolveBrokeredRuntimeAuth(runtime, {
      provider: "openai",
      model: "gpt-5.4-mini",
    }, unavailableStore as any)).rejects.toMatchObject({
      code: "runtime_credential_unresolved",
    });
  });
});
