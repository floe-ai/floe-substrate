import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "./config.js";
import { createBusServer } from "./server.js";

describe("Scope creation through equivalent authority", () => {
  let root: string;
  let handle: Awaited<ReturnType<typeof createBusServer>>;
  let workspace: string;
  const provenance = { cause_event_id: null, delivery_ids: [], execution_attempt_id: null, node_execution_id: null, scope_execution_id: null };
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "floe-scope-creation-"));
    const config = defaultConfig(root);
    const path = join(root, "config.yaml");
    writeFileSync(path, YAML.stringify(config));
    handle = await createBusServer(path, config, { host_control_token: `test-scope-host-${"h".repeat(48)}` });
    await handle.app.ready();
    workspace = (handle.store.registerWorkspace({ locator: root, name: "Campaign", init_authorized: true }, handle.broadcast) as { workspace_id: string }).workspace_id;
  });
  afterEach(async () => { await handle?.app.close(); rmSync(root, { recursive: true, force: true }); });

  function connection(mode: "interactive" | "unattended", operations = ["scope.create", "scope.list", "scope.composition.draft.create"]) {
    const principal = `principal:${mode}`;
    const grant = handle.store.capabilityGrantStore.issueGrant({ principal_id: principal,
      boundary: { kind: "workspace", workspace_id: workspace }, operation_ids: operations,
      expires_at: "2099-01-01T00:00:00.000Z", issuer_id: "test:scope-authority", evidence: [{ kind: "test_fixture", ref: "scope-authority" }],
    });
    const session = handle.store.operationAuthoritySessions.issueSession({ principal_id: principal, workspace_id: workspace,
      grant_ids: [grant.grant_id], interaction: { mode, session_id: `session:${mode}` }, provenance, expires_at: "2099-01-01T00:00:00.000Z",
    });
    return { principal, grant, headers: { authorization: `Bearer ${session.bearer_token}` } };
  }
  const base = () => `/v1/workspaces/${encodeURIComponent(workspace)}`;
  const invocation = (operation: string, key: string, input: unknown) => ({ operation_id: operation, operation_version: "1", input_schema_version: "1", target: null, expected_resource_revision: null, idempotency_key: key, input });

  it.each(["interactive", "unattended"] as const)("ranks a concrete need before unrelated matches for %s discovery", async mode => {
    const { headers } = connection(mode);
    const all = (await handle.app.inject({ url: `${base()}/operations`, headers })).json().operations;
    for (const [query, wanted] of [["scope create", "scope.create"], ["scope list", "scope.list"], ["execution start", "scope.execution.start"], ["node output", "scope.node-output.publish"]]) {
      const found = (await handle.app.inject({ url: `${base()}/operations?query=${encodeURIComponent(query)}`, headers })).json().operations;
      expect(found[0]?.operation_id, query).toBe(wanted);
      // Search order cannot grant access, drop a refusal, or change a contract.
      expect(found[0]).toEqual(all.find((item: { operation_id: string }) => item.operation_id === wanted));
    }
    const broad = (await handle.app.inject({ url: `${base()}/operations?query=scope%20create`, headers })).json().operations;
    expect(broad.length).toBeGreaterThan(20);
    expect(broad.some((item: { operation_id: string }) => item.operation_id === "actor.create")).toBe(true);
  });

  it.each(["interactive", "unattended"] as const)("creates, lists and composes the same retained Scope for %s authority", async mode => {
    const { headers, principal } = connection(mode);
    const discovery = await handle.app.inject({ url: `${base()}/operations?query=scope`, headers });
    expect(discovery.json().operations).toContainEqual(expect.objectContaining({ operation_id: "scope.create", availability: { available: true } }));
    const input = { title: "Night market", description: "Independent makers" };
    const request = invocation("scope.create", "night-market", input);
    const created = await handle.app.inject({ method: "POST", url: `${base()}/operations/invoke`, headers, payload: request });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({ kind: "receipt", receipt: { state: "completed", principal_id: principal, authority_boundary: { kind: "workspace", workspace_id: workspace } } });
    const { receipt } = created.json();
    const scope = receipt.result.scope;
    expect(scope).toMatchObject({ ...input, workspace_id: workspace, status: "active", published_revision_id: null });
    const replay = await handle.app.inject({ method: "POST", url: `${base()}/scopes`, headers: { ...headers, "idempotency-key": "night-market" }, payload: input });
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json()).toMatchObject({ scope, receipt_id: receipt.receipt_id });
    const listed = await handle.app.inject({ method: "POST", url: `${base()}/operations/invoke`, headers, payload: invocation("scope.list", "list", {}) });
    expect(listed.json().receipt.result.scopes).toEqual([scope]);
    const draft = await handle.app.inject({ method: "POST", url: `${base()}/operations/invoke`, headers, payload: {
      ...invocation("scope.composition.draft.create", "draft", { content: {
        nodes: [{ node_id: "incoming", kind: "event", config: { event_type: "campaign.arrived" }, context_policy: { mode: "new_per_execution" } }],
        ports: [{ port_id: "incoming:out", node_id: "incoming", name: "work", direction: "output" }], edges: [],
      } }),
      target: { kind: "scope", id: scope.scope_id }, expected_resource_revision: "none",
    } });
    expect(draft.json(), draft.body).toMatchObject({ kind: "receipt", receipt: { state: "completed", result: { revision: { scope_id: scope.scope_id, workspace_id: workspace } } } });
    const read = await handle.app.inject({ url: `${base()}/operation-receipts/${receipt.receipt_id}`, headers });
    expect(read.json().receipt).toEqual(receipt);
  });

  it("requires the creation grant on both transports and rejects caller-authored Workspace authority", async () => {
    const limited = connection("unattended", ["scope.list"]);
    const request = invocation("scope.create", "refused", { title: "Unapproved" });
    const refused = await handle.app.inject({ method: "POST", url: `${base()}/operations/invoke`, headers: limited.headers, payload: request });
    expect(refused.json()).toMatchObject({ kind: "receipt", receipt: { state: "refused", result: null } });
    expect((await handle.app.inject({ method: "POST", url: `${base()}/scopes`, headers: limited.headers, payload: request.input })).statusCode).toBe(403);
    const allowed = connection("interactive");
    const forged = await handle.app.inject({ method: "POST", url: `${base()}/operations/invoke`, headers: allowed.headers, payload: { ...request, input: { title: "Wrong Workspace", workspace_id: "other" } } });
    expect(forged.json()).toMatchObject({ kind: "receipt", receipt: { state: "refused", result: null } });
    const wrongWorkspace = await handle.app.inject({ method: "POST", url: "/v1/workspaces/other/operations/invoke", headers: allowed.headers, payload: request });
    expect(wrongWorkspace.statusCode).toBe(401);
    expect(handle.store.listScopes(workspace)).toEqual([]);
  });

  it("returns canonical duplicate and reserved-identity refusals without creating another Scope", async () => {
    const { headers } = connection("interactive");
    const create = (id: string, key: string) => handle.app.inject({ method: "POST", url: `${base()}/operations/invoke`, headers,
      payload: invocation("scope.create", key, { scope_id: id, title: "Campaign" }) });
    expect((await create("night-market", "first")).json().receipt.state).toBe("completed");
    expect((await create("night-market", "second")).json().receipt.refusal.code).toBe("scope_already_exists");
    expect((await create("default", "reserved")).json().receipt.refusal.code).toBe("scope_id_reserved");
    expect(handle.store.listScopes(workspace)).toHaveLength(1);
  });
});
