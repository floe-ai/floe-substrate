import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const MAX_ATTACHMENT_INGRESS_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_INGRESS_ITEMS = 5;

const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_TTL_MS = 15 * 60_000;
const MAX_PENDING_SESSIONS = 256;
const MAX_PENDING_BYTES = 256 * 1024 * 1024;
const MAX_TERMINAL_SESSIONS = 1024;

export type AttachmentIngressStatus = Readonly<{
  ingress_session_id: string;
  workspace_id: string;
  context_id: string;
  principal_id: string;
  name: string;
  media_type: string;
  size_bytes: number;
  digest: Readonly<{ algorithm: "sha256"; value: string }> | null;
  state: "awaiting_content" | "ready";
  expires_at: string;
}>;

export type IssuedAttachmentIngressSession = Readonly<{
  session: AttachmentIngressStatus;
  bearer_token: string;
}>;

export type ConsumedAttachmentIngress = Readonly<{
  ingress_session_id: string;
  name: string;
  media_type: string;
  size_bytes: number;
  digest: Readonly<{ algorithm: "sha256"; value: string }>;
  bytes: Uint8Array;
}>;

export type AttachmentIngressFailureCode =
  | "attachment_ingress_not_found"
  | "attachment_ingress_expired"
  | "attachment_ingress_consumed"
  | "attachment_ingress_revoked"
  | "attachment_ingress_token_invalid"
  | "attachment_ingress_principal_mismatch"
  | "attachment_ingress_workspace_mismatch"
  | "attachment_ingress_context_mismatch"
  | "attachment_ingress_content_missing"
  | "attachment_ingress_capacity_exceeded"
  | "attachment_ingress_content_invalid";

export class AttachmentIngressError extends Error {
  readonly error_code = "E_ATTACHMENT_INGRESS_REFUSED" as const;

  constructor(readonly code: AttachmentIngressFailureCode) {
    super(`Attachment ingress refused: ${code}.`);
    this.name = "AttachmentIngressError";
  }
}

type AttachmentIngressSession = Readonly<{
  status: AttachmentIngressStatus;
  token_hash: Buffer;
  bytes: Uint8Array | null;
}>;

export type AttachmentIngressStoreDependencies = Readonly<{
  now?: () => Date;
  token_factory?: () => string;
  session_id_factory?: () => string;
  maximum_pending_sessions?: number;
  maximum_pending_bytes?: number;
  maximum_terminal_sessions?: number;
}>;

/**
 * One-use, memory-only transfer from a trusted client to one Context message.
 * The bearer moves bytes only; the canonical operation later commits the
 * message and its immutable ArtefactVersions together.
 */
export class AttachmentIngressStore {
  private readonly sessions = new Map<string, AttachmentIngressSession>();
  private readonly terminal = new Map<string, { state: "consumed" | "revoked" | "expired"; expires_at: number }>();
  private readonly now: () => Date;
  private readonly tokenFactory: () => string;
  private readonly sessionIdFactory: () => string;
  private readonly maximumPendingSessions: number;
  private readonly maximumPendingBytes: number;
  private readonly maximumTerminalSessions: number;

