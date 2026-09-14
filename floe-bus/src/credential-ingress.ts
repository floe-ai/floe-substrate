import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { OperationAuthorityBoundary } from "./operations.js";

const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_TTL_MS = 10 * 60_000;
const MAX_MATERIAL_BYTES = 1024 * 1024;

export type CredentialIngressAudience = `provider-auth:${string}`;
export type CredentialIngressPurpose = "account-connection" | "credential-maintenance";

export type CredentialIngressSessionStatus = Readonly<{
  ingress_session_id: string;
  secret_ref_id: string;
  authority_boundary: OperationAuthorityBoundary;
  principal_id: string;
  provider_id: string;
  audience: CredentialIngressAudience;
  purpose: CredentialIngressPurpose;
  state: "awaiting_material" | "ready";
  expires_at: string;
}>;

export type IssuedCredentialIngressSession = Readonly<{
  session: CredentialIngressSessionStatus;
  bearer_token: string;
}>;

export type CredentialIngressFailureCode =
  | "credential_ingress_not_found"
  | "credential_ingress_expired"
  | "credential_ingress_consumed"
  | "credential_ingress_revoked"
  | "credential_ingress_token_invalid"
  | "credential_ingress_audience_mismatch"
  | "credential_ingress_purpose_mismatch"
  | "credential_ingress_principal_mismatch"
  | "credential_ingress_boundary_mismatch"
  | "credential_ingress_secret_ref_mismatch"
  | "credential_ingress_provider_mismatch"
  | "credential_ingress_material_missing"
  | "credential_ingress_material_invalid";

export class CredentialIngressError extends Error {
  readonly error_code = "E_CREDENTIAL_INGRESS_REFUSED" as const;

  constructor(readonly code: CredentialIngressFailureCode) {
    super(`Credential ingress refused: ${code}.`);
    this.name = "CredentialIngressError";
  }
}

type CredentialIngressSession = Readonly<{
  status: CredentialIngressSessionStatus;
  token_hash: Buffer;
  material: Uint8Array | null;
}>;

export type CredentialIngressStoreDependencies = Readonly<{
  now?: () => Date;
  token_factory?: () => string;
  session_id_factory?: () => string;
}>;

/**
 * Ephemeral transfer boundary between one trusted provider login helper and
 * one canonical credential operation. It is intentionally memory-only: a
 * restart invalidates outstanding transfers and never creates another secret
 * store beside the operating-system vault.
 */
export class CredentialIngressStore {
  private readonly sessions = new Map<string, CredentialIngressSession>();
  private readonly terminal = new Map<string, "consumed" | "revoked">();
  private readonly now: () => Date;
  private readonly tokenFactory: () => string;
  private readonly sessionIdFactory: () => string;

  constructor(dependencies: CredentialIngressStoreDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.tokenFactory = dependencies.token_factory ?? (() => randomBytes(32).toString("base64url"));
    this.sessionIdFactory = dependencies.session_id_factory ?? (() => `credential-ingress:${randomUUID()}`);
  }

