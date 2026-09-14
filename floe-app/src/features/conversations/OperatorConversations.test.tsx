import React, { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  ContextRef,
  EndpointRef,
  EventEnvelope,
  OperationInvocationReceipt,
  SemanticOperationDescriptor,
} from "../../bus-client/types.ts";
import {
  latestConversationWith,
  OperatorConversations,
  summarizeOperatorConversation,
} from "./OperatorConversations.tsx";
import * as client from "../../bus-client/client.ts";
import { ContextCommunicationPendingError } from "./contextCommunication.ts";
import { ensureInteractiveActor } from "../../actors/interactiveActor.ts";

const modelControl = vi.hoisted(() => ({ ready: true }));
const communicationEmit = vi.hoisted(() => vi.fn());
const communicationCreate = vi.hoisted(() => vi.fn());
vi.mock("../../actors/interactiveActor.ts", () => ({ ensureInteractiveActor: vi.fn(async () => ({ actor_id: "workspace:operator" })) }));

vi.mock("../../bus-client/client.ts", () => ({
  confirmAndInvokeOperation: vi.fn(),
  getContext: vi.fn(),
  invokeOperation: vi.fn(),
  listContextsByParticipantPage: vi.fn(),
  listOperations: vi.fn(),
  subscribeEvents: vi.fn(() => () => {}),
}));

vi.mock("./contextCommunication.ts", () => ({
  createConversationSubmission: communicationCreate,
  ContextCommunicationPendingError: class extends Error {},
}));

vi.mock("../../scope/ContextConversation.tsx", () => ({
  ContextConversation: ({ contextId, operatorEntry }: {
    contextId: string;
    operatorEntry?: {
      showContextIdentity?: boolean;
      onBackToConversations?: () => void;
      onNewConversation?: () => void;
      onArchiveConversation?: () => void;
      onRestoreConversation?: () => void;
      onDestroyConversation?: () => void;
      onConfirmDestroyConversation?: () => void;
      onOpenWork?: () => void;
      onReportProblem?: () => void;
      conversationActionError?: string | null;
      conversationActionRefusal?: { message: string; required_action: { title: string; description: string } | null } | null;
      conversationActionConfirmation?: { title: string; description: string } | null;
    };
  }) => (
    <div data-testid="conversation">
      <span>{contextId}:{String(operatorEntry?.showContextIdentity)}</span>
      <button type="button" onClick={operatorEntry?.onBackToConversations}>Conversations</button>
      {operatorEntry?.onOpenWork && <button type="button" onClick={operatorEntry.onOpenWork}>Work</button>}
      {operatorEntry?.onReportProblem && <button type="button" onClick={operatorEntry.onReportProblem}>Report a problem</button>}
      {operatorEntry?.onNewConversation && (
        <button type="button" onClick={operatorEntry.onNewConversation}>New conversation</button>
      )}
      {operatorEntry?.onArchiveConversation && <button type="button" onClick={operatorEntry.onArchiveConversation}>Archive</button>}
      {operatorEntry?.onRestoreConversation && <button type="button" onClick={operatorEntry.onRestoreConversation}>Restore</button>}
      {operatorEntry?.onDestroyConversation && <button type="button" onClick={operatorEntry.onDestroyConversation}>Permanently destroy</button>}
      {operatorEntry?.conversationActionConfirmation && (
        <div role="status">
          {operatorEntry.conversationActionConfirmation.title}: {operatorEntry.conversationActionConfirmation.description}
          {operatorEntry.onConfirmDestroyConversation && (
            <button type="button" onClick={operatorEntry.onConfirmDestroyConversation}>Confirm permanent destruction</button>
          )}
        </div>
      )}
      {operatorEntry?.conversationActionError && <div role="alert">{operatorEntry.conversationActionError}</div>}
      {operatorEntry?.conversationActionRefusal && (
        <div role="alert">
          {operatorEntry.conversationActionRefusal.message}
          {operatorEntry.conversationActionRefusal.required_action?.title}: {operatorEntry.conversationActionRefusal.required_action?.description}
        </div>
      )}
    </div>
  ),
}));

