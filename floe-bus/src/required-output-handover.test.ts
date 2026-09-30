import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import { defaultConfig, type LocalConfig } from "./config.js";
import type { ScopeCompositionContent, ScopePort } from "./scope-compositions.js";
import { registerExecutableActorFixture } from "./executable-actor-test-fixture.js";

// A step's required output is always handed on or its absence is said:
// a single required output is handed on by the Actor's reply, otherwise the
// Actor gets exactly one visible reminder turn, then the step fails.

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

const BRIDGE = "bridge:required-output";

describe("handing on a step's required output", () => {
  let handle: ServerHandle;
  let tmp: string;
  let workspaceId: string;
  let actorId: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "floe-required-output-"));
    const cfgPath = join(tmp, "config.yaml");
    const cfg: LocalConfig = defaultConfig(tmp);
    writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
    handle = await createBusServer(cfgPath, cfg, { unsafe_in_process_test_auth_bypass: true });
    await handle.app.ready();
    const locator = join(tmp, "workspace");
    mkdirSync(locator, { recursive: true });
    const registered = await handle.app.inject({
      method: "POST",
      url: "/v1/workspaces/register",
      payload: { locator, name: "required output" },
    });
    workspaceId = registered.json().workspace.workspace_id as string;
    actorId = `actor:${workspaceId}:worker`;
    handle.store.createScope({ workspace_id: workspaceId, scope_id: "pipeline", title: "Pipeline" }, handle.broadcast);
    handle.store.registerEndpoint({
      endpoint_id: actorId,
      workspace_id: workspaceId,
      name: "Worker",
      bridge_id: BRIDGE,
      status: "idle",
    }, handle.broadcast);
    registerExecutableActorFixture(handle.store, workspaceId, actorId);
  });

  afterEach(async () => {
    try { await handle.app.close(); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  });

  function start(outputs: Array<Partial<ScopePort> & { port_id: string }>): { executionId: string; nodeExecutionId: string } {
    const ingressContextId = handle.store.contextStore.createContext({
      workspace_id: workspaceId,
      scope_id: "pipeline",
      created_by_endpoint_id: null,
      participants: [],
      title: "Ingress",
    });
    const content: ScopeCompositionContent = {
      nodes: [
        {
          node_id: "ingress",
          kind: "event",
          label: "Input arrived",
          config: { event_type: "input.arrived" },
          context_policy: { mode: "fixed", context_id: ingressContextId },
        },
        {
          node_id: "worker",
          kind: "actor",
          label: "Worker",
          resource_id: actorId,
          activation: { mode: "per_delivery" },
          context_policy: { mode: "new_per_execution" },
        },
      ],
      ports: [
        { port_id: "ingress:out", node_id: "ingress", name: "input", direction: "output", event_types: ["input.arrived"] },
        { port_id: "worker:in", node_id: "worker", name: "in", direction: "input", event_types: ["input.arrived"], min_count: 1 },
        ...outputs.map((port) => ({
          node_id: "worker",
          name: port.port_id.replace("worker:", ""),
          direction: "output" as const,
          event_types: ["work.completed"],
          min_count: 1,
          ...port,
        })),
      ],
      edges: [{ edge_id: "input", source_port_id: "ingress:out", target_port_id: "worker:in" }],
    };
    const draft = handle.store.createScopeCompositionDraft({ workspace_id: workspaceId, scope_id: "pipeline", content }, handle.broadcast);
    handle.store.publishScopeComposition({ revision_id: draft.revision_id }, handle.broadcast);
    const started = handle.store.startScopeExecution({
      workspace_id: workspaceId,
      scope_id: "pipeline",
      ingress_node_id: "ingress",
      output_port_id: "ingress:out",
      content: { item: "work" },
      idempotency_key: `start:${Math.random()}`,
    }, handle.broadcast);
    const worker = handle.store.getScopeExecutionProjection(started.execution.execution_id)!
      .node_executions.find((node) => node.node_id === "worker")!;
    return { executionId: started.execution.execution_id, nodeExecutionId: worker.node_execution_id };
  }

  /** One real-shaped turn: claim, prepare, run, optionally hand on outputs, reply, acknowledge, end. */
  function turn(nodeExecutionId: string, options: { reply?: string; publish?: Array<{ port_id: string; text: string }> } = {}) {
    const [delivery] = handle.store.claimDeliveries(BRIDGE, 1, handle.broadcast);
    expect(delivery, "a turn was queued for the step").toBeDefined();
    handle.store.prepareRuntimeDelivery({ bridge_id: BRIDGE, delivery_id: delivery!.delivery_id }, handle.broadcast);
    handle.store.reportDeliveryStatus({ bridge_id: BRIDGE, delivery_id: delivery!.delivery_id, state: "injected_to_runtime" }, handle.broadcast);
    for (const output of options.publish ?? []) {
      handle.store.publishScopeNodeOutput({
        workspace_id: workspaceId,
        node_execution_id: nodeExecutionId,
        port_id: output.port_id,
        publisher_endpoint_id: actorId,
        content: { text: output.text },
        idempotency_key: `explicit:${output.port_id}:${Math.random()}`,
        lifecycle_outcome: "completed",
      }, handle.broadcast);
    }
    if (options.reply !== undefined) {
      handle.store.recordRuntimeTurnResult({ delivery_id: delivery!.delivery_id, outcome: "completed", text: options.reply }, handle.broadcast);
    }
    handle.store.reportDeliveryStatus({ bridge_id: BRIDGE, delivery_id: delivery!.delivery_id, state: "acknowledged" }, handle.broadcast);
    handle.store.reportTurnEnd(actorId, handle.broadcast);
    return delivery!;
  }

  const node = (executionId: string) => handle.store.getScopeExecutionProjection(executionId)!
    .node_executions.find((candidate) => candidate.node_id === "worker")!;
  const execution = (executionId: string) => handle.store.getScopeExecutionProjection(executionId)!.execution;
  const outputs = (nodeExecutionId: string) => (handle.store.db.prepare(`
    SELECT p.port_id, e.content_json, e.metadata_json FROM scope_output_publications p
    JOIN events e ON e.event_id = p.event_id WHERE p.node_execution_id = ? ORDER BY p.created_at
  `).all(nodeExecutionId) as Array<{ port_id: string; content_json: string; metadata_json: string }>).map((row) => ({
    port_id: row.port_id,
    text: JSON.parse(row.content_json).text as string,
    output_source: JSON.parse(row.metadata_json).output_source ?? null,
  }));
  const reminders = (nodeExecutionId: string) => handle.store.db.prepare(`
    SELECT event_id, content_json FROM events
    WHERE json_extract(metadata_json, '$.origin') = 'scope_output_reminder'
      AND json_extract(metadata_json, '$.node_execution_id') = ?
  `).all(nodeExecutionId) as Array<{ event_id: string; content_json: string }>;

  it("completes a single-output step from its reply alone", () => {
    const run = start([{ port_id: "worker:result" }]);
    turn(run.nodeExecutionId, { reply: "the finished summary" });
    expect(node(run.executionId).status).toBe("completed");
    expect(execution(run.executionId).status).toBe("completed");
    expect(outputs(run.nodeExecutionId)).toEqual([
      { port_id: "worker:result", text: "the finished summary", output_source: "turn_reply" },
    ]);
    expect(reminders(run.nodeExecutionId)).toHaveLength(0);
  });

  it("lets an explicit hand-on win over the reply text", () => {
    const run = start([{ port_id: "worker:result" }]);
    turn(run.nodeExecutionId, { publish: [{ port_id: "worker:result", text: "explicit result" }], reply: "chatty reply" });
    expect(node(run.executionId).status).toBe("completed");
    expect(outputs(run.nodeExecutionId)).toEqual([
      { port_id: "worker:result", text: "explicit result", output_source: null },
    ]);
  });

  it("reminds a multi-output step that missed one exactly once, then completes when it hands it on", () => {
    const run = start([{ port_id: "worker:first" }, { port_id: "worker:second" }]);
    turn(run.nodeExecutionId, { publish: [{ port_id: "worker:first", text: "one" }], reply: "done with first" });
    // A "completed" hand-on does not finish a step still missing required output.
    expect(node(run.executionId).status).toBe("retrying");
    expect(node(run.executionId).failure).toMatchObject({
      code: "required_output_reminder_sent",
      required_port_ids: ["worker:second"],
    });
    const [reminder] = reminders(run.nodeExecutionId);
    expect(JSON.parse(reminder!.content_json).text).toMatch(/worker:second[\s\S]*scope\.node-output\.publish[\s\S]*only reminder/);

    const reminded = turn(run.nodeExecutionId, { publish: [{ port_id: "worker:second", text: "two" }], reply: "done" });
    expect(reminded.trigger_event_id).toBe(reminder!.event_id);
    expect(node(run.executionId).status).toBe("completed");
    expect(execution(run.executionId).status).toBe("completed");
    expect(outputs(run.nodeExecutionId).map((output) => output.port_id)).toEqual(["worker:first", "worker:second"]);
    expect(reminders(run.nodeExecutionId)).toHaveLength(1);
  });

  it("fails a step that ignores the reminder, with the reason, and never loops", () => {
    const run = start([{ port_id: "worker:first" }, { port_id: "worker:second" }]);
    turn(run.nodeExecutionId, { reply: "no" });
    expect(node(run.executionId).status).toBe("retrying");
    turn(run.nodeExecutionId, { reply: "still no" });
    expect(node(run.executionId).status).toBe("failed");
    expect(node(run.executionId).failure).toMatchObject({
      code: "required_output_not_handed_on",
      message: "required output not handed on: first, second",
      required_port_ids: ["worker:first", "worker:second"],
    });
    expect(execution(run.executionId).status).toBe("failed");
    expect(reminders(run.nodeExecutionId)).toHaveLength(1);
    expect(handle.store.claimDeliveries(BRIDGE, 1, handle.broadcast)).toHaveLength(0);
  });

  it("hands on text to a required Port that carries no files, and still demands files where a Port declares them", () => {
    const textRun = start([{ port_id: "worker:result" }]);
    turn(textRun.nodeExecutionId, { publish: [{ port_id: "worker:result", text: "plain text" }] });
    expect(node(textRun.executionId).status).toBe("completed");

    const fileRun = start([{ port_id: "worker:report", artefact_types: ["text/markdown"] }]);
    const [delivery] = handle.store.claimDeliveries(BRIDGE, 1, handle.broadcast);
    handle.store.prepareRuntimeDelivery({ bridge_id: BRIDGE, delivery_id: delivery!.delivery_id }, handle.broadcast);
    handle.store.reportDeliveryStatus({ bridge_id: BRIDGE, delivery_id: delivery!.delivery_id, state: "injected_to_runtime" }, handle.broadcast);
    expect(() => handle.store.publishScopeNodeOutput({
      workspace_id: workspaceId,
      node_execution_id: fileRun.nodeExecutionId,
      port_id: "worker:report",
      publisher_endpoint_id: actorId,
      content: { text: "no file" },
      idempotency_key: "file-port-without-file",
      lifecycle_outcome: "completed",
    }, handle.broadcast)).toThrow(/requires at least 1 ArtefactVersion/);
    // Reply text cannot stand in for a saved file either: the step is reminded.
    handle.store.recordRuntimeTurnResult({ delivery_id: delivery!.delivery_id, outcome: "completed", text: "here it is" }, handle.broadcast);
    handle.store.reportDeliveryStatus({ bridge_id: BRIDGE, delivery_id: delivery!.delivery_id, state: "acknowledged" }, handle.broadcast);
    expect(node(fileRun.executionId).status).toBe("retrying");
    expect(outputs(fileRun.nodeExecutionId)).toEqual([]);
  });

  describe("a Port that declares an output schema", () => {
    const verdict = {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string", pattern: "^(PASS|FAIL|UNSURE)\\b" } },
    };

    it("refuses a publication that does not match, naming the field, and accepts one that does", () => {
      const run = start([{ port_id: "worker:verdict", schema: verdict }]);
      const [delivery] = handle.store.claimDeliveries(BRIDGE, 1, handle.broadcast);
      handle.store.prepareRuntimeDelivery({ bridge_id: BRIDGE, delivery_id: delivery!.delivery_id }, handle.broadcast);
      handle.store.reportDeliveryStatus({ bridge_id: BRIDGE, delivery_id: delivery!.delivery_id, state: "injected_to_runtime" }, handle.broadcast);
      const publish = (content: Record<string, unknown>, key: string) => handle.store.publishScopeNodeOutput({
        workspace_id: workspaceId,
        node_execution_id: run.nodeExecutionId,
        port_id: "worker:verdict",
        publisher_endpoint_id: actorId,
        content,
        idempotency_key: key,
        lifecycle_outcome: "completed",
      }, handle.broadcast);
      expect(() => publish({ text: "looks fine to me" }, "bad-shape"))
        .toThrow(/output does not match Port 'verdict' schema: \/text must match pattern/);
      expect(() => publish({ reason: "no text" }, "missing-field"))
        .toThrow(/must have required property 'text'/);
      expect(outputs(run.nodeExecutionId)).toEqual([]);
      publish({ text: "PASS the error shows" }, "good-shape");
      expect(outputs(run.nodeExecutionId)).toEqual([
        { port_id: "worker:verdict", text: "PASS the error shows", output_source: null },
      ]);
    });

    it("hands on a reply that matches, and reminds with the reason when it does not", () => {
      const good = start([{ port_id: "worker:verdict", schema: verdict }]);
      turn(good.nodeExecutionId, { reply: "FAIL\nthe page shows no error" });
      expect(node(good.executionId).status).toBe("completed");
      expect(outputs(good.nodeExecutionId)[0]).toMatchObject({ output_source: "turn_reply" });

      const bad = start([{ port_id: "worker:verdict", schema: verdict }]);
      turn(bad.nodeExecutionId, { reply: "I think it works" });
      expect(node(bad.executionId).status).toBe("retrying");
      const [reminder] = reminders(bad.nodeExecutionId);
      expect(JSON.parse(reminder!.content_json).text)
        .toMatch(/Your reply could not be handed on as that output: output does not match Port 'verdict' schema: \/text must match pattern/);
      turn(bad.nodeExecutionId, { reply: "still unsure" });
      expect(node(bad.executionId).status).toBe("failed");
      expect(node(bad.executionId).failure?.message).toMatch(/^required output not handed on: verdict \(output does not match/);
    });

    it("refuses a route whose Port schema cannot be used", () => {
      expect(() => start([{ port_id: "worker:verdict", schema: { type: "object", requird: ["text"] } }]))
        .toThrow(/port 'worker:verdict' schema is not usable: strict mode: unknown keyword: "requird"/);
    });
  });
});
