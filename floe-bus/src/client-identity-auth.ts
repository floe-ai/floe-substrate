import { verifyEvent, type Event as NostrEvent } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";

/**
 * All cryptographic identity handling is isolated here. The rest of the Bus
 * treats a client identity as an opaque lowercase-hex public key and never
 * touches key material or signatures directly. The Bus only ever verifies; it
 * holds, derives, and stores no private key (ADR-0015).
 *
 * The scheme is the Nostr / Bitcoin stack: BIP-340 Schnorr signatures over
 * secp256k1 (NIP-01), authenticated with a kind:22242 challenge event (NIP-42),
 * with npub/hex encodings from NIP-19. Verification and encoding are delegated
 * to nostr-tools (built on the audited @noble/curves); no primitive is
 * implemented here.
 */

/** The NIP-42 ephemeral authentication event kind. */
export const NIP42_AUTH_KIND = 22242;

/** NIP-42 recommends accepting a signed event whose created_at is close to now. */
const AUTH_EVENT_MAX_SKEW_SECONDS = 600;

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

/**
 * Normalise an admitted public key supplied as either 64-char lowercase hex
 * (NIP-01 x-only form) or an `npub` (NIP-19). Returns lowercase hex, or null if
 * the input is neither a valid npub nor valid hex.
 */
export function normalizePubkeyToHex(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type !== "npub" || typeof decoded.data !== "string") return null;
      return HEX_PUBKEY.test(decoded.data) ? decoded.data : null;
    } catch {
      return null;
    }
  }
  const lowered = trimmed.toLowerCase();
  return HEX_PUBKEY.test(lowered) ? lowered : null;
}

/** Encode a lowercase-hex public key as an `npub` (NIP-19) for legible display. */
export function encodeNpub(pubkeyHex: string): string {
  return nip19.npubEncode(pubkeyHex);
}

export type AuthEventVerification =
  | Readonly<{ ok: true; pubkey_hex: string }>
  | Readonly<{ ok: false; reason: string }>;

/**
 * Verify a NIP-42 authentication event against an issued challenge, per the
 * NIP-42 verification rules: kind is 22242, created_at is close to now, the
 * challenge tag matches the challenge we issued, the relay tag matches the exact
 * relay string we issued, and the Schnorr signature (and event id) is valid.
 *
 * Deliberate deviation from NIP-42, stated in ADR-0015: the same event and the
 * same rules are carried over HTTP challenge/response rather than the relay
 * WebSocket AUTH frame.
 */
export function verifyAuthEvent(
  event: unknown,
  expected: Readonly<{ relay: string; challenge: string; now_ms: number }>,
): AuthEventVerification {
  if (!isCandidateEvent(event)) return { ok: false, reason: "auth_event_malformed" };
  if (event.kind !== NIP42_AUTH_KIND) return { ok: false, reason: "auth_event_wrong_kind" };

  const nowSeconds = Math.floor(expected.now_ms / 1000);
  if (Math.abs(nowSeconds - event.created_at) > AUTH_EVENT_MAX_SKEW_SECONDS) {
    return { ok: false, reason: "auth_event_stale" };
  }

  if (tagValue(event.tags, "challenge") !== expected.challenge) {
    return { ok: false, reason: "auth_event_challenge_mismatch" };
  }
  if (tagValue(event.tags, "relay") !== expected.relay) {
    return { ok: false, reason: "auth_event_relay_mismatch" };
  }

  // verifyEvent validates the NIP-01 id (sha256 of the canonical serialization)
  // and the BIP-340 Schnorr signature over secp256k1.
  if (!verifyEvent(event as NostrEvent)) {
    return { ok: false, reason: "auth_event_signature_invalid" };
  }

  return { ok: true, pubkey_hex: event.pubkey.toLowerCase() };
}

type CandidateEvent = Readonly<{
  kind: number;
  created_at: number;
  tags: readonly (readonly string[])[];
  pubkey: string;
  id: string;
  sig: string;
  content: string;
}>;

function isCandidateEvent(value: unknown): value is CandidateEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.kind === "number"
    && typeof event.created_at === "number"
    && Array.isArray(event.tags)
    && event.tags.every((tag) => Array.isArray(tag) && tag.every((part) => typeof part === "string"))
    && typeof event.pubkey === "string"
    && typeof event.id === "string"
    && typeof event.sig === "string"
    && typeof event.content === "string"
  );
}

function tagValue(tags: readonly (readonly string[])[], name: string): string | null {
  for (const tag of tags) {
    if (tag.length >= 2 && tag[0] === name) return tag[1];
  }
  return null;
}
