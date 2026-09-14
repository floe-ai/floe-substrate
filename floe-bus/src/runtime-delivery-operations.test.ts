import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { BusStore } from "./store.js";
import { defaultConfig } from "./config.js";
import { registerExecutableActorFixture } from "./executable-actor-test-fixture.js";
import { CANCEL_RUNTIME_DELIVERY_OPERATION_ID as OP } from "./runtime-delivery-operations.js";
import type { OperationAuthorityContext, OperationInvocationRequest } from "./operations.js";

const WS = "workspace:stop-response";
const ACTOR = `actor:${WS}:floe`;
const noop = () => {};

describe("direct runtime response cancellation", () => {
  let root: string;
  let store: BusStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "floe-stop-response-"));
    const config = defaultConfig(root);
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify(config));
    store = new BusStore(configPath, config);
    store.registerEndpoint({ endpoint_id: ACTOR, workspace_id: WS, name: "Floe", bridge_id: "bridge:test", status: "idle" }, noop);
    registerExecutableActorFixture(store, WS, ACTOR);
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  function start(claim = true) {
    const contextId = store.contextStore.createContext({ workspace_id: WS, scope_id: null, participants: [ACTOR], created_by_endpoint_id: null });
    store.submitPrincipalContextCommunication({ workspace_id: WS, context_id: contextId, principal_id: "operator:test", type: "message",
      recipient_endpoint_id: ACTOR, content: { text: "Make a local brief" }, artefact_version_ids: [], attachment_ingress_ids: [],
      response_expected: true, idempotency_key: `message:${contextId}`, provenance: {
        cause_event_id: null, delivery_ids: [], execution_attempt_id: null, node_execution_id: null, scope_execution_id: null,
      } }, noop);
    const [delivery] = claim ? store.claimDeliveries("bridge:test", 1, noop) : store.listDeliveries({ workspace_id: WS }) as any[];
    return { delivery, contextId };
  }
  function cancel(deliveryId: string) {
    return store.cancelRuntimeDelivery({ workspace_id: WS, delivery_id: deliveryId, principal_id: "operator:test", invocation_id: "stop:test" }, noop);
  }
  async function invoke(deliveryId: string, mode: "interactive" | "unattended", grants = new Set([OP]), workspaceId = WS) {
    const authority: OperationAuthorityContext = { principal_id: `principal:${mode}`, boundary: { kind: "workspace", workspace_id: workspaceId }, grants,
      interaction: { mode, session_id: mode, confirmed_prompts: new Set(), approval_refs: new Set() } };
    const request: OperationInvocationRequest = { operation_id: OP, operation_version: "1", input_schema_version: "1",
      target: { kind: "runtime_delivery", id: deliveryId }, input: {}, idempotency_key: `stop:${mode}:${deliveryId}` };
    return store.operationRegistry.invoke({ authority,
      resolve_resource: target => store.resolveOperationResource(target, authority.boundary) }, request);
  }

  it.each(["interactive", "unattended"] as const)("uses the same operation for %s authority and replays its receipt", async mode => {
    const { delivery, contextId } = start();
    const first = await invoke(delivery.delivery_id, mode);
    expect(first).toMatchObject({ kind: "receipt", receipt: { state: "completed", result: { cancelled: true, state: "cancelled", outcome_unknown: true } } });
    expect(await invoke(delivery.delivery_id, mode)).toEqual({ ...first, replayed: true });
    expect(store.getRuntimeDelivery(delivery.delivery_id)?.state).toBe("cancelled");
    expect(store.db.prepare("SELECT DISTINCT state FROM event_queue WHERE delivery_id = ?").all(delivery.delivery_id)).toEqual([{ state: "cancelled" }]);
    expect(store.db.prepare("SELECT count(*) AS n FROM events WHERE context_id = ? AND json_extract(metadata_json, '$.origin') = 'runtime_delivery_cancellation'").get(contextId)).toEqual({ n: 1 });
    expect(() => store.recordRuntimeTurnResult({ delivery_id: delivery.delivery_id, outcome: "completed", text: "Late success" }, noop)).toThrow("cancelled");
    store.reportDeliveryStatus({ bridge_id: "bridge:test", delivery_id: delivery.delivery_id, state: "acknowledged" }, noop);
    expect(store.getRuntimeDelivery(delivery.delivery_id)?.state).toBe("cancelled");
  });

  it("refuses missing grants and cross-workspace targets without stopping work", async () => {
    const { delivery } = start();
    expect(await invoke(delivery.delivery_id, "interactive", new Set())).toMatchObject({ kind: "receipt", receipt: { state: "refused" } });
    expect(await invoke(delivery.delivery_id, "unattended", new Set([OP]), "workspace:other")).toMatchObject({ kind: "receipt", receipt: { state: "refused" } });
    expect(store.getRuntimeDelivery(delivery.delivery_id)?.state).toBe("delivered_to_bridge");
  });

  it("preserves a completion that won the race and does not call it stopped", () => {
    const { delivery } = start();
    const result = store.recordRuntimeTurnResult({ delivery_id: delivery.delivery_id, outcome: "completed", text: "Saved" }, noop);
    expect(cancel(delivery.delivery_id)).toMatchObject({ cancelled: false, state: "completed" });
    store.reportDeliveryStatus({ bridge_id: "bridge:test", delivery_id: delivery.delivery_id, state: "acknowledged" }, noop);
    expect(cancel(delivery.delivery_id)).toMatchObject({ cancelled: false, state: "acknowledged" });
    expect(store.recordRuntimeTurnResult({ delivery_id: delivery.delivery_id, outcome: "completed", text: "Saved" }, noop).result_event.event_id).toBe(result.result_event.event_id);
  });

  it("keeps requested work inspectable from its original Context across completion and restart", () => {
    const { delivery: parent, contextId } = start();
    const reviewer = "actor:reviewer";
    store.registerEndpoint({ endpoint_id: reviewer, workspace_id: WS, name: "Reviewer", bridge_id: "bridge:reviewer", status: "idle" }, noop);
    registerExecutableActorFixture(store, WS, reviewer);
    const request = store.submitEvent({ type: "request", workspace_id: WS, source_endpoint_id: ACTOR,
      destination: { kind: "endpoint", endpoint_id: reviewer }, current_delivery_context_id: contextId,
      correlation_id: "review:1", content: { text: "Review" }, response: { expected: true, mode: "correlated", correlation_id: "review:1" },
      metadata: { request_parent_delivery_id: parent.delivery_id, request_return_context_id: contextId } }, noop);
    const [child] = store.claimDeliveries("bridge:reviewer", 1, noop);
    expect(request.event.context_id).not.toBe(contextId);
    store.recordRuntimeTurnResult({ delivery_id: parent.delivery_id, outcome: "completed", text: "Review underway" }, noop);
    store.reportDeliveryStatus({ bridge_id: "bridge:test", delivery_id: parent.delivery_id, state: "acknowledged" }, noop);
    store.reportTurnEnd(ACTOR, noop);
    // A newer unrelated response must not replace the active requested response at the limit.
    const otherActor = "actor:unrelated";
    store.registerEndpoint({ endpoint_id: otherActor, workspace_id: WS, name: "Unrelated", bridge_id: "bridge:other", status: "idle" }, noop);
    registerExecutableActorFixture(store, WS, otherActor);
    store.submitEvent({ type: "message", workspace_id: WS, source_endpoint_id: ACTOR,
      destination: { kind: "endpoint", endpoint_id: otherActor }, content: { text: "Unrelated work" } }, noop);
    const [unrelated] = store.claimDeliveries("bridge:other", 1, noop);
    const foreignWorkspace = "workspace:foreign", foreignActor = "actor:foreign";
    store.registerEndpoint({ endpoint_id: foreignActor, workspace_id: foreignWorkspace, name: "Foreign", bridge_id: "bridge:foreign", status: "idle" }, noop);
    registerExecutableActorFixture(store, foreignWorkspace, foreignActor);
    store.submitEvent({ type: "message", workspace_id: foreignWorkspace, source_endpoint_id: foreignActor,
      destination: { kind: "endpoint", endpoint_id: foreignActor }, content: { text: "Unrelated workspace" },
      metadata: { request_parent_delivery_id: parent.delivery_id } }, noop);
    store.claimDeliveries("bridge:foreign", 1, noop);
    const query = { workspace_id: WS, context_id: contextId, limit: 1 };
    expect(store.listDeliveries(query)).toEqual([expect.objectContaining({ delivery_id: child.delivery_id })]);
    expect(store.listDeliveries({ ...query, workspace_id: "workspace:other" })).toEqual([]);
    expect(store.getContextDeliverySummaries([contextId, request.event.context_id!, "missing"]).get(contextId))
      .toEqual({ active_count: 1, latest_state: "delivered_to_bridge" });
    expect(store.getContextDeliverySummaries(["missing"]).size).toBe(0);
    cancel(child.delivery_id);
    store.close();
    store = new BusStore(join(root, "config.yaml"), defaultConfig(root));
    expect(store.listDeliveries({ ...query, limit: 500 })).toEqual(expect.arrayContaining([
      expect.objectContaining({ delivery_id: child.delivery_id, state: "cancelled" }),
      expect.objectContaining({ delivery_id: parent.delivery_id, state: "acknowledged" }),
    ]));
    expect(store.listDeliveries({ ...query, limit: 500 })).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ delivery_id: unrelated.delivery_id }),
    ]));
    expect(store.getRuntimeDelivery(child.delivery_id)?.state).toBe("cancelled");
    expect(store.getContextDeliverySummaries([contextId]).get(contextId))
      .toEqual({ active_count: 0, latest_state: "cancelled" });
    store.registerEndpoint({ endpoint_id: ACTOR, workspace_id: WS, name: "Floe", bridge_id: "bridge:test", status: "idle" }, noop);
    store.submitPrincipalContextCommunication({ workspace_id: WS, context_id: contextId, principal_id: "operator:test", type: "message",
      recipient_endpoint_id: ACTOR, content: { text: "Continue the review" }, artefact_version_ids: [], attachment_ingress_ids: [],
      response_expected: true, idempotency_key: `continue:${contextId}`, provenance: {
        cause_event_id: null, delivery_ids: [], execution_attempt_id: null, node_execution_id: null, scope_execution_id: null,
      } }, noop);
    const continued = store.claimDeliveries("bridge:test", 1, noop);
    expect(continued).toHaveLength(1);
    expect(store.getContextDeliverySummaries([contextId]).get(contextId))
      .toEqual({ active_count: 1, latest_state: "delivered_to_bridge" });
    expect(store.getRuntimeDelivery(child.delivery_id)?.state).toBe("cancelled");
  });

  it("keeps a nested collaborator's returned work visible and stoppable from the originating Context", () => {
    const { delivery: parent, contextId } = start();
    const lead = "actor:lead", checker = "actor:checker";
    for (const [endpoint, bridge] of [[lead, "bridge:lead"], [checker, "bridge:checker"]]) {
      store.registerEndpoint({ endpoint_id: endpoint, workspace_id: WS, name: endpoint, bridge_id: bridge, status: "idle" }, noop);
      registerExecutableActorFixture(store, WS, endpoint);
    }
    const finish = (deliveryId: string, endpoint: string, bridge: string, text: string) => {
      const result = store.recordRuntimeTurnResult({ delivery_id: deliveryId, outcome: "completed", text }, noop);
      store.reportDeliveryStatus({ bridge_id: bridge, delivery_id: deliveryId, state: "acknowledged" }, noop);
      store.reportTurnEnd(endpoint, noop);
      return result;
    };
    const leadRequest = store.submitEvent({ type: "request", workspace_id: WS, source_endpoint_id: ACTOR,
      destination: { kind: "endpoint", endpoint_id: lead }, current_delivery_context_id: contextId,
      correlation_id: "lead", content: { text: "Commission and assess an independent check" },
      response: { expected: true, mode: "correlated", correlation_id: "lead" },
      metadata: { request_parent_delivery_id: parent.delivery_id, request_return_context_id: contextId } }, noop).event;
    const [firstLead] = store.claimDeliveries("bridge:lead", 1, noop);
    finish(parent.delivery_id, ACTOR, "bridge:test", "Lead commissioned");
    const checkRequest = store.submitEvent({ type: "request", workspace_id: WS, source_endpoint_id: lead,
      destination: { kind: "endpoint", endpoint_id: checker }, current_delivery_context_id: leadRequest.context_id,
      correlation_id: "check", content: { text: "Check the result" },
      response: { expected: true, mode: "correlated", correlation_id: "check" },
      metadata: { request_parent_delivery_id: firstLead.delivery_id, request_return_context_id: leadRequest.context_id,
        request_continuation_event_id: leadRequest.event_id } }, noop).event;
    const [check] = store.claimDeliveries("bridge:checker", 1, noop);
    finish(firstLead.delivery_id, lead, "bridge:lead", "Waiting for independent evidence");
    finish(check.delivery_id, checker, "bridge:checker", "Independent evidence");
    const [returnedLead] = store.claimDeliveries("bridge:lead", 1, noop);
    expect(returnedLead.events[0].type).toBe("request.result");
    const foreignWorkspace = "workspace:foreign-return", foreignActor = "actor:foreign-return";
    store.registerEndpoint({ endpoint_id: foreignActor, workspace_id: foreignWorkspace, name: "Foreign",
      bridge_id: "bridge:foreign-return", status: "idle" }, noop);
    registerExecutableActorFixture(store, foreignWorkspace, foreignActor);
    store.submitEvent({ type: "request.result", workspace_id: foreignWorkspace, source_endpoint_id: foreignActor,
      destination: { kind: "endpoint", endpoint_id: foreignActor }, content: { text: "Forged return" },
      metadata: { origin: "runtime_request_return", request_event_id: checkRequest.event_id } }, noop);
    store.claimDeliveries("bridge:foreign-return", 1, noop);
    const query = { workspace_id: WS, context_id: contextId, limit: 1 };
    expect(store.listDeliveries(query)).toEqual([expect.objectContaining({ delivery_id: returnedLead.delivery_id })]);
    expect(store.getContextDeliverySummaries([contextId]).get(contextId))
      .toEqual({ active_count: 1, latest_state: "delivered_to_bridge" });
    store.close();
    store = new BusStore(join(root, "config.yaml"), defaultConfig(root));
    expect(store.listDeliveries(query)).toEqual([expect.objectContaining({ delivery_id: returnedLead.delivery_id })]);
    expect(cancel(returnedLead.delivery_id)).toMatchObject({ cancelled: true, state: "cancelled" });
    expect(store.listPendingResponses({ workspace_id: WS })).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_event_id: leadRequest.event_id, status: "cancelled" }),
      expect.objectContaining({ source_event_id: checkRequest.event_id, status: "resolved" }),
    ]));
    expect(store.getContextDeliverySummaries([contextId]).get(contextId))
      .toEqual({ active_count: 0, latest_state: "cancelled" });
    expect(store.getRuntimeDelivery(check.delivery_id)?.state).toBe("acknowledged");
    expect(() => store.recordRuntimeTurnResult({ delivery_id: returnedLead.delivery_id, outcome: "completed", text: "Late finding" }, noop))
      .toThrow("cancelled");
  });

  it("keeps cancelled work stopped after reopening the database", () => {
    const { delivery } = start();
    cancel(delivery.delivery_id);
    store.close();
    store = new BusStore(join(root, "config.yaml"), defaultConfig(root));
    expect(store.getRuntimeDelivery(delivery.delivery_id)?.state).toBe("cancelled");
    expect(store.claimDeliveries("bridge:test", 10, noop)).toEqual([]);
  });

  it("stops a pushed reservation before claim without claiming uncertain effects", () => {
    const { delivery } = start(false);
    expect(cancel(delivery.delivery_id)).toMatchObject({ cancelled: true, outcome_unknown: false });
    expect(store.claimDeliveries("bridge:test", 10, noop)).toEqual([]);
  });

  it("revokes the cancelled runtime's authority atomically", () => {
    const { delivery } = start();
    const grant = store.capabilityGrantStore.issueGrant({ principal_id: ACTOR,
      boundary: { kind: "workspace", workspace_id: WS }, operation_ids: ["artefact.inspect"],
      expires_at: "2099-01-01T00:00:00.000Z", issuer_id: "principal:test-host", evidence: [{ kind: "test_fixture", ref: "stop" }] });
    const session = store.operationAuthoritySessions.issueSession({ principal_id: ACTOR, workspace_id: WS,
      grant_ids: [grant.grant_id], interaction: { mode: "unattended", session_id: delivery.delivery_id },
      provenance: { cause_event_id: null, delivery_ids: [], execution_attempt_id: null, node_execution_id: null, scope_execution_id: null },
      expires_at: "2099-01-01T00:00:00.000Z" });
    store.db.prepare("UPDATE delivery_bundles SET operation_authority_session_id = ? WHERE delivery_id = ?").run(session.session.authority_session_id, delivery.delivery_id);
    cancel(delivery.delivery_id);
    expect(store.db.prepare("SELECT revoked_at FROM operation_authority_sessions WHERE authority_session_id = ?").get(session.session.authority_session_id)).toMatchObject({ revoked_at: expect.any(String) });
  });
});
