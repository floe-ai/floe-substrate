import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { BusStore, type EventCommand } from "./store.js";
import { defaultConfig } from "./config.js";
import type { ScopeCompositionContent } from "./scope-compositions.js";
import { registerExecutableActorFixture } from "./executable-actor-test-fixture.js";

const WS = "workspace:turn-result";
const A = `actor:${WS}:a`;
const B = `actor:${WS}:b`;
const C = `actor:${WS}:c`;
const OPERATOR = `actor:${WS}:operator`;
const noop = () => {};

function requestCommand(input: {
  source: string;
  destination: string;
  correlation: string;
  currentContext: string;
  parentDelivery?: string;
  continuation?: string | null;
}): EventCommand {
  return {
    type: "request",
    workspace_id: WS,
    source_endpoint_id: input.source,
    destination: { kind: "endpoint", endpoint_id: input.destination },
    correlation_id: input.correlation,
    current_delivery_context_id: input.currentContext,
    content: { text: `work for ${input.destination}` },
    response: {
      expected: true,
      mode: "correlated",
      correlation_id: input.correlation
    },
    metadata: {
      origin: "pi_request_tool",
      request_return_context_id: input.currentContext,
      request_parent_delivery_id: input.parentDelivery ?? null,
      request_continuation_event_id: input.continuation ?? null
    }
  };
}

function parallelPlacementsComposition(
  ingressContextId: string,
): ScopeCompositionContent {
  return {
    nodes: [
      {
        node_id: "ingress",
        kind: "event",
        label: "Input",
        context_policy: { mode: "fixed", context_id: ingressContextId },
      },
      {
        node_id: "worker-left",
        kind: "actor",
        label: "Worker left",
        resource_id: B,
        activation: { mode: "per_delivery" },
        context_policy: { mode: "new_per_execution" },
      },
      {
        node_id: "worker-right",
        kind: "actor",
        label: "Worker right",
        resource_id: B,
        activation: { mode: "per_delivery" },
        context_policy: { mode: "new_per_execution" },
      },
    ],
    ports: [
      { port_id: "ingress:out", node_id: "ingress", name: "input", direction: "output", event_types: ["work.arrived"] },
      { port_id: "worker-left:in", node_id: "worker-left", name: "input", direction: "input", event_types: ["work.arrived"], min_count: 1 },
      { port_id: "worker-right:in", node_id: "worker-right", name: "input", direction: "input", event_types: ["work.arrived"], min_count: 1 },
    ],
    edges: [
      { edge_id: "to-left", source_port_id: "ingress:out", target_port_id: "worker-left:in" },
      { edge_id: "to-right", source_port_id: "ingress:out", target_port_id: "worker-right:in" },
    ],
  };
}

function delegatingActorComposition(
  ingressContextId: string,
): ScopeCompositionContent {
  return {
    nodes: [
      {
        node_id: "ingress",
        kind: "event",
        label: "Input",
        context_policy: { mode: "fixed", context_id: ingressContextId },
      },
      {
        node_id: "coordinator",
        kind: "actor",
        label: "Coordinator",
        resource_id: A,
        activation: { mode: "per_delivery" },
        context_policy: { mode: "new_per_execution" },
      },
    ],
    ports: [
      { port_id: "ingress:out", node_id: "ingress", name: "input", direction: "output", event_types: ["work.arrived"] },
      { port_id: "coordinator:in", node_id: "coordinator", name: "input", direction: "input", event_types: ["work.arrived"], min_count: 1 },
    ],
    edges: [
      { edge_id: "to-coordinator", source_port_id: "ingress:out", target_port_id: "coordinator:in" },
    ],
  };
}

