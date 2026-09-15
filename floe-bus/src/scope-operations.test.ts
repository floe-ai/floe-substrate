import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import { emitViaRoute } from "./test-support/emit-via-route.js";
import { defaultConfig, type LocalConfig } from "./config.js";
import { AjvOperationSchemaValidator } from "./operation-schema-validator-ajv.js";
import { createTestOperationRegistry } from "./operation-test-fixtures.js";
import {
  refusal,
  requiredAction,
  type OperationAuthorityContext,
  type OperationInvocationEnvironment,
  type OperationInvocationRequest,
  type OperationInvocationResponse,
  type ResolvedOperationResource,
} from "./operations.js";
import { ScopeCompositionConflictError, type ScopeCompositionContent } from "./scope-compositions.js";
import {
  CLONE_SCOPE_REVISION_OPERATION_ID,
  COMPARE_SCOPE_REVISIONS_OPERATION_ID,
  CREATE_SCOPE_DRAFT_OPERATION_ID,
  CREATE_SCOPE_OPERATION_ID,
  LIST_SCOPES_OPERATION_ID,
  EXPORT_SCOPE_REVISION_OPERATION_ID,
  IMPORT_SCOPE_REVISION_OPERATION_ID,
  INSPECT_SCOPE_EXECUTION_OPERATION_ID,
  INSPECT_SCOPE_PLAN_OPERATION_ID,
  INSPECT_SCOPE_REVISION_IMPACT_OPERATION_ID,
  NO_PUBLISHED_SCOPE_REVISION,
  PAUSE_SCOPE_EXECUTION_OPERATION_ID,
  PUBLISH_SCOPE_OUTPUT_OPERATION_ID,
  PUBLISH_SCOPE_REVISION_OPERATION_ID,
  REDO_SCOPE_EXECUTION_OPERATION_ID,
  REPLACE_SCOPE_DRAFT_OPERATION_ID,
  RESUME_SCOPE_EXECUTION_OPERATION_ID,
  RETRY_NODE_EXECUTION_OPERATION_ID,
  ROLLBACK_SCOPE_REVISION_OPERATION_ID,
  SIMULATE_SCOPE_REVISION_OPERATION_ID,
  START_SCOPE_EXECUTION_OPERATION_ID,
  STOP_SCOPE_EXECUTION_OPERATION_ID,
  VALIDATE_SCOPE_REVISION_OPERATION_ID,
  ScopeOperationRefusalError,
  nodeExecutionStateRevision,
  registerScopeOperations,
  scopeExecutionStateRevision,
  startScopeExecutionOperation,
  type ScopeExecutionInspection,
  type ScopeOperationBackend,
  type ScopePlanInspection,
} from "./scope-operations.js";
import { BusScopeOperationBackend } from "./scope-operation-backend.js";
import { registerExecutableActorFixture } from "./executable-actor-test-fixture.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

const ALL_GRANTS = [
  CREATE_SCOPE_OPERATION_ID,
  LIST_SCOPES_OPERATION_ID,
  "scope.plan.inspect",
  "scope.composition.draft.create",
  "scope.composition.draft.replace",
  "scope.composition.validate",
  "scope.composition.simulate",
  "scope.composition.compare",
  "scope.composition.impact.inspect",
  "scope.composition.publish",
  "scope.composition.rollback",
  "scope.composition.clone",
  "scope.composition.export",
  "scope.composition.import",
  "scope.execution.inspect",
  "scope.execution.start",
  "scope.node-output.publish",
  "scope.execution.pause",
  "scope.execution.resume",
  "scope.node-execution.retry",
  "scope.execution.redo",
  "scope.execution.stop",
];

async function makeServer(): Promise<{ handle: ServerHandle; temp: string; workspaceId: string }> {
  const temp = mkdtempSync(join(tmpdir(), "floe-scope-operations-"));
  const configPath = join(temp, "config.yaml");
  const config: LocalConfig = defaultConfig(temp);
  writeFileSync(configPath, YAML.stringify(config), "utf8");
  const handle = await createBusServer(configPath, config, { unsafe_in_process_test_auth_bypass: true });
  await handle.app.ready();
  const locator = join(temp, "workspace");
  mkdirSync(locator, { recursive: true });
  const response = await handle.app.inject({
    method: "POST",
    url: "/v1/workspaces/register",
    headers: { authorization: `Bearer ${handle.localControlToken}` },
    payload: { locator, name: "Scope operation proof" },
  });
  const workspaceId = response.json().workspace.workspace_id as string;
  handle.store.createScope({
    workspace_id: workspaceId,
    scope_id: "delivery",
    title: "Delivery",
  }, handle.broadcast);
  return { handle, temp, workspaceId };
}

