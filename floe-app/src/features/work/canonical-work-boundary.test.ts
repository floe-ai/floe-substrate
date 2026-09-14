import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workDir = import.meta.dirname;
const scopeWorkSource = readFileSync(resolve(workDir, "ScopeWorkView.tsx"), "utf8");
const pipelineSource = readFileSync(resolve(workDir, "ScopePipelineFocusView.tsx"), "utf8");
const artefactDetailSource = readFileSync(resolve(workDir, "CanonicalArtefactDetail.tsx"), "utf8");
const contextWorkSource = readFileSync(resolve(workDir, "ContextWorkView.tsx"), "utf8");
const conversationsSource = readFileSync(resolve(workDir, "../conversations/OperatorConversations.tsx"), "utf8");

describe("normal Work canonical boundary", () => {
  it("does not reconstruct the plan from subscriptions, Events, or Deliveries", () => {
    expect(pipelineSource).not.toContain("DeliveryRow");
    expect(pipelineSource).not.toContain("EventEnvelope");
    expect(pipelineSource).not.toContain("event_types ?? [\"*\"]");
    expect(pipelineSource).toContain("revision.edges");
    expect(pipelineSource).toContain("executionProjection?.traversals");
  });

  it("links a conversation to Work only through the canonical Context execution route", () => {
    expect(contextWorkSource).toContain("listContextScopeExecutions");
    expect(contextWorkSource).not.toContain("listDeliveries");
    expect(contextWorkSource).not.toContain("buildContextWorkProjection");
  });

  it("never retires a Scope to stop one execution", () => {
    expect(scopeWorkSource).toContain("scope.execution.stop");
    expect(scopeWorkSource).toContain("invokeOperation");
    expect(scopeWorkSource).not.toContain("retireScope");
  });

  it("keeps extension-owned lineage out of the normal Workspace landing", () => {
    expect(conversationsSource).not.toContain("ArtifactLineageView");
    expect(conversationsSource).not.toContain("artifactGraphPaths");
    expect(scopeWorkSource).toContain("Legacy extension lineage; not canonical pipeline state");
  });

  it("opens execution Artefacts through canonical operations and exact-version content", () => {
    expect(artefactDetailSource).toContain("artefact.inspect");
    expect(artefactDetailSource).toContain("readArtefactVersionContent");
    expect(artefactDetailSource).not.toContain("ArtifactLineageView");
    expect(artefactDetailSource).not.toContain("artifact-graph.json");
    expect(artefactDetailSource).not.toContain("readWorkspaceFile");
  });
});
