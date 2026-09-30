import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IdentityAgent, type AgentConnection } from "./agent.js";
import { generatePhrase, npubOf, publicKeyHex, secretKeyFromPhrase } from "./keys.js";
import { FAST_SCRYPT, FakeBus, ManualTimers, legacyConsoleFile } from "./test-support.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setup(options: { vault?: Map<string, Uint8Array>; home?: string } = {}) {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "floe-agent-"));
  homes.push(home);
  const vault = options.vault ?? new Map<string, Uint8Array>();
  const timers = new ManualTimers();
  let now = Date.parse("2026-09-27T10:00:00.000Z");
  const bus = new FakeBus(() => now);
  const agent = new IdentityAgent({
    home,
    busUrl: "http://fake-bus",
    version: "0.3.0",
    lockAfterIdleMs: 15 * 60_000,
    // The vault is scoped by home, as the broker scopes it.
    deviceKey: async (create) => {
      if (!vault.has(home) && create) vault.set(home, new Uint8Array(randomBytes(32)));
      return vault.get(home) ?? null;
    },
    forgetDeviceKey: async () => vault.delete(home),
    hostToken: async () => bus.hostToken,
    fetch: bus.fetch,
    now: () => now,
    setTimer: timers.set,
    clearTimer: timers.clear,
    scrypt: FAST_SCRYPT,
  });
  const messages: Array<Record<string, any>> = [];
  const conn: AgentConnection = { surface: "test", send: (message) => messages.push(message) };
  agent.attach(conn);
  return { agent, conn, bus, timers, home, vault, messages, advance: (ms: number) => { now += ms; } };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() {
  for (let i = 0; i < 20; i += 1) await tick();
}

