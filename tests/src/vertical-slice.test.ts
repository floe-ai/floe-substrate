import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { SliceHarness, fileExists, waitFor, type SliceTier } from "./slice-harness.js";
import {
  LIVE_TIER_MODEL,
  LIVE_TIER_DISABLED,
  announceLiveTierDisabled,
  assertLiveRuntimeReady
} from "./live-runtime.js";
import { assertExactLiveToolEvidence, type LiveToolCase } from "./live-evidence.js";

// The fake tier proves the full substrate lifecycle without a provider. The
// live tier below isolates each required SDK tool callback so one case cannot
// accidentally satisfy the other.
const FAKE_TIER: SliceTier = { id: "fake", adapter: "fake", provider: "fake", model: "fake", live: false };
const LIVE_TIER: SliceTier = { id: "live-copilot", adapter: "floe-runtime", provider: "copilot", model: LIVE_TIER_MODEL, live: true };

// The provider-free core lifecycle always runs.
for (const tier of [FAKE_TIER]) {
  const disabled = tier.live && LIVE_TIER_DISABLED;
  if (disabled) announceLiveTierDisabled();
  const declare = disabled ? describe.skip : describe;

  declare(`vertical slice core lifecycle [${tier.id}]`, () => {
    const h = new SliceHarness(tier);

    beforeEach(async () => {
      // Loud pre-flight: if the live tier cannot reach an authenticated vendor
      // CLI (and was not deliberately disabled), fail here with an actionable
      // message rather than starting the Bus only to time out later.
      if (tier.live) await assertLiveRuntimeReady();
      await h.start();
    }, tier.live ? 120_000 : 60_000);

    afterEach(async () => {
      h.captureEvidence("core-lifecycle");
      await h.stop();
    });

    it("initializes .floe and executes emit->delivery->turn-end lifecycle", async () => {
      const workspaceId = await h.registerAndAuthorize(h.projectPath);

      await waitFor(() => fileExists(join(h.projectPath, ".floe", "agents", "floe.md")), ".floe template");
      const agentFile = readFileSync(join(h.projectPath, ".floe", "agents", "floe.md"), "utf8");
      expect(agentFile).not.toContain("endpoint_id");
      expect(agentFile).not.toContain("auth_profile: default");

      const agentEndpointId = `actor:${workspaceId}:floe`;
      const humanEndpointId = `actor:${workspaceId}:operator`;
      await waitFor(async () => {
        const endpoints = await h.get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
        return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId);
      }, "agent endpoint registration");
      // The fake adapter — like the real floe-runtime adapter — resolves its own
      // runtime config (daemon.ts `runtimeResolvesItsOwnConfig`), so the agent
      // endpoint reaches `idle` on attach without an operator binding. It never
      // sits in `runtime_unconfigured` here; asserting that transition would
      // encode a state only a non-self-resolving adapter reaches.

      await h.post("/v1/endpoints/register", {
        endpoint_id: humanEndpointId,
        workspace_id: workspaceId,
        name: "Operator",
        status: "online"
      });
      await h.post("/v1/runtime/bindings", {
        scope: "workspace_default",
        workspace_id: workspaceId,
        auth_profile: "copilot-atvi",
        provider: tier.provider,
        model: tier.model
      });
      await waitFor(async () => {
        const endpoints = await h.get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
        return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId && endpoint.status === "idle");
      }, "runtime configured status");

      await h.post("/v1/events/emit", {
        type: "message",
        workspace_id: workspaceId,
        source_endpoint_id: humanEndpointId,
        destination: {
          kind: "endpoint",
          endpoint_id: agentEndpointId
        },
        thread_id: "thread:test",
        correlation_id: null,
        content: {
          text: [
            "This is a mandatory direct-tool test. Before writing any response, call `emit`",
            "exactly once with `{ \"type\": \"message\", \"destination\": \"operator\",",
            "\"text\": \"live direct-tool success\" }`. Tool calls are required; text alone",
            "does not complete this task. After the call, reply exactly: tool attempted.",
          ].join(" "),
          data: {},
        },
        response: { expected: false },
        metadata: {}
      });

      await waitFor(async () => h.runtimeResults(workspaceId, agentEndpointId).then((events) => events.length >= 1), "runtime result", tier.live ? 120_000 : 20_000);
      await waitFor(() => h.sawBusEvents([
        "event_submitted",
        "destination_selector_resolved",
        "delivery_created",
        "delivery_injected_to_runtime",
        "delivery_acknowledged",
        "turn_end_observed"
      ]), "delivery lifecycle events", tier.live ? 120_000 : 20_000);

      await waitFor(async () => {
        const telemetry = await h.get<{ records: any[] }>(`/v1/runtime/telemetry?workspace_id=${encodeURIComponent(workspaceId)}&limit=100`);
        return telemetry.records.some((record) => record.kind === "visible_output");
      }, "visible runtime telemetry", tier.live ? 120_000 : 20_000);

      await waitFor(async () => {
        const endpoints = await h.get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
        return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId && endpoint.status === "idle");
      }, "endpoint returns to idle after normal reply", tier.live ? 120_000 : 20_000);

      // Normal replies do not create pending responses
      const pending = await h.get<{ pending: any[] }>(`/v1/pending-responses?workspace_id=${encodeURIComponent(workspaceId)}&limit=100`);
      expect(pending.pending.filter((item) => item.waiting_endpoint_id === agentEndpointId)).toHaveLength(0);

      const marker = join(h.projectPath, "delete-marker.txt");
      writeFileSync(marker, "cleanup proof", "utf8");
      const deleted = await h.post<{ ok: boolean; workspace_id: string; locator_deleted: boolean }>(
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/delete`,
        { delete_locator: true }
      );
      expect(deleted.ok).toBe(true);
      expect(deleted.workspace_id).toBe(workspaceId);
      expect(deleted.locator_deleted).toBe(true);
      await waitFor(async () => {
        const result = await h.get<{ workspaces: any[] }>("/v1/workspaces");
        return !result.workspaces.some((workspace) => workspace.workspace_id === workspaceId);
      }, "workspace deletion propagation");
      expect(existsSync(h.projectPath)).toBe(false);
    }, tier.live ? 180_000 : 90_000);
  });
}

if (LIVE_TIER_DISABLED) announceLiveTierDisabled();
const declareLive = LIVE_TIER_DISABLED ? describe.skip : describe;

declareLive("vertical slice exact Copilot SDK tools [live-copilot]", () => {
  const h = new SliceHarness(LIVE_TIER);

  beforeEach(async () => {
    await assertLiveRuntimeReady();
    await h.start();
  }, 120_000);

  afterEach(async () => {
    await h.stop();
  });

  async function prepareCase(): Promise<{
    workspaceId: string;
    agentEndpointId: string;
    humanEndpointId: string;
  }> {
    const workspaceId = await h.registerAndAuthorize(h.projectPath);
    const agentEndpointId = `actor:${workspaceId}:floe`;
    const humanEndpointId = `actor:${workspaceId}:operator`;
    await waitFor(async () => {
      const { endpoints } = await h.get<{ endpoints: any[] }>(
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`
      );
      return endpoints.some(endpoint => endpoint.endpoint_id === agentEndpointId);
    }, "agent endpoint registration");
    await h.post("/v1/endpoints/register", {
      endpoint_id: humanEndpointId,
      workspace_id: workspaceId,
      name: "Operator",
      status: "online",
    });
    await h.post("/v1/runtime/bindings", {
      scope: "workspace_default",
      workspace_id: workspaceId,
      auth_profile: "copilot-atvi",
      provider: LIVE_TIER.provider,
      model: LIVE_TIER.model,
    });
    await waitFor(async () => {
      const { endpoints } = await h.get<{ endpoints: any[] }>(
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`
      );
      return endpoints.some(endpoint =>
        endpoint.endpoint_id === agentEndpointId && endpoint.status === "idle"
      );
    }, "runtime configured status");
    return { workspaceId, agentEndpointId, humanEndpointId };
  }

  async function runToolCase(caseName: LiveToolCase, prompt: string): Promise<void> {
    const { workspaceId, agentEndpointId, humanEndpointId } = await prepareCase();
    let triggerEventId: string | null = null;
    let evidenceError: unknown;
    try {
      const accepted = await h.post<{ event_id: string }>("/v1/events/emit", {
        type: "message",
        workspace_id: workspaceId,
        source_endpoint_id: humanEndpointId,
        destination: { kind: "endpoint", endpoint_id: agentEndpointId },
        thread_id: `thread:${caseName}`,
        correlation_id: null,
        content: { text: prompt, data: {} },
        response: { expected: false },
        metadata: {},
      });
      triggerEventId = accepted.event_id;
      await waitFor(
        async () => h.runtimeResults(workspaceId, agentEndpointId).then(events => events.length === 1),
        `${caseName} runtime result`,
        120_000
      );
      await waitFor(async () => {
        const { records } = await h.get<{ records: any[] }>(
          `/v1/runtime/telemetry?workspace_id=${encodeURIComponent(workspaceId)}&limit=500`
        );
        return records.some(record => record.kind === "sdk_tool_evidence");
      }, `${caseName} SDK tool evidence`, 120_000);
      await waitFor(
        () => h.sawBusEvents(["delivery_acknowledged"]),
        `${caseName} delivery acknowledgement`,
        120_000
      );
    } catch (error) {
      evidenceError = error;
    } finally {
      if (triggerEventId) {
        const captured = await h.captureLiveToolEvidence({
          case: caseName,
          workspace_id: workspaceId,
          trigger_event_id: triggerEventId,
          trigger_source_endpoint_id: humanEndpointId,
        });
        if (!evidenceError) assertExactLiveToolEvidence(captured.evidence);
      }
    }
    if (evidenceError) throw evidenceError;
    await h.post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/delete`, { delete_locator: true });
  }

  it("records one exact successful emit callback", async () => {
    await runToolCase(
      "emit-success",
      [
        "Call the `emit` tool exactly once with this exact input:",
        "{\"type\":\"message\",\"destination\":\"operator\",\"text\":\"live direct-tool success\"}.",
        "Do not call any other tool. After the tool finishes, reply exactly: tool attempted.",
      ].join(" ")
    );
  }, 180_000);

  it("records one exact denied use_capability callback", async () => {
    await runToolCase(
      "use-capability-denied",
      [
        "Call the `use_capability` tool exactly once with this exact input:",
        "{\"operation_id\":\"command.list\",\"operation_version\":\"1\",",
        "\"input_schema_version\":\"1\",\"input\":{}}.",
        "Do not call any other tool. After the denial, reply exactly: denial observed.",
      ].join(" ")
    );
  }, 180_000);
});

