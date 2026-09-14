import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";

import type { ConnectorEvidenceRef } from "./connectors.js";
import {
  CONNECTOR_WORKER_SOURCE_OPERATION_ID,
  ConnectorWorkerError,
  type ConnectorWorkerCredentialAccess,
  type ConnectorWorkerObservation,
} from "./connector-worker.js";

export type WatchedFolderArrival = Readonly<{
  relative_path: string;
  content_sha256: string;
  size_bytes: number;
  observed_at: string;
  evidence_ref: ConnectorEvidenceRef;
}>;

/**
 * Adapts a workspace-contained file observation to canonical Connector ingress.
 * File bytes stay in their content store; the Event receives exact evidence.
 */
export function normalizeWatchedFolderArrival(
  arrival: WatchedFolderArrival,
): ConnectorWorkerObservation {
  const relativePath = normalizeRelativePath(arrival.relative_path);
  const contentDigest = requireSha256(arrival.content_sha256, "content_sha256");
  const observedAt = requireTimestamp(arrival.observed_at, "observed_at");
  const sizeBytes = requireNonNegativeInteger(arrival.size_bytes, "size_bytes");
  const facts = canonicalJson({
    content_sha256: contentDigest,
    relative_path: relativePath,
    size_bytes: sizeBytes,
  });
  return {
    idempotency_key: `folder:${sha256(`${relativePath}\0${contentDigest}`)}`,
    external_identity: `workspace-file:${relativePath}`,
    external_revision: contentDigest,
    payload_digest: sha256(facts),
    verification: {
      origin: "verified",
      signature: "not_applicable",
      schema: "valid",
      issues: [],
    },
    evidence_refs: [normalizeEvidenceRef(arrival.evidence_ref)],
    observed_at: observedAt,
  };
}

export type SignedWebhookEnvelope = Readonly<{
  external_event_id: string;
  body: Readonly<Uint8Array>;
  signature: string;
  observed_at: string;
  evidence_ref: ConnectorEvidenceRef;
}>;

/**
 * Verifies an HMAC-SHA256 webhook using a SecretRef without returning the key
 * or body. Failed signatures are valid quarantine observations, not retries.
 */
export async function normalizeSignedWebhook(
  envelope: SignedWebhookEnvelope,
  credentials: ConnectorWorkerCredentialAccess,
  slotId: string,
  operationId = CONNECTOR_WORKER_SOURCE_OPERATION_ID,
): Promise<ConnectorWorkerObservation> {
  const eventId = requireText(envelope.external_event_id, "external_event_id", 512);
  const observedAt = requireTimestamp(envelope.observed_at, "observed_at");
  const body = Uint8Array.from(envelope.body);
  if (body.byteLength === 0) throw new ConnectorWorkerError("the webhook body is empty");
  const payloadDigest = createHash("sha256").update(body).digest("hex");
  const claimed = parseHmacSignature(envelope.signature);
  let signatureVerified: boolean;
  try {
    signatureVerified = await credentials.withSecret(slotId, operationId, (material) => {
      const expected = createHmac("sha256", material).update(body).digest();
      try {
        return claimed !== null && claimed.byteLength === expected.byteLength && timingSafeEqual(claimed, expected);
      } finally {
        expected.fill(0);
      }
    });
  } finally {
    body.fill(0);
    claimed?.fill(0);
  }
  return {
    idempotency_key: `webhook:${eventId}`,
    external_identity: eventId,
    payload_digest: payloadDigest,
    verification: {
      origin: signatureVerified ? "verified" : "failed",
      signature: signatureVerified ? "verified" : "failed",
      schema: "valid",
      issues: signatureVerified ? [] : ["signature_verification_failed"],
    },
    evidence_refs: [normalizeEvidenceRef(envelope.evidence_ref)],
    observed_at: observedAt,
  };
}

export type PolledResourceObservation = Readonly<{
  external_identity: string;
  external_revision: string;
  payload_sha256: string;
  observed_at: string;
  evidence_ref: ConnectorEvidenceRef;
  checkpoint_ref?: ConnectorEvidenceRef | null;
}>;

/** Normalizes one exact provider revision returned by a Connector-owned poll. */
export function normalizePolledResource(
  observation: PolledResourceObservation,
): ConnectorWorkerObservation {
  const externalIdentity = requireText(observation.external_identity, "external_identity");
  const externalRevision = requireText(observation.external_revision, "external_revision");
  const payloadDigest = requireSha256(observation.payload_sha256, "payload_sha256");
  return {
    idempotency_key: `poll:${sha256(`${externalIdentity}\0${externalRevision}`)}`,
    external_identity: externalIdentity,
    external_revision: externalRevision,
    payload_digest: payloadDigest,
    verification: {
      origin: "verified",
      signature: "not_applicable",
      schema: "valid",
      issues: [],
    },
    evidence_refs: [normalizeEvidenceRef(observation.evidence_ref)],
    checkpoint_ref: observation.checkpoint_ref == null
      ? null
      : normalizeEvidenceRef(observation.checkpoint_ref),
    observed_at: requireTimestamp(observation.observed_at, "observed_at"),
  };
}

function normalizeRelativePath(value: unknown): string {
  const candidate = requireText(value, "relative_path").replaceAll("\\", "/");
  if (/^[a-zA-Z]:/.test(candidate) || path.win32.isAbsolute(candidate) || path.posix.isAbsolute(candidate)) {
    throw new ConnectorWorkerError("watched-folder observations require a relative workspace path");
  }
  const normalized = path.posix.normalize(candidate);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new ConnectorWorkerError("watched-folder observations must remain inside the configured workspace folder");
  }
  return normalized;
}

function parseHmacSignature(value: unknown): Buffer | null {
  if (typeof value !== "string") return null;
  const match = /^(?:sha256=)?([a-fA-F0-9]{64})$/.exec(value.trim());
  return match ? Buffer.from(match[1], "hex") : null;
}

function normalizeEvidenceRef(value: ConnectorEvidenceRef): ConnectorEvidenceRef {
  return {
    kind: requireText(value?.kind, "evidence_ref.kind"),
    id: requireText(value?.id, "evidence_ref.id"),
    revision: requireText(value?.revision, "evidence_ref.revision"),
  };
}

function requireText(value: unknown, label: string, maximum = 2048): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new ConnectorWorkerError(`${label} must be non-empty text`);
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  const digest = requireText(value, label, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new ConnectorWorkerError(`${label} must be a SHA-256 digest`);
  return digest;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireText(value, label, 128);
  if (!Number.isFinite(Date.parse(timestamp))) throw new ConnectorWorkerError(`${label} must be an ISO timestamp`);
  return new Date(timestamp).toISOString();
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ConnectorWorkerError(`${label} must be a non-negative integer`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new ConnectorWorkerError("Connector facts must contain JSON values only");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
