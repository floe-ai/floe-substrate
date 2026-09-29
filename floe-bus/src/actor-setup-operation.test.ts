import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { defaultConfig } from "./config.js";
import { createBusServer } from "./server.js";
import { CAPABILITY_GRANT_OPERATION_IDS } from "./capability-grant-operations.js";
import { SETUP_ACTOR_OPERATION_ID } from "./actor-setup-operation.js";
import { ENGINE_TOOL_OPERATIONS } from "./tool-policy.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const expiry = "2099-01-01T00:00:00.000Z";
const provenance = { cause_event_id: null, delivery_ids: [], execution_attempt_id: null, node_execution_id: null, scope_execution_id: null };
const STEP_GRANTS = ["actor.create", "actor.runtime-binding.create", "actor.definition.publish"];
const definition = { label: "Helper", charter: "Help", instructions: "Answer briefly.",
  responsibilities: [], knowledge_refs: [], capability_grant_ids: [],
  policy_refs: { budget: null, trust: null, approval: null }, escalation_rules: [] };

async function fixture(operationIds: readonly string[] = [...CAPABILITY_GRANT_OPERATION_IDS, ...STEP_GRANTS, "context.inspect", "artefact.inspect"]) {
  const dir = mkdtempSync(join(tmpdir(), "floe-actor-setup-"));
  const configPath = join(dir, "config.yaml"), config = defaultConfig(dir);
  writeFileSync(configPath, YAML.stringify(config));
  const handle = await createBusServer(configPath, config, { host_control_token: `setup-test-${"x".repeat(48)}` });
  cleanup.push(async () => { await handle.app.close(); rmSync(dir, { recursive: true, force: true }); });
  await handle.app.ready();
  const locator = join(dir, "workspace"); mkdirSync(locator);
  const store = handle.store;
  const workspaceId = (store.registerWorkspace({ locator, name: "Setup proof" }, handle.broadcast) as { workspace_id: string }).workspace_id;
  const boundary = { kind: "workspace" as const, workspace_id: workspaceId };
  const principal = "principal:organiser";
  const grant = store.capabilityGrantStore.issueGrant({ principal_id: principal, boundary, operation_ids: [...operationIds],
    expires_at: expiry, issuer_id: "policy:test", evidence: [{ kind: "policy", ref: "test:setup" }] });
  const runtime = store.runtimeProfileStore.createProfile({
    owner: { kind: "workspace", id: workspaceId }, created_by_principal_id: principal,
    content: { label: "Copilot", backing_kind: "model", adapter_id: "copilot", configuration: {},
      secret_ref_ids: [], required_capability_ids: [],
      checkpoint_policy: { mode: "provider_neutral", schema_ref: "floe.runtime-checkpoint.v1" },
      resource_policy: { max_concurrent_turns: 1 } },
  });
  const runtimeRevision = store.runtimeProfileStore.publishDraft({ runtime_profile_revision_id: runtime.draft.runtime_profile_revision_id,
    expected_current_revision_id: null, changed_by_principal_id: principal }).runtime_profile_revision_id;
  const token = store.operationAuthoritySessions.issueSession({ principal_id: principal, workspace_id: workspaceId,
    grant_ids: [grant.grant_id], interaction: { mode: "unattended", session_id: "test:setup" }, provenance, expires_at: expiry }).bearer_token;
  const announced: string[] = [];
  const broadcast = (store as any).broadcastFn;
  (store as any).broadcastFn = (type: string, payload: unknown) => { announced.push(type); broadcast?.(type, payload); };
  let sequence = 0;
  const setup = async (input: object) => {
    announced.length = 0;
    const response = await handle.app.inject({ method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations/invoke`,
      headers: { authorization: `Bearer ${token}` }, payload: {
        operation_id: SETUP_ACTOR_OPERATION_ID, operation_version: "1", input_schema_version: "1",
        input: { actor_id: "helper", definition, runtime_profile_revision_id: runtimeRevision, ...input },
        target: null, expected_resource_revision: null, idempotency_key: `test:setup:${++sequence}`,
      } });
    expect(response.statusCode, response.body).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 0));
    return response.json().receipt;
  };
  const helperId = `actor:${workspaceId}:helper`;
  const nothingLeft = () => {
    expect(store.actorDefinitionStore.getActor(helperId)).toBeNull();
    expect(store.runtimeProfileStore.getCurrentActorBinding(helperId)).toBeNull();
    expect(store.capabilityGrantStore.listActiveGrantsForPrincipalBoundary(helperId, boundary)).toEqual([]);
    expect(announced).not.toContain("actor_runtime_binding_changed");
  };
  return { store, workspaceId, boundary, grant, runtimeRevision, setup, helperId, announced, nothingLeft, principal };
}

describe("actor.setup: create, bind, give access and publish as one unit", () => {
  it("leaves a published, bound Actor holding exactly the access it was given", async () => {
    const f = await fixture();
    const receipt = await f.setup({ grants: [{ source_grant_id: f.grant.grant_id, operation_ids: ["artefact.inspect"], expires_at: expiry }] });
    expect(receipt.state, JSON.stringify(receipt.refusal)).toBe("completed");
    const actor = f.store.actorDefinitionStore.requireActor(f.helperId);
    expect(actor.current_definition_revision_id).toBe(receipt.result.revision.actor_definition_revision_id);
    expect(receipt.result.revision.published_at).not.toBeNull();
    expect(f.store.runtimeProfileStore.getCurrentActorBinding(f.helperId)).toMatchObject({
      runtime_profile_revision_id: f.runtimeRevision, endpoint_id: f.helperId, status: "resolved" });
    const [given] = receipt.result.delegated_grants;
    expect(given).toMatchObject({ principal_id: f.helperId, operation_ids: ["artefact.inspect"], expires_at: expiry });
    expect(receipt.result.revision.content.capability_grant_ids).toContain(given.grant_id);
    expect(f.announced.filter(type => type === "actor_runtime_binding_changed")).toHaveLength(1);
  });

  it("requires every step's permission and no new one", async () => {
    const f = await fixture([...CAPABILITY_GRANT_OPERATION_IDS, "actor.create", "actor.definition.publish"]);
    const receipt = await f.setup({});
    expect(receipt).toMatchObject({ state: "refused", refusal: { code: "operation_grant_required",
      details: { missing_grants: ["actor.runtime-binding.create"] } } });
    f.nothingLeft();
  });

  it("refuses as a whole at creation when the creator tries to give a tool it does not hold", async () => {
    const f = await fixture();
    const receipt = await f.setup({ engine_tool_operation_ids: [ENGINE_TOOL_OPERATIONS.filesystem_read] });
    expect(receipt).toMatchObject({ state: "refused", refusal: { code: "actor_setup_refused",
      details: { step: "create", cause_code: "actor_tool_access_widened" } } });
    expect(receipt.refusal.message).toContain("Nothing was created.");
    f.nothingLeft();
  });

  it("refuses as a whole at binding and undoes the Actor it had created", async () => {
    const f = await fixture();
    const receipt = await f.setup({ runtime_profile_revision_id: "runtime_profile_revision_missing" });
    expect(receipt).toMatchObject({ state: "refused", refusal: { code: "actor_setup_refused",
      details: { step: "bind_runtime", cause_code: "runtime_profile_not_found" } } });
    f.nothingLeft();
  });

  it("refuses as a whole when the Actor's address already belongs to another Actor", async () => {
    const f = await fixture();
    const other = f.store.actorDefinitionStore.createActor({ workspace_id: f.workspaceId, created_by_principal_id: f.principal,
      definition: { ...definition, label: "Other" } });
    f.store.runtimeProfileStore.bindActor({ actor_id: other.actor.actor_id, runtime_profile_revision_id: f.runtimeRevision,
      endpoint_id: f.helperId, status: "resolved", unresolved_reasons: [], expected_current_binding_id: null,
      created_by_principal_id: f.principal });
    await new Promise(resolve => setTimeout(resolve, 0));
    f.announced.length = 0;
    const receipt = await f.setup({});
    expect(receipt).toMatchObject({ state: "refused", refusal: { code: "actor_setup_refused",
      details: { step: "bind_runtime", cause_code: "actor_endpoint_owned_by_other_actor" } } });
    f.nothingLeft();
  });

  it("refuses as a whole when giving access would widen the creator's own", async () => {
    const f = await fixture();
    const receipt = await f.setup({ grants: [
      { source_grant_id: f.grant.grant_id, operation_ids: ["artefact.inspect"], expires_at: expiry },
      { source_grant_id: f.grant.grant_id, operation_ids: ["scope.execution.start"], expires_at: expiry },
    ] });
    expect(receipt).toMatchObject({ state: "refused", refusal: { code: "actor_setup_refused",
      details: { step: "delegate_access", cause_code: "capability_delegation_refused" } } });
    expect(receipt.refusal.message).toContain("subset of the source grant");
    f.nothingLeft();
  });

  it("keeps the individual steps available", async () => {
    const f = await fixture();
    const ids = f.store.operationRegistry.listCurrentOperationIds({ interaction_mode: "unattended", boundary_kind: "workspace" });
    expect(ids).toEqual(expect.arrayContaining([SETUP_ACTOR_OPERATION_ID, ...STEP_GRANTS, "capability.grant.delegate"]));
  });
});
