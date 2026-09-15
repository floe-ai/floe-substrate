import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Durable store for admitted client identities, single-use authentication
 * challenges, and the sessions minted for each identity (ADR-0015).
 *
 * An identity is a public key plus a human-chosen display name, admitted by a
 * host-control action. The store persists public keys and names only; it never
 * stores a seed, private key, or bearer token. Bearer tokens live in the
 * operation authority session store; here we only record which authority
 * session each identity holds so the operator can see and revoke them.
 */

export type ClientIdentityRecord = Readonly<{
  identity_id: string;
  pubkey_hex: string;
  display_name: string;
  /** Which principal this identity acts through. Today always the operator. */
  principal_id: string;
  /** The host-control credential id that admitted this key. */
  admitted_by: string;
  admitted_at: string;
  revoked_at: string | null;
}>;

export type ClientIdentitySessionRecord = Readonly<{
  authority_session_id: string;
  identity_id: string;
  workspace_id: string;
  issued_at: string;
  expires_at: string;
}>;

export type IssuedChallenge = Readonly<{
  challenge: string;
  relay: string;
  expires_at: string;
}>;

export type ConsumedChallenge = Readonly<{ relay: string }>;

type ClientIdentityDependencies = Readonly<{
  now?: () => string;
  challenge_factory?: () => string;
  identity_id_factory?: () => string;
}>;

/** Installs the client identity, challenge, and session schema. */
export function applyClientIdentitySchema(db: DatabaseSync): void {
  // Challenges are workspace-independent proof-of-key nonces (ADR-0015 F3): the
  // workspace a bearer is scoped to is chosen at authenticate/mint time, not at
  // challenge time. An earlier shape bound the challenge to a workspace; since
  // challenges are ephemeral throwaway nonces (not durable state), drop that old
  // table so the new shape applies. This is not data migration.
  const challengeColumns = db.prepare("PRAGMA table_info(client_identity_challenges)").all() as Array<{ name: string }>;
  if (challengeColumns.some((column) => column.name === "workspace_id")) {
    db.exec("DROP TABLE client_identity_challenges");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_identities (
      identity_id TEXT PRIMARY KEY,
      pubkey_hex TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      admitted_by TEXT NOT NULL,
      admitted_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS client_identity_workspaces (
      identity_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      admitted_by TEXT NOT NULL,
      admitted_at TEXT NOT NULL,
      PRIMARY KEY (identity_id, workspace_id),
      FOREIGN KEY (identity_id) REFERENCES client_identities(identity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_client_identity_workspace_ws
      ON client_identity_workspaces(workspace_id);

    CREATE TABLE IF NOT EXISTS client_identity_challenges (
      challenge TEXT PRIMARY KEY,
      relay TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_client_identity_challenge_expiry
      ON client_identity_challenges(expires_at);

    CREATE TABLE IF NOT EXISTS client_identity_sessions (
      authority_session_id TEXT PRIMARY KEY,
      identity_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (identity_id) REFERENCES client_identities(identity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_client_identity_session_identity
      ON client_identity_sessions(identity_id);
  `);
}

export class SqliteClientIdentityStore {
  private readonly now: () => string;
  private readonly challengeFactory: () => string;
  private readonly identityIdFactory: () => string;

  constructor(readonly db: DatabaseSync, dependencies: ClientIdentityDependencies = {}) {
    this.now = dependencies.now ?? isoNow;
    this.challengeFactory = dependencies.challenge_factory
      ?? (() => randomBytes(32).toString("hex"));
    this.identityIdFactory = dependencies.identity_id_factory
      ?? (() => `identity_${randomUUID()}`);
  }

  /**
   * Admit a public key under a display name. Idempotent per key: re-admitting an
   * existing key updates its display name and clears any prior revocation, since
   * a host-control caller is the substrate's admission root. This is admission,
   * never key recovery.
   */
  admitIdentity(input: Readonly<{
    pubkey_hex: string;
    display_name: string;
    principal_id: string;
    admitted_by: string;
  }>): ClientIdentityRecord {
    assertNonEmpty("pubkey_hex", input.pubkey_hex);
    assertNonEmpty("display_name", input.display_name);
    assertNonEmpty("principal_id", input.principal_id);
    assertNonEmpty("admitted_by", input.admitted_by);
    const existing = this.getIdentityByPubkey(input.pubkey_hex);
    const admittedAt = this.now();
    if (existing) {
      this.db.prepare(`
        UPDATE client_identities
        SET display_name = ?, principal_id = ?, admitted_by = ?, admitted_at = ?, revoked_at = NULL
        WHERE identity_id = ?
      `).run(input.display_name, input.principal_id, input.admitted_by, admittedAt, existing.identity_id);
      return this.getIdentity(existing.identity_id)!;
    }
    const identityId = this.identityIdFactory();
    this.db.prepare(`
      INSERT INTO client_identities (
        identity_id, pubkey_hex, display_name, principal_id, admitted_by, admitted_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(identityId, input.pubkey_hex, input.display_name, input.principal_id, input.admitted_by, admittedAt);
    return this.getIdentity(identityId)!;
  }

  /**
   * Admit an identity to a workspace: record where this key may act (ADR-0015
   * F3). Idempotent per (identity, workspace). An identity may be admitted to
   * several workspaces; authentication reports the set and the client learns its
   * workspaces from the substrate rather than being told one out of band.
   */
  addWorkspaceMembership(input: Readonly<{
    identity_id: string;
    workspace_id: string;
    admitted_by: string;
  }>): void {
    assertNonEmpty("identity_id", input.identity_id);
    assertNonEmpty("workspace_id", input.workspace_id);
    assertNonEmpty("admitted_by", input.admitted_by);
    this.db.prepare(`
      INSERT INTO client_identity_workspaces (identity_id, workspace_id, admitted_by, admitted_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(identity_id, workspace_id) DO NOTHING
    `).run(input.identity_id, input.workspace_id, input.admitted_by, this.now());
  }

  /** The workspace ids this identity has been admitted to. */
  listWorkspaceIdsForIdentity(identityId: string): string[] {
    const rows = this.db.prepare(
      "SELECT workspace_id FROM client_identity_workspaces WHERE identity_id = ? ORDER BY admitted_at ASC",
    ).all(identityId) as Array<{ workspace_id: string }>;
    return rows.map((row) => row.workspace_id);
  }

  /** Whether this identity may act in the given workspace. */
  isMemberOfWorkspace(identityId: string, workspaceId: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM client_identity_workspaces WHERE identity_id = ? AND workspace_id = ?",
    ).get(identityId, workspaceId);
    return row !== undefined;
  }

  getIdentity(identityId: string): ClientIdentityRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM client_identities WHERE identity_id = ?",
    ).get(identityId) as ClientIdentityRow | undefined;
    return row ? rowToIdentity(row) : null;
  }

  getIdentityByPubkey(pubkeyHex: string): ClientIdentityRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM client_identities WHERE pubkey_hex = ?",
    ).get(pubkeyHex) as ClientIdentityRow | undefined;
    return row ? rowToIdentity(row) : null;
  }

  listIdentities(): ClientIdentityRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM client_identities ORDER BY admitted_at ASC",
    ).all() as ClientIdentityRow[];
    return rows.map(rowToIdentity);
  }

  revokeIdentity(identityId: string, revokedAt = this.now()): boolean {
    const result = this.db.prepare(`
      UPDATE client_identities
      SET revoked_at = COALESCE(revoked_at, ?)
      WHERE identity_id = ?
    `).run(revokedAt, identityId);
    return Number(result.changes) === 1;
  }

  /** Issue a single-use, workspace-independent challenge bound to an exact relay string. */
  issueChallenge(input: Readonly<{
    relay: string;
    ttl_seconds?: number;
  }>): IssuedChallenge {
    assertNonEmpty("relay", input.relay);
    const challenge = this.challengeFactory();
    const expiresAt = new Date(Date.parse(this.now()) + (input.ttl_seconds ?? 300) * 1000).toISOString();
    this.db.prepare(`
      INSERT INTO client_identity_challenges (challenge, relay, expires_at, consumed_at)
      VALUES (?, ?, ?, NULL)
    `).run(challenge, input.relay, expiresAt);
    return { challenge, relay: input.relay, expires_at: expiresAt };
  }

  /**
   * Atomically consume a challenge. Returns the issued relay string when the
   * challenge is live and unconsumed, otherwise null. The consume is single-use:
   * a replayed challenge is rejected.
   */
  consumeChallenge(challenge: string): ConsumedChallenge | null {
    const nowIso = this.now();
    const row = this.db.prepare(
      "SELECT * FROM client_identity_challenges WHERE challenge = ?",
    ).get(challenge) as ClientIdentityChallengeRow | undefined;
    if (!row) return null;
    if (row.consumed_at !== null) return null;
    if (Date.parse(row.expires_at) <= Date.parse(nowIso)) return null;
    const result = this.db.prepare(`
      UPDATE client_identity_challenges
      SET consumed_at = ?
      WHERE challenge = ? AND consumed_at IS NULL
    `).run(nowIso, challenge);
    if (Number(result.changes) !== 1) return null;
    return { relay: row.relay };
  }

  /** Record the authority session minted for an identity, for legibility and revocation. */
  recordSession(input: ClientIdentitySessionRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO client_identity_sessions (
        authority_session_id, identity_id, workspace_id, issued_at, expires_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      input.authority_session_id,
      input.identity_id,
      input.workspace_id,
      input.issued_at,
      input.expires_at,
    );
  }

  listSessionsForIdentity(identityId: string): ClientIdentitySessionRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM client_identity_sessions WHERE identity_id = ? ORDER BY issued_at DESC",
    ).all(identityId) as ClientIdentitySessionRow[];
    return rows.map(rowToSession);
  }

  /** Delete expired, unconsumed challenges. Housekeeping only; never security-load-bearing. */
  pruneExpiredChallenges(): void {
    this.db.prepare("DELETE FROM client_identity_challenges WHERE expires_at <= ?").run(this.now());
  }
}

