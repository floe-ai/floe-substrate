/**
 * Slice 3 (reworked) — Runtime-based delivery gate.
 *
 * The substrate has exactly ONE actor abstraction. Delivery is gated on
 * runtime attachment (bridge_id + status), never on a stored backing label.
 *
 * - An actor with no live agent runtime (bridge_id = null) queues events as
 *   readable context history but never receives a delivery bundle.
 * - An actor with a live agent runtime attached gets delivered normally.
 *
 * No actor_kind column; no human/agent distinction stored anywhere.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { type EventCommand } from "../store.js";
import { defaultConfig, type LocalConfig } from "../config.js";
import { createBusServer } from "../server.js";
import { emitViaRoute } from "../test-support/emit-via-route.js";
import { registerExecutableActorFixture } from "../executable-actor-test-fixture.js";

const WS = "workspace:test-runtime-delivery";
const ACTOR_NO_RUNTIME = "actor:runtime-test:no-runtime";
const ACTOR_WITH_RUNTIME = "actor:runtime-test:with-runtime";
const BRIDGE = "bridge:test-runtime";

const noop = () => {};

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

async function makeServer(): Promise<{ handle: ServerHandle; cleanup: () => Promise<void> }> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-runtime-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg: LocalConfig = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const handle = await createBusServer(cfgPath, cfg, { unsafe_in_process_test_auth_bypass: true });
  await handle.app.ready();
  const timestamp = new Date().toISOString();
  handle.store.workspaceIdentityStore.restoreWorkspace({
    snapshot: {
      workspace_id: WS,
      name: "Test WS",
      creation_kind: "created",
      source_workspace_id: null,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  return {
    handle,
    cleanup: async () => {
      try { await handle.app.close(); } catch {}
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function emitCommand(
  overrides: Partial<EventCommand> & {
    source_endpoint_id: string;
    destination: EventCommand["destination"];
  }
): EventCommand {
  return {
    type: overrides.type ?? "message",
    workspace_id: overrides.workspace_id ?? WS,
    source_endpoint_id: overrides.source_endpoint_id,
    destination: overrides.destination,
    thread_id: "",
    correlation_id: null,
    content: overrides.content ?? { text: "hello" },
    response: overrides.response,
    metadata: {},
    idempotency_key: null,
    context_id: overrides.context_id,
    current_delivery_context_id: overrides.current_delivery_context_id,
  };
}

describe("BusStore — runtime-based delivery gate (Slice 3 rework)", () => {
  let handle: ServerHandle;
  let store: ServerHandle["store"];
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const made = await makeServer();
    handle = made.handle;
    store = handle.store;
    cleanup = made.cleanup;
  });
  afterEach(async () => await cleanup());

  function replaceBinding(status: "resolved" | "unresolved") {
    const current = store.runtimeProfileStore.getCurrentActorBinding(ACTOR_WITH_RUNTIME)!;
    return store.runtimeProfileStore.bindActor({
      actor_id: ACTOR_WITH_RUNTIME,
      runtime_profile_revision_id: current.runtime_profile_revision_id,
      endpoint_id: ACTOR_WITH_RUNTIME,
      status,
      unresolved_reasons: status === "unresolved" ? ["runtime_configuration_missing:model"] : [],
      expected_current_binding_id: current.actor_runtime_binding_id,
      created_by_principal_id: "principal:test-fixture",
    });
  }

  async function unconfiguredRuntime() {
    store.setBroadcast(noop);
    store.registerBridge({ bridge_id: BRIDGE }, noop);
    registerExecutableActorFixture(store, WS, ACTOR_WITH_RUNTIME);
    replaceBinding("unresolved");
    store.registerEndpoint({ endpoint_id: ACTOR_WITH_RUNTIME, workspace_id: WS, name: "Worker", bridge_id: BRIDGE, status: "idle" }, noop);
    store.registerEndpoint({ endpoint_id: ACTOR_NO_RUNTIME, workspace_id: WS, name: "Operator" }, noop);
    await Promise.resolve();
    expect(store.getEndpoint(ACTOR_WITH_RUNTIME).status).toBe("runtime_unconfigured");
  }

  it("pushes queued work when its runtime becomes configured and preserves its exact binding", async () => {
    await unconfiguredRuntime();
    const sent = await emitViaRoute(handle, emitCommand({ source_endpoint_id: ACTOR_NO_RUNTIME, destination: { kind: "endpoint", endpoint_id: ACTOR_WITH_RUNTIME } }));
    expect(store.claimDeliveries(BRIDGE, 1, noop)).toHaveLength(0);
    const ready = replaceBinding("resolved");
    await Promise.resolve();
    const deliveries = store.claimDeliveries(BRIDGE, 5, noop);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ trigger_event_id: sent.event.event_id, actor_runtime_binding_id: ready.actor_runtime_binding_id });
    expect(store.getEndpoint(ACTOR_WITH_RUNTIME).status).toBe("active");
    replaceBinding("resolved");
    await Promise.resolve();
    expect(store.getEndpoint(ACTOR_WITH_RUNTIME).status).toBe("active");
    expect(store.db.prepare("SELECT actor_runtime_binding_id FROM delivery_bundles").all()).toEqual([{ actor_runtime_binding_id: ready.actor_runtime_binding_id }]);
  });

  it("does not activate or announce a runtime binding rolled back by its enclosing import", async () => {
    await unconfiguredRuntime();
    const changes: string[] = [];
    store.setBroadcast((type) => changes.push(type));
    store.db.exec("SAVEPOINT import_attempt");
    replaceBinding("resolved");
    store.db.exec("ROLLBACK TO import_attempt");
    store.db.exec("RELEASE import_attempt");
    await Promise.resolve();
    expect(store.getEndpoint(ACTOR_WITH_RUNTIME).status).toBe("runtime_unconfigured");
    expect(changes).toEqual([]);
  });

  it.each(["error", "retired", "offline", "waiting"])("model configuration preserves an Endpoint that is %s", async (status) => {
    await unconfiguredRuntime();
    store.updateEndpointStatus(ACTOR_WITH_RUNTIME, status, noop);
    replaceBinding("resolved");
    await Promise.resolve();
    expect(store.getEndpoint(ACTOR_WITH_RUNTIME).status).toBe(status);
  });

  it.each(["active", "waiting", "error", "retired"])("attachment refresh preserves existing %s work", async (status) => {
    await unconfiguredRuntime();
    replaceBinding("resolved");
    await Promise.resolve();
    store.updateEndpointStatus(ACTOR_WITH_RUNTIME, status, noop);
    store.registerEndpoint({ endpoint_id: ACTOR_WITH_RUNTIME, workspace_id: WS,
      name: "Updated name", bridge_id: BRIDGE, status: "idle" }, noop);
    expect(store.getEndpoint(ACTOR_WITH_RUNTIME)).toMatchObject({ name: "Updated name", status });
  });

  it("an actor with no runtime attached receives no delivery bundle but accrues context history", async () => {
    // Register actor with no bridge_id (runtime-less)
    store.registerEndpoint(
      { endpoint_id: ACTOR_NO_RUNTIME, workspace_id: WS, name: "Actor A" },
      noop
    );
    store.registerEndpoint(
      { endpoint_id: ACTOR_WITH_RUNTIME, workspace_id: WS, name: "Actor B" },
      noop
    );

    // Route a message to the runtime-less actor
    const result = await emitViaRoute(handle,
      emitCommand({
        source_endpoint_id: ACTOR_WITH_RUNTIME,
        destination: { kind: "endpoint", endpoint_id: ACTOR_NO_RUNTIME },
      }),
    );

    // No delivery bundle for the runtime-less actor
    const bundles = store.db
      .prepare("SELECT * FROM delivery_bundles WHERE endpoint_id = ?")
      .all(ACTOR_NO_RUNTIME) as any[];
    expect(bundles).toHaveLength(0);

    // But the event IS queued and readable via context history
    const queued = store.db
      .prepare("SELECT * FROM event_queue WHERE destination_endpoint_id = ?")
      .all(ACTOR_NO_RUNTIME) as any[];
    expect(queued.length).toBeGreaterThan(0);

    const eventRow = store.db
      .prepare("SELECT event_id FROM events WHERE event_id = ?")
      .get(result.event.event_id);
    expect(eventRow).not.toBeUndefined();
  });

  it("an actor with a live runtime attached receives a delivery bundle", async () => {
    // Provision a bridge so ACTOR_WITH_RUNTIME has a real runtime
    store.db.prepare(`
      INSERT INTO bridges (bridge_id, status, capabilities_json, last_seen_at, created_at)
      VALUES (?, 'online', '{}', ?, ?)
    `).run(BRIDGE, new Date().toISOString(), new Date().toISOString());

    store.registerEndpoint(
      { endpoint_id: ACTOR_NO_RUNTIME, workspace_id: WS, name: "Actor A" },
      noop
    );
    store.registerEndpoint(
      {
        endpoint_id: ACTOR_WITH_RUNTIME,
        workspace_id: WS,
        name: "Actor B",
        bridge_id: BRIDGE,
        status: "idle",
      },
      noop
    );

    // Route a message to the runtime-connected actor
    await emitViaRoute(handle,
      emitCommand({
        source_endpoint_id: ACTOR_NO_RUNTIME,
        destination: { kind: "endpoint", endpoint_id: ACTOR_WITH_RUNTIME },
      }),
    );

    const bundles = store.db
      .prepare("SELECT * FROM delivery_bundles WHERE endpoint_id = ?")
      .all(ACTOR_WITH_RUNTIME) as any[];
    expect(bundles.length).toBeGreaterThan(0);
  });

  it("pins direct Context work to one exact Actor definition and runtime revision", async () => {
    store.db.prepare(`
      INSERT INTO bridges (bridge_id, status, capabilities_json, last_seen_at, created_at)
      VALUES (?, 'online', '{}', ?, ?)
    `).run(BRIDGE, new Date().toISOString(), new Date().toISOString());
    store.registerEndpoint(
      { endpoint_id: ACTOR_NO_RUNTIME, workspace_id: WS, name: "Actor A" },
      noop,
    );
    store.registerEndpoint(
      {
        endpoint_id: ACTOR_WITH_RUNTIME,
        workspace_id: WS,
        name: "Actor B",
        bridge_id: BRIDGE,
        status: "idle",
      },
      noop,
    );
    registerExecutableActorFixture(store, WS, ACTOR_WITH_RUNTIME);

    const submitted = await emitViaRoute(handle,
      emitCommand({
        source_endpoint_id: ACTOR_NO_RUNTIME,
        destination: { kind: "endpoint", endpoint_id: ACTOR_WITH_RUNTIME },
      }),
    );
    const originalActor = store.actorDefinitionStore.getActor(ACTOR_WITH_RUNTIME)!;
    const originalDefinition = store.actorDefinitionStore.getRevision(
      originalActor.current_definition_revision_id!,
    )!;
    const originalBinding = store.runtimeProfileStore.getCurrentActorBinding(ACTOR_WITH_RUNTIME)!;
    const originalProfile = store.runtimeProfileStore.getRevision(
      originalBinding.runtime_profile_revision_id,
    )!;

    // Current configuration may change after reservation. The already-created
    // Delivery must continue to use the exact revisions it recorded.
    const nextDefinition = store.actorDefinitionStore.createDraft({
      actor_id: ACTOR_WITH_RUNTIME,
      based_on_revision_id: originalDefinition.actor_definition_revision_id,
      created_by_principal_id: "principal:test-fixture",
      definition: {
        ...originalDefinition.content,
        instructions: "These instructions apply only to future Deliveries.",
      },
    });
    store.actorDefinitionStore.publishDraft({
      actor_definition_revision_id: nextDefinition.actor_definition_revision_id,
      expected_current_revision_id: originalDefinition.actor_definition_revision_id,
      changed_by_principal_id: "principal:test-fixture",
    });
    const nextProfile = store.runtimeProfileStore.createDraft({
      runtime_profile_id: originalProfile.runtime_profile_id,
      based_on_revision_id: originalProfile.runtime_profile_revision_id,
      created_by_principal_id: "principal:test-fixture",
      content: {
        ...originalProfile.content,
        configuration: { model: "future-model" },
      },
    });
    const publishedProfile = store.runtimeProfileStore.publishDraft({
      runtime_profile_revision_id: nextProfile.runtime_profile_revision_id,
      expected_current_revision_id: originalProfile.runtime_profile_revision_id,
      changed_by_principal_id: "principal:test-fixture",
    });
    store.runtimeProfileStore.bindActor({
      actor_id: ACTOR_WITH_RUNTIME,
      runtime_profile_revision_id: publishedProfile.runtime_profile_revision_id,
      endpoint_id: ACTOR_WITH_RUNTIME,
      status: "resolved",
      expected_current_binding_id: originalBinding.actor_runtime_binding_id,
      created_by_principal_id: "principal:test-fixture",
    });
    const claimed = store.claimDeliveries(BRIDGE, 1, noop)[0]!;
    expect(claimed).not.toHaveProperty("processing_contract");
    const prepared = store.prepareRuntimeDelivery({
      bridge_id: BRIDGE,
      delivery_id: claimed.delivery_id,
    }, noop);
    const processingContract = prepared.processing_contract;
    expect(processingContract.contract_kind).toBe("direct_context");
    if (processingContract.contract_kind !== "direct_context") {
      throw new Error("Expected a direct Context processing contract.");
    }

    expect(processingContract).toMatchObject({
      contract_kind: "direct_context",
      workspace_id: WS,
      delivery: {
        delivery_id: claimed.delivery_id,
        endpoint_id: ACTOR_WITH_RUNTIME,
        context_id: submitted.event.context_id,
      },
      context: { context_id: submitted.event.context_id },
      actor: { actor_id: ACTOR_WITH_RUNTIME },
      runtime: { binding: { endpoint_id: ACTOR_WITH_RUNTIME } },
    });
    expect(claimed.actor_definition_revision_id)
      .toBe(processingContract.actor.definition.actor_definition_revision_id);
    expect(claimed.actor_definition_revision_id).toBe(originalDefinition.actor_definition_revision_id);
    expect(claimed.runtime_profile_revision_id)
      .toBe(processingContract.runtime.profile.runtime_profile_revision_id);
    expect(claimed.runtime_profile_revision_id).toBe(originalProfile.runtime_profile_revision_id);
    expect(claimed.actor_runtime_binding_id)
      .toBe(processingContract.runtime.binding.actor_runtime_binding_id);
    expect(claimed.actor_runtime_binding_id).toBe(originalBinding.actor_runtime_binding_id);

    const verified = store.operationAuthorityVerifier.verifyBearerToken(
      prepared.operation_authority_session.bearer_token,
      { boundary: { kind: "workspace", workspace_id: WS } },
    );
    expect(verified).toMatchObject({
      verified: true,
      authority_session_id: prepared.operation_authority_session.authority_session_id,
      authority: { principal_id: ACTOR_WITH_RUNTIME },
      provenance: {
        cause_event_id: submitted.event.event_id,
        delivery_ids: claimed.stable_delivery_ids,
        execution_attempt_id: null,
        node_execution_id: null,
        scope_execution_id: null,
      },
    });
    const reprepared = store.prepareRuntimeDelivery({
      bridge_id: BRIDGE,
      delivery_id: claimed.delivery_id,
    }, noop);
    expect(store.operationAuthorityVerifier.verifyBearerToken(
      prepared.operation_authority_session.bearer_token,
      { boundary: { kind: "workspace", workspace_id: WS } },
    )).toMatchObject({ verified: false, code: "authority_session_revoked" });
    expect(store.operationAuthorityVerifier.verifyBearerToken(
      reprepared.operation_authority_session.bearer_token,
      { boundary: { kind: "workspace", workspace_id: WS } },
    )).toMatchObject({ verified: true });

    store.reportDeliveryStatus({
      bridge_id: BRIDGE,
      delivery_id: claimed.delivery_id,
      state: "injected_to_runtime",
    }, noop);
    const renewed = store.prepareRuntimeDelivery({
      bridge_id: BRIDGE,
      delivery_id: claimed.delivery_id,
    }, noop);
    expect(renewed.processing_contract).toEqual(reprepared.processing_contract);
    expect(renewed.delivery.execution_attempt_id).toBeNull();
    expect((store.db.prepare(`
      SELECT state FROM delivery_bundles WHERE delivery_id = ?
    `).get(claimed.delivery_id) as { state: string }).state).toBe("injected_to_runtime");
    expect(store.operationAuthorityVerifier.verifyBearerToken(
      reprepared.operation_authority_session.bearer_token,
      { boundary: { kind: "workspace", workspace_id: WS } },
    )).toMatchObject({ verified: false, code: "authority_session_revoked" });
    expect(store.operationAuthorityVerifier.verifyBearerToken(
      renewed.operation_authority_session.bearer_token,
      { boundary: { kind: "workspace", workspace_id: WS } },
    )).toMatchObject({ verified: true });
    store.reportDeliveryStatus({
      bridge_id: BRIDGE,
      delivery_id: claimed.delivery_id,
      state: "acknowledged",
    }, noop);
    expect(store.operationAuthorityVerifier.verifyBearerToken(
      renewed.operation_authority_session.bearer_token,
      { boundary: { kind: "workspace", workspace_id: WS } },
    )).toMatchObject({ verified: false, code: "authority_session_revoked" });
    expect(() => store.prepareRuntimeDelivery({
      bridge_id: BRIDGE,
      delivery_id: claimed.delivery_id,
    }, noop)).toThrow(/'acknowledged'.*cannot be prepared/);
  });

  it("endpoints table has no actor_kind column", () => {
    // The substrate must not store any backing label on actors
    const columns = store.db
      .prepare("PRAGMA table_info(endpoints)")
      .all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).not.toContain("actor_kind");
  });

  it("registerEndpoint does not accept or persist any backing-kind field", () => {
    const ep = store.registerEndpoint(
      { endpoint_id: ACTOR_NO_RUNTIME, workspace_id: WS, name: "Actor A" },
      noop
    ) as any;
    // No backing-kind property on the returned endpoint
    expect(ep.actor_kind).toBeUndefined();
  });
});
