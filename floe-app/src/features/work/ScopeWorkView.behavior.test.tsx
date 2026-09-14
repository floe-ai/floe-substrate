import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ScopeCompositionRevision, ScopeExecutionProjection, ScopeExecutionRecord, ScopeRef } from "../../bus-client/types.ts";
import * as client from "../../bus-client/client.ts";
import { ScopeWorkView } from "./ScopeWorkView.tsx";

vi.mock("../../bus-client/client.ts", () => ({
  getScopeExecutionProjection: vi.fn(),
  invokeOperation: vi.fn(),
  listContextsForScope: vi.fn(),
  listEvents: vi.fn(),
  listOperations: vi.fn(),
  listScopeCompositionRevisions: vi.fn(),
  listScopeExecutions: vi.fn(),
  subscribeEvents: vi.fn(() => () => {}),
}));

vi.mock("../../scope/ContextConversation.tsx", () => ({ ContextConversation: ({ contextId, operatorEntry }: { contextId: string; operatorEntry?: { operatorEndpointId: string } }) => <div data-testid="conversation">{contextId} · {operatorEntry?.operatorEndpointId}</div> }));
vi.mock("./ArtifactLineageView.tsx", () => ({
  ArtifactLineageView: () => <div />,
  findArtifactGraphPath: () => null,
  parseArtifactLineageGraph: () => null,
}));
vi.mock("./ScopePipelineFocusView.tsx", () => ({ ScopePipelineFocusView: ({ onOpenContext }: { onOpenContext: (id: string) => void }) => <div data-testid="canonical-plan"><button onClick={() => onOpenContext("selected-work-context")}>Open selected conversation</button></div> }));

const scope: ScopeRef = {
  scope_id: "scope-1", workspace_id: "workspace", title: "Delivery", description: null, status: "active",
  created_at: "2026-09-03T00:00:00Z", updated_at: "2026-09-03T00:00:00Z",
};

const revision = {
  revision_id: "revision-1", workspace_id: "workspace", scope_id: "scope-1", revision_number: 1,
  routing_mode: "edge", based_on_revision_id: null, semantic_digest: "digest", created_by_endpoint_id: null,
  created_at: "2026-09-03T00:00:00Z", published_at: "2026-09-03T00:00:00Z", withdrawn_at: null,
  nodes: [{ node_id: "start", kind: "event", label: "Start" }], ports: [], edges: [],
} satisfies ScopeCompositionRevision;

const execution = {
  execution_id: "execution-1", workspace_id: "workspace", scope_id: "scope-1", revision_id: "revision-1",
  cause_event_id: "message-1", root_event_id: "event-1", ingress_node_id: "start", ingress_port_id: "start-out",
  initiator_endpoint_id: "operator", idempotency_key: "start-1", parent_execution_id: null, redo_of_node_execution_id: null,
  state_revision: 4, status: "active", environment: {}, budget: {}, terminal: {}, created_at: "2026-09-03T00:00:00Z",
  started_at: "2026-09-03T00:00:00Z", completed_at: null, cancelled_at: null,
} satisfies ScopeExecutionRecord;

