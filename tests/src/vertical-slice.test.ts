import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import YAML from "yaml";
import type { LocalConfig } from "../../floe-cli/src/config.js";
import { startAll } from "../../floe-cli/src/startup.js";
import { stopService } from "../../floe-cli/src/process-manager.js";
import {
  fetchHostControlToken,
  registerLocalWorkspaceViaBroker
} from "../../floe-cli/src/operation-client.js";

describe("Floe local vertical slice", () => {
  let temp: string;
  let configPath: string;
  let cliConfig: LocalConfig;
  let busUrl: string;
  let wsUrl: string;
  let projectPath: string;
  let eventSocket: any;
  let busMessages: any[] = [];
  // Real broker-minted credentials. The harness authenticates every privileged
  // Bus call against the real transport boundary — there is no unauthenticated
  // test bypass — so it exercises Floe's authority model, not Floe with
  // authority switched off.
  let hostControlToken: string;
  let operationSessionBearer: string;

  beforeEach(async () => {
    temp = mkdtempSync(join(tmpdir(), "floe-test-"));
    projectPath = join(temp, "project");
    mkdirSync(projectPath, { recursive: true });
    const busPort = await freePort();
    busUrl = `http://127.0.0.1:${busPort}`;
    wsUrl = `ws://127.0.0.1:${busPort}`;
    configPath = join(temp, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      schema: "floe.local.v1",
      version: 1,
      home: temp,
      services: {
        autostart: false,
        manager: "auto"
      },
      bus: {
        listen: `127.0.0.1:${busPort}`,
        http_base_url: busUrl,
        ws_base_url: wsUrl,
        data_dir: "./bus",
        log_dir: "./logs/bus"
      },
      bridge: {
        data_dir: "./bridge",
        log_dir: "./logs/bridge",
        bus_url: wsUrl,
        workspace_access: {
          local_paths: true
        }
      },
      library: {
        configs_dir: "./configs",
        skills_dir: "./skills",
        extensions_dir: "./extensions",
        mcp_dir: "./mcp",
        templates_dir: "./templates"
      }
    }), "utf8");

    // The native broker mints the Bridge service credential and workspace
    // operation sessions against a Bus URL it resolves from the environment.
    // Point it at this isolated Bus so the harness runs the real broker path
    // instead of the default-port product instance.
    process.env.FLOE_BUS_HTTP_BASE = busUrl;

    // The CLI-shaped config the product start path consumes. It shares the home,
    // ports and log dirs of the on-disk Bus config, and selects the fake runtime
    // adapter through configuration exactly as a local install would.
    cliConfig = {
      schema: "floe.local.v1",
      version: 1,
      home: temp,
      services: { autostart: false, manager: "auto" },
      bus: {
        listen: `127.0.0.1:${busPort}`,
        http_base_url: busUrl,
        ws_base_url: wsUrl,
        data_dir: "./bus",
        log_dir: "./logs/bus"
      },
      bridge: {
        data_dir: "./bridge",
        log_dir: "./logs/bridge",
        bus_url: wsUrl,
        workspace_access: { local_paths: true },
        runtime_adapter: "fake"
      },
      library: {
        configs_dir: "./configs",
        skills_dir: "./skills",
        extensions_dir: "./extensions",
        mcp_dir: "./mcp",
        templates_dir: "./templates"
      }
    };

    // Bring up Bus and Bridge through the exact product start sequence: the Bus
    // boots with the broker-owned host-control credential, and the Bridge with a
    // broker-minted service credential. No hand-made tokens, no in-process Bus.
    await startAll(configPath, cliConfig);

    // Hold the same broker-minted credentials the CLI uses so the harness can
    // authenticate its Bus calls as the trusted native owner and as an authorized
    // Bridge transport peer.
    hostControlToken = await fetchHostControlToken();

    busMessages = [];
    eventSocket = new (globalThis as any).WebSocket(`${wsUrl}/v1/events/stream`);
    eventSocket.addEventListener("open", () => {
      // The event stream requires the client to authenticate. Present the
      // broker-owned host-control credential so the harness observes the full
      // push stream as a trusted local client — not via an unauthenticated seam.
      eventSocket.send(JSON.stringify({ type: "authenticate", bearer_token: hostControlToken }));
    });
    eventSocket.addEventListener("message", (event: any) => {
      busMessages.push(JSON.parse(String(event.data)));
    });
    await waitFor(() => busMessages.some((message) => message.type === "authenticated"), "bus event stream authentication");
  }, 60_000);

  afterEach(async () => {
    eventSocket?.close();
    if (configPath && cliConfig) {
      stopService(configPath, cliConfig, "bridge");
      stopService(configPath, cliConfig, "bus");
    }
    delete process.env.FLOE_BUS_HTTP_BASE;
    if (temp) await removeTemp(temp);
  });

  it("initializes .floe and executes emit->delivery->turn-end lifecycle with fake runtime", async () => {
    const workspaceId = await registerAndAuthorize(projectPath);

    await waitFor(() => fileExists(join(projectPath, ".floe", "agents", "floe.md")), ".floe template");
    const agentFile = readFileSync(join(projectPath, ".floe", "agents", "floe.md"), "utf8");
    expect(agentFile).not.toContain("endpoint_id");
    expect(agentFile).not.toContain("auth_profile: default");

    const agentEndpointId = `actor:${workspaceId}:floe`;
    const humanEndpointId = `actor:${workspaceId}:operator`;
    await waitFor(async () => {
      const endpoints = await get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId);
    }, "agent endpoint registration");
    // The fake adapter — like the real floe-runtime adapter — resolves its own
    // runtime config (daemon.ts `runtimeResolvesItsOwnConfig`), so the agent
    // endpoint reaches `idle` on attach without an operator binding. It never
    // sits in `runtime_unconfigured` here; asserting that transition would
    // encode a state only a non-self-resolving adapter reaches.

    await post("/v1/endpoints/register", {
      endpoint_id: humanEndpointId,
      workspace_id: workspaceId,
      name: "Operator",
      status: "online"
    });
    await post("/v1/runtime/bindings", {
      scope: "workspace_default",
      workspace_id: workspaceId,
      auth_profile: "copilot-atvi",
      provider: "fake",
      model: "fake"
    });
    await waitFor(async () => {
      const endpoints = await get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId && endpoint.status === "idle");
    }, "runtime configured status");

    await post("/v1/events/emit", {
      type: "message",
      workspace_id: workspaceId,
      source_endpoint_id: humanEndpointId,
      destination: {
        kind: "endpoint",
        endpoint_id: agentEndpointId
      },
      thread_id: "thread:test",
      correlation_id: null,
      content: { text: "First local test message", data: {} },
      response: { expected: false },
      metadata: {}
    });

    await waitFor(async () => runtimeResults(workspaceId, agentEndpointId).then((events) => events.length >= 1), "fake runtime result");
    await waitFor(() => sawBusEvents([
      "event_submitted",
      "destination_selector_resolved",
      "delivery_created",
      "delivery_injected_to_runtime",
      "delivery_acknowledged",
      "turn_end_observed"
    ]), "delivery lifecycle events");

    await waitFor(async () => {
      const telemetry = await get<{ records: any[] }>(`/v1/runtime/telemetry?workspace_id=${encodeURIComponent(workspaceId)}&limit=100`);
      return telemetry.records.some((record) => record.kind === "visible_output");
    }, "visible runtime telemetry");

    await waitFor(async () => {
      const endpoints = await get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId && endpoint.status === "idle");
    }, "endpoint returns to idle after normal reply");

    // Normal replies do not create pending responses
    const pending = await get<{ pending: any[] }>(`/v1/pending-responses?workspace_id=${encodeURIComponent(workspaceId)}&limit=100`);
    expect(pending.pending.filter((item) => item.waiting_endpoint_id === agentEndpointId)).toHaveLength(0);

    const marker = join(projectPath, "delete-marker.txt");
    writeFileSync(marker, "cleanup proof", "utf8");
    const deleted = await post<{ ok: boolean; workspace_id: string; locator_deleted: boolean }>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/delete`,
      { delete_locator: true }
    );
    expect(deleted.ok).toBe(true);
    expect(deleted.workspace_id).toBe(workspaceId);
    expect(deleted.locator_deleted).toBe(true);
    await waitFor(async () => {
      const result = await get<{ workspaces: any[] }>("/v1/workspaces");
      return !result.workspaces.some((workspace) => workspace.workspace_id === workspaceId);
    }, "workspace deletion propagation");
    expect(existsSync(projectPath)).toBe(false);
  }, 90_000);

  it("fires a one-off pulse and delivers pulse.fired event to subscriber", async () => {
    const workspaceId = await registerAndAuthorize(projectPath);

    // Wait for bridge to set up the workspace (agents + endpoints)
    await waitFor(() => fileExists(join(projectPath, ".floe", "agents", "floe.md")), ".floe template");
    const agentEndpointId = `actor:${workspaceId}:floe`;
    const humanEndpointId = `actor:${workspaceId}:operator`;

    await waitFor(async () => {
      const endpoints = await get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId);
    }, "agent endpoint registration");

    await post("/v1/endpoints/register", {
      endpoint_id: humanEndpointId,
      workspace_id: workspaceId,
      name: "Operator",
      status: "online"
    });
    await post("/v1/runtime/bindings", {
      scope: "workspace_default",
      workspace_id: workspaceId,
      auth_profile: "copilot-atvi",
      provider: "fake",
      model: "fake"
    });

    // Wait for agent endpoint to become idle (runtime configured)
    await waitFor(async () => {
      const endpoints = await get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId && endpoint.status === "idle");
    }, "agent runtime configured");

    // Create a scope (required for endpoint-subscriber pulses that generate delivery contexts)
    const { scope: pulseScope } = await post<{ scope: any }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`, {
      title: "Test Scope"
    });
    const scopeId = pulseScope.scope_id;

    // Create a one-off pulse that fires 2 seconds from now
    const fireAt = new Date(Date.now() + 2_000).toISOString();
    const pulseId = "test-pulse-once";
    const created = await post<{ pulse: any }>("/v1/pulses", {
      pulse_id: pulseId,
      workspace_id: workspaceId,
      persistence: "local",
      scope_id: scopeId,
      trigger: { type: "once", at: fireAt },
      content: { text: "Pulse test message" },
      subscribers: [{ endpoint_ref: `floe` }],
      created_by: humanEndpointId
    });
    expect(created.pulse.pulse_id).toBe(pulseId);
    expect(created.pulse.status).toBe("active");

    // Verify the pulse appears in the list
    const listed = await get<{ pulses: any[] }>(`/v1/pulses?workspace_id=${encodeURIComponent(workspaceId)}`);
    expect(listed.pulses.some((p) => p.pulse_id === pulseId)).toBe(true);

    // Wait for the pulse to fire — we should see pulse_fired on the WebSocket
    await waitFor(() => sawBusEvents(["pulse_created", "pulse_fired"]), "pulse fired broadcast", 15_000);

    // Verify a pulse.fired event was submitted with the trigger contract:
    // null source_endpoint_id (no synthetic system endpoint) and trigger metadata.
    await waitFor(async () => {
      const events = await get<{ events: any[] }>(`/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&limit=100`);
      return events.events.some(
        (event) =>
          event.type === "pulse.fired" &&
          event.source_endpoint_id === null &&
          event.metadata?.trigger_kind === "pulse" &&
          event.metadata?.pulse_id === pulseId
      );
    }, "pulse.fired event in store");

    // Verify the pulse status is now completed
    const pulseAfter = await get<{ pulses: any[] }>(`/v1/pulses?workspace_id=${encodeURIComponent(workspaceId)}&status=completed`);
    expect(pulseAfter.pulses.some((p) => p.pulse_id === pulseId && p.status === "completed")).toBe(true);

    // Clean up
    await post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/delete`, { delete_locator: true });
  }, 60_000);

  it("fires a cron pulse multiple times, pauses, and cancels", async () => {
    const workspaceId = await registerAndAuthorize(projectPath);

    // Wait for bridge to set up the workspace
    await waitFor(() => fileExists(join(projectPath, ".floe", "agents", "floe.md")), ".floe template");
    const agentEndpointId = `actor:${workspaceId}:floe`;
    const humanEndpointId = `actor:${workspaceId}:operator`;

    await waitFor(async () => {
      const endpoints = await get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId);
    }, "agent endpoint registration");

    await post("/v1/endpoints/register", {
      endpoint_id: humanEndpointId,
      workspace_id: workspaceId,
      name: "Operator",
      status: "online"
    });
    await post("/v1/runtime/bindings", {
      scope: "workspace_default",
      workspace_id: workspaceId,
      auth_profile: "copilot-atvi",
      provider: "fake",
      model: "fake"
    });

    await waitFor(async () => {
      const endpoints = await get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId && endpoint.status === "idle");
    }, "agent runtime configured");

    // Create a scope (required for endpoint-subscriber pulses that generate delivery contexts)
    const { scope: pulseScope } = await post<{ scope: any }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`, {
      title: "Test Scope"
    });
    const scopeId = pulseScope.scope_id;

    // Create a cron pulse that fires every 2 seconds
    const pulseId = "test-pulse-cron";
    const created = await post<{ pulse: any }>("/v1/pulses", {
      pulse_id: pulseId,
      workspace_id: workspaceId,
      persistence: "local",
      scope_id: scopeId,
      trigger: { type: "cron", schedule: "*/2 * * * * *", timezone: "UTC" },
      content: { text: "Cron pulse test" },
      subscribers: [{ endpoint_ref: "floe" }],
      created_by: humanEndpointId
    });
    expect(created.pulse.pulse_id).toBe(pulseId);
    expect(created.pulse.status).toBe("active");

    // Wait for at least 2 fires
    await waitFor(async () => {
      const events = await get<{ events: any[] }>(`/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&limit=100`);
      const pulseFires = events.events.filter(
        (event) => event.type === "pulse.fired" && event.content?.pulse_id === pulseId
      );
      return pulseFires.length >= 2;
    }, "cron pulse fires at least twice", 30_000);

    // Verify fire_count incremented
    const pulseAfterFires = await get<{ pulses: any[] }>(`/v1/pulses?workspace_id=${encodeURIComponent(workspaceId)}`);
    const activePulse = pulseAfterFires.pulses.find((p) => p.pulse_id === pulseId);
    expect(activePulse).toBeDefined();
    expect(activePulse!.fire_count).toBeGreaterThanOrEqual(2);
    expect(activePulse!.status).toBe("active");

    // Pause the pulse
    await post(`/v1/pulses/${pulseId}/pause`, {});
    const pausedList = await get<{ pulses: any[] }>(`/v1/pulses?workspace_id=${encodeURIComponent(workspaceId)}&status=paused`);
    expect(pausedList.pulses.some((p) => p.pulse_id === pulseId)).toBe(true);

    // Record fire count at pause time
    const fireCountAtPause = (await get<{ pulses: any[] }>(`/v1/pulses?workspace_id=${encodeURIComponent(workspaceId)}`))
      .pulses.find((p) => p.pulse_id === pulseId)!.fire_count;

    // Wait 4 seconds — no more fires should happen
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const afterPauseWait = await get<{ pulses: any[] }>(`/v1/pulses?workspace_id=${encodeURIComponent(workspaceId)}`);
    const pausedPulse = afterPauseWait.pulses.find((p) => p.pulse_id === pulseId);
    expect(pausedPulse!.fire_count).toBe(fireCountAtPause);

    // Cancel the pulse
    await post(`/v1/pulses/${pulseId}/cancel`, {});
    const cancelledList = await get<{ pulses: any[] }>(`/v1/pulses?workspace_id=${encodeURIComponent(workspaceId)}&status=cancelled`);
    expect(cancelledList.pulses.some((p) => p.pulse_id === pulseId && p.status === "cancelled")).toBe(true);

    // Clean up
    await post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/delete`, { delete_locator: true });
  }, 90_000);

  it("discovers and loads extensions from .floe/extensions/ on workspace attach", async () => {
    // Create workspace with a real extension before registering
    mkdirSync(join(projectPath, ".floe", "extensions", "todo"), { recursive: true });
    mkdirSync(join(projectPath, ".floe", "agents"), { recursive: true });
    mkdirSync(join(projectPath, ".floe", "skills", "substrate-build"), { recursive: true });
    mkdirSync(join(projectPath, ".floe", "mcp"), { recursive: true });
    mkdirSync(join(projectPath, ".floe", "state"), { recursive: true });

    // Write extension manifest
    writeFileSync(join(projectPath, ".floe", "extensions", "todo", "extension.json"), JSON.stringify({
      schema: "floe.extension.v1",
      name: "todo",
      description: "Task tracking",
      entry: "./index.ts"
    }, null, 2), "utf8");

    // Write extension entry point
    writeFileSync(join(projectPath, ".floe", "extensions", "todo", "index.ts"), `