function registerEndpoint(handle: ServerHandle, workspaceId: string, name: string): string {
  const endpointId = `actor:${workspaceId}:${name}`;
  handle.store.registerEndpoint({
    endpoint_id: endpointId,
    workspace_id: workspaceId,
    name,
    bridge_id: null,
    status: "idle",
  }, handle.broadcast);
  registerExecutableActorFixture(handle.store, workspaceId, endpointId);
  return endpointId;
}

function authority(
  principalId: string,
  workspaceId: string,
  mode: "interactive" | "unattended",
): OperationAuthorityContext & { boundary: { kind: "workspace"; workspace_id: string } } {
  return {
    principal_id: principalId,
    boundary: { kind: "workspace", workspace_id: workspaceId },
    grants: new Set(ALL_GRANTS),
    interaction: {
      mode,
      session_id: `session:${principalId}`,
      confirmed_prompts: new Set(),
      approval_refs: new Set(),
    },
  };
}

function backend(handle: ServerHandle): ScopeOperationBackend {
  const store = handle.store;
  const canonical = new BusScopeOperationBackend(handle.store, handle.broadcast);
  const ensure = (condition: boolean, scopeId: string, expected: string | null, actual: string | null) => {
    if (!condition) throw new ScopeCompositionConflictError(scopeId, expected, actual);
  };
  return {
    createScope: input => canonical.createScope(input),
    listScopes: workspaceId => canonical.listScopes(workspaceId),
    getScope: (workspaceId, scopeId) => store.scopeStore.getScope(workspaceId, scopeId),
    getRevision: (revisionId) => store.getScopeCompositionRevision(revisionId),
    getPublishedRevision: (workspaceId, scopeId) => store.getPublishedScopeComposition(workspaceId, scopeId),
    listRevisions: (workspaceId, scopeId) => store.listScopeCompositionRevisions(workspaceId, scopeId),
    listExecutions: (workspaceId, scopeId) => store.listScopeExecutions(workspaceId, scopeId),
    getExecution: (executionId) => store.getScopeExecution(executionId),
    getNodeExecution: (nodeExecutionId) => store.scopeExecutionStore.getNodeExecution(nodeExecutionId),
    createDraft: (input) => {
      const current = store.getPublishedScopeComposition(input.workspace_id, input.scope_id)?.revision_id ?? null;
      const expected = input.call.expected_resource_revision === NO_PUBLISHED_SCOPE_REVISION
        ? null
        : input.call.expected_resource_revision;
      ensure(current === expected, input.scope_id, expected, current);
      return store.createScopeCompositionDraft({
        workspace_id: input.workspace_id,
        scope_id: input.scope_id,
        based_on_revision_id: input.based_on_revision_id,
        created_by_endpoint_id: input.call.authority.principal_id,
        content: input.content,
      }, handle.broadcast);
    },
    replaceDraft: (input) => store.replaceScopeCompositionDraft(
      input.revision_id,
      input.content,
      handle.broadcast,
      input.expected_digest,
    ),
    validateRevision: (input) => canonical.validateRevision(input),
    simulateRevision: (input) => canonical.simulateRevision(input),
    compareRevisions: (input) => canonical.compareRevisions(input),
    inspectRevisionImpact: (input) => canonical.inspectRevisionImpact(input),
    publishRevision: (input) => {
      const draft = store.getScopeCompositionRevision(input.revision_id);
      ensure(
        draft?.semantic_digest === input.expected_digest,
        draft?.scope_id ?? "unknown",
        input.expected_digest,
        draft?.semantic_digest ?? null,
      );
      return store.publishScopeComposition({
        revision_id: input.revision_id,
        expected_published_revision_id: input.expected_current_published_revision_id,
        expected_impact_digest: input.expected_impact_digest,
      }, handle.broadcast);
    },
    rollbackRevision: (input) => canonical.rollbackRevision(input),
    cloneRevision: (input) => canonical.cloneRevision(input),
    exportRevision: (input) => canonical.exportRevision(input),
    importRevision: (input) => canonical.importRevision(input),
    inspectPlan: (input): ScopePlanInspection => {
      const current = store.getPublishedScopeComposition(input.workspace_id, input.scope_id);
      const all = store.listScopeCompositionRevisions(input.workspace_id, input.scope_id);
      const selected = input.selected_revision_id
        ? all.find((revision) => revision.revision_id === input.selected_revision_id)
        : current ?? all[0];
      if (!selected) {
        throw new ScopeOperationRefusalError(refusal(
          "scope_plan_empty",
          "This Scope has no plan revisions.",
          false,
          requiredAction("create_scope_draft", "Create a plan", "Create the first Scope composition draft."),
        ));
      }
      const executions = store.listScopeExecutions(input.workspace_id, input.scope_id);
      const role = (revision: typeof selected) => revision.withdrawn_at
        ? "withdrawn_draft" as const
        : revision.revision_id === current?.revision_id
          ? "current_published" as const
          : revision.published_at
            ? "historical_published" as const
            : "draft" as const;
      const visible = input.include_history
        ? all
        : all.filter((revision) => revision.revision_id === current?.revision_id || revision.revision_id === selected.revision_id);
      return {
        scope_id: input.scope_id,
        current_published_revision_id: current?.revision_id ?? null,
        selected_revision_id: selected.revision_id,
        selected_role: role(selected),
        history_complete: input.include_history,
        revisions: visible.map((revision) => ({
          revision,
          role: role(revision),
          pinned_execution_ids: executions
            .filter((execution) => execution.revision_id === revision.revision_id)
            .map((execution) => execution.execution_id),
        })),
      };
    },
    startExecution: (input) => {
      const current = store.getPublishedScopeComposition(input.workspace_id, input.scope_id)?.revision_id ?? null;
      ensure(current === input.expected_published_revision_id, input.scope_id, input.expected_published_revision_id, current);
      const result = store.startScopeExecution({
        workspace_id: input.workspace_id,
        scope_id: input.scope_id,
        ingress_node_id: input.ingress_node_id,
        output_port_id: input.output_port_id,
        content: input.content,
        correlation_id: input.correlation_id,
        cause_event_id: input.cause_event_id,
        initiator_endpoint_id: input.call.authority.principal_id,
        idempotency_key: input.call.idempotency_key,
      }, handle.broadcast);
      return {
        execution: result.execution,
        root_event_id: result.root_event.event_id,
        publication_id: result.publication.publication_id,
        delivery_ids: result.delivery_ids,
      };
    },
    inspectExecution: (input): ScopeExecutionInspection => {
      const projection = store.getScopeExecutionProjection(input.execution_id);
      if (!projection || projection.execution.workspace_id !== input.workspace_id) {
        throw new ScopeOperationRefusalError(refusal(
          "scope_execution_not_found",
          "This Scope execution is not available in the current Workspace.",
          false,
          requiredAction("refresh_workspace", "Refresh the Workspace", "Select an available Scope execution."),
        ));
      }
      const current = store.getPublishedScopeComposition(input.workspace_id, projection.execution.scope_id);
      return {
        execution: projection.execution,
        pinned_revision: projection.revision,
        current_published_revision_id: current?.revision_id ?? null,
        pinned_revision_role: current?.revision_id === projection.execution.revision_id
          ? "current_published"
          : "historical_published",
        node_executions: projection.node_executions.map((node) => ({
          ...node,
          resource_ref: { kind: "node_execution" as const, id: node.node_execution_id, revision: nodeExecutionStateRevision(node) },
          input_delivery_ids: node.inputs.map((entry) => entry.delivery_id),
          attempt_ids: (node.attempts as Array<{ attempt_id: string }>).map((attempt) => attempt.attempt_id),
          publication_ids: (node.publications as Array<{ publication_id: string }>).map((publication) => publication.publication_id),
          inputs: undefined,
          attempts: undefined,
          publications: undefined,
        })).map(({ inputs: _inputs, attempts: _attempts, publications: _publications, ...node }) => node),
        traversals: (projection.traversals as Array<{
          publication_id: string;
          edge_id: string;
          delivery_id: string;
          target_node_execution_id: string;
        }>).map((item) => ({
          publication_id: item.publication_id,
          edge_id: item.edge_id,
          delivery_id: item.delivery_id,
          target_node_execution_id: item.target_node_execution_id,
        })),
      };
    },
    publishNodeOutput: (input) => {
      const before = store.scopeExecutionStore.getNodeExecution(input.node_execution_id);
      if (!before || nodeExecutionStateRevision(before) !== input.call.expected_resource_revision) {
        throw new ScopeOperationRefusalError(refusal(
          "node_execution_revision_conflict",
          "The Node execution changed before its output was published.",
          true,
          requiredAction("refresh_scope_execution", "Refresh the execution", "Inspect the Node execution and retry against its current state."),
        ));
      }
      const result = store.publishScopeNodeOutput({
        workspace_id: input.workspace_id,
        node_execution_id: input.node_execution_id,
        port_id: input.port_id,
        publisher_endpoint_id: input.call.authority.principal_id,
        ...(input.event_type ? { event_type: input.event_type } : {}),
        content: input.content,
        lifecycle_outcome: input.lifecycle_outcome,
        artefact_version_ids: input.artefact_version_ids,
        idempotency_key: input.call.idempotency_key,
      }, handle.broadcast);
      return {
        execution: result.execution,
        node_execution: result.node_execution,
        event_id: result.event.event_id,
        publication_id: result.publication.publication_id,
        delivery_ids: result.delivery_ids,
      };
    },
    stopExecution: (input) => {
      const execution = store.getScopeExecution(input.execution_id);
      if (!execution || scopeExecutionStateRevision(execution) !== input.call.expected_resource_revision) {
        throw new ScopeOperationRefusalError(refusal(
          "scope_execution_revision_conflict",
          "The Scope execution changed before it could be stopped.",
          true,
          requiredAction("refresh_scope_execution", "Refresh the execution", "Inspect the current execution state and retry."),
        ));
      }
      const nodes = store.scopeExecutionStore.listNodeExecutions(input.execution_id);
      let stoppedNodes = 0;
      for (const node of nodes) {
        if ([
          "collecting",
          "ready",
          "active",
          "waiting_external",
          "paused",
          "retrying",
          "blocked",
        ].includes(node.status)) {
          store.scopeExecutionStore.setNodeExecutionStatus(node.node_execution_id, "cancelled");
          stoppedNodes += 1;
        }
      }
      const queueRows = store.db.prepare(`
        SELECT q.queue_id, q.state
        FROM event_queue q
        WHERE q.scope_execution_id = ? AND q.state IN ('held', 'queued', 'delivering')
      `).all(input.execution_id) as Array<{ queue_id: string; state: string }>;
      const pending = queueRows.filter((row) => row.state !== "delivering").length;
      const active = queueRows.filter((row) => row.state === "delivering").length;
      store.db.prepare(`
        UPDATE event_queue SET state = 'cancelled', last_error = ?
        WHERE scope_execution_id = ? AND state IN ('held', 'queued', 'delivering')
      `).run(input.reason ?? "Scope execution stopped", input.execution_id);
      const cancelled = store.scopeExecutionStore.setExecutionStatus(input.execution_id, "cancelled", {
        reason: input.reason,
        operation_invocation_id: input.call.invocation_id,
      });
      return {
        execution: cancelled,
        stopped: {
          pending_deliveries: pending,
          active_deliveries: active,
          node_executions: stoppedNodes,
          workers: 0,
          callbacks: 0,
          connector_actions: 0,
        },
        uncertain_external_effects: [],
      };
    },
    pauseExecution: (input) => canonical.pauseExecution(input),
    resumeExecution: (input) => canonical.resumeExecution(input),
    retryNodeExecution: (input) => canonical.retryNodeExecution(input),
    redoExecution: (input) => canonical.redoExecution(input),
  };
}

