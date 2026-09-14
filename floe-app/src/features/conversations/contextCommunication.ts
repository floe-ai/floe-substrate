import { getContext, invokeOperation, listOperations, SemanticOperationError } from "../../bus-client/client.ts";
import { uploadConversationAttachments } from "../../fs/conversationAttachments.ts";
import type {
  ContextRef,
  OperationInvocationReceipt,
  OperationInvocationRequest,
  SemanticOperationDescriptor,
} from "../../bus-client/types.ts";
import { ContextOperationUnavailableError } from "./contextLifecycle.ts";

export const CONTEXT_COMMUNICATION_OPERATION_ID = "context.communication.emit";
export const CONTEXT_CREATE_OPERATION_ID = "context.create";

/** An uncertain send must retain the exact draft until its receipt is known. */
export class ContextCommunicationPendingError extends Error {}

type Submission = {
  request?: OperationInvocationRequest;
  receipt?: OperationInvocationReceipt;
};

async function submitPrepared(
  workspaceId: string,
  submission: Submission,
  prepare: () => Promise<OperationInvocationRequest>,
): Promise<OperationInvocationReceipt> {
  if (submission.receipt) return submission.receipt;
  submission.request ??= await prepare();
  let receipt: OperationInvocationReceipt;
  try {
    receipt = await invokeOperation(workspaceId, submission.request);
  } catch (error) {
    if (error instanceof SemanticOperationError) throw error;
    throw new ContextCommunicationPendingError("Floe has not confirmed this send. Retry to check the same message without sending it twice.");
  }
  if (receipt.state === "refused") {
    throw new ContextOperationUnavailableError(receipt.refusal?.message ?? "Floe refused this message.");
  }
  if (receipt.state !== "completed") {
    throw new ContextCommunicationPendingError(receipt.refusal?.message ?? "Floe is still confirming this send. Retry to check the same message.");
  }
  submission.receipt = receipt;
  return receipt;
}

function descriptor(
  operations: SemanticOperationDescriptor[],
  operationId: string,
  unavailableMessage: string,
): SemanticOperationDescriptor {
  const operation = operations.find(
    candidate => candidate.operation_id === operationId,
  );
  if (!operation) {
    throw new ContextOperationUnavailableError(unavailableMessage);
  }
  return operation;
}

function idempotencyKey(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${suffix}`;
}

function revision(context: ContextRef): string {
  if (!Number.isInteger(context.state_revision) || (context.state_revision ?? 0) < 1) {
    throw new ContextOperationUnavailableError(
      "Refresh this conversation before sending so Floe can protect newer changes.",
    );
  }
  return String(context.state_revision);
}

/**
 * Send one deliberate Context message through the Bus-owned operation contract.
 * The authenticated principal is the author; the app never supplies authority.
 */
export async function emitContextCommunication(
  workspaceId: string,
  context: ContextRef,
  input: {
    recipientParticipantId: string | null;
    content: Record<string, unknown>;
    artefactVersionIds?: string[];
    attachmentIngressIds?: string[];
    responseExpected: boolean;
  },
  submission: Submission = {},
): Promise<OperationInvocationReceipt> {
  const target = { kind: "context", id: context.context_id };
  const receipt = await submitPrepared(workspaceId, submission, async () => {
    const operation = descriptor(
      await listOperations(workspaceId, target),
      CONTEXT_COMMUNICATION_OPERATION_ID,
      "This Floe installation cannot send messages in this conversation yet.",
    );
    if (!operation.availability.available) {
      throw new ContextOperationUnavailableError(operation.availability.refusal.message);
    }
    return {
      operation_id: operation.operation_id,
      operation_version: operation.operation_version,
      input_schema_version: operation.input.version,
      target,
      expected_resource_revision: revision(context),
      idempotency_key: idempotencyKey("context-communication"),
      input: {
        event_type: "message",
        recipient_participant_id: input.recipientParticipantId,
        content: input.content,
        artefact_version_ids: input.artefactVersionIds ?? [],
        attachment_ingress_ids: input.attachmentIngressIds ?? [],
        response_expected: input.responseExpected,
      },
    };
  });
  if (receipt.refusal) {
    throw new ContextOperationUnavailableError(receipt.refusal.message);
  }
  const eventRef = (receipt.result as { event_ref?: unknown } | null)?.event_ref;
  if (!eventRef || typeof eventRef !== "object" || (eventRef as { kind?: unknown }).kind !== "event") {
    throw new ContextCommunicationPendingError(
      "Floe accepted the message but did not return its Event identity.",
    );
  }
  return receipt;
}

/**
 * Create a direct collaboration Context through the same discoverable contract
 * used by every client. Participant roles and access remain Bus-owned defaults.
 */
export async function createDirectConversation(
  workspaceId: string,
  participantIds: string[],
  title?: string | null,
  submission: Submission = {},
): Promise<ContextRef> {
  const receipt = await submitPrepared(workspaceId, submission, async () => {
    const operation = descriptor(
      await listOperations(workspaceId),
      CONTEXT_CREATE_OPERATION_ID,
      "This Floe installation cannot start a conversation yet.",
    );
    if (!operation.availability.available) {
      throw new ContextOperationUnavailableError(operation.availability.refusal.message);
    }
    return {
      operation_id: operation.operation_id,
      operation_version: operation.operation_version,
      input_schema_version: operation.input.version,
      idempotency_key: idempotencyKey("context-create"),
      input: {
        title: title ?? null,
        participants: participantIds.map(participant_id => ({ participant_id })),
      },
    };
  });
  if (receipt.refusal) {
    throw new ContextOperationUnavailableError(receipt.refusal.message);
  }
  const created = (receipt.result as { context?: { context_id?: unknown } } | null)?.context;
  if (!created || typeof created.context_id !== "string" || !created.context_id) {
    throw new ContextCommunicationPendingError(
      "Floe accepted the conversation but did not return its Context identity.",
    );
  }
  try {
    return await getContext(created.context_id, workspaceId);
  } catch {
    throw new ContextCommunicationPendingError("The conversation was created, but Floe could not open it yet. Retry to open the same conversation.");
  }
}

/** One deliberate send, retaining uploads and exact requests across retries. */
export function createConversationSubmission(workspaceId: string, input: {
  context?: ContextRef;
  onContextCreated?: (context: ContextRef) => void;
  participantIds?: string[];
  recipientParticipantId: string | null;
  responseExpected?: boolean;
  text: string;
  files: File[];
}): () => Promise<string> {
  let context = input.context;
  let attachmentIngressIds: string[] | undefined;
  const files = [...input.files];
  const creation: Submission = {};
  const communication: Submission = {};
  let inFlight: Promise<string> | undefined;
  const send = async () => {
    context ??= await createDirectConversation(workspaceId, input.participantIds ?? [], undefined, creation);
    input.onContextCreated?.(context);
    attachmentIngressIds ??= (await uploadConversationAttachments(workspaceId, context.context_id, files))
      .map(attachment => attachment.ingress_session_id);
    await emitContextCommunication(workspaceId, context, {
      recipientParticipantId: input.recipientParticipantId,
      content: input.text ? { text: input.text } : {},
      attachmentIngressIds,
      responseExpected: input.responseExpected ?? true,
    }, communication);
    return context.context_id;
  };
  return () => inFlight ??= send().finally(() => { inFlight = undefined; });
}
