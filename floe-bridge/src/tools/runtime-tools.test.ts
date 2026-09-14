import { describe, expect, it } from "vitest";
import type { BusClient } from "../bus-client.js";
import { createRuntimeTools } from "./runtime-tools.js";

describe("runtime Actor capability boundary", () => {
  it("provides governed discovery without file-backed Actor management shortcuts", () => {
    const tools = createRuntimeTools({
      bus: {} as BusClient,
      workspaceId: "workspace:tool-catalogue",
      endpointId: "actor:worker",
      toolContext: { getActiveTurn: () => undefined },
    }).map(tool => tool.name);
    expect(tools).toEqual(expect.arrayContaining(["discover_capabilities", "use_capability"]));
    for (const name of ["create_actor", "list_actors", "update_actor", "delete_actor"]) {
      expect(tools).not.toContain(name);
    }
  });
});
