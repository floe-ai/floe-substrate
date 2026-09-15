/** Transport-safe execution lifecycle and revision contract, shared by clients. */
export type ScopeExecutionStatus =
  | "queued" | "active" | "waiting_external" | "paused"
  | "blocked" | "completed" | "failed" | "cancelled" | "superseded";

export type NodeExecutionStatus =
  | "collecting" | "ready" | "active" | "waiting_external"
  | "paused" | "retrying" | "blocked" | "completed" | "failed" | "cancelled" | "superseded";

type ExecutionState = {
  revision_id: string;
  state_revision: number;
  completed_at: string | null;
  cancelled_at: string | null;
};

export function scopeExecutionStateRevision(execution: ExecutionState & { status: ScopeExecutionStatus }): string {
  return [execution.revision_id, execution.state_revision, execution.status,
    execution.completed_at ?? "", execution.cancelled_at ?? ""].join(":");
}

export function nodeExecutionStateRevision(node: ExecutionState & { status: NodeExecutionStatus }): string {
  return [node.revision_id, node.state_revision, node.status,
    node.completed_at ?? "", node.cancelled_at ?? ""].join(":");
}