  constructor(dependencies: AttachmentIngressStoreDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.tokenFactory = dependencies.token_factory ?? (() => randomBytes(32).toString("base64url"));
    this.sessionIdFactory = dependencies.session_id_factory ?? (() => `attachment-ingress:${randomUUID()}`);
    this.maximumPendingSessions = dependencies.maximum_pending_sessions ?? MAX_PENDING_SESSIONS;
    this.maximumPendingBytes = dependencies.maximum_pending_bytes ?? MAX_PENDING_BYTES;
    this.maximumTerminalSessions = dependencies.maximum_terminal_sessions ?? MAX_TERMINAL_SESSIONS;
    for (const limit of [this.maximumPendingSessions, this.maximumPendingBytes, this.maximumTerminalSessions]) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Attachment ingress limits must be positive integers.");
    }
  }

  issue(input: Readonly<{
    workspace_id: string;
    context_id: string;
    principal_id: string;
    name: string;
    media_type: string;
    size_bytes: number;
    ttl_ms?: number;
  }>): IssuedAttachmentIngressSession {
    this.prune();
    const ttlMs = input.ttl_ms ?? DEFAULT_TTL_MS;
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) {
      throw new AttachmentIngressError("attachment_ingress_expired");
    }
    if (!Number.isSafeInteger(input.size_bytes)
      || input.size_bytes <= 0
      || input.size_bytes > MAX_ATTACHMENT_INGRESS_BYTES) {
      throw new AttachmentIngressError("attachment_ingress_content_invalid");
    }
    const reservedBytes = [...this.sessions.values()].reduce((sum, session) => sum + session.status.size_bytes, 0);
    if (this.sessions.size >= this.maximumPendingSessions || reservedBytes + input.size_bytes > this.maximumPendingBytes) {
      throw new AttachmentIngressError("attachment_ingress_capacity_exceeded");
    }
    const token = requireText(this.tokenFactory(), "bearer token", 4096);
    const sessionId = requireText(this.sessionIdFactory(), "ingress_session_id", 512);
    if (this.sessions.has(sessionId) || this.terminal.has(sessionId)) {
      throw new Error("Attachment ingress session identity was reused.");
    }
    const status: AttachmentIngressStatus = Object.freeze({
      ingress_session_id: sessionId,
      workspace_id: requireText(input.workspace_id, "workspace_id", 512),
      context_id: requireText(input.context_id, "context_id", 512),
      principal_id: requireText(input.principal_id, "principal_id", 512),
      name: safeName(input.name),
      media_type: safeMediaType(input.media_type),
      size_bytes: input.size_bytes,
      digest: null,
      state: "awaiting_content",
      expires_at: new Date(this.now().getTime() + ttlMs).toISOString(),
    });
    this.sessions.set(sessionId, { status, token_hash: digestToken(token), bytes: null });
    return { session: status, bearer_token: token };
  }

  upload(input: Readonly<{
    ingress_session_id: string;
    bearer_token: string;
    bytes: Uint8Array;
  }>): AttachmentIngressStatus {
    const session = this.requireActive(input.ingress_session_id);
    verifyToken(session.token_hash, input.bearer_token);
    if (!(input.bytes instanceof Uint8Array)
      || input.bytes.byteLength !== session.status.size_bytes
      || input.bytes.byteLength === 0
      || input.bytes.byteLength > MAX_ATTACHMENT_INGRESS_BYTES) {
      throw new AttachmentIngressError("attachment_ingress_content_invalid");
    }
    if (session.bytes) throw new AttachmentIngressError("attachment_ingress_consumed");
    const bytes = new Uint8Array(input.bytes);
    const status: AttachmentIngressStatus = Object.freeze({
      ...session.status,
      state: "ready",
      digest: Object.freeze({
        algorithm: "sha256" as const,
        value: createHash("sha256").update(bytes).digest("hex"),
      }),
    });
    this.sessions.set(status.ingress_session_id, { ...session, status, bytes });
    return status;
  }

  consumeMany(input: Readonly<{
    ingress_session_ids: readonly string[];
    workspace_id: string;
    context_id: string;
    principal_id: string;
  }>): ConsumedAttachmentIngress[] {
    const ids = input.ingress_session_ids.map(id => requireText(id, "ingress_session_id", 512));
    if (ids.length > MAX_ATTACHMENT_INGRESS_ITEMS || new Set(ids).size !== ids.length) {
      throw new AttachmentIngressError("attachment_ingress_content_invalid");
    }
    const sessions = ids.map(id => this.requireActive(id));
    for (const session of sessions) {
      this.assertExactUse(session.status, input);
      if (!session.bytes || !session.status.digest || session.status.state !== "ready") {
        throw new AttachmentIngressError("attachment_ingress_content_missing");
      }
    }
    return sessions.map(session => {
      this.sessions.delete(session.status.ingress_session_id);
      this.rememberTerminal(session.status.ingress_session_id, "consumed");
      const bytes = new Uint8Array(session.bytes!);
      session.bytes!.fill(0);
      session.token_hash.fill(0);
      return Object.freeze({
        ingress_session_id: session.status.ingress_session_id,
        name: session.status.name,
        media_type: session.status.media_type,
        size_bytes: session.status.size_bytes,
        digest: session.status.digest!,
        bytes,
      });
    });
  }

  /**
   * Use a ready group synchronously and consume it only after the caller's
   * commit succeeds. A failed database commit leaves the one-use upload ready
   * for an exact retry; temporary byte copies are always zeroed.
   */
  commitMany<T>(input: Readonly<{
    ingress_session_ids: readonly string[];
    workspace_id: string;
    context_id: string;
    principal_id: string;
  }>, commit: (ingresses: readonly ConsumedAttachmentIngress[]) => T): T {
    const ids = input.ingress_session_ids.map(id => requireText(id, "ingress_session_id", 512));
    if (ids.length > MAX_ATTACHMENT_INGRESS_ITEMS || new Set(ids).size !== ids.length) {
      throw new AttachmentIngressError("attachment_ingress_content_invalid");
    }
    const sessions = ids.map(id => this.requireActive(id));
    for (const session of sessions) {
      this.assertExactUse(session.status, input);
      if (!session.bytes || !session.status.digest || session.status.state !== "ready") {
        throw new AttachmentIngressError("attachment_ingress_content_missing");
      }
    }
    const ingresses = sessions.map(session => Object.freeze({
      ingress_session_id: session.status.ingress_session_id,
      name: session.status.name,
      media_type: session.status.media_type,
      size_bytes: session.status.size_bytes,
      digest: session.status.digest!,
      bytes: new Uint8Array(session.bytes!),
    }));
    try {
      const result = commit(ingresses);
      for (const session of sessions) {
        this.sessions.delete(session.status.ingress_session_id);
        this.rememberTerminal(session.status.ingress_session_id, "consumed");
        session.bytes!.fill(0);
        session.token_hash.fill(0);
      }
      return result;
    } finally {
      for (const ingress of ingresses) ingress.bytes.fill(0);
    }
  }

  revoke(input: Readonly<{
    ingress_session_id: string;
    workspace_id: string;
    context_id: string;
    principal_id: string;
  }>): boolean {
    this.prune();
    const id = requireText(input.ingress_session_id, "ingress_session_id", 512);
    const session = this.sessions.get(id);
    if (!session) return false;
    this.assertExactUse(session.status, input);
    this.sessions.delete(id);
    this.rememberTerminal(id, "revoked");
    session.bytes?.fill(0);
    session.token_hash.fill(0);
    return true;
  }

  private requireActive(ingressSessionId: string): AttachmentIngressSession {
    this.prune();
    const id = requireText(ingressSessionId, "ingress_session_id", 512);
    const terminal = this.terminal.get(id);
    if (terminal) {
      throw new AttachmentIngressError(terminal.state === "consumed"
        ? "attachment_ingress_consumed"
        : terminal.state === "revoked" ? "attachment_ingress_revoked" : "attachment_ingress_expired");
    }
    const session = this.sessions.get(id);
    if (!session) throw new AttachmentIngressError("attachment_ingress_not_found");
    return session;
  }

  /** Activity reclaims expired uploads; there is no recurring substrate timer. */
  private prune(): void {
    const now = this.now().getTime();
    for (const [id, terminal] of this.terminal) {
      if (terminal.expires_at <= now) this.terminal.delete(id);
    }
    for (const [id, session] of this.sessions) {
      if (Date.parse(session.status.expires_at) > now) continue;
      this.sessions.delete(id);
      session.bytes?.fill(0);
      session.token_hash.fill(0);
      this.rememberTerminal(id, "expired");
    }
  }

  private rememberTerminal(id: string, state: "consumed" | "revoked" | "expired"): void {
    this.terminal.set(id, { state, expires_at: this.now().getTime() + MAX_TTL_MS });
    while (this.terminal.size > this.maximumTerminalSessions) {
      this.terminal.delete(this.terminal.keys().next().value!);
    }
  }

  private assertExactUse(
    status: AttachmentIngressStatus,
    input: Readonly<{ workspace_id: string; context_id: string; principal_id: string }>,
  ): void {
    if (status.workspace_id !== input.workspace_id) {
      throw new AttachmentIngressError("attachment_ingress_workspace_mismatch");
    }
    if (status.context_id !== input.context_id) {
      throw new AttachmentIngressError("attachment_ingress_context_mismatch");
    }
    if (status.principal_id !== input.principal_id) {
      throw new AttachmentIngressError("attachment_ingress_principal_mismatch");
    }
  }
}

function digestToken(token: string): Buffer {
  return createHash("sha256").update(requireText(token, "bearer token", 4096), "utf8").digest();
}

function verifyToken(expected: Buffer, supplied: string): void {
  const candidate = digestToken(supplied);
  if (candidate.byteLength !== expected.byteLength || !timingSafeEqual(candidate, expected)) {
    throw new AttachmentIngressError("attachment_ingress_token_invalid");
  }
}

function safeName(value: string): string {
  const basename = requireText(value, "name", 255)
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .at(-1);
  if (!basename || basename === "." || basename === "..") {
    throw new AttachmentIngressError("attachment_ingress_content_invalid");
  }
  return basename;
}

function safeMediaType(value: string): string {
  const mediaType = requireText(value || "application/octet-stream", "media_type", 255)
    .toLowerCase()
    .split(";", 1)[0]!
    .trim();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mediaType)) {
    throw new AttachmentIngressError("attachment_ingress_content_invalid");
  }
  return mediaType;
}

function requireText(value: string, field: string, maximum: number): string {
  if (typeof value !== "string"
    || !value.trim()
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AttachmentIngressError("attachment_ingress_content_invalid");
  }
  return value.trim();
}
