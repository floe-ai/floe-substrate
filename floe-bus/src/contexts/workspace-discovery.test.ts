import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { defaultConfig, type LocalConfig } from "../config.js";
import { createBusServer } from "../server.js";
import { registerExecutableActorFixture } from "../executable-actor-test-fixture.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

async function makeServer(): Promise<{ handle: ServerHandle; tmp: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-workspace-contexts-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg: LocalConfig = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const handle = await createBusServer(cfgPath, cfg, { unsafe_in_process_test_auth_bypass: true });
  await handle.app.ready();
  return { handle, tmp };
}

async function registerWorkspace(handle: ServerHandle, tmp: string, name: string): Promise<string> {
  const locator = join(tmp, name);
  mkdirSync(locator, { recursive: true });
  const registered = await handle.app.inject({
    method: "POST",
    url: "/v1/workspaces/register",
    headers: { authorization: `Bearer ${handle.localControlToken}` },
    payload: { locator, name }
  });
  expect(registered.statusCode).toBe(201);
  return registered.json().workspace.workspace_id;
}

async function registerEndpoint(handle: ServerHandle, workspaceId: string, name: string): Promise<string> {
  const endpointId = `actor:${workspaceId}:${name}`;
  const registered = await handle.app.inject({
    method: "POST",
    url: "/v1/endpoints/register",
    payload: {
      endpoint_id: endpointId,
      workspace_id: workspaceId,
      name,
      bridge_id: "bridge:test",
      status: "idle"
    }
  });
  expect(registered.statusCode).toBe(201);
  return endpointId;
}

async function createScope(handle: ServerHandle, workspaceId: string, scopeId: string): Promise<void> {
  const created = await handle.app.inject({
    method: "POST",
    url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`,
    payload: { scope_id: scopeId, title: scopeId }
  });
  expect(created.statusCode).toBe(201);
}

async function emitMessage(handle: ServerHandle, input: {
  workspaceId: string;
  source: string;
  target: string;
  text: string;
  scopeId?: string | null;
}): Promise<any> {
  const emitted = await handle.app.inject({
    method: "POST",
    url: "/v1/events/emit",
    payload: {
      type: "message",
      workspace_id: input.workspaceId,
      source_endpoint_id: input.source,
      destination: { kind: "endpoint", endpoint_id: input.target },
      scope_id: input.scopeId ?? null,
      content: { text: input.text },
      response: { expected: false }
    }
  });
  expect(emitted.statusCode).toBe(202);
  return emitted.json().event;
}

describe("Workspace Context discovery", () => {
  let handle: ServerHandle;
  let tmp: string;

  beforeEach(async () => {
    const made = await makeServer();
    handle = made.handle;
    tmp = made.tmp;
  });

  afterEach(async () => {
    try { await handle.app.close(); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exposes unscoped actor Contexts through a workspace-bounded Context index", async () => {
    const workspaceId = await registerWorkspace(handle, tmp, "workspace-a");
    const otherWorkspaceId = await registerWorkspace(handle, tmp, "workspace-b");
    const operator = await registerEndpoint(handle, workspaceId, "operator");
    const floe = await registerEndpoint(handle, workspaceId, "floe");
    const otherOperator = await registerEndpoint(handle, otherWorkspaceId, "operator");
    const otherFloe = await registerEndpoint(handle, otherWorkspaceId, "floe");
    await createScope(handle, workspaceId, "research");

    const unscoped = await emitMessage(handle, {
      workspaceId,
      source: operator,
      target: floe,
      text: "workspace-level hello"
    });
    const scoped = await emitMessage(handle, {
      workspaceId,
      source: operator,
      target: floe,
      scopeId: "research",
      text: "scoped hello"
    });
    await emitMessage(handle, {
      workspaceId: otherWorkspaceId,
      source: otherOperator,
      target: otherFloe,
      text: "other workspace hello"
    });

    const unscopedRes = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/contexts?scope=unscoped`
    });

    expect(unscopedRes.statusCode).toBe(200);
    expect(unscopedRes.json().contexts).toEqual([
      expect.objectContaining({
        context_id: unscoped.context_id,
        workspace_id: workspaceId,
        scope_id: null,
        participants: expect.arrayContaining([operator, floe]),
        first_message_preview: "workspace-level hello"
      })
    ]);

    const scopedRes = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/contexts?scope=scoped`
    });

    expect(scopedRes.statusCode).toBe(200);
    expect(scopedRes.json().contexts).toEqual([
      expect.objectContaining({
        context_id: scoped.context_id,
        workspace_id: workspaceId,
        scope_id: "research"
      })
    ]);
  });

  it("returns current response state in both participant and Workspace lists", async () => {
    const workspaceId = await registerWorkspace(handle, tmp, "status-workspace");
    const actor = `actor:${workspaceId}:worker`;
    handle.store.registerEndpoint({ endpoint_id: actor, workspace_id: workspaceId, name: "Worker", bridge_id: "bridge:status", status: "idle" }, () => {});
    registerExecutableActorFixture(handle.store, workspaceId, actor);
    const contextId = handle.store.contextStore.createContext({ workspace_id: workspaceId, scope_id: null, participants: [actor], created_by_endpoint_id: null });
    handle.store.submitPrincipalContextCommunication({ workspace_id: workspaceId, context_id: contextId,
      principal_id: "operator:test", type: "message", recipient_endpoint_id: actor, content: { text: "Review the saved work" },
      artefact_version_ids: [], attachment_ingress_ids: [], response_expected: true, idempotency_key: "status-request",
      provenance: { cause_event_id: null, delivery_ids: [], execution_attempt_id: null, node_execution_id: null, scope_execution_id: null },
    }, () => {});
    const [delivery] = handle.store.claimDeliveries("bridge:status", 1, () => {});
    const participantList = await handle.app.inject({ method: "GET",
      url: `/v1/contexts?participant=${encodeURIComponent(actor)}&workspace_id=${encodeURIComponent(workspaceId)}` });
    expect(participantList.statusCode).toBe(200);
    expect(participantList.json().contexts.find((row: any) => row.context_id === contextId)?.delivery_summary)
      .toEqual({ active_count: 1, latest_state: "delivered_to_bridge" });
    handle.store.cancelRuntimeDelivery({ workspace_id: workspaceId, delivery_id: delivery.delivery_id,
      principal_id: "operator:test", invocation_id: "status-stop" }, () => {});
    const workspaceList = await handle.app.inject({ method: "GET", url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/contexts` });
    expect(workspaceList.statusCode).toBe(200);
    expect(workspaceList.json().contexts.find((row: any) => row.context_id === contextId)?.delivery_summary)
      .toEqual({ active_count: 0, latest_state: "cancelled" });
  });
});
