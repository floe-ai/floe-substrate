import { beforeEach, describe, expect, it, vi } from "vitest";

import * as client from "../../bus-client/client.ts";
import type {
  ContextRef,
  OperationInvocationReceipt,
  SemanticOperationDescriptor,
} from "../../bus-client/types.ts";
import {
  CONTEXT_COMMUNICATION_OPERATION_ID,
  CONTEXT_CREATE_OPERATION_ID,
  createDirectConversation,
  emitContextCommunication,
  createConversationSubmission,
  ContextCommunicationPendingError,
} from "./contextCommunication.ts";
import { uploadConversationAttachments } from "../../fs/conversationAttachments.ts";

vi.mock("../../bus-client/client.ts", () => ({
  getContext: vi.fn(),
  invokeOperation: vi.fn(),
  listOperations: vi.fn(),
  SemanticOperationError: class extends Error {},
}));
vi.mock("../../fs/conversationAttachments.ts", () => ({ uploadConversationAttachments: vi.fn() }));

const context: ContextRef = {
  context_id: "context:one",
  workspace_id: "workspace:one",
  scope_id: null,
  parent_context_id: null,
  created_by_endpoint_id: null,
  created_at: "2026-09-04T00:00:00.000Z",
  state_revision: 7,
  lifecycle_state: "active",
  content_state: "available",
  last_event_at: null,
  participants: ["actor:floe", "actor:operator"],
  title: null,
  first_message_preview: null,
};

const operation: SemanticOperationDescriptor = {
  operation_id: CONTEXT_COMMUNICATION_OPERATION_ID,
  operation_version: "1",
  authority_boundary_kinds: ["workspace"],
  category: "contexts",
  title: "Communicate in Context",
  description: "Canonical direct communication",
  effects: { mode: "write", reversibility: "irreversible", external: false, secret_access: "none" },
  required_grants: [CONTEXT_COMMUNICATION_OPERATION_ID],
  interaction_constraints: { allowed_modes: ["interactive"] },
  target: { resource_kinds: ["context"], expected_revision: "required" },
  input: { version: "1", schema: {} },
  result: { version: "1", schema: {} },
  availability: { available: true },
};

const createOperation: SemanticOperationDescriptor = {
  ...operation,
  operation_id: CONTEXT_CREATE_OPERATION_ID,
  title: "Create Context",
  target: { resource_kinds: [], expected_revision: "not_applicable" },
};

const receipt = {
  state: "completed",
  result: { event_ref: { kind: "event", id: "event:one", revision: "now" } },
  refusal: null,
} as OperationInvocationReceipt;

