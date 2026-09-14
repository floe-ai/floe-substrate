import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ApprovalResult } from "./ApprovalResult.tsx";

vi.mock("../work/CanonicalArtefactDetail.tsx", () => ({ CanonicalArtefactDetail: () => <div>Saved evidence</div> }));
afterEach(cleanup);

describe("recorded approval feedback", () => {
  const request = { approval_request_id: "approval-1", status: "rejected", decision: "changes_requested",
    decision_reason: "Keep the exact action and attach the reports in the conversation.",
    reason: "Review the saved result.", action: { expected_effect: { summary: "Save the reviewed gallery locally." }, artefact_version_ids: [] },
    resource_ref: { kind: "approval_request", id: "approval-1", revision: "2" } };

  it("shows the recorded choice and correction instead of only the aggregate rejection", () => {
    render(<ApprovalResult workspaceId="ws" result={{ request }} schema={{}} onSelectResource={vi.fn()} />);
    expect(screen.getByText("Changes requested")).toBeTruthy();
    expect(screen.getAllByText(request.decision_reason).find(element => !element.closest("details"))).toBeTruthy();
    expect(screen.queryByText("Rejected")).toBeNull();
  });

  it("does not present an invalidated request as still approved", () => {
    render(<ApprovalResult workspaceId="ws" result={{ request: { ...request, status: "invalidated", decision: "approved" } }} schema={{}} onSelectResource={vi.fn()} />);
    expect(screen.getByText("Invalidated")).toBeTruthy();
    expect(screen.queryByText("Approved")).toBeNull();
  });
});
