import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(import.meta.dirname, "App.tsx"), "utf8");
const switcher = readFileSync(resolve(import.meta.dirname, "workspace/WorkspaceSwitcher.tsx"), "utf8");
const client = readFileSync(resolve(import.meta.dirname, "bus-client/client.ts"), "utf8");

describe("Workspace registration authority boundary", () => {
  it("uses the discovered host operation from every active app entry", () => {
    expect(app).toContain("registerWorkspace");
    expect(switcher).toContain("registerWorkspace");
    expect(client).toContain('candidate.operation_id === "workspace.register"');
    expect(client).toContain("listHostOperations");
    expect(client).toContain("invokeHostOperation");
    expect(client).not.toContain('post("/v1/workspaces/register"');
  });
});