describe("identity agent", () => {
  it("creates, locks, refuses a wrong passphrase distinctly, unlocks and reveals", async () => {
    const { agent, conn, messages } = setup();
    expect(agent.state()).toEqual({ kind: "none" });
    const created = await agent.handle(conn, "create", { display_name: "Ada", passphrase: "secret" }) as { npub: string; phrase: string };
    expect(created.phrase.split(" ")).toHaveLength(12);
    expect(agent.state()).toMatchObject({ kind: "unlocked", npub: created.npub, protection: "passphrase", secret_kind: "phrase" });
    expect(messages.at(-1)).toMatchObject({ type: "state", state: { kind: "unlocked" } });

    await agent.handle(conn, "lock", {});
    expect(agent.state().kind).toBe("locked");
    await expect(agent.handle(conn, "unlock", { passphrase: "wrong" })).rejects.toMatchObject({ code: "wrong_passphrase" });
    await agent.handle(conn, "unlock", { passphrase: "secret" });
    expect(agent.state().kind).toBe("unlocked");

    await expect(agent.handle(conn, "reveal", {})).rejects.toMatchObject({ code: "passphrase_required" });
    await expect(agent.handle(conn, "reveal", { passphrase: "nope" })).rejects.toMatchObject({ code: "wrong_passphrase" });
    expect(await agent.handle(conn, "reveal", { passphrase: "secret" })).toEqual({ secret_kind: "phrase", secret: created.phrase });
    await expect(agent.handle(conn, "create", { display_name: "Ada", passphrase: "x" })).rejects.toMatchObject({ code: "identity_exists" });
  });

  it("protects with the device when the passphrase is blank, and a different home cannot open it", async () => {
    const vault = new Map<string, Uint8Array>();
    const first = setup({ vault });
    const created = await first.agent.handle(first.conn, "create", { display_name: "Ada", passphrase: "" }) as { npub: string; phrase: string };
    expect(first.agent.state()).toMatchObject({ kind: "unlocked", protection: "device" });
    await first.agent.handle(first.conn, "lock", {});
    await first.agent.handle(first.conn, "unlock", {});
    expect(first.agent.state().kind).toBe("unlocked");
    await expect(first.agent.handle(first.conn, "reveal", {})).rejects.toMatchObject({ code: "confirmation_required" });
    expect(await first.agent.handle(first.conn, "reveal", { confirm: true })).toMatchObject({ secret: created.phrase });

    // A copy of the Floe home at another path has no vault key.
    const copyHome = mkdtempSync(join(tmpdir(), "floe-agent-copy-"));
    const { cpSync } = await import("node:fs");
    cpSync(join(first.home, "identity"), join(copyHome, "identity"), { recursive: true });
    const copy = setup({ vault, home: copyHome });
    expect(copy.agent.state()).toMatchObject({ kind: "locked", npub: created.npub });
    await expect(copy.agent.handle(copy.conn, "unlock", {})).rejects.toMatchObject({ code: "device_key_unavailable" });

    // Restoring from the phrase there gives the same identity.
    const restored = await copy.agent.handle(copy.conn, "restore", { phrase: created.phrase, passphrase: "" }) as { npub: string };
    expect(restored.npub).toBe(created.npub);
    expect(copy.agent.state()).toMatchObject({ kind: "unlocked", npub: created.npub, display_name: "Ada" });
  });

  it("restores from the phrase after a forgotten passphrase, keeping the npub and setting the old file aside", async () => {
    const { agent, conn, home } = setup();
    const created = await agent.handle(conn, "create", { display_name: "Ada", passphrase: "forgotten" }) as { npub: string; phrase: string };
    await agent.handle(conn, "lock", {});
    await expect(agent.handle(conn, "restore", { phrase: "not a phrase", passphrase: "new" })).rejects.toMatchObject({ code: "invalid_phrase" });
    const restored = await agent.handle(conn, "restore", { phrase: created.phrase, passphrase: "new" }) as { npub: string; set_aside_as: string };
    expect(restored.npub).toBe(created.npub);
    expect(restored.set_aside_as).toMatch(/^identity\.set-aside-.*\.json$/);
    expect(readdirSync(join(home, "identity")).sort()).toEqual(["identity.json", restored.set_aside_as].sort());
    await agent.handle(conn, "lock", {});
    await agent.handle(conn, "unlock", { passphrase: "new" });

    const other = generatePhrase();
    await expect(agent.handle(conn, "restore", { phrase: other, passphrase: "x", display_name: "B" })).rejects.toMatchObject({ code: "identity_exists" });
  });

  it("looks up a folder's workspace without registering it", async () => {
    const { agent, conn, bus } = setup();
    await agent.handle(conn, "create", { display_name: "Ada", passphrase: "p" });
    expect(await agent.handle(conn, "workspace_for_folder", { locator: "C:/work/alpha" })).toEqual({ kind: "none" });
    expect(bus.identities.size).toBe(0);
    await agent.handle(conn, "join_folder", { locator: "C:/work/alpha" });
    expect(await agent.handle(conn, "workspace_for_folder", { locator: "C:/work/alpha" })).toMatchObject({
      kind: "workspace",
      workspace: { workspace_id: "workspace:C:/work/alpha", folder_path: "C:/work/alpha" },
      joined: true,
    });
    await agent.handle(conn, "lock", {});
    await expect(agent.handle(conn, "workspace_for_folder", { locator: "C:/work/alpha" })).rejects.toMatchObject({ code: "locked" });
  });

  it("lists the identity's workspaces without a session or a bearer", async () => {
    const { agent, conn, bus } = setup();
    await agent.handle(conn, "create", { display_name: "Ada", passphrase: "p" });
    expect(await agent.handle(conn, "list_workspaces", {})).toEqual({ workspaces: [] });
    await agent.handle(conn, "join_folder", { locator: "C:/work/alpha" });
    const listed = await agent.handle(conn, "list_workspaces", {}) as { workspaces: Array<{ workspace_id: string }> };
    expect(listed.workspaces.map((w) => w.workspace_id)).toEqual(["workspace:C:/work/alpha"]);
    expect(bus.authentications).toBe(0);
    expect(await agent.handle(conn, "sessions", {})).toEqual({ sessions: [] });
  });

  it("replaces a forgotten identity with a new one admitted to the same workspaces, revoking the old", async () => {
    const { agent, conn, bus, home } = setup();
    const old = await agent.handle(conn, "create", { display_name: "Ada", passphrase: "forgotten" }) as { npub: string };
    await agent.handle(conn, "join_folder", { locator: "C:/work/alpha" });
    await agent.handle(conn, "join_folder", { locator: "C:/work/beta" });
    await agent.handle(conn, "lock", {});

    const result = await agent.handle(conn, "replace", { passphrase: "fresh" }) as Record<string, any>;
    expect(result.npub).not.toBe(old.npub);
    expect(result.previous_npub).toBe(old.npub);
    expect(result.previous_revoked).toBe(true);
    expect(result.workspaces.map((w: { name: string }) => w.name)).toEqual(["alpha", "beta"]);
    expect(readdirSync(join(home, "identity"))).toContain(result.set_aside_as);
    const identities = [...bus.identities.values()];
    expect(identities.find((entry) => npubOf(entry.pubkey_hex) === old.npub)?.revoked_at).toBeTruthy();
    expect(identities.find((entry) => npubOf(entry.pubkey_hex) === result.npub)?.workspaces).toHaveLength(2);
    expect(agent.state()).toMatchObject({ kind: "unlocked", npub: result.npub, display_name: "Ada" });
  });

  it("changes nothing when replace cannot reach the bus", async () => {
    const { agent, conn, home } = setup();
    await agent.handle(conn, "create", { display_name: "Ada", passphrase: "p" });
    const offline = new IdentityAgent({
      home, busUrl: "http://fake-bus", version: null, lockAfterIdleMs: 60_000,
      deviceKey: async () => null,
      forgetDeviceKey: async () => false,
      hostToken: async () => { throw new Error("broker unavailable"); },
      scrypt: FAST_SCRYPT,
    });
    await expect(offline.handle(conn, "replace", { passphrase: "q" })).rejects.toMatchObject({ code: "bus_unreachable" });
    expect(readdirSync(join(home, "identity"))).toEqual(["identity.json"]);
  });

  it("lists the identities it holds, npub only when asked, and deletes one set aside", async () => {
    const { agent, conn, home } = setup();
    const created = await agent.handle(conn, "create", { display_name: "Ada", passphrase: "p" }) as { npub: string; phrase: string };
    const restored = await agent.handle(conn, "restore", { phrase: created.phrase, passphrase: "q" }) as { set_aside_as: string };
    const setAsideId = restored.set_aside_as.replace(/^identity\./, "").replace(/\.json$/, "");

    const { identities } = await agent.handle(conn, "list_identities", {}) as { identities: Array<Record<string, unknown>> };
    expect(identities).toEqual([
      { id: "current", current: true, readable: true, display_name: "Ada", created_at: expect.any(String), set_aside_at: null, protection: "passphrase", has_recovery_phrase: true },
      { id: setAsideId, current: false, readable: true, display_name: "Ada", created_at: expect.any(String), set_aside_at: expect.stringMatching(/Z$/), protection: "passphrase", has_recovery_phrase: true },
    ]);
    const withNpub = await agent.handle(conn, "list_identities", { include_npub: true }) as { identities: Array<{ npub: string }> };
    expect(withNpub.identities.map((entry) => entry.npub)).toEqual([created.npub, created.npub]);

    await expect(agent.handle(conn, "delete_identity", { id: "../identity" })).rejects.toMatchObject({ code: "identity_not_found" });
    await expect(agent.handle(conn, "delete_identity", { id: setAsideId })).rejects.toMatchObject({ code: "confirmation_required" });
    expect(await agent.handle(conn, "delete_identity", { id: setAsideId, confirm: true }))
      .toEqual({ deleted: setAsideId, revoked_admissions: null, device_key_removed: false });
    expect(readdirSync(join(home, "identity"))).toEqual(["identity.json"]);
    expect(agent.state().kind).toBe("unlocked");
  });

  it("deletes the current identity only with its passphrase and a revoke choice, revoking at the bus first", async () => {
    const { agent, conn, bus, home, messages } = setup();
    const created = await agent.handle(conn, "create", { display_name: "Ada", passphrase: "p" }) as { npub: string };
    await agent.handle(conn, "join_folder", { locator: "C:/work/alpha" });

    await expect(agent.handle(conn, "delete_identity", { id: "current", confirm: true, passphrase: "p" })).rejects.toMatchObject({ code: "revoke_choice_required" });
    await expect(agent.handle(conn, "delete_identity", { id: "current", confirm: true, revoke_admissions: true })).rejects.toMatchObject({ code: "passphrase_required" });
    await expect(agent.handle(conn, "delete_identity", { id: "current", confirm: true, revoke_admissions: true, passphrase: "x" })).rejects.toMatchObject({ code: "wrong_passphrase" });
    expect(agent.state().kind).toBe("unlocked");

    const result = await agent.handle(conn, "delete_identity", { id: "current", confirm: true, revoke_admissions: true, passphrase: "p" }) as Record<string, any>;
    expect(result).toMatchObject({ deleted: "current", revoked_admissions: { revoked: true }, device_key_removed: false });
    expect(result.revoked_admissions.workspaces.map((w: { name: string }) => w.name)).toEqual(["alpha"]);
    expect([...bus.identities.values()].find((entry) => npubOf(entry.pubkey_hex) === created.npub)?.revoked_at).toBeTruthy();
    expect(readdirSync(join(home, "identity"))).toEqual([]);
    expect(agent.state()).toEqual({ kind: "none" });
    expect(messages.at(-1)).toMatchObject({ type: "state", state: { kind: "none" } });
  });

  it("removes the device key only when no identity it holds still needs it", async () => {
    const { agent, conn, home, vault } = setup();
    const created = await agent.handle(conn, "create", { display_name: "Ada", passphrase: "" }) as { phrase: string };
    const restored = await agent.handle(conn, "restore", { phrase: created.phrase, passphrase: "" }) as { set_aside_as: string };
    const setAsideId = restored.set_aside_as.replace(/^identity\./, "").replace(/\.json$/, "");

    expect(await agent.handle(conn, "delete_identity", { id: setAsideId, confirm: true })).toMatchObject({ device_key_removed: false });
    expect(vault.has(home)).toBe(true);
    expect(await agent.handle(conn, "delete_identity", { id: "current", confirm: true, revoke_admissions: false }))
      .toEqual({ deleted: "current", revoked_admissions: null, device_key_removed: true });
    expect(vault.has(home)).toBe(false);
    expect(agent.state()).toEqual({ kind: "none" });
  });

  it("deletes nothing when it cannot reach the bus to revoke, and needs no bus when told not to revoke", async () => {
    const { agent, conn, home } = setup();
    await agent.handle(conn, "create", { display_name: "Ada", passphrase: "p" });
    const offline = new IdentityAgent({
      home, busUrl: "http://fake-bus", version: null, lockAfterIdleMs: 60_000,
      deviceKey: async () => null,
      forgetDeviceKey: async () => false,
      hostToken: async () => { throw new Error("broker unavailable"); },
      scrypt: FAST_SCRYPT,
    });
    await expect(offline.handle(conn, "delete_identity", { id: "current", confirm: true, revoke_admissions: true, passphrase: "p" })).rejects.toMatchObject({ code: "bus_unreachable" });
    expect(readdirSync(join(home, "identity"))).toEqual(["identity.json"]);
    expect(await offline.handle(conn, "delete_identity", { id: "current", confirm: true, revoke_admissions: false, passphrase: "p" }))
      .toMatchObject({ deleted: "current", revoked_admissions: null });
    expect(readdirSync(join(home, "identity"))).toEqual([]);
  });

  it("pushes a bearer, and a fresh one before expiry from a timer on the known expiry", async () => {
    const { agent, conn, messages, timers, bus, advance } = setup();
    await agent.handle(conn, "create", { display_name: "Ada", passphrase: "p" });
    const { session_id } = await agent.handle(conn, "session", {}) as { session_id: string };
    await settle();
    expect(messages.filter((m) => m.type === "session").at(-1)).toMatchObject({ session_id, status: "needs_workspace" });

    await agent.handle(conn, "join_folder", { locator: "C:/work/alpha" });
    await settle();
    const first = messages.filter((m) => m.type === "session").at(-1)!;
    expect(first).toMatchObject({ session_id, status: "ready", workspace: { name: "alpha" } });
    expect(first.bearer_token).toMatch(/^bearer-/);

    // One timer, set for one minute before the expiry; nothing else is scheduled.
    expect(timers.delays()).toEqual([3_600_000 - 60_000]);
    const authenticationsBefore = bus.authentications;
    advance(3_540_000);
    timers.fireAll();
    await settle();
    const renewed = messages.filter((m) => m.type === "session").at(-1)!;
    expect(renewed.status).toBe("ready");
    expect(renewed.bearer_token).not.toBe(first.bearer_token);
    expect(bus.authentications).toBe(authenticationsBefore + 1);
  });

  it("asks the surface to choose when the identity is in several workspaces", async () => {
    const { agent, conn, messages } = setup();
    await agent.handle(conn, "create", { display_name: "Ada", passphrase: "p" });
    await agent.handle(conn, "join_folder", { locator: "C:/work/alpha" });
    await agent.handle(conn, "join_folder", { locator: "C:/work/beta" });
    const { session_id } = await agent.handle(conn, "session", {}) as { session_id: string };
    await settle();
    expect(messages.at(-1)).toMatchObject({ session_id, status: "selection_required" });
    await agent.handle(conn, "select_workspace", { session_id, workspace_id: "workspace:C:/work/beta" });
    await settle();
    expect(messages.at(-1)).toMatchObject({ session_id, status: "ready", workspace: { name: "beta" } });
  });

  it("ends sessions and revokes their bearers on lock, and on disconnect", async () => {
    const { agent, conn, messages, bus } = setup();
    await agent.handle(conn, "create", { display_name: "Ada", passphrase: "p" });
    await agent.handle(conn, "join_folder", { locator: "C:/work/alpha" });
    const { session_id } = await agent.handle(conn, "session", {}) as { session_id: string };
    await settle();
    await agent.handle(conn, "lock", {});
    await settle();
    expect(messages.filter((m) => m.type === "session").at(-1)).toMatchObject({ session_id, status: "ended", reason: "locked" });
    expect(bus.revokedSessions).toHaveLength(1);

    await agent.handle(conn, "unlock", { passphrase: "p" });
    await agent.handle(conn, "session", {});
    await settle();
    agent.detach(conn);
    await settle();
    expect(bus.revokedSessions).toHaveLength(2);
  });

  it("revokes one surface's session when the person asks", async () => {
    const { agent, conn, messages, bus } = setup();
    await agent.handle(conn, "create", { display_name: "Ada", passphrase: "p" });
    await agent.handle(conn, "join_folder", { locator: "C:/work/alpha" });
    const { session_id } = await agent.handle(conn, "session", {}) as { session_id: string };
    await settle();
    expect((await agent.handle(conn, "sessions", {}) as { sessions: unknown[] }).sessions).toHaveLength(1);
    await agent.handle(conn, "revoke_session", { session_id });
    expect(messages.at(-1)).toMatchObject({ session_id, status: "ended", reason: "revoked" });
    expect(bus.revokedSessions).toHaveLength(1);
    expect((await agent.handle(conn, "sessions", {}) as { sessions: unknown[] }).sessions).toHaveLength(0);
  });

  it("locks after the idle period once no surface is connected, and not while one is", async () => {
    const { agent, conn, timers } = setup();
    await agent.handle(conn, "create", { display_name: "Ada", passphrase: "p" });
    expect(timers.delays()).toEqual([]);
    agent.detach(conn);
    expect(timers.delays()).toEqual([15 * 60_000]);
    agent.attach(conn);
    expect(timers.delays()).toEqual([]);
    agent.detach(conn);
    timers.fireAll();
    expect(agent.state().kind).toBe("locked");
  });

  it("imports the console's files: a phrase file and a raw-key file with no phrase", async () => {
    const { agent, conn } = setup();
    const phrase = generatePhrase();
    const npub = npubOf(publicKeyHex(secretKeyFromPhrase(phrase)));
    const file = legacyConsoleFile(Buffer.from(phrase), npub, "pw", "passphrase");
    await expect(agent.handle(conn, "import_legacy", { file, passphrase: "bad", display_name: "Ada" })).rejects.toMatchObject({ code: "wrong_passphrase" });
    expect(await agent.handle(conn, "import_legacy", { file, passphrase: "pw", display_name: "Ada" })).toMatchObject({ npub, secret_kind: "phrase", protection: "passphrase" });
    expect(await agent.handle(conn, "import_legacy", { file, passphrase: "pw" })).toMatchObject({ already_present: true });

    const second = setup();
    const raw = randomBytes(32);
    const rawNpub = npubOf(publicKeyHex(raw));
    const rawFile = legacyConsoleFile(raw, rawNpub, "", "device");
    await expect(second.agent.handle(second.conn, "import_legacy", { file: rawFile, passphrase: "" })).rejects.toMatchObject({ code: "display_name_required" });
    expect(await second.agent.handle(second.conn, "import_legacy", { file: rawFile, passphrase: "", display_name: "Ada" }))
      .toMatchObject({ npub: rawNpub, secret_kind: "nsec", protection: "device" });
    const revealed = await second.agent.handle(second.conn, "reveal", { confirm: true }) as { secret_kind: string; secret: string };
    expect(revealed.secret_kind).toBe("nsec");
    expect(revealed.secret).toMatch(/^nsec1/);
  });
});
