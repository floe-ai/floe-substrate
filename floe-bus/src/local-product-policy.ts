import { createHash } from "node:crypto";
import type { WorkspaceConfigurationPolicyProvider } from "./workspace-config-import.js";
import { CAPABILITY_GRANT_OPERATION_IDS } from "./capability-grant-operations.js";
import type { CapabilityGrantTarget } from "./capability-grants.js";
import type { BusStore } from "./store.js";

/** Local product defaults, explicitly installed by the CLI/desktop entry points. */
export const LOCAL_FLOE_ACTOR_OPERATIONS_V1 = Object.freeze([
  ...CAPABILITY_GRANT_OPERATION_IDS,
  "actor.create", "actor.definition.draft.create", "actor.definition.draft.replace",
  "actor.definition.get", "actor.definition.publish", "actor.definition.rollback",
  "actor.inspect", "actor.list", "actor.reactivate", "actor.retire",
  "actor.runtime-binding.create", "actor.runtime-binding.get", "actor.runtime-binding.inspect", "actor.runtime-binding.replace",
  "approval.inspect", "approval.list", "approval.request", "approval.response.configure",
  "artefact.create", "artefact.inspect", "artefact.search", "artefact.version.publish", "artefact.version.export",
  "connector.inspect", "context.archive", "context.communication.emit", "context.create", "context.get",
  "context.inspect", "context.list", "context.participant.remove", "context.participant.set_access", "context.restore",
  "credential.use", "credential.refresh",
  "extension.inspect", "extension.list", "extension.package.get", "extension.schema.discover",
  "runtime-profile.create", "runtime-profile.draft.create", "runtime-profile.draft.replace", "runtime-profile.inspect",
  "runtime-profile.list", "runtime-profile.publish", "runtime-profile.reactivate", "runtime-profile.retire",
  "runtime-profile.revision.get", "runtime-profile.rollback",
  "scope.create", "scope.list",
  "scope.composition.draft.create", "scope.composition.draft.replace", "scope.composition.clone",
  "scope.composition.compare", "scope.composition.export", "scope.composition.impact.inspect", "scope.composition.import",
  "scope.composition.publish", "scope.composition.rollback", "scope.composition.simulate", "scope.composition.validate",
  "scope.execution.inspect", "scope.execution.pause", "scope.execution.redo", "scope.execution.resume",
  "scope.execution.start", "scope.execution.stop", "scope.node-execution.retry", "scope.node-output.publish",
  "scope.plan.inspect", "workspace.inspect",
]);

export const localProductWorkspacePolicy: WorkspaceConfigurationPolicyProvider = input => {
  // Restore/copy/fork require their own reviewed authority. Existing migration policy is unchanged.
  if (input.creation_kind !== "created" || !input.init_authorized) return null;
  const assignments = input.inventory.actors.filter(actor => actor.source_actor_id === "floe")
    .map(actor => ({ source_actor_id: actor.source_actor_id, operation_ids: LOCAL_FLOE_ACTOR_OPERATIONS_V1 }));
  const now = new Date();
  const renewalWindow = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const expiry = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 4, 1)).toISOString();
  const digest = createHash("sha256").update(JSON.stringify({ workspace_id: input.workspace_id, assignments, expiry })).digest("hex").slice(0, 24);
  return {
    policy_revision: `local-floe-actor-v1:${renewalWindow}:${digest}`,
    actor_operation_authority: assignments, expires_at: expiry,
    issuer_id: "policy:local-floe-actor:v1", import_principal_id: "system:workspace-configuration-import",
  };
};

/** Apply the local product's delegation responsibility without replaying source files. */
export function applyLocalFloeDelegationPolicy(store: BusStore): void {
  applyLocalFloeOperationPolicy(store, "policy:local-floe-delegation:v1", "capgrant_local_floe_delegation_", CAPABILITY_GRANT_OPERATION_IDS);
}