  issue(input: Readonly<{
    secret_ref_id: string;
    authority_boundary: OperationAuthorityBoundary;
    principal_id: string;
    provider_id: string;
    audience: CredentialIngressAudience;
    purpose: CredentialIngressPurpose;
    ttl_ms?: number;
  }>): IssuedCredentialIngressSession {
    const ttlMs = input.ttl_ms ?? DEFAULT_TTL_MS;
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) {
      throw new CredentialIngressError("credential_ingress_expired");
    }
    const token = requireText(this.tokenFactory(), "bearer token");
    const sessionId = requireText(this.sessionIdFactory(), "ingress_session_id");
    if (this.sessions.has(sessionId) || this.terminal.has(sessionId)) {
      throw new Error("Credential ingress session identity was reused.");
    }
    const status: CredentialIngressSessionStatus = Object.freeze({
      ingress_session_id: sessionId,
      secret_ref_id: requireText(input.secret_ref_id, "secret_ref_id"),
      authority_boundary: normalizeBoundary(input.authority_boundary),
      principal_id: requireText(input.principal_id, "principal_id"),
      provider_id: requireText(input.provider_id, "provider_id"),
      audience: requireAudience(input.audience),
      purpose: input.purpose,
      state: "awaiting_material",
      expires_at: new Date(this.now().getTime() + ttlMs).toISOString(),
    });
    this.sessions.set(sessionId, {
      status,
      token_hash: digest(token),
      material: null,
    });
    return { session: status, bearer_token: token };
  }

  upload(input: Readonly<{
    ingress_session_id: string;
    bearer_token: string;
    audience: CredentialIngressAudience;
    purpose: CredentialIngressPurpose;
    material: Uint8Array;
  }>): CredentialIngressSessionStatus {
    const session = this.requireActive(input.ingress_session_id);
    verifyToken(session.token_hash, input.bearer_token);
    if (session.status.audience !== input.audience) {
      throw new CredentialIngressError("credential_ingress_audience_mismatch");
    }
    if (session.status.purpose !== input.purpose) {
      throw new CredentialIngressError("credential_ingress_purpose_mismatch");
    }
    if (!(input.material instanceof Uint8Array) || input.material.byteLength === 0
      || input.material.byteLength > MAX_MATERIAL_BYTES) {
      throw new CredentialIngressError("credential_ingress_material_invalid");
    }
    if (session.material) {
      throw new CredentialIngressError("credential_ingress_consumed");
    }
    const status = Object.freeze({ ...session.status, state: "ready" as const });
    this.sessions.set(status.ingress_session_id, {
      ...session,
      status,
      material: new Uint8Array(input.material),
    });
    return status;
  }

  consume(input: Readonly<{
    ingress_session_id: string;
    secret_ref_id: string;
    authority_boundary: OperationAuthorityBoundary;
    principal_id: string;
    provider_id: string;
    audience: CredentialIngressAudience;
    purpose: CredentialIngressPurpose;
  }>): Uint8Array {
    const session = this.requireActive(input.ingress_session_id);
    this.assertExactUse(session.status, input);
    if (!session.material) {
      throw new CredentialIngressError("credential_ingress_material_missing");
    }
    // Remove before returning bytes. A concurrent or retried consumer can no
    // longer observe the session, even if the downstream broker later fails.
    this.sessions.delete(session.status.ingress_session_id);
    this.terminal.set(session.status.ingress_session_id, "consumed");
    const material = new Uint8Array(session.material);
    session.material.fill(0);
    session.token_hash.fill(0);
    return material;
  }

  revoke(ingressSessionId: string): boolean {
    const id = requireText(ingressSessionId, "ingress_session_id");
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    this.terminal.set(id, "revoked");
    session.material?.fill(0);
    session.token_hash.fill(0);
    return true;
  }

  private requireActive(ingressSessionId: string): CredentialIngressSession {
    const id = requireText(ingressSessionId, "ingress_session_id");
    const terminal = this.terminal.get(id);
    if (terminal) {
      throw new CredentialIngressError(terminal === "consumed"
        ? "credential_ingress_consumed"
        : "credential_ingress_revoked");
    }
    const session = this.sessions.get(id);
    if (!session) throw new CredentialIngressError("credential_ingress_not_found");
    if (Date.parse(session.status.expires_at) <= this.now().getTime()) {
      this.sessions.delete(id);
      session.material?.fill(0);
      session.token_hash.fill(0);
      throw new CredentialIngressError("credential_ingress_expired");
    }
    return session;
  }

  private assertExactUse(
    status: CredentialIngressSessionStatus,
    input: Readonly<{
      secret_ref_id: string;
      authority_boundary: OperationAuthorityBoundary;
      principal_id: string;
      provider_id: string;
      audience: CredentialIngressAudience;
      purpose: CredentialIngressPurpose;
    }>,
  ): void {
    if (status.secret_ref_id !== input.secret_ref_id) {
      throw new CredentialIngressError("credential_ingress_secret_ref_mismatch");
    }
    if (!sameBoundary(status.authority_boundary, input.authority_boundary)) {
      throw new CredentialIngressError("credential_ingress_boundary_mismatch");
    }
    if (status.principal_id !== input.principal_id) {
      throw new CredentialIngressError("credential_ingress_principal_mismatch");
    }
    if (status.provider_id !== input.provider_id) {
      throw new CredentialIngressError("credential_ingress_provider_mismatch");
    }
    if (status.audience !== input.audience) {
      throw new CredentialIngressError("credential_ingress_audience_mismatch");
    }
    if (status.purpose !== input.purpose) {
      throw new CredentialIngressError("credential_ingress_purpose_mismatch");
    }
  }
}

function digest(token: string): Buffer {
  return createHash("sha256").update(requireText(token, "bearer token"), "utf8").digest();
}

function verifyToken(expected: Buffer, supplied: string): void {
  const candidate = digest(supplied);
  if (candidate.byteLength !== expected.byteLength || !timingSafeEqual(candidate, expected)) {
    throw new CredentialIngressError("credential_ingress_token_invalid");
  }
}

function normalizeBoundary(boundary: OperationAuthorityBoundary): OperationAuthorityBoundary {
  return boundary.kind === "workspace"
    ? Object.freeze({ kind: "workspace", workspace_id: requireText(boundary.workspace_id, "workspace_id") })
    : Object.freeze({ kind: "host", host_id: requireText(boundary.host_id, "host_id") });
}

function sameBoundary(left: OperationAuthorityBoundary, right: OperationAuthorityBoundary): boolean {
  return left.kind === right.kind
    && (left.kind === "workspace"
      ? right.kind === "workspace" && left.workspace_id === right.workspace_id
      : right.kind === "host" && left.host_id === right.host_id);
}

function requireAudience(value: string): CredentialIngressAudience {
  const normalized = requireText(value, "audience");
  if (!normalized.startsWith("provider-auth:")) {
    throw new CredentialIngressError("credential_ingress_audience_mismatch");
  }
  return normalized as CredentialIngressAudience;
}

function requireText(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}
