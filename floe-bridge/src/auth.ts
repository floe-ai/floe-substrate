/**
 * @invariant This module is the bridge-side runtime auth resolver.
 * It must resolve provider, model, auth profile, and workspace-level runtime options from
 * the shared Floe auth files without leaking secrets or bypassing binding precedence.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getModels, getProviders, type Model } from "@earendil-works/pi-ai/compat";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  ModelAuth,
  Models,
} from "@earendil-works/pi-ai";
import YAML from "yaml";
import { z } from "zod";
import type { BusClient } from "./bus-client.js";
import type { LocalConfig } from "./config.js";
import { resolveLocalPath } from "./config.js";

const ProfileSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  created_at: z.string().min(1).optional(),
  updated_at: z.string().min(1).optional()
});

const ProfilesDocumentSchema = z.object({
  version: z.literal(1),
  profiles: z.array(ProfileSchema)
});

/**
 * Thinking capability declaration for a model entry.
 *
 * - "adaptive"  : model accepts { type: "adaptive" } (Opus 4.6+, Sonnet 4.6+)
 * - "budget"    : model accepts legacy { type: "enabled", budget_tokens:N } shapes (haiku 4.5, etc.)
 * - "always-on" : model rejects any explicit thinking param; it must be omitted entirely (e.g. claude-fable-5)
 * - "none"      : no thinking support; the thinking param must be omitted
 *
 * When absent, pi-ai's own internal inference logic applies (no regression for existing configs).
 */
export type ModelThinkingCapability = "adaptive" | "budget" | "always-on" | "none";

const ModelThinkingCapabilitySchema = z.enum(["adaptive", "budget", "always-on", "none"]);

const ModelsConfigSchema = z.object({
  providers: z.record(z.string(), z.object({
    models: z.array(z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      api: z.string().optional(),
      baseUrl: z.string().optional(),
      reasoning: z.boolean().optional(),
      /**
       * Explicit thinking capability declaration.
       * When present, the bridge clamps thinking_level at the bridge/bus boundary
       * rather than relying on pi-ai's internal model-id substring inference.
       */
      thinking: ModelThinkingCapabilitySchema.optional(),
      input: z.array(z.enum(["text", "image"])).optional(),
      cost: z.object({
        input: z.number(),
        output: z.number(),
        cacheRead: z.number(),
        cacheWrite: z.number()
      }).optional(),
      contextWindow: z.number().optional(),
      maxTokens: z.number().optional()
    })).optional()
  }))
});

type AuthProfile = z.infer<typeof ProfileSchema>;
type ProfilesDocument = z.infer<typeof ProfilesDocumentSchema>;

type AuthCredential = Credential;
type AuthStorageData = Record<string, AuthCredential>;

const DEFAULT_PROFILES: ProfilesDocument = {
  version: 1,
  profiles: []
};

const DEFAULT_MODELS_CONFIG = {
  providers: {}
};

export type FloeAuthPaths = {
  authDir: string;
  authJsonPath: string;
  modelsJsonPath: string;
  profilesYamlPath: string;
};

export type BridgeAuthRuntime = {
  paths: FloeAuthPaths;
  authStorage: BridgeAuthStorage;
  modelRegistry: BridgeModelRegistry;
  profiles: ProfilesDocument;
};

/**
 * Resolved thinking capability for a model, derived from its registry entry.
 * Undefined means no declaration was made; pi-ai's own inference applies.
 */
export type ResolvedThinkingCapability = ModelThinkingCapability | undefined;

export type AgentRuntimeConfig = {
  provider?: string;
  model?: string;
  auth_profile?: string;
  thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Source of the auth_profile selection. "agent_binding" and "workspace_binding" indicate
   *  a local override; project-declared provider/model do not take precedence in that case. */
  auth_profile_source?: string;
  /** Source of the model selection. "agent_binding" and "workspace_binding" indicate the model
   *  was explicitly chosen by the user and must not be stripped when providers differ. */
  model_source?: string;
  /** Agent markdown body to use as the system prompt for this agent's runtime sessions. */
  instructions?: string;
};

