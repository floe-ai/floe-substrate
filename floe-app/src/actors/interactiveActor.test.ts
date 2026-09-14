// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBusServer } from "../../../floe-bus/src/server.ts";
import { defaultConfig } from "../../../floe-bus/src/config.ts";
import { ensureInteractiveActor } from "./interactiveActor.ts";
import { nodeExecutionStateRevision } from "../../../floe-bus/src/scope-execution-contract.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "floe-interactive-actor-"));
  const config = defaultConfig(directory);
  const path = join(directory, "config.yaml");
  writeFileSync(path, JSON.stringify(config));
  const handle = await createBusServer(path, config, { host_control_token: "test-interactive-actor-".repeat(3), local_browser_access: true });
  await handle.app.ready();
  cleanups.push(async () => { await handle.app.close(); rmSync(directory, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  handle.store.workspaceIdentityStore.restoreWorkspace({
    snapshot: { workspace_id: "workspace:one", name: "Fresh workspace", creation_kind: "created", source_workspace_id: null, created_at: now, updated_at: now },
    binding: { host_id: handle.store.localHostId, platform: "windows", locator: join(directory, "workspace"), init_authorized: true },
  });
  const headers = { origin: "http://localhost:5379", host: "localhost:5379", cookie: "" };
  const local = await handle.app.inject({ method: "POST", url: "/v1/browser/session/local", headers });
  headers.cookie = String(local.headers["set-cookie"]).split(";")[0]!;
  const operations: Parameters<typeof ensureInteractiveActor>[1] = {
    listOperations: async (workspace, target) => {
      const query = target ? `?target_kind=${target.kind}&target_id=${encodeURIComponent(target.id)}` : "";
      const result = await handle.app.inject({ url: `/v1/workspaces/${encodeURIComponent(workspace)}/operations${query}`, headers });
      expect(result.statusCode, result.body).toBe(200);
      return result.json().operations;
    },
    invokeOperation: async (workspace, request) => {
      const result = await handle.app.inject({ method: "POST", url: `/v1/workspaces/${encodeURIComponent(workspace)}/operations/invoke`, headers, payload: request });
      expect(result.statusCode, result.body).toBeLessThan(300);
      return result.json().receipt;
    },
  };
  return { ...handle, operations };
}

describe("interactive Actor onboarding through the canonical contract", () => {
  it("creates one Actor across concurrent opens, reload and a lost setup response, without registering a worker Endpoint", async () => {
    const { store, operations } = await fixture();
    let loseCreate = true;
    const unreliable = { ...operations, invokeOperation: async (...args: Parameters<typeof operations.invokeOperation>) => {
      const receipt = await operations.invokeOperation(...args);
      if (loseCreate && args[1].operation_id === "actor.create") { loseCreate = false; throw new Error("Connection interrupted"); }
      return receipt;
    } };
    await expect(ensureInteractiveActor("workspace:one", unreliable)).rejects.toThrow("Connection interrupted");
    const [first, second] = await Promise.all([
      ensureInteractiveActor("workspace:one", operations), ensureInteractiveActor("workspace:one", operations),
    ]);
    expect(second.actor_id).toBe(first.actor_id);
    expect((await ensureInteractiveActor("workspace:one", operations)).actor_id).toBe(first.actor_id);
    expect(store.actorRoleAuthorityStore.listPrincipalBindings("workspace:one")).toHaveLength(1);
    expect(store.getEndpoint(first.actor_id)).toBeFalsy();
    expect(store.actorDefinitionStore.getCurrentDefinition(first.actor_id)).not.toBeNull();
    const runtime = store.runtimeProfileStore.getCurrentActorBinding(first.actor_id)!;
    expect(runtime).toMatchObject({ status: "resolved", endpoint_id: null });
    expect(store.runtimeProfileStore.requireRevision(runtime.runtime_profile_revision_id).content)
      .toMatchObject({ backing_kind: "human", adapter_id: "floe-app" });
    expect(store.runtimeProfileStore.listActorBindings(first.actor_id)).toHaveLength(1);
    const result = await operations.invokeOperation("workspace:one", {
      operation_id: "context.create", operation_version: "1", input_schema_version: "1", idempotency_key: "proof-context",
      input: { title: "First conversation", participants: [{ participant_id: first.actor_id }] },
    });
    expect(result.state, JSON.stringify(result.refusal)).toBe("completed");
  });

  it("recovers a lost runtime setup response and preserves an explicitly disabled binding", async () => {
    const { store, operations } = await fixture();
    let losePublish = true;
    const unreliable = { ...operations, invokeOperation: async (...args: Parameters<typeof operations.invokeOperation>) => {
      const receipt = await operations.invokeOperation(...args);
      if (losePublish && args[1].operation_id === "runtime-profile.publish") {
        losePublish = false; throw new Error("Connection interrupted");
      }
      return receipt;
    } };
    await expect(ensureInteractiveActor("workspace:one", unreliable)).rejects.toThrow("Connection interrupted");
    const actor = await ensureInteractiveActor("workspace:one", operations);
    const binding = store.runtimeProfileStore.getCurrentActorBinding(actor.actor_id)!;
    const disabled = store.runtimeProfileStore.bindActor({
      actor_id: actor.actor_id, runtime_profile_revision_id: binding.runtime_profile_revision_id,
      status: "disabled", expected_current_binding_id: binding.actor_runtime_binding_id,
      created_by_principal_id: store.localOperatorPrincipalId,
    });
    await ensureInteractiveActor("workspace:one", operations);
    expect(store.runtimeProfileStore.getCurrentActorBinding(actor.actor_id)).toEqual(disabled);
  });

  it("does not restore a revoked participant when the app reopens", async () => {
    const { store, operations } = await fixture();
    const actor = await ensureInteractiveActor("workspace:one", operations);
    const binding = store.actorRoleAuthorityStore.listPrincipalBindings("workspace:one", { actor_id: actor.actor_id })[0]!;
    store.actorRoleAuthorityStore.revokePrincipalBinding({ workspace_id: "workspace:one", principal_actor_binding_id: binding.principal_actor_binding_id, revoked_by_principal_id: store.localOperatorPrincipalId, reason: "Access removed" });
    await expect(ensureInteractiveActor("workspace:one", operations)).rejects.toThrow("revoked");
    expect(store.actorRoleAuthorityStore.listPrincipalBindings("workspace:one")).toHaveLength(0);
  });

  it("lets the normally onboarded actor receive assigned work and publish through its authenticated app session", async () => {
    const { store, operations, broadcast } = await fixture();
    const actor = await ensureInteractiveActor("workspace:one", operations);
    store.createScope({ workspace_id: "workspace:one", scope_id: "review", title: "Review" }, broadcast);
    const contextId = store.contextStore.createContext({
      workspace_id: "workspace:one", scope_id: "review", created_by_endpoint_id: null, participants: [],
    });
    const cause = store.appendContextEvent({ workspace_id: "workspace:one", context_id: contextId,
      type: "message", content: { text: "Review this work" }, metadata: {} }, broadcast);
    const draft = store.createScopeCompositionDraft({ workspace_id: "workspace:one", scope_id: "review", content: {
      nodes: [
        { node_id: "request", kind: "event", context_policy: { mode: "fixed", context_id: contextId } },
        { node_id: "review", kind: "actor", resource_id: actor.actor_id, activation: { mode: "per_delivery" }, context_policy: { mode: "new_per_execution" } },
      ],
      ports: [
        { port_id: "request:out", node_id: "request", name: "Request", direction: "output" },
        { port_id: "review:in", node_id: "review", name: "Request", direction: "input" },
        { port_id: "review:out", node_id: "review", name: "Reviewed result", direction: "output" },
      ],
      edges: [{ edge_id: "request-review", source_port_id: "request:out", target_port_id: "review:in" }],
    } }, broadcast);
    store.publishScopeComposition({ revision_id: draft.revision_id, expected_published_revision_id: null }, broadcast);
    const run = store.startScopeExecution({ workspace_id: "workspace:one", scope_id: "review",
      ingress_node_id: "request", output_port_id: "request:out", content: { text: "Review this work" },
      cause_event_id: cause.event_id, idempotency_key: "app-assigned-work" }, broadcast);
    const work = store.getScopeExecutionProjection(run.execution.execution_id)!.node_executions.find(node => node.node_id === "review")!;
    expect(work.assigned_actor_ids).toEqual([actor.actor_id]);
    expect(store.contextStore.isParticipant(work.context_id, actor.actor_id)).toBe(true);
    const output = await operations.invokeOperation("workspace:one", {
      operation_id: "scope.node-output.publish", operation_version: "1", input_schema_version: "1", idempotency_key: "app-output",
      target: { kind: "node_execution", id: work.node_execution_id }, expected_resource_revision: nodeExecutionStateRevision(work),
      input: { port_id: "review:out", content: { text: "Reviewed" }, lifecycle_outcome: "completed" },
    });
    expect(output.state, JSON.stringify(output.refusal)).toBe("completed");
    expect(store.getScopeExecution(run.execution.execution_id)?.status).toBe("completed");
    expect(store.getEndpoint(actor.actor_id)).toBeFalsy();
  });
});
