import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  EndpointRef,
  NodeExecutionRecord,
  ScopeCompositionRevision,
  ScopeExecutionProjection,
} from "../../bus-client/types.ts";

vi.mock("../../bus-client/client.ts", () => ({
  listOperations: vi.fn().mockResolvedValue([]),
  invokeOperation: vi.fn(),
}));

vi.mock("../../bus-client/transport.ts", () => ({
  readArtefactVersionContent: vi.fn(),
}));

vi.mock("./CanonicalArtefactDetail.tsx", () => ({
  inspectCanonicalArtefactVersion: vi.fn(async (_workspace: string, id: string) => ({
    artefact: { type_ref: "image/png" }, heads: [], versions: [], history_complete: false,
    selected: { version: { artefact_version_id: id, ordinal: 1, content_ref: { kind: "workspace-relative", path: id + ".png", media_type: "image/png" } } },
  })),
  CanonicalArtefactDetail: ({ artefactVersionId }: { artefactVersionId: string }) => <div>Exact output: {artefactVersionId}</div>,
}));
import * as transport from "../../bus-client/transport.ts";
import { inspectCanonicalArtefactVersion } from "./CanonicalArtefactDetail.tsx";
import { buildCanonicalScopePipelineProjection, outputReachesExecution, ScopePipelineFocusView } from "./ScopePipelineFocusView.tsx";

const revision: ScopeCompositionRevision = {
  revision_id: "revision-2",
  workspace_id: "workspace",
  scope_id: "scope-pipeline",
  revision_number: 2,
  routing_mode: "edge",
  based_on_revision_id: "revision-1",
  semantic_digest: "digest-2",
  created_by_endpoint_id: "actor:architect",
  created_at: "2026-09-03T00:00:00Z",
  published_at: "2026-09-03T00:01:00Z",
  withdrawn_at: null,
  nodes: [
    { node_id: "found", kind: "event", label: "Concept found", config: {}, activation: {}, context_policy: {} },
    { node_id: "registry", kind: "actor", label: "Build registry", resource_id: "actor:registry", config: {}, activation: {}, context_policy: {} },
    { node_id: "props", kind: "actor", label: "Generate prop", resource_id: "actor:props", config: {}, activation: { mode: "keyed_each" }, context_policy: { mode: "create" } },
    { node_id: "unused", kind: "actor", label: "Not connected", resource_id: "actor:unused", config: {}, activation: {}, context_policy: {} },
  ],
  ports: [
    { port_id: "found-out", node_id: "found", name: "image", direction: "output", event_types: ["concept.found"], artefact_types: ["image"] },
    { port_id: "registry-in", node_id: "registry", name: "concept", direction: "input", event_types: ["concept.found"], artefact_types: ["image"] },
    { port_id: "registry-out", node_id: "registry", name: "registry", direction: "output", event_types: ["registry.ready"], artefact_types: ["registry"] },
    { port_id: "props-in", node_id: "props", name: "item", direction: "input", event_types: ["registry.ready"], artefact_types: ["registry"] },
    { port_id: "unused-in", node_id: "unused", name: "anything", direction: "input", event_types: ["concept.found"] },
  ],
  edges: [
    { edge_id: "to-registry", source_port_id: "found-out", target_port_id: "registry-in", enabled: true, priority: 0, policy: {} },
    { edge_id: "to-props", source_port_id: "registry-out", target_port_id: "props-in", enabled: true, priority: 0, policy: {} },
    { edge_id: "disabled", source_port_id: "found-out", target_port_id: "unused-in", enabled: false, priority: 0, policy: {} },
  ],
};

function nodeExecution(input: Partial<NodeExecutionRecord> & Pick<NodeExecutionRecord, "node_execution_id" | "node_id" | "context_id">): NodeExecutionRecord {
  return {
    node_execution_id: input.node_execution_id,
    state_revision: input.state_revision ?? 1,
    execution_id: "execution-1",
    revision_id: "revision-2",
    node_id: input.node_id,
    activation_key: input.activation_key ?? input.node_execution_id,
    context_id: input.context_id,
    status: input.status ?? "completed",
    assigned_actor_ids: input.assigned_actor_ids ?? [],
    missing_port_ids: input.missing_port_ids ?? [],
    failure: input.failure ?? {},
    created_at: input.created_at ?? "2026-09-03T00:02:00Z",
    activated_at: input.activated_at ?? "2026-09-03T00:02:00Z",
    completed_at: input.completed_at ?? "2026-09-03T00:03:00Z",
    cancelled_at: input.cancelled_at ?? null,
    inputs: input.inputs ?? [],
    attempts: input.attempts ?? [],
    publications: input.publications ?? [],
  };
}