export type RuntimeAuthErrorCode =
  | "runtime_profile_required"
  | "provider_auth_missing"
  | "runtime_provider_required"
  | "runtime_model_required"
  | "runtime_model_unknown"
  | "runtime_credential_unresolved"
  | "runtime_processing_contract_mismatch"
  | "runtime_profile_provider_mismatch";

export type RuntimeAuthResolved = {
  provider: string;
  model: Model<any>;
  modelId: string;
  apiKey: string;
  /** Resolves auth again at request time so OAuth rotation remains Delivery-scoped. */
  getApiKey: () => Promise<string>;
  authProfileId: string | null;
  usedEnvFallback: boolean;
  /**
   * Declared thinking capability for this model (from models.json).
   * Undefined means no declaration; pi-ai's own inference applies.
   */
  thinkingCapability: ModelThinkingCapability | undefined;
};

const BrokeredCredentialSchema = z.union([
  z.object({
    type: z.literal("api_key"),
    key: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }).strict().refine((value) => Boolean(value.key || Object.keys(value.env ?? {}).length > 0)),
  z.object({
    type: z.literal("oauth"),
    refresh: z.string().min(1),
    access: z.string().min(1),
    expires: z.number().finite(),
  }).passthrough(),
]);

/**
 * Pi's credential-store contract backed by one Bus-authorised SecretRef.
 *
 * The store is deliberately Delivery-scoped. It cannot enumerate other
 * credentials, fall back to ambient state, or revoke a persistent credential.
 * OAuth refresh is the only supported write and is committed by the Bus under
 * the same exact SecretRef/CapabilityGrant checks as the read.
 */
export class BrokeredDeliveryCredentialStore implements CredentialStore {
  constructor(
    private readonly bus: Pick<BusClient, "readRuntimeCredential" | "replaceRuntimeCredential">,
    private readonly deliveryId: string,
    private readonly secretRefId: string,
    private readonly providerId: string,
  ) {
    if (!deliveryId.trim() || !secretRefId.trim() || !providerId.trim()) {
      throw new RuntimeAuthError(
        "runtime_credential_unresolved",
        "The pinned runtime credential is incomplete.",
      );
    }
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    this.assertProvider(providerId);
    options?.signal?.throwIfAborted();
    const material = await this.readMaterial();
    try {
      return BrokeredCredentialSchema.parse(JSON.parse(Buffer.from(material).toString("utf8"))) as Credential;
    } catch {
      throw new RuntimeAuthError(
        "runtime_credential_unresolved",
        "The pinned runtime credential is unavailable or invalid.",
      );
    } finally {
      material.fill(0);
    }
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const credential = await this.read(this.providerId, options);
    return credential ? [{ providerId: this.providerId, type: credential.type }] : [];
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    this.assertProvider(providerId);
    options?.signal?.throwIfAborted();
    const current = await this.read(providerId, options);
    const next = await fn(current);
    options?.signal?.throwIfAborted();
    if (next === undefined) return current;
    const validated = BrokeredCredentialSchema.parse(next) as Credential;
    const material = Buffer.from(JSON.stringify(validated), "utf8");
    try {
      await this.bus.replaceRuntimeCredential(this.deliveryId, this.secretRefId, material);
    } finally {
      material.fill(0);
    }
    return validated;
  }

  async delete(providerId: string): Promise<void> {
    this.assertProvider(providerId);
    throw new RuntimeAuthError(
      "runtime_credential_unresolved",
      "An isolated runtime cannot revoke a persistent credential.",
    );
  }

  private assertProvider(providerId: string): void {
    if (providerId !== this.providerId) {
      throw new RuntimeAuthError(
        "runtime_credential_unresolved",
        "The pinned runtime credential does not match this provider.",
      );
    }
  }

  private async readMaterial(): Promise<Uint8Array> {
    try {
      return await this.bus.readRuntimeCredential(this.deliveryId, this.secretRefId);
    } catch {
      throw new RuntimeAuthError(
        "runtime_credential_unresolved",
        "The pinned runtime credential is unavailable or invalid.",
      );
    }
  }
}

export class RuntimeAuthError extends Error {
  constructor(readonly code: RuntimeAuthErrorCode, message: string) {
    super(message);
    this.name = "RuntimeAuthError";
  }
}

