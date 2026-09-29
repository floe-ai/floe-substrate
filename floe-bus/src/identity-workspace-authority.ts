import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  expiryMs,
  targetContains,
  type CapabilityGrantRecord,
  type CapabilityGrantTarget,
  type SqliteCapabilityGrantStore,
} from "./capability-grants.js";

/**
 * One admitted identity's durable authority in one Workspace. The record owns
 * no operation list: `root_grant_id` points at the CapabilityGrant that is the
 * only authority definition. Sessions and browser passes reference the root;
 * Actor grants are delegated from it, so revoking it withdraws them all.
 */
export type IdentityWorkspaceAuthorityRecord = Readonly<{
  authority_id: string;
  identity_id: string;
  principal_id: string;
  workspace_id: string;
  root_grant_id: string;
  status: "active" | "revoked";
  issued_by: string;
  issued_at: string;
  /** Null means until revoked. Mirrors the root grant. */
  expires_at: string | null;
  revoked_at: string | null;
  /** Why it stopped: revoked, replaced, identity_revoked, membership_revoked. */
  revocation_reason: string | null;
  replaced_by_authority_id: string | null;
}>;

/** Explicit lifetime choice. Omission is refused, so nothing lasts forever by accident. */
export type AuthorityLifetime = Readonly<{ until_revoked: true }> | Readonly<{ expires_at: string }>;

export class AuthorityLifetimeRequiredError extends Error {
  constructor() {
    super("Choose a lifetime: until_revoked, or expires_at.");
    this.name = "AuthorityLifetimeRequiredError";
  }
}

export class AuthorityWideningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorityWideningError";
  }
}

/** Reads the one explicit lifetime from untrusted input. */
export function parseAuthorityLifetime(value: Readonly<{ until_revoked?: unknown; expires_at?: unknown }>): AuthorityLifetime {
  const untilRevoked = value.until_revoked === true;
  const hasExpiry = typeof value.expires_at === "string" && value.expires_at.length > 0;
  if (untilRevoked === hasExpiry || (value.until_revoked !== undefined && value.until_revoked !== true)) {
    throw new AuthorityLifetimeRequiredError();
  }
  if (hasExpiry && !Number.isFinite(Date.parse(value.expires_at as string))) {
    throw new AuthorityLifetimeRequiredError();
  }
  return untilRevoked ? { until_revoked: true } : { expires_at: new Date(Date.parse(value.expires_at as string)).toISOString() };
}

export function lifetimeExpiry(lifetime: AuthorityLifetime): string | null {
  return "until_revoked" in lifetime ? null : lifetime.expires_at;
}

/** Every admitted identity acts through its own stable principal. */
export function identityPrincipalId(identityId: string): string {
  return `identity:${identityId}`;
}

export function applyIdentityWorkspaceAuthoritySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS identity_workspace_authorities (
      authority_id TEXT PRIMARY KEY,
      identity_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      root_grant_id TEXT NOT NULL UNIQUE REFERENCES capability_grants(grant_id),
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
      issued_by TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      revocation_reason TEXT,
      replaced_by_authority_id TEXT,
      CHECK ((status = 'active') = (revoked_at IS NULL))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_workspace_authority_active
      ON identity_workspace_authorities(identity_id, workspace_id)
      WHERE status = 'active';

    CREATE INDEX IF NOT EXISTS idx_identity_workspace_authority_workspace
      ON identity_workspace_authorities(workspace_id, identity_id);
  `);
}

type Dependencies = Readonly<{
  grants: SqliteCapabilityGrantStore;
  now?: () => string;
  /** Told after authority stops, inside the same transaction, so sessions and passes stop with it. */
  on_revoked?: (record: IdentityWorkspaceAuthorityRecord) => void;
  /** Told after a person's authority in a Workspace starts, is replaced, or stops. */
  on_changed?: (workspaceId: string) => void;
}>;

export class IdentityWorkspaceAuthorityStore {
  private readonly now: () => string;

  constructor(readonly db: DatabaseSync, private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    applyIdentityWorkspaceAuthoritySchema(db);
  }

  /** Issue the root grant for a membership. Idempotent: an active authority is returned unchanged. */
  issue(input: Readonly<{
    identity_id: string;
    workspace_id: string;
    operation_ids: readonly string[];
    targets?: readonly CapabilityGrantTarget[];
    lifetime: AuthorityLifetime;
    issued_by: string;
    evidence: readonly Readonly<{ kind: string; ref: string }>[];
  }>): IdentityWorkspaceAuthorityRecord {
    const existing = this.getActive(input.identity_id, input.workspace_id);
    if (existing) return existing;
    return this.changed(this.inTransaction(() => this.insert(input)));
  }

  getActive(identityId: string, workspaceId: string): IdentityWorkspaceAuthorityRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM identity_workspace_authorities
      WHERE identity_id = ? AND workspace_id = ? AND status = 'active'
    `).get(identityId, workspaceId) as IdentityWorkspaceAuthorityRecord | undefined;
    return row ? { ...row } : null;
  }

  get(authorityId: string): IdentityWorkspaceAuthorityRecord | null {
    const row = this.db.prepare("SELECT * FROM identity_workspace_authorities WHERE authority_id = ?")
      .get(authorityId) as IdentityWorkspaceAuthorityRecord | undefined;
    return row ? { ...row } : null;
  }

  /** Retained history for one identity in one Workspace, newest first. */
  history(identityId: string, workspaceId: string): IdentityWorkspaceAuthorityRecord[] {
    return (this.db.prepare(`
      SELECT * FROM identity_workspace_authorities
      WHERE identity_id = ? AND workspace_id = ?
      ORDER BY issued_at DESC, authority_id
    `).all(identityId, workspaceId) as IdentityWorkspaceAuthorityRecord[]).map((row) => ({ ...row }));
  }

  listActiveForIdentity(identityId: string): IdentityWorkspaceAuthorityRecord[] {
    return (this.db.prepare(`
      SELECT * FROM identity_workspace_authorities
      WHERE identity_id = ? AND status = 'active'
      ORDER BY workspace_id
    `).all(identityId) as IdentityWorkspaceAuthorityRecord[]).map((row) => ({ ...row }));
  }

  rootGrant(record: IdentityWorkspaceAuthorityRecord): CapabilityGrantRecord {
    const grant = this.dependencies.grants.getGrant(record.root_grant_id);
    if (!grant) throw new Error(`Root grant '${record.root_grant_id}' is missing.`);
    return grant;
  }

  /**
   * Atomically issue a new root and revoke the old one. Without `may_widen`
   * the new root must sit inside the old one: same or fewer operations, targets
   * inside, and no longer lifetime. Only an issuer that already holds wider
   * authority (host control, the admission root) may widen.
   */
  replace(input: Readonly<{
    authority_id: string;
    operation_ids: readonly string[];
    targets?: readonly CapabilityGrantTarget[];
    lifetime: AuthorityLifetime;
    issued_by: string;
    evidence: readonly Readonly<{ kind: string; ref: string }>[];
    may_widen: boolean;
  }>): IdentityWorkspaceAuthorityRecord {
    return this.changed(this.inTransaction(() => {
      const current = this.get(input.authority_id);
      if (!current || current.status !== "active") throw new Error("This authority is no longer active.");
      const root = this.rootGrant(current);
      if (!input.may_widen) requireNarrower(root, input.operation_ids, input.targets ?? [], lifetimeExpiry(input.lifetime));
      const next = this.insertWithoutActiveCheck(current, input);
      this.stop(current, "replaced", next.authority_id);
      return next;
    }));
  }

  revoke(authorityId: string, reason: string): IdentityWorkspaceAuthorityRecord | null {
    const current = this.get(authorityId);
    if (!current || current.status !== "active") return current;
    return this.changed(this.inTransaction(() => {
      this.stop(current, reason, null);
      return this.get(authorityId)!;
    }));
  }

  revokeAllForIdentity(identityId: string, reason: string): IdentityWorkspaceAuthorityRecord[] {
    const stopped = this.inTransaction(() => this.listActiveForIdentity(identityId).map((record) => {
      this.stop(record, reason, null);
      return this.get(record.authority_id)!;
    }));
    for (const record of stopped) this.changed(record);
    return stopped;
  }

  private changed(record: IdentityWorkspaceAuthorityRecord): IdentityWorkspaceAuthorityRecord {
    this.dependencies.on_changed?.(record.workspace_id);
    return record;
  }

  private insert(input: Parameters<IdentityWorkspaceAuthorityStore["issue"]>[0]): IdentityWorkspaceAuthorityRecord {
    const authorityId = `identity_authority_${randomUUID()}`;
    const principalId = identityPrincipalId(input.identity_id);
    const grant = this.dependencies.grants.issueGrant({
      principal_id: principalId,
      boundary: { kind: "workspace", workspace_id: input.workspace_id },
      operation_ids: input.operation_ids,
      targets: input.targets ?? [],
      expires_at: lifetimeExpiry(input.lifetime),
      issuer_id: input.issued_by,
      evidence: [...input.evidence, { kind: "identity_workspace_authority", ref: authorityId }],
    });
    this.db.prepare(`
      INSERT INTO identity_workspace_authorities (
        authority_id, identity_id, principal_id, workspace_id, root_grant_id, status,
        issued_by, issued_at, expires_at, revoked_at, revocation_reason, replaced_by_authority_id
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, NULL, NULL)
    `).run(authorityId, input.identity_id, principalId, input.workspace_id, grant.grant_id,
      input.issued_by, grant.issued_at, grant.expires_at);
    return this.get(authorityId)!;
  }

  private insertWithoutActiveCheck(
    current: IdentityWorkspaceAuthorityRecord,
    input: Parameters<IdentityWorkspaceAuthorityStore["replace"]>[0],
  ): IdentityWorkspaceAuthorityRecord {
    // The unique active index would refuse a second active row, so the old row
    // is marked first and the new row inserted in the same transaction.
    this.db.prepare(`
      UPDATE identity_workspace_authorities SET status = 'revoked', revoked_at = ?, revocation_reason = 'replaced'
      WHERE authority_id = ?
    `).run(this.now(), current.authority_id);
    return this.insert({
      identity_id: current.identity_id,
      workspace_id: current.workspace_id,
      operation_ids: input.operation_ids,
      targets: input.targets,
      lifetime: input.lifetime,
      issued_by: input.issued_by,
      evidence: [...input.evidence, { kind: "replaces_identity_workspace_authority", ref: current.authority_id }],
    });
  }

  private stop(record: IdentityWorkspaceAuthorityRecord, reason: string, replacedBy: string | null): void {
    const at = this.now();
    this.db.prepare(`
      UPDATE identity_workspace_authorities
      SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?), revocation_reason = COALESCE(revocation_reason, ?),
          replaced_by_authority_id = ?
      WHERE authority_id = ?
    `).run(at, reason, replacedBy, record.authority_id);
    this.dependencies.grants.revokeGrant(record.root_grant_id, at);
    this.dependencies.on_revoked?.(this.get(record.authority_id)!);
  }

  private inTransaction<T>(work: () => T): T {
    const name = `identity_authority_${randomUUID().replaceAll("-", "")}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = work();
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}`);
      this.db.exec(`RELEASE ${name}`);
      throw error;
    }
  }
}

function requireNarrower(
  root: CapabilityGrantRecord,
  operationIds: readonly string[],
  targets: readonly CapabilityGrantTarget[],
  expiresAt: string | null,
): void {
  const wider = operationIds.find((id) => !root.operation_ids.includes(id));
  if (wider) throw new AuthorityWideningError(`You cannot add '${wider}': your current authority does not hold it.`);
  if (root.targets.length > 0 && (targets.length === 0
    || targets.some((target) => !root.targets.some((allowed) => targetContains(allowed, target))))) {
    throw new AuthorityWideningError("Targets must stay inside your current authority.");
  }
  if (expiryMs(expiresAt) > expiryMs(root.expires_at)) {
    throw new AuthorityWideningError("The new authority cannot last longer than your current authority.");
  }
}
