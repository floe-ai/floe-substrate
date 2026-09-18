import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultConfig, type LocalConfig } from "./config.js";
import { BridgeDaemon, chooseAdapter } from "./daemon.js";
import { TurnFailedError } from "./adapters/turn-failed-error.js";
import { HookRegistry, type HookPayload } from "./hooks.js";

const envStack: Array<string | undefined> = [];
const bridgeServiceToken = `test-bridge-service-${"b".repeat(48)}`;
const originalBridgeServiceToken = process.env.FLOE_BRIDGE_SERVICE_TOKEN;

beforeAll(() => {
  process.env.FLOE_BRIDGE_SERVICE_TOKEN = bridgeServiceToken;
});

afterAll(() => {
  if (originalBridgeServiceToken === undefined) delete process.env.FLOE_BRIDGE_SERVICE_TOKEN;
  else process.env.FLOE_BRIDGE_SERVICE_TOKEN = originalBridgeServiceToken;
});

function makeConfig(runtimeAdapter?: string): { configPath: string; config: LocalConfig; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "floe-bridge-adapter-"));
  const config = defaultConfig(home);
  if (runtimeAdapter !== undefined) config.bridge.runtime_adapter = runtimeAdapter;
  const configPath = join(home, "config.yaml");
  writeFileSync(configPath, YAML.stringify(config), "utf8");
  return {
    configPath,
    config,
    cleanup: () => rmSync(home, { recursive: true, force: true })
  };
}

function withoutAdapterEnv(): void {
  envStack.push(process.env.FLOE_RUNTIME_ADAPTER);
  delete process.env.FLOE_RUNTIME_ADAPTER;
}

afterEach(() => {
  const previous = envStack.pop();
  if (previous === undefined) delete process.env.FLOE_RUNTIME_ADAPTER;
  else process.env.FLOE_RUNTIME_ADAPTER = previous;
});

describe("chooseAdapter", () => {
  it.each(["push", "claim"])("retains a %s reservation arriving while the previous response unwinds", async path => {
    const made = makeConfig();
    try {
      const daemon = new BridgeDaemon(made.configPath, made.config);
      let finish!: () => void;
      const firstDone = new Promise<void>(resolve => { finish = resolve; });
      const handled = vi.fn().mockImplementationOnce(() => firstDone).mockResolvedValue(undefined);
      (daemon as any).handleDelivery = handled;
      (daemon as any).endpointRuntime.set("actor:test", {});
      const first = { endpoint_id: "actor:test", delivery_id: "del:first" };
      const second = { endpoint_id: "actor:test", delivery_id: "del:second" };
      await (daemon as any).handleEventStreamMessage({ type: "delivery_bundle_available", payload: { delivery: first } });
      await (daemon as any).handleEventStreamMessage({ type: "delivery_bundle_available", payload: { delivery: first } });
      if (path === "push") {
        await (daemon as any).handleEventStreamMessage({ type: "delivery_bundle_available", payload: { delivery: second } });
      } else {
        (daemon as any).bus = { claimDeliveries: vi.fn().mockResolvedValue([second]) };
        await (daemon as any).processDeliveries();
      }
      expect(handled).toHaveBeenCalledTimes(1);
      finish();
      await vi.waitFor(() => expect(handled).toHaveBeenCalledTimes(2));
      expect(handled.mock.calls[1][0]).toBe(second);
      expect((daemon as any).pendingDeliveries.size).toBe(0);
    } finally { made.cleanup(); }
  });
  it("uses floe-runtime as the live runtime on a clean start", () => {
    withoutAdapterEnv();
    const made = makeConfig();
    try {
      expect(chooseAdapter(made.configPath, made.config).name).toBe("floe-runtime");
    } finally {
      made.cleanup();
    }
  });

  it("selects floe-runtime when explicitly configured", () => {
    withoutAdapterEnv();
    const made = makeConfig("floe-runtime");
    try {
      expect(chooseAdapter(made.configPath, made.config).name).toBe("floe-runtime");
    } finally {
      made.cleanup();
    }
  });

  it("rejects the removed pi-agent-core adapter name", () => {
    withoutAdapterEnv();
    const made = makeConfig("pi-agent-core");
    try {
      expect(() => chooseAdapter(made.configPath, made.config)).toThrow(/Unsupported FLOE runtime adapter "pi-agent-core"/);
    } finally {
      made.cleanup();
    }
  });

  it("does not silently fall back to fake for unsupported adapter names", () => {
    withoutAdapterEnv();
    const made = makeConfig("copilot");
    try {
      expect(() => chooseAdapter(made.configPath, made.config)).toThrow(/Unsupported FLOE runtime adapter "copilot"/);
    } finally {
      made.cleanup();
    }
  });

  it("does not retain the removed Codex app-server runtime path", () => {
    withoutAdapterEnv();
    const made = makeConfig("codex-app-server");
    try {
      expect(() => chooseAdapter(made.configPath, made.config)).toThrow(/Unsupported FLOE runtime adapter "codex-app-server"/);
    } finally {
      made.cleanup();
    }
  });
});

