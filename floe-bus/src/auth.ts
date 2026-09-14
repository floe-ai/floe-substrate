/**
 * @invariant This module is the bus-local read model for Floe auth metadata.
 * Floe does NOT broker model credentials and holds no built-in provider
 * catalogue: model authentication belongs to the vendor CLI driven by
 * floe-runtime. The only models this module reports are those a workspace has
 * explicitly declared in its local models.json. Profiles are read from
 * profiles.yaml. This module opens no credentials and imports no provider SDK.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

/**
 * List the models Floe knows about for a provider. Floe reports only the models
 * a workspace has explicitly declared in models.json; there is no built-in
 * catalogue. If a client needs the live list a vendor CLI supports, it asks the
 * vendor CLI through floe-runtime, not Floe.
 */
export async function listAuthModels(
  configPath: string,
  config: LocalConfig,
  provider?: string,
): Promise<AuthModelRecord[]> {
  const paths = getFloeAuthPaths(configPath, config);
  ensureAuthFiles(paths);
  return readDeclaredModels(paths.modelsJsonPath, provider);
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

function readDeclaredModels(modelsPath: string, provider: string | undefined): AuthModelRecord[] {
  let parsed: z.infer<typeof ModelsConfigSchema>;
  try {
    parsed = ModelsConfigSchema.parse(JSON.parse(readFileSync(modelsPath, "utf8")));
  } catch {
    return [];
  }
  const records: AuthModelRecord[] = [];
  for (const [providerId, providerConfig] of Object.entries(parsed.providers)) {
    if (provider && providerId !== provider) continue;
    for (const modelDef of providerConfig.models ?? []) {
      records.push({
        id: modelDef.id,
        name: modelDef.name ?? modelDef.id,
        provider: providerId,
        api: modelDef.api ?? "openai-responses",
        reasoning: modelDef.reasoning ?? false,
        contextWindow: modelDef.contextWindow,
        maxTokens: modelDef.maxTokens,
        input: modelDef.input
      });
    }
  }
  return records;
}

function chmodSafe(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort only.
  }
}