function resolver(
  operationBackend: ScopeOperationBackend,
  principal: OperationAuthorityContext,
): OperationInvocationEnvironment {
  return {
    authority: principal,
    resolve_resource: async (target): Promise<ResolvedOperationResource | null> => {
      if (principal.boundary.kind !== "workspace") return null;
      const workspaceId = principal.boundary.workspace_id;
      if (target.kind === "scope") {
        const scope = operationBackend.getScope(workspaceId, target.id);
        if (!scope) return null;
        const current = operationBackend.getPublishedRevision(workspaceId, target.id);
        return {
          ref: { ...target, revision: current?.revision_id ?? NO_PUBLISHED_SCOPE_REVISION },
          state: scope,
        };
      }
      if (target.kind === "scope_composition_revision") {
        const revision = operationBackend.getRevision(target.id);
        return revision?.workspace_id === workspaceId
          ? { ref: { ...target, revision: revision.semantic_digest }, state: revision }
          : null;
      }
      if (target.kind === "scope_execution") {
        const execution = operationBackend.getExecution(target.id);
        return execution?.workspace_id === workspaceId
          ? { ref: { ...target, revision: scopeExecutionStateRevision(execution) }, state: execution }
          : null;
      }
      if (target.kind === "node_execution") {
        const node = operationBackend.getNodeExecution(target.id);
        const execution = node ? operationBackend.getExecution(node.execution_id) : null;
        return node && execution?.workspace_id === workspaceId
          ? { ref: { ...target, revision: nodeExecutionStateRevision(node) }, state: node }
          : null;
      }
      return null;
    },
    now: () => "2026-09-03T14:00:00.000Z",
  };
}