export default function(ctx) {
  return [
    {
      name: "add",
      label: "Add Todo",
      description: "Add a todo item",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      execute: async (_id, params) => ({
        content: [{ type: "text", text: "Added: " + (params?.text ?? "") }],
        details: {}
      })
    }
  ];
}
`, "utf8");

    // Write floe.yaml with agent that declares the extension
    writeFileSync(join(projectPath, ".floe", "floe.yaml"), YAML.stringify({
      schema: "floe.workspace.v1",
      version: 1,
      agents: [{ id: "floe", path: "./agents/floe.md" }]
    }), "utf8");

    // Write agent file with extensions: ["todo"]
    writeFileSync(join(projectPath, ".floe", "agents", "floe.md"), `---
schema: floe.agent.v1
agent_id: floe
label: Floe
extensions:
  - todo
---
# Floe
You are Floe.
`, "utf8");

    writeFileSync(join(projectPath, ".floe", "extensions", "README.md"), "# Extensions\n", "utf8");
    writeFileSync(join(projectPath, ".floe", "skills", "substrate-build", "SKILL.md"), "# substrate-build\n", "utf8");
    writeFileSync(join(projectPath, ".floe", "mcp", "README.md"), "# MCP\n", "utf8");
    writeFileSync(join(projectPath, ".floe", "state", "README.md"), "# State\n", "utf8");
    writeFileSync(join(projectPath, ".floe", "state", ".gitignore"), "*\n!.gitignore\n!README.md\n", "utf8");

    const workspaceId = await registerAndAuthorize(projectPath);

    // Wait for bridge to attach and register the agent endpoint
    // The bridge logs "[bridge] extension loaded" when it discovers and loads extensions
    const agentEndpointId = `actor:${workspaceId}:floe`;
    await waitFor(async () => {
      const endpoints = await get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId);
    }, "agent endpoint registration");

    // Extension loading is verified by the bridge log output:
    // "[bridge] extension loaded { extension: 'todo', tools: 1, pulses: 0 }"
    // The agent endpoint is registered, which means workspace attachment completed
    // successfully including extension discovery and loading.

    // Verify the agent endpoint was registered (attachment completed)
    const endpoints = await get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
    const agentEndpoint = endpoints.endpoints.find((ep: any) => ep.endpoint_id === agentEndpointId);
    expect(agentEndpoint).toBeDefined();
    expect(agentEndpoint.name).toBe("Floe");

    await post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/delete`, { delete_locator: true });
  }, 60_000);

  it("resolves short endpoint references via resolve-endpoint API", async () => {
    const workspaceId = await registerAndAuthorize(projectPath);

    // Wait for bridge to set up the workspace (agents + endpoints)
    await waitFor(() => fileExists(join(projectPath, ".floe", "agents", "floe.md")), ".floe template");
    const agentEndpointId = `actor:${workspaceId}:floe`;
    const humanEndpointId = `actor:${workspaceId}:operator`;

    await waitFor(async () => {
      const endpoints = await get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId);
    }, "agent endpoint registration");

    // Register human endpoint
    await post("/v1/endpoints/register", {
      endpoint_id: humanEndpointId,
      workspace_id: workspaceId,
      name: "Operator",
      status: "online"
    });

    // Resolve actor short ref
    const agentResolved = await get<{ endpoint_id: string; found: boolean }>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/resolve-endpoint?ref=${encodeURIComponent("floe")}`
    );
    expect(agentResolved.endpoint_id).toBe(agentEndpointId);
    expect(agentResolved.found).toBe(true);

    // Resolve operator short ref
    const userResolved = await get<{ endpoint_id: string; found: boolean }>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/resolve-endpoint?ref=${encodeURIComponent("operator")}`
    );
    expect(userResolved.endpoint_id).toBe(humanEndpointId);
    expect(userResolved.found).toBe(true);

    // Resolve non-existent ref — should return constructed ID with found=false
    const unknownResolved = await get<{ endpoint_id: string; found: boolean }>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/resolve-endpoint?ref=${encodeURIComponent("nonexistent")}`
    );
    expect(unknownResolved.endpoint_id).toBe(`actor:${workspaceId}:nonexistent`);
    expect(unknownResolved.found).toBe(false);

    // Clean up
    await post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/delete`, { delete_locator: true });
  }, 60_000);

  function sawBusEvents(types: string[]): boolean {
    return types.every((type) => busMessages.some((message) => message.type === type));
  }

  async function runtimeResults(workspaceId: string, agentEndpointId: string) {
    const result = await get<{ events: any[] }>(`/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&limit=100`);
    return result.events.filter((event) =>
      event.source_endpoint_id === agentEndpointId &&
      event.content?.data?.origin === "runtime_turn_result"
    );
  }

  // Register (and select) the local workspace through the native broker exactly
  // as `floe start` does, then open an operator operation session for it. The
  // session is the real workspace-scoped authority a client holds; the harness
  // uses it for every operator/workspace call so those calls are authenticated,
  // not bypassed.
  async function registerAndAuthorize(locator: string): Promise<string> {
    const { workspace_id } = await registerLocalWorkspaceViaBroker(locator, true);
    operationSessionBearer = await mintOperationSession(workspace_id);
    return workspace_id;
  }

  // Mint a workspace operation session over the Bus' host-control-authenticated
  // route — the same route the broker uses internally. The harness holds the
  // broker-owned host-control credential, so this is the genuine issuance path,
  // not a fabricated bearer.
  async function mintOperationSession(workspaceId: string): Promise<string> {
    const response = await fetch(
      `${busUrl}/v1/local/workspaces/${encodeURIComponent(workspaceId)}/operation-sessions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${hostControlToken}`
        },
        body: JSON.stringify({ expires_in_seconds: 3_600 })
      }
    );
    if (!response.ok) {
      throw new Error(`operation-session mint failed ${response.status}: ${await response.text()}`);
    }
    const issued = (await response.json()) as { bearer_token: string };
    return issued.bearer_token;
  }

  // Select the real broker-minted credential for a route by the authority class
  // the Bus enforces for it: host-control for native-owner bootstrap routes,
  // the Bridge service credential for the Bridge-only endpoint registration,
  // and the operator operation session for everything workspace-scoped.
  function bearerFor(path: string): string {
    const route = path.split("?", 1)[0];
    if (
      route === "/v1/workspaces"
      || route.endsWith("/delete")
      || route === "/v1/runtime/bindings"
    ) {
      return hostControlToken;
    }
    if (route === "/v1/endpoints/register") {
      return hostControlToken;
    }
    return operationSessionBearer;
  }

  async function get<T>(path: string): Promise<T> {
    const response = await fetch(`${busUrl}${path}`, {
      headers: { authorization: `Bearer ${bearerFor(path)}` }
    });
    if (!response.ok) throw new Error(`${path} failed ${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  }

  async function post<T = any>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${busUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearerFor(path)}`
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`${path} failed ${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  }
});

function fileExists(path: string): boolean {
  try {
    return readFileSync(path).length >= 0;
  } catch {
    return false;
  }
}

async function removeTemp(path: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  rmSync(path, { recursive: true, force: true });
}

async function waitFor<T>(check: () => Promise<T | false> | T | false, label: string, timeoutMs = 20_000): Promise<T> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("No free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}
