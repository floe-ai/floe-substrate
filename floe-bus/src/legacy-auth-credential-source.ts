import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import YAML from "yaml";

export type LegacyAuthCredentialSourceRequest = Readonly<{
  profile_id: string;
  source_fingerprint: string;
}>;

export type TrustedCredentialMaterial = Readonly<{
  provider_id: string;
  material: Uint8Array;
}>;

/**
 * Explicit migration-only reader for the legacy Pi auth files. It returns one
 * credential to trusted broker code and never changes or deletes the source.
 */
export class LegacyAuthCredentialSource {
  constructor(
    private readonly profilesPath: string,
    private readonly authPath: string,
  ) {}

  async read(request: LegacyAuthCredentialSourceRequest): Promise<TrustedCredentialMaterial> {
    const profileId = safeId(request.profile_id, "legacy profile ID");
    const expectedFingerprint = safeFingerprint(request.source_fingerprint);
    let authBytes: Buffer;
    let profileText: string;
    try {
      [authBytes, profileText] = await Promise.all([
        readFile(this.authPath),
        readFile(this.profilesPath, "utf8"),
      ]);
    } catch {
      throw new LegacyCredentialSourceError("legacy_source_unavailable");
    }
    try {
      const actualFingerprint = `sha256:${createHash("sha256").update(authBytes).digest("hex")}`;
      if (actualFingerprint !== expectedFingerprint) {
        throw new LegacyCredentialSourceError("legacy_source_changed");
      }
      const profiles = parseProfiles(profileText);
      const profile = profiles.find((candidate) => candidate.id === profileId);
      if (!profile) throw new LegacyCredentialSourceError("legacy_profile_not_found");
      const auth = parseAuth(authBytes);
      const credential = auth[profile.provider];
      if (!credential) throw new LegacyCredentialSourceError("legacy_credential_not_found");
      const material = Uint8Array.from(Buffer.from(JSON.stringify(credential), "utf8"));
      if (material.byteLength === 0) throw new LegacyCredentialSourceError("legacy_credential_invalid");
      return { provider_id: profile.provider, material };
    } finally {
      authBytes.fill(0);
    }
  }
}

export type LegacyCredentialSourceFailure =
  | "legacy_source_unavailable"
  | "legacy_source_changed"
  | "legacy_profile_not_found"
  | "legacy_credential_not_found"
  | "legacy_credential_invalid";

export class LegacyCredentialSourceError extends Error {
  constructor(readonly code: LegacyCredentialSourceFailure) {
    super("The selected legacy credential could not be verified for migration.");
    this.name = "LegacyCredentialSourceError";
  }
}

function parseProfiles(text: string): Array<{ id: string; provider: string }> {
  let value: unknown;
  try {
    value = YAML.parse(text);
  } catch {
    throw new LegacyCredentialSourceError("legacy_credential_invalid");
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.profiles)) {
    throw new LegacyCredentialSourceError("legacy_credential_invalid");
  }
  return value.profiles.map((item) => {
    if (!isRecord(item)) throw new LegacyCredentialSourceError("legacy_credential_invalid");
    return {
      id: safeId(item.id, "legacy profile ID"),
      provider: safeId(item.provider, "legacy provider ID"),
    };
  });
}

function parseAuth(bytes: Uint8Array): Record<string, Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new LegacyCredentialSourceError("legacy_credential_invalid");
  }
  if (!isRecord(value)) throw new LegacyCredentialSourceError("legacy_credential_invalid");
  const result: Record<string, Record<string, unknown>> = {};
  for (const [provider, credential] of Object.entries(value)) {
    safeId(provider, "legacy provider ID");
    if (!isRecord(credential) || (credential.type !== "api_key" && credential.type !== "oauth")) {
      throw new LegacyCredentialSourceError("legacy_credential_invalid");
    }
    if (credential.type === "api_key" && (typeof credential.key !== "string" || !credential.key)) {
      throw new LegacyCredentialSourceError("legacy_credential_invalid");
    }
    if (credential.type === "oauth" && (
      typeof credential.access !== "string" || !credential.access
      || typeof credential.refresh !== "string" || !credential.refresh
      || typeof credential.expires !== "number" || !Number.isFinite(credential.expires)
    )) {
      throw new LegacyCredentialSourceError("legacy_credential_invalid");
    }
    result[provider] = credential;
  }
  return result;
}

function safeFingerprint(value: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new LegacyCredentialSourceError("legacy_credential_invalid");
  }
  return value;
}

function safeId(value: unknown, _label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/.test(value)) {
    throw new LegacyCredentialSourceError("legacy_credential_invalid");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
