import type { ActorDefinitionRevision } from "./actor-definitions.js";
import type { PolicyCategory, PolicyRevisionRecord } from "./policies.js";

export const APPROVAL_POLICY_REF_KIND = "policy";

export type ApprovalPolicyResolution =
  | Readonly<{ ok: true; policy_revision_id: string | null }>
  | Readonly<{ ok: false; reason: string }>;

/**
 * Resolves an Actor definition's `policy_refs.approval` to the exact published
 * Approval Policy revision it pins. A reference must name the policy and the
 * exact revision (`{ kind: "policy", id: policy_id, revision: policy_revision_id }`).
 */
export function resolveActorApprovalPolicy(
  definition: Pick<ActorDefinitionRevision, "workspace_id" | "content">,
  policies: Readonly<{
    getRevision(revisionId: string): PolicyRevisionRecord | null;
    getPolicy(policyId: string): Readonly<{ status: "active" | "retired"; category: PolicyCategory }> | null;
  }>,
): ApprovalPolicyResolution {
  const ref = definition.content.policy_refs.approval;
  if (!ref) return { ok: true, policy_revision_id: null };
  if (ref.kind !== APPROVAL_POLICY_REF_KIND || !ref.revision) {
    return { ok: false, reason: "The approval policy reference must name a policy and its exact published revision." };
  }
  const revision = policies.getRevision(ref.revision);
  const policy = revision ? policies.getPolicy(revision.policy_id) : null;
  if (!revision || !policy || revision.policy_id !== ref.id || revision.workspace_id !== definition.workspace_id) {
    return { ok: false, reason: `Approval policy revision '${ref.revision}' does not exist in this Workspace.` };
  }
  if (revision.category !== "approval") {
    return { ok: false, reason: `Policy revision '${ref.revision}' is a '${revision.category}' policy, not an approval policy.` };
  }
  if (revision.published_at === null || revision.withdrawn_at !== null || policy.status !== "active") {
    return { ok: false, reason: `Approval policy revision '${ref.revision}' is not published and live.` };
  }
  if (revision.content.rules.some((rule) => rule.effect.kind === "limit")) {
    return { ok: false, reason: `Approval policy revision '${ref.revision}' has budget limits; bind budget policies instead.` };
  }
  return { ok: true, policy_revision_id: revision.policy_revision_id };
}
