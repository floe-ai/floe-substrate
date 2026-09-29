/**
 * Pause (A3) and NodeExecution state pushes (A4): Floe's side, with a fake engine.
 *
 * The Bus, Bridge daemon, runtime adapter and CopilotRuntime are real; the
 * engine is a scripted stand-in (test-support/fake-copilot-engine.ts), so the
 * test decides when a model call answers, fails, or stays open. A real
 * engine's interrupt of a real turn is proved by the release guard instead.
 * Every wait is driven by a push on a real Workspace socket or by the engine.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import WebSocket from "ws";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { defaultConfig } from "./config.js";
import { createBusServer } from "./server.js";
import { localProductWorkspacePolicy } from "./local-product-policy.js";
import { BridgeDaemon } from "../../floe-bridge/src/daemon.js";
import { defaultConfig as bridgeConfig } from "../../floe-bridge/src/config.js";
import { EngineControl } from "../../floe-bridge/src/engines/engine-control.js";
import { CopilotRuntime } from "floe-runtime/adapters/copilot";
import { fakeCopilotEngine, readyFakeEngine } from "./test-support/fake-copilot-engine.js";

const WS_ID = "workspace:scope-pause-fake";
const OTHER_WS = "workspace:scope-pause-other";
const BRIDGE = "bridge:scope-pause-fake";
const HOST_TOKEN = `scope-pause-fake-host-${"h".repeat(40)}`;
const MODEL = "gpt-4.1";
const WAIT = 90_000;

type Handle = Awaited<ReturnType<typeof createBusServer>>;
type Push = { type: string; payload: any; cursor?: string };

/** A Workspace socket that keeps every push and resolves waits as pushes arrive. */
class Socket {
  readonly pushes: Push[] = [];
  cursor: string | null = null;
  private readonly arrived = new EventEmitter();
  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Push;
      if (message.cursor) this.cursor = message.cursor;
      if (message.type === "caught_up") this.cursor = message.payload.cursor;
      this.pushes.push(message);
      this.arrived.emit("push", message);
    });
  }

  static async open(url: string, token: string, workspaceId: string, afterCursor?: string | null): Promise<Socket> {
    const ws = new WebSocket(url);
    const socket = new Socket(ws);
    await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "authenticate", bearer_token: token, workspace_id: workspaceId,
      ...(afterCursor !== undefined ? { after_cursor: afterCursor } : {}) }));
    await socket.until((push) => push.type === "caught_up");
    return socket;
  }

  /** Resolves with the first push, already kept or still to come, that matches. */
  until(match: (push: Push) => boolean, label = "push"): Promise<Push> {
    const found = this.pushes.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.arrived.off("push", listen); reject(new Error(`No ${label} arrived`)); }, WAIT);
      const listen = (push: Push) => {
        if (!match(push)) return;
        clearTimeout(timer);
        this.arrived.off("push", listen);
        resolve(push);
      };
      this.arrived.on("push", listen);
    });
  }

  /** Re-checks a condition each time a push arrives. */
  whenever<T>(check: () => T | undefined | null | false, label: string): Promise<T> {
    const first = check();
    if (first) return Promise.resolve(first);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.arrived.off("push", listen); reject(new Error(`Never true: ${label}`)); }, WAIT);
      const listen = () => {
        const value = check();
        if (!value) return;
        clearTimeout(timer);
        this.arrived.off("push", listen);
        resolve(value);
      };
      this.arrived.on("push", listen);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => { this.ws.once("close", () => resolve()); this.ws.close(); });
  }
}