describe("canonical Context communication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.listOperations).mockResolvedValue([operation, createOperation]);
    vi.mocked(client.invokeOperation).mockResolvedValue(receipt);
    vi.mocked(client.getContext).mockResolvedValue(context);
    vi.mocked(uploadConversationAttachments).mockResolvedValue([]);
  });

  it("creates direct collaboration through the exact discovered Context operation", async () => {
    vi.mocked(client.invokeOperation).mockResolvedValue({
      ...receipt,
      operation_id: CONTEXT_CREATE_OPERATION_ID,
      result: { context: { context_id: "context:one" } },
    });

    await expect(createDirectConversation(
      "workspace:one",
      ["actor:operator", "actor:floe"],
    )).resolves.toEqual(context);

    expect(client.listOperations).toHaveBeenCalledWith("workspace:one");
    expect(client.invokeOperation).toHaveBeenCalledWith("workspace:one", {
      operation_id: CONTEXT_CREATE_OPERATION_ID,
      operation_version: "1",
      input_schema_version: "1",
      idempotency_key: expect.stringMatching(/^context-create:/),
      input: {
        title: null,
        participants: [
          { participant_id: "actor:operator" },
          { participant_id: "actor:floe" },
        ],
      },
    });
    expect(client.getContext).toHaveBeenCalledWith("context:one", "workspace:one");
  });

  it("invokes the exact discovered operation and never supplies author authority", async () => {
    await emitContextCommunication("workspace:one", context, {
      recipientParticipantId: "actor:floe",
      content: { text: "Reach this outcome" },
      responseExpected: true,
    });

    expect(client.listOperations).toHaveBeenCalledWith(
      "workspace:one",
      { kind: "context", id: "context:one" },
    );
    expect(client.invokeOperation).toHaveBeenCalledWith("workspace:one", {
      operation_id: CONTEXT_COMMUNICATION_OPERATION_ID,
      operation_version: "1",
      input_schema_version: "1",
      target: { kind: "context", id: "context:one" },
      expected_resource_revision: "7",
      idempotency_key: expect.stringMatching(/^context-communication:/),
      input: {
        event_type: "message",
        recipient_participant_id: "actor:floe",
        content: { text: "Reach this outcome" },
        artefact_version_ids: [],
        attachment_ingress_ids: [],
        response_expected: true,
      },
    });
    const request = vi.mocked(client.invokeOperation).mock.calls[0]?.[1] as unknown as Record<string, unknown>;
    expect(request).not.toHaveProperty("principal_id");
    expect(request).not.toHaveProperty("source_endpoint_id");
  });

  it("does not fall back when the canonical operation is unavailable", async () => {
    vi.mocked(client.listOperations).mockResolvedValue([]);

    await expect(emitContextCommunication("workspace:one", context, {
      recipientParticipantId: "actor:floe",
      content: { text: "Hello" },
      responseExpected: true,
    })).rejects.toThrow("cannot send messages");
    expect(client.invokeOperation).not.toHaveBeenCalled();
  });

  it("retries the exact message after a lost response without uploading again or refreshing its request", async () => {
    vi.mocked(uploadConversationAttachments).mockResolvedValue([{ ingress_session_id: "upload:one" } as any]);
    vi.mocked(client.invokeOperation).mockRejectedValueOnce(new Error("response lost")).mockResolvedValue(receipt);
    const file = new File(["image"], "image.png", { type: "image/png" });
    const send = createConversationSubmission("workspace:one", {
      context: { ...context }, recipientParticipantId: "actor:floe", text: "Inspect this", files: [file],
    });
    await expect(send()).rejects.toBeInstanceOf(ContextCommunicationPendingError);
    const original = structuredClone(vi.mocked(client.invokeOperation).mock.calls[0]![1]);
    vi.mocked(client.listOperations).mockResolvedValue([]);
    await expect(send()).resolves.toBe("context:one");
    expect(vi.mocked(client.invokeOperation).mock.calls[1]![1]).toEqual(original);
    expect(uploadConversationAttachments).toHaveBeenCalledTimes(1);
    expect(client.listOperations).toHaveBeenCalledTimes(1);
    expect(original.input).toMatchObject({ attachment_ingress_ids: ["upload:one"], content: { text: "Inspect this" } });
  });

  it("recovers the original new conversation when its creation response is lost", async () => {
    vi.mocked(client.invokeOperation)
      .mockRejectedValueOnce(new Error("creation response lost"))
      .mockResolvedValueOnce({ ...receipt, result: { context: { context_id: "context:one" } } })
      .mockResolvedValue(receipt);
    const send = createConversationSubmission("workspace:one", {
      participantIds: ["actor:floe"], recipientParticipantId: "actor:floe", text: "Start", files: [],
    });
    await expect(send()).rejects.toBeInstanceOf(ContextCommunicationPendingError);
    await expect(send()).resolves.toBe("context:one");
    expect(vi.mocked(client.invokeOperation).mock.calls[1]![1]).toEqual(vi.mocked(client.invokeOperation).mock.calls[0]![1]);
    expect(vi.mocked(client.invokeOperation).mock.calls[2]![1].operation_id).toBe(CONTEXT_COMMUNICATION_OPERATION_ID);
  });

  it("retains a created conversation when an upload fails before sending and the draft is corrected", async () => {
    vi.mocked(client.invokeOperation)
      .mockResolvedValueOnce({ ...receipt, result: { context: { context_id: "context:one" } } })
      .mockResolvedValue(receipt);
    vi.mocked(uploadConversationAttachments).mockRejectedValueOnce(new Error("empty image"));
    let retained: ContextRef | undefined;
    const first = createConversationSubmission("workspace:one", {
      participantIds: ["actor:floe"], recipientParticipantId: "actor:floe", text: "Review", files: [],
      onContextCreated: value => { retained = value; },
    });
    await expect(first()).rejects.toThrow("empty image");
    const corrected = createConversationSubmission("workspace:one", {
      context: retained, recipientParticipantId: "actor:floe", text: "Corrected draft", files: [],
    });
    await expect(corrected()).resolves.toBe("context:one");
    expect(vi.mocked(client.invokeOperation).mock.calls.map(call => call[1].operation_id))
      .toEqual([CONTEXT_CREATE_OPERATION_ID, CONTEXT_COMMUNICATION_OPERATION_ID]);
  });

  it("shares one in-flight send when the same submission is triggered twice", async () => {
    const send = createConversationSubmission("workspace:one", {
      context, recipientParticipantId: "actor:floe", text: "Only once", files: [],
    });
    const first = send();
    const second = send();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(client.invokeOperation).toHaveBeenCalledTimes(1);
    expect(uploadConversationAttachments).toHaveBeenCalledTimes(1);
  });
});
