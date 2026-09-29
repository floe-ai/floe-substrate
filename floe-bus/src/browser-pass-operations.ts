import type { SqliteClientIdentityStore } from "./client-identity-store.js";
import type { BrowserPassRecord, BrowserPassStore } from "./browser-pass.js";
import { BrowserConnectionError, type PendingBrowserConnection } from "./browser-connections.js";
import { lifetimeExpiry, parseAuthorityLifetime, type IdentityWorkspaceAuthorityStore } from "./identity-workspace-authority.js";
import { refusal, requireWorkspaceAuthorityId, type SemanticOperationDefinition } from "./operations.js";

export const BROWSER_PASS_OPERATION_IDS = [
  "browser.connection.list",
  "browser.pass.approve",
  "browser.pass.list",
  "browser.pass.revoke",
] as const;

/** The waiting browsers this Bus process holds; pairing requests live only in memory. */
export type BrowserPairing = Readonly<{
  list: () => PendingBrowserConnection[];
  approve: (connectionId: string, issue: (origin: string) => { pass: BrowserPassRecord; token: string }) => BrowserPassRecord;
}>;

const text = { type: "string", minLength: 1 } as const;
const nullableText = { oneOf: [text, { type: "null" }] } as const;
const connectionSchema = { type: "object", additionalProperties: false,
  required: ["connection_id", "code", "origin", "expires_at"],
  properties: { connection_id: text, code: text, origin: text, expires_at: text } };
const passSchema = { type: "object", additionalProperties: false,
  required: ["pass_id", "workspace_id", "exact_origin", "status", "operation_ids", "issued_at", "authority_expires_at",
    "credential_expires_at", "last_used_at", "revoked_at", "revocation_reason"],
  properties: {
    pass_id: text, workspace_id: text, exact_origin: text, status: { enum: ["active", "revoked"] },
    operation_ids: { type: "array", items: text }, issued_at: text,
    authority_expires_at: { ...nullableText, description: "Null means until revoked." },
    credential_expires_at: { ...text, description: "The browser must be used before this, or pair again." },
    last_used_at: nullableText, revoked_at: nullableText, revocation_reason: nullableText,
  } };
const resultSchema = (properties: Record<string, unknown>) => ({ version: "1", schema: {
  type: "object", additionalProperties: false, required: Object.keys(properties), properties,
} });

type Dependencies = Readonly<{
  passes: BrowserPassStore;
  authorities: IdentityWorkspaceAuthorityStore;
  identities: SqliteClientIdentityStore;
  grants: Readonly<{ getGrant: (id: string) => { operation_ids: readonly string[] } | null }>;
  pairing: () => BrowserPairing | null;
}>;

/**
 * A person lets a browser act for them in this Workspace. The pass rests on the
 * person's own authority: it can hold only what they hold, and ends with it.
 */