function once(events: EventEmitter, name: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Model never saw ${name}`)), WAIT);
    events.once(name, (value) => { clearTimeout(timer); resolve(value); });
  });
}

describe("Scope pause and node pushes, Floe's side with a fake engine", () => {
  let root: string;
  let handle: Handle;
  let daemon: BridgeDaemon;
  let model: ReturnType<typeof fakeCopilotEngine>;
  let wsUrl: string;
  let token: string;
  let otherToken: string;
  let actors: string[];
  let ingressContext: string;
  let socket: Socket;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "floe-scope-pause-fake-"));
    const workspace = join(root, "workspace");
    const other = join(root, "other");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(other, { recursive: true });
    model = fakeCopilotEngine();

    const busHome = join(root, "bus");
    mkdirSync(busHome);
    const config = defaultConfig(busHome);
    writeFileSync(join(busHome, "config.yaml"), YAML.stringify(config), "utf8");
    handle = await createBusServer(join(busHome, "config.yaml"), config, {
      host_control_token: HOST_TOKEN, workspace_configuration_policy: localProductWorkspacePolicy,
    });
    await handle.app.ready();
    const at = new Date().toISOString();
    for (const [id, locator] of [[WS_ID, workspace], [OTHER_WS, other]] as const) {
      handle.store.workspaceIdentityStore.restoreWorkspace({
        snapshot: { workspace_id: id, name: id, creation_kind: "created", source_workspace_id: null, created_at: at, updated_at: at },
        binding: { host_id: handle.store.localHostId, platform: process.platform === "win32" ? "windows" : "posix", locator, init_authorized: true },
      });
      const admitted = await handle.app.inject({ method: "POST", url: "/v1/identities",
        headers: { authorization: ["Be", "arer ", HOST_TOKEN].join("") },
        payload: { display_name: "Operator", pubkey: getPublicKey(generateSecretKey()), workspace_id: id, until_revoked: true } });
      expect(admitted.statusCode, admitted.body).toBe(201);
    }
    const bridgeToken = handle.issueBridgeServiceCredential(BRIDGE).bearer_token;
    const bindingId = handle.store.workspaceIdentityStore.getCurrentBinding(WS_ID, handle.store.localHostId)!.binding_id;
    const imported = await handle.app.inject({
      method: "POST", url: `/v1/workspaces/${encodeURIComponent(WS_ID)}/import-config`,
      headers: { authorization: `Bearer ${bridgeToken}` }, payload: inventory(bindingId),
    });
    expect(imported.statusCode, imported.body).toBe(200);
    actors = imported.json().import_result.receipt.imported_actors.map((actor: { actor_id: string }) => actor.actor_id);
    expect(actors).toHaveLength(2);
    const session = async (id: string) => {
      const issued = await handle.app.inject({
        method: "POST", url: `/v1/local/workspaces/${encodeURIComponent(id)}/operation-sessions`,
        headers: { authorization: `Bearer ${HOST_TOKEN}` }, payload: { interaction_session_id: `interaction:${id}` },
      });
      expect(issued.statusCode, issued.body).toBe(201);
      return issued.json().bearer_token as string;
    };
    token = await session(WS_ID);
    otherToken = await session(OTHER_WS);

    handle.store.createScope({ workspace_id: WS_ID, scope_id: "pipeline", title: "Pipeline" }, handle.broadcast);
    ingressContext = handle.store.contextStore.createContext({
      workspace_id: WS_ID, scope_id: "pipeline", created_by_endpoint_id: null, participants: [], title: "Operator input",
    });
    const draft = handle.store.createScopeCompositionDraft({
      workspace_id: WS_ID, scope_id: "pipeline",
      content: {
        nodes: [
          { node_id: "ingress", kind: "event", config: { event_type: "work.requested" },
            context_policy: { mode: "fixed", context_id: ingressContext } },
          ...actors.map((actorId, index) => ({ node_id: `worker${index + 1}`, kind: "actor", resource_id: actorId,
            activation: { mode: "per_delivery" }, context_policy: { mode: "new_per_execution" } })),
        ],
        ports: [
          { port_id: "ingress:out", node_id: "ingress", name: "work", direction: "output", event_types: ["work.requested"] },
          ...actors.flatMap((_, index) => [
            { port_id: `worker${index + 1}:in`, node_id: `worker${index + 1}`, name: "work", direction: "input",
              event_types: ["work.requested"], min_count: 1 },
            { port_id: `worker${index + 1}:out`, node_id: `worker${index + 1}`, name: "result", direction: "output",
              event_types: ["work.completed"] },
          ]),
        ],
        edges: actors.map((_, index) => ({ edge_id: `ingress-to-worker${index + 1}`,
          source_port_id: "ingress:out", target_port_id: `worker${index + 1}:in` })),
      } as any,
    }, handle.broadcast);
    handle.store.publishScopeComposition({ revision_id: draft.revision_id, expected_published_revision_id: null }, handle.broadcast);

    const address = await handle.app.listen({ host: "127.0.0.1", port: 0 });
    wsUrl = `${address.replace("http:", "ws:")}/v1/events/stream`;
    socket = await Socket.open(wsUrl, token, WS_ID);

    const bridge = bridgeConfig(workspace);
    bridge.bus.http_base_url = address;
    bridge.bus.ws_base_url = address.replace("http:", "ws:");
    bridge.bridge.bus_url = bridge.bus.ws_base_url;
    bridge.bridge.runtime_adapter = "floe-runtime";
    bridge.bridge.data_dir = join(root, "bridge");
    daemon = new BridgeDaemon(join(root, "bridge-config.yaml"), bridge, {
      bridge_id: BRIDGE,
      transport_authority: { audience: "bridge_service", bearer_token: bridgeToken },
      engines: new EngineControl(new Map([["copilot", readyFakeEngine() as any]]), null),
      stand_in_engine: (options) => new CopilotRuntime({
        ...options, client: model.client as any, clientOptions: { baseDirectory: "unused-by-fake-engine" },
      }),
    });
    await daemon.start();
    await socket.until((push) => push.type === "bridge_connected", "bridge_connected");
    await socket.whenever(() => actors.every((id) => handle.store.getEndpoint(id)?.bridge_id === BRIDGE), "Actors attached");
  }, 120_000);

  afterAll(async () => {
    const step = async (name: string, work: () => Promise<unknown> | undefined) => {
      const began = Date.now(); await work(); console.log(`[cleanup] ${name} ${Date.now() - began}ms`);
    };
    await step("socket", () => socket?.close());
    await step("bridge", () => daemon?.stop());
    await step("bus", async () => { try { await handle?.app.close(); } catch {} });
    rmSync(root, { recursive: true, force: true });
  }, 120_000);

  function inventory(bindingId: string) {
    const actor = (id: string) => ({
      source_actor_id: id,
      source: { kind: "workspace_actor_file", path: `agents/${id}.md`, source_fingerprint: `sha256:${(id === "floe" ? "b" : "c").repeat(64)}` },
      definition: {
        label: id, charter: "Help achieve the operator outcome.", responsibilities: [],
        instructions: "Reply briefly.", knowledge_refs: [],
        policy_refs: { budget: null, trust: null, approval: null }, escalation_rules: [],
      },
      runtime: {
        label: "Copilot", backing_kind: "model", adapter_id: "floe-runtime", configuration: { model: MODEL },
        required_capability_ids: [], checkpoint_policy: { mode: "none", schema_ref: null }, resource_policy: {},
        credential_requirement: "none", required_configuration_keys: ["model"],
      },
    });
    return {
      schema: "floe.workspace-configuration-inventory.v1", importer_version: "1", binding_id: bindingId,
      config_hash: `sha256:${"a".repeat(64)}`, source: { kind: "workspace_files", manifest_ref: ".floe/floe.yaml" },
      validation: { ok: true, issues: [] },
      actors: [actor("floe"), actor("helper")],
    };
  }

  function start(key: string) {
    const cause = handle.store.appendContextEvent({
      type: "message", workspace_id: WS_ID, context_id: ingressContext, content: { text: key },
      metadata: { origin: "operator" }, idempotency_key: `cause:${key}`,
    }, handle.broadcast).event_id;
    return handle.store.startScopeExecution({
      workspace_id: WS_ID, scope_id: "pipeline", ingress_node_id: "ingress", output_port_id: "ingress:out",
      content: { request: key }, artefact_version_ids: [], cause_event_id: cause,
      initiator_endpoint_id: "operator", idempotency_key: key,
    }, handle.broadcast);
  }

  async function control(operationId: string, executionId: string, key: string) {
    const resolved = handle.store.resolveOperationResource({ kind: "scope_execution", id: executionId },
      { kind: "workspace", workspace_id: WS_ID })!;
    const response = await handle.app.inject({
      method: "POST", url: `/v1/workspaces/${encodeURIComponent(WS_ID)}/operations/invoke`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        operation_id: operationId, operation_version: "1", input_schema_version: "1",
        target: { kind: "scope_execution", id: executionId }, expected_resource_revision: resolved.ref.revision,
        idempotency_key: key, input: {},
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().receipt;
  }

  const nodePushes = (s: Socket, executionId: string) => s.pushes
    .filter((push) => push.type === "node_execution_state_changed" && push.payload.scope_execution_id === executionId);
  const nodeStatus = (s: Socket, executionId: string, status: string) =>
    nodePushes(s, executionId).filter((push) => push.payload.to_status === status);

  function expectOnePushPerRevision(s: Socket, executionId: string) {
    const nodes = handle.store.scopeExecutionStore.listNodeExecutions(executionId);
    for (const node of nodes) {
      const revisions = nodePushes(s, executionId)
        .filter((push) => push.payload.node_execution_id === node.node_execution_id)
        .map((push) => push.payload.state_revision as number);
      expect(revisions, node.node_id).toEqual(Array.from({ length: revisions.length }, (_, index) => index + 1));
      expect(nodePushes(s, executionId).filter((push) => push.payload.node_execution_id === node.node_execution_id).at(-1)?.payload.to_status)
        .toBe(node.status);
    }
  }

  it("A3: pause interrupts the running turn now, holds queued work, and resume reruns only the interrupted node", async () => {
    model.script.push("answer", "hold");
    const requestsBefore = model.prompts.length;
    const held = once(model.events, "held");
    const { execution } = start("pause-proof");
    await held;
    const completed = (await socket.until((push) => push.type === "node_execution_state_changed"
      && push.payload.scope_execution_id === execution.execution_id && push.payload.node_id !== "ingress"
      && push.payload.to_status === "completed", "first node completed")).payload;
    const interruptedNodeId = handle.store.scopeExecutionStore.listNodeExecutions(execution.execution_id)
      .find((node) => node.node_execution_id !== completed.node_execution_id && node.node_id !== "ingress")!.node_execution_id;

    const aborted = once(model.events, "aborted");
    const receipt = await control("scope.execution.pause", execution.execution_id, "pause-1");
    expect(receipt.state, JSON.stringify(receipt)).toBe("accepted");
    expect(receipt.result).toMatchObject({ execution: { execution_id: execution.execution_id } });
    const requested = await socket.until((push) => push.type === "scope_execution_pause_requested"
      && push.payload.execution.execution_id === execution.execution_id, "scope_execution_pause_requested");
    const cancel = await socket.until((push) => push.type === "delivery_cancel_requested"
      && push.payload.scope_execution_id === execution.execution_id, "delivery_cancel_requested");
    expect(requested.payload.active_delivery_ids).toEqual([cancel.payload.delivery_id]);
    await aborted;
    await socket.until((push) => push.type === "node_execution_state_changed"
      && push.payload.node_execution_id === interruptedNodeId && push.payload.to_status === "paused", "node paused");
    const paused = await socket.until((push) => push.type === "scope_execution_paused"
      && push.payload.execution.execution_id === execution.execution_id, "scope_execution_paused");
    expect(paused.payload.execution.status).toBe("paused");
    expect(model.prompts.length).toBe(requestsBefore + 2);

    const interrupted = handle.store.scopeExecutionStore.getNodeExecution(interruptedNodeId)!;
    const firstAttempts = handle.store.scopeExecutionStore.listAttempts(interruptedNodeId);
    expect(interrupted).toMatchObject({ status: "paused", failure: expect.objectContaining({ outcome_unknown: true }) });
    expect(firstAttempts).toEqual([expect.objectContaining({ status: "outcome_unknown" })]);
    expect(handle.store.scopeExecutionStore.listAttempts(completed.node_execution_id)).toHaveLength(1);

    model.script.push("answer");
    const resumedRequest = once(model.events, "request");
    const resumed = await control("scope.execution.resume", execution.execution_id, "resume-1");
    expect(resumed.state, JSON.stringify(resumed)).toBe("accepted");
    await resumedRequest;
    await socket.until((push) => push.type === "node_execution_state_changed"
      && push.payload.node_execution_id === interruptedNodeId && push.payload.to_status === "completed", "resumed node completed");

    const attempts = handle.store.scopeExecutionStore.listAttempts(interruptedNodeId);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({
      ordinal: 2,
      actor_definition_revision_id: attempts[0]!.actor_definition_revision_id,
      runtime_profile_revision_id: attempts[0]!.runtime_profile_revision_id,
      actor_runtime_binding_id: attempts[0]!.actor_runtime_binding_id,
    });
    expect(handle.store.scopeExecutionStore.listAttempts(completed.node_execution_id)).toHaveLength(1);
    expect(model.prompts.length).toBe(requestsBefore + 3);
    console.log("[A3] resumed turn mentions the interruption:", /interrupt|paused|outcome/i.test(model.prompts.at(-1)!));
    console.log("[A3] interrupted attempt evidence:", JSON.stringify(firstAttempts[0]!.error));
    expectOnePushPerRevision(socket, execution.execution_id);
  }, 180_000);

  it("A4: completed and failed nodes are pushed once per revision, replay after reconnect, and stay in their Workspace", async () => {
    const outsider = await Socket.open(wsUrl, otherToken, OTHER_WS);
    const before = socket.cursor;
    await socket.close();
    model.script.push("answer", "fail", "fail", "fail", "fail", "fail", "fail");
    const { execution } = start("failure-proof");
    const live = await Socket.open(wsUrl, token, WS_ID, null);
    await live.whenever(() => {
      const nodes = handle.store.scopeExecutionStore.listNodeExecutions(execution.execution_id).filter((node) => node.node_id !== "ingress");
      return nodes.length === 2 && nodes.some((node) => node.status === "completed") && nodes.some((node) => node.status === "failed");
    }, "one node completed and one failed");
    await live.until((push) => push.type === "node_execution_state_changed"
      && push.payload.scope_execution_id === execution.execution_id && push.payload.to_status === "failed", "failed push");
    const failed = nodeStatus(live, execution.execution_id, "failed")[0]!.payload;
    expect(failed).toMatchObject({ workspace_id: WS_ID, scope_id: "pipeline", node_id: expect.stringMatching(/^worker/),
      composition_revision_id: expect.any(String), failure: expect.anything() });
    expect(nodeStatus(live, execution.execution_id, "completed").find((push) => push.payload.node_id !== "ingress")!.payload).toMatchObject({ scope_id: "pipeline", node_id: expect.stringMatching(/^worker/) });
    expectOnePushPerRevision(live, execution.execution_id);
    console.log("[A4] failure pushed:", JSON.stringify(failed.failure));

    const replayed = await Socket.open(wsUrl, token, WS_ID, before);
    expect(nodePushes(replayed, execution.execution_id).map((push) => push.cursor))
      .toEqual(nodePushes(live, execution.execution_id).map((push) => push.cursor));
    expectOnePushPerRevision(replayed, execution.execution_id);

    expect(outsider.pushes.filter((push) => push.type === "node_execution_state_changed")).toEqual([]);
    for (const s of [outsider, live, replayed]) await s.close();
    socket = await Socket.open(wsUrl, token, WS_ID);
  }, 180_000);
});
