import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { defaultConfig, type LocalConfig } from "./config.js";
import { createBusServer } from "./server.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

describe("context diagnostic projection", () => {
  let handle: ServerHandle;
  let root: string;
  let workspaceId: string;
  let operatorId: string;
  let floeId: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "floe-diagnostics-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const configPath = join(root, "config.yaml");
    const config: LocalConfig = defaultConfig(root);
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    handle = await createBusServer(configPath, config, { allow_unauthenticated_test_requests: true });
    await handle.app.ready();
    const registered = handle.store.registerWorkspace({
      locator: workspace,
      name: "Diagnostic test",
      init_authorized: true,
    }, handle.broadcast) as { workspace_id: string };
    workspaceId = registered.workspace_id;
    operatorId = `actor:${workspaceId}:operator`;
    floeId = `actor:${workspaceId}:floe`;
    handle.store.registerBridge({ bridge_id: "bridge:diagnostic-test" }, handle.broadcast);
    handle.store.registerEndpoint({
      endpoint_id: operatorId,
      workspace_id: workspaceId,
      name: "Operator",
      agent_id: "operator",
      bridge_id: null,
      status: "idle",
      metadata: { api_key: "must-not-leave-endpoint-storage" },
    }, handle.broadcast);
    handle.store.registerEndpoint({
      endpoint_id: floeId,
      workspace_id: workspaceId,
      name: "Floe",
      agent_id: "floe",
      bridge_id: "bridge:diagnostic-test",
      status: "idle",
    }, handle.broadcast);
  });

  afterEach(async () => {
    try { await handle.app.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  function send(text: string, contextId?: string) {
    return handle.store.submitEvent({
      type: "message",
      workspace_id: workspaceId,
      source_endpoint_id: operatorId,
      destination: { kind: "endpoint", endpoint_id: floeId },
      thread_id: "",
      correlation_id: null,
      content: { text },
      metadata: {},
      idempotency_key: null,
      context_id: contextId,
    }, handle.broadcast).event;
  }

  it("returns only bounded facts related to the requested Context", async () => {
    const first = send("expected message");
    send("newest message", first.context_id);
    const unrelated = send("unrelated context");

    const relatedDeliveries = handle.store.listContextDeliveries({
      workspace_id: workspaceId,
      context_id: first.context_id,
      limit: 10,
    }) as Array<{ delivery_id: string }>;
    expect(relatedDeliveries.length).toBeGreaterThan(0);
    handle.store.appendRuntimeTelemetry({
      workspace_id: workspaceId,
      endpoint_id: floeId,
      delivery_id: relatedDeliveries.at(-1)!.delivery_id,
      kind: "runtime.progress",
      payload: { phase: "working", authorization: "Bearer should-be-redacted-by-client" },
    }, handle.broadcast);
    handle.store.appendRuntimeTelemetry({
      workspace_id: workspaceId,
      endpoint_id: floeId,
      delivery_id: relatedDeliveries.at(-1)!.delivery_id,
      kind: "visible_output",
      payload: { text: "full model prose must not consume diagnostic limits" },
    }, handle.broadcast);
    handle.store.appendRuntimeTelemetry({
      workspace_id: workspaceId,
      endpoint_id: floeId,
      delivery_id: relatedDeliveries.at(-1)!.delivery_id,
      kind: "BeforeToolUse",
      payload: {
        toolCallId: "call-private",
        toolName: "shell",
        args: { command: "echo should-never-leave-the-bus" },
      },
    }, handle.broadcast);

    const response = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/diagnostics/contexts/${encodeURIComponent(first.context_id)}?event_limit=1&delivery_limit=1&telemetry_limit=10`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      schema: "floe.context-diagnostic.v1",
      source: { component: "floe-bus" },
      workspace: { workspace_id: workspaceId },
      context: {
        context_id: first.context_id,
      },
      runtime: { bridge: { online: false, runtime_adapter: null } },
      limits: {
        events: 1,
        deliveries: 1,
        telemetry: 10,
        events_truncated: true,
        deliveries_truncated: false,
      },
    });
    expect(body.context.participants).toEqual(expect.arrayContaining([operatorId, floeId]));
    expect(body.events).toHaveLength(1);
    expect(body.events[0].content.text).toBe("newest message");
    expect(body.events.every((event: any) => event.context_id === first.context_id)).toBe(true);
    expect(body.events.some((event: any) => event.context_id === unrelated.context_id)).toBe(false);
    expect(body.telemetry).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "runtime.progress", payload: expect.objectContaining({ phase: "working" }) }),
      expect.objectContaining({ kind: "BeforeToolUse", payload: { toolName: "shell" } }),
    ]));
    expect(JSON.stringify(body.telemetry)).not.toContain("should-never-leave-the-bus");
    expect(JSON.stringify(body.telemetry)).not.toContain("call-private");
    expect(JSON.stringify(body.telemetry)).not.toContain("should-be-redacted-by-client");
    expect(body.telemetry.some((record: any) => record.kind === "visible_output")).toBe(false);
    expect(body.context.endpoints[0]).not.toHaveProperty("metadata_json");
    expect(JSON.stringify(body.context.endpoints)).not.toContain("must-not-leave-endpoint-storage");
    expect(body.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation_id: "scope.composition.draft.create", effects: expect.objectContaining({ mode: "write" }) }),
    ]));
  });

  it("does not expose a Context through the wrong workspace", async () => {
    const event = send("private to this workspace");
    const response = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent("workspace:other")}/diagnostics/contexts/${encodeURIComponent(event.context_id)}`,
    });
    expect(response.statusCode).toBe(404);
  });
});
