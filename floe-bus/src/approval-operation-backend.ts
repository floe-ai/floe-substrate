import type {
  ApprovalOperationBackend,
} from "./approval-operations.js";
import type { BusStore } from "./store.js";

/** Bus adapter for cross-record Context and decision-Event guarantees. */
export class BusApprovalOperationBackend implements ApprovalOperationBackend {
  readonly store;

  constructor(private readonly bus: BusStore) {
    this.store = bus.approvalStore;
  }

  contextBelongsToWorkspace(contextId: string, workspaceId: string): boolean {
    const context = this.bus.contextStore.getContext(contextId);
    return Boolean(
      context
      && context.workspace_id === workspaceId
      && context.lifecycle_state === "active",
    );
  }

  createRequest(input: Parameters<ApprovalOperationBackend["createRequest"]>[0]) {
    return this.bus.createApprovalRequest(input);
  }

  decideRequest(input: Parameters<ApprovalOperationBackend["decideRequest"]>[0]) {
    return this.bus.decideApprovalRequest(input);
  }

  configureResponse(input: Parameters<ApprovalOperationBackend["configureResponse"]>[0]) {
    return this.bus.configureApprovalResponse(input);
  }
}
