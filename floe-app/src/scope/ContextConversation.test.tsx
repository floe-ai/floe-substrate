/** Tests for the Context conversation operator-authority boundary. */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import {
  ContextConversation,
  conversationMessagePresentation,
  conversationDeliveryState,
  mergeOperatorProgress,
  operatorProgressFromTelemetry,
} from "./ContextConversation.tsx";
import * as client from "../bus-client/client.ts";
import { subscribeEvents } from "../bus-client/stream.ts";
import { ContextCommunicationPendingError } from "../features/conversations/contextCommunication.ts";

const modelControl = vi.hoisted(() => ({ ready: true }));
const communicationEmit = vi.hoisted(() => vi.fn());
const createSubmission = vi.hoisted(() => vi.fn());
const inspectOutput = vi.hoisted(() => vi.fn());
const stopResponse = vi.hoisted(() => vi.fn());
const createStop = vi.hoisted(() => vi.fn(() => stopResponse));
vi.mock("../features/conversations/stopResponse.ts", () => ({ createResponseStop: createStop }));

vi.mock("../features/work/CanonicalArtefactDetail.tsx", () => ({
  CanonicalArtefactDetail: (props: { workspaceId: string; artefactVersionId: string }) => {
    inspectOutput(props);
    return <div>Saved output preview</div>;
  },
}));

vi.mock("../bus-client/client.ts", () => ({
  getContext: vi.fn(),
  listContextEventHistoryPage: vi.fn(),
  listDeliveries: vi.fn(),
  listRuntimeTelemetry: vi.fn(),
}));

vi.mock("../features/conversations/contextCommunication.ts", () => ({
  createConversationSubmission: createSubmission,
  ContextCommunicationPendingError: class extends Error {},
}));

vi.mock("../bus-client/stream.ts", () => ({
  subscribeEvents: vi.fn(() => () => {}),
}));

vi.mock("../workspace/FloeModelControl.tsx", async () => {
  const ReactModule = await import("react");
  return {
    FloeModelControl: ({ onReadyChange }: { onReadyChange: (ready: boolean) => void }) => {
      ReactModule.useEffect(() => onReadyChange(modelControl.ready), [onReadyChange]);
      return <div data-testid="model-control">model</div>;
    },
  };
});

// contextLabel from ScopeDetail is a pure helper — mock ScopeDetail minimally
vi.mock("./ScopeDetail.tsx", () => ({
  contextLabel: (ctx: { title?: string | null; context_id: string }) =>
    ctx.title ?? ctx.context_id,
}));

const PARTICIPANT_EP = "ep-participant";
const NON_PARTICIPANT_EP = "ep-outsider";

const mockContext = {
  context_id: "ctx-1",
  workspace_id: "ws-1",
  scope_id: "scope-1",
  participants: [PARTICIPANT_EP],
  title: "Test Context",
  first_message_preview: null,
  created_at: "2026-01-01T00:00:00Z",
  last_event_at: null,
};

const endpoints = [
  { endpoint_id: PARTICIPANT_EP, workspace_id: "ws-1", name: "Alice", agent_id: null, bridge_id: null, status: "active", metadata_json: "{}", created_at: "", updated_at: "" },
  { endpoint_id: NON_PARTICIPANT_EP, workspace_id: "ws-1", name: "Bob", agent_id: null, bridge_id: null, status: "active", metadata_json: "{}", created_at: "", updated_at: "" },
];

function conversationEvent(
  eventId: string,
  sourceEndpointId: string,
  type: string,
  content: Record<string, unknown>,
) {
  return {
    event_id: eventId,
    type,
    workspace_id: "ws-1",
    source_endpoint_id: sourceEndpointId,
    thread_id: "thread-1",
    context_id: "ctx-1",
    scope_id: null,
    correlation_id: null,
    destination_json: { kind: "context", context_id: "ctx-1" },
    content,
    response: { expected: false },
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
  } as const;
}

beforeEach(() => {
  vi.clearAllMocks();
  modelControl.ready = true;
  vi.mocked(client.getContext).mockResolvedValue(mockContext as any);
  vi.mocked(client.listContextEventHistoryPage).mockResolvedValue({ events: [], previous_cursor: null });
  vi.mocked(client.listDeliveries).mockResolvedValue([]);
  vi.mocked(client.listRuntimeTelemetry).mockResolvedValue([]);
  communicationEmit.mockResolvedValue({});
  createSubmission.mockReturnValue(communicationEmit);

});