const registryExecution = nodeExecution({
  node_execution_id: "node-registry",
  node_id: "registry",
  context_id: "context-registry",
  inputs: [{ input_id: "input-1", node_execution_id: "node-registry", port_id: "registry-in", delivery_id: "delivery-1", event_id: "event-concept", artefact_version_id: "artefact-version-concept", member_key: "", accepted_at: "2026-09-03T00:02:00Z" }],
  attempts: [{ attempt_id: "attempt-1", node_execution_id: "node-registry", ordinal: 1, delivery_ids: ["delivery-1"], delivery_id: "delivery-1", delivery_bundle_id: "bundle-1", status: "completed", runtime: {}, resource_use: {}, result: {}, error: {}, created_at: "2026-09-03T00:02:00Z", started_at: "2026-09-03T00:02:00Z", completed_at: "2026-09-03T00:03:00Z" }],
  publications: [{ publication_id: "publication-registry", node_execution_id: "node-registry", port_id: "registry-out", event_id: "event-registry", idempotency_key: "publish-1", published_by_endpoint_id: "actor:registry", created_at: "2026-09-03T00:03:00Z", artefact_version_ids: ["artefact-version-registry"] }],
});

const propOne = nodeExecution({ node_execution_id: "node-prop-one", node_id: "props", context_id: "context-prop-one", status: "active", completed_at: null });
const propTwo = nodeExecution({ node_execution_id: "node-prop-two", node_id: "props", context_id: "context-prop-two", status: "waiting_external", completed_at: null });

const executionProjection: ScopeExecutionProjection = {
  execution: {
    execution_id: "execution-1", workspace_id: "workspace", scope_id: "scope-pipeline", revision_id: "revision-2",
    cause_event_id: "operator-message", root_event_id: "event-concept", ingress_node_id: "found", ingress_port_id: "found-out",
    initiator_endpoint_id: "actor:operator", idempotency_key: "start-1", parent_execution_id: null, redo_of_node_execution_id: null,
    state_revision: 1, status: "active", environment: {}, budget: {}, terminal: {}, created_at: "2026-09-03T00:01:00Z", started_at: "2026-09-03T00:01:00Z", completed_at: null, cancelled_at: null,
  },
  revision,
  current_published_revision_id: "revision-2",
  node_executions: [nodeExecution({ node_execution_id: "node-found", node_id: "found", context_id: "context-found", publications: [{ publication_id: "publication-found", node_execution_id: "node-found", port_id: "found-out", event_id: "event-concept", idempotency_key: "found", published_by_endpoint_id: null, created_at: "2026-09-03T00:01:00Z", artefact_version_ids: ["artefact-version-concept"] }] }), registryExecution, propOne, propTwo],
  traversals: [
    { publication_id: "publication-found", edge_id: "to-registry", delivery_id: "delivery-1", target_node_execution_id: "node-registry" },
    { traversal_id: "traversal-1", publication_id: "publication-registry", edge_id: "to-props", delivery_id: "delivery-prop-one", target_node_execution_id: "node-prop-one", created_at: "2026-09-03T00:03:01Z" },
    { traversal_id: "traversal-2", publication_id: "publication-registry", edge_id: "to-props", delivery_id: "delivery-prop-two", target_node_execution_id: "node-prop-two", created_at: "2026-09-03T00:03:02Z" },
  ],
};

