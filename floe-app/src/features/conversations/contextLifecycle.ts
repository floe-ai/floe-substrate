import {
  confirmAndInvokeOperation,
  invokeOperation,
  listOperations,
} from "../../bus-client/client.ts";
import type {
  ContextRef,
  OperationInvocationRequest,
  OperationInvocationReceipt,
  OperationRefusal,
  SemanticOperationDescriptor,
} from "../../bus-client/types.ts";

export const CONTEXT_LIST_OPERATION_ID = "context.list";
export const CONTEXT_ARCHIVE_OPERATION_ID = "context.archive";
export const CONTEXT_RESTORE_OPERATION_ID = "context.restore";
export const CONTEXT_DESTROY_OPERATION_ID = "context.destroy_permanently";

export type ContextLifecycleAction =
  | typeof CONTEXT_ARCHIVE_OPERATION_ID
  | typeof CONTEXT_RESTORE_OPERATION_ID;

export type ContextLifecycleResult =
  | { state: "completed"; context: ContextRef; receipt: OperationInvocationReceipt }
  | { state: "refused"; refusal: OperationRefusal };

export type ContextDestructionPreparation =
  | {
      state: "confirmation_required";
      confirmation: { title: string; description: string };
      request: OperationInvocationRequest;
    }
  | { state: "refused"; refusal: OperationRefusal };

export type ConfirmedContextDestructionResult = ContextLifecycleResult | { state: "cancelled" };

export class ContextOperationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextOperationUnavailableError";
  }
}

function operation(
  descriptors: SemanticOperationDescriptor[],
  operationId: string,
): SemanticOperationDescriptor {
  const descriptor = descriptors.find(candidate => candidate.operation_id === operationId);
  if (!descriptor) {
    throw new ContextOperationUnavailableError("This Floe installation cannot manage this conversation yet.");
  }
  return descriptor;
}