afterEach(() => cleanup());

describe("ContextConversation — operator authority", () => {
  it("shows a pushed approval correction and retains it on reload without exposing lifecycle records", async () => {
    const decision = { ...conversationEvent("decision-1", "", "approval.decision", {
      approval_request_id: "approval-1", decision: "changes_requested", reason: "Keep the original saved action.",
    }), artefact_version_ids: ["version-gallery"], source_endpoint_id: null, metadata: { semantic_operation_id: "approval.decide", source_principal_id: "principal:local-operator" } };
    const named = { ...conversationEvent("named-1", PARTICIPANT_EP, "message", { text: "Saved evidence", attachments: [
      { artefact_version_id: "version-gallery", name: "Reviewed gallery" },
      { artefact_version_id: "unattached-version", name: "Unattached name" },
    ] }), artefact_version_ids: ["version-gallery"] };
    const hidden = conversationEvent("lifecycle-1", "", "context.created", { text: "Internal lifecycle" });
    const view = render(<ContextConversation contextId="ctx-1" workspaceId="ws-1" endpoints={endpoints} operatorEntry={{ operatorEndpointId: "operator" }} />);
    await screen.findByRole("textbox", { name: "Compose message" });
    expect(client.listContextEventHistoryPage).toHaveBeenLastCalledWith("ctx-1", { limit: 50, workspace_id: "ws-1" });
    vi.mocked(client.listContextEventHistoryPage).mockResolvedValue({ events: [hidden, named, decision] as any, previous_cursor: null });
    vi.mocked(subscribeEvents).mock.calls.at(-1)![0]({ type: "event_submitted", payload: { event: { context_id: "ctx-1" } } } as any);
    expect(await screen.findByText("Changes requested")).toBeTruthy();
    expect(screen.getByText("Keep the original saved action.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review decision" })).toBeTruthy();
    const decisionArticle = screen.getByLabelText("Recorded approval decision").closest("article")!;
    fireEvent.click(within(decisionArticle).getByRole("button", { name: "Open Reviewed gallery" }));
    expect(inspectOutput).toHaveBeenLastCalledWith({ workspaceId: "ws-1", artefactVersionId: "version-gallery" });
    expect(within(decisionArticle).queryByText("Unattached name")).toBeNull();
    expect(screen.getByLabelText("Message from Operator")).toBeTruthy();
    expect(screen.queryByText("Internal lifecycle")).toBeNull();
    expect(communicationEmit).not.toHaveBeenCalled();
    view.unmount();
    render(<ContextConversation contextId="ctx-1" workspaceId="ws-1" endpoints={endpoints} />);
    expect(await screen.findByText("Changes requested")).toBeTruthy();
  });

  it("does not turn a claimed decision in an ordinary message into canonical decision controls", async () => {
    vi.mocked(client.listContextEventHistoryPage).mockResolvedValue({ events: [conversationEvent("claim-1", PARTICIPANT_EP, "message", {
      text: "Approval ready", approval_request_id: "made-up", decision: "approved", reason: "A claim only",
    })] as any, previous_cursor: null });
    render(<ContextConversation contextId="ctx-1" workspaceId="ws-1" endpoints={endpoints} />);
    expect(await screen.findByText("Approval ready")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review decision" })).toBeNull();
  });
  it("shows and stops requested work in another Context, including after reload and pushed completion", async () => {
    vi.mocked(client.getContext).mockResolvedValue({ ...mockContext, scope_id: null } as any);
    const child = { delivery_id: "del:child", endpoint_id: NON_PARTICIPANT_EP,
      state: "injected_to_runtime", created_at: "2026-01-01", events_json: JSON.stringify([{ context_id: "ctx-review" }]) };
    vi.mocked(client.listDeliveries).mockResolvedValue([child] as any);
    stopResponse.mockResolvedValue(undefined);
    render(<ContextConversation contextId="ctx-1" workspaceId="ws-1" endpoints={endpoints} operatorEntry={{ operatorEndpointId: "operator" }} />);
    expect(await screen.findByRole("button", { name: "Stop Bob response" })).toBeTruthy();
    expect(client.listDeliveries).toHaveBeenCalledWith({ workspace_id: "ws-1", context_id: "ctx-1", limit: 500 });
    // Completion of Floe's earlier response must not erase the reviewer's work.
    const push = vi.mocked(subscribeEvents).mock.calls.at(-1)![0];
    push({ type: "turn_end_observed", payload: { endpoint_id: PARTICIPANT_EP } } as any);
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop Bob response" })).toBeTruthy());
    vi.mocked(client.listDeliveries).mockResolvedValue([{ ...child, state: "cancelled" }] as any);
    fireEvent.click(screen.getByRole("button", { name: "Stop Bob response" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop Bob response" })).toBeNull());
    expect(createStop).toHaveBeenCalledWith("ws-1", "del:child");
    expect(screen.getByRole("alert").textContent).toContain("stopped");
  });
  it("offers Stop beside the active direct response and keeps an unconfirmed stop retryable", async () => {
    vi.mocked(client.getContext).mockResolvedValue({ ...mockContext, scope_id: null } as any);
    vi.mocked(client.listDeliveries).mockResolvedValue([{ delivery_id: "del:active", endpoint_id: PARTICIPANT_EP,
      state: "injected_to_runtime", created_at: "2026-01-01", events_json: JSON.stringify([{ context_id: "ctx-1" }]) }] as any);
    stopResponse.mockRejectedValueOnce(new Error("Stop is not confirmed"));
    render(<ContextConversation contextId="ctx-1" workspaceId="ws-1" endpoints={endpoints} operatorEntry={{ operatorEndpointId: NON_PARTICIPANT_EP }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop Alice response" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Stop is not confirmed");
    expect(createStop).toHaveBeenCalledWith("ws-1", "del:active");
    expect((screen.getByRole("button", { name: "Stop Alice response" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/is working/)).toBeTruthy();
  });
  it("presents canonical local-principal communication as the operator", () => {
    const event = {
      ...conversationEvent("event-operator", "", "message", { text: "Outcome" }),
      source_endpoint_id: null,
      metadata: {
        semantic_operation_id: "context.communication.emit",
        source_principal_id: "principal:local-operator",
      },
    } as any;

    expect(conversationMessagePresentation(event, endpoints, PARTICIPANT_EP)).toEqual({
      author: "Operator",
      alignedRight: true,
    });
  });

  it("names the current operator's saved output without requiring a runtime endpoint", () => {
    const actorId = "actor:workspace:operator";
    const event = {
      ...conversationEvent("event-output", actorId, "message", { text: "Reviewed" }),
      artefact_version_ids: [],
    };

    expect(conversationMessagePresentation(event, endpoints, actorId)).toEqual({
      author: "Operator",
      alignedRight: true,
    });
    expect(conversationMessagePresentation(event, [
      ...endpoints,
      { endpoint_id: actorId, name: "Alex" } as any,
    ], actorId)).toEqual({ author: "Alex", alignedRight: true });
    expect(conversationMessagePresentation(event, endpoints, "actor:another")).toEqual({
      author: actorId,
      alignedRight: false,
    });
  });

  it("keeps developer Context inspection read-only", async () => {
    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
      />,
    );

    expect(await screen.findByText(
      "Conversation history is read-only here. Open Conversations to reply as the authenticated operator.",
    )).toBeTruthy();
    expect(screen.queryByLabelText("Compose message")).toBeNull();
    expect(screen.queryByLabelText("Speaking as")).toBeNull();
    expect(screen.queryByRole("button", { name: "Join context" })).toBeNull();
  });

  it("allows the authenticated operator surface to compose without an identity selector", async () => {
    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
        operatorEntry={{ operatorEndpointId: PARTICIPANT_EP }}
      />,
    );

    const textarea = await screen.findByLabelText("Compose message");
    expect(textarea).toBeTruthy();
    expect(screen.queryByLabelText("Speaking as")).toBeNull();
  });

  it("presents the fixed operator conversation without substrate-oriented identity controls", async () => {
    const onNewConversation = vi.fn();
    const onArchiveConversation = vi.fn();
    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
        operatorEntry={{ operatorEndpointId: PARTICIPANT_EP, onNewConversation, onArchiveConversation }}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Floe" })).toBeTruthy();
    expect(screen.getByLabelText("Compose message")).toBeTruthy();
    expect(screen.queryByLabelText("Speaking as")).toBeNull();
    expect(screen.queryByText("Context")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(onNewConversation).toHaveBeenCalledOnce();
    expect(onArchiveConversation).toHaveBeenCalledOnce();
  });

  it("keeps an archived conversation readable and offers restore without a composer", async () => {
    const onRestoreConversation = vi.fn();
    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
        readOnly
        operatorEntry={{
          operatorEndpointId: PARTICIPANT_EP,
          conversationLifecycleState: "archived",
          onRestoreConversation,
        }}
      />,
    );

    expect(await screen.findByText("Archived conversations are retained but cannot receive new messages.")).toBeTruthy();
    expect(screen.queryByLabelText("Compose message")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(onRestoreConversation).toHaveBeenCalledOnce();
  });

  it("renders the Bus-owned warning before forwarding explicit confirmation to the native host", async () => {
    const onConfirmDestroyConversation = vi.fn();
    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
        readOnly
        operatorEntry={{
          operatorEndpointId: PARTICIPANT_EP,
          conversationLifecycleState: "archived",
          conversationActionConfirmation: {
            title: "Permanently destroy Context content",
            description: "This permanently removes the Context's content and cannot be undone.",
          },
          onConfirmDestroyConversation,
        }}
      />,
    );

    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("cannot be undone");
    fireEvent.click(screen.getByRole("button", { name: "Confirm permanent destruction" }));
    expect(onConfirmDestroyConversation).toHaveBeenCalledOnce();
  });

  it("presents another collaborator by name when opened from operator conversations", async () => {
    const onBackToConversations = vi.fn();
    vi.mocked(client.getContext).mockResolvedValue({
      ...mockContext,
      participants: [PARTICIPANT_EP, NON_PARTICIPANT_EP],
      title: "Decide the product audience",
    } as any);

    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
        operatorEntry={{
          operatorEndpointId: PARTICIPANT_EP,
          showContextIdentity: true,
          onBackToConversations,
        }}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Bob" })).toBeTruthy();
    expect(screen.getByText("Decide the product audience")).toBeTruthy();
    expect(screen.getByPlaceholderText("Message Bob…")).toBeTruthy();
    expect(screen.queryByLabelText("Speaking as")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Conversations/ }));
    expect(onBackToConversations).toHaveBeenCalledOnce();
  });

  it("marks an operator message as expecting a reply", async () => {
    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
        operatorEntry={{ operatorEndpointId: PARTICIPANT_EP }}
      />,
    );

    const input = await screen.findByLabelText("Compose message");
    fireEvent.change(input, { target: { value: "Help me reach this outcome" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(createSubmission).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ context: expect.objectContaining({ context_id: "ctx-1" }), text: "Help me reach this outcome" }),
    ));
  });

  it("keeps an uncertain draft intact and retries the same submission", async () => {
    communicationEmit.mockRejectedValueOnce(new ContextCommunicationPendingError("Retry the same message"));
    render(<ContextConversation contextId="ctx-1" workspaceId="ws-1" endpoints={endpoints}
      operatorEntry={{ operatorEndpointId: PARTICIPANT_EP }} />);
    const input = await screen.findByLabelText("Compose message") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "One message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    const retry = await screen.findByRole("button", { name: "Retry send" });
    expect(input.disabled).toBe(true);
    expect(input.value).toBe("One message");
    fireEvent.click(retry);
    await waitFor(() => expect(input.value).toBe(""));
    expect(createSubmission).toHaveBeenCalledTimes(1);
    expect(communicationEmit).toHaveBeenCalledTimes(2);
    expect(input.disabled).toBe(false);
  });

  it("disables the Floe front door until the workspace model is ready", async () => {
    modelControl.ready = false;
    vi.mocked(client.getContext).mockResolvedValue({ ...mockContext, scope_id: null } as any);
    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
        operatorEntry={{ operatorEndpointId: PARTICIPANT_EP }}
      />,
    );

    const input = await screen.findByLabelText("Compose message") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(screen.getByText("Choose a provider and model before talking to Floe.")).toBeTruthy();
    expect(communicationEmit).not.toHaveBeenCalled();
  });

  it("allows a work conversation to post without requiring a model connection", async () => {
    modelControl.ready = false;
    render(<ContextConversation contextId="ctx-1" workspaceId="ws-1" endpoints={endpoints}
      operatorEntry={{ operatorEndpointId: PARTICIPANT_EP, showContextIdentity: true }} />);
    const input = await screen.findByLabelText("Compose message") as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    expect(screen.queryByTestId("model-control")).toBeNull();
    expect(screen.getByRole("heading", { name: "Test Context" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "Review this branch" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(createSubmission).toHaveBeenCalledWith("ws-1", expect.objectContaining({
      context: expect.objectContaining({ context_id: "ctx-1" }), text: "Review this branch",
      recipientParticipantId: null, responseExpected: false,
    })));
  });

  it("renders Markdown and places the operator on the right and collaborators on the left", async () => {
    vi.mocked(client.getContext).mockResolvedValue({
      ...mockContext,
      participants: [PARTICIPANT_EP, NON_PARTICIPANT_EP],
    } as any);
    vi.mocked(client.listContextEventHistoryPage).mockResolvedValue({
      events: [
        conversationEvent("event-operator", PARTICIPANT_EP, "message", { text: "**Outcome** accepted" }),
        conversationEvent("event-collaborator", NON_PARTICIPANT_EP, "message", { text: "- First step\n- Second step" }),
      ] as any,
      previous_cursor: null,
    });

    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
        operatorEntry={{ operatorEndpointId: PARTICIPANT_EP }}
      />,
    );

    const operatorMessage = await screen.findByLabelText("Message from Alice");
    const collaboratorMessage = screen.getByLabelText("Message from Bob");
    expect(operatorMessage.getAttribute("data-message-side")).toBe("right");
    expect(collaboratorMessage.getAttribute("data-message-side")).toBe("left");
    expect(screen.getByText("Outcome").tagName).toBe("STRONG");
    expect(screen.getByText("First step").tagName).toBe("LI");
    expect(client.listContextEventHistoryPage).toHaveBeenCalledWith("ctx-1", {
      limit: 50,
      workspace_id: "ws-1",
    });
  });

  it("turns a Floe semantic report draft into a review action", async () => {
    const onReviewProblemReport = vi.fn();
    vi.mocked(client.listContextEventHistoryPage).mockResolvedValue({
      events: [conversationEvent("event-report", NON_PARTICIPANT_EP, "message", {
        text: "I prepared the problem report.",
        data: {
          problem_report: {
            schema: "floe.problem-report-draft.v1",
            expected: "The operation should stop",
            actual: "It continued running",
            impact: "Token use continued",
            tentative_classification: "possible-substrate-defect",
            interpretation: "A delivery may remain active",
            reproduction_safety: "isolated-workspace-first",
          },
        },
      }) as any],
      previous_cursor: null,
    });
    vi.mocked(client.getContext).mockResolvedValue({
      ...mockContext,
      participants: [PARTICIPANT_EP, NON_PARTICIPANT_EP],
    } as any);

    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
        operatorEntry={{ operatorEndpointId: PARTICIPANT_EP, onReviewProblemReport }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Report ready — Review" }));
    expect(onReviewProblemReport).toHaveBeenCalledWith(expect.objectContaining({
      expected: "The operation should stop",
      actual: "It continued running",
    }));
  });

  it("keeps durable messages visible when supplementary delivery status cannot load", async () => {
    vi.mocked(client.listContextEventHistoryPage).mockResolvedValue({
      events: [conversationEvent("event-safe", PARTICIPANT_EP, "message", { text: "The durable message remains visible." })] as any,
      previous_cursor: null,
    });
    vi.mocked(client.listDeliveries).mockRejectedValue(new Error("runtime diagnostics unavailable"));

    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
        operatorEntry={{ operatorEndpointId: PARTICIPANT_EP }}
      />,
    );

    expect(await screen.findByText("The durable message remains visible.")).toBeTruthy();
  });

  it("starts with the newest page and prepends earlier messages when scrolled upward", async () => {
    vi.mocked(client.listContextEventHistoryPage)
      .mockResolvedValueOnce({
        events: [{
          ...conversationEvent("event-new", NON_PARTICIPANT_EP, "message", { text: "Newest message" }),
          created_at: "2026-01-02T00:00:00Z",
        }] as any,
        previous_cursor: "cursor-before-newest",
      })
      .mockResolvedValueOnce({
        events: [{
          ...conversationEvent("event-old", PARTICIPANT_EP, "message", { text: "Earlier message" }),
          created_at: "2026-01-01T00:00:00Z",
        }] as any,
        previous_cursor: null,
      });

    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
        operatorEntry={{ operatorEndpointId: PARTICIPANT_EP }}
      />,
    );

    expect(await screen.findByText("Newest message")).toBeTruthy();
    expect(screen.queryByText("Earlier message")).toBeNull();

    const stream = screen.getByLabelText("Message stream");
    Object.defineProperties(stream, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, writable: true, value: 20 },
    });
    fireEvent.scroll(stream);

    expect(await screen.findByText("Earlier message")).toBeTruthy();
    expect(client.listContextEventHistoryPage).toHaveBeenNthCalledWith(2, "ctx-1", {
      before: "cursor-before-newest",
      limit: 50,
      workspace_id: "ws-1",
    });
    const visibleText = stream.textContent ?? "";
    expect(visibleText.indexOf("Earlier message")).toBeLessThan(visibleText.indexOf("Newest message"));
  });

  it("renders files deliberately attached to a conversation message", async () => {
    vi.mocked(client.listContextEventHistoryPage).mockResolvedValue({
      events: [conversationEvent("event-attachment", PARTICIPANT_EP, "message", {
          text: "This is what I see.",
          attachments: [{
            path: ".floe/state/attachments/ctx-1/screen.png",
            name: "screen.png",
            media_type: "image/png",
            bytes: 2048,
          }],
        })] as any,
      previous_cursor: null,
    });

    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
        operatorEntry={{ operatorEndpointId: PARTICIPANT_EP }}
      />,
    );

    expect(await screen.findByText("This is what I see.")).toBeTruthy();
    expect(screen.getByText("screen.png")).toBeTruthy();
    expect(screen.getByText("2 KB")).toBeTruthy();
  });

  it.each([true, false])("opens the canonical attached output (display metadata: %s)", async (hasDisplayMetadata) => {
    vi.mocked(client.listContextEventHistoryPage).mockResolvedValue({
      events: [{ ...conversationEvent("event-result", NON_PARTICIPANT_EP, "message", {
        text: "The brief is ready.",
        ...(hasDisplayMetadata ? { attachments: [{ artefact_version_id: "version:brief-original", name: "brief.md", media_type: "text/markdown", bytes: 128 }] } : {}),
      }), artefact_version_ids: ["version:brief-original"] }] as any,
      previous_cursor: null,
    });
    render(<ContextConversation contextId="ctx-1" workspaceId="ws-1" endpoints={endpoints} />);
    const label = hasDisplayMetadata ? "brief.md" : "Saved result";
    const open = await screen.findByRole("button", { name: `Open ${label}` });
    expect(inspectOutput).not.toHaveBeenCalled();
    fireEvent.click(open);
    expect(screen.getByText("Saved output preview")).toBeTruthy();
    expect(inspectOutput).toHaveBeenLastCalledWith({ workspaceId: "ws-1", artefactVersionId: "version:brief-original" });
    fireEvent.click(screen.getByRole("button", { name: `Close ${label}` }));
    expect(screen.queryByText("Saved output preview")).toBeNull();
  });

  it("shows public work events in a read-only inspector without exposing a composer", async () => {
    vi.mocked(client.listContextEventHistoryPage).mockResolvedValue({
      events: [conversationEvent("event-work", NON_PARTICIPANT_EP, "application.slice.dispatched", {
          summary: "Implement the first vertical slice",
        })] as any,
      previous_cursor: null,
    });

    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
        alignRightEndpointId={PARTICIPANT_EP}
        showWorkEvents
        readOnly
      />,
    );

    expect(await screen.findByText("Implement the first vertical slice")).toBeTruthy();
    expect(screen.getByText("application.slice.dispatched")).toBeTruthy();
    expect(screen.queryByLabelText("Compose message")).toBeNull();
    expect(screen.queryByLabelText("Not a participant")).toBeNull();
  });
});

