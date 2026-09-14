import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConversationReferences, conversationReferences } from "./ConversationReferences.tsx";
const inspect = vi.hoisted(() => vi.fn());
vi.mock("../actions/ActionPanel.tsx", () => ({ ActionPanel: (props: unknown) => { inspect(props); return <div>Current permitted actions</div>; } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const ref = { kind: "approval_request", id: "approval-exact", revision: "2" };
describe("named conversation references", () => {
  it("carries the exact reference and current Workspace to ordinary action discovery only after opening", () => {
    render(<ConversationReferences workspaceId="current-workspace" content={{ text: "Ready", references: [{ name: "Local preview approval", resource_ref: ref }] }} />);
    expect(inspect).not.toHaveBeenCalled();
    expect(screen.queryByText("Approved")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Local preview approval" }));
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "current-workspace", initialTarget: { ref, label: "Local preview approval" } }));
  });
  it("does not infer resources from prose, IDs, URLs or cross-Workspace claims", () => {
    expect(conversationReferences({ text: "approval-exact", approval_request_id: "approval-exact" })).toEqual([]);
    expect(conversationReferences({ references: [
      { name: "URL", url: "javascript:alert(1)" },
      { name: "Missing revision", resource_ref: { kind: "approval_request", id: "approval-exact" } },
      { name: "Wrong boundary", resource_ref: { ...ref, workspace_id: "other" } },
      { name: "Blank", resource_ref: { ...ref, id: " " } },
      { name: "Preview approval", resource_ref: ref },
      { name: "Duplicate", resource_ref: ref },
    ] })).toEqual([{ name: "Preview approval", resource_ref: ref }]);
  });
  it("supports unfamiliar resource kinds through the same reference contract", () => {
    const extensionRef = { kind: "extension.example.record", id: "opaque", revision: null };
    render(<ConversationReferences workspaceId="ws" content={{ references: [{ name: "Example", resource_ref: extensionRef }] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Example" }));
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ initialTarget: { ref: extensionRef, label: "Example" } }));
  });
  it("does not duplicate an Open label supplied in the saved handoff", () => {
    render(<ConversationReferences workspaceId="ws" content={{ references: [{ name: "Open local preview approval & decision", resource_ref: ref }] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open local preview approval & decision" }));
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({initialReadOperationId:"approval.inspect"}));
  });
});
