import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { defaultConfig } from "./config.js";
import { createBusServer } from "./server.js";
import { CAPABILITY_GRANT_OPERATION_IDS } from "./capability-grant-operations.js";
import { NO_ACTOR_DEFINITION_REVISION } from "./actor-definition-operations.js";
import { CredentialBrokerService, InMemoryCredentialBroker } from "./credential-broker.js";
import { RUNTIME_CREDENTIAL_PURPOSE } from "./credential-operations.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const expiry = "2099-01-01T00:00:00.000Z";
const provenance = { cause_event_id: null, delivery_ids: [], execution_attempt_id: null, node_execution_id: null, scope_execution_id: null };

async function fixture(mode: "interactive" | "unattended" = "unattended", publish = true) {
  const dir = mkdtempSync(join(tmpdir(), "floe-delegation-operations-"));
  const configPath = join(dir, "config.yaml"), config = defaultConfig(dir);
  writeFileSync(configPath, YAML.stringify(config));
  const handle = await createBusServer(configPath, config, { host_control_token: `delegation-test-${"x".repeat(48)}` });
  cleanup.push(async () => { await handle.app.close(); rmSync(dir, { recursive: true, force: true }); });
  await handle.app.ready();
  const locator = join(dir, "workspace"); mkdirSync(locator);
  const workspace = handle.store.registerWorkspace({ locator, name: "Delegation proof" }, handle.broadcast) as { workspace_id: string };
  const store = handle.store, workspaceId = workspace.workspace_id;
  const boundary = { kind: "workspace" as const, workspace_id: workspaceId };
  const principal = "principal:organiser";
  const grant = store.capabilityGrantStore.issueGrant({ principal_id: principal, boundary,
    operation_ids: [...CAPABILITY_GRANT_OPERATION_IDS, "actor.definition.publish", "actor.runtime-binding.create", "context.inspect", "artefact.inspect"],
    expires_at: expiry, issuer_id: "policy:test", evidence: [{ kind: "policy", ref: "test:delegation" }] });
  const actor = store.actorDefinitionStore.createActor({ workspace_id: workspaceId,
    created_by_principal_id: principal, definition: { label: "Reviewer", charter: "Review saved work", instructions: "Report evidence",
      responsibilities: [], knowledge_refs: [], capability_grant_ids: [],
      policy_refs: { budget: null, trust: null, approval: null }, escalation_rules: [] } });
  if (publish) store.actorDefinitionStore.publishDraft({ actor_definition_revision_id: actor.draft.actor_definition_revision_id,
    expected_current_revision_id: null, changed_by_principal_id: principal });
  const issueSession = (ids = [grant.grant_id]) => store.operationAuthoritySessions.issueSession({ principal_id: principal,
    workspace_id: workspaceId, grant_ids: ids, interaction: { mode, session_id: `test:${mode}` }, provenance, expires_at: expiry }).bearer_token;
  const token = issueSession();
  let sequence = 0;
  const invoke = async (operationId: string, input: object, options: { token?: string; key?: string; target?: { kind: string; id: string } | null; expected?: string | null } = {}) => {
    const response = await handle.app.inject({ method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations/invoke`,
      headers: { authorization: `Bearer ${options.token ?? token}` }, payload: {
        operation_id: operationId, operation_version: "1", input_schema_version: "1", input,
        target: options.target === undefined ? { kind: "actor", id: actor.actor.actor_id } : options.target,
        expected_resource_revision: options.expected === undefined ? store.actorDefinitionStore.requireActor(actor.actor.actor_id).current_definition_revision_id : options.expected,
        idempotency_key: options.key ?? `test:operation:${++sequence}`,
      } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  return { dir, handle, store, actor, grant, principal, boundary, issueSession, invoke };
}

describe("authenticated collaborator permission operations", () => {
  it.each(["interactive", "unattended"] as const)("grants a new Actor access before its first publication in %s mode", async mode => {
    const f = await fixture(mode, false);
    const result = await f.invoke("capability.grant.delegate", { expires_at: expiry, source_grant_id: f.grant.grant_id,
      operation_ids: ["artefact.inspect"] }, { expected: null });
    expect(result.receipt.state).toBe("completed");
    const draft = f.store.actorDefinitionStore.createDraft({ actor_id: f.actor.actor.actor_id,
      created_by_principal_id: f.principal, definition: { ...f.actor.draft.content,
        capability_grant_ids: [result.receipt.result.grant.grant_id] } });
    expect((await f.invoke("actor.definition.publish", { expected_current_definition_revision_id: null }, {
      target: { kind: "actor_definition_revision", id: draft.actor_definition_revision_id }, expected: draft.semantic_digest,
    })).receipt.state).toBe("completed");
  });

  it("reports an unpublished Actor with the revision its operations accept", async () => {
    const f = await fixture("unattended", false);
    const boundary = f.boundary;
    const resolved = f.store.resolveOperationResource({ kind: "actor", id: f.actor.actor.actor_id }, boundary);
    expect(resolved?.ref.revision).toBe(NO_ACTOR_DEFINITION_REVISION);
    const runtime = f.store.runtimeProfileStore.createProfile({
      owner: { kind: "workspace", id: boundary.workspace_id }, created_by_principal_id: f.principal,
      content: { label: "Copilot", backing_kind: "model", adapter_id: "copilot", configuration: {},
        secret_ref_ids: [], required_capability_ids: [],
        checkpoint_policy: { mode: "provider_neutral", schema_ref: "floe.runtime-checkpoint.v1" },
        resource_policy: { max_concurrent_turns: 1 } },
    });
    const published = f.store.runtimeProfileStore.publishDraft({
      runtime_profile_revision_id: runtime.draft.runtime_profile_revision_id,
      expected_current_revision_id: null, changed_by_principal_id: f.principal,
    });
    const bound = await f.invoke("actor.runtime-binding.create", {
      runtime_profile_revision_id: published.runtime_profile_revision_id, status: "resolved",
    }, { expected: resolved!.ref.revision });
    expect(bound, JSON.stringify(bound)).toMatchObject({ receipt: { state: "completed" } });
    expect(f.store.runtimeProfileStore.getCurrentActorBinding(f.actor.actor.actor_id)?.runtime_profile_revision_id)
      .toBe(published.runtime_profile_revision_id);
    const delegated = await f.invoke("capability.grant.delegate", { expires_at: expiry, source_grant_id: f.grant.grant_id,
      operation_ids: ["artefact.inspect"] }, { expected: resolved!.ref.revision });
    expect(delegated.receipt.state, JSON.stringify(delegated.receipt.refusal)).toBe("completed");
  });

  it("refuses an unpublished expectation if another caller published the Actor in the meantime", async () => {
    const f = await fixture("unattended", false);
    f.store.actorDefinitionStore.publishDraft({ actor_definition_revision_id: f.actor.draft.actor_definition_revision_id,
      expected_current_revision_id: null, changed_by_principal_id: f.principal });
    const result = await f.invoke("capability.grant.delegate", { expires_at: expiry, source_grant_id: f.grant.grant_id,
      operation_ids: ["artefact.inspect"] }, { expected: null });
    expect(result.receipt.state).toBe("refused");
    expect(f.store.capabilityGrantStore.listActiveGrantsForPrincipalBoundary(f.actor.actor.actor_id, f.boundary)).toEqual([]);
  });

  it.each(["interactive", "unattended"] as const)("delegates, publishes and revokes through the same %s contract", async mode => {
    const f = await fixture(mode);
    const invalid = f.store.actorDefinitionStore.createDraft({ actor_id: f.actor.actor.actor_id,
      created_by_principal_id: f.principal, definition: { ...f.actor.draft.content, capability_grant_ids: [f.grant.grant_id] } });
    const refused = await f.invoke("actor.definition.publish", { expected_current_definition_revision_id: f.actor.draft.actor_definition_revision_id }, {
      target: { kind: "actor_definition_revision", id: invalid.actor_definition_revision_id }, expected: invalid.semantic_digest,
    });
    expect(refused.receipt).toMatchObject({ state: "refused", refusal: { message: expect.stringContaining("grant_principal_mismatch") } });
    expect(f.store.actorDefinitionStore.requireActor(f.actor.actor.actor_id).current_definition_revision_id).toBe(f.actor.draft.actor_definition_revision_id);
    const delegated = await f.invoke("capability.grant.delegate", { expires_at: expiry, source_grant_id: f.grant.grant_id,
      operation_ids: ["context.inspect", "artefact.inspect"] }, { key: "same-delegation" });
    expect(delegated.receipt.state).toBe("completed");
    const grantId = delegated.receipt.result.grant.grant_id;
    const replay = await f.invoke("capability.grant.delegate", { expires_at: expiry, source_grant_id: f.grant.grant_id,
      operation_ids: ["context.inspect", "artefact.inspect"] }, { key: "same-delegation" });
    expect(replay).toMatchObject({ replayed: true, receipt: { receipt_id: delegated.receipt.receipt_id } });
    expect(f.store.capabilityGrantStore.listActiveGrantsForPrincipalBoundary(f.actor.actor.actor_id, f.boundary)).toHaveLength(1);
    const valid = f.store.actorDefinitionStore.createDraft({ actor_id: f.actor.actor.actor_id,
      created_by_principal_id: f.principal, definition: { ...f.actor.draft.content, capability_grant_ids: [grantId] } });
    const published = await f.invoke("actor.definition.publish", { expected_current_definition_revision_id: f.actor.draft.actor_definition_revision_id }, {
      target: { kind: "actor_definition_revision", id: valid.actor_definition_revision_id }, expected: valid.semantic_digest,
    });
    expect(published.receipt.state).toBe("completed");
    const session = f.store.operationAuthoritySessions.issueSession({ principal_id: f.actor.actor.actor_id,
      workspace_id: f.boundary.workspace_id, grant_ids: [grantId], expires_at: expiry,
      interaction: { mode, session_id: "reviewer" }, provenance });
    expect(f.store.operationAuthorityVerifier.verifyBearerToken(session.bearer_token, { boundary: f.boundary }).verified).toBe(true);
    expect((await f.invoke("capability.grant.revoke", { grant_id: grantId }, { expected: null })).receipt.state).toBe("completed");
    expect(() => f.store.operationAuthoritySessions.issueSession({ ...session.session, grant_ids: [grantId],
      interaction: { mode, session_id: "reviewer:new" } })).toThrow("grant_revoked");
  });

  it("preserves account constraints and denies actual brokered use after the source is revoked", async () => {
    const f = await fixture();
    const ref = f.store.secretRefStore.createSecretRef({ owner: { kind: "host", host_id: f.store.localHostId },
      resource: { kind: "provider_account", id: "test:account" }, secret_kind: "oauth", label: "Test account" });
    const source = f.store.capabilityGrantStore.issueGrant({ principal_id: f.principal, boundary: f.boundary,
      operation_ids: ["credential.bind", "credential.use", "credential.refresh"],
      targets: [{ kind: "secret_ref", id: ref.secret_ref_id }, ref.resource], expires_at: expiry,
      issuer_id: "policy:test", evidence: [{ kind: "policy", ref: "account:test" }] });
    f.store.secretRefStore.attachGrantConstraint({ grant_id: source.grant_id, secret_ref_id: ref.secret_ref_id,
      authority_boundary: f.boundary, purposes: [RUNTIME_CREDENTIAL_PURPOSE] }, f.store.capabilityGrantStore);
    const broker = new InMemoryCredentialBroker("broker:delegation-test");
    const service = new CredentialBrokerService(f.store.secretRefStore, f.store.capabilityGrantStore, [broker]);
    const request = { principal_id: f.principal, grant_id: source.grant_id, secret_ref_id: ref.secret_ref_id,
      authority_boundary: f.boundary, resource: ref.resource, purpose: RUNTIME_CREDENTIAL_PURPOSE, operation_id: "credential.bind" };
    await service.bindSecretRef({ request, broker_id: broker.broker_id, material: new TextEncoder().encode("test-only-material") });
    const response = await f.invoke("capability.grant.delegate", { expires_at: expiry, source_grant_id: source.grant_id,
      operation_ids: ["credential.use", "credential.refresh"] }, { token: f.issueSession([f.grant.grant_id, source.grant_id]) });
    expect(response.receipt.state).toBe("completed");
    expect(JSON.stringify(response)).not.toContain("test-only-material");
    const grantId = response.receipt.result.grant.grant_id;
    expect(f.store.secretRefStore.getGrantConstraint(grantId)).toMatchObject({ secret_ref_id: ref.secret_ref_id,
      purposes: [RUNTIME_CREDENTIAL_PURPOSE] });
    const use = { ...request, principal_id: f.actor.actor.actor_id, grant_id: grantId, operation_id: "credential.use" };
    expect(await service.useSecret(use, bytes => bytes.length)).toBe(18);
    await expect(service.useSecret({ ...use, purpose: "different-purpose" }, bytes => bytes.length)).rejects.toMatchObject({ reason_code: "grant_purpose_mismatch" });
    f.store.capabilityGrantStore.revokeGrant(source.grant_id);
    await expect(service.useSecret(use, bytes => bytes.length)).rejects.toMatchObject({ reason_code: "grant_dependency_unavailable" });
  });

  it("lets a Navigator delegate write and shell access it can never exercise itself", async () => {
    const f = await fixture();
    const toolOps = ["engine.tool.filesystem.write", "engine.tool.process.execute"];
    const ceiling = f.store.capabilityGrantStore.issueGrant({ principal_id: f.principal, boundary: f.boundary,
      operation_ids: toolOps, targets: [{ kind: "filesystem_path", id: "src" }], expires_at: expiry,
      issuer_id: "policy:test", evidence: [{ kind: "policy", ref: "builder-ceiling" }], delegation_only: true });
    expect(ceiling.delegation_only).toBe(true);
    const token = f.issueSession([f.grant.grant_id, ceiling.grant_id]);
    const own = f.store.capabilityGrantStore.resolveSessionAuthority({ principal_id: f.principal, boundary: f.boundary,
      grant_ids: [f.grant.grant_id, ceiling.grant_id],
      interaction: { mode: "unattended", session_id: "navigator", confirmed_prompts: [], approval_refs: [] } },
    { kind: "filesystem_path", id: "src" });
    for (const op of toolOps) expect(own.authority.grants.has(op)).toBe(false);
    expect(own.authority.session_capability_grant_ids).toContain(ceiling.grant_id);
    const listed = await f.invoke("capability.grant.list", {}, { token, target: null, expected: null });
    expect(listed.receipt.result.active_grants.map((grant: any) => grant.grant_id)).not.toContain(ceiling.grant_id);
    expect(listed.receipt.result.delegable_grants.map((grant: any) => grant.grant_id)).toEqual([ceiling.grant_id]);

    const wider = await f.invoke("capability.grant.delegate", { expires_at: expiry, source_grant_id: ceiling.grant_id,
      operation_ids: ["engine.tool.filesystem.write"], targets: [{ kind: "filesystem_path", id: "." }] }, { token });
    expect(wider.receipt).toMatchObject({ state: "refused", refusal: { message: expect.stringContaining("contained in the source") } });

    const child = await f.invoke("capability.grant.delegate", { expires_at: expiry, source_grant_id: ceiling.grant_id,
      operation_ids: ["engine.tool.filesystem.write"], targets: [{ kind: "filesystem_path", id: "src/app" }] }, { token });
    expect(child.receipt.state).toBe("completed");
    expect(child.receipt.result.grant).toMatchObject({ delegation_only: false, targets: [{ kind: "filesystem_path", id: "src/app" }] });
    const builderGrants = () => f.store.capabilityGrantStore.listActiveGrantsForPrincipalBoundary(f.actor.actor.actor_id, f.boundary);
    expect(builderGrants().map(grant => grant.grant_id)).toEqual([child.receipt.result.grant.grant_id]);

    f.store.capabilityGrantStore.revokeGrant(ceiling.grant_id);
    expect(builderGrants()).toEqual([]);
  });

  it("refuses a delegation without an explicit lifetime, or with two", async () => {
    const f = await fixture();
    for (const lifetime of [{}, { until_revoked: true, expires_at: expiry }]) {
      const result = await f.invoke("capability.grant.delegate", { ...lifetime, source_grant_id: f.grant.grant_id,
        operation_ids: ["context.inspect"] });
      expect(result.receipt).toMatchObject({ state: "refused", refusal: { code: "delegation_lifetime_required" } });
    }
    expect(f.store.capabilityGrantStore.listActiveGrantsForPrincipalBoundary(f.actor.actor.actor_id, f.boundary)).toEqual([]);
  });

  it("never treats a delegation-only grant as permission to delegate", async () => {
    const f = await fixture();
    const permissionOnly = f.store.capabilityGrantStore.issueGrant({ principal_id: f.principal, boundary: f.boundary,
      operation_ids: ["capability.grant.delegate", "context.inspect"], expires_at: expiry, issuer_id: "policy:test",
      evidence: [{ kind: "policy", ref: "not-exercisable" }], delegation_only: true });
    const token = f.issueSession([permissionOnly.grant_id]);
    const result = await f.invoke("capability.grant.delegate", { expires_at: expiry, source_grant_id: permissionOnly.grant_id,
      operation_ids: ["context.inspect"] }, { token });
    expect(result.receipt?.state ?? result.state).not.toBe("completed");
    expect(f.store.capabilityGrantStore.listActiveGrantsForPrincipalBoundary(f.actor.actor.actor_id, f.boundary)).toEqual([]);
  });

  it("refuses a source outside the caller's session without creating recipient authority", async () => {
    const f = await fixture();
    const extra = f.store.capabilityGrantStore.issueGrant({ principal_id: f.principal, boundary: f.boundary,
      operation_ids: ["context.inspect"], expires_at: expiry, issuer_id: "test", evidence: [{ kind: "test", ref: "extra" }] });
    const result = await f.invoke("capability.grant.delegate", { expires_at: expiry, source_grant_id: extra.grant_id, operation_ids: ["context.inspect"] });
    expect(result.receipt).toMatchObject({ state: "refused", refusal: { message: expect.stringContaining("not part of this authenticated session") } });
    expect(f.store.capabilityGrantStore.listActiveGrantsForPrincipalBoundary(f.actor.actor.actor_id, f.boundary)).toEqual([]);
  });

  it("retains source revocation dependencies through a portable Workspace restore", async () => {
    const source = await fixture();
    const result = await source.invoke("capability.grant.delegate", { expires_at: expiry, source_grant_id: source.grant.grant_id, operation_ids: ["context.inspect"] });
    expect(result.receipt.state).toBe("completed");
    const childId = result.receipt.result.grant.grant_id;
    const onward = await source.invoke("capability.grant.delegate", { expires_at: expiry, source_grant_id: source.grant.grant_id,
      operation_ids: ["artefact.inspect"], delegation_only: true });
    const onwardId = onward.receipt.result.grant.grant_id;
    const bundle = source.store.workspacePortabilityService.exportWorkspace(source.boundary.workspace_id);
    expect(bundle.manifest.records.find(record => record.table === "capability_grant_delegations")?.record_count).toBe(2);
    expect(bundle.manifest.records.find(record => record.table === "capability_grant_delegation_only")?.record_count).toBe(1);
    const target = await fixture();
    target.store.workspacePortabilityService.restoreWorkspace({ bundle_directory: bundle.bundle_directory,
      workspace_locator: join(target.dir, "restored") });
    expect(target.store.capabilityGrantStore.getDelegation(childId)).toEqual(source.store.capabilityGrantStore.getDelegation(childId));
    expect(target.store.capabilityGrantStore.getGrant(onwardId)?.delegation_only).toBe(true);
    target.store.capabilityGrantStore.revokeGrant(source.grant.grant_id);
    expect(target.store.capabilityGrantStore.inspectSessionGrantIds({ principal_id: source.actor.actor.actor_id,
      boundary: source.boundary, grant_ids: [childId] }).unavailable_grants).toEqual([
      { grant_id: childId, code: "grant_dependency_unavailable" },
    ]);
  });
});
