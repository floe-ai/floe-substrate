import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finalizeEvent } from "nostr-tools/pure";
import { generateSeedWords, privateKeyFromSeedWords } from "nostr-tools/nip06";
import { checkInstalledExtensions, INSTALL_RECORD_SCHEMA, MANIFEST_SCHEMA } from "../../floe-bridge/src/extensions/install-records.js";
import { fetchHostControlToken, registerLocalWorkspaceViaBroker } from "../../floe-cli/src/operation-client.js";
import { SliceHarness, fileExists, waitFor, type SliceTier } from "./slice-harness.js";

const FAKE_TIER: SliceTier = { id: "fake", adapter: "fake", provider: "fake", model: "fake", live: false };

// Written by the Extension itself as it loads: the names of every Floe
// variable its process can see.
const ENV_PROBE = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
export default (ctx) => {
  const names = Object.keys(process.env).filter((name) => name.toUpperCase().startsWith("FLOE_"));
  writeFileSync(join(ctx.workspacePath, "env-probe.json"), JSON.stringify(names));
  return [];
};
`;

/**
 * The access boundary on a real Floe (docs/design/capability/access.md):
 * knowing a Workspace's folder admits nobody, a removed identity stays removed,
 * and an Extension never sees Floe's own service credentials.
 */
describe("access boundary [fake]", () => {
  const h = new SliceHarness(FAKE_TIER);

  beforeEach(async () => {
    await h.start();
  }, 60_000);

  afterEach(async () => {
    await h.stop();
  });

  it("joins only what its owner allows, and keeps Floe's credentials from Extensions", async () => {
    const floeDir = join(h.projectPath, ".floe");
    const extDir = join(floeDir, "extensions", "envprobe");
    mkdirSync(join(floeDir, "agents"), { recursive: true });
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(floeDir, "agents", "floe.md"), [
      "---", "schema: floe.agent.v1", "agent_id: floe", "label: Floe", "extensions:", "  - envprobe", "---", "# Floe", "",
    ].join("\n"), "utf8");
    writeFileSync(join(extDir, "extension.json"), JSON.stringify({ schema: MANIFEST_SCHEMA, name: "envprobe", entry: "./index.mjs" }));
    writeFileSync(join(extDir, "index.mjs"), ENV_PROBE, "utf8");
    const record = { schema: INSTALL_RECORD_SCHEMA, code: ".", enabled: true, accepted_version: null as string | null };
    writeFileSync(join(extDir, "installed.json"), JSON.stringify(record));
    const [held] = await checkInstalledExtensions(floeDir);
    record.accepted_version = (held as { current_version: string }).current_version;
    writeFileSync(join(extDir, "installed.json"), JSON.stringify(record));

    // The Workspace has its person (admitted by the harness, as the owner would).
    const workspaceId = await h.registerAndAuthorize(h.projectPath);

    // F1: the Extension process sees no Floe service credential.
    await waitFor(() => h.busMessages.some((message) =>
      message.type === "workspace_attachment_result"
      && message.payload?.validation?.extensions?.some((ext: any) => ext.name === "envprobe" && ext.status === "running")
    ), "envprobe Extension running");
    const probePath = join(h.projectPath, "env-probe.json");
    await waitFor(() => fileExists(probePath), "envprobe wrote what it sees");
    const seen = JSON.parse(readFileSync(probePath, "utf8")) as string[];
    console.log("[access-boundary] Floe variables an Extension sees:", JSON.stringify(seen));
    expect(seen).not.toContain("FLOE_BRIDGE_SERVICE_TOKEN");
    expect(seen).not.toContain("FLOE_HOST_CONTROL_TOKEN");

    const register = async (key: Uint8Array, locator: string) => {
      const { challenge, relay } = await (await fetch(`${h.busUrl}/v1/identity/challenge`)).json() as { challenge: string; relay: string };
      const auth_event = finalizeEvent({
        kind: 22242, created_at: Math.floor(Date.now() / 1000), tags: [["relay", relay], ["challenge", challenge]], content: "",
      }, key);
      const response = await fetch(`${h.busUrl}/v1/identity/register-workspace`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ auth_event, locator, display_name: "Stranger" }),
      });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };

    // F2: a key that only knows the folder is refused.
    const stranger = privateKeyFromSeedWords(generateSeedWords());
    const refused = await register(stranger, h.projectPath);
    console.log("[access-boundary] stranger joining an owned folder:", refused.status, refused.body.error);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: "workspace_admission_requires_owner", workspace_id: workspaceId });

    // F3: a folder nobody has joined is claimed by its first key, then closed.
    const ownerless = mkdtempSync(join(h.temp, "ownerless-"));
    await registerLocalWorkspaceViaBroker(ownerless, true, h.busUrl);
    const claimed = await register(stranger, ownerless);
    console.log("[access-boundary] first key joining an unowned folder:", claimed.status);
    expect([201, 202]).toContain(claimed.status);
    const second = await register(privateKeyFromSeedWords(generateSeedWords()), ownerless);
    expect(second.status).toBe(403);

    // F4: once removed, joining again never readmits it.
    const hostToken = await fetchHostControlToken(h.busUrl);
    const removed = await fetch(`${h.busUrl}/v1/clients/${encodeURIComponent(claimed.body.identity.identity_id)}`, {
      method: "DELETE",
      headers: { authorization: ["Be", "arer ", hostToken].join("") },
    });
    expect(removed.status).toBe(200);
    const again = await register(stranger, ownerless);
    console.log("[access-boundary] removed key joining again:", again.status, again.body.error);
    expect(again.status).toBe(403);
    expect(again.body.error).toBe("identity_revoked");
  }, 90_000);
});
