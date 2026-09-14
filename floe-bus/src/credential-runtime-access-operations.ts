import type { ActorDefinitionStore } from "./actor-definitions.js";
import type { SqliteCapabilityGrantStore } from "./capability-grants.js";
import type { SecretRefRecord, SqliteSecretRefStore } from "./credential-broker.js";
import { RUNTIME_CREDENTIAL_PURPOSE } from "./credential-operations.js";
import { refusal, type SemanticOperationDefinition } from "./operations.js";

export const GRANT_RUNTIME_CREDENTIAL_ACCESS = "credential.runtime-access.grant";
export const REVOKE_RUNTIME_CREDENTIAL_ACCESS = "credential.runtime-access.revoke";
type Dependencies = { actors: ActorDefinitionStore; grants: SqliteCapabilityGrantStore; refs: SqliteSecretRefStore; access_revoked?: (ref: SecretRefRecord, principalId: string) => void };
const text = { type: "string", minLength: 1 } as const;

/** A host may grant a named Actor narrow use of an account it owns. No material crosses this operation. */
export function runtimeCredentialAccessOperations(deps: Dependencies): SemanticOperationDefinition<any, any>[] {
  return [GRANT_RUNTIME_CREDENTIAL_ACCESS, REVOKE_RUNTIME_CREDENTIAL_ACCESS].map(operationId => {
    const issuing = operationId === GRANT_RUNTIME_CREDENTIAL_ACCESS;
    return {
      operation_id: operationId, operation_version: "1", authority_boundary_kinds: ["host"], category: "credentials",
      title: issuing ? "Allow Actor to Use Account" : "Remove Actor Account Access",
      description: issuing ? "Grant one Actor time-bounded, brokered use and refresh of this account in its Workspace." : "Revoke one retained Actor account grant. Future credential use is refused, including in active Deliveries.",
      effects: { mode: "write", reversibility: issuing ? "reversible" : "irreversible", external: false, secret_access: "reference" },
      required_grants: [operationId], interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
      target: { resource_kinds: ["secret_ref"], expected_revision: "required" },
      input: { version: "1", schema: issuing ? {
        type: "object", additionalProperties: false, required: ["workspace_id", "actor_id", "expires_at"],
        properties: { workspace_id: text, actor_id: text, expires_at: text },
      } : { type: "object", additionalProperties: false, required: ["grant_id"], properties: { grant_id: text } } },
      result: { version: "1", schema: { type: "object", additionalProperties: false, required: ["grant_id", "expires_at", "revoked"], properties: { grant_id: text, expires_at: text, revoked: { type: "boolean" } } } },
      handler: (context, input) => {
        const ref = deps.refs.getSecretRef(context.target?.ref.id ?? "");
        if (!ref || ref.owner.kind !== "host" || context.authority.boundary.kind !== "host" || ref.owner.host_id !== context.authority.boundary.host_id || ref.resource.kind !== "provider_account") {
          return { state: "refused", refusal: refusal("credential_access_owner_mismatch", "This host does not own the requested provider account.", false, null) };
        }
        if (context.expected_resource_revision !== `generation:${ref.generation}:${ref.resolution}`) {
          return { state: "refused", refusal: refusal("credential_access_revision_conflict", "The account changed. Refresh its status before changing access.", true, null) };
        }
        const audit = { kind: "operation_invocation", id: context.invocation_id, revision: null };
        if (!issuing) {
          const grant = deps.grants.getGrant(input.grant_id);
          const constraint = grant && deps.refs.getGrantConstraint(grant.grant_id);
          if (!grant || constraint?.secret_ref_id !== ref.secret_ref_id || !constraint.purposes.includes(RUNTIME_CREDENTIAL_PURPOSE)) {
            return { state: "refused", refusal: refusal("credential_access_grant_mismatch", "That grant does not authorize runtime use of this account.", false, null) };
          }
          deps.grants.revokeGrant(grant.grant_id);
          deps.access_revoked?.(ref, context.authority.principal_id);
          return { state: "completed", result: { grant_id: grant.grant_id, expires_at: grant.expires_at, revoked: true }, audit_ref: audit };
        }
        const actor = deps.actors.getActor(input.actor_id);
        if (!actor || actor.workspace_id !== input.workspace_id || actor.status !== "active") {
          return { state: "refused", refusal: refusal("credential_access_actor_mismatch", "Select an active Actor in the requested Workspace.", false, null) };
        }
        if (ref.resolution !== "resolved" || !Number.isFinite(Date.parse(input.expires_at)) || Date.parse(input.expires_at) <= Date.now()) {
          return { state: "refused", refusal: refusal("credential_access_invalid", "Connect the account and choose a future access expiry.", false, null) };
        }
        // Both records must exist together. The operation ledger retains the authorizing principal.
        deps.actors.db.exec("SAVEPOINT credential_runtime_access");
        try {
          const existing = deps.grants.listActiveGrantsForPrincipalBoundary(actor.actor_id, { kind: "workspace", workspace_id: actor.workspace_id }).find(grant => {
            const constraint = deps.refs.getGrantConstraint(grant.grant_id);
            return Date.parse(grant.expires_at) >= Date.parse(input.expires_at)
              && grant.operation_ids.length === 2 && grant.operation_ids.includes("credential.use") && grant.operation_ids.includes("credential.refresh")
              && grant.targets.length === 2 && grant.targets.some(target => target.kind === "secret_ref" && target.id === ref.secret_ref_id)
              && grant.targets.some(target => target.kind === ref.resource.kind && target.id === ref.resource.id)
              && constraint?.secret_ref_id === ref.secret_ref_id && constraint.purposes.length === 1 && constraint.purposes[0] === RUNTIME_CREDENTIAL_PURPOSE;
          });
          const grant = existing ?? deps.grants.issueGrant({
            principal_id: actor.actor_id, boundary: { kind: "workspace", workspace_id: actor.workspace_id },
            operation_ids: ["credential.use", "credential.refresh"], expires_at: input.expires_at,
            targets: [{ kind: "secret_ref", id: ref.secret_ref_id }, ref.resource],
            issuer_id: context.authority.principal_id, evidence: [{ kind: "operation_invocation", ref: context.invocation_id }],
          });
          if (!existing) deps.refs.attachGrantConstraint({ grant_id: grant.grant_id, authority_boundary: { kind: "workspace", workspace_id: actor.workspace_id }, secret_ref_id: ref.secret_ref_id, purposes: [RUNTIME_CREDENTIAL_PURPOSE] }, deps.grants);
          deps.actors.db.exec("RELEASE credential_runtime_access");
          return { state: "completed", result: { grant_id: grant.grant_id, expires_at: grant.expires_at, revoked: false }, audit_ref: audit };
        } catch (error) {
          deps.actors.db.exec("ROLLBACK TO credential_runtime_access");
          deps.actors.db.exec("RELEASE credential_runtime_access");
          throw error;
        }
      },
    };
  });
}