export function browserPassOperations(deps: Dependencies): SemanticOperationDefinition<any, any>[] {
  const common = {
    operation_version: "1", authority_boundary_kinds: ["workspace"] as const, category: "permissions",
    interaction_constraints: { allowed_modes: ["interactive"] as const },
    target: { resource_kinds: [], expected_revision: "not_applicable" as const },
  };
  const person = (principalId: string, workspaceId: string) => {
    const identity = deps.identities.listIdentities().find((candidate) => candidate.principal_id === principalId);
    const authority = identity ? deps.authorities.getActive(identity.identity_id, workspaceId) : null;
    return identity && authority ? { identity, authority } : null;
  };
  const missing = { state: "refused" as const, refusal: refusal("identity_workspace_authority_unavailable",
    "Only an admitted person with active authority in this Workspace can manage browser passes.", false, null) };
  const unavailable = { state: "refused" as const, refusal: refusal("browser_pairing_unavailable",
    "This Floe is not accepting browser connections right now.", true, null) };
  const describe = (pass: BrowserPassRecord) => ({
    pass_id: pass.pass_id, workspace_id: pass.workspace_id, exact_origin: pass.exact_origin, status: pass.status,
    operation_ids: [...(deps.grants.getGrant(pass.grant_id)?.operation_ids ?? [])], issued_at: pass.issued_at,
    authority_expires_at: pass.authority_expires_at, credential_expires_at: pass.credential_expires_at,
    last_used_at: pass.last_used_at, revoked_at: pass.revoked_at, revocation_reason: pass.revocation_reason,
  });

  return [{
    ...common, operation_id: "browser.connection.list", required_grants: ["browser.connection.list"],
    title: "List browsers waiting to connect",
    description: "Show browsers that asked to connect to Floe in the last five minutes and are waiting for a person to allow them. Each shows the code it displays and the exact web address it runs at; compare both with the browser before allowing it.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    result: resultSchema({ connections: { type: "array", items: connectionSchema } }),
    input: { version: "1", schema: { type: "object", additionalProperties: false } },
    handler: (context) => {
      if (!person(context.authority.principal_id, requireWorkspaceAuthorityId(context.authority))) return missing;
      const pairing = deps.pairing();
      return pairing ? { state: "completed", result: { connections: pairing.list() } } : unavailable;
    },
  }, {
    ...common, operation_id: "browser.pass.approve", required_grants: ["browser.pass.approve"],
    title: "Allow a browser to act for you",
    description: "Give a waiting browser a pass to use this Workspace as you, limited to the operations you choose. It can never hold more than you do, and it stops when your own access does. The browser keeps working after Floe restarts. Choose the lifetime explicitly: until_revoked, or expires_at. Revoke it at any time with browser.pass.revoke.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    result: resultSchema({ pass: passSchema }),
    input: { version: "1", schema: { type: "object", additionalProperties: false,
      required: ["connection_id", "workspace_id", "operation_ids"], properties: {
        connection_id: text,
        workspace_id: { ...text, description: "Must be the Workspace this session is for." },
        operation_ids: { type: "array", minItems: 1, uniqueItems: true, items: text },
        until_revoked: { const: true },
        expires_at: text,
      } } },
    handler: (context, input) => {
      const workspaceId = requireWorkspaceAuthorityId(context.authority);
      const own = person(context.authority.principal_id, workspaceId);
      if (!own) return missing;
      if (input.workspace_id !== workspaceId) {
        return { state: "refused", refusal: refusal("browser_pass_workspace_mismatch",
          "A browser pass is approved from a session for the same Workspace.", false, null) };
      }
      const pairing = deps.pairing();
      if (!pairing) return unavailable;
      let lifetime: string | null;
      try {
        lifetime = lifetimeExpiry(parseAuthorityLifetime(input));
      } catch (error) {
        return { state: "refused", refusal: refusal("authority_lifetime_required", (error as Error).message, false, null) };
      }
      try {
        const pass = pairing.approve(input.connection_id, (origin) => deps.passes.issue({
          identity_id: own.identity.identity_id, principal_id: context.authority.principal_id, workspace_id: workspaceId,
          exact_origin: origin, source_grant_id: own.authority.root_grant_id, operation_ids: input.operation_ids,
          expires_at: lifetime, evidence: [{ kind: "operation_invocation", ref: context.invocation_id }],
        }));
        return { state: "completed", result: { pass: describe(pass) },
          changed_refs: [{ kind: "capability_grant", id: pass.grant_id, revision: null }],
          audit_ref: { kind: "operation_invocation", id: context.invocation_id, revision: null } };
      } catch (error) {
        if (error instanceof BrowserConnectionError) {
          return { state: "refused", refusal: refusal("browser_connection_unavailable", error.message, false, null) };
        }
        return { state: "refused", refusal: refusal("browser_pass_widening_refused", (error as Error).message, false, null) };
      }
    },
  }, {
    ...common, operation_id: "browser.pass.list", required_grants: ["browser.pass.list"],
    title: "List your browser passes",
    description: "Show the browsers you have allowed to act for you in this Workspace, what each may do, when it was last used, and which have ended.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    result: resultSchema({ passes: { type: "array", items: passSchema } }),
    input: { version: "1", schema: { type: "object", additionalProperties: false } },
    handler: (context) => {
      const workspaceId = requireWorkspaceAuthorityId(context.authority);
      if (!person(context.authority.principal_id, workspaceId)) return missing;
      return { state: "completed", result: {
        passes: deps.passes.list(context.authority.principal_id, workspaceId).map(describe) } };
    },
  }, {
    ...common, operation_id: "browser.pass.revoke", required_grants: ["browser.pass.revoke"],
    title: "Revoke a browser pass",
    description: "Stop a browser acting for you in this Workspace, now. Its next request is refused and its live connection closes. Effects it already caused stay.",
    effects: { mode: "write", reversibility: "irreversible", external: false, secret_access: "none" },
    result: resultSchema({ pass: passSchema }),
    input: { version: "1", schema: { type: "object", additionalProperties: false, required: ["pass_id"],
      properties: { pass_id: text } } },
    handler: (context, input) => {
      const workspaceId = requireWorkspaceAuthorityId(context.authority);
      if (!person(context.authority.principal_id, workspaceId)) return missing;
      const pass = deps.passes.get(input.pass_id);
      if (!pass || pass.principal_id !== context.authority.principal_id || pass.workspace_id !== workspaceId) {
        return { state: "refused", refusal: refusal("browser_pass_not_found",
          "You have no browser pass with this id in this Workspace.", false, null) };
      }
      const revoked = deps.passes.revoke(pass.pass_id, "revoked") ?? pass;
      return { state: "completed", result: { pass: describe(revoked) },
        changed_refs: [{ kind: "capability_grant", id: pass.grant_id, revision: null }],
        audit_ref: { kind: "operation_invocation", id: context.invocation_id, revision: null } };
    },
  }];
}
