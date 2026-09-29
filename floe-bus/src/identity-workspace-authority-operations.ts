import type { SqliteClientIdentityStore } from "./client-identity-store.js";
import type { ActorAccessAdoption } from "./actor-authority-adoption.js";
import {
  AuthorityLifetimeRequiredError,
  AuthorityWideningError,
  parseAuthorityLifetime,
  type IdentityWorkspaceAuthorityRecord,
  type IdentityWorkspaceAuthorityStore,
} from "./identity-workspace-authority.js";
import { refusal, requireWorkspaceAuthorityId, type SemanticOperationDefinition } from "./operations.js";

export const IDENTITY_WORKSPACE_AUTHORITY_OPERATION_IDS = [
  "identity.workspace-authority.inspect",
  "identity.workspace-authority.replace",
  "identity.workspace-authority.revoke",
  "actor.access.adopt",
] as const;

const text = { type: "string", minLength: 1 } as const;
const nullableText = { oneOf: [text, { type: "null" }] } as const;
const targets = { type: "array", items: { type: "object", additionalProperties: false,
  required: ["kind", "id"], properties: { kind: text, id: nullableText } } };
const authoritySchema = { type: "object", additionalProperties: false,
  required: ["authority_id", "identity_id", "principal_id", "workspace_id", "root_grant_id", "status", "issued_by",
    "issued_at", "expires_at", "revoked_at", "revocation_reason", "replaced_by_authority_id", "operation_ids", "targets"],
  properties: {
    authority_id: text, identity_id: text, principal_id: text, workspace_id: text, root_grant_id: text,
    status: { enum: ["active", "revoked"] }, issued_by: text, issued_at: text,
    expires_at: { ...nullableText, description: "Null means until revoked." },
    revoked_at: nullableText, revocation_reason: nullableText, replaced_by_authority_id: nullableText,
    operation_ids: { type: "array", items: text }, targets,
  } };
const resultSchema = (properties: Record<string, unknown>) => ({ version: "1", schema: {
  type: "object", additionalProperties: false, required: Object.keys(properties), properties,
} });

type Dependencies = Readonly<{
  authorities: IdentityWorkspaceAuthorityStore;
  identities: SqliteClientIdentityStore;
  adoption: () => ActorAccessAdoption;
}>;

/**
 * A person's own durable authority in the Workspace their session is for.
 * Only the identity that holds it may inspect, narrow or revoke it here;
 * widening needs host control, because authority cannot create itself.
 */
