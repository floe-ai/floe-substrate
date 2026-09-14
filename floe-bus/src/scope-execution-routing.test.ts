import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import { defaultConfig, type LocalConfig } from "./config.js";
import type { ScopeCompositionContent } from "./scope-compositions.js";
import { registerExecutableActorFixture } from "./executable-actor-test-fixture.js";
import { ScopeExecutionStore } from "./scope-executions.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

async function makeServer(): Promise<{ handle: ServerHandle; tmp: string; workspaceId: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-canonical-execution-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg: LocalConfig = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const handle = await createBusServer(cfgPath, cfg, { allow_unauthenticated_test_requests: true });
  await handle.app.ready();
  const locator = join(tmp, "workspace");
  mkdirSync(locator, { recursive: true });
  const registered = await handle.app.inject({
    method: "POST",
    url: "/v1/workspaces/register",
    headers: { authorization: `Bearer ${handle.localControlToken}` },
    payload: { locator, name: "canonical execution" },
  });
  const workspaceId = registered.json().workspace.workspace_id as string;
  handle.store.createScope({ workspace_id: workspaceId, scope_id: "delivery", title: "Delivery" }, handle.broadcast);
  return { handle, tmp, workspaceId };
}

function registerEndpoint(handle: ServerHandle, workspaceId: string, id: string): string {
  const endpointId = `actor:${workspaceId}:${id}`;
  handle.store.registerEndpoint({
    endpoint_id: endpointId,
    workspace_id: workspaceId,
    name: id,
    bridge_id: null,
    status: "idle",
  }, handle.broadcast);
  registerExecutableActorFixture(handle.store, workspaceId, endpointId);
  return endpointId;
}

function composition(
  ingressContextId: string,
  planner: string,
  reviewer: string,
): ScopeCompositionContent {
  return {
    nodes: [
      {
        node_id: "ingress",
        kind: "event",
        label: "Work arrived",
        config: { event_type: "work.arrived" },
        context_policy: { mode: "fixed", context_id: ingressContextId },
      },
      {
        node_id: "planner",
        kind: "actor",
        label: "Planner",
        resource_id: planner,
        activation: { mode: "per_delivery" },
        context_policy: { mode: "new_per_execution" },
      },
      {
        node_id: "reviewer",
        kind: "actor",
        label: "Reviewer",
        resource_id: reviewer,
        activation: { mode: "per_delivery" },
        context_policy: { mode: "new_per_execution" },
      },
    ],
    ports: [
      { port_id: "ingress:out", node_id: "ingress", name: "arrived", direction: "output", event_types: ["work.arrived"] },
      { port_id: "planner:in", node_id: "planner", name: "work", direction: "input", event_types: ["work.arrived"], min_count: 1 },
      { port_id: "planner:planned", node_id: "planner", name: "planned", direction: "output", event_types: ["work.planned"] },
      { port_id: "reviewer:in", node_id: "reviewer", name: "plan", direction: "input", event_types: ["work.planned"], min_count: 1 },
    ],
    edges: [
      { edge_id: "ingress-to-planner", source_port_id: "ingress:out", target_port_id: "planner:in" },
      { edge_id: "planner-to-reviewer", source_port_id: "planner:planned", target_port_id: "reviewer:in" },
    ],
  };
}