function idempotencyKey(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${suffix}`;
}

function requireCurrentRevision(context: ContextRef): number {
  if (!Number.isInteger(context.state_revision) || (context.state_revision ?? 0) < 1) {
    throw new ContextOperationUnavailableError(
      "Refresh this conversation before changing it so Floe can protect newer activity.",
    );
  }
  return context.state_revision!;
}

function destructionRequest(
  descriptor: SemanticOperationDescriptor,
  context: ContextRef,
): OperationInvocationRequest {
  return {
    operation_id: descriptor.operation_id,
    operation_version: descriptor.operation_version,
    input_schema_version: descriptor.input.version,
    target: { kind: "context", id: context.context_id },
    expected_resource_revision: String(requireCurrentRevision(context)),
    idempotency_key: idempotencyKey("context-destroy-permanently"),
    input: { reason: "The operator requested permanent destruction from the archived conversation." },
  };
}

function requiredConfirmation(
  descriptor: SemanticOperationDescriptor,
): { title: string; description: string } {
  const confirmation = (descriptor.interaction_constraints as {
    confirmation?: { required?: unknown; title?: unknown; description?: unknown };
  }).confirmation;
  if (
    confirmation?.required !== true
    || typeof confirmation.title !== "string"
    || !confirmation.title.trim()
    || typeof confirmation.description !== "string"
    || !confirmation.description.trim()
  ) {
    throw new ContextOperationUnavailableError(
      "Floe did not provide the required safety confirmation for permanent destruction.",
    );
  }
  return { title: confirmation.title, description: confirmation.description };
}

function canonicalContext(value: unknown): ContextRef | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ContextRef>;
  if (
    typeof candidate.context_id !== "string"
    || typeof candidate.workspace_id !== "string"
    || !Array.isArray(candidate.participants)
  ) return null;
  return {
    ...candidate,
    first_message_preview: candidate.first_message_preview ?? null,
    last_event_at: candidate.last_event_at ?? null,
  } as ContextRef;
}

export async function listArchivedContexts(
  workspaceId: string,
  participantId: string,
): Promise<ContextRef[]> {
  const descriptor = operation(await listOperations(workspaceId), CONTEXT_LIST_OPERATION_ID);
  if (!descriptor.availability.available) {
    throw new ContextOperationUnavailableError(descriptor.availability.refusal.message);
  }
  const receipt = await invokeOperation(workspaceId, {
    operation_id: descriptor.operation_id,
    operation_version: descriptor.operation_version,
    input_schema_version: descriptor.input.version,
    idempotency_key: idempotencyKey("context-list-archived"),
    input: {
      participant_id: participantId,
      include_archived: true,
      limit: 500,
    },
  });
  if (receipt.refusal) {
    throw new ContextOperationUnavailableError(receipt.refusal.message);
  }
  const values = (receipt.result as { contexts?: unknown[] } | null)?.contexts;
  if (!Array.isArray(values)) {
    throw new ContextOperationUnavailableError("Floe could not read the archived conversation list.");
  }
  return values
    .map(canonicalContext)
    .filter((context): context is ContextRef => context?.lifecycle_state === "archived");
}

export async function invokeContextLifecycle(
  workspaceId: string,
  context: ContextRef,
  operationId: ContextLifecycleAction,
): Promise<ContextLifecycleResult> {
  const target = { kind: "context", id: context.context_id };
  const descriptor = operation(await listOperations(workspaceId, target), operationId);
  if (!descriptor.availability.available) {
    return { state: "refused", refusal: descriptor.availability.refusal };
  }
  if (!Number.isInteger(context.state_revision) || (context.state_revision ?? 0) < 1) {
    throw new ContextOperationUnavailableError(
      "Refresh this conversation before changing it so Floe can protect newer activity.",
    );
  }
  const receipt = await invokeOperation(workspaceId, {
    operation_id: descriptor.operation_id,
    operation_version: descriptor.operation_version,
    input_schema_version: descriptor.input.version,
    target,
    expected_resource_revision: String(context.state_revision),
    idempotency_key: idempotencyKey(operationId.replaceAll(".", "-")),
    input: {},
  });
  if (receipt.refusal) return { state: "refused", refusal: receipt.refusal };
  const changed = canonicalContext((receipt.result as { context?: unknown } | null)?.context);
  if (!changed) {
    throw new ContextOperationUnavailableError("Floe changed the conversation but did not return its current state.");
  }
  return { state: "completed", context: changed, receipt };
}

/** Read the Bus-owned warning before asking the trusted desktop to act. */
export async function prepareContextDestruction(
  workspaceId: string,
  context: ContextRef,
): Promise<ContextDestructionPreparation> {
  const target = { kind: "context", id: context.context_id };
  const descriptor = operation(
    await listOperations(workspaceId, target),
    CONTEXT_DESTROY_OPERATION_ID,
  );
  if (!descriptor.availability.available) {
    return { state: "refused", refusal: descriptor.availability.refusal };
  }
  return {
    state: "confirmation_required",
    confirmation: requiredConfirmation(descriptor),
    request: destructionRequest(descriptor, context),
  };
}

/** The unchanged request crosses a native prompt; no confirmation claim enters its input. */
export async function confirmContextDestruction(
  workspaceId: string,
  request: OperationInvocationRequest,
): Promise<ConfirmedContextDestructionResult> {
  if (request.operation_id !== CONTEXT_DESTROY_OPERATION_ID) {
    throw new ContextOperationUnavailableError("The selected conversation action is invalid.");
  }
  const result = await confirmAndInvokeOperation(workspaceId, request);
  if (!result.confirmed) return { state: "cancelled" };
  const receipt = result.receipt;
  if (receipt.refusal) return { state: "refused", refusal: receipt.refusal };
  const changed = canonicalContext((receipt.result as { context?: unknown } | null)?.context);
  if (!changed) {
    throw new ContextOperationUnavailableError(
      "Floe changed the conversation but did not return its current state.",
    );
  }
  return { state: "completed", context: changed, receipt };
}
