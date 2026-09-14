/**
 * @invariant This module is the bus-local read model for Floe auth metadata.
 * It must merge pi-ai built-ins with local model/profile metadata without
 * opening credentials. Credential use and refresh belong exclusively to an
 * exact brokered operation or isolated runtime Delivery.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getModels, getProviders, type Model } from "@earendil-works/pi-ai/compat";
import YAML from "yaml";
import { z } from "zod";
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

const ModelsConfigSchema = z.object({
  providers: z.record(z.string(), z.object({
    apiKey: z.string().optional(),
    models: z.array(z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      api: z.string().optional(),
      baseUrl: z.string().optional(),
      reasoning: z.boolean().optional(),
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

const DEFAULT_PROFILES = {
  version: 1,
  profiles: []
} satisfies z.infer<typeof ProfilesDocumentSchema>;

const DEFAULT_MODELS_CONFIG = {
  providers: {}
} satisfies z.infer<typeof ModelsConfigSchema>;

export type AuthProfileRecord = z.infer<typeof ProfileSchema>;

export type AuthModelRecord = {
  id: string;
  name: string;
  provider: string;
  api: string;
  reasoning: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
};

type FloeAuthPaths = {
  authDir: string;
  authJsonPath: string;
  modelsJsonPath: string;
  profilesYamlPath: string;
};

export function listAuthProfiles(configPath: string, config: LocalConfig): AuthProfileRecord[] {
  const paths = getFloeAuthPaths(configPath, config);
  ensureAuthFiles(paths);
  try {
    const raw = readFileSync(paths.profilesYamlPath, "utf8");
    const parsed = raw.trim() ? YAML.parse(raw) : DEFAULT_PROFILES;
    return ProfilesDocumentSchema.parse(parsed).profiles;
  } catch {
    return [];
  }
}

export async function listAuthModels(
  configPath: string,
  config: LocalConfig,
  provider?: string,
  _legacyFetchFn?: unknown,
): Promise<AuthModelRecord[]> {
  const paths = getFloeAuthPaths(configPath, config);
  ensureAuthFiles(paths);
  const registry = new BusModelRegistry(paths.modelsJsonPath);
  return registry.list(provider);
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

class BusModelRegistry {
  private readonly models: Model<any>[] = [];

  constructor(private readonly modelsPath: string) {
    const builtIns = getProviders().flatMap((provider) => getModels(provider as any)) as Model<any>[];
    this.models.push(...builtIns);
    this.applyOverlays();
  }

  async list(provider: string | undefined): Promise<AuthModelRecord[]> {
    return this.models
      .filter((model) => !provider || model.provider === provider)
      .map((model) => ({
        id: model.id,
        name: model.name,
        provider: model.provider,
        api: model.api,
        reasoning: !!model.reasoning,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        input: model.input
      }));
  }

  private applyOverlays(): void {
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
          const existingIndex = this.models.findIndex((model) => model.provider === provider && model.id === modelDef.id);
          if (existingIndex >= 0) this.models[existingIndex] = custom;
          else this.models.push(custom);
        }
      }
    } catch {
      // Keep built-ins only when models.json is unreadable or invalid.
    }
  }
}

function chmodSafe(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort only.
  }
}
