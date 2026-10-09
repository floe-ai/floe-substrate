/**
 * Proof that the test guard (test-support/isolated-home.ts) holds for the
 * routes that reach a real Floe without touching its folder directly.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { get as httpGet } from "node:http";
import { connect } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureConfig } from "./config.js";
import { fetchHostControlToken, fetchIdentityDeviceKey, forgetHostControlToken, forgetIdentityDeviceKey } from "./operation-client.js";
import { canonicalHome } from "./identity/protocol.js";

const guard = (globalThis as unknown as Record<symbol, { violations: string[] }>)[Symbol.for("floe.test.guard")]!;
const realProfile = userInfo().homedir;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "floe-isolation-"));
  dirs.push(dir);
  return dir;
}

/** Run `action` as if the profile were the real one, then take back the violations it caused. */
async function asRealProfile(action: () => unknown): Promise<string[]> {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = realProfile;
  process.env.USERPROFILE = realProfile;
  try {
    await action();
  } catch {
    // The guard throws; what it recorded is the proof.
  } finally {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
  }
  return guard.violations.splice(0);
}

describe("test isolation", () => {
  it("a new config names the throwaway home, and one naming the real home is refused", async () => {
    expect(homedir()).not.toBe(realProfile);
    const { config, created } = ensureConfig(join(temp(), "config.yaml"));
    expect(created).toBe(true);
    expect(config.home).toBe(join(homedir(), ".floe"));

    const path = join(temp(), "config.yaml");
    const violations = await asRealProfile(() => ensureConfig(path));
    expect(violations.join("\n")).toMatch(/wrote the real Floe home/);
  });

  it("device keys in the OS keyring are named per Floe home, so a test's key is never the real one", async () => {
    const [a, b] = [canonicalHome(join(temp(), ".floe")), canonicalHome(join(temp(), ".floe"))];
    try {
      const keyA = await fetchIdentityDeviceKey(a, true);
      const keyB = await fetchIdentityDeviceKey(b, true);
      expect(keyA).not.toBeNull();
      expect(Buffer.from(keyA!).equals(Buffer.from(keyB!))).toBe(false);
      expect(Buffer.from((await fetchIdentityDeviceKey(a, false))!).equals(Buffer.from(keyA!))).toBe(true);
      expect(await forgetIdentityDeviceKey(a)).toBe(true);
      expect(await fetchIdentityDeviceKey(a, false)).toBeNull();
      expect(await fetchIdentityDeviceKey(b, false)).not.toBeNull();
    } finally {
      await forgetIdentityDeviceKey(a);
      await forgetIdentityDeviceKey(b);
    }

    await expect(fetchIdentityDeviceKey(canonicalHome(join(realProfile, ".floe")), false)).rejects.toThrow(/real Floe home/);
    expect(guard.violations.splice(0).join("\n")).toMatch(/wrote the real Floe home/);
  }, 30_000);

  it("the host-control credential is named by bus address, so the real bus address is refused", async () => {
    await expect(fetchHostControlToken("http://127.0.0.1:5377")).rejects.toThrow(/real Floe bus address/);
    await expect(fetch("http://127.0.0.1:5377/v1/health")).rejects.toThrow(/real Floe bus address/);
    expect(guard.violations.splice(0)).toHaveLength(2);
  });

  it("a throwaway bus's host-control credential can be removed from the OS keyring", async () => {
    const bus = "http://127.0.0.1:59871";
    const first = await fetchHostControlToken(bus);
    expect(await fetchHostControlToken(bus)).toBe(first);
    expect(await forgetHostControlToken(bus)).toBe(true);
    expect(await forgetHostControlToken(bus)).toBe(false);
    expect(await fetchHostControlToken(bus)).not.toBe(first);
    expect(await forgetHostControlToken(bus)).toBe(true);
    await expect(forgetHostControlToken("http://127.0.0.1:5377")).rejects.toThrow(/real Floe bus address/);
    expect(guard.violations.splice(0)).toHaveLength(1);
  }, 30_000);

  it("any other connection to the real bus address is refused: WebSocket, http, raw socket", async () => {
    const attempts: Array<() => Promise<unknown>> = [
      () => new Promise((settle) => {
        const socket = new WebSocket("ws://127.0.0.1:5377/v1/events/stream");
        socket.onerror = settle;
        socket.onclose = settle;
      }),
      () => new Promise((settle) => {
        const request = httpGet("http://localhost:5377/v1/health", settle);
        request.on("error", settle);
      }),
      () => new Promise((settle) => {
        const socket = connect({ host: "::1", port: 5377 }, () => settle(null));
        socket.on("error", settle);
      }),
    ];
    for (const attempt of attempts) {
      await attempt().catch((error) => error);
      const found = guard.violations.splice(0);
      expect(found.join("\n")).toMatch(/real Floe bus address: net\.Socket\.connect/);
    }
  });
});
