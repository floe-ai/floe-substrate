import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SubstrateToolBridge, type SubstrateSessionHandle } from "./floe-mcp-server.js";
import type { SubstrateTurnAnchor } from "../runtime-core/index.js";

const anchor: SubstrateTurnAnchor = {
  workspace_id: "workspace:test",
  endpoint_id: "actor:workspace:test:floe",
  thread_id: "ctx-1",
  context_id: "ctx-1",
  runtime_turn_id: "rt_1",
  delivery_id: "del-1",
  execution_attempt_id: null,
  scope_execution_id: null,
  composition_revision_id: null,
  node_execution_id: null,
  target_node_id: null,
  invocation_request_event_id: null,
};

function fakeBus(emitted: any[]) {
  return {
    async emit(event: any) {
      emitted.push(event);
      return { event_id: "evt-1", accepted_at: "now", event: { artefact_version_ids: [] } };
    },
    async listEndpoints(_ws: string) {
      return [
        { endpoint_id: "actor:workspace:test:floe", name: "Floe", status: "idle" },
        { endpoint_id: "actor:workspace:test:operator", name: "Operator", status: "active" },
      ];
    },
  } as any;
}

/** Connect an MCP client to the bridge over HTTP with the given session token. */
async function connect(bridge: SubstrateToolBridge, token: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(bridge.mcpUrl), {
    requestInit: { headers: { [bridge.sessionTokenHeader]: token } },
  });
  await client.connect(transport);
  return client;
}

describe("SubstrateToolBridge (MCP over HTTP)", () => {
  let bridge: SubstrateToolBridge | null = null;
  afterEach(async () => { await bridge?.stop(); bridge = null; });

  it("exposes emit + request tools over MCP", async () => {
    bridge = new SubstrateToolBridge();
    await bridge.ensureStarted();
    bridge.register("tok-list", {
      getBus: () => fakeBus([]),
      getAnchor: () => anchor,
      isDependencyRequested: () => false,
      markDependencyRequested: () => {},
      recordEmitted: () => {},
    });
    const client = await connect(bridge, "tok-list");
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["emit", "request"]);
    await client.close();
  });

  it("forwards emit to the bus anchored to the active turn", async () => {
    bridge = new SubstrateToolBridge();
    await bridge.ensureStarted();
    const emitted: any[] = [];
    const recorded: any[] = [];
    const handle: SubstrateSessionHandle = {
      getBus: () => fakeBus(emitted),
      getAnchor: () => anchor,
      isDependencyRequested: () => false,
      markDependencyRequested: () => {},
      recordEmitted: (s) => recorded.push(s),
    };
    bridge.register("tok-1", handle);

    const client = await connect(bridge, "tok-1");
    const result: any = await client.callTool({
      name: "emit",
      arguments: { type: "message", destination: "operator", text: "Ping from MCP" },
    });

    expect(result.isError).toBeFalsy();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].source_endpoint_id).toBe("actor:workspace:test:floe");
    expect(emitted[0].destination).toEqual({ kind: "endpoint", endpoint_id: "actor:workspace:test:operator" });
    expect(emitted[0].content.text).toBe("Ping from MCP");
    expect(emitted[0].metadata.origin).toBe("floe_emit_tool");
    expect(emitted[0].current_delivery_context_id).toBe("ctx-1");
    expect(recorded).toHaveLength(1);
    await client.close();
  });

  it("rejects a connection with an unknown session token", async () => {
    bridge = new SubstrateToolBridge();
    await bridge.ensureStarted();
    await expect(connect(bridge, "nope")).rejects.toThrow();
  });

  it("returns a tool error when no turn is active", async () => {
    bridge = new SubstrateToolBridge();
    await bridge.ensureStarted();
    bridge.register("tok-2", {
      getBus: () => fakeBus([]),
      getAnchor: () => null,
      isDependencyRequested: () => false,
      markDependencyRequested: () => {},
      recordEmitted: () => {},
    });
    const client = await connect(bridge, "tok-2");
    const result: any = await client.callTool({ name: "emit", arguments: { type: "message", destination: "operator", text: "x" } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no active Floe turn");
    await client.close();
  });
});