const projection = { execution, revision, node_executions: [], traversals: [] } satisfies ScopeExecutionProjection;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.listScopeCompositionRevisions).mockResolvedValue({ published_revision_id: revision.revision_id, revisions: [revision] });
  vi.mocked(client.listScopeExecutions).mockResolvedValue({ executions: [execution], next_cursor: null });
  vi.mocked(client.getScopeExecutionProjection).mockResolvedValue(projection);
  vi.mocked(client.listOperations).mockResolvedValue([{
    operation_id: "scope.execution.stop", operation_version: "1", category: "scope-execution", title: "Stop Scope execution", description: "Stop it",
    authority_boundary_kinds: ["workspace"],
    effects: { mode: "write", reversibility: "irreversible", external: true, secret_access: "none" }, required_grants: ["scope.execution.stop"],
    interaction_constraints: {}, target: { resource_kinds: ["scope_execution"], expected_revision: "required" },
    input: { version: "1", schema: {} }, result: { version: "1", schema: {} }, availability: { available: true },
  }]);
  vi.mocked(client.invokeOperation).mockResolvedValue({ state: "completed", refusal: null } as never);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ScopeWorkView mutations", () => {
  it("keeps the selected pipeline mounted through a pushed update and conversation inspection", async () => {
    render(<ScopeWorkView workspaceId="workspace" scope={scope} endpoints={[]} operatorEndpointId="operator" onBack={vi.fn()} />);
    const plan = await screen.findByTestId("canonical-plan");
    let completeRefresh!: (value: ScopeExecutionProjection) => void;
    vi.mocked(client.getScopeExecutionProjection).mockImplementationOnce(() => new Promise(resolve => { completeRefresh = resolve; }));
    const listener = vi.mocked(client.subscribeEvents).mock.calls.at(-1)![0];
    act(() => listener({ type: "scope_output_published", at: "2026-09-06T12:30:00Z", payload: {} }));
    await waitFor(() => expect(completeRefresh).toBeTypeOf("function"));
    expect(screen.getByTestId("canonical-plan")).toBe(plan);
    await act(async () => completeRefresh({ ...projection, execution: { ...execution, state_revision: 5 } }));
    expect(screen.getByTestId("canonical-plan")).toBe(plan);
    fireEvent.click(screen.getByRole("button", { name: "Open selected conversation" }));
    expect(screen.getByTestId("conversation").textContent).toBe("selected-work-context · operator");
    expect(screen.getByTestId("canonical-plan")).toBe(plan);
    fireEvent.click(screen.getByRole("button", { name: "Close conversation" }));
    expect(screen.queryByTestId("conversation")).toBeNull();
    expect(screen.getByTestId("canonical-plan")).toBe(plan);
  });

  it("shows a pushed setup blocker without reopening the work view", async () => {
    render(<ScopeWorkView workspaceId="workspace" scope={scope} endpoints={[]} operatorEndpointId="operator" onBack={vi.fn()} />);
    await screen.findByRole("button", { name: "Stop execution" });
    await waitFor(() => expect(client.getScopeExecutionProjection).toHaveBeenCalled());
    const blocked = { ...execution, status: "blocked" as const, state_revision: 5 };
    vi.mocked(client.listScopeExecutions).mockResolvedValue({ executions: [blocked], next_cursor: null });
    vi.mocked(client.getScopeExecutionProjection).mockResolvedValue({ ...projection, execution: blocked });
    const listener = vi.mocked(client.subscribeEvents).mock.calls.at(-1)![0];
    act(() => listener({ type: "delivery_deferred", at: "2026-09-05T12:30:00Z", payload: { delivery_id: "delivery-1" } }));
    expect(await screen.findByText("Blocked")).toBeTruthy();
  });

  it("stops the selected execution through the discovered operation", async () => {
    render(<ScopeWorkView workspaceId="workspace" scope={scope} endpoints={[]} operatorEndpointId="operator" onBack={vi.fn()} />);
    const stop = await screen.findByRole("button", { name: "Stop execution" });
    await waitFor(() => expect((stop as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(stop);

    await waitFor(() => expect(client.listOperations).toHaveBeenCalledWith("workspace", { kind: "scope_execution", id: "execution-1" }));
    expect(client.invokeOperation).toHaveBeenCalledWith("workspace", expect.objectContaining({
      operation_id: "scope.execution.stop",
      target: { kind: "scope_execution", id: "execution-1" },
      expected_resource_revision: "revision-1:4:active::",
    }));
  });

  it("shows when authenticated Workspace operations are unavailable", async () => {
    vi.mocked(client.listOperations).mockRejectedValueOnce(new Error("Credential recovery is required."));
    render(<ScopeWorkView workspaceId="workspace" scope={scope} endpoints={[]} operatorEndpointId="operator" onBack={vi.fn()} />);
    const stop = await screen.findByRole("button", { name: "Stop execution" });
    await waitFor(() => expect((stop as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(stop);
    expect(await screen.findByText("Credential recovery is required.")).toBeTruthy();
  });
});