describe("conversation delivery state", () => {
  const row = (state: string, error: string | null = null) => ({
    delivery_id: `delivery-${state}`,
    endpoint_id: "ep-floe",
    workspace_id: "ws-1",
    trigger_event_id: "event-1",
    events_json: JSON.stringify([{ context_id: "ctx-1" }]),
    state,
    lease_expires_at: null,
    attempt_count: 1,
    last_error: error,
    created_at: "2026-01-01T00:00:00Z",
    claimed_at: null,
  });

  it("restores a working indicator when the conversation mounts after delivery began", () => {
    const result = conversationDeliveryState([row("injected_to_runtime")]);
    expect(result.working.get("delivery-injected_to_runtime")).toBe("ep-floe");
    expect(result.notice).toBeNull();
  });

  it("turns a deferred authentication failure into an actionable operator notice", () => {
    const result = conversationDeliveryState([
      row("deferred", "provider_auth_missing: no credential"),
    ]);
    expect(result.notice).toMatch(/connected model/i);
  });

  it("keeps concurrent responses by one Actor independently stoppable", () => {
    const first = row("injected_to_runtime");
    const second = { ...first, delivery_id: "delivery-second" };
    expect(conversationDeliveryState([first, second]).working).toEqual(new Map([
      [first.delivery_id, "ep-floe"], [second.delivery_id, "ep-floe"],
    ]));
  });
});

