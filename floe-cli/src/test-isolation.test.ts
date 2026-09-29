/**
 * Proof that the test guard (test-support/isolated-home.ts) holds for the
 * routes that reach a real Floe without touching its folder directly.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureConfig } from "./config.js";
import { fetchHostControlToken, fetchIdentityDeviceKey, forgetIdentityDeviceKey } from "./operation-client.js";
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
  });

  it("the host-control credential is named by bus address, so the real bus address is refused", async () => {
    await expect(fetchHostControlToken("http://127.0.0.1:5377")).rejects.toThrow(/real Floe bus address/);
    await expect(fetch("http://127.0.0.1:5377/v1/health")).rejects.toThrow(/real Floe bus address/);
    expect(guard.violations.splice(0)).toHaveLength(2);
  });
});
