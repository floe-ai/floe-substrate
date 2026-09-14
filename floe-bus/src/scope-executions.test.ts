import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  ScopeExecutionReferenceError,
  ScopeExecutionStore,
  ScopeExecutionTransitionError,
  applyScopeExecutionSchema,
} from "./scope-executions.js";
import {
  ActorDefinitionStore,
  applyActorDefinitionSchema,
  type ActorDefinitionContent,
} from "./actor-definitions.js";
import {
  RuntimeProfileStore,
  applyRuntimeProfileSchema,
  type RuntimeProfileContent,
} from "./runtime-profiles.js";
import { applyScopeCompositionSchema } from "./scope-compositions.js";

describe("canonical Scope execution records", () => {
  let db: DatabaseSync;
  let store: ScopeExecutionStore;
  let actors: ActorDefinitionStore;
  let runtimes: RuntimeProfileStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    applyActorDefinitionSchema(db);
    applyRuntimeProfileSchema(db);
    applyScopeCompositionSchema(db);
    applyScopeExecutionSchema(db);
    actors = new ActorDefinitionStore(db);
    runtimes = new RuntimeProfileStore(db);
    store = new ScopeExecutionStore(db);
  });

  afterEach(() => db.close());

  it("pins a Scope execution to one composition revision", () => {
    const first = store.createExecution({
      workspace_id: "workspace:test",
      scope_id: "delivery",
      revision_id: "revision:1",
      ingress_node_id: "work-arrived",
      ingress_port_id: "work-arrived:out",
      idempotency_key: "arrival:card-1",
    });
    const duplicate = store.createExecution({
      workspace_id: "workspace:test",
      scope_id: "delivery",
      revision_id: "revision:2",
      ingress_node_id: "different",
      ingress_port_id: "different:out",
      idempotency_key: "arrival:card-1",
    });
    expect(duplicate.execution_id).toBe(first.execution_id);
    expect(duplicate.revision_id).toBe("revision:1");
  });

  it("upgrades retained execution rows to canonical statuses and durable input identity", () => {
    const retained = new DatabaseSync(":memory:");
    try {
      retained.exec(`
        CREATE TABLE scope_executions (
          execution_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          revision_id TEXT NOT NULL,
          cause_event_id TEXT,
          root_event_id TEXT,
          ingress_node_id TEXT NOT NULL,
          ingress_port_id TEXT NOT NULL,
          initiator_endpoint_id TEXT,
          idempotency_key TEXT,
          parent_execution_id TEXT,
          redo_of_node_execution_id TEXT,
          status TEXT NOT NULL,
          environment_json TEXT NOT NULL,
          budget_json TEXT NOT NULL,
          terminal_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          cancelled_at TEXT
        );
        CREATE TABLE node_executions (
          node_execution_id TEXT PRIMARY KEY,
          execution_id TEXT NOT NULL,
          revision_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          activation_key TEXT NOT NULL,
          context_id TEXT NOT NULL,
          status TEXT NOT NULL,
          assigned_actor_ids_json TEXT NOT NULL,
          missing_port_ids_json TEXT NOT NULL,
          failure_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          activated_at TEXT,
          completed_at TEXT,
          cancelled_at TEXT,
          UNIQUE (execution_id, node_id, activation_key)
        );
        CREATE TABLE node_execution_inputs (
          input_id TEXT PRIMARY KEY,
          node_execution_id TEXT NOT NULL,
          port_id TEXT NOT NULL,
          delivery_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          artefact_version_id TEXT,
          member_key TEXT NOT NULL,
          accepted_at TEXT NOT NULL
        );
        INSERT INTO scope_executions VALUES (
          'execution:retained', 'workspace:test', 'delivery', 'revision:retained',
          NULL, NULL, 'ingress', 'ingress:out', NULL, NULL, NULL, NULL,
          'running', '{}', '{}', '{}', '2026-09-01T00:00:00.000Z',
          '2026-09-01T00:00:00.000Z', NULL, NULL
        );
        INSERT INTO node_executions VALUES (
          'node:retained', 'execution:retained', 'revision:retained', 'join',
          'one', 'context:retained', 'pending', '[]', '[]', '{}',
          '2026-09-01T00:00:00.000Z', NULL, NULL, NULL
        );
        INSERT INTO node_execution_inputs VALUES
          ('input:first', 'node:retained', 'join:member', 'delivery:first', 'event:first',
           'version:one', 'crate', '2026-09-01T00:00:00.000Z'),
          ('input:duplicate', 'node:retained', 'join:member', 'delivery:duplicate', 'event:duplicate',
           'version:one', 'crate', '2026-09-01T00:00:01.000Z');
      `);

      applyScopeExecutionSchema(retained);
      const retainedStore = new ScopeExecutionStore(retained);
      expect(retainedStore.getExecution("execution:retained")?.status).toBe("active");
      expect(retainedStore.getNodeExecution("node:retained")).toMatchObject({
        status: "collecting",
        join_key: null,
      });
      expect(retainedStore.listInputs("node:retained")).toEqual([
        expect.objectContaining({
          input_id: "input:first",
          input_identity: "artefact:version:one:member:crate",
          state: "received",
        }),
        expect.objectContaining({
          input_id: "input:duplicate",
          input_identity: "artefact:version:one:member:crate",
          state: "late",
          reason: { code: "retained_duplicate_input" },
        }),
      ]);
    } finally {
      retained.close();
    }
  });

  it("deduplicates one logical NodeExecution and its exact inputs", () => {
    seedPlacement(db, { revision_id: "revision:1", node_id: "builder", kind: "context" });
    const execution = store.createExecution({
      workspace_id: "workspace:test",
      scope_id: "delivery",
      revision_id: "revision:1",
      ingress_node_id: "work-arrived",
      ingress_port_id: "work-arrived:out",
    });
    const first = store.createOrGetNodeExecution({
      execution_id: execution.execution_id,
      revision_id: execution.revision_id,
      node_id: "builder",
      activation_key: "card-1",
      context_id: "context:builder:card-1",
      assigned_actor_ids: ["actor:workspace:test:builder"],
      status: "ready",
    });
    const duplicate = store.createOrGetNodeExecution({
      execution_id: execution.execution_id,
      revision_id: execution.revision_id,
      node_id: "builder",
      activation_key: "card-1",
      context_id: "context:builder:card-1",
    });
    expect(duplicate.node_execution_id).toBe(first.node_execution_id);
    expect(duplicate.context_id).toBe("context:builder:card-1");
    expect(() => store.createOrGetNodeExecution({
      execution_id: execution.execution_id,
      revision_id: execution.revision_id,
      node_id: "builder",
      activation_key: "card-1",
      context_id: "context:wrong",
    })).toThrow(/conflicting immutable identity/);

    const input = {
      node_execution_id: first.node_execution_id,
      port_id: "builder:work",
      delivery_id: "delivery:1",
      event_id: "event:1",
      artefact_version_id: "artefact-version:1",
      member_key: "card-1",
    };
    expect(store.acceptInput(input).input_id).toBe(store.acceptInput(input).input_id);
    expect(store.listInputs(first.node_execution_id)).toHaveLength(1);
  });

  it("separates processing attempts from the logical NodeExecution", () => {
    seedPlacement(db, { revision_id: "revision:1", node_id: "builder", kind: "context" });
    const execution = store.createExecution({
      workspace_id: "workspace:test",
      scope_id: "delivery",
      revision_id: "revision:1",
      ingress_node_id: "work-arrived",
      ingress_port_id: "work-arrived:out",
    });
    const node = store.createOrGetNodeExecution({
      execution_id: execution.execution_id,
      revision_id: execution.revision_id,
      node_id: "builder",
      activation_key: "one",
      context_id: "context:one",
      status: "ready",
    });
    const first = store.startAttempt({
      node_execution_id: node.node_execution_id,
      delivery_ids: ["delivery:1"],
      delivery_bundle_id: "bundle:1",
      runtime: { provider: "test", model: "fake" },
    });
    store.finishAttempt({ attempt_id: first.attempt_id, status: "failed", error: { code: "transient" } });
    store.setNodeExecutionStatus(node.node_execution_id, "retrying");
    const retry = store.startAttempt({
      node_execution_id: node.node_execution_id,
      delivery_ids: ["delivery:1"],
      delivery_bundle_id: "bundle:2",
    });
    expect(first.ordinal).toBe(1);
    expect(first.delivery_ids).toEqual(["delivery:1"]);
    expect(retry.ordinal).toBe(2);
    expect(retry.node_execution_id).toBe(first.node_execution_id);
  });

  it("associates a joined attempt with every stable Delivery", () => {
    seedPlacement(db, { revision_id: "revision:1", node_id: "judge", kind: "context" });
    const execution = store.createExecution({
      workspace_id: "workspace:test",
      scope_id: "delivery",
      revision_id: "revision:1",
      ingress_node_id: "work-arrived",
      ingress_port_id: "work-arrived:out",
    });
    const node = store.createOrGetNodeExecution({
      execution_id: execution.execution_id,
      revision_id: execution.revision_id,
      node_id: "judge",
      activation_key: "joined",
      context_id: "context:joined",
      status: "ready",
    });
    const attempt = store.startAttempt({
      node_execution_id: node.node_execution_id,
      delivery_ids: ["delivery:requirements", "delivery:candidate"],
      delivery_bundle_id: "bundle:joined",
    });
    expect(attempt.delivery_id).toBeNull();
    expect(attempt.delivery_ids).toEqual(["delivery:candidate", "delivery:requirements"]);
    expect(store.startAttempt({
      node_execution_id: node.node_execution_id,
      delivery_ids: ["delivery:ignored"],
      delivery_bundle_id: "bundle:joined",
    }).attempt_id).toBe(attempt.attempt_id);
  });

  it("prepares an attempt without claiming runtime execution, then begins that exact attempt", () => {
    seedPlacement(db, { revision_id: "revision:1", node_id: "judge", kind: "context" });
    const execution = store.createExecution({
      workspace_id: "workspace:test",
      scope_id: "delivery",
      revision_id: "revision:1",
      ingress_node_id: "work-arrived",
      ingress_port_id: "work-arrived:out",
    });
    const node = store.createOrGetNodeExecution({
      execution_id: execution.execution_id,
      revision_id: execution.revision_id,
      node_id: "judge",
      activation_key: "prepared",
      context_id: "context:prepared",
      status: "ready",
    });
    const prepared = store.startAttempt({
      node_execution_id: node.node_execution_id,
      delivery_ids: ["delivery:one"],
      delivery_bundle_id: "bundle:prepared",
      runtime: { bridge_id: "bridge:one" },
      status: "pending",
    });
    expect(prepared).toMatchObject({ status: "pending", started_at: null });
    expect(store.getNodeExecution(node.node_execution_id)?.status).toBe("ready");

    const running = store.beginAttempt({
      attempt_id: prepared.attempt_id,
      runtime: { adapter_id: "adapter:test" },
    });
    expect(running.status).toBe("running");
    expect(running.started_at).not.toBeNull();
    expect(running.runtime).toEqual({ bridge_id: "bridge:one", adapter_id: "adapter:test" });
    expect(store.getNodeExecution(node.node_execution_id)?.status).toBe("active");
    expect(store.beginAttempt({ attempt_id: prepared.attempt_id }).attempt_id).toBe(prepared.attempt_id);
  });

  it("refuses invalid attempt transitions without leaving partial durable state", () => {
    seedPlacement(db, { revision_id: "revision:attempt-guard", node_id: "worker", kind: "context" });
    const execution = createExecution(store, "revision:attempt-guard", "workspace:test");
    const collecting = store.createOrGetNodeExecution({
      execution_id: execution.execution_id,
      revision_id: execution.revision_id,
      node_id: "worker",
      activation_key: "collecting",
      context_id: "context:collecting",
      status: "collecting",
    });
    expect(() => store.startAttempt({ node_execution_id: collecting.node_execution_id }))
      .toThrow(ScopeExecutionTransitionError);
    expect(store.listAttempts(collecting.node_execution_id)).toEqual([]);

    const ready = store.createOrGetNodeExecution({
      execution_id: execution.execution_id,
      revision_id: execution.revision_id,
      node_id: "worker",
      activation_key: "ready",
      context_id: "context:ready",
      status: "ready",
    });
    const pending = store.startAttempt({
      node_execution_id: ready.node_execution_id,
      delivery_bundle_id: "bundle:will-cancel",
      status: "pending",
    });
    store.setNodeExecutionStatus(ready.node_execution_id, "cancelled");
    expect(() => store.beginAttempt({ attempt_id: pending.attempt_id }))
      .toThrow(ScopeExecutionTransitionError);
    expect(store.getAttempt(pending.attempt_id)?.status).toBe("pending");

    const finishedNode = store.createOrGetNodeExecution({
      execution_id: execution.execution_id,
      revision_id: execution.revision_id,
      node_id: "worker",
      activation_key: "finished",
      context_id: "context:finished",
      status: "ready",
    });
    const finished = store.startAttempt({ node_execution_id: finishedNode.node_execution_id });
    store.finishAttempt({ attempt_id: finished.attempt_id, status: "completed" });
    expect(() => store.finishAttempt({ attempt_id: finished.attempt_id, status: "failed" }))
      .toThrow(ScopeExecutionTransitionError);
    expect(store.getAttempt(finished.attempt_id)?.status).toBe("completed");
  });

  it("records one output publication and one traversal per stored Edge", () => {
    const publication = store.createPublication({
      node_execution_id: "node-execution:1",
      port_id: "builder:completed",
      event_id: "event:completed",
      idempotency_key: "publish:builder:completed:1",
      artefact_versions: [{ artefact_version_id: "artefact-version:1" }],
    });
    const duplicate = store.createPublication({
      node_execution_id: "node-execution:wrong",
      port_id: "wrong",
      event_id: "wrong",
      idempotency_key: "publish:builder:completed:1",
    });
    expect(duplicate.publication_id).toBe(publication.publication_id);
    expect(publication.outputs).toEqual([
      { artefact_version_id: "artefact-version:1", member_key: "" },
    ]);

    store.recordTraversal({
      publication_id: publication.publication_id,
      edge_id: "builder-to-reviewer",
      delivery_id: "delivery:reviewer",
      target_node_execution_id: "node-execution:reviewer",
    });
    store.recordTraversal({
      publication_id: publication.publication_id,
      edge_id: "builder-to-reviewer",
      delivery_id: "delivery:duplicate",
      target_node_execution_id: "node-execution:duplicate",
    });
    const rows = db.prepare(`SELECT * FROM scope_edge_traversals`).all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].delivery_id).toBe("delivery:reviewer");
  });

  it("pins the exact Actor definition, runtime profile, and binding across retries", () => {
    const first = createPublishedActorRuntime(actors, runtimes, "workspace:test", "builder");
    seedPlacement(db, {
      revision_id: "revision:1",
      node_id: "builder",
      kind: "actor",
      resource_id: first.actor_id,
    });
    const execution = store.createExecution({
      workspace_id: "workspace:test",
      scope_id: "delivery",
      revision_id: "revision:1",
      ingress_node_id: "work-arrived",
      ingress_port_id: "work-arrived:out",
    });
    const node = store.createOrGetNodeExecution({
      execution_id: execution.execution_id,
      revision_id: execution.revision_id,
      node_id: "builder",
      activation_key: "card-1",
      context_id: "context:builder:card-1",
      status: "ready",
    });
    expect(node).toMatchObject({
      assigned_actor_ids: [first.actor_id],
      actor_definition_revision_id: first.actor_definition_revision_id,
      runtime_profile_revision_id: first.runtime_profile_revision_id,
      actor_runtime_binding_id: first.actor_runtime_binding_id,
    });
    const attempt = store.startAttempt({
      node_execution_id: node.node_execution_id,
      delivery_ids: ["delivery:1"],
      delivery_bundle_id: "bundle:1",
    });
    expect(attempt).toMatchObject({
      actor_definition_revision_id: first.actor_definition_revision_id,
      runtime_profile_revision_id: first.runtime_profile_revision_id,
      actor_runtime_binding_id: first.actor_runtime_binding_id,
    });
    store.finishAttempt({ attempt_id: attempt.attempt_id, status: "failed" });
    store.setNodeExecutionStatus(node.node_execution_id, "retrying");

    const nextDefinitionDraft = actors.createDraft({
      actor_id: first.actor_id,
      created_by_principal_id: "principal:operator",
      definition: actorDefinition("Builder current"),
    });
    const nextDefinition = actors.publishDraft({
      actor_definition_revision_id: nextDefinitionDraft.actor_definition_revision_id,
      expected_current_revision_id: first.actor_definition_revision_id,
      changed_by_principal_id: "principal:operator",
    });
    const nextRuntimeDraft = runtimes.createDraft({
      runtime_profile_id: first.runtime_profile_id,
      created_by_principal_id: "principal:operator",
      content: runtimeProfile("Runtime current"),
    });
    const nextRuntime = runtimes.publishDraft({
      runtime_profile_revision_id: nextRuntimeDraft.runtime_profile_revision_id,
      expected_current_revision_id: first.runtime_profile_revision_id,
      changed_by_principal_id: "principal:operator",
    });
    const nextBinding = runtimes.bindActor({
      actor_id: first.actor_id,
      runtime_profile_revision_id: nextRuntime.runtime_profile_revision_id,
      status: "resolved",
      expected_current_binding_id: first.actor_runtime_binding_id,
      created_by_principal_id: "principal:operator",
    });

    const retry = store.startAttempt({
      node_execution_id: node.node_execution_id,
      delivery_ids: ["delivery:1"],
      delivery_bundle_id: "bundle:2",
    });
    expect(retry.ordinal).toBe(2);
    expect(retry).toMatchObject({
      actor_definition_revision_id: first.actor_definition_revision_id,
      runtime_profile_revision_id: first.runtime_profile_revision_id,
      actor_runtime_binding_id: first.actor_runtime_binding_id,
    });

    seedPlacement(db, {
      revision_id: "revision:2",
      node_id: "builder",
      kind: "actor",
      resource_id: first.actor_id,
    });
    const redo = store.createRedoExecution({
      redo_of_node_execution_id: node.node_execution_id,
      revision_id: "revision:2",
      ingress_node_id: "work-arrived",
      ingress_port_id: "work-arrived:out",
      idempotency_key: "redo:card-1",
    });
    const redoneNode = store.createOrGetNodeExecution({
      execution_id: redo.execution_id,
      revision_id: redo.revision_id,
      node_id: "builder",
      activation_key: "card-1-redo",
      context_id: "context:builder:card-1-redo",
      status: "ready",
    });
    expect(redo.execution_id).not.toBe(execution.execution_id);
    expect(redo.revision_id).toBe("revision:2");
    expect(redo.parent_execution_id).toBe(execution.execution_id);
    expect(redo.redo_of_node_execution_id).toBe(node.node_execution_id);
    expect(redoneNode).toMatchObject({
      actor_definition_revision_id: nextDefinition.actor_definition_revision_id,
      runtime_profile_revision_id: nextRuntime.runtime_profile_revision_id,
      actor_runtime_binding_id: nextBinding.actor_runtime_binding_id,
    });
  });

  it("keeps Actor/runtime pins absent from non-Actor work", () => {
    seedPlacement(db, { revision_id: "revision:1", node_id: "build", kind: "context" });
    const execution = store.createExecution({
      workspace_id: "workspace:test",
      scope_id: "delivery",
      revision_id: "revision:1",
      ingress_node_id: "work-arrived",
      ingress_port_id: "work-arrived:out",
    });
    const node = store.createOrGetNodeExecution({
      execution_id: execution.execution_id,
      revision_id: execution.revision_id,
      node_id: "build",
      activation_key: "one",
      context_id: "context:build",
      status: "ready",
    });
    const attempt = store.startAttempt({ node_execution_id: node.node_execution_id });
    expect(node).toMatchObject({
      actor_definition_revision_id: null,
      runtime_profile_revision_id: null,
      actor_runtime_binding_id: null,
    });
    expect(attempt).toMatchObject({
      actor_definition_revision_id: null,
      runtime_profile_revision_id: null,
      actor_runtime_binding_id: null,
    });
  });

  it("refuses missing, retired, unpublished, unresolved, and cross-Workspace Actor references before creating work", () => {
    seedPlacement(db, {
      revision_id: "revision:missing",
      node_id: "missing",
      kind: "actor",
      resource_id: "actor:missing",
    });
    const missingExecution = createExecution(store, "revision:missing", "workspace:test");
    expect(() => createNode(store, missingExecution.execution_id, "revision:missing", "missing"))
      .toThrow(ScopeExecutionReferenceError);

    const unpublished = actors.createActor({
      workspace_id: "workspace:test",
      actor_id: "actor:unpublished",
      created_by_principal_id: "principal:operator",
      definition: actorDefinition("Unpublished"),
    });
    seedPlacement(db, {
      revision_id: "revision:unpublished",
      node_id: "unpublished",
      kind: "actor",
      resource_id: unpublished.actor.actor_id,
    });
    const unpublishedExecution = createExecution(store, "revision:unpublished", "workspace:test");
    expect(() => createNode(store, unpublishedExecution.execution_id, "revision:unpublished", "unpublished"))
      .toThrow(/no published definition/);

    const unresolvedActor = publishActor(actors, "workspace:test", "actor:unresolved", "Unresolved");
    const unresolvedProfile = publishRuntime(runtimes, "workspace:test", "runtime:unresolved", "Unresolved runtime");
    runtimes.bindActor({
      actor_id: unresolvedActor.actor_id,
      runtime_profile_revision_id: unresolvedProfile.runtime_profile_revision_id,
      status: "unresolved",
      unresolved_reasons: ["broker binding unavailable"],
      expected_current_binding_id: null,
      created_by_principal_id: "principal:operator",
    });
    seedPlacement(db, {
      revision_id: "revision:unresolved",
      node_id: "unresolved",
      kind: "actor",
      resource_id: unresolvedActor.actor_id,
    });
    const unresolvedExecution = createExecution(store, "revision:unresolved", "workspace:test");
    expect(() => createNode(store, unresolvedExecution.execution_id, "revision:unresolved", "unresolved"))
      .toThrow(/not resolved/);

    const unboundActor = publishActor(actors, "workspace:test", "actor:unbound", "Unbound");
    seedPlacement(db, {
      revision_id: "revision:unbound",
      node_id: "unbound",
      kind: "actor",
      resource_id: unboundActor.actor_id,
    });
    const unboundExecution = createExecution(store, "revision:unbound", "workspace:test");
    expect(() => createNode(store, unboundExecution.execution_id, "revision:unbound", "unbound"))
      .toThrow(/no current runtime binding/);

    const retired = createPublishedActorRuntime(actors, runtimes, "workspace:test", "retired");
    actors.setActorStatus({
      actor_id: retired.actor_id,
      status: "retired",
      expected_current_definition_revision_id: retired.actor_definition_revision_id,
    });
    seedPlacement(db, {
      revision_id: "revision:retired",
      node_id: "retired",
      kind: "actor",
      resource_id: retired.actor_id,
    });
    const retiredExecution = createExecution(store, "revision:retired", "workspace:test");
    expect(() => createNode(store, retiredExecution.execution_id, "revision:retired", "retired"))
      .toThrow(/retired/);

    const retiredProfile = createPublishedActorRuntime(actors, runtimes, "workspace:test", "retired-runtime");
    runtimes.setProfileStatus({
      runtime_profile_id: retiredProfile.runtime_profile_id,
      status: "retired",
      expected_current_revision_id: retiredProfile.runtime_profile_revision_id,
    });
    seedPlacement(db, {
      revision_id: "revision:retired-runtime",
      node_id: "retired-runtime",
      kind: "actor",
      resource_id: retiredProfile.actor_id,
    });
    const retiredProfileExecution = createExecution(store, "revision:retired-runtime", "workspace:test");
    expect(() => createNode(
      store,
      retiredProfileExecution.execution_id,
      "revision:retired-runtime",
      "retired-runtime",
    )).toThrow(/runtime profile .* retired/);

    const unpublishedRuntime = createPublishedActorRuntime(actors, runtimes, "workspace:test", "unpublished-runtime");
    db.prepare(`
      UPDATE runtime_profile_revisions SET published_at = NULL
      WHERE runtime_profile_revision_id = ?
    `).run(unpublishedRuntime.runtime_profile_revision_id);
    seedPlacement(db, {
      revision_id: "revision:unpublished-runtime",
      node_id: "unpublished-runtime",
      kind: "actor",
      resource_id: unpublishedRuntime.actor_id,
    });
    const unpublishedRuntimeExecution = createExecution(store, "revision:unpublished-runtime", "workspace:test");
    expect(() => createNode(
      store,
      unpublishedRuntimeExecution.execution_id,
      "revision:unpublished-runtime",
      "unpublished-runtime",
    )).toThrow(/not retained and published/);

    const foreignActor = publishActor(actors, "workspace:other", "actor:foreign", "Foreign");
    seedPlacement(db, {
      revision_id: "revision:foreign",
      node_id: "foreign",
      kind: "actor",
      resource_id: foreignActor.actor_id,
    });
    const foreignExecution = createExecution(store, "revision:foreign", "workspace:test");
    expect(() => createNode(store, foreignExecution.execution_id, "revision:foreign", "foreign"))
      .toThrow(/outside this Workspace/);

    const crossActor = publishActor(actors, "workspace:test", "actor:cross", "Cross profile");
    const crossProfile = publishRuntime(runtimes, "workspace:other", "runtime:cross", "Cross profile runtime");
    runtimes.bindActor({
      actor_id: crossActor.actor_id,
      runtime_profile_revision_id: crossProfile.runtime_profile_revision_id,
      status: "resolved",
      expected_current_binding_id: null,
      created_by_principal_id: "principal:operator",
    });
    seedPlacement(db, {
      revision_id: "revision:cross-profile",
      node_id: "cross-profile",
      kind: "actor",
      resource_id: crossActor.actor_id,
    });
    const crossExecution = createExecution(store, "revision:cross-profile", "workspace:test");
    expect(() => createNode(store, crossExecution.execution_id, "revision:cross-profile", "cross-profile"))
      .toThrow(/outside this Workspace/);

    expect((db.prepare(`SELECT COUNT(*) AS count FROM node_executions`).get() as { count: number }).count).toBe(0);
  });

  it("retains nullable legacy rows but will not start an unpinned legacy Actor execution", () => {
    const legacyDb = new DatabaseSync(":memory:");
    try {
      applyActorDefinitionSchema(legacyDb);
      applyRuntimeProfileSchema(legacyDb);
      applyScopeCompositionSchema(legacyDb);
      createLegacyExecutionTables(legacyDb);
      legacyDb.prepare(`
        INSERT INTO execution_attempts (
          attempt_id, node_execution_id, ordinal, delivery_id,
          delivery_bundle_id, status, runtime_json, resource_use_json,
          result_json, error_json, created_at, started_at, completed_at
        ) VALUES (
          'attempt:retained', 'node:retained', 1, NULL, NULL, 'completed',
          '{}', '{}', '{}', '{}', '2026-09-03T00:00:00.000Z',
          '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:01.000Z'
        )
      `).run();
      expect(columnNames(legacyDb, "node_executions")).not.toContain("actor_definition_revision_id");
      applyScopeExecutionSchema(legacyDb);
      const legacyActors = new ActorDefinitionStore(legacyDb);
      const legacyRuntimes = new RuntimeProfileStore(legacyDb);
      const legacyStore = new ScopeExecutionStore(legacyDb);
      const current = createPublishedActorRuntime(
        legacyActors,
        legacyRuntimes,
        "workspace:test",
        "legacy",
      );
      seedPlacement(legacyDb, {
        revision_id: "revision:legacy",
        node_id: "legacy",
        kind: "actor",
        resource_id: current.actor_id,
      });
      const execution = createExecution(legacyStore, "revision:legacy", "workspace:test");
      legacyDb.prepare(`
        INSERT INTO node_executions (
          node_execution_id, execution_id, revision_id, node_id, activation_key,
          context_id, status, assigned_actor_ids_json, missing_port_ids_json,
          failure_json, created_at, activated_at
        ) VALUES ('node:legacy', ?, 'revision:legacy', 'legacy', 'legacy',
          'context:legacy', 'ready', ?, '[]', '{}', '2026-09-04T00:00:00.000Z',
          '2026-09-04T00:00:00.000Z')
      `).run(execution.execution_id, JSON.stringify([current.actor_id]));
      const legacy = legacyStore.getNodeExecution("node:legacy");
      expect(legacy).toMatchObject({
        actor_definition_revision_id: null,
        runtime_profile_revision_id: null,
        actor_runtime_binding_id: null,
      });
      expect(() => legacyStore.startAttempt({ node_execution_id: "node:legacy" }))
        .toThrow(/no complete immutable Actor\/runtime pins/);
      expect(legacyStore.getAttempt("attempt:retained")).toMatchObject({
        actor_definition_revision_id: null,
        runtime_profile_revision_id: null,
        actor_runtime_binding_id: null,
      });
      expect((legacyDb.prepare(`SELECT COUNT(*) AS count FROM execution_attempts`).get() as { count: number }).count)
        .toBe(1);
      const columns = legacyDb.prepare(`PRAGMA table_info(node_executions)`).all() as Array<{
        name: string;
        notnull: number;
      }>;
      for (const name of [
        "actor_definition_revision_id",
        "runtime_profile_revision_id",
        "actor_runtime_binding_id",
      ]) {
        expect(columns.find((column) => column.name === name)?.notnull).toBe(0);
      }
      const attemptColumns = legacyDb.prepare(`PRAGMA table_info(execution_attempts)`).all() as Array<{
        name: string;
        notnull: number;
      }>;
      for (const name of [
        "actor_definition_revision_id",
        "runtime_profile_revision_id",
        "actor_runtime_binding_id",
      ]) {
        expect(attemptColumns.find((column) => column.name === name)?.notnull).toBe(0);
      }
    } finally {
      legacyDb.close();
    }
  });

  it("persists deterministic join state across duplicate and out-of-order arrivals", () => {
    seedPlacement(db, { revision_id: "revision:join", node_id: "join", kind: "context" });
    const execution = createExecution(store, "revision:join", "workspace:test");
    const node = store.createOrGetNodeExecution({
      execution_id: execution.execution_id,
      revision_id: execution.revision_id,
      node_id: "join",
      activation_key: "keyed-gather:batch-1",
      join_key: "batch-1",
      context_id: "context:join:batch-1",
      status: "collecting",
    });
    store.initializeRequiredPortExpectations(node.node_execution_id, [
      { port_id: "join:left", min_count: 1 },
      { port_id: "join:right", min_count: 1 },
    ]);
    expect(store.getJoinState(node.node_execution_id)).toMatchObject({
      received: [],
      expected: [{ port_id: "join:left" }, { port_id: "join:right" }],
      missing: [{ port_id: "join:left" }, { port_id: "join:right" }],
      ready: false,
    });

    const right = store.acceptInput({
      node_execution_id: node.node_execution_id,
      port_id: "join:right",
      delivery_id: "delivery:right:first",
      event_id: "event:right",
      artefact_version_id: "version:right",
    });
    const duplicate = store.acceptInput({
      node_execution_id: node.node_execution_id,
      port_id: "join:right",
      delivery_id: "delivery:right:duplicate",
      event_id: "event:right:duplicate",
      artefact_version_id: "version:right",
    });
    expect(duplicate.input_id).toBe(right.input_id);
    expect(store.getJoinState(node.node_execution_id).missing.map((item) => item.port_id))
      .toEqual(["join:left"]);

    store.acceptInput({
      node_execution_id: node.node_execution_id,
      port_id: "join:left",
      delivery_id: "delivery:left",
      event_id: "event:left",
      artefact_version_id: "version:left",
    });
    expect(store.getJoinState(node.node_execution_id)).toMatchObject({
      received: [{ port_id: "join:left" }, { port_id: "join:right" }],
      missing: [],
      ready: true,
    });

    // A fresh store over the same durable records reconstructs the exact join;
    // readiness is not held in process memory.
    applyScopeExecutionSchema(db);
    const afterRestart = new ScopeExecutionStore(db).getJoinState(node.node_execution_id);
    expect(afterRestart.ready).toBe(true);
    expect(afterRestart.received.map((item) => item.input_identity).sort()).toEqual([
      "artefact:version:left:member:",
      "artefact:version:right:member:",
    ]);
  });

  it("keeps failed, late, and superseded members inspectable without changing accepted runtime inputs", () => {
    seedPlacement(db, { revision_id: "revision:members", node_id: "join", kind: "context" });
    const execution = createExecution(store, "revision:members", "workspace:test");
    const node = store.createOrGetNodeExecution({
      execution_id: execution.execution_id,
      revision_id: execution.revision_id,
      node_id: "join",
      activation_key: "keyed-gather:batch-2",
      join_key: "batch-2",
      context_id: "context:join:batch-2",
      status: "collecting",
    });
    const original = store.acceptInput({
      node_execution_id: node.node_execution_id,
      port_id: "join:member",
      delivery_id: "delivery:old",
      event_id: "event:old",
      artefact_version_id: "version:old",
      member_key: "crate",
    });
    const replacement = store.acceptInput({
      node_execution_id: node.node_execution_id,
      port_id: "join:member",
      delivery_id: "delivery:new",
      event_id: "event:new",
      artefact_version_id: "version:new",
      member_key: "crate",
      supersedes_input_id: original.input_id,
      reason: { code: "operator_replaced_input" },
    });
    store.registerExpectedMembership({
      node_execution_id: node.node_execution_id,
      collection_port_id: "join:manifest",
      member_port_id: "join:member",
      collection_artefact_version_id: "version:manifest",
      match_policy: "member_key",
      members: [
        { member_key: "crate", member_version_id: "version:old" },
        { member_key: "barrel", member_version_id: "version:barrel" },
      ],
    });
    store.failExpectedMember({
      node_execution_id: node.node_execution_id,
      port_id: "join:member",
      member_key: "barrel",
      reason: { code: "producer_failed" },
    });
    const late = store.acceptInput({
      node_execution_id: node.node_execution_id,
      port_id: "join:member",
      delivery_id: "delivery:late",
      event_id: "event:late",
      artefact_version_id: "version:late",
      member_key: "barrel",
      state: "late",
      reason: { code: "arrived_after_failure" },
    });

    const state = store.getJoinState(node.node_execution_id);
    expect(state.received.map((item) => item.input_id)).toEqual([replacement.input_id]);
    expect(state.failed).toEqual([expect.objectContaining({ member_key: "barrel" })]);
    expect(state.late).toEqual([expect.objectContaining({ input_id: late.input_id })]);
    expect(state.superseded.inputs).toEqual([expect.objectContaining({ input_id: original.input_id })]);
    expect(store.listReceivedInputs(node.node_execution_id).map((item) => item.input_id))
      .toEqual([replacement.input_id]);
    expect(store.getNodeExecution(node.node_execution_id)?.status).toBe("blocked");
  });

  it("refuses to resurrect a terminal NodeExecution after restart", () => {
    seedPlacement(db, { revision_id: "revision:terminal", node_id: "work", kind: "context" });
    const execution = createExecution(store, "revision:terminal", "workspace:test");
    const node = store.createOrGetNodeExecution({
      execution_id: execution.execution_id,
      revision_id: execution.revision_id,
      node_id: "work",
      activation_key: "per-delivery:one",
      context_id: "context:terminal",
      status: "ready",
    });
    store.setNodeExecutionStatus(node.node_execution_id, "completed");
    applyScopeExecutionSchema(db);
    const restarted = new ScopeExecutionStore(db);
    expect(() => restarted.setNodeExecutionStatus(node.node_execution_id, "ready"))
      .toThrow(/cannot move from 'completed' to 'ready'/);
  });

  it("persists a pause barrier across restart and resumes the exact queued work", () => {
    createQueueSchema(db);
    seedPlacement(db, { revision_id: "revision:pause", node_id: "worker", kind: "context" });
    const execution = createExecution(store, "revision:pause", "workspace:test");
    const node = store.createOrGetNodeExecution({
      execution_id: execution.execution_id,
      revision_id: execution.revision_id,
      node_id: "worker",
      activation_key: "one",
      context_id: "context:pause",
      status: "ready",
    });
    db.prepare(`
      INSERT INTO event_queue (
        queue_id, state, scope_execution_id, created_at, node_execution_id,
        delivery_id, lease_expires_at, last_error
      ) VALUES ('delivery:pause', 'queued', ?, '2026-09-04T00:00:00.000Z', ?, NULL, NULL, NULL)
    `).run(execution.execution_id, node.node_execution_id);

    const paused = store.pauseExecution({ execution_id: execution.execution_id, reason: "Operator review" });
    expect(paused).toMatchObject({
      execution: { status: "paused", revision_id: "revision:pause" },
      node_execution_ids: [node.node_execution_id],
      delivery_ids: ["delivery:pause"],
    });
    expect(paused.execution.state_revision).toBeGreaterThan(execution.state_revision);
    expect(store.getNodeExecution(node.node_execution_id)?.status).toBe("paused");
    expect((db.prepare(`SELECT state FROM event_queue WHERE queue_id = 'delivery:pause'`).get() as { state: string }).state)
      .toBe("held");

    applyScopeExecutionSchema(db);
    const restarted = new ScopeExecutionStore(db);
    const resumed = restarted.resumeExecution({ execution_id: execution.execution_id });
    expect(resumed.execution).toMatchObject({ status: "active", revision_id: "revision:pause" });
    expect(resumed.execution.state_revision).toBeGreaterThan(paused.execution.state_revision);
    expect(restarted.getNodeExecution(node.node_execution_id)).toMatchObject({
      status: "ready",
      context_id: "context:pause",
      revision_id: "revision:pause",
    });
    expect((db.prepare(`SELECT state FROM event_queue WHERE queue_id = 'delivery:pause'`).get() as { state: string }).state)
      .toBe("queued");
  });

  it("retries the same NodeExecution with exact inputs and pins as a new attempt", () => {
    createQueueSchema(db);
    seedPlacement(db, { revision_id: "revision:retry", node_id: "worker", kind: "context" });
    const execution = createExecution(store, "revision:retry", "workspace:test");
    const node = store.createOrGetNodeExecution({
      execution_id: execution.execution_id,
      revision_id: execution.revision_id,
      node_id: "worker",
      activation_key: "one",
      context_id: "context:retry",
      status: "ready",
    });
    db.prepare(`
      INSERT INTO event_queue (
        queue_id, state, scope_execution_id, created_at, node_execution_id,
        delivery_id, lease_expires_at, last_error
      ) VALUES ('delivery:retry', 'dead_lettered', ?, '2026-09-04T00:00:00.000Z', ?, 'bundle:first', NULL, 'failed')
    `).run(execution.execution_id, node.node_execution_id);
    const first = store.startAttempt({
      node_execution_id: node.node_execution_id,
      delivery_ids: ["delivery:retry"],
      delivery_bundle_id: "bundle:first",
    });
    store.finishAttempt({ attempt_id: first.attempt_id, status: "failed", error: { code: "runtime_failed" } });
    store.setNodeExecutionStatus(node.node_execution_id, "failed", { code: "runtime_failed" });
    store.setExecutionStatus(execution.execution_id, "failed", { code: "node_failed" });

    const retry = store.retryNodeExecution(node.node_execution_id);
    expect(retry).toMatchObject({
      execution: { execution_id: execution.execution_id, revision_id: "revision:retry", status: "active" },
      node_execution: {
        node_execution_id: node.node_execution_id,
        revision_id: "revision:retry",
        context_id: "context:retry",
        status: "retrying",
      },
      previous_attempt: { attempt_id: first.attempt_id, ordinal: 1, status: "failed" },
      delivery_ids: ["delivery:retry"],
    });
    const queue = db.prepare(`SELECT state, delivery_id FROM event_queue WHERE queue_id = 'delivery:retry'`)
      .get() as { state: string; delivery_id: string | null };
    expect(queue).toEqual({ state: "queued", delivery_id: null });
    const second = store.startAttempt({
      node_execution_id: node.node_execution_id,
      delivery_ids: retry.delivery_ids,
      delivery_bundle_id: "bundle:second",
    });
    expect(second).toMatchObject({
      ordinal: 2,
      node_execution_id: node.node_execution_id,
      actor_definition_revision_id: node.actor_definition_revision_id,
      runtime_profile_revision_id: node.runtime_profile_revision_id,
      actor_runtime_binding_id: node.actor_runtime_binding_id,
    });
  });
});

