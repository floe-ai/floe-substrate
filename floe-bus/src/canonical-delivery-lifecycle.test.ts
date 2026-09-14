import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import { defaultConfig, type LocalConfig } from "./config.js";
import type { ScopeCompositionContent } from "./scope-compositions.js";
import { registerExecutableActorFixture } from "./executable-actor-test-fixture.js";
import type { DeliveryBundle } from "./store.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

const BRIDGE = "bridge:canonical-lifecycle";

async function makeServer(): Promise<{ handle: ServerHandle; tmp: string; workspaceId: string; actorId: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-canonical-lifecycle-"));
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
    payload: { locator, name: "canonical lifecycle" },
  });
  const workspaceId = registered.json().workspace.workspace_id as string;
  const actorId = `actor:${workspaceId}:worker`;
  handle.store.createScope({ workspace_id: workspaceId, scope_id: "pipeline", title: "Pipeline" }, handle.broadcast);
  handle.store.registerEndpoint({
    endpoint_id: actorId,
    workspace_id: workspaceId,
    name: "Worker",
    bridge_id: BRIDGE,
    status: "idle",
  }, handle.broadcast);
  registerExecutableActorFixture(handle.store, workspaceId, actorId);
  return { handle, tmp, workspaceId, actorId };
}

function joinedComposition(ingressContextId: string, actorId: string): ScopeCompositionContent {
  return {
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
        activation: { mode: "all_required_ports" },
        context_policy: { mode: "new_per_execution" },
      },
    ],
    ports: [
      { port_id: "ingress:out", node_id: "ingress", name: "input", direction: "output", event_types: ["input.arrived"] },
      { port_id: "worker:left", node_id: "worker", name: "left", direction: "input", event_types: ["input.arrived"], min_count: 1 },
      { port_id: "worker:right", node_id: "worker", name: "right", direction: "input", event_types: ["input.arrived"], min_count: 1 },
      { port_id: "worker:result", node_id: "worker", name: "result", direction: "output", event_types: ["work.completed"], min_count: 1 },
    ],
    edges: [
      { edge_id: "input-left", source_port_id: "ingress:out", target_port_id: "worker:left" },
      { edge_id: "input-right", source_port_id: "ingress:out", target_port_id: "worker:right" },
    ],
  };
}