vi.mock("../work/ContextWorkView.tsx", () => ({
  ContextWorkView: ({ rootContextId, onBackToConversation }: {
    rootContextId: string;
    onBackToConversation: () => void;
  }) => (
    <div data-testid="work-view">
      <span>Work for {rootContextId}</span>
      <button type="button" onClick={onBackToConversation}>Conversation</button>
    </div>
  ),
}));

vi.mock("../work/ScopeWorkView.tsx", () => ({
  ScopeWorkView: ({ scope, onBack }: { scope: { title: string }; onBack: () => void }) => (
    <div data-testid="scope-work-view">
      <span>{scope.title}</span>
      <button type="button" onClick={onBack}>Workspace</button>
    </div>
  ),
}));

vi.mock("../../workspace/FloeModelControl.tsx", async () => {
  const ReactModule = await import("react");
  return {
    FloeModelControl: ({ onReadyChange }: { onReadyChange: (ready: boolean) => void }) => {
      ReactModule.useEffect(() => onReadyChange(modelControl.ready), [onReadyChange]);
      return <div data-testid="model-control">model</div>;
    },
  };
});

const OPERATOR = "workspace:operator";
const FLOE = "workspace:floe";
const ARCHITECT = "workspace:architect";

const endpoints: EndpointRef[] = [
  // The authenticated participant is an Actor; no model worker is needed for it.
  endpoint(FLOE, "Floe", "floe"),
  endpoint(ARCHITECT, "Product Architect", "product-architect"),
];

function endpoint(endpointId: string, name: string, agentId: string): EndpointRef {
  return {
    endpoint_id: endpointId,
    workspace_id: "workspace",
    name,
    agent_id: agentId,
    bridge_id: null,
    status: "active",
    metadata_json: "{}",
    created_at: "2026-08-24T00:00:00Z",
    updated_at: "2026-08-24T00:00:00Z",
  };
}

function context(
  contextId: string,
  participant: string,
  title: string,
  lastEventAt: string,
): ContextRef {
  return {
    context_id: contextId,
    workspace_id: "workspace",
    scope_id: null,
    parent_context_id: null,
    created_by_endpoint_id: OPERATOR,
    created_at: "2026-08-24T00:00:00Z",
    updated_at: "2026-08-24T00:00:00Z",
    state_revision: 1,
    lifecycle_state: "active",
    content_state: "available",
    last_event_at: lastEventAt,
    participants: [OPERATOR, participant],
    title,
    first_message_preview: "Initial request",
  };
}

function message(
  eventId: string,
  source: string,
  destination: string,
  text: string,
  expected: boolean,
  createdAt: string,
): EventEnvelope {
  return {
    event_id: eventId,
    type: "message",
    workspace_id: "workspace",
    source_endpoint_id: source,
    thread_id: "thread",
    context_id: "context",
    scope_id: null,
    correlation_id: null,
    destination_json: { kind: "endpoint", endpoint_id: destination },
    content: { text },
    response: { expected },
    metadata: {},
    artefact_version_ids: [],
    created_at: createdAt,
  };
}

