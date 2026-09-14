import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { WindowsDpapiCredentialProtector } from "./windows-dpapi-credential-protector.js";

describe("WindowsDpapiCredentialProtector", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("persists only protected bytes and round-trips through its OS-protection boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floe-dpapi-vault-"));
    temporaryDirectories.push(directory);
    const calls: Array<{ mode: string; input: Uint8Array }> = [];
    const protector = new WindowsDpapiCredentialProtector({
      platform: "win32",
      local_app_data: directory,
      run_dpapi: async (mode, input) => {
        calls.push({ mode, input: Uint8Array.from(input) });
        return mode === "protect"
          ? Uint8Array.from(Buffer.concat([Buffer.from("os-protected:"), Buffer.from(input).reverse()]))
          : Uint8Array.from(Buffer.from(input).subarray("os-protected:".length).reverse());
      },
    });
    const secret = Uint8Array.from(Buffer.from("provider-secret-never-on-disk"));

    await protector.writeAtomic("floe/workspace/ref/one", secret);
    const vaultPath = join(directory, "Floe", "credential-vault", "v1");
    const files = await import("node:fs/promises").then((fs) => fs.readdir(vaultPath));
    expect(files).toHaveLength(1);
    const persisted = await readFile(join(vaultPath, files[0]!));
    expect(persisted.toString("utf8")).not.toContain("provider-secret-never-on-disk");
    expect(Buffer.from(await protector.read("floe/workspace/ref/one") ?? []).toString("utf8"))
      .toBe("provider-secret-never-on-disk");
    expect(calls.map((call) => call.mode)).toEqual(["protect", "unprotect"]);

    await protector.remove("floe/workspace/ref/one");
    expect(await protector.read("floe/workspace/ref/one")).toBeNull();
  });

  it.runIf(process.platform === "win32")("uses Windows CurrentUser DPAPI without a desktop process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floe-real-dpapi-vault-"));
    temporaryDirectories.push(directory);
    const protector = new WindowsDpapiCredentialProtector({ local_app_data: directory });
    const value = Uint8Array.from(Buffer.from(`credential-${Date.now()}`));

    await protector.writeAtomic("floe/integration/ref/one", value);
    expect(await protector.read("floe/integration/ref/one")).toEqual(value);
    const rotated = Uint8Array.from(Buffer.from(`rotated-${Date.now()}`));
    await protector.writeAtomic("floe/integration/ref/one", rotated);
    expect(await protector.read("floe/integration/ref/one")).toEqual(rotated);
  }, 30_000);

  it("refuses unsupported platforms and invalid locators", async () => {
    expect(() => new WindowsDpapiCredentialProtector({ platform: "linux", local_app_data: "unused" }))
      .toThrow("available only on Windows");
    const protector = new WindowsDpapiCredentialProtector({
      platform: "win32",
      local_app_data: "ignored",
      run_dpapi: async (_mode, input) => input,
    });
    await expect(protector.writeAtomic("../outside", Uint8Array.of(1))).rejects.toThrow("locator is invalid");
  });
});
