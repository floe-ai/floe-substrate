import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "../../bus-client/types.ts";
import {
  artifactNeighborhood,
  findArtifactGraphPath,
  parseArtifactLineageGraph,
} from "./ArtifactLineageView.tsx";
import { artifactFileKind } from "./ArtifactPreview.tsx";
import { artifactGraphNeighborhood } from "./ArtifactRelationshipGraph.tsx";

function event(type: string, text: string): EventEnvelope {
  return {
    event_id: `event:${type}`,
    type,
    workspace_id: "workspace:test",
    source_endpoint_id: "actor:lineage",
    thread_id: "ctx:test",
    context_id: "ctx:test",
    scope_id: "scope:test",
    correlation_id: null,
    destination_json: { kind: "context", context_id: "ctx:test" },
    content: { text },
    response: { expected: false },
    metadata: {},
    artefact_version_ids: [],
    created_at: "2026-09-01T00:00:00Z",
  };
}

describe("artifact lineage projection", () => {
  it("discovers the extension-owned document from its lineage update Event", () => {
    expect(findArtifactGraphPath([
      event("message", "ordinary"),
      event("lineage.updated", JSON.stringify({ artifact_graph: "artifact-graph.json" })),
    ])).toBe("artifact-graph.json");
    expect(findArtifactGraphPath([
      event("lineage.updated", JSON.stringify({ graph_path: "state/current-lineage.json" })),
    ])).toBe("state/current-lineage.json");
    const runtimeAnchored = event("lineage.updated", JSON.stringify({ graph_path: "artifact-graph.json" }));
    runtimeAnchored.content.data = { origin: "pi_emit_tool" };
    expect(findArtifactGraphPath([runtimeAnchored])).toBe("artifact-graph.json");
    expect(findArtifactGraphPath([
      event("lineage.updated", JSON.stringify({ artifact_graph: "../outside.json" })),
    ])).toBeNull();
  });

  it("projects artifact identity, links, status, and related Contexts without changing the source file", () => {
    const graph = parseArtifactLineageGraph(JSON.stringify({
      graph_id: "lineage:test",
      nodes: [
        { id: "source:r1", type: "source-concept", path: "input.png", revision: 1, status: "current", context_refs: ["ctx:source"] },
        { id: "manifest:r1", type: "manifest", path: "manifest.json", revision: "r001", status: "current", context_refs: ["ctx:manifest"] },
        { type: "ignored-without-id" },
      ],
      edges: [
        { from: "source:r1", to: "manifest:r1", relation: "analyzed_into" },
        { from: "missing", to: "manifest:r1", relation: "dangling" },
      ],
    }));
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(artifactNeighborhood(graph, "manifest:r1").upstream).toEqual([
      expect.objectContaining({ relation: "analyzed_into", node: expect.objectContaining({ id: "source:r1" }) }),
    ]);
    expect(graph.nodes[1]?.contextRefs).toEqual(["ctx:manifest"]);
    expect(artifactGraphNeighborhood(graph, "source:r1").nodes.map(item => item.artifact.id)).toEqual([
      "source:r1",
      "manifest:r1",
    ]);
  });

  it("selects an appropriate preview for common artifact file types", () => {
    expect(artifactFileKind("concept.png")).toBe("image");
    expect(artifactFileKind("contact-sheet.JPG")).toBe("image");
    expect(artifactFileKind("registry.json")).toBe("json");
    expect(artifactFileKind("review.md")).toBe("markdown");
    expect(artifactFileKind("output/reference-set")).toBe("folder");
  });
});