/** Add exact-version export to previously initialised local Floe Actors. */
export function applyLocalFloeExportPolicy(store: BusStore): void {
  applyLocalFloeOperationPolicy(store, "policy:local-floe-export:v1", "capgrant_local_floe_export_", ["artefact.version.export"]);
}

/** The default Floe Actor may explicitly arrange a decision response. */
export function applyLocalFloeApprovalResponsePolicy(store: BusStore): void {
  applyLocalFloeOperationPolicy(store, "policy:local-floe-approval-response:v1", "capgrant_local_floe_approval_response_", ["approval.response.configure"], [{kind:"approval_request",id:null}]);
}

function applyLocalFloeOperationPolicy(store: BusStore, policy: string, grantPrefix: string, operationIds: readonly string[], targets: readonly CapabilityGrantTarget[] = []): void {
  for (const workspace of store.workspaceIdentityStore.listLocalProjections(store.localHostId)) {
    if (!workspace.binding?.init_authorized || !["created", "legacy_retained"].includes(workspace.creation_kind)) continue;
    const ownership = store.db.prepare(`SELECT actor_id FROM workspace_configuration_import_resources
      WHERE workspace_id = ? AND source_actor_id = 'floe'`).get(workspace.workspace_id) as { actor_id: string } | undefined;
    if (!ownership) continue;
    const actor = store.actorDefinitionStore.getActor(ownership.actor_id);
    if (!actor || actor.status !== "active" || actor.workspace_id !== workspace.workspace_id) continue;
    const definition = store.actorDefinitionStore.getCurrentDefinition(actor.actor_id);
    if (!definition) continue;
    const inspection = store.capabilityGrantStore.inspectSessionGrantIds({ principal_id: actor.actor_id,
      boundary: { kind: "workspace", workspace_id: actor.workspace_id }, grant_ids: definition.content.capability_grant_ids });
    if (inspection.unavailable_grants.length > 0) continue;
    if (operationIds.every(id => inspection.active_grants.some(grant => grant.targets.length === 0 && grant.operation_ids.includes(id)))) continue;
    const basis = inspection.active_grants.find(grant => grant.targets.length === 0
      && ["policy:local-floe-actor:v1", "policy:legacy-workspace-model-actor-authority:v1"].includes(grant.issuer_id)
      && grant.evidence.some(item => item.kind === "workspace_configuration_import_policy")
      && grant.operation_ids.includes("actor.create"));
    if (!basis) continue;
    const grantId = `${grantPrefix}${createHash("sha256").update(actor.actor_id).digest("hex").slice(0, 32)}`;
    // Never replace a prior policy grant after removal, expiry or revocation.
    if (store.capabilityGrantStore.getGrant(grantId)) continue;
    store.db.exec("SAVEPOINT local_floe_delegation_policy");
    try {
      const grant = store.capabilityGrantStore.issueGrant({ grant_id: grantId,
        principal_id: actor.actor_id, boundary: basis.boundary, operation_ids: operationIds, targets,
        expires_at: basis.expires_at, issuer_id: policy,
        evidence: [{ kind: "local_product_policy", ref: policy }, { kind: "capability_grant", ref: basis.grant_id }],
      });
      const draft = store.actorDefinitionStore.createDraft({ actor_id: actor.actor_id,
        created_by_principal_id: policy, definition: { ...definition.content,
          capability_grant_ids: [...definition.content.capability_grant_ids, grant.grant_id] },
      });
      store.actorDefinitionStore.publishDraft({ actor_definition_revision_id: draft.actor_definition_revision_id,
        expected_current_revision_id: definition.actor_definition_revision_id, changed_by_principal_id: policy });
      store.db.exec("RELEASE local_floe_delegation_policy");
    } catch (error) {
      store.db.exec("ROLLBACK TO local_floe_delegation_policy"); store.db.exec("RELEASE local_floe_delegation_policy");
      throw error;
    }
  }
}