const endpoints: EndpointRef[] = [];

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  URL.createObjectURL = vi.fn(() => "blob:exact-image");
  URL.revokeObjectURL = vi.fn();
  vi.mocked(transport.readArtefactVersionContent).mockResolvedValue({ mediaType: "image/png", data: new Blob(["image"]), etag: "exact", artefactVersionId: "version" });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("canonical Scope pipeline projection", () => {
  it("keeps different saved evidence distinguishable on one output port", async () => {
    const saved = [
      { id: "gallery", type: "campaign.site", media: "text/html; charset=utf-8", label: "Campaign site" },
      { id: "tests", type: "campaign.test-evidence", media: "application/json", label: "Campaign test evidence" },
      { id: "build", type: "campaign.build-evidence", media: "application/json", label: "Campaign build evidence" },
    ];
    const inspect = vi.mocked(inspectCanonicalArtefactVersion);
    const original = inspect.getMockImplementation()!;
    inspect.mockImplementation(async (...args) => {
      const item = saved.find(item => item.id === args[1]);
      const result = await original(...args);
      return item ? { ...result, artefact: { ...result.artefact, type_ref: item.type }, selected: {
        ...result.selected!, version: { ...result.selected!.version, content_ref: {
          kind: "workspace-relative", path: `.floe/content/sha256/${"a".repeat(64)}`, media_type: item.media,
          digest: { algorithm: "sha256", value: "a".repeat(64) },
        } },
      } } : result;
    });
    try {
      const ingress = executionProjection.node_executions[0]!;
      render(<ScopePipelineFocusView workspaceId="workspace" revision={revision} executionProjection={{
        ...executionProjection, node_executions: [{ ...ingress, publications: [{
          ...ingress.publications[0]!, artefact_version_ids: saved.map(item => item.id),
        }] }],
      }} endpoints={endpoints} />);
      const focus = screen.getByRole("region", { name: "Focused pipeline step" });
      for (const item of saved) {
        fireEvent.click(await within(focus).findByRole("button", { name: `Open ${item.label} · version 1` }));
        fireEvent.click(within(focus).getAllByRole("button", { name: `Open ${item.label} · version 1` }).find(button => !button.hasAttribute("aria-pressed"))!);
        expect(await screen.findByText(`Exact output: ${item.id}`)).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Close output" }));
      }
    } finally { inspect.mockImplementation(original); }
  });

  it("uses only stored enabled Edges and canonical NodeExecutions", () => {
    const projection = buildCanonicalScopePipelineProjection(revision, executionProjection);
    expect(projection.routes.map((route) => route.edge.edge_id)).toEqual(["to-registry", "to-props"]);
    expect(projection.nodes.find((item) => item.node.node_id === "registry")?.executions).toEqual([registryExecution]);
    expect(projection.nodes.find((item) => item.node.node_id === "unused")?.executions).toEqual([]);
  });

  it("refuses to combine an execution with a different plan revision", () => {
    expect(() => buildCanonicalScopePipelineProjection(revision, {
      ...executionProjection,
      execution: { ...executionProjection.execution, revision_id: "revision-other" },
    })).toThrow("does not belong to the displayed plan revision");
  });

  it("reveals exact branching and opens the selected work conversation", async () => {
    const openContext = vi.fn();
    render(<ScopePipelineFocusView workspaceId="workspace" revision={revision} executionProjection={executionProjection} endpoints={endpoints} onOpenContext={openContext} />);
    fireEvent.click(screen.getByRole("button", { name: /Follow Build registry/ }));
    const focus = screen.getByRole("region", { name: "Focused pipeline step" });
    expect(await within(focus).findByRole("button", { name: "Open artefact-version-concept.png" })).toBeTruthy();
    expect(await within(focus).findByRole("button", { name: "Open artefact-version-registry.png" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Next pipeline layer" }).querySelectorAll("button[data-node-kind='actor']")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    expect(openContext).toHaveBeenCalledWith("context-registry");
  });

  it("returns to a previous step without growing a repeated breadcrumb", () => {
    render(<ScopePipelineFocusView workspaceId="workspace" revision={revision} executionProjection={executionProjection} endpoints={endpoints} />);
    fireEvent.click(screen.getByRole("button", { name: /Follow Build registry/ }));
    fireEvent.click(within(screen.getByRole("region", { name: "Previous pipeline layer" })).getByRole("button"));
    expect(within(screen.getByRole("navigation", { name: "Current pipeline path" })).getAllByRole("button")).toHaveLength(1);
  });

  it("does not label an untraversed branch as executed", () => {
    render(<ScopePipelineFocusView workspaceId="workspace" revision={revision} executionProjection={{ ...executionProjection, traversals: [] }} endpoints={endpoints} />);
    fireEvent.click(screen.getByRole("button", { name: /Follow Build registry/ }));
    expect(screen.queryByRole("button", { name: "Open conversation" })).toBeNull();
    expect(screen.getByRole("region", { name: "Focused pipeline step" }).textContent).toContain("Outputs appear here when this step runs.");
  });

  it("filters output branches by recorded Delivery and exact input version", () => {
    const route = buildCanonicalScopePipelineProjection(revision, executionProjection).routes.find(route => route.edge.edge_id === "to-props")!;
    const ref = { versionId: "artefact-version-registry", portId: "registry-out", memberKey: "" };
    const child = { ...propOne, inputs: [{ ...registryExecution.inputs[0], port_id: "props-in", delivery_id: "delivery-prop-one", artefact_version_id: ref.versionId }] };
    expect(outputReachesExecution(ref, child, route, registryExecution, executionProjection)).toBe(true);
    expect(outputReachesExecution(ref, { ...child, inputs: [{ ...child.inputs[0], delivery_id: "unrelated-delivery" }] }, route, registryExecution, executionProjection)).toBe(false);
    expect(outputReachesExecution({ ...ref, versionId: "another-version" }, child, route, registryExecution, executionProjection)).toBe(false);
  });
});
