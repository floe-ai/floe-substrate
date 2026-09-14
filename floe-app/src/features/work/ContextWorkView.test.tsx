import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ContextRef, ScopeExecutionRecord, ScopeRef } from "../../bus-client/types.ts";
import * as client from "../../bus-client/client.ts";
import { ContextWorkView } from "./ContextWorkView.tsx";

vi.mock("../../bus-client/client.ts", () => ({
  listContextScopeExecutions: vi.fn(),
  listContextTree: vi.fn(),
  subscribeEvents: vi.fn(() => () => {}),
}));

vi.mock("./ScopeWorkView.tsx", () => ({
  ScopeWorkView: ({ initialExecutionId, allowedExecutionIds }: { initialExecutionId: string; allowedExecutionIds: string[] }) => <div data-testid="scope-work">{initialExecutionId}:{allowedExecutionIds.join(",")}</div>,
}));

vi.mock("../../scope/ContextConversation.tsx", () => ({
  ContextConversation: ({ contextId }: { contextId: string }) => <div data-testid="context-diagnostic">{contextId}</div>,
}));

const scope: ScopeRef = {
  scope_id: "scope-1", workspace_id: "workspace", title: "Product delivery", description: null, status: "active",
  created_at: "2026-09-03T00:00:00Z", updated_at: "2026-09-03T00:00:00Z",
};

function execution(id: string, causeEventId: string): ScopeExecutionRecord {
  return {
    execution_id: id, workspace_id: "workspace", scope_id: "scope-1", revision_id: "revision-1",
    cause_event_id: causeEventId, root_event_id: "root-event", ingress_node_id: "start", ingress_port_id: "start-out",
    initiator_endpoint_id: "operator", idempotency_key: id, parent_execution_id: null, redo_of_node_execution_id: null,
    state_revision: 1, status: "active", environment: {}, budget: {}, terminal: {}, created_at: "2026-09-03T00:00:00Z",
    started_at: "2026-09-03T00:00:00Z", completed_at: null, cancelled_at: null,
  };
}

const rootContext: ContextRef = {
  context_id: "context-root", workspace_id: "workspace", scope_id: null, parent_context_id: null,
  created_by_endpoint_id: "operator", created_at: "2026-09-03T00:00:00Z", last_event_at: null,
  participants: ["operator", "floe"], title: "Plan a product", first_message_preview: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.listContextScopeExecutions).mockResolvedValue([]);
  vi.mocked(client.listContextTree).mockResolvedValue({ contexts: [rootContext], truncated: false });
});

afterEach(cleanup);

function view() {
  return <ContextWorkView workspaceId="workspace" rootContextId="context-root" scopes={[scope]} endpoints={[]} operatorEndpointId="operator" onBackToConversation={vi.fn()} />;
}

describe("conversation to organised work", () => {
  it("updates the run status when an output publication finishes its work", async () => {
    const earlier = { ...execution("earlier", "earlier-message"), status: "completed" as const };
    vi.mocked(client.listContextScopeExecutions).mockResolvedValue([
      { ...execution("review", "message"), status: "waiting_external" }, earlier,
    ]);
    render(view());
    await screen.findByRole("button", { name: /Waiting for a response/ });
    vi.mocked(client.listContextScopeExecutions).mockResolvedValue([
      { ...execution("review", "message"), status: "completed" }, earlier,
    ]);
    await act(async () => { vi.mocked(client.subscribeEvents).mock.calls[0]![0]({ type: "scope_output_published", payload: {}, at: "2026-09-03T00:04:00Z" }); });
    await waitFor(() => expect(screen.queryByRole("button", { name: /Waiting for a response/ })).toBeNull());
    expect(screen.getAllByRole("button", { name: /Product delivery Complete/ })).toHaveLength(2);
  });

  it("distinguishes recorded runs with readable status and date", async () => {
    vi.mocked(client.listContextScopeExecutions).mockResolvedValue([
      { ...execution("waiting-run", "message-event"), status: "waiting_external" },
      { ...execution("completed-run", "earlier-message"), status: "completed" },
    ]);
    render(view());
    const waiting = await screen.findByRole("button", { name: /Product delivery Waiting for a response/ });
    expect(waiting.textContent).toContain(new Date("2026-09-03T00:00:00Z").toLocaleString());
    expect(screen.getByRole("button", { name: /Product delivery Complete/ })).toBeTruthy();
    expect(screen.queryByText(/revision-1|waiting_external/)).toBeNull();
    fireEvent.click(waiting);
    expect((await screen.findByTestId("scope-work")).textContent).toBe("waiting-run:waiting-run,completed-run");
  });

  it("does not infer organised work from Context membership or parentage", async () => {
    render(view());
    expect(await screen.findByText(/No organised work is linked/)).toBeTruthy();
    expect(client.listContextScopeExecutions).toHaveBeenCalledWith("workspace", "context-root");
    expect(client.listContextTree).not.toHaveBeenCalled();
  });

  it("opens the Scope execution explicitly linked through cause_event_id", async () => {
    vi.mocked(client.listContextScopeExecutions).mockResolvedValue([execution("execution-1", "message-event")]);
    render(view());
    expect((await screen.findByTestId("scope-work")).textContent).toBe("execution-1:execution-1");
  });

  it("keeps Context parentage behind a diagnostic label", async () => {
    render(view());
    await screen.findByText(/No organised work is linked/);
    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    expect(await screen.findByText(/not the pipeline plan or an execution route/)).toBeTruthy();
    await waitFor(() => expect(client.listContextTree).toHaveBeenCalledWith("context-root", 200, "workspace"));
  });
});