const baseDefinition: ActorDefinitionContent = {
  label: "Actor",
  charter: "Perform the assigned responsibility.",
  responsibilities: [],
  instructions: "Use the exact inputs and report the exact outcome.",
  knowledge_refs: [],
  capability_grant_ids: [],
  policy_refs: { budget: null, trust: null, approval: null },
  escalation_rules: [],
};

const baseRuntime: RuntimeProfileContent = {
  label: "Runtime",
  backing_kind: "model",
  adapter_id: "adapter:primary",
  configuration: { mode: "balanced" },
  secret_ref_ids: ["secret-ref:runtime"],
  required_capability_ids: [],
  checkpoint_policy: { mode: "provider_neutral", schema_ref: null },
  resource_policy: {},
};

function actorDefinition(label: string): ActorDefinitionContent {
  return { ...baseDefinition, label };
}

function runtimeProfile(label: string): RuntimeProfileContent {
  return { ...baseRuntime, label };
}

function publishActor(
  actors: ActorDefinitionStore,
  workspaceId: string,
  actorId: string,
  label: string,
) {
  const created = actors.createActor({
    workspace_id: workspaceId,
    actor_id: actorId,
    created_by_principal_id: "principal:operator",
    definition: actorDefinition(label),
  });
  const revision = actors.publishDraft({
    actor_definition_revision_id: created.draft.actor_definition_revision_id,
    expected_current_revision_id: null,
    changed_by_principal_id: "principal:operator",
  });
  return { actor_id: created.actor.actor_id, revision };
}

