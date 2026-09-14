import type { EventEnvelope } from "../../bus-client/types.ts";

export function approvalDecisionLabel(decision: unknown): string | null {
  if (decision === "approved") return "Approved";
  if (decision === "rejected") return "Rejected";
  if (decision === "changes_requested") return "Changes requested";
  return null;
}

/** Read the retained decision Event; ordinary message metadata is not a decision. */
export function approvalDecisionFromEvent(event: EventEnvelope): { label: string; reason: string; requestId: string } | null {
  if (event.metadata?.semantic_operation_id !== "approval.decide") return null;
  const label = approvalDecisionLabel(event.content?.decision);
  const reason = event.content?.reason;
  const requestId = event.content?.approval_request_id;
  return label && typeof reason === "string" && typeof requestId === "string" && requestId.trim()
    ? { label, reason, requestId } : null;
}
