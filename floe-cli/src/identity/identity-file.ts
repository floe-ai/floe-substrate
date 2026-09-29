/**
 * The identity as it rests on disk under the Floe home, and the one legacy
 * format Floe can import.
 *
 * What is sealed is the recovery phrase (so it can be revealed for backup), or
 * for an identity made before phrases existed, the raw 32-byte key. The file
 * says which (`secret_kind`), so the format is never guessed by decrypting.
 *
 * Two protections, one cipher (AES-256-GCM, whose tag makes a wrong key fail
 * loudly):
 *  - `passphrase`: the wrapping key is scrypt(passphrase).
 *  - `device`: the person chose a blank passphrase. The wrapping key is a
 *    random key in the OS credential vault, held for this Floe home's location,
 *    so a copied Floe home cannot open it.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export type Protection = "passphrase" | "device";
export type SecretKind = "phrase" | "nsec";

export type ScryptParams = { N: number; r: number; p: number };

/** OWASP scrypt minimums for a file at rest; the same the console used. */
export const SCRYPT_PARAMS: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

const CipherSchema = z.object({
  name: z.literal("aes-256-gcm"),
  iv: z.string().min(1),
  ciphertext: z.string().min(1),
  tag: z.string().min(1),
}).strict();

const IdentityFileSchema = z.object({
  version: z.literal(2),
  npub: z.string().min(1),
  pubkey_hex: z.string().regex(/^[0-9a-f]{64}$/),
  display_name: z.string().min(1).max(200),
  created_at: z.string().min(1),
  protection: z.enum(["passphrase", "device"]),
  secret_kind: z.enum(["phrase", "nsec"]),
  seal: z.discriminatedUnion("name", [
    z.object({
      name: z.literal("scrypt"),
      N: z.number().int().positive(),
      r: z.number().int().positive(),
      p: z.number().int().positive(),
      salt: z.string().min(1),
    }).strict(),
    z.object({ name: z.literal("os-vault") }).strict(),
  ]),
  cipher: CipherSchema,
}).strict();

export type IdentityFile = z.infer<typeof IdentityFileSchema>;

export class WrongPassphraseError extends Error {
  constructor() {
    super("That passphrase did not unlock this identity.");
    this.name = "WrongPassphraseError";
  }
}

export type SealInput = {
  secretKind: SecretKind;
  /** UTF-8 phrase bytes, or the raw 32-byte key. */
  secret: Uint8Array;
  npub: string;
  pubkeyHex: string;
  displayName: string;
  protection: Protection;
  /** Required for `passphrase`. */
  passphrase?: string;
  /** Required for `device`: the vault wrapping key (32 bytes). */
  deviceKey?: Uint8Array;
  scrypt?: ScryptParams;
  createdAt?: string;
};

export function sealIdentity(input: SealInput): IdentityFile {
  const iv = randomBytes(12);
  let wrappingKey: Buffer;
  let seal: IdentityFile["seal"];
  if (input.protection === "passphrase") {
    if (!input.passphrase) throw new Error("A passphrase-protected identity needs a passphrase.");
    const params = input.scrypt ?? SCRYPT_PARAMS;
    const salt = randomBytes(16);
    wrappingKey = scryptKey(input.passphrase, salt, params);
    seal = { name: "scrypt", N: params.N, r: params.r, p: params.p, salt: salt.toString("base64") };
  } else {
    if (!input.deviceKey || input.deviceKey.length !== 32) throw new Error("A device-protected identity needs the device key.");
    wrappingKey = Buffer.from(input.deviceKey);
    seal = { name: "os-vault" };
  }
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, iv);
  const ciphertext = Buffer.concat([cipher.update(input.secret), cipher.final()]);
  const tag = cipher.getAuthTag();
  wrappingKey.fill(0);
  return {
    version: 2,
    npub: input.npub,
    pubkey_hex: input.pubkeyHex,
    display_name: input.displayName,
    created_at: input.createdAt ?? new Date().toISOString(),
    protection: input.protection,
    secret_kind: input.secretKind,
    seal,
    cipher: {
      name: "aes-256-gcm",
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: tag.toString("base64"),
    },
  };
}