// The remaining slices exercise the Bus pulse engine, extension discovery and
// endpoint resolution. They are adapter-independent, so they run on the fake
// tier only: forcing each pulse fire through a real model turn would be slow,
// costly and timing-fragile without proving anything more about the adapter.
describe("Floe local vertical slice (fake adapter)", () => {
  const h = new SliceHarness(FAKE_TIER);

  beforeEach(async () => {
    await h.start();
  }, 60_000);

  afterEach(async () => {
    await h.stop();
  });

  it("fires a one-off pulse and delivers pulse.fired event to subscriber", async () => {
    const workspaceId = await h.registerAndAuthorize(h.projectPath);

    await waitFor(() => fileExists(join(h.projectPath, ".floe", "agents", "floe.md")), ".floe template");
    const agentEndpointId = `actor:${workspaceId}:floe`;
    const humanEndpointId = `actor:${workspaceId}:operator`;

    await waitFor(async () => {
      const endpoints = await h.get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId);
    }, "agent endpoint registration");

    await h.post("/v1/endpoints/register", {
      endpoint_id: humanEndpointId,
      workspace_id: workspaceId,
      name: "Operator",
      status: "online"
    });
    await h.post("/v1/runtime/bindings", {
      scope: "workspace_default",
      workspace_id: workspaceId,
      auth_profile: "copilot-atvi",
      provider: "fake",
      model: "fake"
    });

    await waitFor(async () => {
      const endpoints = await h.get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId && endpoint.status === "idle");
    }, "agent runtime configured");

    const { scope: pulseScope } = await h.post<{ scope: any }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`, {
      title: "Test Scope"
    });
    const scopeId = pulseScope.scope_id;

    const fireAt = new Date(Date.now() + 2_000).toISOString();
    const pulseId = "test-pulse-once";
    const created = await h.post<{ pulse: any }>("/v1/pulses", {
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

    const listed = await h.get<{ pulses: any[] }>(`/v1/pulses?workspace_id=${encodeURIComponent(workspaceId)}`);
    expect(listed.pulses.some((p) => p.pulse_id === pulseId)).toBe(true);

    await waitFor(() => h.sawBusEvents(["pulse_created", "pulse_fired"]), "pulse fired broadcast", 15_000);

    await waitFor(async () => {
      const events = await h.get<{ events: any[] }>(`/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&limit=100`);
      return events.events.some(
        (event) =>
          event.type === "pulse.fired" &&
          event.source_endpoint_id === null &&
          event.metadata?.trigger_kind === "pulse" &&
          event.metadata?.pulse_id === pulseId
      );
    }, "pulse.fired event in store");

    const pulseAfter = await h.get<{ pulses: any[] }>(`/v1/pulses?workspace_id=${encodeURIComponent(workspaceId)}&status=completed`);
    expect(pulseAfter.pulses.some((p) => p.pulse_id === pulseId && p.status === "completed")).toBe(true);

    await h.post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/delete`, { delete_locator: true });
  }, 60_000);

  it("fires a cron pulse multiple times, pauses, and cancels", async () => {
    const workspaceId = await h.registerAndAuthorize(h.projectPath);

    await waitFor(() => fileExists(join(h.projectPath, ".floe", "agents", "floe.md")), ".floe template");
    const agentEndpointId = `actor:${workspaceId}:floe`;
    const humanEndpointId = `actor:${workspaceId}:operator`;

    await waitFor(async () => {
      const endpoints = await h.get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId);
    }, "agent endpoint registration");

    await h.post("/v1/endpoints/register", {
      endpoint_id: humanEndpointId,
      workspace_id: workspaceId,
      name: "Operator",
      status: "online"
    });
    await h.post("/v1/runtime/bindings", {
      scope: "workspace_default",
      workspace_id: workspaceId,
      auth_profile: "copilot-atvi",
      provider: "fake",
      model: "fake"
    });

    await waitFor(async () => {
      const endpoints = await h.get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId && endpoint.status === "idle");
    }, "agent runtime configured");

    const { scope: pulseScope } = await h.post<{ scope: any }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`, {
      title: "Test Scope"
    });
    const scopeId = pulseScope.scope_id;

    const pulseId = "test-pulse-cron";
    const created = await h.post<{ pulse: any }>("/v1/pulses", {
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

    await waitFor(async () => {
      const events = await h.get<{ events: any[] }>(`/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&limit=100`);
      const pulseFires = events.events.filter(
        (event) => event.type === "pulse.fired" && event.content?.pulse_id === pulseId
      );
      return pulseFires.length >= 2;
    }, "cron pulse fires at least twice", 30_000);

    const pulseAfterFires = await h.get<{ pulses: any[] }>(`/v1/pulses?workspace_id=${encodeURIComponent(workspaceId)}`);
    const activePulse = pulseAfterFires.pulses.find((p) => p.pulse_id === pulseId);
    expect(activePulse).toBeDefined();
    expect(activePulse!.fire_count).toBeGreaterThanOrEqual(2);
    expect(activePulse!.status).toBe("active");

    await h.post(`/v1/pulses/${pulseId}/pause`, {});
    const pausedList = await h.get<{ pulses: any[] }>(`/v1/pulses?workspace_id=${encodeURIComponent(workspaceId)}&status=paused`);
    expect(pausedList.pulses.some((p) => p.pulse_id === pulseId)).toBe(true);

    const fireCountAtPause = (await h.get<{ pulses: any[] }>(`/v1/pulses?workspace_id=${encodeURIComponent(workspaceId)}`))
      .pulses.find((p) => p.pulse_id === pulseId)!.fire_count;

    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const afterPauseWait = await h.get<{ pulses: any[] }>(`/v1/pulses?workspace_id=${encodeURIComponent(workspaceId)}`);
    const pausedPulse = afterPauseWait.pulses.find((p) => p.pulse_id === pulseId);
    expect(pausedPulse!.fire_count).toBe(fireCountAtPause);

    await h.post(`/v1/pulses/${pulseId}/cancel`, {});
    const cancelledList = await h.get<{ pulses: any[] }>(`/v1/pulses?workspace_id=${encodeURIComponent(workspaceId)}&status=cancelled`);
    expect(cancelledList.pulses.some((p) => p.pulse_id === pulseId && p.status === "cancelled")).toBe(true);

    await h.post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/delete`, { delete_locator: true });
  }, 90_000);

  it("discovers and loads extensions from .floe/extensions/ on workspace attach", async () => {
    mkdirSync(join(h.projectPath, ".floe", "extensions", "todo"), { recursive: true });
    mkdirSync(join(h.projectPath, ".floe", "agents"), { recursive: true });
    mkdirSync(join(h.projectPath, ".floe", "skills", "substrate-build"), { recursive: true });
    mkdirSync(join(h.projectPath, ".floe", "mcp"), { recursive: true });
    mkdirSync(join(h.projectPath, ".floe", "state"), { recursive: true });

    writeFileSync(join(h.projectPath, ".floe", "extensions", "todo", "extension.json"), JSON.stringify({
      schema: "floe.extension.v1",
      name: "todo",
      description: "Task tracking",
      entry: "./index.ts"
    }, null, 2), "utf8");

    writeFileSync(join(h.projectPath, ".floe", "extensions", "todo", "index.ts"), `
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

    writeFileSync(join(h.projectPath, ".floe", "floe.yaml"), YAML.stringify({
      schema: "floe.workspace.v1",
      version: 1,
      agents: [{ id: "floe", path: "./agents/floe.md" }]
    }), "utf8");

    writeFileSync(join(h.projectPath, ".floe", "agents", "floe.md"), `---
schema: floe.agent.v1
agent_id: floe
label: Floe
extensions:
  - todo
---
# Floe
You are Floe.
`, "utf8");

    writeFileSync(join(h.projectPath, ".floe", "extensions", "README.md"), "# Extensions\n", "utf8");
    writeFileSync(join(h.projectPath, ".floe", "skills", "substrate-build", "SKILL.md"), "# substrate-build\n", "utf8");
    writeFileSync(join(h.projectPath, ".floe", "mcp", "README.md"), "# MCP\n", "utf8");
    writeFileSync(join(h.projectPath, ".floe", "state", "README.md"), "# State\n", "utf8");
    writeFileSync(join(h.projectPath, ".floe", "state", ".gitignore"), "*\n!.gitignore\n!README.md\n", "utf8");

    const workspaceId = await h.registerAndAuthorize(h.projectPath);

    const agentEndpointId = `actor:${workspaceId}:floe`;
    await waitFor(async () => {
      const endpoints = await h.get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId);
    }, "agent endpoint registration");

    const endpoints = await h.get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
    const agentEndpoint = endpoints.endpoints.find((ep: any) => ep.endpoint_id === agentEndpointId);
    expect(agentEndpoint).toBeDefined();
    expect(agentEndpoint.name).toBe("Floe");

    await h.post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/delete`, { delete_locator: true });
  }, 60_000);

  it("resolves short endpoint references via resolve-endpoint API", async () => {
    const workspaceId = await h.registerAndAuthorize(h.projectPath);

    await waitFor(() => fileExists(join(h.projectPath, ".floe", "agents", "floe.md")), ".floe template");
    const agentEndpointId = `actor:${workspaceId}:floe`;
    const humanEndpointId = `actor:${workspaceId}:operator`;

    await waitFor(async () => {
      const endpoints = await h.get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId);
    }, "agent endpoint registration");

    await h.post("/v1/endpoints/register", {
      endpoint_id: humanEndpointId,
      workspace_id: workspaceId,
      name: "Operator",
      status: "online"
    });

    const agentResolved = await h.get<{ endpoint_id: string; found: boolean }>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/resolve-endpoint?ref=${encodeURIComponent("floe")}`
    );
    expect(agentResolved.endpoint_id).toBe(agentEndpointId);
    expect(agentResolved.found).toBe(true);

    const userResolved = await h.get<{ endpoint_id: string; found: boolean }>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/resolve-endpoint?ref=${encodeURIComponent("operator")}`
    );
    expect(userResolved.endpoint_id).toBe(humanEndpointId);
    expect(userResolved.found).toBe(true);

    const unknownResolved = await h.get<{ endpoint_id: string; found: boolean }>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/resolve-endpoint?ref=${encodeURIComponent("nonexistent")}`
    );
    expect(unknownResolved.endpoint_id).toBe(`actor:${workspaceId}:nonexistent`);
    expect(unknownResolved.found).toBe(false);

    await h.post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/delete`, { delete_locator: true });
  }, 60_000);
});