function request(
  operationId: string,
  target: { kind: string; id: string },
  input: unknown,
  idempotencyKey: string,
  expectedResourceRevision?: string,
): OperationInvocationRequest {
  return {
    operation_id: operationId,
    operation_version: "1",
    input_schema_version: "1",
    target,
    input,
    idempotency_key: idempotencyKey,
    ...(expectedResourceRevision !== undefined
      ? { expected_resource_revision: expectedResourceRevision }
      : {}),
  };
}

function receipt(response: OperationInvocationResponse) {
  expect(response.kind).toBe("receipt");
  if (response.kind !== "receipt") throw new Error("Expected operation receipt");
  return response.receipt;
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

describe("Bus-owned Scope semantic operations", () => {
  let handle: ServerHandle;
  let temp: string;
  let workspaceId: string;
  let operationBackend: ScopeOperationBackend;
  let registry: ReturnType<typeof createTestOperationRegistry>;

  beforeEach(async () => {
    ({ handle, temp, workspaceId } = await makeServer());
    operationBackend = backend(handle);
    registry = registerScopeOperations(
      createTestOperationRegistry(new AjvOperationSchemaValidator()),
      operationBackend,
    );
  });

  afterEach(async () => {
    try { await handle.app.close(); } catch {}
    rmSync(temp, { recursive: true, force: true });
  });

  it("projects identical contracts and results for interactive and unattended clients", async () => {
    const interactive = authority("principal:desktop", workspaceId, "interactive");
    const unattended = authority("principal:runtime", workspaceId, "unattended");
    const [allInteractive, allUnattended] = await Promise.all([
      registry.project({ authority: interactive }),
      registry.project({ authority: unattended }),
    ]);
    expect(allInteractive).toEqual(allUnattended);
    expect(allInteractive.map((item) => item.operation_id)).toEqual([
      CREATE_SCOPE_OPERATION_ID,
      LIST_SCOPES_OPERATION_ID,
      CREATE_SCOPE_DRAFT_OPERATION_ID,
      REPLACE_SCOPE_DRAFT_OPERATION_ID,
      VALIDATE_SCOPE_REVISION_OPERATION_ID,
      SIMULATE_SCOPE_REVISION_OPERATION_ID,
      COMPARE_SCOPE_REVISIONS_OPERATION_ID,
      INSPECT_SCOPE_REVISION_IMPACT_OPERATION_ID,
      PUBLISH_SCOPE_REVISION_OPERATION_ID,
      ROLLBACK_SCOPE_REVISION_OPERATION_ID,
      CLONE_SCOPE_REVISION_OPERATION_ID,
      EXPORT_SCOPE_REVISION_OPERATION_ID,
      IMPORT_SCOPE_REVISION_OPERATION_ID,
      INSPECT_SCOPE_PLAN_OPERATION_ID,
      START_SCOPE_EXECUTION_OPERATION_ID,
      INSPECT_SCOPE_EXECUTION_OPERATION_ID,
      PUBLISH_SCOPE_OUTPUT_OPERATION_ID,
      PAUSE_SCOPE_EXECUTION_OPERATION_ID,
      RESUME_SCOPE_EXECUTION_OPERATION_ID,
      RETRY_NODE_EXECUTION_OPERATION_ID,
      REDO_SCOPE_EXECUTION_OPERATION_ID,
      STOP_SCOPE_EXECUTION_OPERATION_ID,
    ]);
    expect(allInteractive.every((item) =>
      item.interaction_constraints.allowed_modes.includes("interactive")
      && item.interaction_constraints.allowed_modes.includes("unattended")
    )).toBe(true);

    const target = await resolver(operationBackend, interactive).resolve_resource({ kind: "scope", id: "delivery" });
    const [interactiveProjection, unattendedProjection] = await Promise.all([
      registry.project({ authority: interactive, target }),
      registry.project({ authority: unattended, target }),
    ]);

    expect(interactiveProjection).toEqual(unattendedProjection);
    expect(interactiveProjection.map((item) => item.operation_id)).toEqual([
      CREATE_SCOPE_DRAFT_OPERATION_ID,
      IMPORT_SCOPE_REVISION_OPERATION_ID,
      INSPECT_SCOPE_PLAN_OPERATION_ID,
      START_SCOPE_EXECUTION_OPERATION_ID,
    ]);
    const draft = receipt(await registry.invoke(
      resolver(operationBackend, interactive),
      request(
        CREATE_SCOPE_DRAFT_OPERATION_ID,
        { kind: "scope", id: "delivery" },
        {
          content: {
            nodes: [{ node_id: "ingress", kind: "event", context_policy: { mode: "new_per_execution" } }],
            ports: [{ port_id: "ingress:out", node_id: "ingress", name: "start", direction: "output" }],
            edges: [],
          },
        },
        "create-minimal",
        NO_PUBLISHED_SCOPE_REVISION,
      ),
    ));
    expect(draft.state).toBe("completed");

    const [interactiveInspect, unattendedInspect] = await Promise.all([
      registry.invoke(
        resolver(operationBackend, interactive),
        request(INSPECT_SCOPE_PLAN_OPERATION_ID, { kind: "scope", id: "delivery" }, {}, "inspect-interactive"),
      ),
      registry.invoke(
        resolver(operationBackend, unattended),
        request(INSPECT_SCOPE_PLAN_OPERATION_ID, { kind: "scope", id: "delivery" }, {}, "inspect-unattended"),
      ),
    ]);
    expect(receipt(interactiveInspect).result).toEqual(receipt(unattendedInspect).result);
  });

  it("refuses a stale current-plan revision before starting work", async () => {
    const principal = authority("principal:desktop", workspaceId, "interactive");
    const draft = handle.store.createScopeCompositionDraft({
      workspace_id: workspaceId,
      scope_id: "delivery",
      content: {
        nodes: [{ node_id: "ingress", kind: "event", context_policy: { mode: "new_per_execution" } }],
        ports: [{ port_id: "ingress:out", node_id: "ingress", name: "start", direction: "output" }],
        edges: [],
      },
    }, handle.broadcast);
    const published = handle.store.publishScopeComposition({
      revision_id: draft.revision_id,
      expected_published_revision_id: null,
    }, handle.broadcast);

    const response = receipt(await registry.invoke(
      resolver(operationBackend, principal),
      request(
        START_SCOPE_EXECUTION_OPERATION_ID,
        { kind: "scope", id: "delivery" },
        { ingress_node_id: "ingress", output_port_id: "ingress:out", content: {} },
        "stale-start",
        "revision_superseded",
      ),
    ));

    expect(response).toMatchObject({
      state: "refused",
      target: { revision: published.revision_id },
      refusal: {
        code: "operation_resource_revision_conflict",
        retryable: true,
        required_action: { code: "refresh_resource" },
      },
    });
    expect(handle.store.listScopeExecutions(workspaceId, "delivery")).toHaveLength(0);
  });

  it("takes cause Event identity only from trusted execution context provenance", async () => {
    const principalId = registerEndpoint(handle, workspaceId, "operator-session");
    const recipientId = registerEndpoint(handle, workspaceId, "cause-recipient");
    const principal = authority(principalId, workspaceId, "interactive");
    const cause = (await emitViaRoute(handle, {
      type: "message",
      workspace_id: workspaceId,
      source_endpoint_id: principalId,
      destination: { kind: "endpoint", endpoint_id: recipientId },
      content: { text: "Begin the approved pipeline" },
      response: { expected: false },
    })).event;
    const draft = handle.store.createScopeCompositionDraft({
      workspace_id: workspaceId,
      scope_id: "delivery",
      content: {
        nodes: [{ node_id: "ingress", kind: "event", context_policy: { mode: "new_per_execution" } }],
        ports: [{ port_id: "ingress:out", node_id: "ingress", name: "start", direction: "output" }],
        edges: [],
      },
    }, handle.broadcast);
    const published = handle.store.publishScopeComposition({
      revision_id: draft.revision_id,
      expected_published_revision_id: null,
    }, handle.broadcast);
    let receivedCause: string | null | undefined;
    const capturingBackend: ScopeOperationBackend = {
      ...operationBackend,
      startExecution: (input) => {
        receivedCause = input.cause_event_id;
        return operationBackend.startExecution(input);
      },
    };
    const definition = startScopeExecutionOperation(capturingBackend);
    const outcome = await definition.handler({
      authority: principal,
      target: {
        ref: { kind: "scope", id: "delivery", revision: published.revision_id },
        state: operationBackend.getScope(workspaceId, "delivery"),
      },
      invocation_id: "operation:trusted-cause",
      idempotency_key: "trusted-cause",
      expected_resource_revision: published.revision_id,
      // This property is supplied by the trusted invocation boundary. It is
      // intentionally absent from START_SCOPE_EXECUTION_INPUT_SCHEMA.
      provenance: { cause_event_id: cause.event_id },
    } as any, {
      ingress_node_id: "ingress",
      output_port_id: "ingress:out",
      content: {},
    });

    expect(outcome.state).toBe("accepted");
    expect(receivedCause).toBe(cause.event_id);
    if (outcome.state === "accepted") {
      expect(outcome.result.execution.cause_event_id).toBe(cause.event_id);
    }
  });

  it("pins one plan revision and routes only through its stored Edges", async () => {
    const planner = registerEndpoint(handle, workspaceId, "planner");
    const reviewerV1 = registerEndpoint(handle, workspaceId, "reviewer-v1");
    const reviewerV2 = registerEndpoint(handle, workspaceId, "reviewer-v2");
    const accidental = registerEndpoint(handle, workspaceId, "accidental");
    const interactive = authority("principal:desktop", workspaceId, "interactive");
    const plannerAuthority = authority(planner, workspaceId, "unattended");
    const ingressContextId = handle.store.contextStore.createContext({
      workspace_id: workspaceId,
      scope_id: "delivery",
      created_by_endpoint_id: null,
      participants: [accidental],
      title: "Ingress evidence",
    });
    handle.store.contextStore.applyContextSubscriptions(ingressContextId, [{
      endpoint_id: accidental,
      event_types: ["work.arrived", "work.planned"],
    }]);

    const draftV1Receipt = receipt(await registry.invoke(
      resolver(operationBackend, interactive),
      request(
        CREATE_SCOPE_DRAFT_OPERATION_ID,
        { kind: "scope", id: "delivery" },
        { content: composition(ingressContextId, planner, reviewerV1) },
        "draft-v1",
        NO_PUBLISHED_SCOPE_REVISION,
      ),
    ));
    expect(draftV1Receipt.state).toBe("completed");
    const draftV1 = (draftV1Receipt.result as any).revision;
    const impactV1 = handle.store.assessScopeCompositionImpact(draftV1.revision_id);

    const publishedV1Receipt = receipt(await registry.invoke(
      resolver(operationBackend, interactive),
      request(
        PUBLISH_SCOPE_REVISION_OPERATION_ID,
        { kind: "scope_composition_revision", id: draftV1.revision_id },
        {
          expected_current_published_revision_id: null,
          expected_impact_digest: impactV1.impact_digest,
        },
        "publish-v1",
        draftV1.semantic_digest,
      ),
    ));
    expect(publishedV1Receipt.state).toBe("completed");
    const revisionV1 = (publishedV1Receipt.result as any).revision;

    const startedReceipt = receipt(await registry.invoke(
      resolver(operationBackend, interactive),
      request(
        START_SCOPE_EXECUTION_OPERATION_ID,
        { kind: "scope", id: "delivery" },
        { ingress_node_id: "ingress", output_port_id: "ingress:out", content: { card: "one" } },
        "start-v1",
        revisionV1.revision_id,
      ),
    ));
    expect(startedReceipt.state, JSON.stringify(startedReceipt.refusal)).toBe("accepted");
    expect(startedReceipt).toMatchObject({
      state: "accepted",
      progress_ref: { kind: "scope_execution" },
      cancel_ref: { operation_id: STOP_SCOPE_EXECUTION_OPERATION_ID },
      audit_ref: { kind: "operation_invocation" },
    });
    const started = startedReceipt.result as any;
    expect(started.execution.revision_id).toBe(revisionV1.revision_id);

    const firstQueue = handle.store.db.prepare(`
      SELECT * FROM event_queue WHERE scope_execution_id = ? ORDER BY created_at ASC
    `).all(started.execution.execution_id) as any[];
    expect(firstQueue).toHaveLength(1);
    expect(firstQueue[0]).toMatchObject({
      destination_endpoint_id: planner,
      edge_id: "ingress-to-planner",
      composition_revision_id: revisionV1.revision_id,
    });
    expect(firstQueue.some((entry) => entry.destination_endpoint_id === accidental)).toBe(false);

    const draftV2Receipt = receipt(await registry.invoke(
      resolver(operationBackend, interactive),
      request(
        CREATE_SCOPE_DRAFT_OPERATION_ID,
        { kind: "scope", id: "delivery" },
        {
          based_on_revision_id: revisionV1.revision_id,
          content: composition(ingressContextId, planner, reviewerV2),
        },
        "draft-v2",
        revisionV1.revision_id,
      ),
    ));
    const draftV2 = (draftV2Receipt.result as any).revision;
    const impactV2 = handle.store.assessScopeCompositionImpact(draftV2.revision_id);
    const publishedV2Receipt = receipt(await registry.invoke(
      resolver(operationBackend, interactive),
      request(
        PUBLISH_SCOPE_REVISION_OPERATION_ID,
        { kind: "scope_composition_revision", id: draftV2.revision_id },
        {
          expected_current_published_revision_id: revisionV1.revision_id,
          expected_impact_digest: impactV2.impact_digest,
        },
        "publish-v2",
        draftV2.semantic_digest,
      ),
    ));
    const revisionV2 = (publishedV2Receipt.result as any).revision;

    const plannerNode = handle.store.getScopeExecutionProjection(started.execution.execution_id)!
      .node_executions.find((node) => node.node_id === "planner")!;
    const outputReceipt = receipt(await registry.invoke(
      resolver(operationBackend, plannerAuthority),
      request(
        PUBLISH_SCOPE_OUTPUT_OPERATION_ID,
        { kind: "node_execution", id: plannerNode.node_execution_id },
        {
          port_id: "planner:planned",
          content: { plan: "revision one" },
          lifecycle_outcome: "completed",
        },
        "planner-output-v1",
        nodeExecutionStateRevision(plannerNode),
      ),
    ));
    expect(outputReceipt.state, JSON.stringify(outputReceipt.refusal)).toBe("completed");
    const output = outputReceipt.result as any;
    const reviewerQueue = handle.store.db.prepare(`SELECT * FROM event_queue WHERE queue_id = ?`)
      .get(output.delivery_ids[0]) as any;
    expect(reviewerQueue).toMatchObject({
      destination_endpoint_id: reviewerV1,
      edge_id: "planner-to-reviewer",
      composition_revision_id: revisionV1.revision_id,
    });
    expect(reviewerQueue.destination_endpoint_id).not.toBe(reviewerV2);

    const inspectionReceipt = receipt(await registry.invoke(
      resolver(operationBackend, interactive),
      request(
        INSPECT_SCOPE_EXECUTION_OPERATION_ID,
        { kind: "scope_execution", id: started.execution.execution_id },
        {},
        "inspect-pinned-v1",
      ),
    ));
    const inspection = inspectionReceipt.result as ScopeExecutionInspection;
    expect(inspection.pinned_revision.revision_id).toBe(revisionV1.revision_id);
    expect(inspection.current_published_revision_id).toBe(revisionV2.revision_id);
    expect(inspection.pinned_revision_role).toBe("historical_published");
    expect(inspection.traversals.map((item) => item.edge_id)).toEqual([
      "ingress-to-planner",
      "planner-to-reviewer",
    ]);

    const planReceipt = receipt(await registry.invoke(
      resolver(operationBackend, interactive),
      request(
        INSPECT_SCOPE_PLAN_OPERATION_ID,
        { kind: "scope", id: "delivery" },
        { selected_revision_id: revisionV1.revision_id, include_history: true },
        "inspect-plan-history",
      ),
    ));
    const plan = planReceipt.result as ScopePlanInspection;
    expect(plan.current_published_revision_id).toBe(revisionV2.revision_id);
    expect(plan.selected_role).toBe("historical_published");
    expect(plan.revisions.find((item) => item.revision.revision_id === revisionV1.revision_id))
      .toMatchObject({ role: "historical_published", pinned_execution_ids: [started.execution.execution_id] });

    const completedPlanner = handle.store.scopeExecutionStore.getNodeExecution(plannerNode.node_execution_id)!;
    const redoReceipt = receipt(await registry.invoke(
      resolver(operationBackend, interactive),
      request(
        REDO_SCOPE_EXECUTION_OPERATION_ID,
        { kind: "node_execution", id: completedPlanner.node_execution_id },
        {
          revision_selection: "current_published",
          ingress_node_id: "ingress",
          output_port_id: "ingress:out",
          content: { card: "redo with current plan" },
        },
        "redo-under-v2",
        nodeExecutionStateRevision(completedPlanner),
      ),
    ));
    expect(redoReceipt.state, JSON.stringify(redoReceipt.refusal)).toBe("accepted");
    expect(redoReceipt.result).toMatchObject({
      execution: {
        revision_id: revisionV2.revision_id,
        parent_execution_id: started.execution.execution_id,
        redo_of_node_execution_id: completedPlanner.node_execution_id,
      },
    });
    expect(handle.store.getScopeExecution(started.execution.execution_id)?.revision_id)
      .toBe(revisionV1.revision_id);
  });

  it("takes caller identity only from authority and returns explicit stop evidence", async () => {
    const principal = authority("principal:desktop", workspaceId, "interactive");
    registerExecutableActorFixture(handle.store, workspaceId, "actor:worker");
    const draft = handle.store.createScopeCompositionDraft({
      workspace_id: workspaceId,
      scope_id: "delivery",
      content: {
        nodes: [
          { node_id: "ingress", kind: "event", context_policy: { mode: "new_per_execution" } },
          { node_id: "worker", kind: "actor", resource_id: "actor:worker", activation: { mode: "per_delivery" }, context_policy: { mode: "new_per_execution" } },
        ],
        ports: [
          { port_id: "ingress:out", node_id: "ingress", name: "start", direction: "output" },
          { port_id: "worker:in", node_id: "worker", name: "work", direction: "input", min_count: 1 },
        ],
        edges: [{ edge_id: "run-worker", source_port_id: "ingress:out", target_port_id: "worker:in" }],
      },
    }, handle.broadcast);
    const published = handle.store.publishScopeComposition({
      revision_id: draft.revision_id,
      expected_published_revision_id: null,
    }, handle.broadcast);

    const forged = receipt(await registry.invoke(
      resolver(operationBackend, principal),
      request(
        START_SCOPE_EXECUTION_OPERATION_ID,
        { kind: "scope", id: "delivery" },
        {
          ingress_node_id: "ingress",
          output_port_id: "ingress:out",
          content: {},
          initiator_endpoint_id: "actor:forged",
        },
        "forged-start",
        published.revision_id,
      ),
    ));
    expect(forged.refusal).toMatchObject({ code: "operation_input_invalid" });

    const started = receipt(await registry.invoke(
      resolver(operationBackend, principal),
      request(
        START_SCOPE_EXECUTION_OPERATION_ID,
        { kind: "scope", id: "delivery" },
        { ingress_node_id: "ingress", output_port_id: "ingress:out", content: {} },
        "real-start",
        published.revision_id,
      ),
    ));
    expect(started.state, JSON.stringify(started.refusal)).toBe("accepted");
    const execution = (started.result as any).execution;
    expect(execution.initiator_endpoint_id).toBe(principal.principal_id);

    const stopped = receipt(await registry.invoke(
      resolver(operationBackend, principal),
      request(
        STOP_SCOPE_EXECUTION_OPERATION_ID,
        { kind: "scope_execution", id: execution.execution_id },
        { reason: "Operator stopped the run" },
        "stop-real-start",
        scopeExecutionStateRevision(execution),
      ),
    ));
    expect(stopped).toMatchObject({
      state: "completed",
      result: {
        execution: { status: "cancelled" },
        stopped: { pending_deliveries: 1, node_executions: 1 },
        uncertain_external_effects: [],
      },
      progress_ref: null,
      cancel_ref: null,
      audit_ref: { kind: "operation_invocation" },
    });
  });
});