export class BridgeAuthStorage implements CredentialStore {
  private data: AuthStorageData = {};
  private errors: Error[] = [];
  private readonly oauthModels: Models;

  constructor(private readonly authPath: string) {
    this.oauthModels = builtinModels({ credentials: this });
  }

  reload(): void {
    try {
      this.data = JSON.parse(readFileSync(this.authPath, "utf8")) as AuthStorageData;
    } catch {
      this.data = {};
    }
  }

  async getApiKey(provider: string): Promise<string | undefined> {
    // Reload from disk on every resolution. External writers (e.g. the bus probe refresh)
    // may have persisted fresher credentials since construction. Anthropic rotates refresh
    // tokens on each refresh, so a stale in-memory token is immediately invalid.
    this.reload();
    const credential = this.data[provider];
    if (credential?.type === "api_key") return credential.key?.trim() || undefined;
    if (credential?.type === "oauth") {
      try {
        const resolved = await this.oauthModels.getAuth(provider);
        return resolved?.auth.apiKey?.trim() || undefined;
      } catch (error) {
        this.errors.push(error instanceof Error ? error : new Error(String(error)));
        return undefined;
      }
    }
    return undefined;
  }

  async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
    this.reload();
    return this.data[providerId];
  }

  async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    this.reload();
    return Object.entries(this.data).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    this.reload();
    const current = this.data[providerId];
    const next = await fn(current);
    if (next !== undefined) {
      this.data[providerId] = next;
      this.save();
      return next;
    }
    return current;
  }

  async delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
    this.reload();
    delete this.data[providerId];
    this.save();
  }

  drainErrors(): Error[] {
    const drained = [...this.errors];
    this.errors = [];
    return drained;
  }

  private save(): void {
    writeFileSync(this.authPath, JSON.stringify(this.data, null, 2) + "\n", "utf8");
    chmodSafe(this.authPath, 0o600);
  }
}

class BridgeModelRegistry {
  private models: Model<any>[] = [];
  /** Thinking capability declarations keyed by "provider/modelId" */
  private thinkingCapabilities = new Map<string, ModelThinkingCapability>();

  constructor(
    private readonly authStorage: BridgeAuthStorage,
    private readonly modelsPath: string
  ) {
    this.refresh();
  }

  refresh(): void {
    this.thinkingCapabilities.clear();
    const builtIn = getProviders().flatMap((provider) => getModels(provider as any)) as Model<any>[];
    this.models = [...builtIn];
    try {
      const parsed = ModelsConfigSchema.parse(JSON.parse(readFileSync(this.modelsPath, "utf8")));
      for (const [provider, config] of Object.entries(parsed.providers)) {
        for (const modelDef of config.models ?? []) {
          const fallback = this.models.find((model) => model.provider === provider);
          const custom: Model<any> = {
            id: modelDef.id,
            name: modelDef.name ?? modelDef.id,
            api: (modelDef.api ?? fallback?.api ?? "openai-responses") as any,
            provider,
            baseUrl: modelDef.baseUrl ?? fallback?.baseUrl ?? "",
            reasoning: modelDef.reasoning ?? false,
            input: modelDef.input ?? ["text"],
            cost: modelDef.cost ?? fallback?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: modelDef.contextWindow ?? fallback?.contextWindow ?? 128000,
            maxTokens: modelDef.maxTokens ?? fallback?.maxTokens ?? 16384,
            headers: fallback?.headers,
            compat: fallback?.compat
          };
          const index = this.models.findIndex((model) => model.provider === provider && model.id === modelDef.id);
          if (index >= 0) this.models[index] = custom;
          else this.models.push(custom);
          // Store declared thinking capability if present
          if (modelDef.thinking) {
            this.thinkingCapabilities.set(`${provider}/${modelDef.id}`, modelDef.thinking);
          }
        }
      }
    } catch {
      // Keep built-ins on invalid models.json
    }
  }

  getAll(): Model<any>[] {
    return this.models;
  }

  find(provider: string, modelId: string): Model<any> | undefined {
    return this.models.find((model) => model.provider === provider && model.id === modelId);
  }

