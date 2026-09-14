import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const inspector = readFileSync(resolve(import.meta.dirname, "ActorInspector.tsx"), "utf8");
const operations = readFileSync(resolve(import.meta.dirname, "actorDefinitionOperations.ts"), "utf8");

describe("active Actor mutation boundary", () => {
  it("publishes existing Actor edits through the shared contract", () => {
    expect(inspector).toContain("reviseActorDefinition");
    expect(inspector).not.toContain("registerEndpoint");
    expect(inspector).not.toContain("writeWorkspaceFile");
    expect(operations).toContain('"actor.definition.draft.create"');
    expect(operations).toContain('"actor.definition.publish"');
    expect(operations).toContain('"actor.retire"');
    expect(operations).toContain("listOperations");
    expect(operations).toContain("invokeOperation");
  });
});
