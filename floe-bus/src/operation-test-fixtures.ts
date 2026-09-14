import {
  InMemoryOperationInvocationLedger,
  SemanticOperationRegistry,
  type OperationGovernanceControlPlane,
  type OperationInvocationLedger,
  type OperationSchemaValidator,
} from "./operations.js";

/** Unit-only governance proof. Production Bus construction cannot omit governance. */
export const ALLOWING_TEST_OPERATION_GOVERNANCE: OperationGovernanceControlPlane = {
  prepare: (input) => {
    const common = {
      evidence: {
        policy_evaluation_id: "policy_evaluation:test-allow",
        approval_request_ids: [],
        approval_receipt_ids: [],
        budget_reservation_id: null,
      },
      audit_ref: null,
      canonical_provenance: input.provenance,
    } as const;
    return input.pre_effect_refusal
      ? { ...common, state: "refused" as const, refusal: input.pre_effect_refusal }
      : { ...common, state: "authorized" as const };
  },
  settle: () => undefined,
  recover: () => undefined,
};

export function createTestOperationRegistry(
  validator: OperationSchemaValidator,
  ledger: OperationInvocationLedger = new InMemoryOperationInvocationLedger(),
): SemanticOperationRegistry {
  return new SemanticOperationRegistry(
    validator,
    ledger,
    ALLOWING_TEST_OPERATION_GOVERNANCE,
  );
}
