import {
  BudgetConflictError,
  BudgetStore,
  BudgetValidationError,
  type BudgetReservationRecord,
} from "./budgets.js";
import {
  refusal,
  requireWorkspaceAuthorityId,
  requiredAction,
  type JsonSchema,
  type OperationAuthorityBoundary,
  type OperationResourceIdentity,
  type ResolvedOperationResource,
  type SemanticOperationDefinition,
  type SemanticOperationRegistry,
} from "./operations.js";

export const LIST_BUDGET_RESERVATIONS_OPERATION_ID = "budget.reservation.list";
export const INSPECT_BUDGET_RESERVATION_OPERATION_ID = "budget.reservation.inspect";
export const LIST_RESOURCE_USAGE_OPERATION_ID = "budget.usage.list";
export const RECONCILE_BUDGET_NO_EFFECT_OPERATION_ID = "budget.reservation.reconcile_no_effect";

const text: JsonSchema = { type: "string", minLength: 1 };
const nullableText: JsonSchema = { oneOf: [text, { type: "null" }] };
const usageMapSchema: JsonSchema = {
  type: "object",
  additionalProperties: { type: "number", minimum: 0 },
};
const sourceSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id"],
  properties: {
    kind: { enum: ["operation_invocation", "execution_attempt", "connector_action", "extension_activation"] },
    id: text,
  },
};
const usageFactsSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "workspace_id", "principal_id", "operation_id", "scope_id", "scope_execution_id",
    "actor_id", "scope_composition_revision_id", "node_placement_id", "connector_binding_id", "extension_installation_id",
  ],
  properties: {
    workspace_id: text,
    principal_id: text,
    operation_id: text,
    scope_id: nullableText,
    scope_execution_id: nullableText,
    actor_id: nullableText,
    scope_composition_revision_id: nullableText,
    node_placement_id: nullableText,
    connector_binding_id: nullableText,
    extension_installation_id: nullableText,
  },
};
const reservationItemSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "reservation_item_id", "reservation_id", "policy_revision_id", "policy_binding_id", "rule_id",
    "subject", "metric", "maximum", "window", "timezone", "window_start", "window_end", "estimated_amount",
  ],
  properties: {
    reservation_item_id: text,
    reservation_id: text,
    policy_revision_id: text,
    policy_binding_id: text,
    rule_id: text,
    subject: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "id"],
      properties: {
        kind: { enum: ["workspace", "scope", "actor", "node_placement", "connector_binding", "extension_installation"] },
        id: text,
      },
    },
    metric: text,
    maximum: { type: "number", minimum: 0 },
    window: { enum: ["operation", "scope_execution", "day", "month", "all_time"] },
    timezone: nullableText,
    window_start: nullableText,
    window_end: nullableText,
    estimated_amount: { type: "number", minimum: 0 },
  },
};
const emptyInput: JsonSchema = { type: "object", additionalProperties: false };
const reservationSchema: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: [
    "reservation_id", "workspace_id", "source", "policy_evaluation_id", "facts",
    "estimates", "state", "idempotency_digest", "actual_usage_digest", "created_at",
    "updated_at", "completed_at", "items",
  ],
  properties: {
    reservation_id: text,
    workspace_id: text,
    source: sourceSchema,
    policy_evaluation_id: text,
    facts: usageFactsSchema,
    estimates: usageMapSchema,
    state: { enum: ["reserved", "committed", "released", "outcome_unknown", "exceeded"] },
    idempotency_digest: text,
    actual_usage_digest: nullableText,
    created_at: text,
    updated_at: text,
    completed_at: nullableText,
    items: { type: "array", items: reservationItemSchema },
  },
};
const usageSchema: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: [
    "usage_entry_id", "workspace_id", "source", "principal_id", "operation_id",
    "scope_id", "scope_execution_id", "actor_id", "node_placement_id",
    "scope_composition_revision_id", "connector_binding_id", "extension_installation_id", "metric", "amount", "observed_at",
  ],
  properties: {
    usage_entry_id: text,
    workspace_id: text,
    source: sourceSchema,
    principal_id: text,
    operation_id: text,
    scope_id: nullableText,
    scope_execution_id: nullableText,
    actor_id: nullableText,
    scope_composition_revision_id: nullableText,
    node_placement_id: nullableText,
    connector_binding_id: nullableText,
    extension_installation_id: nullableText,
    metric: text,
    amount: { type: "number", minimum: 0 },
    observed_at: text,
  },
};

function readEffects() {
  return { mode: "read" as const, reversibility: "none" as const, external: false, secret_access: "none" as const };
}

function writeEffects() {
  return { mode: "write" as const, reversibility: "irreversible" as const, external: false, secret_access: "none" as const };
}

function auditRef(invocationId: string) {
  return { kind: "operation_invocation", id: invocationId, revision: null };
}

function reservationRef(reservation: BudgetReservationRecord) {
  return { kind: "budget_reservation", id: reservation.reservation_id, revision: reservation.updated_at };
}

function mapFailure(error: unknown) {
  if (error instanceof BudgetConflictError) {
    return refusal("budget_state_changed", error.message, false, requiredAction(
      "inspect_budget_reservation",
      "Review current resource use",
      "Inspect the reservation and its external evidence before taking another action.",
    ));
  }
  if (error instanceof BudgetValidationError) {
    return refusal("budget_reservation_invalid", error.message, false, requiredAction(
      "inspect_budget_reservation",
      "Review current resource use",
      "Inspect the reservation and correct the selected action.",
    ));
  }
  throw error;
}

