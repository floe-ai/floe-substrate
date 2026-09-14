import type { ActorDefinitionStore } from "./actor-definitions.js";
import type { SqliteCapabilityGrantStore } from "./capability-grants.js";
import type { SqliteSecretRefStore } from "./credential-broker.js";
import { refusal, requireWorkspaceAuthorityId, type SemanticOperationDefinition } from "./operations.js";

export const CAPABILITY_GRANT_OPERATION_IDS = ["capability.grant.list", "capability.grant.delegate", "capability.grant.revoke"] as const;
const text = { type: "string", minLength: 1 } as const;
const targets = { type: "array", items: { type: "object", additionalProperties: false,
  required: ["kind", "id"], properties: { kind: text, id: { oneOf: [text, { type: "null" }] } } } };
const grantSchema = { type: "object", additionalProperties: false,
  required: ["grant_id", "principal_id", "boundary", "operation_ids", "targets", "issued_at", "expires_at", "revoked_at", "issuer_id", "evidence"],
  properties: { grant_id: text, principal_id: text,
    boundary: { type: "object", additionalProperties: false, required: ["kind", "workspace_id"],
      properties: { kind: { const: "workspace" }, workspace_id: text } },
    operation_ids: { type: "array", minItems: 1, uniqueItems: true, items: text }, targets,
    issued_at: text, expires_at: text, revoked_at: { oneOf: [text, { type: "null" }] }, issuer_id: text,
    evidence: { type: "array", items: { type: "object", additionalProperties: false, required: ["kind", "ref"],
      properties: { kind: text, ref: text } } },
  } };
const resultSchema = (properties: Record<string, unknown>) => ({ version: "1", schema: {
  type: "object", additionalProperties: false, required: Object.keys(properties), properties,
} });
type Dependencies = { actors: ActorDefinitionStore; grants: SqliteCapabilityGrantStore; refs: SqliteSecretRefStore };