describe("canonical Delivery and ExecutionAttempt lifecycle", () => {
  let handle: ServerHandle;
  let tmp: string;
  let workspaceId: string;
  let actorId: string;

  beforeEach(async () => {
    ({ handle, tmp, workspaceId, actorId } = await makeServer());
  });

  afterEach(async () => {
    try { await handle.app.close(); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  });

  function start(
    broadcast: (type: string, payload: Record<string, unknown>) => void = handle.broadcast,
    deliveryPath: "claim" | "push" = "claim",
  ): { executionId: string; deliveryId: string; nodeExecutionId: string } {
    let pushed: DeliveryBundle | undefined;
    const observe = (type: string, payload: Record<string, unknown>) => {
      if (type === "delivery_bundle_available") pushed = payload.delivery as DeliveryBundle;
      broadcast(type, payload);
    };
    const ingressContextId = handle.store.contextStore.createContext({
      workspace_id: workspaceId,
      scope_id: "pipeline",
      created_by_endpoint_id: null,
      participants: [],
      title: "Ingress",
    });
    const draft = handle.store.createScopeCompositionDraft({
      workspace_id: workspaceId,
      scope_id: "pipeline",
      content: joinedComposition(ingressContextId, actorId),
    }, observe);
    handle.store.publishScopeComposition({ revision_id: draft.revision_id }, observe);
    const started = handle.store.startScopeExecution({
      workspace_id: workspaceId,
      scope_id: "pipeline",
      ingress_node_id: "ingress",
      output_port_id: "ingress:out",
      content: { item: "one coherent input" },
      idempotency_key: `start:${Math.random()}`,
    }, observe);
    const claimed = deliveryPath === "push" ? pushed! : handle.store.claimDeliveries(BRIDGE, 1, observe)[0]!;
    const worker = handle.store.getScopeExecutionProjection(started.execution.execution_id)!
      .node_executions.find((node) => node.node_id === "worker")!;
    expect(claimed.stable_delivery_ids).toHaveLength(2);
    expect(new Set(claimed.target_port_ids)).toEqual(new Set(["worker:left", "worker:right"]));
    expect(claimed.context_id).toBe(worker.context_id);
    return {
      executionId: started.execution.execution_id,
      deliveryId: claimed.delivery_id,
      nodeExecutionId: worker.node_execution_id,
    };
  }

  it.each(["claim", "push"] as const)("records one joined attempt and waits for required output through %s", deliveryPath => {
    const started = start(handle.broadcast, deliveryPath);
    const prepared = handle.store.prepareRuntimeDelivery({
      bridge_id: BRIDGE,
      delivery_id: started.deliveryId,
    }, handle.broadcast);
    expect(prepared.processing_contract.contract_kind).toBe("scope_node");
    if (prepared.processing_contract.contract_kind !== "scope_node") {
      throw new Error("Expected a Scope Node processing contract.");
    }
    expect(prepared.processing_contract.execution_attempt).toMatchObject({
      status: "pending",
      node_execution_id: started.nodeExecutionId,
    });
    expect(handle.store.actorRoleAuthorityStore.listPrincipalBindings(workspaceId, {
      principal_id: actorId,
      actor_id: actorId,
    })).toEqual([
      expect.objectContaining({
        workspace_id: workspaceId,
        principal_id: actorId,
        actor_id: actorId,
        status: "active",
        evidence_refs: expect.arrayContaining([
          expect.objectContaining({
            kind: "actor_definition_revision",
            id: prepared.processing_contract.actor.definition.actor_definition_revision_id,
          }),
          expect.objectContaining({
            kind: "actor_runtime_binding",
            id: prepared.processing_contract.runtime.binding.actor_runtime_binding_id,
          }),
        ]),
      }),
    ]);
    const firstAuthority = handle.store.operationAuthorityVerifier.verifyBearerToken(
      prepared.operation_authority_session.bearer_token,
      { boundary: { kind: "workspace", workspace_id: workspaceId } },
    );
    expect(firstAuthority).toMatchObject({
      verified: true,
      authority_session_id: prepared.operation_authority_session.authority_session_id,
      authority: {
        principal_id: actorId,
        boundary: { kind: "workspace", workspace_id: workspaceId },
      },
      provenance: {
        cause_event_id: prepared.delivery.trigger_event_id,
        delivery_ids: [...prepared.delivery.stable_delivery_ids].sort(),
        execution_attempt_id: prepared.processing_contract.execution_attempt.attempt_id,
        node_execution_id: started.nodeExecutionId,
        scope_execution_id: started.executionId,
      },
    });
    if (!firstAuthority.verified) throw new Error("Expected runtime operation authority.");
    expect(firstAuthority.authority.grants).toEqual(
      new Set(["context.inspect", "scope.node-output.publish"]),
    );
    const persistedPrepared = handle.store.db.prepare(`
      SELECT * FROM delivery_bundles WHERE delivery_id = ?
    `).get(started.deliveryId) as Record<string, unknown>;
    expect(persistedPrepared.operation_authority_session_id)
      .toBe(prepared.operation_authority_session.authority_session_id);
    expect(JSON.stringify(persistedPrepared))
      .not.toContain(prepared.operation_authority_session.bearer_token);
    expect(JSON.stringify(prepared.delivery.events))
      .not.toContain(prepared.operation_authority_session.bearer_token);
    const reprepared = handle.store.prepareRuntimeDelivery({
      bridge_id: BRIDGE,
      delivery_id: started.deliveryId,
    }, handle.broadcast);
    expect(reprepared.processing_contract.contract_kind).toBe("scope_node");
    if (reprepared.processing_contract.contract_kind !== "scope_node") {
      throw new Error("Expected a Scope Node processing contract.");
    }
    expect(reprepared.processing_contract.execution_attempt.attempt_id)
      .toBe(prepared.processing_contract.execution_attempt.attempt_id);
    expect(reprepared.operation_authority_session.authority_session_id)
      .not.toBe(prepared.operation_authority_session.authority_session_id);
    expect(handle.store.operationAuthorityVerifier.verifyBearerToken(
      prepared.operation_authority_session.bearer_token,
      { boundary: { kind: "workspace", workspace_id: workspaceId } },
    )).toMatchObject({ verified: false, code: "authority_session_revoked" });
    expect(handle.store.operationAuthorityVerifier.verifyBearerToken(
      reprepared.operation_authority_session.bearer_token,
      { boundary: { kind: "workspace", workspace_id: workspaceId } },
    )).toMatchObject({ verified: true });
    expect(handle.store.getScopeExecutionProjection(started.executionId)?.node_executions
      .find((node) => node.node_execution_id === started.nodeExecutionId)?.status).toBe("ready");
    const injected = handle.store.reportDeliveryStatus({
      bridge_id: BRIDGE,
      delivery_id: started.deliveryId,
      state: "injected_to_runtime",
    }, handle.broadcast) as { execution_attempt_id: string };
    const injectedContract = handle.store.getRuntimeProcessingContract(injected.execution_attempt_id);

    expect(injectedContract).toMatchObject({
      processing_contract_id: `runtime-processing-contract:v1:${injected.execution_attempt_id}`,
      node_execution: { node_execution_id: started.nodeExecutionId },
      execution_attempt: { status: "running" },
      actor: { actor_id: actorId },
      outputs: { ports: [expect.objectContaining({ port_id: "worker:result" })] },
    });
    expect(new Set(injectedContract.inputs.map((input) => input.port.port_id)))
      .toEqual(new Set(["worker:left", "worker:right"]));
    expect(injectedContract.actor.definition.actor_definition_revision_id)
      .toBe(injectedContract.node_execution.actor_definition_revision_id);
    expect(injectedContract.runtime.binding.actor_runtime_binding_id)
      .toBe(injectedContract.node_execution.actor_runtime_binding_id);
    expect(injectedContract.runtime.profile.runtime_profile_revision_id)
      .toBe(injectedContract.node_execution.runtime_profile_revision_id);

    const running = handle.store.getScopeExecutionProjection(started.executionId)!;
    const worker = running.node_executions.find((node) => node.node_execution_id === started.nodeExecutionId)!;
    expect(worker.status).toBe("active");
    expect(worker.attempts).toEqual([
      expect.objectContaining({
        attempt_id: injected.execution_attempt_id,
        status: "running",
      }),
    ]);
    const attemptDeliveries = handle.store.db.prepare(`
      SELECT delivery_id FROM execution_attempt_deliveries WHERE attempt_id = ? ORDER BY delivery_id
    `).all(injected.execution_attempt_id) as Array<{ delivery_id: string }>;
    expect(attemptDeliveries).toHaveLength(2);

    expect(() => handle.store.prepareRuntimeDelivery({
      bridge_id: "bridge:not-owner",
      delivery_id: started.deliveryId,
    }, handle.broadcast)).toThrow(/does not own Delivery/);
    const renewed = handle.store.prepareRuntimeDelivery({
      bridge_id: BRIDGE,
      delivery_id: started.deliveryId,
    }, handle.broadcast);
    expect(renewed.processing_contract.contract_kind).toBe("scope_node");
    if (renewed.processing_contract.contract_kind !== "scope_node") {
      throw new Error("Expected a Scope Node processing contract.");
    }
    expect(renewed.processing_contract.processing_contract_id)
      .toBe(injectedContract.processing_contract_id);
    expect(renewed.processing_contract.execution_attempt.attempt_id)
      .toBe(injected.execution_attempt_id);
    expect(renewed.delivery).toMatchObject({
      delivery_id: started.deliveryId,
      execution_attempt_id: injected.execution_attempt_id,
    });
    expect((handle.store.db.prepare(`
      SELECT state FROM delivery_bundles WHERE delivery_id = ?
    `).get(started.deliveryId) as { state: string }).state).toBe("injected_to_runtime");
    expect(handle.store.scopeExecutionStore.listAttempts(started.nodeExecutionId)).toHaveLength(1);
    expect(handle.store.operationAuthorityVerifier.verifyBearerToken(
      reprepared.operation_authority_session.bearer_token,
      { boundary: { kind: "workspace", workspace_id: workspaceId } },
    )).toMatchObject({ verified: false, code: "authority_session_revoked" });
    expect(handle.store.operationAuthorityVerifier.verifyBearerToken(
      renewed.operation_authority_session.bearer_token,
      { boundary: { kind: "workspace", workspace_id: workspaceId } },
    )).toMatchObject({
      verified: true,
      provenance: {
        execution_attempt_id: injected.execution_attempt_id,
        node_execution_id: started.nodeExecutionId,
        scope_execution_id: started.executionId,
      },
    });

    handle.store.reportDeliveryStatus({
      bridge_id: BRIDGE,
      delivery_id: started.deliveryId,
      state: "acknowledged",
    }, handle.broadcast);
    expect(handle.store.operationAuthorityVerifier.verifyBearerToken(
      renewed.operation_authority_session.bearer_token,
      { boundary: { kind: "workspace", workspace_id: workspaceId } },
    )).toMatchObject({ verified: false, code: "authority_session_revoked" });
    expect(() => handle.store.prepareRuntimeDelivery({
      bridge_id: BRIDGE,
      delivery_id: started.deliveryId,
    }, handle.broadcast)).toThrow(/'acknowledged'.*cannot be prepared/);

    const settled = handle.store.getScopeExecutionProjection(started.executionId)!;
    const settledWorker = settled.node_executions.find((node) => node.node_execution_id === started.nodeExecutionId)!;
    expect(settledWorker.status).toBe("waiting_external");
    expect(settledWorker.failure).toEqual({
      code: "required_output_not_published",
      required_port_ids: ["worker:result"],
    });
    expect(settled.execution.status).toBe("waiting_external");
    expect((settledWorker.attempts[0] as { status: string }).status).toBe("completed");
  });

  it("rolls back a pushed claim when runtime preparation fails, without announcing the claim", () => {
    const announcements: string[] = [];
    const broadcast = (type: string) => { announcements.push(type); };
    const started = start(broadcast, "push");
    announcements.length = 0;
    const startAttempt = vi.spyOn(handle.store.scopeExecutionStore, "startAttempt")
      .mockImplementationOnce(() => { throw new Error("processing contract could not be prepared"); });
    try {
      expect(() => handle.store.prepareRuntimeDelivery({
        bridge_id: BRIDGE,
        delivery_id: started.deliveryId,
      }, broadcast)).toThrow("processing contract could not be prepared");
    } finally {
      startAttempt.mockRestore();
    }
    expect(handle.store.db.prepare(`
      SELECT state, claimed_at, operation_authority_session_id FROM delivery_bundles WHERE delivery_id = ?
    `).get(started.deliveryId)).toMatchObject({
      state: "reserved", claimed_at: null, operation_authority_session_id: null,
    });
    expect(handle.store.db.prepare("SELECT state FROM event_queue WHERE delivery_id = ?")
      .all(started.deliveryId)).toEqual([
      expect.objectContaining({ state: "reserved" }), expect.objectContaining({ state: "reserved" }),
    ]);
    expect(announcements).toEqual([]);
    const prepared = handle.store.prepareRuntimeDelivery({
      bridge_id: BRIDGE,
      delivery_id: started.deliveryId,
    }, broadcast);
    expect(prepared.processing_contract.contract_kind).toBe("scope_node");
    expect(announcements).toContain("delivery_delivered_to_bridge");
  });

  it("never silently restores a revoked runtime principal-to-Actor binding", () => {
    const started = start();
    handle.store.prepareRuntimeDelivery({
      bridge_id: BRIDGE,
      delivery_id: started.deliveryId,
    }, handle.broadcast);
    const binding = handle.store.actorRoleAuthorityStore.listPrincipalBindings(workspaceId, {
      principal_id: actorId,
      actor_id: actorId,
    })[0]!;
    handle.store.actorRoleAuthorityStore.revokePrincipalBinding({
      workspace_id: workspaceId,
      principal_actor_binding_id: binding.principal_actor_binding_id,
      revoked_by_principal_id: handle.store.localOperatorPrincipalId,
      reason: "Actor runtime identity was disabled",
    });

    expect(() => handle.store.prepareRuntimeDelivery({
      bridge_id: BRIDGE,
      delivery_id: started.deliveryId,
    }, handle.broadcast)).toThrow(/explicitly revoked.*authorised management decision/);
    expect(handle.store.actorRoleAuthorityStore.listPrincipalBindings(workspaceId, {
      principal_id: actorId,
      actor_id: actorId,
    })).toEqual([]);
  });

  it("never requeues work after runtime injection when the outcome is unknown or failed", () => {
    const broadcasts: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const broadcast = (type: string, payload: Record<string, unknown> = {}) => broadcasts.push({ type, payload });
    handle.store.setBroadcast(broadcast);
    const started = start(broadcast);
    handle.store.reportDeliveryStatus({
      bridge_id: BRIDGE,
      delivery_id: started.deliveryId,
      state: "injected_to_runtime",
    }, broadcast);
    expect(() => handle.store.prepareRuntimeDelivery({
      bridge_id: BRIDGE,
      delivery_id: started.deliveryId,
    }, broadcast)).toThrow(/no prepared runtime authority to renew/);
    broadcasts.length = 0;

    handle.store.reportDeliveryStatus({
      bridge_id: BRIDGE,
      delivery_id: started.deliveryId,
      state: "failed",
      error: "provider connection ended after execution began",
    }, broadcast);

    const queueRows = handle.store.db.prepare(`
      SELECT state FROM event_queue WHERE delivery_id = ?
    `).all(started.deliveryId) as Array<{ state: string }>;
    expect(queueRows).toHaveLength(2);
    expect(queueRows.every((row) => row.state === "dead_lettered")).toBe(true);
    expect(broadcasts.some((item) => item.type === "delivery_bundle_available")).toBe(false);
    expect(broadcasts.find((item) => item.type === "delivery_failed")?.payload).toMatchObject({
      safe_to_retry_automatically: false,
    });
    const projection = handle.store.getScopeExecutionProjection(started.executionId)!;
    expect(projection.execution.status).toBe("failed");
    expect(projection.node_executions.find((node) => node.node_execution_id === started.nodeExecutionId)?.status).toBe("failed");
  });

  it.each([false, true])("retains a visible setup blocker and retries explicitly (injected: %s)", (injected) => {
    const started = start();
    const prepared = handle.store.prepareRuntimeDelivery({
      bridge_id: BRIDGE,
      delivery_id: started.deliveryId,
    }, handle.broadcast);
    if (prepared.processing_contract.contract_kind !== "scope_node") {
      throw new Error("Expected a Scope Node processing contract.");
    }

    if (injected) handle.store.reportDeliveryStatus({
      bridge_id: BRIDGE, delivery_id: started.deliveryId, state: "injected_to_runtime",
    }, handle.broadcast);

    handle.store.reportDeliveryStatus({
      bridge_id: BRIDGE,
      delivery_id: started.deliveryId,
      state: "deferred",
      error: "pinned SecretRef is unresolved",
    }, handle.broadcast);

    const attempt = handle.store.scopeExecutionStore.getAttempt(
      prepared.processing_contract.execution_attempt.attempt_id,
    );
    expect(attempt).toMatchObject({
      status: "failed",
      error: {
        code: "runtime_preparation_deferred",
        safe_to_retry: true,
      },
    });
    const node = handle.store.scopeExecutionStore.getNodeExecution(started.nodeExecutionId);
    expect(node).toMatchObject({ status: "blocked", failure: {
      code: "runtime_preparation_deferred", message: "pinned SecretRef is unresolved",
    } });
    expect(handle.store.getScopeExecutionProjection(started.executionId)?.execution.status).toBe("blocked");
    expect(handle.store.db.prepare(`
      SELECT COUNT(*) AS count FROM event_queue
      WHERE node_execution_id = ? AND state = 'held'
    `).get(started.nodeExecutionId)).toEqual({ count: 2 });

    handle.store.registerEndpoint({ endpoint_id: actorId, workspace_id: workspaceId,
      name: "Worker", bridge_id: BRIDGE, status: "idle" }, handle.broadcast);
    expect(handle.store.claimDeliveries(BRIDGE, 1, handle.broadcast)).toEqual([]);
    const retried = handle.store.retryScopeNodeExecution({
      workspace_id: workspaceId, node_execution_id: started.nodeExecutionId,
    }, handle.broadcast);
    expect(retried.node_execution).toMatchObject({ status: "retrying", context_id: node!.context_id,
      actor_definition_revision_id: node!.actor_definition_revision_id,
      actor_runtime_binding_id: node!.actor_runtime_binding_id });
    const next = handle.store.claimDeliveries(BRIDGE, 1, handle.broadcast)[0]!;
    const nextPrepared = handle.store.prepareRuntimeDelivery({
      bridge_id: BRIDGE, delivery_id: next.delivery_id,
    }, handle.broadcast);
    expect(nextPrepared.processing_contract.contract_kind).toBe("scope_node");
    expect(handle.store.scopeExecutionStore.listAttempts(started.nodeExecutionId).map(entry=>entry.status))
      .toEqual(["failed", "pending"]);
  });
});