export function identityWorkspaceAuthorityOperations(deps: Dependencies): SemanticOperationDefinition<any, any>[] {
  const common = {
    operation_version: "1", authority_boundary_kinds: ["workspace"] as const, category: "permissions",
    interaction_constraints: { allowed_modes: ["interactive"] as const },
  };
  const own = (principalId: string, workspaceId: string): IdentityWorkspaceAuthorityRecord | null => {
    const identity = deps.identities.listIdentities().find((candidate) => candidate.principal_id === principalId);
    return identity ? deps.authorities.getActive(identity.identity_id, workspaceId) : null;
  };
  const describe = (record: IdentityWorkspaceAuthorityRecord) => {
    const root = deps.authorities.rootGrant(record);
    return { ...record, operation_ids: [...root.operation_ids], targets: [...root.targets] };
  };
  const missing = { state: "refused" as const, refusal: refusal("identity_workspace_authority_unavailable",
    "Only an admitted identity with active authority in this Workspace can use this.", false, null) };

  return [{
    ...common, operation_id: "identity.workspace-authority.inspect", required_grants: ["identity.workspace-authority.inspect"],
    title: "Inspect your Workspace authority",
    description: "Show your durable authority in this Workspace: what it covers, when it ends (null expires_at means until revoked), and who issued it. Your sessions reference it; Actor access you delegated depends on it.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    result: resultSchema({ authority: authoritySchema }),
    input: { version: "1", schema: { type: "object", additionalProperties: false } },
    handler: (context) => {
      const record = own(context.authority.principal_id, requireWorkspaceAuthorityId(context.authority));
      return record ? { state: "completed", result: { authority: describe(record) } } : missing;
    },
  }, {
    ...common, operation_id: "identity.workspace-authority.replace", required_grants: ["identity.workspace-authority.replace"],
    title: "Narrow your Workspace authority",
    description: "Replace your Workspace authority with a narrower one: fewer operations, narrower targets, or a shorter lifetime. The old authority is revoked in the same step, which ends your current sessions and every Actor grant delegated from it; delegate again from the new authority. Choose the lifetime explicitly: until_revoked, or expires_at. Widening is refused here.",
    effects: { mode: "write", reversibility: "irreversible", external: false, secret_access: "none" },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    result: resultSchema({ authority: authoritySchema, replaced_authority_id: text }),
    input: { version: "1", schema: { type: "object", additionalProperties: false,
      required: ["operation_ids"], properties: {
        operation_ids: { type: "array", minItems: 1, uniqueItems: true, items: text },
        targets: { ...targets, description: "Omit to keep your current targets. Supplied targets may only narrow them." },
        until_revoked: { const: true },
        expires_at: text,
      } } },
    handler: (context, input) => {
      const current = own(context.authority.principal_id, requireWorkspaceAuthorityId(context.authority));
      if (!current) return missing;
      try {
        const next = deps.authorities.replace({
          authority_id: current.authority_id,
          operation_ids: input.operation_ids,
          targets: input.targets ?? deps.authorities.rootGrant(current).targets,
          lifetime: parseAuthorityLifetime(input),
          issued_by: context.authority.principal_id,
          evidence: [{ kind: "operation_invocation", ref: context.invocation_id }],
          may_widen: false,
        });
        return { state: "completed", result: { authority: describe(next), replaced_authority_id: current.authority_id },
          changed_refs: [{ kind: "capability_grant", id: next.root_grant_id, revision: null }],
          audit_ref: { kind: "operation_invocation", id: context.invocation_id, revision: null } };
      } catch (error) {
        if (error instanceof AuthorityLifetimeRequiredError) {
          return { state: "refused", refusal: refusal("authority_lifetime_required", error.message, false, null) };
        }
        if (error instanceof AuthorityWideningError) {
          return { state: "refused", refusal: refusal("authority_widening_refused", error.message, false, null) };
        }
        throw error;
      }
    },
  }, {
    ...common, operation_id: "identity.workspace-authority.revoke", required_grants: ["identity.workspace-authority.revoke"],
    title: "Give up your Workspace authority",
    description: "Revoke your own authority in this Workspace. Your sessions and browser passes end, and every Actor grant delegated from it stops working. History stays inspectable. Getting authority back needs admission by host control.",
    effects: { mode: "write", reversibility: "irreversible", external: false, secret_access: "none" },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    result: resultSchema({ authority: authoritySchema }),
    input: { version: "1", schema: { type: "object", additionalProperties: false } },
    handler: (context) => {
      const current = own(context.authority.principal_id, requireWorkspaceAuthorityId(context.authority));
      if (!current) return missing;
      const revoked = deps.authorities.revoke(current.authority_id, "revoked")!;
      return { state: "completed", result: { authority: describe(revoked) },
        changed_refs: [{ kind: "capability_grant", id: revoked.root_grant_id, revision: null }],
        audit_ref: { kind: "operation_invocation", id: context.invocation_id, revision: null } };
    },
  }, {
    ...common, operation_id: "actor.access.adopt", required_grants: ["actor.access.adopt"],
    title: "Adopt an Actor's access",
    description: "Become the owner of an Actor's access in this Workspace. Access Floe itself issued is moved onto your authority: the same operations and targets, cut to what you hold, lasting until you revoke it or your own access ends, so it no longer expires on a date. An Actor with no access at all gets the default Actor access from you. Refused when there is nothing to adopt.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    result: resultSchema({
      actor_id: text, actor_definition_revision_id: text,
      moved_grant_ids: { type: "array", items: text }, issued_grant_ids: { type: "array", items: text },
      dropped_operation_ids: { type: "array", items: text, description: "Operations the old access had that you do not hold." },
    }),
    input: { version: "1", schema: { type: "object", additionalProperties: false, required: ["actor_id"],
      properties: { actor_id: text } } },
    handler: (context, input) => {
      const current = own(context.authority.principal_id, requireWorkspaceAuthorityId(context.authority));
      if (!current) return missing;
      const move = deps.adoption().adopt({ actor_id: input.actor_id, authority: current,
        changed_by: context.authority.principal_id, give_default: true });
      if (!move) {
        return { state: "refused", refusal: refusal("actor_access_nothing_to_adopt",
          "This Actor has no Floe-issued access to adopt and already has access of its own, or is not an active Actor in this Workspace.", false, null) };
      }
      return { state: "completed", result: {
        actor_id: move.actor_id, actor_definition_revision_id: move.actor_definition_revision_id,
        moved_grant_ids: [...move.moved_grant_ids], issued_grant_ids: [...move.issued_grant_ids],
        dropped_operation_ids: [...move.dropped_operation_ids],
      }, changed_refs: move.issued_grant_ids.map(id => ({ kind: "capability_grant", id, revision: null })),
        audit_ref: { kind: "operation_invocation", id: context.invocation_id, revision: null } };
    },
  }];
}