function dynamicJoinComposition(
  ingressContextId: string,
  producer: string,
  gatherer: string,
): ScopeCompositionContent {
  return {
    nodes: [
      {
        node_id: "ingress",
        kind: "event",
        context_policy: { mode: "fixed", context_id: ingressContextId },
      },
      {
        node_id: "producer",
        kind: "actor",
        resource_id: producer,
        activation: { mode: "per_delivery" },
        context_policy: { mode: "new_per_execution" },
      },
      {
        node_id: "gatherer",
        kind: "actor",
        resource_id: gatherer,
        activation: {
          mode: "keyed_gather",
          join_key: { source: "event_content", path: "batch_id" },
          expected_members: {
            mode: "from_collection",
            collection_port_id: "gatherer:collection",
            member_port_id: "gatherer:member",
            member_key: { source: "event_content", path: "member_key" },
            match: "member_key_and_version",
          },
        },
        context_policy: { mode: "new_per_execution" },
      },
    ],
    ports: [
      { port_id: "ingress:out", node_id: "ingress", name: "start", direction: "output", event_types: ["work.started"] },
      { port_id: "producer:in", node_id: "producer", name: "start", direction: "input", event_types: ["work.started"], min_count: 1 },
      { port_id: "producer:member", node_id: "producer", name: "member", direction: "output", event_types: ["member.ready"], artefact_types: ["image/prop"] },
      { port_id: "producer:collection", node_id: "producer", name: "collection", direction: "output", event_types: ["collection.ready"], artefact_types: ["core:collection"] },
      { port_id: "gatherer:member", node_id: "gatherer", name: "member", direction: "input", event_types: ["member.ready"], artefact_types: ["image/prop"], min_count: 0, max_count: null },
      { port_id: "gatherer:collection", node_id: "gatherer", name: "collection", direction: "input", event_types: ["collection.ready"], artefact_types: ["core:collection"], min_count: 1, max_count: 1 },
    ],
    edges: [
      { edge_id: "ingress-to-producer", source_port_id: "ingress:out", target_port_id: "producer:in" },
      { edge_id: "member-to-gatherer", source_port_id: "producer:member", target_port_id: "gatherer:member" },
      { edge_id: "collection-to-gatherer", source_port_id: "producer:collection", target_port_id: "gatherer:collection" },
    ],
  };
}

