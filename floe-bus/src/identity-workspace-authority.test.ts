import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { defaultConfig } from "./config.js";
import { createBusServer } from "./server.js";
import { DEFAULT_ACTOR_OPERATIONS_V1 } from "./local-product-policy.js";

const HOST_TOKEN = "a".repeat(48);
const bearer = (token: string) => ({ authorization: ["Be", "arer ", token].join("") });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

type Handle = Awaited<ReturnType<typeof createBusServer>>;

async function start(dir: string): Promise<Handle> {
  const configPath = join(dir, "config.yaml");
  const config = defaultConfig(dir);
  writeFileSync(configPath, YAML.stringify(config));
  const handle = await createBusServer(configPath, config, { host_control_token: HOST_TOKEN });
  await handle.app.ready();
  return handle;
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "floe-identity-authority-"));
  let handle = await start(dir);
  cleanup.push(async () => { await handle.app.close(); rmSync(dir, { recursive: true, force: true }); });
  const locator = join(dir, "workspace"); mkdirSync(locator);
  const workspaceId = (handle.store.registerWorkspace({ locator, name: "Authority proof" }, handle.broadcast) as { workspace_id: string }).workspace_id;

  const person = (name: string) => {
    const secret = generateSecretKey();
    const admit = async (body: Record<string, unknown> = { until_revoked: true }) => handle.app.inject({
      method: "POST", url: "/v1/identities", headers: bearer(HOST_TOKEN),
      payload: { display_name: name, pubkey: getPublicKey(secret), workspace_id: workspaceId, ...body },
    });
    const authenticate = async () => {
      const { challenge, relay } = (await handle.app.inject({ method: "GET", url: "/v1/identity/challenge" })).json();
      const event = finalizeEvent({ kind: 22242, created_at: Math.floor(Date.now() / 1000),
        tags: [["relay", relay], ["challenge", challenge]], content: "" }, secret);
      return handle.app.inject({ method: "POST", url: "/v1/identity/authenticate",
        payload: { workspace_id: workspaceId, auth_event: event } });
    };
    return { admit, authenticate };
  };

  let sequence = 0;
  const invoke = async (token: string, operationId: string, input: object,
    target: { kind: string; id: string } | null = null, expected: string | null = null) => {
    const response = await handle.app.inject({ method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations/invoke`,
      headers: bearer(token), payload: {
        operation_id: operationId, operation_version: "1", input_schema_version: "1", input,
        target, expected_resource_revision: expected, idempotency_key: `authority-test:${++sequence}`,
      } });
    return { status: response.statusCode, body: response.json() };
  };

  const actor = () => {
    const created = handle.store.actorDefinitionStore.createActor({ workspace_id: workspaceId,
      created_by_principal_id: "principal:test", definition: { label: "Helper", charter: "Help", instructions: "Help",
        responsibilities: [], knowledge_refs: [], capability_grant_ids: [],
        policy_refs: { budget: null, trust: null, approval: null }, escalation_rules: [] } });
    handle.store.actorDefinitionStore.publishDraft({ actor_definition_revision_id: created.draft.actor_definition_revision_id,
      expected_current_revision_id: null, changed_by_principal_id: "principal:test" });
    return handle.store.actorDefinitionStore.requireActor(created.actor.actor_id);
  };

  const grantActive = (grantId: string, principalId: string) => handle.store.capabilityGrantStore.inspectSessionGrantIds({
    principal_id: principalId, boundary: { kind: "workspace", workspace_id: workspaceId }, grant_ids: [grantId],
  }).active_grants.length === 1;

  const restart = async () => {
    await handle.app.close();
    handle = await start(dir);
  };

  return { get handle() { return handle; }, workspaceId, person, invoke, actor, grantActive, restart };
}

describe("durable identity authority (A1)", () => {
  it("refuses admission without an explicit lifetime", async () => {
    const f = await fixture();
    const missing = await f.person("A").admit({});
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe("authority_lifetime_required");
    const both = await f.person("A").admit({ until_revoked: true, expires_at: "2099-01-01T00:00:00.000Z" });
    expect(both.statusCode).toBe(400);
  });

  it("proves the lifetime chain: sessions reference a durable root, delegation outlives them, revocation ends it all", async () => {
    const f = await fixture();
    const a = f.person("A");

    // 1. Admission issues a root that lasts until revoked, under A's own principal.
    const admitted = (await a.admit()).json();
    const identityId = admitted.identity.identity_id as string;
    expect(admitted.identity.principal_id).toBe(`identity:${identityId}`);
    expect(admitted.authority).toMatchObject({ principal_id: `identity:${identityId}`, expires_at: null, status: "active" });
    const rootGrantId = admitted.authority.root_grant_id as string;

    // 2. The bearer is short; the root is not.
    const first = (await a.authenticate()).json();
    expect(Date.parse(first.expires_at) - Date.now()).toBeLessThanOrEqual(3_600_000);
    expect(f.handle.store.capabilityGrantStore.getGrant(rootGrantId)?.expires_at).toBeNull();
    const inspected = await f.invoke(first.bearer_token, "identity.workspace-authority.inspect", {});
    expect(inspected.body.receipt.result.authority).toMatchObject({ root_grant_id: rootGrantId, expires_at: null });

    // 3. Delegate narrow access to an Actor, until revoked.
    const helper = f.actor();
    const delegated = await f.invoke(first.bearer_token, "capability.grant.delegate",
      { source_grant_id: rootGrantId, operation_ids: ["context.inspect"], until_revoked: true },
      { kind: "actor", id: helper.actor_id }, helper.current_definition_revision_id);
    expect(delegated.body.receipt.state, JSON.stringify(delegated.body)).toBe("completed");
    const childId = delegated.body.receipt.result.grant.grant_id as string;
    expect(delegated.body.receipt.result.grant.expires_at).toBeNull();

    // 4. Ending A's session leaves the root and the Actor grant intact.
    const ended = await f.handle.app.inject({ method: "DELETE", headers: bearer(HOST_TOKEN),
      url: `/v1/clients/${identityId}/sessions/${first.authority_session_id}` });
    expect(ended.statusCode).toBe(200);
    expect(f.grantActive(childId, helper.actor_id)).toBe(true);
    const second = (await a.authenticate()).json();
    expect(second.bearer_token).toBeTruthy();
    expect((await f.invoke(second.bearer_token, "identity.workspace-authority.inspect", {}))
      .body.receipt.result.authority.root_grant_id).toBe(rootGrantId);

    // 5. Both survive a restart.
    await f.restart();
    expect(f.grantActive(rootGrantId, `identity:${identityId}`)).toBe(true);
    expect(f.grantActive(childId, helper.actor_id)).toBe(true);
    const afterRestart = (await a.authenticate()).json();

    // 7. B is a different principal and cannot touch A's delegation.
    const b = f.person("B");
    const bAdmitted = (await b.admit()).json();
    expect(bAdmitted.identity.principal_id).not.toBe(admitted.identity.principal_id);
    const bSession = (await b.authenticate()).json();
    const bRevoke = await f.invoke(bSession.bearer_token, "capability.grant.revoke", { grant_id: childId },
      { kind: "actor", id: helper.actor_id });
    expect(bRevoke.body.receipt.state).toBe("refused");
    expect(f.grantActive(childId, helper.actor_id)).toBe(true);

    // 6. Revoking A's membership ends A's session, root and Actor grant together.
    const removed = await f.handle.app.inject({ method: "DELETE", headers: bearer(HOST_TOKEN),
      url: `/v1/clients/${identityId}/workspaces/${f.workspaceId}` });
    expect(removed.statusCode).toBe(200);
    const dead = await f.handle.app.inject({ method: "GET", headers: bearer(afterRestart.bearer_token),
      url: `/v1/pending-responses?workspace_id=${f.workspaceId}` });
    expect(dead.statusCode).toBe(401);
    expect(f.grantActive(rootGrantId, `identity:${identityId}`)).toBe(false);
    expect(f.grantActive(childId, helper.actor_id)).toBe(false);
    expect((await a.authenticate()).statusCode).toBe(403);
    // B is untouched.
    expect(f.grantActive(bAdmitted.authority.root_grant_id, bAdmitted.identity.principal_id)).toBe(true);
  });

  it("revoking the identity ends its authority in every Workspace", async () => {
    const f = await fixture();
    const a = f.person("A");
    const admitted = (await a.admit()).json();
    const revoked = await f.handle.app.inject({ method: "DELETE", headers: bearer(HOST_TOKEN),
      url: `/v1/clients/${admitted.identity.identity_id}` });
    expect(revoked.statusCode).toBe(200);
    expect(f.grantActive(admitted.authority.root_grant_id, admitted.identity.principal_id)).toBe(false);
    const record = f.handle.store.identityWorkspaceAuthorityStore.get(admitted.authority.authority_id);
    expect(record).toMatchObject({ status: "revoked", revocation_reason: "identity_revoked" });
  });

  it("lets a person narrow their own authority but never widen it, and give it up", async () => {
    const f = await fixture();
    const a = f.person("A");
    const admitted = (await a.admit({ expires_at: "2099-01-01T00:00:00.000Z" })).json();
    expect(admitted.authority.expires_at).toBe("2099-01-01T00:00:00.000Z");
    const session = (await a.authenticate()).json();

    const longer = await f.invoke(session.bearer_token, "identity.workspace-authority.replace",
      { operation_ids: ["identity.workspace-authority.inspect"], until_revoked: true });
    expect(longer.body.receipt.refusal.code).toBe("authority_widening_refused");
    const noLifetime = await f.invoke(session.bearer_token, "identity.workspace-authority.replace",
      { operation_ids: ["identity.workspace-authority.inspect"] });
    expect(noLifetime.body.receipt.refusal.code).toBe("authority_lifetime_required");

    const narrowed = await f.invoke(session.bearer_token, "identity.workspace-authority.replace", {
      operation_ids: ["identity.workspace-authority.inspect", "identity.workspace-authority.revoke"],
      expires_at: "2098-01-01T00:00:00.000Z",
    });
    expect(narrowed.body.receipt.state, JSON.stringify(narrowed.body)).toBe("completed");
    expect(narrowed.body.receipt.result.replaced_authority_id).toBe(admitted.authority.authority_id);
    expect(f.grantActive(admitted.authority.root_grant_id, admitted.identity.principal_id)).toBe(false);

    // The old session referenced the old root; a new one references the narrower root.
    const next = (await a.authenticate()).json();
    const listed = await f.invoke(next.bearer_token, "context.list", {});
    expect(listed.status === 403 || listed.body.receipt?.state === "refused", JSON.stringify(listed.body)).toBe(true);
    const gaveUp = await f.invoke(next.bearer_token, "identity.workspace-authority.revoke", {});
    expect(gaveUp.body.receipt.result.authority.status).toBe("revoked");
    expect((await a.authenticate()).statusCode).toBe(403);
  });

  it("lets a person with decide authority answer an approval naming the host operator, and records who answered (O1)", async () => {
    const f = await fixture();
    const store = f.handle.store;
    const admitted = (await f.person("A").admit()).json();
    const principal = admitted.identity.principal_id as string;
    const outsider = "identity:not-admitted";
    store.capabilityGrantStore.issueGrant({ principal_id: outsider, boundary: { kind: "workspace", workspace_id: f.workspaceId },
      operation_ids: ["approval.decide"], expires_at: null, issuer_id: "test", evidence: [{ kind: "test", ref: "outsider" }] });
    const request = (key: string) => store.approvalStore.createRequest({
      workspace_id: f.workspaceId, context_id: null, requested_by_principal_id: "actor:helper",
      reason: "Publish the reviewed page.", expires_at: "2099-01-01T00:00:00.000Z", idempotency_key: key,
      decision_policy: { source: { kind: "local_operator", principal_id: store.localOperatorPrincipalId },
        approvers: { mode: "any", principal_ids: [store.localOperatorPrincipalId], roles: [] } },
      action: { operation_id: "connector.worker.action.execute", authorized_principal_id: "worker:connector-host",
        target: { kind: "connector_binding", id: "connector-binding:publish", revision: "2" }, input_digest: "b".repeat(64),
        artefact_version_ids: [], composition_revision_id: null, node_placement_id: null, scope_execution_id: null,
        node_execution_id: null, connector_binding_revision_id: "connector-binding-revision:publish-2",
        extension_package_version_id: null, approval_policy_ref: null, capability_grant_ids: [],
        expected_effect: { summary: "Publish.", external: true, reversibility: "reversible", resource_refs: [] } },
    });
    const decide = (requestId: string, by: string) => store.decideApprovalRequest({
      workspace_id: f.workspaceId, approval_request_id: requestId,
      expected_state_revision: store.approvalStore.requireRequest(requestId).state_revision,
      decision: "approved", decided_by_principal_id: by, decision_reason: "Checked.", operation_invocation_id: `invoke:${requestId}`,
    });

    // An identity without Workspace authority is not a stand-in, even holding approval.decide.
    const refused = request("o1:outsider");
    expect(() => decide(refused.approval_request_id, outsider)).toThrow();

    const answered = request("o1:person");
    const result = decide(answered.approval_request_id, principal);
    expect(result.request.status).toBe("approved");
    expect(result.request.decided_by_principal_id).toBe(principal);
    expect(JSON.stringify(result)).toContain(`stands_in_for:${store.localOperatorPrincipalId}`);
  });

  it("gives memberships admitted before durable authority their root once, at start", async () => {
    const f = await fixture();
    const secret = generateSecretKey();
    const identity = f.handle.store.clientIdentityStore.admitIdentity({
      pubkey_hex: getPublicKey(secret), display_name: "Older", admitted_by: "test" });
    f.handle.store.clientIdentityStore.addWorkspaceMembership({
      identity_id: identity.identity_id, workspace_id: f.workspaceId, admitted_by: "test" });
    expect(f.handle.store.identityWorkspaceAuthorityStore.getActive(identity.identity_id, f.workspaceId)).toBeNull();
    await f.restart();
    const migrated = f.handle.store.identityWorkspaceAuthorityStore.getActive(identity.identity_id, f.workspaceId);
    expect(migrated).toMatchObject({ expires_at: null, issued_by: "system:identity-authority-migration:v0.4.0" });
    expect(f.handle.store.identityAuthorityMigration).toEqual([{ identity_id: identity.identity_id, workspace_id: f.workspaceId }]);
    // A revoked authority is never re-issued.
    f.handle.store.identityWorkspaceAuthorityStore.revoke(migrated!.authority_id, "revoked");
    await f.restart();
    expect(f.handle.store.identityWorkspaceAuthorityStore.getActive(identity.identity_id, f.workspaceId)).toBeNull();
  });
  it("lets a person adopt an Actor's access: default access for an Actor with none, refused when nothing is left", async () => {
    const f = await fixture();
    const a = f.person("Ada");
    const admitted = (await a.admit()).json();
    const token = (await a.authenticate()).json().bearer_token as string;
    const helper = f.actor();

    const adopted = await f.invoke(token, "actor.access.adopt", { actor_id: helper.actor_id });
    expect(adopted.body.receipt.state, JSON.stringify(adopted.body)).toBe("completed");
    const [grantId] = adopted.body.receipt.result.issued_grant_ids as string[];
    const grants = f.handle.store.capabilityGrantStore;
    const root = grants.getGrant(admitted.authority.root_grant_id)!;
    expect(grants.getGrant(grantId!)).toMatchObject({ expires_at: null, issuer_id: admitted.identity.principal_id,
      operation_ids: DEFAULT_ACTOR_OPERATIONS_V1.filter(id => root.operation_ids.includes(id)).sort() });
    expect(f.handle.store.actorDefinitionStore.getCurrentDefinition(helper.actor_id)?.content.capability_grant_ids).toEqual([grantId]);
    expect(f.handle.store.workspaceAccessStore.inspect(f.workspaceId).records.map(record => record.summary))
      .toContain("Helper was given access to this workspace by Ada. It lasts until Ada's access is revoked.");

    const again = await f.invoke(token, "actor.access.adopt", { actor_id: helper.actor_id });
    expect(again.body.receipt).toMatchObject({ state: "refused", refusal: { code: "actor_access_nothing_to_adopt" } });
  });

  it("moves older Floe-issued Actor access onto the one person at start, and clears the lapse warning", async () => {
    const f = await fixture();
    const helper = f.actor();
    const store = () => f.handle.store;
    const old = store().capabilityGrantStore.issueGrant({ principal_id: helper.actor_id,
      boundary: { kind: "workspace", workspace_id: f.workspaceId }, operation_ids: ["context.inspect"], targets: [],
      expires_at: "2099-01-01T00:00:00.000Z", issuer_id: "policy:local-floe-actor:v1", evidence: [{ kind: "local_product_policy", ref: "v1" }] });
    const current = store().actorDefinitionStore.getCurrentDefinition(helper.actor_id)!;
    const draft = store().actorDefinitionStore.createDraft({ actor_id: helper.actor_id, created_by_principal_id: "principal:test",
      definition: { ...current.content, capability_grant_ids: [old.grant_id] } });
    store().actorDefinitionStore.publishDraft({ actor_definition_revision_id: draft.actor_definition_revision_id,
      expected_current_revision_id: current.actor_definition_revision_id, changed_by_principal_id: "principal:test" });
    const kinds = () => store().workspaceAccessStore.inspect(f.workspaceId).records.map(record => record.kind);
    expect(kinds()).toEqual(["actor_access_lapsing"]);
    expect(store().workspaceAccessStore.inspect(f.workspaceId).records[0]!.summary)
      .toBe("Helper loses its access to this workspace on 2099-01-01, unless a person here adopts it.");

    await f.person("Ada").admit();
    await f.restart();
    expect(store().actorAccessMigration).toEqual([expect.objectContaining({ actor_id: helper.actor_id, moved_grant_ids: [old.grant_id] })]);
    const [adopted] = store().actorDefinitionStore.getCurrentDefinition(helper.actor_id)!.content.capability_grant_ids;
    expect(store().capabilityGrantStore.getGrant(adopted!)).toMatchObject({ operation_ids: ["context.inspect"], expires_at: null });
    expect(kinds()).toEqual(["actor_access_moved"]);
    await f.restart();
    expect(store().actorAccessMigration).toEqual([]);
  });
});
