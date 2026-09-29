import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { BrowserWorkspaceSession } from "./browser-connections.js";
import {
  expiryMs,
  inSavepoint,
  type CapabilityGrantEvidence,
  type CapabilityGrantTarget,
  type SqliteCapabilityGrantStore,
} from "./capability-grants.js";
import type { SqliteOperationAuthoritySessionStore } from "./operation-authority-sessions.js";

export type BrowserPassStatus = "active" | "revoked";

export type BrowserPassRecord = Readonly<{
  pass_id: string;
  identity_id: string;
  principal_id: string;
  workspace_id: string;
  exact_origin: string;
  grant_id: string;
  status: BrowserPassStatus;
  issued_at: string;
  /** When the access behind the pass ends. Null means until revoked. */
  authority_expires_at: string | null;
  /** When this browser's cookie stops working unless it is used and renewed first. */
  credential_expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
}>;

type Row = BrowserPassRecord & { token_hash: string; previous_token_hash: string | null; previous_valid_until: string | null };

/** How long a browser may go unused before it must pair again. */
export const BROWSER_PASS_CREDENTIAL_MS = 30 * 86_400_000;
/** The cookie is replaced at most this often while in use. */
const RENEW_AFTER_MS = 86_400_000;
/** A request already in flight with the replaced cookie still succeeds for this long. */
const ROTATION_GRACE_MS = 60_000;
/** The short Workspace session a pass mints for itself; the page never sees it. */
const PASS_SESSION_MS = 15 * 60_000;

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();
export const passInteractionId = (passId: string) => `browser:pass:${passId}`;