describe("explicit Scope execution routing", () => {
  let handle: ServerHandle;
  let tmp: string;
  let workspaceId: string;

  beforeEach(async () => {
    ({ handle, tmp, workspaceId } = await makeServer());
  });

  afterEach(async () => {
    try { await handle.app.close(); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  });

  it("uses stored Edges, pins the revision, and never treats a matching Context subscription as pipeline topology", () => {
    const planner = registerEndpoint(handle, workspaceId, "planner");
    const reviewerV1 = registerEndpoint(handle, workspaceId, "reviewer-v1");
    const reviewerV2 = registerEndpoint(handle, workspaceId, "reviewer-v2");
    const accidentalSubscriber = registerEndpoint(handle, workspaceId, "accidental-subscriber");
    const ingressContextId = handle.store.contextStore.createContext({
      workspace_id: workspaceId,
      scope_id: "delivery",
      created_by_endpoint_id: null,
      participants: [accidentalSubscriber],
      title: "Ingress evidence",
    });
    handle.store.contextStore.applyContextSubscriptions(ingressContextId, [{
      endpoint_id: accidentalSubscriber,
      event_types: ["work.arrived"],
    }]);

    const draftV1 = handle.store.createScopeCompositionDraft({
      workspace_id: workspaceId,
      scope_id: "delivery",
      content: composition(ingressContextId, planner, reviewerV1),
    }, handle.broadcast);
    const revisionV1 = handle.store.publishScopeComposition({
      revision_id: draftV1.revision_id,
      expected_published_revision_id: null,
    }, handle.broadcast);

    const startedV1 = handle.store.startScopeExecution({
      workspace_id: workspaceId,
      scope_id: "delivery",
      ingress_node_id: "ingress",
      output_port_id: "ingress:out",
      content: { card_id: "card-1" },
      idempotency_key: "card-1",
    }, handle.broadcast);
    expect(startedV1.execution.revision_id).toBe(revisionV1.revision_id);
    expect(startedV1.delivery_ids).toHaveLength(1);
    expect((handle.store.db.prepare(`SELECT count(*) AS count FROM events`).get() as { count: number }).count).toBe(1);
    const queuedV1 = handle.store.db.prepare(`SELECT * FROM event_queue ORDER BY created_at ASC`).all() as any[];
    expect(queuedV1).toHaveLength(1);
    expect(queuedV1[0]).toMatchObject({
      queue_id: startedV1.delivery_ids[0],
      destination_endpoint_id: planner,
      composition_revision_id: revisionV1.revision_id,
      edge_id: "ingress-to-planner",
      target_node_id: "planner",
      target_port_id: "planner:in",
    });
    expect(queuedV1.some((row) => row.destination_endpoint_id === accidentalSubscriber)).toBe(false);

    const plannerNode = handle.store.getScopeExecutionProjection(startedV1.execution.execution_id)!
      .node_executions.find((node) => node.node_id === "planner")!;
    expect(plannerNode.context_id).not.toBe(ingressContextId);
    expect(plannerNode.inputs).toEqual([
      expect.objectContaining({ port_id: "planner:in", event_id: startedV1.root_event.event_id }),
    ]);

    const draftV2 = handle.store.createScopeCompositionDraft({
      workspace_id: workspaceId,
      scope_id: "delivery",
      based_on_revision_id: revisionV1.revision_id,
      content: composition(ingressContextId, planner, reviewerV2),
    }, handle.broadcast);
    const revisionV2 = handle.store.publishScopeComposition({
      revision_id: draftV2.revision_id,
      expected_published_revision_id: revisionV1.revision_id,
    }, handle.broadcast);

    const plannerOutput = handle.store.publishScopeNodeOutput({
      workspace_id: workspaceId,
      node_execution_id: plannerNode.node_execution_id,
      port_id: "planner:planned",
      publisher_endpoint_id: planner,
      content: { plan: "exact revision one plan" },
      idempotency_key: "planner-output:card-1",
      lifecycle_outcome: "completed",
    }, handle.broadcast);
    expect(plannerOutput.execution.revision_id).toBe(revisionV1.revision_id);
    const reviewerDelivery = handle.store.db.prepare(`
      SELECT * FROM event_queue WHERE queue_id = ?
    `).get(plannerOutput.delivery_ids[0]) as any;
    expect(reviewerDelivery.destination_endpoint_id).toBe(reviewerV1);
    expect(reviewerDelivery.composition_revision_id).toBe(revisionV1.revision_id);

    const startedV2 = handle.store.startScopeExecution({
      workspace_id: workspaceId,
      scope_id: "delivery",
      ingress_node_id: "ingress",
      output_port_id: "ingress:out",
      content: { card_id: "card-2" },
      idempotency_key: "card-2",
    }, handle.broadcast);
    expect(startedV2.execution.revision_id).toBe(revisionV2.revision_id);
  });

  it("gathers out-of-order collection members once, preserves missing evidence, and becomes ready after restart", () => {
    const producer = registerEndpoint(handle, workspaceId, "producer");
    const gatherer = registerEndpoint(handle, workspaceId, "gatherer");
    const ingressContextId = handle.store.contextStore.createContext({
      workspace_id: workspaceId,
      scope_id: "delivery",
      created_by_endpoint_id: null,
      participants: [],
      title: "Join ingress",
    });
    const draft = handle.store.createScopeCompositionDraft({
      workspace_id: workspaceId,
      scope_id: "delivery",
      content: dynamicJoinComposition(ingressContextId, producer, gatherer),
    }, handle.broadcast);
    handle.store.publishScopeComposition({
      revision_id: draft.revision_id,
      expected_published_revision_id: null,
    }, handle.broadcast);

    const crate = handle.store.artefactStore.createArtefact({
      workspace_id: workspaceId,
      type_ref: "image/prop",
      idempotency_key: "artefact:crate",
    });
    const crateVersion = handle.store.artefactStore.publishVersion({
      artefact_id: crate.artefact_id,
      idempotency_key: "artefact:crate:v1",
      content_ref: {
        kind: "content-addressed",
        resolver_id: "test",
        digest: { algorithm: "sha256", value: "a".repeat(64) },
      },
    });
    const barrel = handle.store.artefactStore.createArtefact({
      workspace_id: workspaceId,
      type_ref: "image/prop",
      idempotency_key: "artefact:barrel",
    });
    const barrelVersion = handle.store.artefactStore.publishVersion({
      artefact_id: barrel.artefact_id,
      idempotency_key: "artefact:barrel:v1",
      content_ref: {
        kind: "content-addressed",
        resolver_id: "test",
        digest: { algorithm: "sha256", value: "b".repeat(64) },
      },
    });
    const collection = handle.store.artefactStore.createArtefact({
      workspace_id: workspaceId,
      type_ref: "core:collection",
      idempotency_key: "artefact:collection",
    });
    const collectionVersion = handle.store.artefactStore.publishVersion({
      artefact_id: collection.artefact_id,
      idempotency_key: "artefact:collection:v1",
      content_ref: {
        kind: "content-addressed",
        resolver_id: "test",
        digest: { algorithm: "sha256", value: "c".repeat(64) },
      },
      members: [
        { member_key: "crate", member_version_id: crateVersion.artefact_version_id, position: 0 },
        { member_key: "barrel", member_version_id: barrelVersion.artefact_version_id, position: 1 },
      ],
    });

    const started = handle.store.startScopeExecution({
      workspace_id: workspaceId,
      scope_id: "delivery",
      ingress_node_id: "ingress",
      output_port_id: "ingress:out",
      content: { batch_id: "batch-1" },
      idempotency_key: "dynamic-join",
    }, handle.broadcast);
    const producerNode = handle.store.getScopeExecutionProjection(started.execution.execution_id)!
      .node_executions.find((node) => node.node_id === "producer")!;

    const firstMember = handle.store.publishScopeNodeOutput({
      workspace_id: workspaceId,
      node_execution_id: producerNode.node_execution_id,
      port_id: "producer:member",
      publisher_endpoint_id: producer,
      event_type: "member.ready",
      content: { batch_id: "batch-1", member_key: "crate" },
      idempotency_key: "member:crate:first",
      lifecycle_outcome: "waiting",
      artefact_version_ids: [crateVersion.artefact_version_id],
    }, handle.broadcast);
    const gatherNode = handle.store.getScopeExecutionProjection(started.execution.execution_id)!
      .node_executions.find((node) => node.node_id === "gatherer")!;
    const contextId = gatherNode.context_id;
    expect(gatherNode).toMatchObject({ status: "collecting", join_key: "batch-1" });
    expect(gatherNode.join_state).toMatchObject({
      ready: false,
      received: [expect.objectContaining({ member_key: "crate", state: "received" })],
      missing: [expect.objectContaining({ port_id: "gatherer:collection" })],
    });

    const duplicateMember = handle.store.publishScopeNodeOutput({
      workspace_id: workspaceId,
      node_execution_id: producerNode.node_execution_id,
      port_id: "producer:member",
      publisher_endpoint_id: producer,
      event_type: "member.ready",
      content: { batch_id: "batch-1", member_key: "crate" },
      idempotency_key: "member:crate:duplicate",
      lifecycle_outcome: "waiting",
      artefact_version_ids: [crateVersion.artefact_version_id],
    }, handle.broadcast);
    expect(handle.store.db.prepare(`SELECT state FROM event_queue WHERE queue_id = ?`)
      .get(duplicateMember.delivery_ids[0])).toEqual({ state: "cancelled" });

    handle.store.publishScopeNodeOutput({
      workspace_id: workspaceId,
      node_execution_id: producerNode.node_execution_id,
      port_id: "producer:collection",
      publisher_endpoint_id: producer,
      event_type: "collection.ready",
      content: { batch_id: "batch-1" },
      idempotency_key: "collection:batch-1",
      lifecycle_outcome: "waiting",
      artefact_version_ids: [collectionVersion.artefact_version_id],
    }, handle.broadcast);
    const awaitingBarrel = handle.store.getScopeExecutionProjection(started.execution.execution_id)!
      .node_executions.find((node) => node.node_id === "gatherer")!;
    expect(awaitingBarrel.context_id).toBe(contextId);
    expect(awaitingBarrel.join_state).toMatchObject({
      ready: false,
      missing: [expect.objectContaining({ member_key: "barrel", expected_artefact_version_id: barrelVersion.artefact_version_id })],
    });

    handle.store.publishScopeNodeOutput({
      workspace_id: workspaceId,
      node_execution_id: producerNode.node_execution_id,
      port_id: "producer:member",
      publisher_endpoint_id: producer,
      event_type: "member.ready",
      content: { batch_id: "batch-1", member_key: "barrel" },
      idempotency_key: "member:barrel",
      lifecycle_outcome: "completed",
      artefact_version_ids: [barrelVersion.artefact_version_id],
    }, handle.broadcast);

    // Constructing a fresh store over the same database simulates process-local
    // state loss: readiness is reconstructed entirely from retained records.
    const afterRestart = new ScopeExecutionStore(handle.store.db);
    const finalNode = afterRestart.getNodeExecution(gatherNode.node_execution_id)!;
    const finalJoin = afterRestart.getJoinState(gatherNode.node_execution_id);
    expect(finalNode).toMatchObject({ status: "ready", context_id: contextId, join_key: "batch-1" });
    expect(finalJoin.ready).toBe(true);
    expect(finalJoin.missing).toEqual([]);
    expect(finalJoin.received).toHaveLength(3);
    expect(firstMember.delivery_ids).toHaveLength(1);
    const queued = handle.store.db.prepare(`
      SELECT state FROM event_queue WHERE node_execution_id = ? ORDER BY queue_id
    `).all(gatherNode.node_execution_id) as Array<{ state: string }>;
    expect(queued.filter((row) => row.state === "queued")).toHaveLength(3);
    expect(queued.filter((row) => row.state === "cancelled")).toHaveLength(1);
  });

  it("activates all required Ports together and reuses only the explicitly keyed Context", () => {
    const judge = registerEndpoint(handle, workspaceId, "judge");
    const ingressContextId = handle.store.contextStore.createContext({
      workspace_id: workspaceId,
      scope_id: "delivery",
      created_by_endpoint_id: null,
      participants: [],
      title: "Required-port ingress",
    });
    const draft = handle.store.createScopeCompositionDraft({
      workspace_id: workspaceId,
      scope_id: "delivery",
      content: {
        nodes: [
          {
            node_id: "ingress",
            kind: "event",
            context_policy: { mode: "fixed", context_id: ingressContextId },
          },
          {
            node_id: "judge",
            kind: "actor",
            resource_id: judge,
            activation: { mode: "all_required_ports" },
            context_policy: { mode: "reuse_by_key", key_template: "case:{{content.case_id}}" },
          },
        ],
        ports: [
          { port_id: "ingress:out", node_id: "ingress", name: "case", direction: "output", event_types: ["case.ready"] },
          { port_id: "judge:left", node_id: "judge", name: "left", direction: "input", event_types: ["case.ready"], min_count: 1, max_count: 1 },
          { port_id: "judge:right", node_id: "judge", name: "right", direction: "input", event_types: ["case.ready"], min_count: 1, max_count: 1 },
        ],
        edges: [
          { edge_id: "to-left", source_port_id: "ingress:out", target_port_id: "judge:left" },
          { edge_id: "to-right", source_port_id: "ingress:out", target_port_id: "judge:right" },
        ],
      },
    }, handle.broadcast);
    handle.store.publishScopeComposition({
      revision_id: draft.revision_id,
      expected_published_revision_id: null,
    }, handle.broadcast);

    const first = handle.store.startScopeExecution({
      workspace_id: workspaceId,
      scope_id: "delivery",
      ingress_node_id: "ingress",
      output_port_id: "ingress:out",
      content: { case_id: "case-1" },
      idempotency_key: "required-ports:first",
    }, handle.broadcast);
    const firstJudge = handle.store.getScopeExecutionProjection(first.execution.execution_id)!
      .node_executions.find((node) => node.node_id === "judge")!;
    expect(firstJudge.status).toBe("ready");
    expect(firstJudge.join_state).toMatchObject({ ready: true, missing: [] });
    expect(firstJudge.join_state.received.map((input) => input.port_id)).toEqual([
      "judge:left",
      "judge:right",
    ]);
    expect(first.delivery_ids).toHaveLength(2);

    const second = handle.store.startScopeExecution({
      workspace_id: workspaceId,
      scope_id: "delivery",
      ingress_node_id: "ingress",
      output_port_id: "ingress:out",
      content: { case_id: "case-1" },
      idempotency_key: "required-ports:second",
    }, handle.broadcast);
    const secondJudge = handle.store.getScopeExecutionProjection(second.execution.execution_id)!
      .node_executions.find((node) => node.node_id === "judge")!;
    expect(secondJudge.node_execution_id).not.toBe(firstJudge.node_execution_id);
    expect(secondJudge.context_id).toBe(firstJudge.context_id);
  });
});