/** Decrypt the sealed secret. Throws WrongPassphraseError when the key does not fit. */
export function openIdentity(file: IdentityFile, unlock: { passphrase?: string; deviceKey?: Uint8Array }): Buffer {
  const wrappingKey = file.seal.name === "scrypt"
    ? scryptKey(unlock.passphrase ?? "", Buffer.from(file.seal.salt, "base64"), file.seal)
    : Buffer.from(unlock.deviceKey ?? new Uint8Array(32));
  return decrypt(file.cipher, wrappingKey);
}

function scryptKey(passphrase: string, salt: Buffer, params: ScryptParams): Buffer {
  return scryptSync(passphrase.normalize("NFKC"), salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM });
}

function decrypt(cipher: z.infer<typeof CipherSchema>, wrappingKey: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", wrappingKey, Buffer.from(cipher.iv, "base64"));
  decipher.setAuthTag(Buffer.from(cipher.tag, "base64"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(cipher.ciphertext, "base64")), decipher.final()]);
  } catch {
    throw new WrongPassphraseError();
  } finally {
    wrappingKey.fill(0);
  }
}

// ── where it lives ───────────────────────────────────────────────────────────

export function identityDir(home: string): string {
  return join(home, "identity");
}

export function identityFilePath(home: string): string {
  return join(identityDir(home), "identity.json");
}

export function loadIdentityFile(home: string): IdentityFile | null {
  const path = identityFilePath(home);
  if (!existsSync(path)) return null;
  const parsed = parseIdentityFile(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed) {
    throw new Error(`The identity at ${path} is unreadable. Set it aside and restore from the recovery phrase.`);
  }
  return parsed;
}

/** The identity file format, or null when the value is not one. */
export function parseIdentityFile(value: unknown): IdentityFile | null {
  const parsed = IdentityFileSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Write atomically, so a crash never leaves half an identity. */
export function saveIdentityFile(home: string, file: IdentityFile): void {
  const dir = identityDir(home);
  mkdirSync(dir, { recursive: true });
  chmodBestEffort(dir, 0o700);
  const path = identityFilePath(home);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(file, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * Move the current identity aside under a dated name rather than delete it: a
 * forgotten passphrase may turn up. Returns the new file name, or null if there
 * was nothing to move.
 */
export function setAsideIdentityFile(home: string, now: Date = new Date()): string | null {
  const path = identityFilePath(home);
  if (!existsSync(path)) return null;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const name = `identity.set-aside-${stamp}.json`;
  renameSync(path, join(identityDir(home), name));
  return name;
}

function chmodBestEffort(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // On Windows the profile directory ACL is the boundary.
  }
}

// ── the console's earlier format, for import only ────────────────────────────

const LegacyConsoleFileSchema = z.object({
  version: z.literal(1),
  npub: z.string().min(1),
  created_at: z.string().min(1),
  protection: z.enum(["passphrase", "device"]).optional(),
  kdf: z.object({
    name: z.literal("scrypt"),
    N: z.number().int().positive(),
    r: z.number().int().positive(),
    p: z.number().int().positive(),
    salt: z.string().min(1),
  }),
  cipher: CipherSchema.passthrough(),
});

export type LegacyConsoleFile = z.infer<typeof LegacyConsoleFileSchema>;

export function parseLegacyConsoleFile(value: unknown): LegacyConsoleFile | null {
  const parsed = LegacyConsoleFileSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Decrypt a console identity file. A device-protected console file was sealed
 * with an empty passphrase. Throws WrongPassphraseError on mismatch.
 */
export function openLegacyConsoleFile(file: LegacyConsoleFile, passphrase: string): Buffer {
  const secret = file.protection === "device" ? "" : passphrase;
  const wrappingKey = scryptKey(secret, Buffer.from(file.kdf.salt, "base64"), file.kdf);
  return decrypt({ name: "aes-256-gcm", iv: file.cipher.iv, ciphertext: file.cipher.ciphertext, tag: file.cipher.tag }, wrappingKey);
}
