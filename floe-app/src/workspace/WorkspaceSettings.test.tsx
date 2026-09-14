import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { WorkspaceSettings } from "./WorkspaceSettings.tsx";
import type { EndpointRef } from "../bus-client/types.ts";

vi.mock("./FloeModelControl.tsx", () => ({
  FloeModelControl: ({ workspaceId, endpointId }: { workspaceId: string; endpointId: string }) => (
    <div data-testid="floe-model-control">{workspaceId}:{endpointId}</div>
  ),
}));

const mockWorkspace = {
  workspace_id: "ws-1",
  name: "My Workspace",
  locator: "/path/to/ws",
  status: "active" as const,
  selected_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const floeEndpoint: EndpointRef = {
  endpoint_id: "actor:floe",
  workspace_id: "ws-1",
  name: "Floe",
  agent_id: "floe",
  bridge_id: "bridge:main",
  status: "active",
  metadata_json: "{}",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("WorkspaceSettings", () => {
  afterEach(cleanup);

  it("renders the shared Actor model control targeting the workspace's declared floe Actor", () => {
    render(<WorkspaceSettings workspace={mockWorkspace} endpoints={[floeEndpoint]} onRemove={vi.fn()} />);
    expect(screen.getByTestId("floe-model-control").textContent).toBe("ws-1:actor:floe");
  });

  it("shows a fallback message when the workspace has no declared floe Actor yet", () => {
    render(<WorkspaceSettings workspace={mockWorkspace} endpoints={[]} onRemove={vi.fn()} />);
    expect(screen.queryByTestId("floe-model-control")).toBeNull();
    expect(screen.getByText(/has not finished setting up/i)).toBeDefined();
  });

  it("confirms in-app before calling onRemove(false) for 'Remove from Floe'", async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined);
    render(<WorkspaceSettings workspace={mockWorkspace} endpoints={[floeEndpoint]} onRemove={onRemove} />);
    fireEvent.click(screen.getByText("Remove from Floe"));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Remove workspace"));
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith(false));
  });

  it("confirms in-app before calling onRemove(true) for 'Delete workspace and files'", async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined);
    render(<WorkspaceSettings workspace={mockWorkspace} endpoints={[floeEndpoint]} onRemove={onRemove} />);
    fireEvent.click(screen.getByText("Delete workspace and files"));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Delete permanently"));
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith(true));
  });

  it("cancels the pending removal without calling onRemove", () => {
    const onRemove = vi.fn();
    render(<WorkspaceSettings workspace={mockWorkspace} endpoints={[floeEndpoint]} onRemove={onRemove} />);
    fireEvent.click(screen.getByText("Delete workspace and files"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Delete permanently")).toBeNull();
    expect(onRemove).not.toHaveBeenCalled();
  });
});