describe("runtime turn results and causal requests", () => {
  let store: BusStore;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "floe-turn-result-"));
    const configPath = join(root, "config.yaml");
    const config = defaultConfig(root);
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    store = new BusStore(configPath, config);
    for (const [endpoint_id, bridge_id] of [[OPERATOR, null], [A, "bridge:a"], [B, "bridge:b"], [C, "bridge:c"]] as const) {
      store.registerEndpoint({ endpoint_id, workspace_id: WS, name: endpoint_id, bridge_id, status: "idle" }, noop);
    }
    registerExecutableActorFixture(store, WS, A);
    registerExecutableActorFixture(store, WS, B);
  });

  afterEach(() => {
    try { store.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  it("records ordinary completion in its originating Context with no result delivery", () => {
    const submitted = store.submitEvent({
      type: "message",
      workspace_id: WS,
      source_endpoint_id: OPERATOR,
      destination: { kind: "endpoint", endpoint_id: B },
      content: { text: "answer naturally" },
      response: { expected: true }
    }, noop);
    const [delivery] = store.claimDeliveries("bridge:b", 10, noop);

    const recorded = store.recordRuntimeTurnResult({
      delivery_id: delivery.delivery_id,
      outcome: "completed",
      text: "A natural answer."
    }, noop);

    expect(recorded.request_resolved).toBe(false);
    expect(recorded.return_event).toBeNull();
    expect(recorded.result_event).toMatchObject({
      type: "message",
      context_id: submitted.event.context_id,
      source_endpoint_id: B,
      destination_json: { kind: "context", context_id: submitted.event.context_id },
      content: { text: "A natural answer." },
      response: { expected: false }
    });
    expect(store.db.prepare("SELECT count(*) AS c FROM event_queue WHERE event_id = ?")
      .get(recorded.result_event.event_id)).toEqual({ c: 0 });
    expect(store.listPendingResponses({ workspace_id: WS })).toEqual([
      expect.objectContaining({ source_event_id: submitted.event.event_id, status: "resolved" })
    ]);
  });

  it("does not duplicate a stored result when its delivery acknowledgement is retried", () => {
    const submitted = store.submitEvent({
      type: "message",
      workspace_id: WS,
      source_endpoint_id: OPERATOR,
      destination: { kind: "endpoint", endpoint_id: B },
      content: { text: "answer once" }
    }, noop);
    const [firstDelivery] = store.claimDeliveries("bridge:b", 10, noop);
    const first = store.recordRuntimeTurnResult({
      delivery_id: firstDelivery.delivery_id,
      outcome: "completed",
      text: "One durable answer."
    }, noop);

    store.reportDeliveryStatus({
      bridge_id: "bridge:b",
      delivery_id: firstDelivery.delivery_id,
      state: "failed",
      error: "acknowledgement lost"
    }, noop);
    store.reportTurnEnd(B, noop);
    const [retryDelivery] = store.claimDeliveries("bridge:b", 10, noop);
    const retried = store.recordRuntimeTurnResult({
      delivery_id: retryDelivery.delivery_id,
      outcome: "completed",
      text: "One durable answer."
    }, noop);

    expect(retried.result_event.event_id).toBe(first.result_event.event_id);
    const rows = store.db.prepare(`
      SELECT event_id FROM events
      WHERE context_id = ? AND source_endpoint_id = ? AND type = 'message'
    `).all(submitted.event.context_id, B);
    expect(rows).toEqual([{ event_id: first.result_event.event_id }]);
  });

  it("records canonical placement results in each target Context without collapsing two placements of one Actor", () => {
    store.createScope({ workspace_id: WS, scope_id: "parallel", title: "Parallel" }, noop);
    const ingressContextId = store.contextStore.createContext({
      workspace_id: WS,
      scope_id: "parallel",
      created_by_endpoint_id: OPERATOR,
      participants: [OPERATOR],
      title: "Ingress",
    });
    const draft = store.createScopeCompositionDraft({
      workspace_id: WS,
      scope_id: "parallel",
      content: parallelPlacementsComposition(ingressContextId),
    }, noop);
    store.publishScopeComposition({ revision_id: draft.revision_id }, noop);
    const started = store.startScopeExecution({
      workspace_id: WS,
      scope_id: "parallel",
      ingress_node_id: "ingress",
      output_port_id: "ingress:out",
      content: { work: "run both placements" },
      idempotency_key: "parallel-result-contexts",
    }, noop);

    const [leftDelivery] = store.claimDeliveries("bridge:b", 1, noop);
    const leftInjected = store.reportDeliveryStatus({
      bridge_id: "bridge:b",
      delivery_id: leftDelivery.delivery_id,
      state: "injected_to_runtime",
    }, noop) as { execution_attempt_id: string };
    const left = store.recordRuntimeTurnResult({
      delivery_id: leftDelivery.delivery_id,
      outcome: "completed",
      text: "Left placement result",
      metadata: { execution_attempt_id: leftInjected.execution_attempt_id },
    }, noop);
    store.reportDeliveryStatus({
      bridge_id: "bridge:b",
      delivery_id: leftDelivery.delivery_id,
      state: "acknowledged",
    }, noop);
    store.reportTurnEnd(B, noop);

    const [rightDelivery] = store.claimDeliveries("bridge:b", 1, noop);
    const rightInjected = store.reportDeliveryStatus({
      bridge_id: "bridge:b",
      delivery_id: rightDelivery.delivery_id,
      state: "injected_to_runtime",
    }, noop) as { execution_attempt_id: string };
    const right = store.recordRuntimeTurnResult({
      delivery_id: rightDelivery.delivery_id,
      outcome: "completed",
      text: "Right placement result",
      metadata: { execution_attempt_id: rightInjected.execution_attempt_id },
    }, noop);

    expect(leftDelivery.trigger_event_id).toBe(started.root_event.event_id);
    expect(rightDelivery.trigger_event_id).toBe(started.root_event.event_id);
    expect(leftDelivery.node_execution_id).not.toBe(rightDelivery.node_execution_id);
    expect(leftDelivery.context_id).not.toBe(rightDelivery.context_id);
    expect(left.result_event.event_id).not.toBe(right.result_event.event_id);
    expect(left.result_event.context_id).toBe(leftDelivery.context_id);
    expect(right.result_event.context_id).toBe(rightDelivery.context_id);
    expect(left.result_event.context_id).not.toBe(ingressContextId);
    expect(right.result_event.context_id).not.toBe(ingressContextId);
  });

  it("resumes a delegated request in the same NodeExecution and pinned revision", () => {
    store.createScope({ workspace_id: WS, scope_id: "delegation", title: "Delegation" }, noop);
    const ingressContextId = store.contextStore.createContext({
      workspace_id: WS,
      scope_id: "delegation",
      created_by_endpoint_id: OPERATOR,
      participants: [OPERATOR],
      title: "Ingress",
    });
    const draft = store.createScopeCompositionDraft({
      workspace_id: WS,
      scope_id: "delegation",
      content: delegatingActorComposition(ingressContextId),
    }, noop);
    store.publishScopeComposition({ revision_id: draft.revision_id }, noop);
    const started = store.startScopeExecution({
      workspace_id: WS,
      scope_id: "delegation",
      ingress_node_id: "ingress",
      output_port_id: "ingress:out",
      content: { work: "coordinate" },
      idempotency_key: "delegation-continuation",
    }, noop);
    const [firstA] = store.claimDeliveries("bridge:a", 1, noop);
    const firstAttempt = store.reportDeliveryStatus({
      bridge_id: "bridge:a",
      delivery_id: firstA.delivery_id,
      state: "injected_to_runtime",
    }, noop) as { execution_attempt_id: string };

    const childRequest = requestCommand({
      source: A,
      destination: B,
      correlation: "corr-canonical-delegation",
      currentContext: firstA.context_id!,
      parentDelivery: firstA.delivery_id,
    });
    childRequest.metadata = {
      ...(childRequest.metadata ?? {}),
      request_parent_scope_execution_id: firstA.scope_execution_id,
      request_parent_composition_revision_id: firstA.composition_revision_id,
      request_parent_node_execution_id: firstA.node_execution_id,
      request_parent_target_node_id: firstA.target_node_id,
      request_parent_execution_attempt_id: firstAttempt.execution_attempt_id,
    };
    store.submitEvent(childRequest, noop);
    const [deliveryB] = store.claimDeliveries("bridge:b", 1, noop);
    store.reportDeliveryStatus({
      bridge_id: "bridge:b",
      delivery_id: deliveryB.delivery_id,
      state: "injected_to_runtime",
    }, noop);
    const childResult = store.recordRuntimeTurnResult({
      delivery_id: deliveryB.delivery_id,
      outcome: "completed",
      text: "Delegated evidence",
    }, noop);
    expect(childResult.request_resolved).toBe(true);

    store.recordRuntimeTurnResult({
      delivery_id: firstA.delivery_id,
      outcome: "completed",
      text: "Waiting for delegated evidence",
    }, noop);
    store.reportDeliveryStatus({
      bridge_id: "bridge:a",
      delivery_id: firstA.delivery_id,
      state: "acknowledged",
    }, noop);
    store.reportTurnEnd(A, noop);

    const [resumedA] = store.claimDeliveries("bridge:a", 1, noop);
    expect(resumedA.events[0]).toMatchObject({
      event_id: childResult.return_event?.event_id,
      type: "request.result",
      context_id: firstA.context_id,
    });
    expect(resumedA.scope_execution_id).toBe(firstA.scope_execution_id);
    expect(resumedA.composition_revision_id).toBe(firstA.composition_revision_id);
    expect(resumedA.node_execution_id).toBe(firstA.node_execution_id);
    expect(resumedA.target_node_id).toBe(firstA.target_node_id);
    expect(resumedA.context_id).toBe(firstA.context_id);

    const resumedAttempt = store.reportDeliveryStatus({
      bridge_id: "bridge:a",
      delivery_id: resumedA.delivery_id,
      state: "injected_to_runtime",
    }, noop) as { execution_attempt_id: string };
    expect(resumedAttempt.execution_attempt_id).not.toBe(firstAttempt.execution_attempt_id);
    store.recordRuntimeTurnResult({
      delivery_id: resumedA.delivery_id,
      outcome: "completed",
      text: "Coordinated result",
    }, noop);
    store.reportDeliveryStatus({
      bridge_id: "bridge:a",
      delivery_id: resumedA.delivery_id,
      state: "acknowledged",
    }, noop);

    const projection = store.getScopeExecutionProjection(started.execution.execution_id)!;
    const coordinator = projection.node_executions.find((node) => node.node_id === "coordinator")!;
    expect(coordinator.node_execution_id).toBe(firstA.node_execution_id);
    expect(coordinator.context_id).toBe(firstA.context_id);
    expect(coordinator.attempts).toHaveLength(2);
    expect(coordinator.status).toBe("completed");
  });

  it("only the requested actor's natural completion resolves and resumes the exact request", () => {
    const parent = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: A,
      participants: [A, OPERATOR]
    });
    const request = store.submitEvent(requestCommand({
      source: A,
      destination: B,
      correlation: "corr-exact",
      currentContext: parent
    }), noop).event;
    const [deliveryB] = store.claimDeliveries("bridge:b", 10, noop);

    store.submitEvent({
      type: "message",
      workspace_id: WS,
      source_endpoint_id: C,
      destination: { kind: "endpoint", endpoint_id: A },
      correlation_id: "corr-exact",
      content: { text: "unrelated but same correlation" }
    }, noop);
    expect(store.listPendingResponses({ workspace_id: WS })).toEqual([
      expect.objectContaining({ source_event_id: request.event_id, status: "pending" })
    ]);

    const recorded = store.recordRuntimeTurnResult({
      delivery_id: deliveryB.delivery_id,
      outcome: "completed",
      text: "B's exact result"
    }, noop);

    expect(recorded.request_resolved).toBe(true);
    expect(recorded.result_event.context_id).toBe(request.context_id);
    expect(recorded.result_event.source_endpoint_id).toBe(B);
    expect(recorded.return_event).toMatchObject({
      type: "request.result",
      context_id: parent,
      source_endpoint_id: null,
      destination_json: { kind: "endpoint", endpoint_id: A },
      content: {
        text: "B's exact result",
        data: expect.objectContaining({
          request_event_id: request.event_id,
          responding_endpoint_id: B,
          result_context_id: request.context_id
        })
      }
    });
    expect(store.listPendingResponses({ workspace_id: WS })).toEqual([
      expect.objectContaining({ source_event_id: request.event_id, status: "resolved" })
    ]);
  });

  it("preserves a durable nested A to B to C return chain", () => {
    const parent = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: A,
      participants: [A, OPERATOR]
    });
    const requestAB = store.submitEvent(requestCommand({
      source: A,
      destination: B,
      correlation: "corr-ab",
      currentContext: parent
    }), noop).event;
    const [deliveryB1] = store.claimDeliveries("bridge:b", 10, noop);

    const requestBC = store.submitEvent(requestCommand({
      source: B,
      destination: C,
      correlation: "corr-bc",
      currentContext: requestAB.context_id,
      parentDelivery: deliveryB1.delivery_id,
      continuation: requestAB.event_id
    }), noop).event;
    const [deliveryC] = store.claimDeliveries("bridge:c", 10, noop);

    // C can finish before B's first processing cycle has fully ended. That
    // fast return must not let B's interim completion satisfy A's request.
    const resultC = store.recordRuntimeTurnResult({
      delivery_id: deliveryC.delivery_id,
      outcome: "completed",
      text: "C's result"
    }, noop);
    expect(resultC.request_resolved).toBe(true);
    expect(resultC.return_event?.metadata.request_continuation_event_id).toBe(requestAB.event_id);

    const interimB = store.recordRuntimeTurnResult({
      delivery_id: deliveryB1.delivery_id,
      outcome: "completed",
      text: "Waiting on C."
    }, noop);
    expect(interimB.request_resolved).toBe(false);
    expect(store.listPendingResponses({ workspace_id: WS })).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_event_id: requestAB.event_id, status: "pending" }),
      expect.objectContaining({ source_event_id: requestBC.event_id, status: "resolved" })
    ]));
    store.reportDeliveryStatus({ bridge_id: "bridge:b", delivery_id: deliveryB1.delivery_id, state: "acknowledged" }, noop);
    store.reportTurnEnd(B, noop);

    const [deliveryB2] = store.claimDeliveries("bridge:b", 10, noop);
    expect(deliveryB2.events[0]).toMatchObject({
      type: "request.result",
      context_id: requestAB.context_id,
      content: { text: "C's result" }
    });
    const resultB = store.recordRuntimeTurnResult({
      delivery_id: deliveryB2.delivery_id,
      outcome: "completed",
      text: "B completed using C."
    }, noop);

    expect(resultB.request_resolved).toBe(true);
    expect(resultB.return_event).toMatchObject({
      context_id: parent,
      destination_json: { kind: "endpoint", endpoint_id: A },
      content: { text: "B completed using C." }
    });
    expect(store.listPendingResponses({ workspace_id: WS })).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_event_id: requestAB.event_id, status: "resolved" }),
      expect.objectContaining({ source_event_id: requestBC.event_id, status: "resolved" })
    ]));
  });

  it("returns terminal requested-actor failure through the same causal path", () => {
    const parent = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: A,
      participants: [A]
    });
    const request = store.submitEvent(requestCommand({
      source: A,
      destination: B,
      correlation: "corr-failure",
      currentContext: parent
    }), noop).event;
    const [deliveryB] = store.claimDeliveries("bridge:b", 10, noop);

    const failed = store.recordRuntimeTurnResult({
      delivery_id: deliveryB.delivery_id,
      outcome: "failed",
      text: "B failed after bounded delivery attempts."
    }, noop);

    expect(failed.request_resolved).toBe(true);
    expect(failed.result_event.metadata.outcome).toBe("failed");
    expect(failed.return_event).toMatchObject({
      context_id: parent,
      content: {
        text: "B failed after bounded delivery attempts.",
        data: expect.objectContaining({ outcome: "failed", request_event_id: request.event_id })
      }
    });
  });

  it("dead-letters a failed turn after three bounded delivery attempts", () => {
    store.submitEvent({
      type: "message",
      workspace_id: WS,
      source_endpoint_id: OPERATOR,
      destination: { kind: "endpoint", endpoint_id: B },
      content: { text: "work that keeps failing" }
    }, noop);

    for (let expectedAttempt = 1; expectedAttempt <= 3; expectedAttempt += 1) {
      const [delivery] = store.claimDeliveries("bridge:b", 10, noop);
      expect(store.db.prepare("SELECT attempt_count FROM delivery_bundles WHERE delivery_id = ?")
        .get(delivery.delivery_id)).toEqual({ attempt_count: expectedAttempt });

      const reported = store.reportDeliveryStatus({
        bridge_id: "bridge:b",
        delivery_id: delivery.delivery_id,
        state: "failed",
        error: `attempt ${expectedAttempt} failed`
      }, noop) as { state: string; attempt_count: number };

      expect(reported.attempt_count).toBe(expectedAttempt);
      expect(reported.state).toBe(expectedAttempt === 3 ? "dead_lettered" : "failed");
      store.reportTurnEnd(B, noop);
    }

    expect(store.claimDeliveries("bridge:b", 10, noop)).toEqual([]);
  });
});