describe("runtime interruption", () => {
  it("replaces stale working state with an explicit service failure", async () => {
    vi.mocked(client.listDeliveries).mockResolvedValue([{
      delivery_id: "delivery-active",
      endpoint_id: PARTICIPANT_EP,
      workspace_id: "ws-1",
      trigger_event_id: "event-1",
      events_json: JSON.stringify([{ context_id: "ctx-1" }]),
      state: "injected_to_runtime",
      lease_expires_at: null,
      attempt_count: 1,
      last_error: null,
      created_at: "2026-01-01T00:00:00Z",
      claimed_at: null,
    }] as any);

    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
        runtimeHealth={{
          state: "offline",
          label: "Floe needs attention",
          detail: "Local services stopped.",
        }}
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toMatch(/local services stopped while this work was active/i);
    await waitFor(() => expect(screen.queryByText("Alice is working")).toBeNull());
  });
});

describe("operator work progress", () => {
  const telemetry = (kind: string, payload: Record<string, unknown>, createdAt = "2026-01-01T00:00:00Z") => ({
    telemetry_id: `telemetry-${kind}-${createdAt}`,
    workspace_id: "ws-1",
    endpoint_id: "ep-floe",
    delivery_id: "delivery-1",
    kind,
    payload_json: JSON.stringify(payload),
    created_at: createdAt,
  });

  it("turns tool telemetry into concise progress without exposing command arguments", () => {
    const result = operatorProgressFromTelemetry(telemetry("BeforeToolUse", {
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "secret command text" },
    }));

    expect(result?.text).toBe("Running a workspace step");
    expect(JSON.stringify(result)).not.toContain("secret command text");
  });

  it("replaces a running action with its completion and keeps recent actions bounded", () => {
    const rows = [
      telemetry("BeforeToolUse", { toolCallId: "call-1", toolName: "write", args: { path: "pipeline.ts" } }),
      telemetry("AfterToolUse", { toolCallId: "call-1", toolName: "write", files_touched: ["pipeline.ts"] }, "2026-01-01T00:00:01Z"),
      ...Array.from({ length: 6 }, (_, index) => telemetry(
        "BeforeToolUse",
        { toolCallId: `call-${index + 2}`, toolName: "read" },
        `2026-01-01T00:00:0${index + 2}Z`,
      )),
    ];

    const result = mergeOperatorProgress([], rows);
    expect(result).toHaveLength(5);
    expect(result.some(progress => progress.toolCallId === "call-1")).toBe(false);
  });

  it("preserves failure status in earlier command evidence without claiming recovery", () => {
    const result = operatorProgressFromTelemetry(telemetry("AfterToolUse", {
      toolCallId: "call-1",
      toolName: "bash",
      summary: "bash: private details (timeout, 30000ms)",
    }));

    expect(result).toMatchObject({ text: "A step did not succeed", status: "failed" });
  });

  it("distinguishes command completion from verified work and structured refusal", () => {
    expect(operatorProgressFromTelemetry(telemetry("AfterToolUse", {
      toolCallId: "command", toolName: "run_command", isError: false,
    }))).toMatchObject({ text: "Completed a workspace step", status: "completed" });
    expect(operatorProgressFromTelemetry(telemetry("ToolUseFailed", {
      toolCallId: "refused", toolName: "use_capability", isError: true,
    }))).toMatchObject({ text: "A step did not succeed", status: "failed" });
  });
});