export function applyBrowserPassSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_passes (
      pass_id TEXT PRIMARY KEY,
      identity_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      exact_origin TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      previous_token_hash TEXT,
      previous_valid_until TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
      issued_at TEXT NOT NULL,
      authority_expires_at TEXT,
      credential_expires_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT,
      revocation_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_browser_passes_origin ON browser_passes(exact_origin) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_browser_passes_principal ON browser_passes(principal_id, workspace_id);
  `);
}

export type BrowserPassUse = Readonly<{
  pass: BrowserPassRecord;
  session: BrowserWorkspaceSession;
  /** A replacement cookie token, present when the credential was renewed. */
  renewed_token: string | null;
}>;

/**
 * A durable, revocable browser credential. Only the cookie token's hash is
 * stored. The pass holds a grant that depends on its person's own authority,
 * so it can never do more, or last longer, than that person may.
 */
export class BrowserPassStore {
  private readonly sessions = new Map<string, BrowserWorkspaceSession>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly grants: SqliteCapabilityGrantStore,
    private readonly authoritySessions: SqliteOperationAuthoritySessionStore,
    private readonly onChanged: (pass: BrowserPassRecord) => void = () => {},
    private readonly now: () => number = () => Date.now(),
  ) {}

  issue(input: Readonly<{
    identity_id: string;
    principal_id: string;
    workspace_id: string;
    exact_origin: string;
    source_grant_id: string;
    operation_ids: readonly string[];
    targets?: readonly CapabilityGrantTarget[];
    expires_at: string | null;
    evidence: readonly CapabilityGrantEvidence[];
  }>): { pass: BrowserPassRecord; token: string } {
    const token = randomBytes(32).toString("base64url");
    const pass = inSavepoint(this.db, () => {
      const grant = this.grants.issueDependentGrant({ source_grant_id: input.source_grant_id,
        principal_id: input.principal_id, operation_ids: input.operation_ids, targets: input.targets,
        expires_at: input.expires_at, evidence: input.evidence });
      const authorityExpiry = this.grants.effectiveExpiry(grant.grant_id);
      const passId = `browserpass_${randomUUID()}`;
      this.db.prepare(`INSERT INTO browser_passes (pass_id, identity_id, principal_id, workspace_id, exact_origin,
        grant_id, token_hash, status, issued_at, authority_expires_at, credential_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`).run(passId, input.identity_id, input.principal_id,
        input.workspace_id, input.exact_origin, grant.grant_id, digest(token), iso(this.now()), authorityExpiry,
        this.credentialExpiry(authorityExpiry));
      return this.require(passId);
    });
    this.onChanged(pass);
    return { pass, token };
  }

  get(passId: string): BrowserPassRecord | null {
    const row = this.db.prepare("SELECT * FROM browser_passes WHERE pass_id = ?").get(passId) as Row | undefined;
    return row ? project(row) : null;
  }

  list(principalId: string, workspaceId: string): BrowserPassRecord[] {
    return (this.db.prepare(`SELECT * FROM browser_passes WHERE principal_id = ? AND workspace_id = ?
      ORDER BY issued_at DESC, pass_id`).all(principalId, workspaceId) as Row[]).map(project);
  }

  /** True while any active pass is bound to this exact origin. CORS only; it grants nothing. */
  hasActiveOrigin(origin: string): boolean {
    return this.db.prepare(`SELECT 1 AS present FROM browser_passes WHERE exact_origin = ? AND status = 'active'
      AND credential_expires_at > ? LIMIT 1`).get(origin, iso(this.now())) !== undefined;
  }

  /**
   * Resolves a cookie for one exact origin and Workspace into a short session
   * that references only the pass's grant. With `renew`, replaces the cookie
   * while in use, never beyond the access it rests on; only a caller that can
   * deliver the replacement cookie may ask for that.
   */
  use(token: string, origin: string, workspaceId: string | undefined, renew = false): BrowserPassUse | null {
    if (!token) return null;
    const nowMs = this.now();
    const hash = digest(token);
    const row = this.db.prepare(`SELECT * FROM browser_passes WHERE status = 'active'
      AND (token_hash = ? OR (previous_token_hash = ? AND previous_valid_until > ?))`)
      .get(hash, hash, iso(nowMs)) as Row | undefined;
    if (!row || row.exact_origin !== origin) return null;
    if (workspaceId !== undefined && workspaceId !== row.workspace_id) return null;
    if (Date.parse(row.credential_expires_at) <= nowMs) return null;
    const grant = this.grants.getGrant(row.grant_id);
    if (!grant || !this.grants.isActiveGrant(grant, nowMs)) {
      this.revoke(row.pass_id, "authority_ended");
      return null;
    }

    let session = this.sessions.get(row.pass_id);
    if (!session || Date.parse(session.expires_at) <= nowMs) {
      if (session) this.authoritySessions.revokeSession(session.authority_session_id);
      const expiresAt = Math.min(nowMs + PASS_SESSION_MS, expiryMs(this.grants.effectiveExpiry(row.grant_id)));
      const issued = this.authoritySessions.issueSession({ principal_id: row.principal_id, workspace_id: row.workspace_id,
        grant_ids: [row.grant_id], interaction: { mode: "interactive", session_id: passInteractionId(row.pass_id) },
        provenance: { cause_event_id: null, delivery_ids: [], execution_attempt_id: null, node_execution_id: null, scope_execution_id: null },
        expires_at: iso(expiresAt) });
      session = { bearer_token: issued.bearer_token, authority_session_id: issued.session.authority_session_id,
        principal_id: row.principal_id, workspace_id: row.workspace_id, expires_at: issued.session.expires_at };
      this.sessions.set(row.pass_id, session);
    }

    let renewed: string | null = null;
    const lastRenewal = Date.parse(row.credential_expires_at) - BROWSER_PASS_CREDENTIAL_MS;
    if (renew && row.token_hash === hash && nowMs - lastRenewal >= RENEW_AFTER_MS
      && this.credentialExpiry(row.authority_expires_at) > row.credential_expires_at) {
      renewed = randomBytes(32).toString("base64url");
      this.db.prepare(`UPDATE browser_passes SET token_hash = ?, previous_token_hash = ?, previous_valid_until = ?,
        credential_expires_at = ?, last_used_at = ? WHERE pass_id = ?`).run(digest(renewed), row.token_hash,
        iso(nowMs + ROTATION_GRACE_MS), this.credentialExpiry(row.authority_expires_at), iso(nowMs), row.pass_id);
    } else {
      this.db.prepare("UPDATE browser_passes SET last_used_at = ? WHERE pass_id = ?").run(iso(nowMs), row.pass_id);
    }
    return { pass: this.require(row.pass_id), session, renewed_token: renewed };
  }

  /** Ends the pass a browser holds, as that browser's own disconnect. */
  revokeByToken(token: string, origin: string, reason: string): BrowserPassRecord | null {
    if (!token) return null;
    const row = this.db.prepare("SELECT pass_id, exact_origin FROM browser_passes WHERE token_hash = ? AND status = 'active'")
      .get(digest(token)) as { pass_id: string; exact_origin: string } | undefined;
    return row && row.exact_origin === origin ? this.revoke(row.pass_id, reason) : null;
  }

  /** Records the claim, the first use of a pass. */
  markClaimed(passId: string): void {
    this.db.prepare("UPDATE browser_passes SET last_used_at = ? WHERE pass_id = ? AND last_used_at IS NULL")
      .run(iso(this.now()), passId);
  }

  /** Ends the pass, its grant and every session it minted. Revoking twice is a no-op. */
  revoke(passId: string, reason: string): BrowserPassRecord | null {
    const result = this.db.prepare(`UPDATE browser_passes SET status = 'revoked', revoked_at = ?, revocation_reason = ?,
      previous_token_hash = NULL, previous_valid_until = NULL WHERE pass_id = ? AND status = 'active'`)
      .run(iso(this.now()), reason, passId);
    const pass = this.get(passId);
    if (Number(result.changes) !== 1 || !pass) return pass;
    this.sessions.delete(passId);
    this.authoritySessions.revokeSessionsForInteraction(passInteractionId(passId));
    this.grants.revokeGrant(pass.grant_id);
    this.onChanged(pass);
    return pass;
  }

  /** Ends each active pass whose access has ended, such as after its person's authority was revoked. */
  revokeWhereAuthorityEnded(): BrowserPassRecord[] {
    const nowMs = this.now();
    const active = this.db.prepare("SELECT pass_id, grant_id FROM browser_passes WHERE status = 'active'")
      .all() as Array<{ pass_id: string; grant_id: string }>;
    return active.filter(({ grant_id }) => {
      const grant = this.grants.getGrant(grant_id);
      return !grant || !this.grants.isActiveGrant(grant, nowMs);
    }).map(({ pass_id }) => this.revoke(pass_id, "authority_ended")!).filter(Boolean);
  }

  /** An approved pass never claimed before a restart has no reachable cookie, so it is ended. */
  revokeUnclaimed(): BrowserPassRecord[] {
    const ids = this.db.prepare("SELECT pass_id FROM browser_passes WHERE status = 'active' AND last_used_at IS NULL")
      .all() as Array<{ pass_id: string }>;
    return ids.map(({ pass_id }) => this.revoke(pass_id, "never_claimed")!).filter(Boolean);
  }

  private credentialExpiry(authorityExpiry: string | null): string {
    return iso(Math.min(this.now() + BROWSER_PASS_CREDENTIAL_MS, expiryMs(authorityExpiry)));
  }

  private require(passId: string): BrowserPassRecord {
    const pass = this.get(passId);
    if (!pass) throw new Error(`Browser pass '${passId}' does not exist.`);
    return pass;
  }
}

function project(row: Row): BrowserPassRecord {
  return { pass_id: row.pass_id, identity_id: row.identity_id, principal_id: row.principal_id,
    workspace_id: row.workspace_id, exact_origin: row.exact_origin, grant_id: row.grant_id, status: row.status,
    issued_at: row.issued_at, authority_expires_at: row.authority_expires_at,
    credential_expires_at: row.credential_expires_at, last_used_at: row.last_used_at,
    revoked_at: row.revoked_at, revocation_reason: row.revocation_reason };
}
