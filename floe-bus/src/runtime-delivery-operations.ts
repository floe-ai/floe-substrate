import {
  refusal, requireWorkspaceAuthorityId, requiredAction,
  type SemanticOperationDefinition,
} from "./operations.js";

export const CANCEL_RUNTIME_DELIVERY_OPERATION_ID = "runtime.delivery.cancel";
export const ACTIVE_RUNTIME_DELIVERY_STATES = new Set(["reserved", "delivered_to_bridge", "injected_to_runtime"]);

/** A view of the existing transport reservation, not another execution ledger. */
export interface RuntimeDeliveryState {
  delivery_id: string;
  workspace_id: string;
  endpoint_id: string;
  context_id: string;
  state: string;
  scope_execution_id: string | null;
}

export interface RuntimeDeliveryCancellation {
  delivery_id: string;
  state: string;
  cancelled: boolean;
  outcome_unknown: boolean;
}

export function cancelRuntimeDeliveryOperation(backend: {
  cancel(input: { workspace_id: string; delivery_id: string; principal_id: string; invocation_id: string }): RuntimeDeliveryCancellation;
}): SemanticOperationDefinition<Record<string, never>, RuntimeDeliveryCancellation> {
  return {
    operation_id: CANCEL_RUNTIME_DELIVERY_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "runtime",
    title: "Stop response",
    description: "Cancel one exact direct runtime response and its bundled deliveries. Retain history and completed effects. This does not cancel separately delegated work. Use scope.execution.stop for a Scope execution.",
    effects: { mode: "write", reversibility: "irreversible", external: true, secret_access: "none" },
    required_grants: [CANCEL_RUNTIME_DELIVERY_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    // Reservation state may advance while Stop is in flight. Its exact ID is
    // never reused; terminal reservations are returned unchanged.
    target: { resource_kinds: ["runtime_delivery"], expected_revision: "not_applicable" },
    input: { version: "1", schema: { type: "object", additionalProperties: false } },
    result: { version: "1", schema: {
      type: "object", additionalProperties: false,
      required: ["delivery_id", "state", "cancelled", "outcome_unknown"],
      properties: {
        delivery_id: { type: "string" }, state: { type: "string" },
        cancelled: { type: "boolean" }, outcome_unknown: { type: "boolean" },
      },
    } },
    availability: context => {
      const delivery = context.target!.state as RuntimeDeliveryState;
      return delivery.scope_execution_id
        ? { available: false, refusal: refusal("scope_execution_stop_required", "Stop this response through its Scope execution so connected work stops consistently.", false,
          requiredAction("stop_scope_execution", "Stop connected work", "Use scope.execution.stop for this Scope execution.")) }
        : { available: true };
    },
    handler: context => {
      const result = backend.cancel({
        workspace_id: requireWorkspaceAuthorityId(context.authority),
        delivery_id: context.target!.ref.id,
        principal_id: context.authority.principal_id,
        invocation_id: context.invocation_id,
      });
      return {
        state: "completed", result,
        changed_refs: result.cancelled ? [{ kind: "runtime_delivery", id: result.delivery_id, revision: result.state }] : [],
        audit_ref: { kind: "operation_invocation", id: context.invocation_id, revision: null },
      };
    },
  };
}
