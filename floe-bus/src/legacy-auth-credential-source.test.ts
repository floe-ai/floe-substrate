import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LegacyAuthCredentialSource } from "./legacy-auth-credential-source.js";

describe("LegacyAuthCredentialSource", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("selects one verified profile credential and preserves the legacy files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floe-legacy-auth-source-"));
    directories.push(directory);
    const profilesPath = join(directory, "profiles.yaml");
    const authPath = join(directory, "auth.json");
    const auth = JSON.stringify({
      "openai-codex": { type: "oauth", access: "access-material", refresh: "refresh-material", expires: 4_000_000_000_000 },
      anthropic: { type: "api_key", key: "other-secret" },
    }, null, 2);
    await writeFile(profilesPath, "version: 1\nprofiles:\n  - id: codex-personal\n    provider: openai-codex\n", "utf8");
    await writeFile(authPath, auth, "utf8");
    const fingerprint = `sha256:${createHash("sha256").update(auth).digest("hex")}`;

    const selected = await new LegacyAuthCredentialSource(profilesPath, authPath).read({
      profile_id: "codex-personal",
      source_fingerprint: fingerprint,
    });
    expect(selected.provider_id).toBe("openai-codex");
    expect(JSON.parse(Buffer.from(selected.material).toString("utf8"))).toEqual({
      type: "oauth",
      access: "access-material",
      refresh: "refresh-material",
      expires: 4_000_000_000_000,
    });
    expect(await readFile(authPath, "utf8")).toBe(auth);
  });

  it("refuses a changed source before returning credential material", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floe-legacy-auth-source-"));
    directories.push(directory);
    const profilesPath = join(directory, "profiles.yaml");
    const authPath = join(directory, "auth.json");
    await writeFile(profilesPath, "version: 1\nprofiles:\n  - id: personal\n    provider: anthropic\n", "utf8");
    await writeFile(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "secret" } }), "utf8");

    await expect(new LegacyAuthCredentialSource(profilesPath, authPath).read({
      profile_id: "personal",
      source_fingerprint: `sha256:${"0".repeat(64)}`,
    })).rejects.toMatchObject({ code: "legacy_source_changed" });
  });
});
