import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SubstrateToolBridge, type SubstrateSessionHandle, type SubstrateActiveTurn } from "./floe-mcp-server.js";
import type { SubstrateTurnAnchor } from "../runtime-core/index.js";

function makeActiveTurn(): SubstrateActiveTurn {
  return {
    workspace_id: "workspace:test",
    context_id: "ctx-1",
    workspace_locator: null,
    delivery_id: "del-1",
    processing_contract_id: null,
    operation_authority_session: null,
  };
}

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
      getActiveTurn: () => makeActiveTurn(),
      isDependencyRequested: () => false,
      markDependencyRequested: () => {},
      recordEmitted: () => {},
    });
    const client = await connect(bridge, "tok-list");
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "cancel_pulse", "create_pulse", "discover_capabilities", "emit",
      "list_pulses", "pause_pulse", "read_artefact", "request", "resume_pulse", "use_capability",
    ]);
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
      getActiveTurn: () => makeActiveTurn(),
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
      getActiveTurn: () => null,
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

  it("forwards use_capability to the bus under active-Delivery authority", async () => {
    bridge = new SubstrateToolBridge();
    await bridge.ensureStarted();
    const invoked: any[] = [];
    const bus = {
      async prepareRuntimeDelivery(_id: string) {
        return {
          delivery: { state: "prepared" },
          processing_contract: { processing_contract_id: "pc-1" },
          operation_authority_session: {
            authority_session_id: "auth-1",
            bearer_token: "bearer-xyz",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
        };
      },
      async invokeOperation(ws: string, bearer: string, request: any) {
        invoked.push({ ws, bearer, request });
        return {
          kind: "receipt",
          replayed: false,
          receipt: {
            receipt_id: "rcpt-1", invocation_id: "inv-1",
            operation_id: request.operation_id, operation_version: request.operation_version,
            state: "completed", result: { ok: true }, refusal: null,
            changed_refs: [], progress_ref: null, cancel_ref: null, audit_ref: null,
            governance: { policy_evaluation_id: null, approval_request_ids: [], approval_receipt_ids: [], budget_reservation_id: null },
          },
        };
      },
    } as any;
    bridge.register("tok-cap", {
      getBus: () => bus,
      getAnchor: () => anchor,
      getActiveTurn: () => makeActiveTurn(),
      isDependencyRequested: () => false,
      markDependencyRequested: () => {},
      recordEmitted: () => {},
    });
    const client = await connect(bridge, "tok-cap");
    const result: any = await client.callTool({
      name: "use_capability",
      arguments: {
        operation_id: "note.create", operation_version: "1", input_schema_version: "1",
        input: { text: "hello" },
      },
    });
    expect(result.isError).toBeFalsy();
    expect(invoked).toHaveLength(1);
    expect(invoked[0].bearer).toBe("bearer-xyz");
    expect(invoked[0].ws).toBe("workspace:test");
    expect(invoked[0].request.operation_id).toBe("note.create");
    expect(result.content[0].text).toContain("completed");
    await client.close();
  });

  it("forwards create_pulse to the bus anchored to the active turn", async () => {
    bridge = new SubstrateToolBridge();
    await bridge.ensureStarted();
    const created: any[] = [];
    const bus = {
      async createPulse(input: any) {
        created.push(input);
        return { pulse: { pulse_id: input.pulse_id, status: "active", scope_id: input.scope_id ?? null } };
      },
    } as any;
    bridge.register("tok-pulse", {
      getBus: () => bus,
      getAnchor: () => anchor,
      getActiveTurn: () => makeActiveTurn(),
      isDependencyRequested: () => false,
      markDependencyRequested: () => {},
      recordEmitted: () => {},
    });
    const client = await connect(bridge, "tok-pulse");
    const result: any = await client.callTool({
      name: "create_pulse",
      arguments: {
        pulse_id: "reminder-1",
        trigger: { type: "once", after_seconds: 30 },
        event: { type: "pulse.fired", content: { text: "Check the build" } },
        subscribers: [{ kind: "context", context_id: "ctx-1" }],
      },
    });
    expect(result.isError).toBeFalsy();
    expect(created).toHaveLength(1);
    expect(created[0].pulse_id).toBe("reminder-1");
    expect(created[0].workspace_id).toBe("workspace:test");
    expect(created[0].trigger.type).toBe("once");
    expect(typeof created[0].trigger.at).toBe("string");
    expect(created[0].current_context_id).toBe("ctx-1");
    expect(result.content[0].text).toContain("created");
    await client.close();
  });

  it("forwards read_artefact and pages saved text under active-Delivery authority", async () => {
    bridge = new SubstrateToolBridge();
    await bridge.ensureStarted();
    const reads: any[] = [];
    const bus = {
      async prepareRuntimeDelivery(_id: string) {
        return {
          delivery: { state: "prepared" },
          processing_contract: { processing_contract_id: "pc-1" },
          operation_authority_session: {
            authority_session_id: "auth-1",
            bearer_token: "bearer-art",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
        };
      },
      async readArtefactVersionContent(ws: string, versionId: string, bearer: string) {
        reads.push({ ws, versionId, bearer });
        return { bytes: Buffer.from("hello saved text", "utf8"), media_type: "text/plain" };
      },
    } as any;
    bridge.register("tok-art", {
      getBus: () => bus,
      getAnchor: () => anchor,
      getActiveTurn: () => makeActiveTurn(),
      isDependencyRequested: () => false,
      markDependencyRequested: () => {},
      recordEmitted: () => {},
    });
    const client = await connect(bridge, "tok-art");
    const result: any = await client.callTool({
      name: "read_artefact",
      arguments: { artefact_version_id: "av-1" },
    });
    expect(result.isError).toBeFalsy();
    expect(reads).toHaveLength(1);
    expect(reads[0].bearer).toBe("bearer-art");
    expect(reads[0].versionId).toBe("av-1");
    expect(result.content[1].text).toBe("hello saved text");
    await client.close();
  });
});