export function budgetOperationDefinitions(store: BudgetStore): readonly SemanticOperationDefinition[] {
  return [
    {
      operation_id: LIST_BUDGET_RESERVATIONS_OPERATION_ID,
      operation_version: "1",
      authority_boundary_kinds: ["workspace"],
      category: "budgets",
      title: "List resource reservations",
      description: "List retained resource reservations and their exact Policy limits.",
      effects: readEffects(),
      required_grants: [LIST_BUDGET_RESERVATIONS_OPERATION_ID],
      interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
      target: { resource_kinds: [], expected_revision: "not_applicable" },
      input: {
        version: "1",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            state: { enum: ["reserved", "committed", "released", "outcome_unknown", "exceeded"] },
          },
        },
      },
      result: {
        version: "1",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["reservations"],
          properties: { reservations: { type: "array", items: reservationSchema } },
        },
      },
      handler: (context, input: unknown) => ({
        state: "completed",
        result: {
          reservations: store.listReservations(
            requireWorkspaceAuthorityId(context.authority),
            { state: (input as { state?: BudgetReservationRecord["state"] }).state },
          ),
        },
        audit_ref: auditRef(context.invocation_id),
      }),
    },
    {
      operation_id: INSPECT_BUDGET_RESERVATION_OPERATION_ID,
      operation_version: "1",
      authority_boundary_kinds: ["workspace"],
      category: "budgets",
      title: "Inspect resource reservation",
      description: "Inspect exact estimates, limits, usage facts, and reconciliation state.",
      effects: readEffects(),
      required_grants: [INSPECT_BUDGET_RESERVATION_OPERATION_ID],
      interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
      target: { resource_kinds: ["budget_reservation"], expected_revision: "not_applicable" },
      input: { version: "1", schema: emptyInput },
      result: { version: "1", schema: reservationSchema },
      handler: (context) => ({
        state: "completed",
        result: store.requireReservationForWorkspace(
          context.target!.ref.id,
          requireWorkspaceAuthorityId(context.authority),
        ),
        audit_ref: auditRef(context.invocation_id),
      }),
    },
    {
      operation_id: LIST_RESOURCE_USAGE_OPERATION_ID,
      operation_version: "1",
      authority_boundary_kinds: ["workspace"],
      category: "budgets",
      title: "List measured resource use",
      description: "List retained measured resource use against canonical execution and operation identities.",
      effects: readEffects(),
      required_grants: [LIST_RESOURCE_USAGE_OPERATION_ID],
      interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
      target: { resource_kinds: [], expected_revision: "not_applicable" },
      input: {
        version: "1",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            metric: text,
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
        },
      },
      result: {
        version: "1",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["usage"],
          properties: { usage: { type: "array", items: usageSchema } },
        },
      },
      handler: (context, input: unknown) => {
        const value = input as { metric?: string; limit?: number };
        return {
          state: "completed",
          result: {
            usage: store.listUsage(requireWorkspaceAuthorityId(context.authority), {
              ...(value.metric ? { metric: value.metric } : {}),
              ...(value.limit ? { limit: value.limit } : {}),
            }),
          },
          audit_ref: auditRef(context.invocation_id),
        };
      },
    },
    {
      operation_id: RECONCILE_BUDGET_NO_EFFECT_OPERATION_ID,
      operation_version: "1",
      authority_boundary_kinds: ["workspace"],
      category: "budgets",
      title: "Confirm no resource effect",
      description: "Release an uncertain reservation only after external evidence proves no effect occurred.",
      effects: writeEffects(),
      required_grants: [RECONCILE_BUDGET_NO_EFFECT_OPERATION_ID],
      interaction_constraints: {
        allowed_modes: ["interactive", "unattended"],
        confirmation: {
          required: true,
          prompt_id: "budget.reconcile_no_effect.confirm",
          title: "Confirm no effect occurred",
          description: "This records that external evidence proved the uncertain action had no resource effect.",
        },
      },
      target: { resource_kinds: ["budget_reservation"], expected_revision: "required" },
      input: { version: "1", schema: emptyInput },
      result: { version: "1", schema: reservationSchema },
      handler: (context) => {
        try {
          const workspaceId = requireWorkspaceAuthorityId(context.authority);
          const current = store.requireReservationForWorkspace(context.target!.ref.id, workspaceId);
          if (current.updated_at !== context.expected_resource_revision) {
            throw new BudgetConflictError(current.source, "the reservation changed before reconciliation");
          }
          const reservation = store.reconcileNoEffect({
            workspace_id: workspaceId,
            reservation_id: current.reservation_id,
          });
          return {
            state: "completed",
            result: reservation,
            changed_refs: [reservationRef(reservation)],
            audit_ref: auditRef(context.invocation_id),
          };
        } catch (error) {
          return { state: "refused", refusal: mapFailure(error) };
        }
      },
    },
  ];
}

export function registerBudgetOperations(registry: SemanticOperationRegistry, store: BudgetStore): SemanticOperationRegistry {
  for (const definition of budgetOperationDefinitions(store)) registry.register(definition);
  return registry;
}

export function resolveBudgetOperationResource(
  store: BudgetStore,
  boundary: OperationAuthorityBoundary,
  target: OperationResourceIdentity,
): ResolvedOperationResource | null {
  if (boundary.kind !== "workspace" || target.kind !== "budget_reservation") return null;
  const reservation = store.getReservation(target.id);
  return reservation?.workspace_id === boundary.workspace_id
    ? { ref: reservationRef(reservation), state: reservation }
    : null;
}
