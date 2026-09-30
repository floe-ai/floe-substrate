import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { defaultConfig } from "./config.js";
import { createBusServer } from "./server.js";
import { emitViaRoute } from "./test-support/emit-via-route.js";
import { registerExecutableActorFixture } from "./executable-actor-test-fixture.js";
import { INSPECT_RUNTIME_DELIVERY_OPERATION_ID } from "./runtime-turn-inspection.js";
import type { RuntimeToolCallRequest } from "./runtime-tool-policy.js";

const WS = "workspace:turn-inspection";
const ACTOR = "actor:turn-inspection:builder";
const OPERATOR = "actor:turn-inspection:operator";
const BRIDGE = "bridge:turn-inspection";
const noop = () => {};

describe("runtime.delivery.inspect", () => {
  let handle: Awaited<ReturnType<typeof createBusServer>>;
  let tmp: string;
  let home: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "floe-turn-inspection-"));
    const cfgPath = join(tmp, "config.yaml");
    const cfg = defaultConfig(tmp);
    writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
    handle = await createBusServer(cfgPath, cfg, { unsafe_in_process_test_auth_bypass: true });
    await handle.app.ready();
    const at = new Date().toISOString();
    handle.store.workspaceIdentityStore.restoreWorkspace({
      snapshot: { workspace_id: WS, name: "Turns", creation_kind: "created", source_workspace_id: null, created_at: at, updated_at: at },
    });
    home = join(realpathSync.native(tmp), "home");
    mkdirSync(home, { recursive: true });
    handle.store.workspaceIdentityStore.bindLocator(WS, {
      host_id: handle.store.localHostId, platform: process.platform === "win32" ? "windows" : "posix",
      locator: home, init_authorized: true,
    });
    handle.store.db.prepare(`
      INSERT INTO bridges (bridge_id, status, capabilities_json, last_seen_at, created_at)
      VALUES (?, 'online', '{}', ?, ?)
    `).run(BRIDGE, at, at);
    handle.store.registerEndpoint({ endpoint_id: OPERATOR, workspace_id: WS, name: "Operator" }, noop);
    handle.store.registerEndpoint({ endpoint_id: ACTOR, workspace_id: WS, name: "Builder", bridge_id: BRIDGE, status: "idle" }, noop);
    registerExecutableActorFixture(handle.store, WS, ACTOR);
  });

  afterEach(async () => {
    try { await handle.app.close(); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  });

  async function runningDelivery(text: string, actor = ACTOR) {
    await emitViaRoute(handle, {
      type: "message", workspace_id: WS, source_endpoint_id: OPERATOR,
      destination: { kind: "endpoint", endpoint_id: actor }, thread_id: "", correlation_id: null,
      content: { text }, metadata: {}, idempotency_key: null,
    });
    const claimed = handle.store.claimDeliveries(BRIDGE, 1, noop)[0]!;
    handle.store.prepareRuntimeDelivery({ bridge_id: BRIDGE, delivery_id: claimed.delivery_id }, noop);
    handle.store.reportDeliveryStatus({ bridge_id: BRIDGE, delivery_id: claimed.delivery_id, state: "injected_to_runtime" }, noop);
    return claimed.delivery_id;
  }

  const shell = (toolCallId: string): RuntimeToolCallRequest => ({
    operation_id: "engine.tool.process.execute", tool_call_id: toolCallId, engine: "copilot",
    manifest_version: "copilot-cli-1.0.83-win32-v2", native_tools: ["powershell"], paths: [], executables: ["git"],
    urls: [], write_redirection: false, sandbox_bypass: false, argument_digest: "a".repeat(64),
  });

  const telemetry = (deliveryId: string, kind: string, payload: Record<string, unknown>) =>
    handle.store.appendRuntimeTelemetry({ workspace_id: WS, endpoint_id: ACTOR, delivery_id: deliveryId, kind, payload }, noop);

  it("shows the model a turn ran on and each tool it used, with Floe's decision and no arguments", async () => {
    const deliveryId = await runningDelivery("check the repo");
    const decision = handle.store.evaluateRuntimeToolCall({ bridge_id: BRIDGE, delivery_id: deliveryId, request: shell("call-1") }, noop);
    telemetry(deliveryId, "tool_activity", { tool_call_id: "call-1", name: "powershell", status: "started", at: "2026-01-01T00:00:01.000Z" });
    telemetry(deliveryId, "tool_activity", { tool_call_id: "call-1", name: "powershell", status: "completed", at: "2026-01-01T00:00:02.000Z" });
    telemetry(deliveryId, "sdk_tool_evidence", { tool_calls: [{ call_id: "call-1", arguments: { command: "git status" } }] });
    telemetry(deliveryId, "usage", { usage: { model: "gpt-5-mini", modelCalls: [{ model: "claude-haiku-4.5" }, { model: "gpt-5-mini" }] } });

    const reviewer = "actor:turn-inspection:reviewer";
    handle.store.registerEndpoint({ endpoint_id: reviewer, workspace_id: WS, name: "Reviewer", bridge_id: BRIDGE, status: "idle" }, noop);
    registerExecutableActorFixture(handle.store, WS, reviewer);
    const other = await runningDelivery("something else", reviewer);
    handle.store.evaluateRuntimeToolCall({ bridge_id: BRIDGE, delivery_id: other, request: shell("call-2") }, noop);

    const inspected = handle.store.inspectRuntimeTurn(WS, deliveryId);
    expect(inspected).toMatchObject({ delivery_id: deliveryId, endpoint_id: ACTOR, model: "gpt-5-mini",
      models: ["claude-haiku-4.5", "gpt-5-mini"] });
    expect(inspected.tools).toEqual([{
      tool_call_id: "call-1", name: "powershell", status: "completed",
      started_at: "2026-01-01T00:00:01.000Z", ended_at: "2026-01-01T00:00:02.000Z",
      operation_id: "engine.tool.process.execute", decision: decision.decision, policy_evaluation_id: decision.evaluation_id,
    }]);
    expect(JSON.stringify(inspected)).not.toContain("git status");
  });

  it("shows no model and no tools for a turn that has not reported any", async () => {
    const deliveryId = await runningDelivery("hello");
    expect(handle.store.inspectRuntimeTurn(WS, deliveryId)).toMatchObject({ model: null, models: [], tools: [] });
    expect(() => handle.store.inspectRuntimeTurn("workspace:other", deliveryId)).toThrow(/unavailable in this Workspace/);
  });

  it("is a read operation a person's session holds", () => {
    const operations = handle.store.operationRegistry.listCurrentOperationMetadata({ interaction_mode: "interactive", boundary_kind: "workspace" });
    expect(operations.find((operation) => operation.operation_id === INSPECT_RUNTIME_DELIVERY_OPERATION_ID))
      .toMatchObject({ effects: { mode: "read" } });
  });
});
