import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import { defaultConfig, type LocalConfig } from "./config.js";
import {
  START_SCOPE_EXECUTION_OPERATION_ID,
  STOP_SCOPE_EXECUTION_OPERATION_ID,
  nodeExecutionStateRevision,
  scopeExecutionStateRevision,
} from "./scope-operations.js";
import type {
  OperationAuthorityContext,
  OperationInvocationEnvironment,
  OperationInvocationReceipt,
  OperationInvocationRequest,
} from "./operations.js";
import { registerExecutableActorFixture } from "./executable-actor-test-fixture.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

const BRIDGE_ID = "bridge:scope-operation-backend";
const ALL_GRANTS = new Set([
  "artefact.create",
  "artefact.inspect",
  "artefact.version.publish",
  "scope.plan.inspect",
  "scope.composition.draft.create",
  "scope.composition.draft.replace",
  "scope.composition.publish",
  "scope.composition.validate",
  "scope.composition.rollback",
  "scope.execution.inspect",
  "scope.execution.start",
  "scope.node-output.publish",
  "scope.execution.stop",
]);

describe("Bus Scope operation backend", () => {
  let handle: ServerHandle;
  let temp: string;
  let workspaceId: string;
  let actorId: string;
  let ingressContextId: string;

  beforeEach(async () => {
    temp = mkdtempSync(join(tmpdir(), "floe-scope-operation-backend-"));
    const configPath = join(temp, "config.yaml");
    const config: LocalConfig = defaultConfig(temp);
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    handle = await createBusServer(configPath, config, { allow_unauthenticated_test_requests: true });
    await handle.app.ready();
    const locator = join(temp, "workspace");
    mkdirSync(locator, { recursive: true });
    const registered = await handle.app.inject({
      method: "POST",
      url: "/v1/workspaces/register",
      headers: { authorization: `Bearer ${handle.localControlToken}` },
      payload: { locator, name: "Scope operation backend" },
    });
    workspaceId = registered.json().workspace.workspace_id as string;
    actorId = `actor:${workspaceId}:worker`;
    handle.store.createScope({
      workspace_id: workspaceId,
      scope_id: "pipeline",
      title: "Pipeline",
    }, handle.broadcast);
    handle.store.registerEndpoint({
      endpoint_id: actorId,
      workspace_id: workspaceId,
      name: "Worker",
      bridge_id: BRIDGE_ID,
      status: "idle",
    }, handle.broadcast);
    registerExecutableActorFixture(handle.store, workspaceId, actorId);
    ingressContextId = handle.store.contextStore.createContext({
      workspace_id: workspaceId,
      scope_id: "pipeline",
      created_by_endpoint_id: null,
      participants: [],
      title: "Operator input",
    });
  });

  afterEach(async () => {
    try { await handle.app.close(); } catch {}
    rmSync(temp, { recursive: true, force: true });
  });

  function authority(): OperationAuthorityContext & { boundary: { kind: "workspace"; workspace_id: string } } {
    return {
      principal_id: "principal:desktop",
      boundary: { kind: "workspace", workspace_id: workspaceId },
      grants: ALL_GRANTS,
      interaction: {
        mode: "interactive",
        session_id: "session:desktop",
        confirmed_prompts: new Set(),
        approval_refs: new Set(),
      },
    };
  }

  function environment(causeEventId: string | null = null): OperationInvocationEnvironment {
    const principal = authority();
    return {
      authority: principal,
      provenance: {
        cause_event_id: causeEventId,
        delivery_ids: [],
        execution_attempt_id: null,
        node_execution_id: null,
        scope_execution_id: null,
      },
      resolve_resource: (target) => handle.store.resolveOperationResource(target, principal.boundary),
    };
  }

  function cause(contextId: string, key: string): string {
    return handle.store.appendContextEvent({
      type: "message",
      workspace_id: workspaceId,
      context_id: contextId,
      content: { text: key },
      metadata: { origin: "operator" },
      idempotency_key: `cause:${key}`,
    }, handle.broadcast).event_id;
  }

  function request(
    operationId: string,
    target: { kind: string; id: string },
    input: unknown,
    idempotencyKey: string,
    expectedResourceRevision: string,
  ): OperationInvocationRequest {
    return {
      operation_id: operationId,
      operation_version: "1",
      input_schema_version: "1",
      target,
      input,
      idempotency_key: idempotencyKey,
      expected_resource_revision: expectedResourceRevision,
    };
  }

  function receipt(value: Awaited<ReturnType<ServerHandle["store"]["operationRegistry"]["invoke"]>>): OperationInvocationReceipt {
    expect(value.kind).toBe("receipt");
    if (value.kind !== "receipt") throw new Error("Expected receipt");
    return value.receipt;
  }

  function publishPlan() {
    const draft = handle.store.createScopeCompositionDraft({
      workspace_id: workspaceId,
      scope_id: "pipeline",
      content: {
        nodes: [
          {
            node_id: "ingress",
            kind: "event",
            config: { event_type: "work.requested" },
            context_policy: { mode: "fixed", context_id: ingressContextId },
          },
          {
            node_id: "worker",
            kind: "actor",
            resource_id: actorId,
            activation: { mode: "per_delivery" },
            context_policy: { mode: "new_per_execution" },
          },
        ],
        ports: [
          { port_id: "ingress:out", node_id: "ingress", name: "work", direction: "output", event_types: ["work.requested"] },
          { port_id: "worker:in", node_id: "worker", name: "work", direction: "input", event_types: ["work.requested"], min_count: 1 },
          { port_id: "worker:out", node_id: "worker", name: "result", direction: "output", event_types: ["work.completed"] },
        ],
        edges: [
          { edge_id: "ingress-to-worker", source_port_id: "ingress:out", target_port_id: "worker:in" },
        ],
      },
    }, handle.broadcast);
    return handle.store.publishScopeComposition({
      revision_id: draft.revision_id,
      expected_published_revision_id: null,
    }, handle.broadcast);
  }

  function startWork(key: string, artefactVersionIds: string[] = []) {
    return handle.store.startScopeExecution({
      workspace_id: workspaceId,
      scope_id: "pipeline",
      ingress_node_id: "ingress",
      output_port_id: "ingress:out",
      content: { request: key },
      artefact_version_ids: artefactVersionIds,
      cause_event_id: cause(ingressContextId, key),
      initiator_endpoint_id: authority().principal_id,
      idempotency_key: key,
    }, handle.broadcast);
  }

  it.each(["interactive", "unattended"] as const)("refuses unavailable fixed Contexts before %s publication", async mode => {
    const published = publishPlan();
    const caller = environment();
    caller.authority = { ...caller.authority, interaction: { ...caller.authority.interaction, mode } };
    handle.store.createScope({ workspace_id: workspaceId, scope_id: "other", title: "Other" }, handle.broadcast);
    for (const kind of ["missing", "outside-scope", "another-scope", "archived", "redacted"] as const) {
      const contextId = kind === "missing" ? "ctx:absent" : handle.store.contextStore.createContext({
        workspace_id: workspaceId, scope_id: kind === "outside-scope" ? null : kind === "another-scope" ? "other" : "pipeline",
        created_by_endpoint_id: null, participants: [actorId], title: kind,
      });
      if (kind === "archived") handle.store.contextStore.archiveContext({ context_id: contextId, expected_revision: 1, archived_by_principal_id: caller.authority.principal_id });
      if (kind === "redacted") handle.store.db.prepare("UPDATE contexts SET content_state='redacted' WHERE context_id=?").run(contextId);
      const draft = handle.store.createScopeCompositionDraft({ workspace_id: workspaceId, scope_id: "pipeline", content: {
        nodes: published.nodes.map(node => node.node_id === "worker" ? { ...node, context_policy: { mode: "fixed", context_id: contextId } } : node),
        ports: published.ports, edges: published.edges,
      } }, handle.broadcast);
      const target = { kind: "scope_composition_revision", id: draft.revision_id };
      const checked = receipt(await handle.store.operationRegistry.invoke(caller, request("scope.composition.validate", target, {}, `validate:${kind}`, draft.semantic_digest)));
      expect(checked.state).toBe("completed");
      expect(checked.result).toMatchObject({ validation: { valid: false, diagnostics: [expect.objectContaining({ severity: "error", message: expect.stringContaining("unavailable in this Scope") })] } });
      const impact = handle.store.assessScopeCompositionImpact(draft.revision_id);
      const submitted = receipt(await handle.store.operationRegistry.invoke(caller, request("scope.composition.publish", target, {
        expected_current_published_revision_id: published.revision_id, expected_impact_digest: impact.impact_digest,
      }, `publish:${kind}`, draft.semantic_digest)));
      expect(submitted.state).toBe("refused");
      expect(submitted.refusal?.message).toContain("unavailable in this Scope");
      expect(handle.store.getPublishedScopeComposition(workspaceId, "pipeline")?.revision_id).toBe(published.revision_id);
      expect(handle.store.getScopeCompositionRevision(draft.revision_id)?.published_at).toBeNull();
    }
  });

  it("rechecks fixed Context availability on rollback and activation after valid publication", async () => {
    const original = publishPlan();
    const contextId = handle.store.contextStore.createContext({ workspace_id: workspaceId, scope_id: "pipeline", created_by_endpoint_id: null, participants: [actorId] });
    const draft = handle.store.createScopeCompositionDraft({ workspace_id: workspaceId, scope_id: "pipeline", content: {
      nodes: original.nodes.map(node => node.node_id === "worker" ? { ...node, context_policy: { mode: "fixed", context_id: contextId } } : node),
      ports: original.ports, edges: original.edges,
    } }, handle.broadcast);
    expect(handle.store.inspectScopeCompositionValidation(draft).valid).toBe(true);
    const fixed = handle.store.publishScopeComposition({ revision_id: draft.revision_id, expected_published_revision_id: original.revision_id }, handle.broadcast);
    const started = startWork("valid fixed Context");
    expect(handle.store.getScopeExecutionProjection(started.execution.execution_id)!.node_executions.find(node => node.node_id === "worker")!.context_id).toBe(contextId);
    const replacement = handle.store.createScopeCompositionDraft({ workspace_id: workspaceId, scope_id: "pipeline", content: { nodes: original.nodes, ports: original.ports, edges: original.edges } }, handle.broadcast);
    handle.store.publishScopeComposition({ revision_id: replacement.revision_id, expected_published_revision_id: fixed.revision_id }, handle.broadcast);
    const context = handle.store.contextStore.getContext(contextId)!;
    handle.store.contextStore.archiveContext({ context_id: contextId, expected_revision: context.state_revision, archived_by_principal_id: authority().principal_id });
    expect(handle.store.inspectScopeCompositionValidation(fixed).valid).toBe(false);
    const impact = handle.store.assessScopeCompositionImpact(fixed.revision_id);
    const rolledBack = receipt(await handle.store.operationRegistry.invoke(environment(), request("scope.composition.rollback", { kind: "scope_composition_revision", id: fixed.revision_id }, {
      expected_current_published_revision_id: replacement.revision_id, expected_impact_digest: impact.impact_digest,
    }, "rollback-unavailable-context", fixed.semantic_digest)));
    expect(rolledBack.state).toBe("refused");
    expect(rolledBack.refusal?.message).toContain("unavailable in this Scope");
    expect(handle.store.getPublishedScopeComposition(workspaceId, "pipeline")?.revision_id).toBe(replacement.revision_id);
    expect(() => handle.store.startScopeExecution({ workspace_id: workspaceId, scope_id: "pipeline", revision_id: fixed.revision_id,
      ingress_node_id: "ingress", output_port_id: "ingress:out", content: {}, idempotency_key: "after-context-archive",
    }, handle.broadcast)).toThrow("unavailable in this Scope");
    expect(handle.store.listScopeExecutions(workspaceId, "pipeline")).toHaveLength(1);
  });

  it.each(["interactive", "unattended"] as const)("describes and validates injected instruction bindings for %s authoring", async mode => {
    const published = publishPlan();
    const caller = environment();
    caller.authority = { ...caller.authority, interaction: { ...caller.authority.interaction, mode } };
    const target = await caller.resolve_resource({ kind: "scope", id: "pipeline" });
    const descriptors = await handle.store.operationRegistry.project({ authority: caller.authority, target });
    const descriptor = descriptors.find(item => item.operation_id === "scope.composition.draft.create")!;
    expect(descriptor.input.schema).toMatchObject({ properties: { content: { properties: { nodes: {
      items: { properties: { bindings: { items: { required: ["kind", "text"], properties: {
        kind: { const: "instructions" }, text: { type: "string" },
      } } } } },
    } } } } });
    const submit = (bindings: unknown[], key: string) => handle.store.operationRegistry.invoke(caller, request(
      "scope.composition.draft.create", { kind: "scope", id: "pipeline" }, { content: {
        nodes: published.nodes.map(node => node.node_id === "worker" ? { ...node, bindings } : node),
        ports: published.ports, edges: published.edges,
      } }, `instruction-binding:${mode}:${key}`, published.revision_id,
    ));
    const bindings = [{ kind: "instructions", text: "Return the verified result to the requesting Context." }];
    const accepted = receipt(await submit(bindings, "valid"));
    expect(accepted.state, JSON.stringify(accepted.refusal)).toBe("completed");
    expect(accepted.result).toMatchObject({ revision: { nodes: expect.arrayContaining([
      expect.objectContaining({ node_id: "worker", bindings }),
    ]) } });
    for (const [index, malformed] of [{ kind: "instructions" }, { kind: "instructions", text: 7 }, { kind: "unknown", text: "ignored" }].entries()) {
      const rejected = receipt(await submit([malformed], `invalid:${index}`));
      expect(rejected.state).toBe("refused");
      expect(rejected.refusal?.code).toBe("operation_input_invalid");
    }
  });

  it("reads exact published Event evidence on demand with the same interactive and unattended contract", async () => {
    publishPlan();
    handle.store.artefactStore.createArtefact({
      artefact_id: "artefact:evidence", workspace_id: workspaceId,
      type_ref: "application/json", idempotency_key: "evidence",
    });
    handle.store.artefactStore.publishVersion({
      artefact_id: "artefact:evidence", artefact_version_id: "version:evidence",
      idempotency_key: "evidence:1", content_ref: {
        kind: "content-addressed", resolver_id: "test-content",
        digest: { algorithm: "sha256", value: "d".repeat(64) }, media_type: "application/json",
      },
    });
    const started = startWork("saved result to inspect", ["version:evidence"]);
    const extra = cause(ingressContextId, "ordinary conversation is not a published output");
    const other = startWork("another run is not this result");
    const read = (input: unknown, mode: "interactive" | "unattended", grants = ALL_GRANTS) => {
      const caller = environment();
      caller.authority = { ...caller.authority, principal_id: `principal:${mode}`, grants,
        interaction: { ...caller.authority.interaction, mode } };
      return handle.store.operationRegistry.invoke(caller, {
        operation_id: "scope.execution.inspect", operation_version: "1", input_schema_version: "1",
        idempotency_key: `read-output:${mode}:${JSON.stringify(input)}:${grants.size}`,
        target: { kind: "scope_execution", id: started.execution.execution_id }, input,
      });
    };
    const compact = receipt(await read({}, "interactive"));
    expect(compact.state).toBe("completed");
    expect(compact.result).not.toHaveProperty("output_publications");
    const interactive = receipt(await read({ include_outputs: true }, "interactive"));
    const unattended = receipt(await read({ include_outputs: true }, "unattended"));
    expect(interactive.state, JSON.stringify(interactive.refusal)).toBe("completed");
    expect(unattended.state, JSON.stringify(unattended.refusal)).toBe("completed");
    expect(interactive.result).toEqual(unattended.result);
    expect(interactive.result).toMatchObject({ output_publications: [{
      publication_id: started.publication.publication_id,
      node_execution_id: started.publication.node_execution_id,
      port_id: "ingress:out",
      event: handle.store.getEvent(started.root_event.event_id),
    }] });
    const outputs = (interactive.result as { output_publications: Array<{ event: unknown }> }).output_publications;
    expect(outputs).toHaveLength(1);
    expect(outputs[0].event).toMatchObject({ artefact_version_ids: ["version:evidence"] });
    expect(JSON.stringify(outputs)).not.toContain(extra);
    expect(JSON.stringify(outputs)).not.toContain(other.root_event.event_id);
    const denied = receipt(await read({ include_outputs: true }, "unattended", new Set()));
    expect(denied.state).toBe("refused");
    expect(denied.result).toBeNull();
    const foreign = environment();
    foreign.authority = { ...foreign.authority, boundary: { kind: "workspace", workspace_id: "workspace:elsewhere" } };
    foreign.resolve_resource = target => handle.store.resolveOperationResource(target, foreign.authority.boundary);
    const isolated = receipt(await handle.store.operationRegistry.invoke(foreign, {
      operation_id: "scope.execution.inspect", operation_version: "1", input_schema_version: "1",
      idempotency_key: "inspect:wrong-workspace",
      target: { kind: "scope_execution", id: started.execution.execution_id }, input: { include_outputs: true },
    }));
    expect(isolated.state).toBe("refused");
    expect(isolated.result).toBeNull();
  });

  it.each(["missing", "other Context", "other Workspace"])(
    "keeps a %s Event reference unavailable instead of substituting evidence", async state => {
      publishPlan();
      const started = startWork("read retained publication");
      let eventId = "event:no-longer-available";
      if (state !== "missing") {
        let eventWorkspace = workspaceId;
        if (state === "other Workspace") {
          const locator = join(temp, "other-workspace");
          mkdirSync(locator);
          eventWorkspace = (handle.store.registerWorkspace({ locator, name: "Other" }, handle.broadcast) as {
            workspace_id: string;
          }).workspace_id;
        }
        handle.store.createScope({
          workspace_id: eventWorkspace, scope_id: "unrelated", title: "Unrelated work",
        }, handle.broadcast);
        const contextId = handle.store.contextStore.createContext({
          workspace_id: eventWorkspace, scope_id: "unrelated", created_by_endpoint_id: null,
          participants: [], title: "Unrelated evidence",
        });
        eventId = handle.store.appendContextEvent({
          type: "message", workspace_id: eventWorkspace, context_id: contextId,
          content: { text: "not this publication's content" }, idempotency_key: "unrelated",
        }, handle.broadcast).event_id;
      }
      handle.store.db.prepare("UPDATE scope_output_publications SET event_id = ? WHERE publication_id = ?")
        .run(eventId, started.publication.publication_id);
      const inspected = receipt(await handle.store.operationRegistry.invoke(environment(), {
        operation_id: "scope.execution.inspect", operation_version: "1", input_schema_version: "1",
        idempotency_key: "inspect:unavailable-output",
        target: { kind: "scope_execution", id: started.execution.execution_id }, input: { include_outputs: true },
      }));
      expect(inspected.state, JSON.stringify(inspected.refusal)).toBe("completed");
      expect(inspected.result).toMatchObject({ output_publications: [{ event_id: eventId, event: null }] });
      expect(JSON.stringify(inspected.result)).not.toContain("not this publication's content");
    },
  );

  it("reads the exact Node target revision before requesting a mutation", async () => {
    publishPlan();
    const started = startWork("inspect-node");
    const node = handle.store.getScopeExecutionProjection(started.execution.execution_id)!
      .node_executions.find((entry) => entry.node_id === "worker")!;
    const inspected = receipt(await handle.store.operationRegistry.invoke(
      environment(cause(ingressContextId, "inspect current review")), {
        operation_id: "scope.execution.inspect", operation_version: "1", input_schema_version: "1",
        idempotency_key: "inspect:node", target: { kind: "scope_execution", id: started.execution.execution_id }, input: {},
      },
    ));
    expect(inspected.state, JSON.stringify(inspected.refusal)).toBe("completed");
    expect(inspected.result).toMatchObject({ execution: { execution_id: started.execution.execution_id },
      node_executions: expect.arrayContaining([expect.objectContaining({
        node_execution_id: node.node_execution_id,
        resource_ref: { kind: "node_execution", id: node.node_execution_id, revision: nodeExecutionStateRevision(node) },
      })]),
    });
  });

  it.each(["conversation", "another execution"])("inspects and stops work from %s without rewriting its origin", async (origin) => {
    publishPlan();
    const target = startWork("target");
    const source = environment(cause(ingressContextId, "control request"));
    if (origin === "another execution") {
      const other = startWork("source");
      const node = handle.store.getScopeExecutionProjection(other.execution.execution_id)!
        .node_executions.find((entry) => entry.node_id === "worker")!;
      source.provenance = {
        cause_event_id: other.root_event.event_id,
        delivery_ids: other.delivery_ids,
        scope_execution_id: other.execution.execution_id,
        node_execution_id: node.node_execution_id,
        execution_attempt_id: null,
      };
    } else {
      // A retained direct-conversation delivery, with no Scope assignment.
      handle.store.db.prepare(`INSERT INTO event_queue
        (queue_id, event_id, workspace_id, destination_endpoint_id, state, created_at)
        VALUES (?, ?, ?, ?, 'queued', ?)`)
        .run("q:conversation", source.provenance!.cause_event_id, workspaceId, actorId, new Date().toISOString());
      source.provenance = { ...source.provenance!, delivery_ids: ["q:conversation"] };
    }
    const inspected = receipt(await handle.store.operationRegistry.invoke(source, {
      operation_id: "scope.execution.inspect", operation_version: "1", input_schema_version: "1",
      idempotency_key: `inspect:${origin}`,
      target: { kind: "scope_execution", id: target.execution.execution_id }, input: {},
    }));
    expect(inspected.state, JSON.stringify(inspected.refusal)).toBe("completed");
    expect(inspected.provenance).toEqual(source.provenance);
    const facts = handle.store.policyStore.getEvaluation(inspected.governance.policy_evaluation_id!)!.facts!;
    expect(facts.target?.id).toBe(target.execution.execution_id);
    expect(facts.node_placement_id).toBeNull();
    expect(facts.provenance).toEqual(source.provenance);

    const current = handle.store.getScopeExecution(target.execution.execution_id)!;
    const stopped = receipt(await handle.store.operationRegistry.invoke(source, request(
      STOP_SCOPE_EXECUTION_OPERATION_ID, { kind: "scope_execution", id: current.execution_id },
      { reason: "Stop from the originating conversation" }, `stop:${origin}`, scopeExecutionStateRevision(current),
    )));
    expect(stopped.state, JSON.stringify(stopped.refusal)).toBe("completed");
    expect(stopped.provenance).toEqual(source.provenance);
    expect(handle.store.auditStore.require(stopped.audit_ref!.id).request.provenance).toEqual(source.provenance);
    expect(handle.store.getScopeExecution(current.execution_id)?.status).toBe("cancelled");
  });

  it("still refuses false source provenance and output attributed to another execution", async () => {
    publishPlan();
    const source = startWork("source");
    const target = startWork("target");
    const node = (id: string) => handle.store.getScopeExecutionProjection(id)!
      .node_executions.find((entry) => entry.node_id === "worker")!;
    const caller = environment(source.root_event.event_id);
    caller.provenance = {
      cause_event_id: source.root_event.event_id, delivery_ids: source.delivery_ids,
      scope_execution_id: target.execution.execution_id, node_execution_id: null, execution_attempt_id: null,
    };
    const forged = receipt(await handle.store.operationRegistry.invoke(caller, {
      operation_id: "scope.execution.inspect", operation_version: "1", input_schema_version: "1",
      idempotency_key: "inspect:forged",
      target: { kind: "scope_execution", id: target.execution.execution_id }, input: {},
    }));
    expect(forged.refusal?.code).toBe("operation_governance_provenance_invalid");

    const sourceNode = node(source.execution.execution_id);
    caller.provenance = { ...caller.provenance!, scope_execution_id: source.execution.execution_id,
      node_execution_id: sourceNode.node_execution_id };
    caller.authority = { ...caller.authority, principal_id: actorId };
    const targetNode = node(target.execution.execution_id);
    const output = receipt(await handle.store.operationRegistry.invoke(caller, request(
      "scope.node-output.publish", { kind: "node_execution", id: targetNode.node_execution_id },
      { port_id: "worker:out", content: { text: "wrong run" }, lifecycle_outcome: "completed" },
      "wrong-output", nodeExecutionStateRevision(targetNode),
    )));
    expect(output.state).toBe("refused");
    expect(output.refusal?.code).toBe("scope_output_provenance_conflict");
    expect(handle.store.scopeExecutionStore.listPublications(targetNode.node_execution_id)).toHaveLength(0);
  });

  it("registers Scope and Artefact operations in the same Bus registry", async () => {
    const projected = await handle.store.operationRegistry.project({ authority: authority() });
    expect(projected.map((operation) => operation.operation_id)).toEqual(expect.arrayContaining([
      "artefact.create",
      "artefact.version.publish",
      "artefact.inspect",
      "scope.composition.draft.create",
      "scope.composition.publish",
      "scope.execution.start",
      "scope.node-output.publish",
      "scope.execution.stop",
    ]));
  });

  it.each(["active", "revoked", "unbound", "matching identifier", "other actor", "missing grant"])(
    "requires retained executor authority to publish output: %s", async (state) => {
      publishPlan();
      const started = startWork(`authority:${state}`);
      const node = handle.store.getScopeExecutionProjection(started.execution.execution_id)!
        .node_executions.find(item => item.node_id === "worker")!;
      const caller = environment();
      if (state === "matching identifier") caller.authority = { ...caller.authority, principal_id: actorId };
      if (!["unbound", "matching identifier"].includes(state)) {
        const boundActor = state === "other actor" ? `actor:${workspaceId}:another-worker` : actorId;
        if (state === "other actor") registerExecutableActorFixture(handle.store, workspaceId, boundActor);
        const binding = handle.store.actorRoleAuthorityStore.bindPrincipal({
          workspace_id: workspaceId, principal_id: caller.authority.principal_id, actor_id: boundActor,
          bound_by_principal_id: "principal:setup",
          evidence_refs: [{ kind: "operation_invocation", id: "binding:setup", revision: null }],
        });
        if (state === "revoked") handle.store.actorRoleAuthorityStore.revokePrincipalBinding({
          workspace_id: workspaceId, principal_actor_binding_id: binding.principal_actor_binding_id,
          revoked_by_principal_id: "principal:setup", reason: "Access removed",
        });
      }
      if (state === "missing grant") caller.authority = {
        ...caller.authority, grants: new Set([...ALL_GRANTS].filter(grant => grant !== "scope.node-output.publish")),
      };
      const output = receipt(await handle.store.operationRegistry.invoke(caller, request(
        "scope.node-output.publish", { kind: "node_execution", id: node.node_execution_id },
        { port_id: "worker:out", content: { text: "Reviewed" }, lifecycle_outcome: "completed" },
        `publish:${state}`, nodeExecutionStateRevision(node),
      )));
      if (state === "active") {
        expect(output.state, JSON.stringify(output.refusal)).toBe("completed");
        const eventId = (output.result as { event_id: string }).event_id;
        expect(handle.store.getEvent(eventId)).toMatchObject({
          source_endpoint_id: actorId,
          metadata: { source_principal_id: caller.authority.principal_id, node_execution_id: node.node_execution_id },
        });
        expect(handle.store.getScopeExecution(started.execution.execution_id)?.status).toBe("completed");
      } else {
        expect(output.state).toBe("refused");
        if (state !== "missing grant") expect(output.refusal?.code).toBe("scope_output_authority");
        expect(handle.store.scopeExecutionStore.listPublications(node.node_execution_id)).toHaveLength(0);
      }
    },
  );

  it("carries exact ArtefactVersions from ingress Event through the pinned execution", async () => {
    const published = publishPlan();
    handle.store.artefactStore.createArtefact({
      artefact_id: "artefact:concept",
      workspace_id: workspaceId,
      type_ref: "image/concept",
      idempotency_key: "concept",
    });
    handle.store.artefactStore.publishVersion({
      artefact_id: "artefact:concept",
      artefact_version_id: "artefact-version:concept:1",
      idempotency_key: "concept-v1",
      content_ref: {
        kind: "content-addressed",
        resolver_id: "test-content",
        digest: { algorithm: "sha256", value: "c".repeat(64) },
        media_type: "image/png",
      },
    });

    const startedReceipt = receipt(await handle.store.operationRegistry.invoke(
      environment(cause(ingressContextId, "exact-artefact-ingress")),
      request(
        START_SCOPE_EXECUTION_OPERATION_ID,
        { kind: "scope", id: "pipeline" },
        {
          ingress_node_id: "ingress",
          output_port_id: "ingress:out",
          content: { outcome: "analyse concept" },
          artefact_version_ids: ["artefact-version:concept:1"],
        },
        "start-exact-artefact",
        published.revision_id,
      ),
    ));
    expect(startedReceipt.state, JSON.stringify(startedReceipt.refusal)).toBe("accepted");
    const started = startedReceipt.result as {
      execution: { execution_id: string };
      root_event_id: string;
      publication_id: string;
    };
    expect(handle.store.getEvent(started.root_event_id)?.artefact_version_ids)
      .toEqual(["artefact-version:concept:1"]);
    const projection = handle.store.getScopeExecutionProjection(started.execution.execution_id)!;
    const ingress = projection.node_executions.find((node) => node.node_id === "ingress")!;
    expect(ingress.publications[0]?.outputs).toEqual([
      { artefact_version_id: "artefact-version:concept:1", member_key: "" },
    ]);
    expect(handle.store.artefactStore.listAssociations("artefact-version:concept:1"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ target_kind: "event", target_id: started.root_event_id, role: "attachment" }),
        expect.objectContaining({ target_kind: "scope_execution", target_id: started.execution.execution_id, role: "input" }),
        expect.objectContaining({ target_kind: "node_execution", target_id: ingress.node_execution_id, role: "output" }),
      ]));
  });

  it("stops queued work before a worker owns it", async () => {
    handle.store.db.prepare(`UPDATE endpoints SET bridge_id = NULL WHERE endpoint_id = ?`).run(actorId);
    const published = publishPlan();
    const startedReceipt = receipt(await handle.store.operationRegistry.invoke(
      environment(cause(ingressContextId, "queued-stop")),
      request(
        START_SCOPE_EXECUTION_OPERATION_ID,
        { kind: "scope", id: "pipeline" },
        { ingress_node_id: "ingress", output_port_id: "ingress:out", content: {} },
        "start-queued-stop",
        published.revision_id,
      ),
    ));
    const execution = (startedReceipt.result as { execution: { execution_id: string } }).execution;
    const current = handle.store.getScopeExecution(execution.execution_id)!;
    expect((handle.store.db.prepare(`
      SELECT state FROM event_queue WHERE scope_execution_id = ?
    `).get(current.execution_id) as { state: string }).state).toBe("queued");

    const stopped = receipt(await handle.store.operationRegistry.invoke(
      environment(),
      request(
        STOP_SCOPE_EXECUTION_OPERATION_ID,
        { kind: "scope_execution", id: current.execution_id },
        { reason: "No longer needed" },
        "stop-queued-stop",
        scopeExecutionStateRevision(current),
      ),
    ));
    expect(stopped.result).toMatchObject({
      stopped: { pending_deliveries: 1, active_deliveries: 0, node_executions: 1, workers: 0 },
      uncertain_external_effects: [],
    });
    expect((handle.store.db.prepare(`
      SELECT state FROM event_queue WHERE scope_execution_id = ?
    `).get(current.execution_id) as { state: string }).state).toBe("cancelled");
  });

  it("cancels a reserved Delivery without inventing an ExecutionAttempt", async () => {
    const published = publishPlan();
    const startedReceipt = receipt(await handle.store.operationRegistry.invoke(
      environment(cause(ingressContextId, "reserved-stop")),
      request(
        START_SCOPE_EXECUTION_OPERATION_ID,
        { kind: "scope", id: "pipeline" },
        { ingress_node_id: "ingress", output_port_id: "ingress:out", content: {} },
        "start-reserved-stop",
        published.revision_id,
      ),
    ));
    const execution = (startedReceipt.result as { execution: { execution_id: string } }).execution;
    const current = handle.store.getScopeExecution(execution.execution_id)!;
    const bundle = handle.store.db.prepare(`
      SELECT delivery_id, state FROM delivery_bundles
      WHERE delivery_id IN (
        SELECT delivery_id FROM event_queue WHERE scope_execution_id = ?
      )
    `).get(current.execution_id) as { delivery_id: string; state: string };
    expect(bundle.state).toBe("reserved");

    const stopped = receipt(await handle.store.operationRegistry.invoke(
      environment(),
      request(
        STOP_SCOPE_EXECUTION_OPERATION_ID,
        { kind: "scope_execution", id: current.execution_id },
        {},
        "stop-reserved-stop",
        scopeExecutionStateRevision(current),
      ),
    ));
    expect(stopped.result).toMatchObject({
      stopped: { pending_deliveries: 0, active_deliveries: 1, node_executions: 1, workers: 1 },
      uncertain_external_effects: [],
    });
    expect((handle.store.db.prepare(`
      SELECT state FROM delivery_bundles WHERE delivery_id = ?
    `).get(bundle.delivery_id) as { state: string }).state).toBe("cancelled");
    expect(Number((handle.store.db.prepare(`
      SELECT COUNT(*) AS count FROM execution_attempts
    `).get() as { count: number }).count)).toBe(0);
  });

  it("uses trusted provenance and reports uncertain effects when stopping injected work", async () => {
    const published = publishPlan();
    const cause = handle.store.appendContextEvent({
      type: "message",
      workspace_id: workspaceId,
      context_id: ingressContextId,
      content: { text: "Build the requested outcome" },
      metadata: { origin: "operator" },
    }, handle.broadcast);
    const startedReceipt = receipt(await handle.store.operationRegistry.invoke(
      environment(cause.event_id),
      request(
        START_SCOPE_EXECUTION_OPERATION_ID,
        { kind: "scope", id: "pipeline" },
        {
          ingress_node_id: "ingress",
          output_port_id: "ingress:out",
          content: { outcome: "proof" },
        },
        "start-through-shared-registry",
        published.revision_id,
      ),
    ));
    expect(startedReceipt.state, JSON.stringify(startedReceipt.refusal)).toBe("accepted");
    const started = startedReceipt.result as {
      execution: { execution_id: string; cause_event_id: string | null };
    };
    expect(started.execution.cause_event_id).toBe(cause.event_id);

    const claimed = handle.store.claimDeliveries(BRIDGE_ID, 1, handle.broadcast)[0]!;
    handle.store.reportDeliveryStatus({
      bridge_id: BRIDGE_ID,
      delivery_id: claimed.delivery_id,
      state: "injected_to_runtime",
    }, handle.broadcast);
    const running = handle.store.getScopeExecution(started.execution.execution_id)!;
    const eventCountBefore = Number((handle.store.db.prepare(`
      SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?
    `).get(workspaceId) as { count: number }).count);

    const stoppedReceipt = receipt(await handle.store.operationRegistry.invoke(
      environment(),
      request(
        STOP_SCOPE_EXECUTION_OPERATION_ID,
        { kind: "scope_execution", id: running.execution_id },
        { reason: "Operator stopped this execution" },
        "stop-through-shared-registry",
        scopeExecutionStateRevision(running),
      ),
    ));
    expect(stoppedReceipt.state, JSON.stringify(stoppedReceipt.refusal)).toBe("completed");
    expect(stoppedReceipt.result).toMatchObject({
      execution: { status: "cancelled" },
      stopped: {
        active_deliveries: 1,
        node_executions: 1,
        workers: 1,
      },
      uncertain_external_effects: [
        { kind: "runtime_delivery", id: claimed.delivery_id },
      ],
    });
    expect((handle.store.db.prepare(`
      SELECT state FROM delivery_bundles WHERE delivery_id = ?
    `).get(claimed.delivery_id) as { state: string }).state).toBe("cancelled");
    expect((handle.store.db.prepare(`
      SELECT status FROM execution_attempts WHERE delivery_bundle_id = ?
    `).get(claimed.delivery_id) as { status: string }).status).toBe("outcome_unknown");
    expect(Number((handle.store.db.prepare(`
      SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?
    `).get(workspaceId) as { count: number }).count)).toBe(eventCountBefore);
    expect(handle.store.getScopeExecutionProjection(running.execution_id)).toMatchObject({
      execution: {
        status: "cancelled",
        terminal: { uncertain_external_effects: [{ id: claimed.delivery_id }] },
      },
      node_executions: expect.arrayContaining([
        expect.objectContaining({ node_id: "worker", status: "cancelled" }),
      ]),
    });
  });

  it("resolves operation resources only inside verified Workspace authority", () => {
    const published = publishPlan();
    const scope = handle.store.resolveOperationResource(
      { kind: "scope", id: "pipeline" },
      { kind: "workspace", workspace_id: workspaceId },
    );
    const revision = handle.store.resolveOperationResource(
      { kind: "scope_composition_revision", id: published.revision_id },
      { kind: "workspace", workspace_id: workspaceId },
    );
    expect(scope?.ref.revision).toBe(published.revision_id);
    expect(revision?.ref.revision).toBe(published.semantic_digest);
    expect(handle.store.resolveOperationResource(
      { kind: "scope", id: "pipeline" },
      { kind: "workspace", workspace_id: "workspace:other" },
    )).toBeNull();
  });
});
