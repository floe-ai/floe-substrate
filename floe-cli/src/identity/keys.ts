/**
 * The identity's key material: a BIP-39 recovery phrase, the NIP-06 secp256k1
 * key derived from it, and the NIP-42 proof the Bus verifies (docs/reference/client-identity-protocol.md). Every
 * primitive is nostr-tools / noble; nothing cryptographic is written here.
 */
import { generateSeedWords, privateKeyFromSeedWords, validateWords } from "nostr-tools/nip06";
import { finalizeEvent, getPublicKey, type Event as NostrEvent } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";

export const NIP42_AUTH_KIND = 22242;

export function normalizePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(" ");
}

/** A fresh 12-word recovery phrase (128 bits of entropy). */
export function generatePhrase(): string {
  return generateSeedWords();
}

export function isValidPhrase(phrase: string): boolean {
  try {
    return validateWords(normalizePhrase(phrase));
  } catch {
    return false;
  }
}

/** NIP-06: m/44'/1237'/0'/0/0. */
export function secretKeyFromPhrase(phrase: string): Uint8Array {
  return privateKeyFromSeedWords(normalizePhrase(phrase));
}

export function publicKeyHex(secretKey: Uint8Array): string {
  return getPublicKey(secretKey);
}

export function npubOf(pubkeyHex: string): string {
  return nip19.npubEncode(pubkeyHex);
}

export function nsecOf(secretKey: Uint8Array): string {
  return nip19.nsecEncode(secretKey);
}

/** The kind:22242 event proving possession of the key for one Bus challenge. */
export function signAuthEvent(secretKey: Uint8Array, relay: string, challenge: string): NostrEvent {
  return finalizeEvent(
    {
      kind: NIP42_AUTH_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["relay", relay],
        ["challenge", challenge],
      ],
      content: "",
    },
    secretKey,
  );
}
