import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { defaultConfig, type LocalConfig } from "../config.js";
import { createBusServer } from "../server.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

async function makeServer(): Promise<{ handle: ServerHandle; tmp: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-context-scope-assignment-"));
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
  contextId?: string;
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
      ...(input.contextId ? { context_id: input.contextId } : {}),
      scope_id: input.scopeId ?? null,
      content: { text: input.text },
      response: { expected: false }
    }
  });
  expect(emitted.statusCode).toBe(202);
  return emitted.json().event;
}

async function assignScope(handle: ServerHandle, input: {
  workspaceId: string;
  contextId: string;
  scopeId: string;
  assignedBy?: string;
  reason?: string;
}) {
  return handle.app.inject({
    method: "POST",
    url: `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/contexts/${encodeURIComponent(input.contextId)}/assign-scope`,
    payload: {
      scope_id: input.scopeId,
      ...(input.assignedBy ? { assigned_by: input.assignedBy } : {}),
      ...(input.reason ? { reason: input.reason } : {})
    }
  });
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 2_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

describe("Context Scope assignment", () => {
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

  it("intentionally assigns a Workspace-level actor Context to a real Scope without changing Context identity", async () => {
    const workspaceId = await registerWorkspace(handle, tmp, "workspace-a");
    const operator = await registerEndpoint(handle, workspaceId, "operator");
    const floe = await registerEndpoint(handle, workspaceId, "floe");
    await createScope(handle, workspaceId, "research");

    const unscoped = await emitMessage(handle, {
      workspaceId,
      source: operator,
      target: floe,
      text: "workspace-level before assignment"
    });

    const beforeProjection = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/research/projection`
    });
    expect(beforeProjection.statusCode).toBe(200);
    expect(beforeProjection.json().projection.refs.contexts).toHaveLength(0);

    const assigned = await assignScope(handle, {
      workspaceId,
      contextId: unscoped.context_id,
      scopeId: "research",
      assignedBy: operator,
      reason: "promote direct conversation into operational work"
    });

    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toMatchObject({
      ok: true,
      context: {
        context_id: unscoped.context_id,
        workspace_id: workspaceId,
        scope_id: "research",
        participants: expect.arrayContaining([operator, floe])
      }
    });

    const unscopedAfter = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/contexts?scope=unscoped`
    });
    expect(unscopedAfter.statusCode).toBe(200);
    expect(unscopedAfter.json().contexts).toEqual([]);

    const projectionAfter = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/research/projection`
    });
    expect(projectionAfter.statusCode).toBe(200);
    expect(projectionAfter.json().projection.refs.contexts).toEqual([
      expect.objectContaining({
        context_id: unscoped.context_id,
        scope_id: "research"
      })
    ]);
  });

  it("records an audit Event and derives future Event Scope from the assigned Context", async () => {
    const workspaceId = await registerWorkspace(handle, tmp, "workspace-a");
    const operator = await registerEndpoint(handle, workspaceId, "operator");
    const floe = await registerEndpoint(handle, workspaceId, "floe");
    await createScope(handle, workspaceId, "research");

    const unscoped = await emitMessage(handle, {
      workspaceId,
      source: operator,
      target: floe,
      text: "workspace-level before assignment"
    });

    const assigned = await assignScope(handle, {
      workspaceId,
      contextId: unscoped.context_id,
      scopeId: "research",
      assignedBy: operator,
      reason: "promote direct conversation into operational work"
    });

    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().audit_event).toMatchObject({
      type: "context.scope_assigned",
      workspace_id: workspaceId,
      context_id: unscoped.context_id,
      scope_id: "research",
      source_endpoint_id: null,
      destination_json: { kind: "context", context_id: unscoped.context_id },
      metadata: {
        previous_scope_id: null,
        scope_id: "research",
        assigned_by: operator,
        reason: "promote direct conversation into operational work"
      }
    });

    const followUp = await emitMessage(handle, {
      workspaceId,
      source: operator,
      target: floe,
      contextId: unscoped.context_id,
      text: "follow-up after assignment"
    });

    expect(followUp.scope_id).toBe("research");

    const events = await handle.app.inject({
      method: "GET",
      url: `/v1/contexts/${encodeURIComponent(unscoped.context_id)}/events?limit=10`
    });
    expect(events.statusCode).toBe(200);
    expect(events.json().events).toEqual([
      expect.objectContaining({
        event_id: unscoped.event_id,
        type: "message",
        scope_id: null
      }),
      expect.objectContaining({
        type: "context.scope_assigned",
        scope_id: "research"
      }),
      expect.objectContaining({
        event_id: followUp.event_id,
        type: "message",
        scope_id: "research"
      })
    ]);
  });

  it("lets scoped operational Pulse events derive Scope from the assigned Context", async () => {
    const workspaceId = await registerWorkspace(handle, tmp, "workspace-a");
    const operator = await registerEndpoint(handle, workspaceId, "operator");
    const floe = await registerEndpoint(handle, workspaceId, "floe");
    await createScope(handle, workspaceId, "research");

    const unscoped = await emitMessage(handle, {
      workspaceId,
      source: operator,
      target: floe,
      text: "workspace-level before assignment"
    });

    const assigned = await assignScope(handle, {
      workspaceId,
      contextId: unscoped.context_id,
      scopeId: "research"
    });
    expect(assigned.statusCode).toBe(200);

    const pulseId = `pulse-assigned-context-${Date.now()}`;
    const pulse = await handle.app.inject({
      method: "POST",
      url: "/v1/pulses",
      payload: {
        pulse_id: pulseId,
        workspace_id: workspaceId,
        persistence: "local",
        scope_id: "research",
        trigger: { type: "once", at: new Date(Date.now() + 30).toISOString() },
        event: {
          type: "pulse.fired",
          content: { text: "Render in assigned context." }
        },
        subscribers: [{ kind: "context", context_id: unscoped.context_id }]
      }
    });
    expect(pulse.statusCode).toBe(201);

    const pulseEvent = await waitFor(async () => {
      const res = await handle.app.inject({
        method: "GET",
        url: `/v1/contexts/${encodeURIComponent(unscoped.context_id)}/events?limit=20`
      });
      const events = res.json().events as any[];
      return events.find((event) => event.type === "pulse.fired" && event.metadata?.pulse_id === pulseId) ?? null;
    });

    expect(pulseEvent).toMatchObject({
      context_id: unscoped.context_id,
      scope_id: "research",
      destination_json: { kind: "context", context_id: unscoped.context_id }
    });
  });

  it("fails invalid assignment attempts clearly without inserting assignment audit Events", async () => {
    const workspaceId = await registerWorkspace(handle, tmp, "workspace-a");
    const otherWorkspaceId = await registerWorkspace(handle, tmp, "workspace-b");
    const operator = await registerEndpoint(handle, workspaceId, "operator");
    const floe = await registerEndpoint(handle, workspaceId, "floe");
    await createScope(handle, workspaceId, "research");
    await createScope(handle, otherWorkspaceId, "research");

    const unscoped = await emitMessage(handle, {
      workspaceId,
      source: operator,
      target: floe,
      text: "workspace-level before assignment"
    });
    const alreadyScoped = await emitMessage(handle, {
      workspaceId,
      source: operator,
      target: floe,
      scopeId: "research",
      text: "already scoped"
    });
    const orphanId = "ctx_orphan";
    handle.store.db.prepare(`
      INSERT INTO contexts (context_id, workspace_id, scope_id, parent_context_id, created_by_endpoint_id, created_at)
      VALUES (?, ?, NULL, NULL, NULL, ?)
    `).run(orphanId, workspaceId, new Date().toISOString());

    const missingScope = await assignScope(handle, {
      workspaceId,
      contextId: unscoped.context_id,
      scopeId: "missing"
    });
    expect(missingScope.statusCode).toBe(404);
    expect(missingScope.json()).toMatchObject({
      ok: false,
      error: "scope_not_found",
      workspace_id: workspaceId,
      scope_id: "missing"
    });

    const wrongWorkspace = await assignScope(handle, {
      workspaceId: otherWorkspaceId,
      contextId: unscoped.context_id,
      scopeId: "research"
    });
    expect(wrongWorkspace.statusCode).toBe(404);
    expect(wrongWorkspace.json()).toMatchObject({
      ok: false,
      error: "context_not_found",
      workspace_id: otherWorkspaceId,
      context_id: unscoped.context_id
    });

    const scopedAgain = await assignScope(handle, {
      workspaceId,
      contextId: alreadyScoped.context_id,
      scopeId: "research"
    });
    expect(scopedAgain.statusCode).toBe(409);
    expect(scopedAgain.json()).toMatchObject({
      ok: false,
      error: "context_scope_assignment_invalid",
      reason: "context_already_scoped"
    });

    const orphan = await assignScope(handle, {
      workspaceId,
      contextId: orphanId,
      scopeId: "research"
    });
    expect(orphan.statusCode).toBe(409);
    expect(orphan.json()).toMatchObject({
      ok: false,
      error: "context_scope_assignment_invalid",
      reason: "orphan_context"
    });

    const contextAfterFailures = await handle.app.inject({
      method: "GET",
      url: `/v1/contexts/${encodeURIComponent(unscoped.context_id)}`
    });
    expect(contextAfterFailures.statusCode).toBe(200);
    expect(contextAfterFailures.json().scope_id).toBeNull();

    const eventsAfterFailures = await handle.app.inject({
      method: "GET",
      url: `/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&limit=20`
    });
    expect(eventsAfterFailures.statusCode).toBe(200);
    expect(eventsAfterFailures.json().events.map((event: any) => event.type)).not.toContain("context.scope_assigned");
  });
});
