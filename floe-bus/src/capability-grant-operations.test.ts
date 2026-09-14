import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { defaultConfig } from "./config.js";
import { createBusServer } from "./server.js";
import { CAPABILITY_GRANT_OPERATION_IDS } from "./capability-grant-operations.js";
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
    operation_ids: [...CAPABILITY_GRANT_OPERATION_IDS, "actor.definition.publish", "context.inspect", "artefact.inspect"],
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
    const result = await f.invoke("capability.grant.delegate", { source_grant_id: f.grant.grant_id,
      operation_ids: ["artefact.inspect"] }, { expected: null });
    expect(result.receipt.state).toBe("completed");
    const draft = f.store.actorDefinitionStore.createDraft({ actor_id: f.actor.actor.actor_id,
      created_by_principal_id: f.principal, definition: { ...f.actor.draft.content,
        capability_grant_ids: [result.receipt.result.grant.grant_id] } });
    expect((await f.invoke("actor.definition.publish", { expected_current_definition_revision_id: null }, {
      target: { kind: "actor_definition_revision", id: draft.actor_definition_revision_id }, expected: draft.semantic_digest,
    })).receipt.state).toBe("completed");
  });

  it("refuses an unpublished expectation if another caller published the Actor in the meantime", async () => {
    const f = await fixture("unattended", false);
    f.store.actorDefinitionStore.publishDraft({ actor_definition_revision_id: f.actor.draft.actor_definition_revision_id,
      expected_current_revision_id: null, changed_by_principal_id: f.principal });
    const result = await f.invoke("capability.grant.delegate", { source_grant_id: f.grant.grant_id,
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
    const delegated = await f.invoke("capability.grant.delegate", { source_grant_id: f.grant.grant_id,
      operation_ids: ["context.inspect", "artefact.inspect"] }, { key: "same-delegation" });
    expect(delegated.receipt.state).toBe("completed");
    const grantId = delegated.receipt.result.grant.grant_id;
    const replay = await f.invoke("capability.grant.delegate", { source_grant_id: f.grant.grant_id,
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
    const response = await f.invoke("capability.grant.delegate", { source_grant_id: source.grant_id,
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

  it("refuses a source outside the caller's session without creating recipient authority", async () => {
    const f = await fixture();
    const extra = f.store.capabilityGrantStore.issueGrant({ principal_id: f.principal, boundary: f.boundary,
      operation_ids: ["context.inspect"], expires_at: expiry, issuer_id: "test", evidence: [{ kind: "test", ref: "extra" }] });
    const result = await f.invoke("capability.grant.delegate", { source_grant_id: extra.grant_id, operation_ids: ["context.inspect"] });
    expect(result.receipt).toMatchObject({ state: "refused", refusal: { message: expect.stringContaining("not part of this authenticated session") } });
    expect(f.store.capabilityGrantStore.listActiveGrantsForPrincipalBoundary(f.actor.actor.actor_id, f.boundary)).toEqual([]);
  });

  it("retains source revocation dependencies through a portable Workspace restore", async () => {
    const source = await fixture();
    const result = await source.invoke("capability.grant.delegate", { source_grant_id: source.grant.grant_id, operation_ids: ["context.inspect"] });
    expect(result.receipt.state).toBe("completed");
    const childId = result.receipt.result.grant.grant_id;
    const bundle = source.store.workspacePortabilityService.exportWorkspace(source.boundary.workspace_id);
    expect(bundle.manifest.records.find(record => record.table === "capability_grant_delegations")?.record_count).toBe(1);
    const target = await fixture();
    target.store.workspacePortabilityService.restoreWorkspace({ bundle_directory: bundle.bundle_directory,
      workspace_locator: join(target.dir, "restored") });
    expect(target.store.capabilityGrantStore.getDelegation(childId)).toEqual(source.store.capabilityGrantStore.getDelegation(childId));
    target.store.capabilityGrantStore.revokeGrant(source.grant.grant_id);
    expect(target.store.capabilityGrantStore.inspectSessionGrantIds({ principal_id: source.actor.actor.actor_id,
      boundary: source.boundary, grant_ids: [childId] }).unavailable_grants).toEqual([
      { grant_id: childId, code: "grant_dependency_unavailable" },
    ]);
  });
});
