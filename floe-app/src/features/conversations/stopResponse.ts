import { invokeOperation, listOperations } from "../../bus-client/client.ts";
import type { OperationInvocationRequest } from "../../bus-client/types.ts";

/** Keep the exact cancellation request across an uncertain connection result. */
export function createResponseStop(workspaceId: string, deliveryId: string): () => Promise<void> {
  let request: OperationInvocationRequest | undefined;
  return async () => {
    if (!request) {
      const target = { kind: "runtime_delivery", id: deliveryId };
      const operation = (await listOperations(workspaceId, target))
        .find(operation => operation.operation_id === "runtime.delivery.cancel");
      if (!operation) throw new Error("This Floe installation cannot stop a direct response yet.");
      if (!operation.availability.available) throw new Error(operation.availability.refusal.message);
      request = {
        operation_id: operation.operation_id, operation_version: operation.operation_version,
        input_schema_version: operation.input.version, target, input: {},
        idempotency_key: `stop-response:${crypto.randomUUID()}`,
      };
    }
    let receipt;
    try { receipt = await invokeOperation(workspaceId, request); }
    catch { throw new Error("Floe has not confirmed Stop. Try Stop again to check the same response."); }
    if (receipt.state !== "completed") {
      throw new Error(receipt.refusal?.message ?? "Floe has not confirmed Stop. Try Stop again to check the same response.");
    }
  };
}
