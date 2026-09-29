import type { ActorDefinitionStore, ActorDefinitionRevision } from "./actor-definitions.js";
import type { CapabilityGrantRecord, SqliteCapabilityGrantStore } from "./capability-grants.js";
import type { OperationAuthorityContext } from "./operations.js";
import { ENGINE_TOOL_OPERATIONS } from "./tool-policy.js";

export const ALL_ENGINE_TOOL_OPERATION_IDS: readonly string[] = Object.values(ENGINE_TOOL_OPERATIONS).sort();

/** What a newly created Actor received, and anything its creator could not pass on. */
export type NewActorToolAccess = Readonly<{
  limited_by_creator: boolean;
  granted_operation_ids: readonly string[];
  grant_ids: readonly string[];
  not_granted: readonly Readonly<{ operation_id: string; reason: string }>[];
}>;

export class ToolAccessWideningError extends Error {}

/**
 * A new Actor may use every engine tool unless its creator chooses limits. It
 * receives delegated copies of the creator's own engine tool grants, with the
 * same targets and expiry, so it can never hold more than its creator and loses
 * the access when the creator does. A creator's limit may only narrow.
 */
export function passOnEngineToolAccess(input: Readonly<{
  grants: SqliteCapabilityGrantStore;
  actors: ActorDefinitionStore;
  authority: OperationAuthorityContext;
  draft: ActorDefinitionRevision;
  chosen_operation_ids: readonly string[] | undefined;
  invocation_id: string;
}>): { draft: ActorDefinitionRevision; tool_access: NewActorToolAccess } {
  const limited = input.chosen_operation_ids !== undefined;
  const wanted = [...new Set(input.chosen_operation_ids ?? ALL_ENGINE_TOOL_OPERATION_IDS)].sort();
  const held = heldGrants(input.grants, input.authority);
  const notGranted: Array<{ operation_id: string; reason: string }> = [];
  const granted: CapabilityGrantRecord[] = [];
  const covered = new Set<string>();

  for (const operationId of wanted) {
    if (!held.some(grant => grant.operation_ids.includes(operationId))) {
      if (limited) throw new ToolAccessWideningError(`You cannot give '${operationId}' because you do not hold it.`);
      notGranted.push({ operation_id: operationId, reason: "The creator does not hold this engine tool." });
    }
  }
  for (const source of held) {
    const operations = source.operation_ids.filter(id => wanted.includes(id) && !covered.has(id));
    if (operations.length === 0) continue;
    try {
      granted.push(input.grants.delegateGrant({
        authority: input.authority,
        source_grant_id: source.grant_id,
        principal_id: input.draft.actor_id,
        recipient: { kind: "actor", id: input.draft.actor_id },
        operation_ids: operations,
        invocation_id: input.invocation_id,
      }));
      for (const id of operations) covered.add(id);
    } catch (error) {
      if (limited) throw new ToolAccessWideningError((error as Error).message);
      for (const id of operations) notGranted.push({ operation_id: id, reason: (error as Error).message });
    }
  }

  const grantIds = granted.map(grant => grant.grant_id);
  const draft = grantIds.length === 0 ? input.draft : input.actors.replaceDraft({
    actor_definition_revision_id: input.draft.actor_definition_revision_id,
    expected_digest: input.draft.semantic_digest,
    definition: {
      ...input.draft.content,
      capability_grant_ids: [...new Set([...input.draft.content.capability_grant_ids, ...grantIds])],
    },
  });
  const settled = new Map<string, { operation_id: string; reason: string }>();
  for (const item of notGranted) if (!covered.has(item.operation_id)) settled.set(item.operation_id, item);
  return {
    draft,
    tool_access: {
      limited_by_creator: limited,
      granted_operation_ids: [...covered].sort(),
      grant_ids: grantIds,
      not_granted: [...settled.values()].sort((a, b) => a.operation_id.localeCompare(b.operation_id)),
    },
  };
}

/** The creator's session grants that carry engine tool access, longest-lived first. */
function heldGrants(grants: SqliteCapabilityGrantStore, authority: OperationAuthorityContext): CapabilityGrantRecord[] {
  const inspection = grants.inspectSessionGrantIds({
    principal_id: authority.principal_id,
    boundary: authority.boundary,
    grant_ids: authority.session_capability_grant_ids ?? [],
  });
  return [...inspection.active_grants, ...inspection.delegable_grants]
    .filter(grant => grant.operation_ids.some(id => ALL_ENGINE_TOOL_OPERATION_IDS.includes(id)))
    .sort((a, b) => b.expires_at.localeCompare(a.expires_at) || a.grant_id.localeCompare(b.grant_id));
}