function publishRuntime(
  runtimes: RuntimeProfileStore,
  workspaceId: string,
  profileId: string,
  label: string,
) {
  const created = runtimes.createProfile({
    runtime_profile_id: profileId,
    owner: { kind: "workspace", id: workspaceId },
    created_by_principal_id: "principal:operator",
    content: runtimeProfile(label),
  });
  return runtimes.publishDraft({
    runtime_profile_revision_id: created.draft.runtime_profile_revision_id,
    expected_current_revision_id: null,
    changed_by_principal_id: "principal:operator",
  });
}

function createPublishedActorRuntime(
  actors: ActorDefinitionStore,
  runtimes: RuntimeProfileStore,
  workspaceId: string,
  suffix: string,
) {
  const actor = publishActor(actors, workspaceId, `actor:${suffix}`, `Actor ${suffix}`);
  const runtime = publishRuntime(runtimes, workspaceId, `runtime:${suffix}`, `Runtime ${suffix}`);
  const binding = runtimes.bindActor({
    actor_id: actor.actor_id,
    runtime_profile_revision_id: runtime.runtime_profile_revision_id,
    status: "resolved",
    expected_current_binding_id: null,
    created_by_principal_id: "principal:operator",
  });
  return {
    actor_id: actor.actor_id,
    actor_definition_revision_id: actor.revision.actor_definition_revision_id,
    runtime_profile_id: runtime.runtime_profile_id,
    runtime_profile_revision_id: runtime.runtime_profile_revision_id,
    actor_runtime_binding_id: binding.actor_runtime_binding_id,
  };
}