type ClientIdentityRow = Readonly<{
  identity_id: string;
  pubkey_hex: string;
  display_name: string;
  principal_id: string;
  admitted_by: string;
  admitted_at: string;
  revoked_at: string | null;
}>;

type ClientIdentityChallengeRow = Readonly<{
  challenge: string;
  relay: string;
  expires_at: string;
  consumed_at: string | null;
}>;

type ClientIdentitySessionRow = Readonly<{
  authority_session_id: string;
  identity_id: string;
  workspace_id: string;
  issued_at: string;
  expires_at: string;
}>;

function rowToIdentity(row: ClientIdentityRow): ClientIdentityRecord {
  return {
    identity_id: row.identity_id,
    pubkey_hex: row.pubkey_hex,
    display_name: row.display_name,
    principal_id: row.principal_id,
    admitted_by: row.admitted_by,
    admitted_at: row.admitted_at,
    revoked_at: row.revoked_at,
  };
}

function rowToSession(row: ClientIdentitySessionRow): ClientIdentitySessionRecord {
  return {
    authority_session_id: row.authority_session_id,
    identity_id: row.identity_id,
    workspace_id: row.workspace_id,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
  };
}

function assertNonEmpty(label: string, value: string): void {
  if (!value.trim()) throw new Error(`Client identity ${label} must not be empty.`);
}

function isoNow(): string {
  return new Date().toISOString();
}