function operationDescriptor(operationId: string, target = true): SemanticOperationDescriptor {
  return {
    operation_id: operationId,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "contexts",
    title: operationId,
    description: operationId,
    effects: { mode: operationId === "context.list" ? "read" : "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [operationId],
    interaction_constraints: {},
    target: { resource_kinds: target ? ["context"] : [], expected_revision: target ? "required" : "not_applicable" },
    input: { version: "1", schema: {} },
    result: { version: "1", schema: {} },
    availability: { available: true },
  };
}

function destructionDescriptor(): SemanticOperationDescriptor {
  return {
    ...operationDescriptor("context.destroy_permanently"),
    effects: { mode: "write", reversibility: "irreversible", external: false, secret_access: "none" },
    interaction_constraints: {
      allowed_modes: ["interactive"],
      confirmation: {
        required: true,
        prompt_id: "context.destroy_permanently",
        title: "Permanently destroy Context content",
        description: "This permanently removes the Context's content and cannot be undone.",
      },
    },
  };
}

function operationReceipt(
  operationId: string,
  result: unknown,
  refusal: OperationInvocationReceipt["refusal"] = null,
): OperationInvocationReceipt {
  return {
    receipt_id: `receipt:${operationId}`,
    invocation_id: `invocation:${operationId}`,
    operation_id: operationId,
    operation_version: "1",
    principal_id: "principal:operator",
    authority_boundary: { kind: "workspace", workspace_id: "workspace" },
    workspace_id: "workspace",
    target: null,
    expected_resource_revision: null,
    idempotency_key: `key:${operationId}`,
    request_digest: "digest",
    state: refusal ? "refused" : "completed",
    result_schema_version: "1",
    result,
    refusal,
    changed_refs: [],
    progress_ref: null,
    cancel_ref: null,
    audit_ref: null,
    started_at: "2026-08-24T00:00:00Z",
    updated_at: "2026-08-24T00:00:00Z",
    completed_at: "2026-08-24T00:00:00Z",
  };
}

function Harness(): React.ReactElement {
  const [selectedContextId, setSelectedContextId] = useState<string | null>("context-floe");
  const open = useCallback((contextId: string) => setSelectedContextId(contextId), []);
  const close = useCallback(() => setSelectedContextId(null), []);
  return (
    <OperatorConversations
      workspaceId="workspace"
      workspaceLocator={"C:\\workspace"}
      endpoints={endpoints}
      scopes={[]}
      selectedContextId={selectedContextId}
      onOpenContext={open}
      onCloseContext={close}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  modelControl.ready = true;
  vi.mocked(client.listContextsByParticipantPage).mockResolvedValue({ contexts: [], next_cursor: null });
  communicationCreate.mockReturnValue(communicationEmit);
  communicationEmit.mockResolvedValue("context-new");
  vi.mocked(client.listOperations).mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("operator conversation projection", () => {
  const architectContext = context(
    "context-architect",
    ARCHITECT,
    "Define Acme",
    "2026-08-24T02:00:00Z",
  );

  it("marks a direct expected response from a collaborator as needing the operator", () => {
    const result = summarizeOperatorConversation(
      architectContext,
      [message("event-1", ARCHITECT, OPERATOR, "Which audience should we serve first?", true, "2026-08-24T02:00:00Z")],
      OPERATOR,
      endpoints,
    );

    expect(result.needsOperator).toBe(true);
    expect(result.collaborators).toBe("Product Architect");
    expect(result.preview).toBe("Which audience should we serve first?");
  });

  it("moves the conversation out of attention after the operator replies", () => {
    const result = summarizeOperatorConversation(
      architectContext,
      [
        message("event-1", ARCHITECT, OPERATOR, "Which audience should we serve first?", true, "2026-08-24T02:00:00Z"),
        message("event-2", OPERATOR, ARCHITECT, "Start with environment artists.", true, "2026-08-24T02:01:00Z"),
      ],
      OPERATOR,
      endpoints,
    );

    expect(result.needsOperator).toBe(false);
    expect(result.preview).toBe("Start with environment artists.");
  });

  it.each([
    { active_count: 0, latest_state: "cancelled", label: "Stopped" },
    { active_count: 1, latest_state: "cancelled", label: "Working" },
    { active_count: 0, latest_state: "failed", label: "Needs attention" },
    { active_count: 0, latest_state: "acknowledged", label: null },
  ])("separates current response state from the last message ($label)", ({ label, ...delivery_summary }) => {
    const result = summarizeOperatorConversation(
      { ...architectContext, delivery_summary },
      [message("event-working", ARCHITECT, OPERATOR, "The review is underway.", false, "2026-08-24T02:00:00Z")],
      OPERATOR, endpoints,
    );
    expect(result.responseStatus).toBe(label);
    expect(result.preview).toBe("The review is underway.");
  });

  it("finds the latest sorted conversation involving a collaborator", () => {
    const floeContext = context("context-floe", FLOE, "Build it", "2026-08-24T01:00:00Z");
    const architectSummary = summarizeOperatorConversation(architectContext, [], OPERATOR, endpoints);
    const floeSummary = summarizeOperatorConversation(floeContext, [], OPERATOR, endpoints);
    expect(latestConversationWith([architectSummary, floeSummary], FLOE)?.context.context_id).toBe("context-floe");
  });
});

describe("unified operator conversations", () => {
  const architectContext = context("context-architect", ARCHITECT, "Define Acme", "2026-08-24T02:00:00Z");
  const floeContext = context("context-floe", FLOE, "Build the pipeline", "2026-08-24T01:00:00Z");

  beforeEach(() => {
    vi.mocked(client.listContextsByParticipantPage).mockResolvedValue({
      contexts: [
        {
          ...architectContext,
          latest_message: message("event-1", ARCHITECT, OPERATOR, "I need your decision.", true, "2026-08-24T02:00:00Z"),
        },
        {
          ...floeContext,
          latest_message: message("event-2", FLOE, OPERATOR, "The pipeline is ready.", false, "2026-08-24T01:00:00Z"),
        },
      ],
      next_cursor: null,
    });
  });

  it("isolates participant, draft and late results when switching Workspace", async () => {
    vi.mocked(ensureInteractiveActor)
      .mockResolvedValueOnce({ actor_id: "actor:one:operator" } as Awaited<ReturnType<typeof ensureInteractiveActor>>)
      .mockResolvedValueOnce({ actor_id: "actor:two:operator" } as Awaited<ReturnType<typeof ensureInteractiveActor>>);
    let finishOld!: (page: { contexts: ContextRef[]; next_cursor: null }) => void;
    const oldPage = new Promise<{ contexts: ContextRef[]; next_cursor: null }>(resolve => { finishOld = resolve; });
    vi.mocked(client.listContextsByParticipantPage).mockImplementation(async query =>
      query.workspace_id === "one" ? oldPage : { contexts: [], next_cursor: null });
    const callbacks = { onOpenContext: vi.fn(), onCloseContext: vi.fn() };
    const props = (workspaceId: string) => ({
      ...callbacks, workspaceId, scopes: [], selectedContextId: null,
      endpoints: [{ ...endpoint(`actor:${workspaceId}:floe`, "Floe", "floe"), workspace_id: workspaceId }],
    });
    const view = render(<OperatorConversations {...props("one")} />);
    await waitFor(() => expect(client.listContextsByParticipantPage).toHaveBeenCalledWith({ workspace_id: "one", participant: "actor:one:operator", limit: 20 }));
    view.rerender(<OperatorConversations {...props("two")} />);
    await waitFor(() => expect(client.listContextsByParticipantPage).toHaveBeenCalledWith({ workspace_id: "two", participant: "actor:two:operator", limit: 20 }));
    expect(client.listContextsByParticipantPage).not.toHaveBeenCalledWith(expect.objectContaining({ workspace_id: "two", participant: "actor:one:operator" }));
    await act(async () => { finishOld({ contexts: [{ ...floeContext, first_message_preview: "Old workspace result" }], next_cursor: null }); });
    expect(screen.queryByText("Old workspace result")).toBeNull();
    await screen.findByRole("heading", { name: "What do you want to make happen?" });
    fireEvent.change(screen.getByRole("textbox", { name: "Outcome" }), { target: { value: "Make a gallery" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(communicationCreate).toHaveBeenCalledWith("two", expect.objectContaining({ participantIds: ["actor:two:operator", "actor:two:floe"], recipientParticipantId: "actor:two:floe" })));
  });

  it("lands on the conversation index when conversations already exist", async () => {
    const onOpenContext = vi.fn();
    render(
      <OperatorConversations
        workspaceId="workspace"
        endpoints={endpoints}
        scopes={[]}
        selectedContextId={null}
        onOpenContext={onOpenContext}
        onCloseContext={vi.fn()}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Conversations" })).toBeTruthy();
    expect(onOpenContext).not.toHaveBeenCalled();
    await waitFor(() => expect(client.listContextsByParticipantPage).toHaveBeenCalledWith({
      participant: OPERATOR,
      workspace_id: "workspace",
      limit: 20,
    }));
  });

  it("updates stopped and working labels on lifecycle pushes without replaying routine telemetry", async () => {
    const result = (active_count: number, latest_state: string) => ({ contexts: [{ ...floeContext,
      delivery_summary: { active_count, latest_state },
      latest_message: message("event-review", FLOE, OPERATOR, "The review is underway.", false, "2026-08-24T01:00:00Z"),
    }], next_cursor: null });
    vi.mocked(client.listContextsByParticipantPage).mockResolvedValue(result(0, "cancelled"));
    render(<OperatorConversations workspaceId="workspace" endpoints={endpoints} scopes={[]} selectedContextId={null}
      onOpenContext={vi.fn()} onCloseContext={vi.fn()} />);
    expect(await screen.findByText("Stopped")).toBeTruthy();
    expect(screen.getByText("Last message: The review is underway.")).toBeTruthy();
    const handler = vi.mocked(client.subscribeEvents).mock.calls.at(-1)![0];
    vi.mocked(client.listContextsByParticipantPage).mockClear();
    await act(async () => { handler({ type: "delivery_lease_renewed", payload: {}, at: "2026-08-24T02:00:00Z" }); });
    expect(client.listContextsByParticipantPage).not.toHaveBeenCalled();
    vi.mocked(client.listContextsByParticipantPage).mockResolvedValue(result(1, "reserved"));
    await act(async () => { handler({ type: "delivery_reserved", payload: {}, at: "2026-08-24T02:00:01Z" }); });
    expect(await screen.findByText("Working")).toBeTruthy();
    expect(screen.queryByText("Stopped")).toBeNull();
    vi.mocked(client.listContextsByParticipantPage).mockResolvedValue(result(0, "acknowledged"));
    await act(async () => { handler({ type: "delivery_acknowledged", payload: {}, at: "2026-08-24T02:00:02Z" }); });
    await waitFor(() => expect(screen.queryByText("Working")).toBeNull());
  });

  it("loads older conversation summaries only when the operator asks", async () => {
    vi.mocked(client.listContextsByParticipantPage)
      .mockResolvedValueOnce({
        contexts: [{
          ...architectContext,
          latest_message: message("event-1", ARCHITECT, OPERATOR, "I need your decision.", true, "2026-08-24T02:00:00Z"),
        }],
        next_cursor: "older-page",
      })
      .mockResolvedValueOnce({
        contexts: [{
          ...floeContext,
          latest_message: message("event-2", FLOE, OPERATOR, "The pipeline is ready.", false, "2026-08-24T01:00:00Z"),
        }],
        next_cursor: null,
      });

    render(
      <OperatorConversations
        workspaceId="workspace"
        endpoints={endpoints}
        scopes={[]}
        selectedContextId={null}
        onOpenContext={vi.fn()}
        onCloseContext={vi.fn()}
      />,
    );

    expect(await screen.findByText("I need your decision.")).toBeTruthy();
    expect(screen.queryByText("The pipeline is ready.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show more conversations" }));
    fireEvent.click(screen.getByRole("button", { name: "Load older conversations" }));
    expect(await screen.findByText("The pipeline is ready.")).toBeTruthy();
    expect(client.listContextsByParticipantPage).toHaveBeenLastCalledWith({
      participant: OPERATOR,
      workspace_id: "workspace",
      limit: 20,
      before: "older-page",
    });
  });

  it("opens active organised work from the same workspace index", async () => {
    render(
      <OperatorConversations
        workspaceId="workspace"
        endpoints={endpoints}
        scopes={[{
          scope_id: "acme-delivery",
          workspace_id: "workspace",
          title: "Acme delivery",
          description: "Build and judge one slice at a time.",
          status: "active",
          created_at: "2026-08-27T00:00:00Z",
          updated_at: "2026-08-27T00:00:00Z",
        }]}
        selectedContextId={null}
        onOpenContext={vi.fn()}
        onCloseContext={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open organised work Acme delivery" }));
    expect(screen.getByTestId("scope-work-view").textContent).toContain("Acme delivery");
  });

  it("returns from the selected Floe conversation to the one shared conversation list", async () => {
    render(<Harness />);

    expect((await screen.findByTestId("conversation")).textContent).toContain("context-floe:true");
    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));

    expect(await screen.findByRole("list", { name: "Needs you" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Recent" })).toBeTruthy();
    expect(screen.getByText("I need your decision.")).toBeTruthy();
    expect(screen.getByText("The pipeline is ready.")).toBeTruthy();
  });

  it("opens work as a view of the current conversation and returns to the same chat", async () => {
    render(<Harness />);

    expect(await screen.findByTestId("conversation")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    expect(screen.getByTestId("work-view").textContent).toContain("context-floe");

    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    expect(await screen.findByTestId("conversation")).toBeTruthy();
  });

  it("starts a new conversation with the currently selected collaborator", async () => {
    render(<Harness />);

    fireEvent.click(await screen.findByRole("button", { name: "Conversations" }));
    fireEvent.click(screen.getByRole("button", { name: "Open conversation with Product Architect" }));
    fireEvent.click(await screen.findByRole("button", { name: "New conversation" }));

    expect(await screen.findByText("New conversation with Product Architect")).toBeTruthy();
    expect(communicationCreate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "Refine the audience" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(communicationCreate).toHaveBeenCalledWith(
      "workspace",
      {
        context: undefined,
        onContextCreated: expect.any(Function),
        participantIds: [OPERATOR, ARCHITECT],
        recipientParticipantId: ARCHITECT,
        text: "Refine the audience",
        files: [],
      },
    ));
    expect(communicationEmit).toHaveBeenCalledOnce();
  });

  it("archives a selected conversation through the canonical operation contract", async () => {
    vi.mocked(client.listContextsByParticipantPage)
      .mockResolvedValueOnce({ contexts: [architectContext, floeContext], next_cursor: null })
      .mockResolvedValueOnce({ contexts: [], next_cursor: null });
    vi.mocked(client.listOperations).mockResolvedValue([operationDescriptor("context.archive")]);
    vi.mocked(client.invokeOperation).mockResolvedValue(operationReceipt(
      "context.archive",
      { context: { ...architectContext, lifecycle_state: "archived", state_revision: 2 } },
    ));
    render(<Harness />);

    fireEvent.click(await screen.findByRole("button", { name: "Conversations" }));
    fireEvent.click(screen.getByRole("button", { name: "Open conversation with Product Architect" }));
    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));

    await waitFor(() => expect(client.invokeOperation).toHaveBeenCalledWith("workspace", expect.objectContaining({
      operation_id: "context.archive",
      operation_version: "1",
      input_schema_version: "1",
      target: { kind: "context", id: "context-architect" },
      expected_resource_revision: "1",
      idempotency_key: expect.stringMatching(/^context-archive:/),
      input: {},
    })));
    expect(await screen.findByRole("heading", { name: "Conversations" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open conversation with Product Architect" })).toBeNull();
  });

  it("loads archived conversations on demand and restores one through the canonical operation contract", async () => {
    const archived = {
      ...architectContext,
      lifecycle_state: "archived" as const,
      state_revision: 4,
      archived_at: "2026-08-24T03:00:00Z",
    };
    vi.mocked(client.listContextsByParticipantPage).mockResolvedValue({ contexts: [floeContext], next_cursor: null });
    vi.mocked(client.listOperations).mockImplementation(async (_workspaceId, target) => target
      ? [operationDescriptor("context.restore")]
      : [operationDescriptor("context.list", false)]);
    vi.mocked(client.invokeOperation).mockImplementation(async (_workspaceId, request) => {
      if (request.operation_id === "context.list") {
        return operationReceipt("context.list", { contexts: [archived] });
      }
      return operationReceipt("context.restore", {
        context: { ...archived, lifecycle_state: "active", state_revision: 5 },
      });
    });

    function ArchivedHarness(): React.ReactElement {
      const [selected, setSelected] = useState<string | null>(null);
      return (
        <OperatorConversations
          workspaceId="workspace"
          endpoints={endpoints}
          scopes={[]}
          selectedContextId={selected}
          onOpenContext={setSelected}
          onCloseContext={() => setSelected(null)}
        />
      );
    }

    render(<ArchivedHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "Archived conversations" }));
    expect(await screen.findByRole("list", { name: "Archived" })).toBeTruthy();
    expect(client.invokeOperation).toHaveBeenCalledWith("workspace", expect.objectContaining({
      operation_id: "context.list",
      input: { participant_id: OPERATOR, include_archived: true, limit: 500 },
    }));
    fireEvent.click(within(screen.getByRole("list", { name: "Archived" }))
      .getByRole("button", { name: "Open conversation with Product Architect" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(client.invokeOperation).toHaveBeenCalledWith("workspace", expect.objectContaining({
      operation_id: "context.restore",
      target: { kind: "context", id: "context-architect" },
      expected_resource_revision: "4",
      input: {},
    })));
  });

  it("shows the Bus-owned warning before asking the native host to confirm permanent destruction", async () => {
    const archived = {
      ...floeContext,
      lifecycle_state: "archived" as const,
      state_revision: 4,
    };
    vi.mocked(client.listContextsByParticipantPage).mockResolvedValue({ contexts: [architectContext], next_cursor: null });
    vi.mocked(client.listOperations).mockImplementation(async (_workspaceId, target) => target
      ? [destructionDescriptor()]
      : [operationDescriptor("context.list", false)]);
    vi.mocked(client.invokeOperation).mockImplementation(async (_workspaceId, request) => {
      if (request.operation_id === "context.list") {
        return operationReceipt("context.list", { contexts: [archived] });
      }
      throw new Error("destruction must not use the ordinary browser invocation");
    });

    function ArchivedHarness(): React.ReactElement {
      const [selected, setSelected] = useState<string | null>(null);
      return (
        <OperatorConversations
          workspaceId="workspace"
          endpoints={endpoints}
          scopes={[]}
          selectedContextId={selected}
          onOpenContext={setSelected}
          onCloseContext={() => setSelected(null)}
        />
      );
    }

    render(<ArchivedHarness />);
    fireEvent.click(await screen.findByRole("button", { name: "Archived conversations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open conversation with Floe" }));
    fireEvent.click(await screen.findByRole("button", { name: "Permanently destroy" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain(
      "Permanently destroy Context content: This permanently removes",
    ));
    expect(client.confirmAndInvokeOperation).not.toHaveBeenCalled();
    expect(client.invokeOperation).not.toHaveBeenCalledWith(
      "workspace",
      expect.objectContaining({ operation_id: "context.destroy_permanently" }),
    );
  });

  it("uses native confirmation and keeps the Bus retained-evidence refusal visible", async () => {
    const archived = {
      ...floeContext,
      lifecycle_state: "archived" as const,
      state_revision: 4,
    };
    vi.mocked(client.listContextsByParticipantPage).mockResolvedValue({ contexts: [architectContext], next_cursor: null });
    vi.mocked(client.listOperations).mockImplementation(async (_workspaceId, target) => target
      ? [destructionDescriptor()]
      : [operationDescriptor("context.list", false)]);
    vi.mocked(client.invokeOperation).mockResolvedValue(operationReceipt("context.list", { contexts: [archived] }));
    vi.mocked(client.confirmAndInvokeOperation).mockResolvedValue({
      confirmed: true,
      receipt: operationReceipt("context.destroy_permanently", null, {
        code: "context_retained_references_exist",
        message: "This Context is retained by canonical evidence and cannot be permanently destroyed.",
        retryable: false,
        required_action: {
          code: "inspect_context",
          title: "Inspect retained evidence",
          description: "Inspect the Context to see the records that require its evidence.",
          operation: null,
        },
        details: { retained_references: [{ kind: "node_execution", id: "node:one" }] },
      }),
    });

    function ArchivedHarness(): React.ReactElement {
      const [selected, setSelected] = useState<string | null>(null);
      return (
        <OperatorConversations
          workspaceId="workspace"
          endpoints={endpoints}
          scopes={[]}
          selectedContextId={selected}
          onOpenContext={setSelected}
          onCloseContext={() => setSelected(null)}
        />
      );
    }

    render(<ArchivedHarness />);
    fireEvent.click(await screen.findByRole("button", { name: "Archived conversations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open conversation with Floe" }));
    fireEvent.click(await screen.findByRole("button", { name: "Permanently destroy" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm permanent destruction" }));

    await waitFor(() => expect(client.confirmAndInvokeOperation).toHaveBeenCalledWith(
      "workspace",
      expect.objectContaining({
        operation_id: "context.destroy_permanently",
        target: { kind: "context", id: "context-floe" },
        expected_resource_revision: "4",
      }),
    ));
    expect((await screen.findByRole("alert")).textContent).toContain("retained by canonical evidence");
  });

  it("starts with a new Floe outcome when the workspace has no conversations", async () => {
    vi.mocked(client.listContextsByParticipantPage).mockResolvedValue({ contexts: [], next_cursor: null });
    render(<Harness />);

    expect(await screen.findByText("New conversation with Floe")).toBeTruthy();
    expect(communicationCreate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "Ship the customer report" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(communicationCreate).toHaveBeenCalledWith(
      "workspace",
      expect.objectContaining({
        recipientParticipantId: FLOE,
        text: "Ship the customer report",
      }),
    ));
  });

  it("includes the operator-selected file in one deliberate conversation submission", async () => {
    vi.mocked(client.listContextsByParticipantPage).mockResolvedValue({ contexts: [], next_cursor: null });
    render(<Harness />);

    expect(await screen.findByText("New conversation with Floe")).toBeTruthy();
    const selected = new File(["png"], "screen.png", { type: "image/png" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [selected] } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(communicationCreate).toHaveBeenCalledWith(
      "workspace",
      expect.objectContaining({
        text: "",
        files: [selected],
      }),
    ));
    expect(communicationEmit).toHaveBeenCalledOnce();
  });

  it("retains an uncertain outcome and retries its original submission", async () => {
    vi.mocked(client.listContextsByParticipantPage).mockResolvedValue({ contexts: [], next_cursor: null });
    communicationEmit.mockRejectedValueOnce(new ContextCommunicationPendingError("Retry this outcome"));
    render(<Harness />);
    const input = await screen.findByLabelText("Outcome") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Build once" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    const retry = await screen.findByRole("button", { name: "Retry start" });
    expect(input.disabled).toBe(true);
    expect(input.value).toBe("Build once");
    fireEvent.click(retry);
    await screen.findByTestId("conversation");
    expect(communicationCreate).toHaveBeenCalledTimes(1);
    expect(communicationEmit).toHaveBeenCalledTimes(2);
  });

  it("does not accept an outcome until the workspace model is ready", async () => {
    modelControl.ready = false;
    vi.mocked(client.listContextsByParticipantPage).mockResolvedValue({ contexts: [], next_cursor: null });
    render(<Harness />);

    const input = await screen.findByLabelText("Outcome") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Start" })).toHaveProperty("disabled", true);
    expect(screen.getByText("Choose a provider and model before starting a conversation.")).toBeTruthy();
    expect(communicationCreate).not.toHaveBeenCalled();
    expect(communicationEmit).not.toHaveBeenCalled();
  });
});