  getThinkingCapability(provider: string, modelId: string): ModelThinkingCapability | undefined {
    return this.thinkingCapabilities.get(`${provider}/${modelId}`);
  }

  async getApiKeyForProvider(provider: string): Promise<string | undefined> {
    return this.authStorage.getApiKey(provider);
  }

  async getAuthForModel(model: Model<any>): Promise<ModelAuth | undefined> {
    const credential = await this.authStorage.read(model.provider);
    if (credential?.type === "oauth") {
      try {
        const models = builtinModels({ credentials: this.authStorage });
        return (await models.getAuth(model))?.auth;
      } catch {
        return undefined;
      }
    }
    const stored = await this.authStorage.getApiKey(model.provider);
    if (stored) return { apiKey: stored };
    return undefined;
  }
}

export function createBridgeAuthRuntime(configPath: string, config: LocalConfig): BridgeAuthRuntime {
  const paths = getFloeAuthPaths(configPath, config);
  ensureAuthFiles(paths);
  const authStorage = new BridgeAuthStorage(paths.authJsonPath);
  const modelRegistry = new BridgeModelRegistry(authStorage, paths.modelsJsonPath);
  const profiles = loadProfiles(paths.profilesYamlPath);
  return {
    paths,
    authStorage,
    modelRegistry,
    profiles
  };
}