function seedPlacement(db: DatabaseSync, input: {
  revision_id: string;
  node_id: string;
  kind: "actor" | "context";
  resource_id?: string;
}): void {
  const existing = db.prepare(`
    SELECT revision_id FROM scope_composition_revisions WHERE revision_id = ?
  `).get(input.revision_id);
  if (!existing) {
    const revisionNumber = Number((db.prepare(`
      SELECT COALESCE(MAX(revision_number), 0) + 1 AS next
      FROM scope_composition_revisions
      WHERE workspace_id = 'workspace:test' AND scope_id = 'delivery'
    `).get() as { next: number }).next);
    db.prepare(`
      INSERT INTO scope_composition_revisions (
        revision_id, workspace_id, scope_id, revision_number, routing_mode,
        based_on_revision_id, semantic_digest, created_by_endpoint_id,
        created_at, published_at, withdrawn_at
      ) VALUES (?, 'workspace:test', 'delivery', ?, 'edge', NULL, ?, NULL,
        '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z', NULL)
    `).run(input.revision_id, revisionNumber, `digest:${input.revision_id}`);
  }
  db.prepare(`
    INSERT INTO scope_node_placements (
      revision_id, node_id, kind, label, resource_id, config_json,
      bindings_json, activation_json, context_policy_json
    ) VALUES (?, ?, ?, ?, ?, '{}', '[]', '{}', '{}')
  `).run(input.revision_id, input.node_id, input.kind, input.node_id, input.resource_id ?? input.node_id);
}

