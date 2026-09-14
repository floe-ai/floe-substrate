import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextDiagnosticEvidence } from "../../bus-client/types.ts";
import { ProblemReportDialog } from "./ProblemReportDialog.tsx";

const mocks = vi.hoisted(() => ({
  getEvidence: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("../../bus-client/client.ts", () => ({
  getContextDiagnosticEvidence: mocks.getEvidence,
}));

vi.mock("../../fs/workspaceFs.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../fs/workspaceFs.ts")>()),
  readWorkspaceFile: mocks.readFile,
  writeWorkspaceFile: mocks.writeFile,
}));

const evidence: ContextDiagnosticEvidence = {
  schema: "floe.context-diagnostic.v1",
  generated_at: "2026-09-01T04:00:00.000Z",
  source: { component: "floe-bus", release_version: "0.1.29", build_sha: "abc123" },
  workspace: { workspace_id: "workspace:test" },
  context: {
    context_id: "ctx:test",
    workspace_id: "workspace:test",
    scope_id: null,
    parent_context_id: null,
    created_by_endpoint_id: "actor:operator",
    created_at: "2026-09-01T03:00:00.000Z",
    title: null,
    participants: ["actor:operator", "actor:floe"],
    endpoints: [
      { endpoint_id: "actor:operator", name: "Operator", agent_id: "operator", bridge_id: null, status: "idle" },
      { endpoint_id: "actor:floe", name: "Floe", agent_id: "floe", bridge_id: "bridge:main", status: "idle" },
    ],
  },
  events: [{
    event_id: "event:floe",
    type: "message",
    workspace_id: "workspace:test",
    source_endpoint_id: "actor:floe",
    thread_id: "ctx:test",
    context_id: "ctx:test",
    scope_id: null,
    correlation_id: null,
    destination_json: { kind: "endpoint", endpoint_id: "actor:operator" },
    content: { text: "The runtime at C:\\Users\\alice stopped with sk-abcdefghijklmnopqrstuvwxyz" },
    response: { expected: false },
    metadata: {},
    artefact_version_ids: [],
    created_at: "2026-09-01T03:01:00.000Z",
  }],
  deliveries: [],
  telemetry: [],
  runtime: { bridge: { online: false, runtime_adapter: "pi" } },
  operations: [],
  limits: {
    events: 30,
    deliveries: 30,
    telemetry: 100,
    events_truncated: false,
    deliveries_truncated: false,
    telemetry_truncated: false,
  },
};

describe("ProblemReportDialog", () => {
  beforeEach(() => {
    mocks.getEvidence.mockReset().mockResolvedValue(evidence);
    mocks.writeFile.mockReset().mockResolvedValue(undefined);
    mocks.readFile.mockReset().mockRejectedValue(new Error("no report index yet"));
  });

  it("requires semantic context, previews exact redacted formats, and saves only after approval", async () => {
    render(
      <ProblemReportDialog
        workspace={{ workspace_id: "workspace:test", locator: "C:\\Development\\workspace" }}
        contextId="ctx:test"
        operatorEndpointId="actor:operator"
        runtimeHealth={{ state: "offline", label: "Needs attention", detail: "Runtime stopped" }}
        onClose={vi.fn()}
      />,
    );

    const expected = await screen.findByLabelText("What did you expect?");
    const actual = screen.getByLabelText("What happened instead?");
    expect((screen.getByRole("button", { name: "Review exact report" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(expected, { target: { value: "Floe should finish the message" } });
    fireEvent.change(actual, { target: { value: "Floe stayed working forever" } });
    expect((screen.getByRole("button", { name: "Review exact report" }) as HTMLButtonElement).disabled).toBe(false);
    expect(mocks.writeFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Review exact report" }));
    const markdown = screen.getByLabelText("markdown report preview");
    expect(markdown.textContent).toContain("Floe should finish the message");
    expect(markdown.textContent).toContain("saved locally; not transmitted");
    expect(markdown.textContent).toContain("<user-home>");
    expect(markdown.textContent).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");

    fireEvent.click(screen.getByRole("button", { name: "json" }));
    const json = screen.getByLabelText("json report preview");
    expect(json.textContent).toContain('"schema": "floe.problem-report.v1"');
    expect(json.textContent).not.toContain("C:\\Users\\alice");

    fireEvent.click(screen.getByRole("button", { name: "Save report locally" }));
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(3));
    expect(mocks.writeFile.mock.calls.map((call) => call[1])).toEqual(expect.arrayContaining([
      expect.stringMatching(/^\.floe\/state\/feedback\/.+\/report\.md$/),
      expect.stringMatching(/^\.floe\/state\/feedback\/.+\/report\.json$/),
    ]));
    expect(await screen.findByText("Ready for developer handoff")).not.toBeNull();
  });

  it("starts from a Floe-authored semantic draft", async () => {
    render(
      <ProblemReportDialog
        workspace={{ workspace_id: "workspace:test", locator: "C:\\Development\\workspace" }}
        contextId="ctx:test"
        operatorEndpointId="actor:operator"
        runtimeHealth={{ state: "healthy", label: "Ready", detail: "Ready" }}
        initialDraft={{ expected: "Expected from Floe", actual: "Actual from Floe" }}
        onClose={vi.fn()}
      />,
    );
    expect((await screen.findByLabelText("What did you expect?") as HTMLTextAreaElement).value).toBe("Expected from Floe");
    expect((screen.getByLabelText("What happened instead?") as HTMLTextAreaElement).value).toBe("Actual from Floe");
  });
});
