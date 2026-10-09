import { createHash } from "node:crypto";
import type { WorkspaceConfigurationPolicyProvider } from "./workspace-config-import.js";
import { CAPABILITY_GRANT_OPERATION_IDS } from "./capability-grant-operations.js";
import { ENGINE_TOOL_OPERATIONS } from "./tool-policy.js";

/**
 * What an Actor can do by default when a person gives it access: the same as
 * the default Floe Actor, unless its creator chooses limits (D1). Always cut to
 * what the giving person holds, so it can never widen their authority.
 */
export const DEFAULT_ACTOR_OPERATIONS_V1: readonly string[] = Object.freeze([
  ...CAPABILITY_GRANT_OPERATION_IDS,
  "actor.create", "actor.definition.draft.create", "actor.definition.draft.replace",
  "actor.definition.get", "actor.definition.publish", "actor.definition.rollback",
  "actor.inspect", "actor.list", "actor.reactivate", "actor.retire",
  "actor.runtime-binding.create", "actor.runtime-binding.get", "actor.runtime-binding.inspect", "actor.runtime-binding.replace",
  "approval.inspect", "approval.list", "approval.request", "approval.response.configure",
  "artefact.create", "artefact.inspect", "artefact.search", "artefact.version.publish", "artefact.version.export",
  "connector.inspect", "context.archive", "context.communication.emit", "context.create", "context.get",
  "context.inspect", "context.list", "context.participant.remove", "context.participant.set_access", "context.restore",
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
  // Engine built-ins are unrestricted by default; a person may choose limits.
  ...Object.values(ENGINE_TOOL_OPERATIONS),
]);

/**
 * Local product import policy. In a Workspace with exactly one person, every
 * Actor the Workspace files define gets the default access, delegated from
 * that person's root: issued by them, lasting until they revoke it or their
 * own access ends. With no person, or several, the files give nothing new and
 * existing access is kept; a person adopts the Actors instead.
 */
export const localProductWorkspacePolicy: WorkspaceConfigurationPolicyProvider = input => {
  // Restore/copy/fork require their own reviewed authority.
  if (!input.init_authorized || !["created", "legacy_retained"].includes(input.creation_kind ?? "")) return null;
  const root = input.sole_person_root;
  if (!root) return null;
  const operations = DEFAULT_ACTOR_OPERATIONS_V1.filter(id => root.operation_ids.includes(id));
  if (operations.length === 0) return null;
  const assignments = input.inventory.actors.map(actor => ({ source_actor_id: actor.source_actor_id, operation_ids: operations }));
  const digest = createHash("sha256")
    .update(JSON.stringify({ workspace_id: input.workspace_id, assignments, root: root.grant_id }))
    .digest("hex").slice(0, 24);
  return {
    policy_revision: `person-delegated-actor-access-v1:${root.grant_id}:${digest}`,
    actor_operation_authority: assignments,
    expires_at: null,
    issuer_id: root.principal_id,
    import_principal_id: "system:workspace-configuration-import",
    delegation_source_grant_id: root.grant_id,
  };
};