describe("BridgeDaemon shutdown", () => {
  it("stays explicitly unavailable instead of trusting loopback when its credential is missing", async () => {
    withoutAdapterEnv();
    const made = makeConfig("fake");
    try {
      const daemon = new BridgeDaemon(made.configPath, made.config, {
        transport_authority: null,
      });

      expect(daemon.transportAuthorityState).toEqual({
        status: "unavailable",
        reason: "credential_missing",
      });
      await expect(daemon.start()).rejects.toMatchObject({
        code: "bridge_transport_unavailable",
        reason: "credential_missing",
      });
    } finally {
      made.cleanup();
    }
  });

  it("disposes runtime adapter sessions with bridge_shutdown reason", async () => {
    withoutAdapterEnv();
    const made = makeConfig("fake");
    const disposeReasons: string[] = [];
    try {
      const daemon = new BridgeDaemon(made.configPath, made.config);
      (daemon as any).adapter = {
        name: "test-adapter",
        async handleBundle() {},
        async dispose(reason?: string) {
          disposeReasons.push(reason ?? "");
        }
      };

      await daemon.stop();

      expect(disposeReasons).toEqual(["bridge_shutdown"]);
    } finally {
      made.cleanup();
    }
  });

  it("interrupts the exact runtime delivery requested by the Bus", () => {
    withoutAdapterEnv();
    const made = makeConfig("fake");
    try {
      const daemon = new BridgeDaemon(made.configPath, made.config);
      const cancelDelivery = vi.fn(() => true);
      (daemon as any).adapter = { name: "test-adapter", handleBundle: vi.fn(), cancelDelivery };

      (daemon as any).handleEventStreamMessage({
        type: "delivery_cancel_requested",
        payload: { delivery_id: "delivery:active" },
      });

      expect(cancelDelivery).toHaveBeenCalledWith("delivery:active");
      expect((daemon as any).cancelledDeliveries.has("delivery:active")).toBe(true);
    } finally {
      made.cleanup();
    }
  });

  it("does not start a pushed delivery when cancellation overtakes execution", async () => {
    withoutAdapterEnv();
    const made = makeConfig("fake");
    try {
      const daemon = new BridgeDaemon(made.configPath, made.config);
      const handleBundle = vi.fn(async () => {});
      const reportTurnEnd = vi.fn(async () => {});
      (daemon as any).adapter = { name: "test-adapter", handleBundle, cancelDelivery: vi.fn(() => false) };
      (daemon as any).bus = { reportTurnEnd };

      (daemon as any).handleEventStreamMessage({
        type: "delivery_cancel_requested",
        payload: { delivery_id: "delivery:queued-locally" },
      });
      await (daemon as any).handleDelivery({
        delivery_id: "delivery:queued-locally",
        endpoint_id: "actor:test:worker",
        workspace_id: "workspace:test",
        events: [],
      });

      expect(handleBundle).not.toHaveBeenCalled();
      expect(reportTurnEnd).toHaveBeenCalledWith("actor:test:worker");
    } finally {
      made.cleanup();
    }
  });
});

describe("BridgeDaemon canonical runtime and Scope refresh", () => {
  it.each(["scope_graph_created", "scope_graph_updated", "scope_retired", "actor_runtime_binding_changed"])(
    "reattaches workspaces when receiving %s",
    async (messageType) => {
    withoutAdapterEnv();
    const made = makeConfig("fake");
    try {
      const daemon = new BridgeDaemon(made.configPath, made.config);
      const attach = vi.fn(async () => {});
      const process = vi.fn(async () => {});
      (daemon as any).attachKnownWorkspaces = attach;
      (daemon as any).processDeliveries = process;

      await (daemon as any).handleEventStreamMessage({
        type: messageType,
        payload: { graph: { graph_id: "graph-1" } },
      });

      expect(attach).toHaveBeenCalledOnce();
      expect(process).toHaveBeenCalledOnce();
    } finally {
      made.cleanup();
    }
    },
  );

  it("rechecks attachment when a configuration push arrives during the current pass", async () => {
    withoutAdapterEnv();
    const made = makeConfig("fake");
    try {
      const daemon = new BridgeDaemon(made.configPath, made.config);
      let finish!: () => void;
      const pending = new Promise<void>(resolve => { finish = resolve; });
      const workspace = { workspace_id: "workspace:test" };
      const list = vi.fn().mockResolvedValue([workspace]);
      const attach = vi.fn().mockImplementationOnce(() => pending).mockResolvedValue(undefined);
      (daemon as any).bus = { listWorkspaces: list };
      (daemon as any).attachWorkspace = attach;
      const first = (daemon as any).attachKnownWorkspaces();
      await Promise.resolve();
      expect(attach).toHaveBeenCalledOnce();
      const second = (daemon as any).attachKnownWorkspaces();
      finish();
      await Promise.all([first, second]);
      expect(attach).toHaveBeenCalledTimes(2);
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      made.cleanup();
    }
  });
});

