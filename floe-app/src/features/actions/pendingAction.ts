import type { OperationInvocationRequest, OperationResourceRef, SemanticOperationDescriptor } from "../../bus-client/types.ts";
import { record } from "./SchemaFields.tsx";

export type PendingAction = {
  request: OperationInvocationRequest;
  descriptor: SemanticOperationDescriptor;
  target?: { ref: OperationResourceRef; label: string };
};
const key = (workspaceId: string) => `floe:pending-action:${workspaceId}`;

/** A browser-session journal of submitted intent, never a source of result or authority. */
export function readPendingAction(workspaceId: string): PendingAction | null {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(key(workspaceId)) ?? "null");
    if (!record(raw) || !record(raw.request) || !record(raw.descriptor)
      || typeof raw.request.idempotency_key !== "string" || typeof raw.request.operation_id !== "string"
      || raw.request.operation_id !== raw.descriptor.operation_id || !record(raw.descriptor.input)
      || !record(raw.descriptor.result) || !record(raw.descriptor.effects) || !record(raw.descriptor.target)) return null;
    return raw as unknown as PendingAction;
  } catch { return null; }
}

export function retainPendingAction(workspaceId: string, pending: PendingAction): void {
  // Persist before dispatch. If the journal cannot be saved, no action is sent.
  sessionStorage.setItem(key(workspaceId), JSON.stringify(pending));
}

export function clearPendingAction(workspaceId: string): void {
  sessionStorage.removeItem(key(workspaceId));
}