/** Existing grant lifecycle, exposed through the shared semantic operation boundary. */
export function capabilityGrantOperations(deps: Dependencies): SemanticOperationDefinition<any, any>[] {
  const common = {
    operation_version: "1", authority_boundary_kinds: ["workspace"] as const, category: "permissions",
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] as const },
  };
  const delegate: SemanticOperationDefinition<any, any> = {
    ...common, operation_id: "capability.grant.delegate", required_grants: ["capability.grant.delegate"],
    title: "Delegate permitted access",
    description: "Issue one Actor its own grant containing only the requested subset of one of your session's grants. Requires explicit delegation permission for that Actor. Source and delegation permission remain live dependencies; revoking either removes delegated access. Account purpose constraints are preserved. For an unpublished Actor, omit expected_resource_revision; otherwise supply its exact current_definition_revision_id. Add the returned grant ID to the recipient's Actor definition before publishing it; never copy another Actor's grant IDs.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "reference" },
    target: { resource_kinds: ["actor"], expected_revision: "optional" },
    result: resultSchema({ grant: grantSchema, delegation: { type: "object", additionalProperties: false,
      required: ["source_grant_id", "authority_grant_id"], properties: { source_grant_id: text, authority_grant_id: text } } }),
    input: { version: "1", schema: { type: "object", additionalProperties: false,
      required: ["source_grant_id", "operation_ids"], properties: {
        source_grant_id: text,
        operation_ids: { type: "array", minItems: 1, uniqueItems: true, items: text },
        targets: { ...targets, description: "Omit to preserve the source targets. Supplied targets may only narrow them." },
        expires_at: { ...text, description: "Optional earlier expiry. Otherwise uses the earlier source or delegation-permission expiry." },
      } } },
    handler: (context, input) => {
      const workspaceId = requireWorkspaceAuthorityId(context.authority);
      const actor = deps.actors.getActor(context.target?.ref.id ?? "");
      if (!actor || actor.workspace_id !== workspaceId || actor.status !== "active") {
        return { state: "refused", refusal: refusal("delegation_actor_unavailable", "Select an active Actor in this Workspace.", false, null) };
      }
      if (context.expected_resource_revision !== actor.current_definition_revision_id) {
        return { state: "refused", refusal: refusal("delegation_actor_changed", "The Actor changed. Inspect it before delegating access.", true, null) };
      }
      deps.actors.db.exec("SAVEPOINT delegate_capability");
      try {
        const grant = deps.grants.delegateGrant({ ...input, authority: context.authority,
          principal_id: actor.actor_id, recipient: { kind: "actor", id: actor.actor_id }, invocation_id: context.invocation_id });
        const constraint = deps.refs.getGrantConstraint(input.source_grant_id);
        if (constraint) deps.refs.attachGrantConstraint({ grant_id: grant.grant_id,
          authority_boundary: context.authority.boundary, secret_ref_id: constraint.secret_ref_id,
          purposes: constraint.purposes }, deps.grants);
        deps.actors.db.exec("RELEASE delegate_capability");
        return { state: "completed", result: { grant, delegation: deps.grants.getDelegation(grant.grant_id) },
          changed_refs: [{ kind: "capability_grant", id: grant.grant_id, revision: null }],
          audit_ref: { kind: "operation_invocation", id: context.invocation_id, revision: null } };
      } catch (error) {
        deps.actors.db.exec("ROLLBACK TO delegate_capability"); deps.actors.db.exec("RELEASE delegate_capability");
        return { state: "refused", refusal: refusal("capability_delegation_refused", (error as Error).message, false, null) };
      }
    },
  };
  return [{
    ...common, operation_id: "capability.grant.list", required_grants: ["capability.grant.list"],
    title: "Inspect your permitted access",
    description: "List the current grants pinned by your authenticated session, including their operation and target limits. Delegation creates a new grant for another Actor; these IDs cannot be reused as that Actor's authority.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "reference" },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    result: resultSchema({ active_grants: { type: "array", items: grantSchema },
      unavailable_grants: { type: "array", items: { type: "object", additionalProperties: false,
        required: ["grant_id", "code"], properties: { grant_id: text, code: text } } } }),
    input: { version: "1", schema: { type: "object", additionalProperties: false } },
    handler: context => ({ state: "completed", result: deps.grants.inspectSessionGrantIds({
      principal_id: context.authority.principal_id, boundary: context.authority.boundary,
      grant_ids: context.authority.session_capability_grant_ids ?? [],
    }) }),
  }, delegate, {
    ...common, operation_id: "capability.grant.revoke", required_grants: ["capability.grant.revoke"],
    title: "Withdraw delegated access",
    description: "Revoke a grant you delegated to this Actor. Dependent grants immediately lose authority as well; history remains available.",
    effects: { mode: "write", reversibility: "irreversible", external: false, secret_access: "reference" },
    target: { resource_kinds: ["actor"], expected_revision: "not_applicable" },
    result: resultSchema({ grant: grantSchema }),
    input: { version: "1", schema: { type: "object", additionalProperties: false,
      required: ["grant_id"], properties: { grant_id: text } } },
    handler: (context, input) => {
      const grant = deps.grants.getGrant(input.grant_id);
      if (!grant || !deps.grants.getDelegation(grant.grant_id)
        || grant.issuer_id !== context.authority.principal_id || grant.principal_id !== context.target?.ref.id
        || grant.boundary.kind !== "workspace" || grant.boundary.workspace_id !== requireWorkspaceAuthorityId(context.authority)) {
        return { state: "refused", refusal: refusal("delegation_grant_mismatch", "This is not a grant you delegated to the selected Actor.", false, null) };
      }
      deps.grants.revokeGrant(grant.grant_id);
      return { state: "completed", result: { grant: deps.grants.getGrant(grant.grant_id) },
        changed_refs: [{ kind: "capability_grant", id: grant.grant_id, revision: null }],
        audit_ref: { kind: "operation_invocation", id: context.invocation_id, revision: null } };
    },
  }];
}
