import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadIdentityFile,
  openIdentity,
  openLegacyConsoleFile,
  parseLegacyConsoleFile,
  saveIdentityFile,
  sealIdentity,
  setAsideIdentityFile,
  WrongPassphraseError,
} from "./identity-file.js";
import { generatePhrase, npubOf, publicKeyHex, secretKeyFromPhrase } from "./keys.js";
import { FAST_SCRYPT, legacyConsoleFile } from "./test-support.js";

const homes: string[] = [];
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "floe-identity-file-"));
  homes.push(home);
  return home;
}
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function sealPhrase(protection: "passphrase" | "device", unlock: { passphrase?: string; deviceKey?: Uint8Array }) {
  const phrase = generatePhrase();
  const pubkey = publicKeyHex(secretKeyFromPhrase(phrase));
  const file = sealIdentity({
    secretKind: "phrase",
    secret: Buffer.from(phrase, "utf8"),
    npub: npubOf(pubkey),
    pubkeyHex: pubkey,
    displayName: "Ada",
    protection,
    ...unlock,
    scrypt: FAST_SCRYPT,
  });
  return { phrase, file };
}

describe("identity file", () => {
  it("opens a passphrase seal with the passphrase and refuses a wrong one distinctly", () => {
    const { phrase, file } = sealPhrase("passphrase", { passphrase: "correct horse" });
    expect(openIdentity(file, { passphrase: "correct horse" }).toString("utf8")).toBe(phrase);
    expect(() => openIdentity(file, { passphrase: "wrong" })).toThrow(WrongPassphraseError);
  });

  it("opens a device seal only with the same device key", () => {
    const deviceKey = new Uint8Array(randomBytes(32));
    const { phrase, file } = sealPhrase("device", { deviceKey });
    expect(openIdentity(file, { deviceKey }).toString("utf8")).toBe(phrase);
    expect(() => openIdentity(file, { deviceKey: new Uint8Array(randomBytes(32)) })).toThrow(WrongPassphraseError);
  });

  it("round-trips through the Floe home and sets the old file aside with a date", () => {
    const home = tempHome();
    const { file } = sealPhrase("passphrase", { passphrase: "p" });
    saveIdentityFile(home, file);
    expect(loadIdentityFile(home)).toEqual(file);
    const name = setAsideIdentityFile(home, new Date("2026-09-27T10:00:00.000Z"));
    expect(name).toBe("identity.set-aside-2026-09-27T10-00-00-000Z.json");
    expect(loadIdentityFile(home)).toBeNull();
    expect(readdirSync(join(home, "identity"))).toEqual([name]);
  });

  it("imports the console's phrase files and its earlier raw-key files", () => {
    const phrase = generatePhrase();
    const npub = npubOf(publicKeyHex(secretKeyFromPhrase(phrase)));
    const withPhrase = parseLegacyConsoleFile(legacyConsoleFile(Buffer.from(phrase), npub, "pw", "passphrase"))!;
    expect(openLegacyConsoleFile(withPhrase, "pw").toString("utf8")).toBe(phrase);
    expect(() => openLegacyConsoleFile(withPhrase, "nope")).toThrow(WrongPassphraseError);

    const raw = randomBytes(32);
    const device = parseLegacyConsoleFile(legacyConsoleFile(raw, npubOf(publicKeyHex(raw)), "", "device"))!;
    expect(openLegacyConsoleFile(device, "ignored").equals(raw)).toBe(true);
    expect(parseLegacyConsoleFile({ version: 3 })).toBeNull();
  });
});