export async function resolveRuntimeAuth(
  runtime: BridgeAuthRuntime,
  runtimeConfig: AgentRuntimeConfig | undefined,
  options?: {
    defaultAuthProfile?: string;
  }
): Promise<RuntimeAuthResolved> {
  const profileId = cleanValue(runtimeConfig?.auth_profile) ?? cleanValue(options?.defaultAuthProfile);
  if (!profileId) {
    throw new RuntimeAuthError(
      "runtime_profile_required",
      "Runtime auth profile is required. Select an auth profile for this workspace or agent."
    );
  }
  const profile = resolveProfile(runtime.profiles, profileId);
  if (!profile) {
    throw new RuntimeAuthError(
      "runtime_profile_required",
      `Unknown auth profile '${profileId}'. Connect an account in Floe Settings and select it for this workspace.`
    );
  }

  const projectProvider = cleanValue(runtimeConfig?.provider);
  const profileProvider = cleanValue(profile.provider);
  const isLocalBinding =
    runtimeConfig?.auth_profile_source === "agent_binding" ||
    runtimeConfig?.auth_profile_source === "workspace_binding";

  let provider: string | undefined;
  let modelId = cleanValue(runtimeConfig?.model);
  const usedEnvFallback = false;

  if (isLocalBinding) {
    // A local (workspace/agent) binding was selected: the profile's provider takes precedence.
    // If the project declared a conflicting provider, its model is likely incompatible too, so strip it —
    // but only if the model itself also came from the project, not from a user-selected binding.
    const modelFromBinding =
      runtimeConfig?.model_source === "agent_binding" ||
      runtimeConfig?.model_source === "workspace_binding";
    if (!modelFromBinding && projectProvider && projectProvider !== "configured_by_pi_ai" && projectProvider !== profileProvider) {
      modelId = undefined;
    }
    provider = profileProvider;
    if (!modelId && profile?.model) modelId = cleanValue(profile.model);
  } else {
    // No local binding. If project and profile declare different providers, that is a configuration
    // conflict that cannot be resolved automatically.
    if (
      projectProvider &&
      projectProvider !== "configured_by_pi_ai" &&
      profileProvider &&
      projectProvider !== profileProvider
    ) {
      throw new RuntimeAuthError(
        "runtime_profile_provider_mismatch",
        `Project runtime declares provider '${projectProvider}' but auth profile '${profileId}' is for provider '${profileProvider}'. ` +
        `Update the project runtime block to match the selected profile, or select a compatible profile.`
      );
    }
    provider = projectProvider !== "configured_by_pi_ai" ? projectProvider : undefined;
    if (!provider && profileProvider) provider = profileProvider;
    if (!modelId && profile?.model) modelId = cleanValue(profile.model);
  }

  if (modelId && modelId.includes("/")) {
    const [qualifiedProvider, ...rest] = modelId.split("/");
    if (!provider && qualifiedProvider && rest.length > 0) {
      provider = qualifiedProvider;
      modelId = rest.join("/");
    }
  }

  if (!provider || provider === "configured_by_pi_ai") {
    throw new RuntimeAuthError(
      "runtime_provider_required",
      "No runtime provider configured. Set runtime.provider or configure it in the selected auth profile."
    );
  }
  if (!modelId) {
    throw new RuntimeAuthError(
      "runtime_model_required",
      `No runtime model configured for provider '${provider}'. Set runtime.model or configure it in the selected auth profile.`
    );
  }

  let model = runtime.modelRegistry.find(provider, modelId);
  if (!model && modelId.includes("/")) {
    const [qualifiedProvider, ...rest] = modelId.split("/");
    if (qualifiedProvider === provider && rest.length > 0) {
      modelId = rest.join("/");
      model = runtime.modelRegistry.find(provider, modelId);
    }
  }
  if (!model) {
    throw new RuntimeAuthError(
      "runtime_model_unknown",
      `Model '${provider}/${modelId}' is not present in local model registry.`
    );
  }
  let resolvedModel: Model<any> = model;

  const getAuthForModel = runtime.modelRegistry.getAuthForModel?.bind(runtime.modelRegistry);
  const modelAuth = getAuthForModel
    ? await getAuthForModel(resolvedModel)
    : { apiKey: await runtime.modelRegistry.getApiKeyForProvider(provider) };
  const apiKey = modelAuth?.apiKey;
  if (!apiKey) {
    const profileHint = profileId ? ` for profile '${profileId}'` : "";
    throw new RuntimeAuthError(
      "provider_auth_missing",
      `Missing provider auth for '${provider}'${profileHint}. Connect that account in Floe Settings.`
    );
  }

  if (modelAuth.baseUrl || modelAuth.headers) {
    const authHeaders = modelAuth.headers
      ? Object.fromEntries(Object.entries(modelAuth.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : undefined;
    resolvedModel = {
      ...resolvedModel,
      ...(modelAuth.baseUrl ? { baseUrl: modelAuth.baseUrl } : {}),
      ...(authHeaders ? { headers: { ...resolvedModel.headers, ...authHeaders } } : {}),
    };
  }

  return {
    provider,
    model: resolvedModel,
    modelId,
    apiKey,
    getApiKey: async () => {
      const refreshed = getAuthForModel
        ? await getAuthForModel(resolvedModel)
        : { apiKey: await runtime.modelRegistry.getApiKeyForProvider(provider) };
      if (!refreshed?.apiKey) {
        throw new RuntimeAuthError(
          "provider_auth_missing",
          `Missing provider auth for '${provider}'. Connect that account in Floe Settings.`,
        );
      }
      return refreshed.apiKey;
    },
    authProfileId: profile?.id ?? null,
    usedEnvFallback,
    thinkingCapability: runtime.modelRegistry.getThinkingCapability?.(provider, modelId)
  };
}

/**
 * Resolve a Bus-pinned Runtime Profile using only its Delivery-scoped
 * credential store. This path deliberately ignores auth profiles, environment
 * variables, configured key commands, and legacy files.
 */
export async function resolveBrokeredRuntimeAuth(
  runtime: BridgeAuthRuntime,
  runtimeConfig: AgentRuntimeConfig | undefined,
  credentialStore: CredentialStore,
): Promise<RuntimeAuthResolved> {
  const provider = cleanValue(runtimeConfig?.provider);
  let modelId = cleanValue(runtimeConfig?.model);
  if (!provider || provider === "configured_by_pi_ai") {
    throw new RuntimeAuthError(
      "runtime_provider_required",
      "The pinned Runtime Profile does not select a provider.",
    );
  }
  if (!modelId) {
    throw new RuntimeAuthError(
      "runtime_model_required",
      "The pinned Runtime Profile does not select a model.",
    );
  }
  if (modelId.includes("/")) {
    const [qualifiedProvider, ...rest] = modelId.split("/");
    if (qualifiedProvider !== provider || rest.length === 0) {
      throw new RuntimeAuthError(
        "runtime_profile_provider_mismatch",
        "The pinned Runtime Profile model does not match its provider.",
      );
    }
    modelId = rest.join("/");
  }
  const model = runtime.modelRegistry.find(provider, modelId);
  if (!model) {
    throw new RuntimeAuthError(
      "runtime_model_unknown",
      `Model '${provider}/${modelId}' is not present in the local model registry.`,
    );
  }

  const models = builtinModels({ credentials: credentialStore });
  const resolveKey = async (): Promise<string> => {
    try {
      const result = await models.getAuth(model);
      if (!result?.auth.apiKey) throw new Error("unavailable");
      return result.auth.apiKey;
    } catch {
      // Provider errors can include transport details. Keep the durable/runtime
      // surface generic and never echo the credential material or provider body.
      throw new RuntimeAuthError(
        "runtime_credential_unresolved",
        "The pinned runtime credential is unavailable or could not be refreshed.",
      );
    }
  };

  let modelAuth: ModelAuth;
  try {
    const result = await models.getAuth(model);
    if (!result?.auth.apiKey) throw new Error("unavailable");
    modelAuth = result.auth;
  } catch {
    throw new RuntimeAuthError(
      "runtime_credential_unresolved",
      "The pinned runtime credential is unavailable or could not be refreshed.",
    );
  }
  const authHeaders = modelAuth.headers
    ? Object.fromEntries(
        Object.entries(modelAuth.headers)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      )
    : undefined;
  const resolvedModel: Model<any> = modelAuth.baseUrl || authHeaders
    ? {
        ...model,
        ...(modelAuth.baseUrl ? { baseUrl: modelAuth.baseUrl } : {}),
        ...(authHeaders ? { headers: { ...model.headers, ...authHeaders } } : {}),
      }
    : model;
  const initialApiKey = modelAuth.apiKey;
  if (!initialApiKey) {
    throw new RuntimeAuthError(
      "runtime_credential_unresolved",
      "The pinned runtime credential is unavailable or could not be refreshed.",
    );
  }

  return {
    provider,
    model: resolvedModel,
    modelId,
    apiKey: initialApiKey,
    getApiKey: resolveKey,
    authProfileId: null,
    usedEnvFallback: false,
    thinkingCapability: runtime.modelRegistry.getThinkingCapability?.(provider, modelId),
  };
}

function getFloeAuthPaths(configPath: string, config: LocalConfig): FloeAuthPaths {
  const homeDir = resolveLocalPath(configPath, config.home, ".");
  const authDir = join(homeDir, "auth");
  return {
    authDir,
    authJsonPath: join(authDir, "auth.json"),
    modelsJsonPath: join(authDir, "models.json"),
    profilesYamlPath: join(authDir, "profiles.yaml")
  };
}

function ensureAuthFiles(paths: FloeAuthPaths): void {
  mkdirSync(paths.authDir, { recursive: true, mode: 0o700 });
  chmodSafe(paths.authDir, 0o700);
  if (!existsSync(paths.authJsonPath)) writeFileSync(paths.authJsonPath, "{}\n", "utf8");
  chmodSafe(paths.authJsonPath, 0o600);
  if (!existsSync(paths.modelsJsonPath)) {
    writeFileSync(paths.modelsJsonPath, JSON.stringify(DEFAULT_MODELS_CONFIG, null, 2) + "\n", "utf8");
  }
  chmodSafe(paths.modelsJsonPath, 0o600);
  if (!existsSync(paths.profilesYamlPath)) {
    writeFileSync(paths.profilesYamlPath, YAML.stringify(DEFAULT_PROFILES), "utf8");
  }
  chmodSafe(paths.profilesYamlPath, 0o600);
}

function loadProfiles(path: string): ProfilesDocument {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = raw.trim() ? YAML.parse(raw) : DEFAULT_PROFILES;
    return ProfilesDocumentSchema.parse(parsed);
  } catch {
    return { ...DEFAULT_PROFILES, profiles: [] };
  }
}

function resolveProfile(profiles: ProfilesDocument, profileId?: string): AuthProfile | undefined {
  const id = cleanValue(profileId);
  if (!id) return undefined;
  return profiles.profiles.find((profile) => profile.id === id);
}

function cleanValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function chmodSafe(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort only.
  }
}