function createExecution(store: ScopeExecutionStore, revisionId: string, workspaceId: string) {
  return store.createExecution({
    workspace_id: workspaceId,
    scope_id: "delivery",
    revision_id: revisionId,
    ingress_node_id: "work-arrived",
    ingress_port_id: "work-arrived:out",
  });
}

function createNode(
  store: ScopeExecutionStore,
  executionId: string,
  revisionId: string,
  nodeId: string,
) {
  return store.createOrGetNodeExecution({
    execution_id: executionId,
    revision_id: revisionId,
    node_id: nodeId,
    activation_key: `activation:${nodeId}`,
    context_id: `context:${nodeId}`,
    status: "ready",
  });
}

function createLegacyExecutionTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE node_executions (
      node_execution_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      activation_key TEXT NOT NULL,
      context_id TEXT NOT NULL,
      status TEXT NOT NULL,
      assigned_actor_ids_json TEXT NOT NULL,
      missing_port_ids_json TEXT NOT NULL,
      failure_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      activated_at TEXT,
      completed_at TEXT,
      cancelled_at TEXT,
      UNIQUE (execution_id, node_id, activation_key)
    );

    CREATE TABLE execution_attempts (
      attempt_id TEXT PRIMARY KEY,
      node_execution_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      delivery_id TEXT,
      delivery_bundle_id TEXT,
      status TEXT NOT NULL,
      runtime_json TEXT NOT NULL,
      resource_use_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      error_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      UNIQUE (node_execution_id, ordinal)
    );
  `);
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((column) => column.name);
}

function createQueueSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_queue (
      queue_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      scope_execution_id TEXT,
      created_at TEXT NOT NULL,
      node_execution_id TEXT,
      delivery_id TEXT,
      lease_expires_at TEXT,
      last_error TEXT
    );
  `);
}
