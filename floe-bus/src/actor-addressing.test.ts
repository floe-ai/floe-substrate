import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { defaultConfig } from "./config.js";
import { createBusServer } from "./server.js";


// An Actor created and bound through operations must be reachable at the same
// address that routing resolves its name to, exactly like an imported Actor.

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const expiry = "2099-01-01T00:00:00.000Z";
const provenance = { cause_event_id: null, delivery_ids: [], execution_attempt_id: null, node_execution_id: null, scope_execution_id: null };
const definition = { label: "Greeter", charter: "Greet people", instructions: "Reply with a greeting",
  responsibilities: [], knowledge_refs: [], capability_grant_ids: [],
  policy_refs: { budget: null, trust: null, approval: null }, escalation_rules: [] };
const OPERATIONS = ["actor.create", "actor.definition.publish", "actor.runtime-binding.create", "actor.runtime-binding.replace"];

async function server() {
  const dir = mkdtempSync(join(tmpdir(), "floe-actor-addressing-"));
  const configPath = join(dir, "config.yaml"), config = defaultConfig(dir);
  writeFileSync(configPath, YAML.stringify(config));
  const handle = await createBusServer(configPath, config, { host_control_token: `addressing-test-${"x".repeat(48)}` });
  cleanup.push(async () => { await handle.app.close(); rmSync(dir, { recursive: true, force: true }); });
  await handle.app.ready();
  const store = handle.store;
  const workspace = (name: string) => {
    const locator = join(dir, name); mkdirSync(locator);
    const workspaceId = (store.registerWorkspace({ locator, name }, handle.broadcast) as { workspace_id: string }).workspace_id;
    const grant = store.capabilityGrantStore.issueGrant({ principal_id: "principal:organiser",
      boundary: { kind: "workspace", workspace_id: workspaceId }, operation_ids: OPERATIONS,
      expires_at: expiry, issuer_id: "policy:test", evidence: [{ kind: "policy", ref: "test:addressing" }] });
    const runtime = store.runtimeProfileStore.createProfile({
      owner: { kind: "workspace", id: workspaceId }, created_by_principal_id: "principal:test",
      content: { label: "Copilot", backing_kind: "model", adapter_id: "floe-runtime", configuration: {},
        secret_ref_ids: [], required_capability_ids: [],
        checkpoint_policy: { mode: "provider_neutral", schema_ref: "floe.runtime-checkpoint.v1" },
        resource_policy: { max_concurrent_turns: 1 } },
    });
    const profile = store.runtimeProfileStore.publishDraft({
      runtime_profile_revision_id: runtime.draft.runtime_profile_revision_id,
      expected_current_revision_id: null, changed_by_principal_id: "principal:test",
    });
    const token = store.operationAuthoritySessions.issueSession({ principal_id: "principal:organiser", workspace_id: workspaceId,
      grant_ids: [grant.grant_id], interaction: { mode: "unattended", session_id: "test" }, provenance, expires_at: expiry }).bearer_token;
    let sequence = 0;
    const invoke = async (operation_id: string, input: object, target: { kind: string; id: string } | null = null, expected: string | null = null) => {
      const response = await handle.app.inject({ method: "POST",
        url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations/invoke`,
        headers: { authorization: `Bearer ${token}` },
        payload: { operation_id, operation_version: "1", input_schema_version: "1", input, target,
          expected_resource_revision: expected, idempotency_key: `addressing:${++sequence}` } });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().receipt;
    };
    /** Create, publish and bind an Actor the way an Actor or person does: through operations only. */
    const createBoundActor = async (actorId: string | undefined, bindInput: object = {}) => {
      const created = await invoke("actor.create", { ...(actorId ? { actor_id: actorId } : {}), definition });
      expect(created.state, JSON.stringify(created)).toBe("completed");
      const { actor, draft } = created.result;
      const published = await invoke("actor.definition.publish", { expected_current_definition_revision_id: null },
        { kind: "actor_definition_revision", id: draft.actor_definition_revision_id }, draft.semantic_digest);
      expect(published.state, JSON.stringify(published)).toBe("completed");
      const bound = await invoke("actor.runtime-binding.create",
        { runtime_profile_revision_id: profile.runtime_profile_revision_id, status: "resolved", ...bindInput },
        { kind: "actor", id: actor.actor_id }, published.result.revision.actor_definition_revision_id);
      expect(bound.state, JSON.stringify(bound)).toBe("completed");
      return { actor, binding: bound.result.binding };
    };
    return { workspaceId, invoke, createBoundActor };
  };
  return { store, workspace };
}

describe("Actors created through operations are reachable", () => {
  it("a named Actor is hosted at the address its name routes to", async () => {
    const { store, workspace } = await server();
    const w = await workspace("one");
    const { actor, binding } = await w.createBoundActor("greeter");

    expect(actor.actor_id).toBe(`actor:${w.workspaceId}:greeter`);
    expect(binding.endpoint_id).toBe(actor.actor_id);
    expect(store.resolveSubscriberEndpointId(w.workspaceId, "greeter")).toBe(actor.actor_id);
    expect(store.listRuntimeEndpoints(w.workspaceId).map(endpoint => endpoint.endpoint_id)).toContain(actor.actor_id);
  });

  it("an unnamed Actor gets a Workspace-qualified ID and is hosted there", async () => {
    const { store, workspace } = await server();
    const w = await workspace("one");
    const { actor, binding } = await w.createBoundActor(undefined);

    expect(actor.actor_id).toMatch(new RegExp(`^actor:${w.workspaceId}:actor_[0-9a-f-]{36}$`));
    expect(binding.endpoint_id).toBe(actor.actor_id);
    expect(store.listRuntimeEndpoints(w.workspaceId).map(endpoint => endpoint.endpoint_id)).toContain(actor.actor_id);
  });

  it("accepts the Actor's full ID in its own Workspace as its name", async () => {
    const { workspace } = await server();
    const w = await workspace("one");
    const { actor } = await w.createBoundActor(`actor:${w.workspaceId}:greeter`);
    expect(actor.actor_id).toBe(`actor:${w.workspaceId}:greeter`);
  });

  it("lets two Workspaces each have an Actor with the same name", async () => {
    const { workspace } = await server();
    const one = await workspace("one"), two = await workspace("two");
    const first = await one.createBoundActor("greeter");
    const second = await two.createBoundActor("greeter");
    expect(first.actor.actor_id).not.toBe(second.actor.actor_id);
  });

  it("refuses a name that points into another Workspace", async () => {
    const { workspace } = await server();
    const one = await workspace("one"), two = await workspace("two");
    const refused = await two.invoke("actor.create", { actor_id: `actor:${one.workspaceId}:greeter`, definition });
    expect(refused).toMatchObject({ state: "refused", refusal: { code: "actor_definition_invalid" } });
  });

  it("refuses a second Actor with a name already used in the Workspace, and says so", async () => {
    const { workspace } = await server();
    const w = await workspace("one");
    await w.createBoundActor("greeter");
    const refused = await w.invoke("actor.create", { actor_id: "greeter", definition });
    expect(refused).toMatchObject({ state: "refused", refusal: { code: "actor_name_taken" } });
    expect(refused.refusal.message).toContain("greeter");
  });

  it("keeps an endpoint that the binder chose", async () => {
    const { workspace } = await server();
    const w = await workspace("one");
    const { binding } = await w.createBoundActor("greeter", { endpoint_id: "endpoint:chosen" });
    expect(binding.endpoint_id).toBe("endpoint:chosen");
  });

  it("keeps the current endpoint when a binding is replaced without naming one", async () => {
    const { store, workspace } = await server();
    const w = await workspace("one");
    const { actor, binding } = await w.createBoundActor("greeter");
    const replaced = await w.invoke("actor.runtime-binding.replace",
      { runtime_profile_revision_id: binding.runtime_profile_revision_id, status: "resolved" },
      { kind: "actor_runtime_binding", id: binding.actor_runtime_binding_id }, binding.actor_runtime_binding_id);
    expect(replaced.state, JSON.stringify(replaced)).toBe("completed");
    expect(store.runtimeProfileStore.getCurrentActorBinding(actor.actor_id)?.endpoint_id).toBe(actor.actor_id);
  });
});