describe("BridgeDaemon hook event stream", () => {
  it("fires WebhookReceived once for a persisted webhook ingest event and ignores spoofed or repeated payloads", async () => {
    withoutAdapterEnv();
    const made = makeConfig("fake");
    const previousWebSocket = (globalThis as any).WebSocket;
    let socket: { emitMessage(data: string): void } | undefined;

    class FakeWebSocket {
      private listeners = new Map<string, Array<(event: { data: string }) => void>>();

      constructor(readonly url: string) {
        socket = this;
      }

      addEventListener(event: string, listener: (event: { data: string }) => void): void {
        const existing = this.listeners.get(event) ?? [];
        existing.push(listener);
        this.listeners.set(event, existing);
      }

      emitMessage(data: string): void {
        for (const listener of this.listeners.get("message") ?? []) listener({ data });
      }
    }

    (globalThis as any).WebSocket = FakeWebSocket;

    const received: HookPayload[] = [];
    const hooks = new HookRegistry();
    hooks.on("WebhookReceived", "bad-ext", () => {
      throw new Error("webhook hook failed");
    });
    hooks.on("WebhookReceived", "test-ext", (payload) => {
      received.push(payload);
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const daemon = new BridgeDaemon(made.configPath, made.config);
      (daemon as any).bus = {
        async health() {},
        async registerBridge() {},
        async listWorkspaces() { return []; },
        async claimDeliveries() { return []; },
        async reportBridgeLiveness() {}
      };

      await daemon.start();
      socket?.emitMessage(JSON.stringify({
        type: "authenticated",
        payload: { audience: "bridge_service", bridge_id: daemon.bridgeId, cursor: "cursor:0" },
      }));
      (daemon as any).workspaceHooks.set("workspace:test", hooks);

      socket?.emitMessage(JSON.stringify({
        type: "event_submitted",
        payload: {
          event: {
            event_id: "evt:webhook:1",
            type: "webhook_received",
            workspace_id: "workspace:test",
            source_endpoint_id: null,
            thread_id: "",
            context_id: "ctx:webhook:1",
            correlation_id: "corr-1",
            destination_json: {
              kind: "endpoint",
              endpoint_id: "actor:workspace:test:floe"
            },
            content: {
              text: "Webhook route_alpha received",
              data: { text: "Webhook route_alpha received", correlation_id: "corr-1" }
            },
            response: { expected: false },
            metadata: {
              trigger_kind: "webhook",
              route_id: "route_alpha"
            },
            created_at: new Date().toISOString()
          }
        }
      }));
      socket?.emitMessage(JSON.stringify({
        type: "event_submitted",
        payload: {
          event: {
            event_id: "evt:webhook:1",
            type: "webhook_received",
            workspace_id: "workspace:test",
            source_endpoint_id: null,
            context_id: "ctx:webhook:1",
            destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:floe" },
            content: { text: "duplicate replay" },
            metadata: { trigger_kind: "webhook", route_id: "route_alpha" }
          }
        }
      }));
      socket?.emitMessage(JSON.stringify({
        type: "event_submitted",
        payload: {
          event: {
            event_id: "evt:webhook:spoof",
            type: "webhook_received",
            workspace_id: "workspace:test",
            source_endpoint_id: "actor:workspace:test:operator",
            context_id: "ctx:webhook:spoof",
            destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:floe" },
            content: { text: "ordinary emit spoof" },
            metadata: { trigger_kind: "webhook", route_id: "route_alpha" }
          }
        }
      }));
      socket?.emitMessage(JSON.stringify({
        type: "event_submitted",
        payload: {
          event: {
            event_id: "evt:webhook:other-workspace",
            type: "webhook_received",
            workspace_id: "workspace:other",
            source_endpoint_id: null,
            context_id: "ctx:webhook:other",
            destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:other:floe" },
            content: { text: "other workspace" },
            metadata: { trigger_kind: "webhook", route_id: "route_alpha" }
          }
        }
      }));
      socket?.emitMessage(JSON.stringify({
        type: "event_submitted",
        payload: {
          event: {
            event_id: "evt:webhook:missing-route",
            type: "webhook_received",
            workspace_id: "workspace:test",
            source_endpoint_id: null,
            context_id: "ctx:webhook:missing-route",
            destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:floe" },
            content: { text: "missing route" },
            metadata: { trigger_kind: "webhook" }
          }
        }
      }));
      socket?.emitMessage(JSON.stringify({
        type: "event_submitted",
        payload: {
          event: {
            event_id: "evt:message:1",
            type: "message",
            workspace_id: "workspace:test",
            destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:floe" },
            content: { text: "not a webhook" },
            metadata: {}
          }
        }
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await daemon.stop();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        workspace_id: "workspace:test",
        route_id: "route_alpha",
        event_id: "evt:webhook:1",
        context_id: "ctx:webhook:1",
        target_endpoint_id: "actor:workspace:test:floe",
        content: {
          text: "Webhook route_alpha received"
        },
        metadata: {
          trigger_kind: "webhook",
          route_id: "route_alpha"
        }
      });
    } finally {
      consoleSpy.mockRestore();
      (globalThis as any).WebSocket = previousWebSocket;
      made.cleanup();
    }
  });

  it("bounds WebhookReceived replay dedupe to recent event IDs", async () => {
    withoutAdapterEnv();
    const made = makeConfig("fake");
    const previousWebSocket = (globalThis as any).WebSocket;
    let socket: { emitMessage(data: string): void } | undefined;

    class FakeWebSocket {
      private listeners = new Map<string, Array<(event: { data: string }) => void>>();

      constructor(readonly url: string) {
        socket = this;
      }

      addEventListener(event: string, listener: (event: { data: string }) => void): void {
        const existing = this.listeners.get(event) ?? [];
        existing.push(listener);
        this.listeners.set(event, existing);
      }

      emitMessage(data: string): void {
        for (const listener of this.listeners.get("message") ?? []) listener({ data });
      }
    }

    (globalThis as any).WebSocket = FakeWebSocket;

    const receivedEventIds: string[] = [];
    const hooks = new HookRegistry();
    hooks.on("WebhookReceived", "test-ext", (payload) => {
      receivedEventIds.push(payload.event_id);
    });

    try {
      const daemon = new BridgeDaemon(made.configPath, made.config);
      (daemon as any).bus = {
        async health() {},
        async registerBridge() {},
        async listWorkspaces() { return []; },
        async claimDeliveries() { return []; },
        async reportBridgeLiveness() {}
      };

      await daemon.start();
      socket?.emitMessage(JSON.stringify({
        type: "authenticated",
        payload: { audience: "bridge_service", bridge_id: daemon.bridgeId, cursor: "cursor:0" },
      }));
      (daemon as any).workspaceHooks.set("workspace:test", hooks);

      const emitWebhook = (eventId: string) => socket?.emitMessage(JSON.stringify({
        type: "event_submitted",
        payload: {
          event: {
            event_id: eventId,
            type: "webhook_received",
            workspace_id: "workspace:test",
            source_endpoint_id: null,
            context_id: `ctx:${eventId}`,
            destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:floe" },
            content: { text: eventId },
            metadata: { trigger_kind: "webhook", route_id: "route_alpha" }
          }
        }
      }));

      const webhookDedupeMaxEvents = 10_000;
      for (let index = 0; index <= webhookDedupeMaxEvents; index += 1) {
        emitWebhook(`evt:webhook:${index}`);
      }
      emitWebhook("evt:webhook:10000");
      emitWebhook("evt:webhook:0");

      await new Promise((resolve) => setTimeout(resolve, 0));
      await daemon.stop();

      expect(receivedEventIds.filter((eventId) => eventId === "evt:webhook:10000")).toHaveLength(1);
      expect(receivedEventIds.filter((eventId) => eventId === "evt:webhook:0")).toHaveLength(2);
    } finally {
      (globalThis as any).WebSocket = previousWebSocket;
      made.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// FIX 1: TurnFailedError handling in daemon handleDelivery
// ---------------------------------------------------------------------------

describe("BridgeDaemon – TurnFailedError handling (FIX 1)", () => {
  it("records terminal failure through the causal turn-result path", async () => {
    withoutAdapterEnv();
    const made = makeConfig("fake");

    try {
      const daemon = new BridgeDaemon(made.configPath, made.config);

      const emittedEvents: any[] = [];
      const turnResults: any[] = [];
      const deliveryStatusUpdates: Array<{ id: string; state: string; error?: string | null }> = [];
      const endpointStatusUpdates: Array<{ id: string; status: string }> = [];

      const delivery = {
        delivery_id: "del-turn-fail-1",
        endpoint_id: "actor:workspace:test:floe",
        workspace_id: "workspace:test",
        trigger_event_id: "evt:del-turn-fail-1",
        delivered_at: new Date().toISOString(),
        events: [
          {
            event_id: "evt:del-turn-fail-1",
            type: "message",
            workspace_id: "workspace:test",
            source_endpoint_id: "actor:workspace:test:operator",
            thread_id: "thread:test:1",
            context_id: "ctx:test:1",
            correlation_id: null,
            destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:floe" },
            content: { text: "hello" },
            response: { expected: false },
            metadata: {},
            created_at: new Date().toISOString()
          }
        ]
      };

      // Adapter that throws TurnFailedError (simulating a pi turn failure)
      (daemon as any).adapter = {
        name: "test-failing-adapter",
        async handleBundle() {
          throw new TurnFailedError(
            "del-turn-fail-1",
            "actor:workspace:test:operator",
            "workspace:test",
            "ctx:test:1",
            "thread:test:1",
            "claude-haiku-4-5",
            "anthropic",
            400,
            "POST /v1/messages failed: 400 Bad Request"
          );
        }
      };

      (daemon as any).bus = {
        async emit(event: any) { emittedEvents.push(event); },
        async reportDeliveryStatus(...[id, state, error]: [string, string, string?]) {
          deliveryStatusUpdates.push({ id, state, error: error ?? null });
          return { state, attempt_count: 1 };
        },
        async recordRuntimeTurnResult(input: any) { turnResults.push(input); },
        async reportTurnEnd() {},
        async updateEndpointStatus(id: string, status: string) {
          endpointStatusUpdates.push({ id, status });
        },
        async appendRuntimeTelemetry() {},
        async resolveRuntimeBinding() {
          return {
            endpoint_auth_profile: "test-profile",
            workspace_auth_profile: null,
            global_auth_profile: null,
            endpoint_model: null,
            workspace_model: null,
            global_model: null,
            endpoint_thinking_level: null,
            workspace_thinking_level: null,
            global_thinking_level: null
          };
        }
      };

      (daemon as any).endpointRuntime.set("actor:workspace:test:floe", {
        config: { auth_profile: "test-profile", provider: "anthropic", model: "claude-haiku-4-5" },
        instructions: "",
        workspace_locator: undefined,
        agent_id: undefined
      });

      await (daemon as any).handleDelivery(delivery);

      expect(emittedEvents).toHaveLength(0);
      expect(turnResults).toEqual([expect.objectContaining({
        delivery_id: "del-turn-fail-1",
        outcome: "failed",
        text: expect.stringContaining("HTTP 400"),
        metadata: expect.objectContaining({ runtime: "test-failing-adapter" })
      })]);

      // An injected runtime turn may already have effects, so it is terminal
      // and must not enter the automatic delivery retry loop.
      const failedUpdate = deliveryStatusUpdates.find((u) => u.state === "dead_lettered");
      expect(failedUpdate).toBeDefined();
      expect(failedUpdate?.id).toBe("del-turn-fail-1");

      // Endpoint must NOT be set to error status (turn failures don't invalidate the endpoint)
      const errorStatus = endpointStatusUpdates.find((u) => u.status === "error");
      expect(errorStatus).toBeUndefined();
    } finally {
      made.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Canonical direct Context runtime pins
// ---------------------------------------------------------------------------

describe("BridgeDaemon – canonical direct Context runtime", () => {
  it.each([false, true])("uses the pinned runtime and its Workspace binding without an Actor file (local access: %s)", async (hasLocalBinding) => {
    withoutAdapterEnv();
    const made = makeConfig("fake");
    try {
      const daemon = new BridgeDaemon(made.configPath, made.config);
      const selected: any[] = [];
      const contexts: any[] = [];
      if (hasLocalBinding) (daemon as any).workspaceLocators.set("workspace:test", made.config.home);
      let mutableResolutionCalls = 0;
      let runtimePrepareCalls = 0;
      (daemon as any).adapter = {
        name: "fake",
        async handleBundle(context: unknown, _delivery: unknown, config: unknown) {
          contexts.push(context);
          selected.push(config);
        },
      };
      (daemon as any).bus = {
        async prepareRuntimeDelivery() {
          runtimePrepareCalls += 1;
          return {
            delivery: { state: "claimed", execution_attempt_id: null },
            processing_contract: processingContract,
            operation_authority_session: {
              authority_session_id: "operation-authority-session:pinned-direct",
              bearer_token: "operation-bearer-pinned-direct",
              expires_at: "2099-01-01T00:00:00.000Z",
            },
          };
        },
        async reportDeliveryStatus(_id: string, state: string) { return { state }; },
        async reportTurnEnd() {},
        async resolveRuntimeBinding() { mutableResolutionCalls += 1; throw new Error("must not resolve"); },
      };

      const delivery: any = {
        delivery_id: "delivery:pinned-direct",
        stable_delivery_ids: ["stable-delivery:pinned-direct"],
        endpoint_id: "actor:workspace:test:floe",
        workspace_id: "workspace:test",
        trigger_event_id: "event:pinned-direct",
        delivered_at: new Date().toISOString(),
        events: [],
        actor_definition_revision_id: "actor-definition:pinned",
        runtime_profile_revision_id: "runtime-profile-revision:pinned",
        actor_runtime_binding_id: "runtime-binding:pinned",
        processing_contract: {
          contract_kind: "direct_context",
          contract_version: 1,
          processing_contract_id: "runtime-processing-contract:v1:delivery:pinned-direct",
          workspace_id: "workspace:test",
          delivery: {
            delivery_id: "delivery:pinned-direct",
            stable_delivery_ids: ["stable-delivery:pinned-direct"],
            endpoint_id: "actor:workspace:test:floe",
            context_id: "context:pinned-direct",
          },
          context: { context_id: "context:pinned-direct", inspect_operation_id: "context.inspect" },
          actor: {
            actor_id: "actor:workspace:test:floe",
            definition: {
              actor_definition_revision_id: "actor-definition:pinned",
              actor_id: "actor:workspace:test:floe",
              workspace_id: "workspace:test",
              content: {
                instructions: "Use the exact recorded runtime.",
                capability_grant_ids: [],
              },
            },
          },
          runtime: {
            binding: {
              actor_runtime_binding_id: "runtime-binding:pinned",
              actor_id: "actor:workspace:test:floe",
              workspace_id: "workspace:test",
              runtime_profile_revision_id: "runtime-profile-revision:pinned",
              endpoint_id: "actor:workspace:test:floe",
            },
            profile: {
              runtime_profile_revision_id: "runtime-profile-revision:pinned",
              runtime_profile_id: "runtime-profile:floe",
              content: {
                adapter_id: "fake",
                configuration: {
                  provider: "recorded-provider",
                  model: "recorded-model",
                  auth_profile: "recorded-profile",
                  thinking_level: "high",
                },
                secret_ref_ids: ["secret-ref:recorded-profile"],
                resource_policy: {},
              },
            },
          },
          operation_authority: {
            principal_id: "actor:workspace:test:floe",
            capability_grant_ids: [],
            authority_session_required: true,
          },
          events: [],
          outputs: { publish_operation_id: null, ports: [] },
        },
      };
      const processingContract = delivery.processing_contract;
      delete delivery.processing_contract;

      await (daemon as any).handleDelivery(delivery);

      expect(mutableResolutionCalls).toBe(0);
      expect(runtimePrepareCalls).toBe(1);
      expect(contexts[0].workspace_locator).toBe(hasLocalBinding ? made.config.home : undefined);
      expect(selected).toEqual([expect.objectContaining({
        provider: "recorded-provider",
        model: "recorded-model",
        model_source: "runtime_profile_revision",
        thinking_level: "high",
        instructions: "Use the exact recorded runtime.",
      })]);
    } finally {
      made.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Extension isolation: workspace package code never enters an Actor runtime
// ---------------------------------------------------------------------------

describe("BridgeDaemon – Extension isolation", () => {
  it("does not inject workspace Extension code into an Actor runtime", async () => {
    withoutAdapterEnv();
    const made = makeConfig("fake");

    try {
      const daemon = new BridgeDaemon(made.configPath, made.config);

      const capturedBundles: any[] = [];

      // A mock adapter that captures the bundle context passed to handleBundle
      (daemon as any).adapter = {
        name: "test-capture-adapter",
        async handleBundle(context: any) {
          capturedBundles.push(context);
        }
      };

      // Register an ordinary Actor. Extension capabilities are reached only
      // through canonical operations and never arrive as imported tool code.
      (daemon as any).endpointRuntime.set("actor:workspace:test:floe", {
        config: { auth_profile: "test-profile", provider: "anthropic", model: "claude-haiku-4-5" },
        instructions: "",
        workspace_locator: undefined,
        agent_id: "floe"
      });

      (daemon as any).bus = {
        async emit() {},
        async reportDeliveryStatus() {},
        async reportTurnEnd() {},
        async updateEndpointStatus() {},
        async appendRuntimeTelemetry() {},
        async resolveRuntimeBinding() {
          return {
            endpoint_auth_profile: "test-profile",
            workspace_auth_profile: null,
            global_auth_profile: null,
            endpoint_model: null,
            workspace_model: null,
            global_model: null,
            endpoint_thinking_level: null,
            workspace_thinking_level: null,
            global_thinking_level: null
          };
        }
      };

      const delivery = {
        delivery_id: "del-ungate-1",
        endpoint_id: "actor:workspace:test:floe",
        workspace_id: "workspace:test",
        trigger_event_id: "evt:del-ungate-1",
        delivered_at: new Date().toISOString(),
        events: [
          {
            event_id: "evt:del-ungate-1",
            type: "message",
            workspace_id: "workspace:test",
            source_endpoint_id: "actor:workspace:test:operator",
            thread_id: "thread:test:1",
            context_id: "ctx:test:1",
            correlation_id: null,
            destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:floe" },
            content: { text: "do the task" },
            response: { expected: false },
            metadata: {},
            created_at: new Date().toISOString()
          }
        ]
      };

      await (daemon as any).handleDelivery(delivery);

      expect(capturedBundles).toHaveLength(1);
      expect(capturedBundles[0]).not.toHaveProperty("extensions");
    } finally {
      made.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// D1 — WS reconnect: exponential back-off + one-shot resync on reopen
// ---------------------------------------------------------------------------

describe("BridgeDaemon – D1 WS reconnect with exponential back-off", () => {
  it("reconnects after socket close with increasing back-off and resets on reopen", async () => {
    withoutAdapterEnv();
    const made = makeConfig("fake");
    const previousWebSocket = (globalThis as any).WebSocket;

    const socketInstances: Array<{
      emitOpen(): void;
      emitMessage(data: string): void;
      emitClose(code?: number): void;
      sent: string[];
    }> = [];

    class FakeWebSocket {
      private listeners = new Map<string, Array<(event?: any) => void>>();
      readonly sent: string[] = [];

      constructor(readonly url: string) {
        socketInstances.push(this as any);
      }

      addEventListener(event: string, listener: (event?: any) => void): void {
        const existing = this.listeners.get(event) ?? [];
        existing.push(listener);
        this.listeners.set(event, existing);
      }

      send(data: string): void { this.sent.push(data); }
      close(): void {}

      emitOpen(): void {
        for (const l of this.listeners.get("open") ?? []) l();
      }
      emitMessage(data: string): void {
        for (const l of this.listeners.get("message") ?? []) l({ data });
      }
      emitClose(code = 1000): void {
        for (const l of this.listeners.get("close") ?? []) l({ code });
      }
    }

    (globalThis as any).WebSocket = FakeWebSocket;

    const attachCalls: string[] = [];
    const processCalls: string[] = [];

    try {
      const daemon = new BridgeDaemon(made.configPath, made.config);
      (daemon as any).bus = {
        async health() {},
        async registerBridge() {},
        async listWorkspaces() { attachCalls.push("attach"); return []; },
        async claimDeliveries() { processCalls.push("process"); return []; },
        async reportBridgeLiveness() {}
      };

      await daemon.start();

      // First socket created by openEventStream()
      expect(socketInstances).toHaveLength(1);

      // Opening sends authentication; only the acknowledgement triggers resync.
      socketInstances[0].emitOpen();
      socketInstances[0].emitMessage(JSON.stringify({
        type: "authenticated",
        payload: { audience: "bridge_service", bridge_id: daemon.bridgeId },
      }));
      socketInstances[0].emitMessage(JSON.stringify({
        type: "caught_up",
        payload: { cursor: "cursor:1" },
      }));
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(attachCalls.length).toBeGreaterThanOrEqual(1);
      expect(processCalls.length).toBeGreaterThanOrEqual(1);
      const callsAfterFirstOpen = attachCalls.length;

      socketInstances[0].emitMessage(JSON.stringify({
        type: "bridge_test_signal",
        payload: {},
        at: new Date().toISOString(),
        cursor: "cursor:live",
      }));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(JSON.parse(socketInstances[0].sent.at(-1) ?? "{}")).toEqual({
        type: "acknowledge_cursor",
        cursor: "cursor:live",
      });

      // Simulate socket close → should schedule a reconnect
      socketInstances[0].emitClose();

      // Wait for the back-off timer (STREAM_INITIAL_BACKOFF_MS = 250ms by default, but
      // tests run with real timers; we use vi.useFakeTimers to accelerate)
      await new Promise(resolve => setTimeout(resolve, 300));

      // Second socket should have been created
      expect(socketInstances.length).toBeGreaterThanOrEqual(2);

      // Opening the second socket authenticates with the retained cursor.
      const reconnected = socketInstances[socketInstances.length - 1];
      reconnected.emitOpen();
      expect(JSON.parse(reconnected.sent[0])).toEqual({
        type: "authenticate",
        bearer_token: bridgeServiceToken,
        after_cursor: "cursor:live",
      });
      reconnected.emitMessage(JSON.stringify({
        type: "authenticated",
        payload: { audience: "bridge_service", bridge_id: daemon.bridgeId },
      }));
      reconnected.emitMessage(JSON.stringify({
        type: "caught_up",
        payload: { cursor: "cursor:2" },
      }));
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(attachCalls.length).toBeGreaterThan(callsAfterFirstOpen);

      await daemon.stop();
    } finally {
      (globalThis as any).WebSocket = previousWebSocket;
      made.cleanup();
    }
  });

  it("does not reconnect after stop() is called", async () => {
    withoutAdapterEnv();
    const made = makeConfig("fake");
    const previousWebSocket = (globalThis as any).WebSocket;

    const socketInstances: Array<{ emitClose(): void }> = [];

    class FakeWebSocket {
      private listeners = new Map<string, Array<() => void>>();

      constructor() {
        socketInstances.push(this as any);
      }

      addEventListener(event: string, listener: () => void): void {
        const existing = this.listeners.get(event) ?? [];
        existing.push(listener);
        this.listeners.set(event, existing);
      }

      send(): void {}
      close(): void {}

      emitClose(): void {
        for (const l of this.listeners.get("close") ?? []) l();
      }
    }

    (globalThis as any).WebSocket = FakeWebSocket;

    try {
      const daemon = new BridgeDaemon(made.configPath, made.config);
      (daemon as any).bus = {
        async health() {},
        async registerBridge() {},
        async listWorkspaces() { return []; },
        async claimDeliveries() { return []; },
        async reportBridgeLiveness() {}
      };

      await daemon.start();
      expect(socketInstances).toHaveLength(1);

      // Stop cancels the reconnect loop
      await daemon.stop();

      socketInstances[0].emitClose();
      await new Promise(resolve => setTimeout(resolve, 400));

      // Should NOT have created a second socket
      expect(socketInstances).toHaveLength(1);
    } finally {
      (globalThis as any).WebSocket = previousWebSocket;
      made.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// D2 — direct bundle consumption from WS payload (no HTTP round-trip)
// ---------------------------------------------------------------------------

describe("BridgeDaemon – D2 direct bundle consumption from WS payload", () => {
  it("handles a pushed bundle directly without calling claimDeliveries when this bridge owns the endpoint", async () => {
    withoutAdapterEnv();
    const made = makeConfig("fake");
    const previousWebSocket = (globalThis as any).WebSocket;

    let socket: { emitMessage(data: string): void } | undefined;

    class FakeWebSocket {
      private listeners = new Map<string, Array<(event: any) => void>>();

      constructor() { socket = this as any; }

      addEventListener(event: string, listener: (event: any) => void): void {
        const existing = this.listeners.get(event) ?? [];
        existing.push(listener);
        this.listeners.set(event, existing);
      }

      send(): void {}
      close(): void {}

      emitMessage(data: string): void {
        for (const l of this.listeners.get("message") ?? []) l({ data });
      }
    }

    (globalThis as any).WebSocket = FakeWebSocket;

    const claimCalls: number[] = [];
    const handledDeliveries: string[] = [];

    try {
      const daemon = new BridgeDaemon(made.configPath, made.config);

      (daemon as any).bus = {
        async health() {},
        async registerBridge() {},
        async listWorkspaces() { return []; },
        async claimDeliveries() { claimCalls.push(1); return []; },
        async reportDeliveryStatus() {},
        async reportTurnEnd() {},
        async updateEndpointStatus() {},
        async resolveRuntimeBinding() {
          return {
            endpoint_auth_profile: "p", workspace_auth_profile: null, global_auth_profile: null,
            endpoint_model: null, workspace_model: null, global_model: null,
            endpoint_thinking_level: null, workspace_thinking_level: null, global_thinking_level: null
          };
        }
      };

      // Register the endpoint so the bridge "owns" it
      (daemon as any).endpointRuntime.set("actor:workspace:test:agent1", {
        config: { auth_profile: "p", provider: "fake", model: "fake" },
        instructions: "",
        workspace_locator: undefined,
        agent_id: "agent1"
      });

      // Capture handleDelivery calls
      (daemon as any).handleDelivery = async (d: any) => {
        handledDeliveries.push(d.delivery_id);
        // Don't actually invoke the full delivery pipeline in this unit test
      };

      await daemon.start();
      socket?.emitMessage(JSON.stringify({
        type: "authenticated",
        payload: { audience: "bridge_service", bridge_id: daemon.bridgeId, cursor: "cursor:direct" },
      }));
      await new Promise(resolve => setTimeout(resolve, 0));
      const claimsAfterStart = claimCalls.length;

      const bundle = {
        delivery_id: "del-direct-1",
        endpoint_id: "actor:workspace:test:agent1",
        workspace_id: "workspace:test",
        trigger_event_id: "evt:1",
        events: [],
        delivered_at: new Date().toISOString()
      };

      socket?.emitMessage(JSON.stringify({
        type: "delivery_bundle_available",
        payload: { delivery: bundle }
      }));

      await new Promise(resolve => setTimeout(resolve, 10));

      // handleDelivery should have been called directly
      expect(handledDeliveries).toContain("del-direct-1");
      // claimDeliveries should NOT have been called for this owned bundle
      expect(claimCalls.length).toBe(claimsAfterStart);

      await daemon.stop();
    } finally {
      (globalThis as any).WebSocket = previousWebSocket;
      made.cleanup();
    }
  });

  it("falls back to processDeliveries when the endpoint is not owned by this bridge", async () => {
    withoutAdapterEnv();
    const made = makeConfig("fake");
    const previousWebSocket = (globalThis as any).WebSocket;

    let socket: { emitMessage(data: string): void } | undefined;

    class FakeWebSocket {
      private listeners = new Map<string, Array<(event: any) => void>>();

      constructor() { socket = this as any; }

      addEventListener(event: string, listener: (event: any) => void): void {
        const existing = this.listeners.get(event) ?? [];
        existing.push(listener);
        this.listeners.set(event, existing);
      }

      send(): void {}
      close(): void {}

      emitMessage(data: string): void {
        for (const l of this.listeners.get("message") ?? []) l({ data });
      }
    }

    (globalThis as any).WebSocket = FakeWebSocket;

    const claimCalls: number[] = [];

    try {
      const daemon = new BridgeDaemon(made.configPath, made.config);

      (daemon as any).bus = {
        async health() {},
        async registerBridge() {},
        async listWorkspaces() { return []; },
        async claimDeliveries() { claimCalls.push(1); return []; },
      };

      await daemon.start();
      socket?.emitMessage(JSON.stringify({
        type: "authenticated",
        payload: { audience: "bridge_service", bridge_id: daemon.bridgeId, cursor: "cursor:fallback" },
      }));
      await new Promise(resolve => setTimeout(resolve, 0));
      const claimsAfterStart = claimCalls.length;

      // endpoint NOT in endpointRuntime → fallback path
      socket?.emitMessage(JSON.stringify({
        type: "delivery_bundle_available",
        payload: { delivery: {
          delivery_id: "del-other-bridge",
          endpoint_id: "actor:workspace:other:agent2",
          workspace_id: "workspace:other",
          trigger_event_id: "evt:2",
          events: [],
          delivered_at: new Date().toISOString()
        } }
      }));

      await new Promise(resolve => setTimeout(resolve, 10));

      // Should have triggered processDeliveries (HTTP claim fallback)
      expect(claimCalls.length).toBeGreaterThan(claimsAfterStart);

      await daemon.stop();
    } finally {
      (globalThis as any).WebSocket = previousWebSocket;
      made.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Authenticated WS handshake: the credential is the first frame
// ---------------------------------------------------------------------------

describe("BridgeDaemon – authenticated WS first frame", () => {
  it("sends only the credential and retained cursor, not caller identity", async () => {
    withoutAdapterEnv();
    const made = makeConfig("fake");
    const previousWebSocket = (globalThis as any).WebSocket;

    const sentMessages: string[] = [];
    let openListener: (() => void) | undefined;

    class FakeWebSocket {
      private listeners = new Map<string, Array<(event?: any) => void>>();

      constructor() {}

      addEventListener(event: string, listener: (event?: any) => void): void {
        const existing = this.listeners.get(event) ?? [];
        existing.push(listener);
        this.listeners.set(event, existing);
        if (event === "open") openListener = listener;
      }

      send(data: string): void { sentMessages.push(data); }
      close(): void {}
    }

    (globalThis as any).WebSocket = FakeWebSocket;

    try {
      const daemon = new BridgeDaemon(made.configPath, made.config);
      (daemon as any).bus = {
        async health() {},
        async registerBridge() {},
        async listWorkspaces() { return []; },
        async claimDeliveries() { return []; },
      };

      await daemon.start();

      // Trigger the open event
      openListener?.();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(sentMessages).toHaveLength(1);
      const authMessage = JSON.parse(sentMessages[0]);
      expect(authMessage).toEqual({
        type: "authenticate",
        bearer_token: bridgeServiceToken,
      });
      expect(authMessage).not.toHaveProperty("bridge_id");
      expect(authMessage).not.toHaveProperty("workspace_id");

      await daemon.stop();
    } finally {
      (globalThis as any).WebSocket = previousWebSocket;
      made.cleanup();
    }
  });
});

describe("BridgeDaemon – node instructions binding injection", () => {
  it("injects an actor node's instructions binding as a BeforeTurn hook result, scoped to that endpoint+context", async () => {
    const made = makeConfig("fake");
    try {
      const daemon = new BridgeDaemon(made.configPath, made.config);
      (daemon as any).nodeInstructionBindings.set("actor:writer:ctx_1", "Draft docs for the landed note.");

      const hookRegistry = new HookRegistry();
      (daemon as any).registerNodeInstructionsHook(hookRegistry);

      const results = await hookRegistry.fire("BeforeTurn", {
        endpoint_id: "actor:writer",
        workspace_id: "workspace:test",
        delivery_id: "del-1",
        trigger_event_id: "evt:1",
        origin: { id: "ctx_1", kind: "context" }
      } as HookPayload<"BeforeTurn">);

      expect(results).toEqual([
        { inject: { source: "node_instructions:actor:writer", content: "Draft docs for the landed note." } }
      ]);
    } finally {
      made.cleanup();
    }
  });

  it("does not inject for an endpoint+context pair with no bound node instructions", async () => {
    const made = makeConfig("fake");
    try {
      const daemon = new BridgeDaemon(made.configPath, made.config);
      (daemon as any).nodeInstructionBindings.set("actor:writer:ctx_1", "Draft docs for the landed note.");

      const hookRegistry = new HookRegistry();
      (daemon as any).registerNodeInstructionsHook(hookRegistry);

      const results = await hookRegistry.fire("BeforeTurn", {
        endpoint_id: "actor:reviewer",
        workspace_id: "workspace:test",
        delivery_id: "del-2",
        trigger_event_id: "evt:2",
        origin: { id: "ctx_1", kind: "context" }
      } as HookPayload<"BeforeTurn">);

      expect(results).toEqual([]);
    } finally {
      made.cleanup();
    }
  });
});
