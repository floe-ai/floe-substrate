import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import { defaultConfig, type LocalConfig } from "./config.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

describe("canonical Scope execution read projections", () => {
  let handle: ServerHandle;
  let temp: string;
  let workspaceId: string;
  let sourceContextId: string;
  let otherContextId: string;
  let ingressContextId: string;

  beforeEach(async () => {
    temp = mkdtempSync(join(tmpdir(), "floe-scope-execution-routes-"));
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
      payload: { locator, name: "Execution read proof" },
    });
    workspaceId = registered.json().workspace.workspace_id as string;
    handle.store.createScope({
      workspace_id: workspaceId,
      scope_id: "pipeline",
      title: "Pipeline",
    }, handle.broadcast);
    sourceContextId = createContext("Operator request");
    otherContextId = createContext("Different request");
    ingressContextId = createContext("Pipeline ingress");
    const draft = handle.store.createScopeCompositionDraft({
      workspace_id: workspaceId,
      scope_id: "pipeline",
      content: {
        nodes: [{
          node_id: "ingress",
          kind: "event",
          config: { event_type: "work.requested" },
          context_policy: { mode: "fixed", context_id: ingressContextId },
        }],
        ports: [{
          port_id: "ingress:out",
          node_id: "ingress",
          name: "work",
          direction: "output",
          event_types: ["work.requested"],
        }],
        edges: [],
      },
    }, handle.broadcast);
    handle.store.publishScopeComposition({ revision_id: draft.revision_id }, handle.broadcast);
  });

  afterEach(async () => {
    try { await handle.app.close(); } catch {}
    rmSync(temp, { recursive: true, force: true });
  });

  function createContext(title: string): string {
    return handle.store.contextStore.createContext({
      workspace_id: workspaceId,
      scope_id: "pipeline",
      created_by_endpoint_id: null,
      participants: [],
      title,
    });
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

  function start(causeEventId: string, key: string): string {
    return handle.store.startScopeExecution({
      workspace_id: workspaceId,
      scope_id: "pipeline",
      ingress_node_id: "ingress",
      output_port_id: "ingress:out",
      content: { key },
      cause_event_id: causeEventId,
      idempotency_key: `execution:${key}`,
    }, handle.broadcast).execution.execution_id;
  }

  it("pages current executions and returns one selected canonical projection", async () => {
    const firstId = start(cause(sourceContextId, "first"), "first");
    const secondId = start(cause(otherContextId, "second"), "second");
    const thirdId = start(cause(sourceContextId, "third"), "third");
    handle.store.db.prepare(`UPDATE scope_executions SET created_at = ? WHERE execution_id = ?`)
      .run("2026-09-03T10:00:00.000Z", firstId);
    handle.store.db.prepare(`UPDATE scope_executions SET created_at = ? WHERE execution_id = ?`)
      .run("2026-09-03T11:00:00.000Z", secondId);
    handle.store.db.prepare(`UPDATE scope_executions SET created_at = ? WHERE execution_id = ?`)
      .run("2026-09-03T12:00:00.000Z", thirdId);

    const firstPage = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/pipeline/executions?limit=2`,
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json()).toMatchObject({
      executions: [
        { execution_id: thirdId },
        { execution_id: secondId },
      ],
    });
    expect(firstPage.json().next_cursor).toEqual(expect.any(String));

    const secondPage = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/pipeline/executions?limit=2&before=${encodeURIComponent(firstPage.json().next_cursor)}`,
    });
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json()).toMatchObject({
      executions: [{ execution_id: firstId }],
      next_cursor: null,
    });

    const selected = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scope-executions/${encodeURIComponent(thirdId)}`,
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toMatchObject({
      projection: {
        execution: { execution_id: thirdId },
        revision: {
          routing_mode: "edge",
          nodes: [{ node_id: "ingress" }],
          ports: [{ port_id: "ingress:out" }],
          edges: [],
        },
        node_executions: [{
          node_id: "ingress",
          inputs: [],
          attempts: [],
          publications: [expect.objectContaining({ port_id: "ingress:out", outputs: [] })],
        }],
        traversals: [],
      },
    });
  });

  it("lists only executions caused by exact Events in the selected Context", async () => {
    const fromSelected = start(cause(sourceContextId, "selected"), "selected");
    start(cause(otherContextId, "other"), "other");

    const response = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/contexts/${encodeURIComponent(sourceContextId)}/scope-executions`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      executions: [{
        execution_id: fromSelected,
        cause_event_id: expect.any(String),
      }],
      next_cursor: null,
    });
    expect(response.json().executions[0].root_event_id).not.toBe(response.json().executions[0].cause_event_id);
    expect(handle.store.getScopeExecutionProjection(fromSelected)?.node_executions[0]?.context_id)
      .toBe(ingressContextId);
  });

  it("rejects malformed cursors instead of changing the query meaning", async () => {
    const response = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/pipeline/executions?before=not-a-cursor`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_scope_execution_cursor" });
  });
});
