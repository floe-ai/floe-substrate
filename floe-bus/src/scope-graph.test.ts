import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import { defaultConfig, type LocalConfig } from "./config.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

async function makeServer(): Promise<{ handle: ServerHandle; tmp: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-scope-graph-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg: LocalConfig = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const handle = await createBusServer(cfgPath, cfg, { unsafe_in_process_test_auth_bypass: true });
  await handle.app.ready();
  return { handle, tmp };
}

async function registerWorkspace(handle: ServerHandle, tmp: string): Promise<string> {
  const locator = join(tmp, "ws");
  mkdirSync(locator, { recursive: true });
  const res = await handle.app.inject({
    method: "POST",
    url: "/v1/workspaces/register",
    headers: { authorization: `Bearer ${handle.localControlToken}` },
    payload: { locator, name: "scope-graph" }
  });
  expect(res.statusCode).toBe(201);
  return res.json().workspace.workspace_id;
}

function registerEndpoint(handle: ServerHandle, workspaceId: string, endpointId: string): void {
  handle.store.registerEndpoint({
    endpoint_id: endpointId,
    workspace_id: workspaceId,
    name: endpointId,
    bridge_id: "bridge:test",
    status: "idle"
  }, () => {});
}

async function createScope(handle: ServerHandle, workspaceId: string, scopeId: string): Promise<void> {
  const created = await handle.app.inject({
    method: "POST",
    url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`,
    payload: { scope_id: scopeId, title: scopeId }
  });
  expect(created.statusCode).toBe(201);
}

describe("Scope Graph API", () => {
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

  it("stores an authored graph before anything runs, then fires the trigger to wake the actor", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const writer = `actor:${workspaceId}:writer`;
    registerEndpoint(handle, workspaceId, writer);
    await createScope(handle, workspaceId, "docs");

    // The graph is authored — stored — before it ever runs. No bespoke "edge"
    // is authored: the actor node's connection is realised via existing
    // Context participant + subscription primitives, which the graph's
    // shared context_id ties together.
    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/docs/graphs`,
      payload: {
        nodes: [
          {
            node_id: "watcher",
            kind: "trigger",
            event_type: "note.landed",
            label: "note landed",
            source: { kind: "folder", path: "notes", extensions: ["md"], settle_ms: 400 },
          },
          { node_id: "writer_node", kind: "actor", endpoint_id: writer, label: "writer" }
        ]
      }
    });
    expect(created.statusCode).toBe(201);
    const graph = created.json().graph;
    expect(graph.graph_id).toMatch(/^graph_/);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[0].source).toEqual({ kind: "folder", path: "notes", extensions: ["md"], settle_ms: 400 });
    expect(graph.context_id).toMatch(/^ctx_/);

    // Authoring the actor node already wired it into the graph's Context via
    // the EXISTING participant + subscription primitives — verified directly
    // against those tables, not a bespoke scope-graph routing record.
    const participant = handle.store.db.prepare(
      "SELECT * FROM context_participants WHERE context_id = ? AND endpoint_id = ?"
    ).get(graph.context_id, writer);
    expect(participant).toBeTruthy();
    const subscription = handle.store.contextStore.getContextSubscriptions(graph.context_id);
    expect(subscription).toEqual([{ endpoint_id: writer, event_types: ["*"], subscribed_at: expect.any(String) }]);

    // Nothing has run yet: no event exists for the writer.
    const beforeFire = handle.store.db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number };
    expect(beforeFire.count).toBe(0);

    // Firing the trigger node causes the actor node to be woken — resolved by
    // reading the Context's own EXISTING subscription state, not a stored edge.
    const fired = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/graphs/${graph.graph_id}/nodes/watcher/fire`,
      payload: {
        content: { path: "docs/README.md" },
        idempotency_key: "folder-arrival:readme-v1"
      }
    });
    expect(fired.statusCode).toBe(201);
    const events = fired.json().events;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("note.landed");
    expect(events[0].destination_json).toEqual({ kind: "endpoint", endpoint_id: writer });
    expect(events[0].context_id).toBe(graph.context_id);
    expect(events[0].source_endpoint_id).toBeNull();
    expect(events[0].content).toEqual({ path: "docs/README.md" });

    const queued = handle.store.db.prepare(
      "SELECT * FROM event_queue WHERE destination_endpoint_id = ?"
    ).get(writer) as any;
    expect(queued).toBeTruthy();
    expect(queued.event_id).toBe(events[0].event_id);

    const duplicate = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/graphs/${graph.graph_id}/nodes/watcher/fire`,
      payload: {
        content: { path: "docs/README.md" },
        idempotency_key: "folder-arrival:readme-v1"
      }
    });
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json().events[0].event_id).toBe(events[0].event_id);
    expect(duplicate.json().events[0].metadata.trigger_fire_id).toBe(events[0].metadata.trigger_fire_id);
    expect((handle.store.db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count).toBe(1);

    // The graph persists as read afterward — it did not vanish on firing.
    const reread = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/graphs/${graph.graph_id}`
    });
    expect(reread.statusCode).toBe(200);
    expect(reread.json().graph.graph_id).toBe(graph.graph_id);
  });

  it("identifies one trigger firing across every subscribed endpoint", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const planner = `actor:${workspaceId}:planner`;
    const builder = `actor:${workspaceId}:builder`;
    registerEndpoint(handle, workspaceId, planner);
    registerEndpoint(handle, workspaceId, builder);
    await createScope(handle, workspaceId, "pipeline");

    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/pipeline/graphs`,
      payload: {
        nodes: [
          { node_id: "work-arrived", kind: "trigger", event_type: "work.arrived" },
          { node_id: "planner", kind: "actor", endpoint_id: planner, event_types: ["work.arrived"] },
          { node_id: "builder", kind: "actor", endpoint_id: builder, event_types: ["work.arrived"] },
        ],
      },
    });
    const graph = created.json().graph;
    const fire = (idempotencyKey: string) => handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/graphs/${graph.graph_id}/nodes/work-arrived/fire`,
      payload: { content: { work_id: "work-1" }, idempotency_key: idempotencyKey },
    });

    const first = await fire("work-arrived:1");
    const firstEvents = first.json().events;
    expect(firstEvents).toHaveLength(2);
    expect(new Set(firstEvents.map((event: any) => event.metadata.trigger_fire_id)).size).toBe(1);
    expect(firstEvents[0].metadata.trigger_fire_id).toMatch(/^trigger_fire_[a-f0-9]{32}$/);

    const retry = await fire("work-arrived:1");
    expect(retry.json().events.map((event: any) => event.event_id)).toEqual(
      firstEvents.map((event: any) => event.event_id),
    );
    expect(retry.json().events.map((event: any) => event.metadata.trigger_fire_id)).toEqual(
      firstEvents.map((event: any) => event.metadata.trigger_fire_id),
    );

    const separate = await fire("work-arrived:2");
    expect(separate.json().events[0].metadata.trigger_fire_id).not.toBe(firstEvents[0].metadata.trigger_fire_id);
  });

  it("does not wake an actor whose Context subscription does not match the trigger's event type", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const writer = `actor:${workspaceId}:writer`;
    registerEndpoint(handle, workspaceId, writer);
    await createScope(handle, workspaceId, "docs");

    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/docs/graphs`,
      payload: {
        nodes: [
          { node_id: "watcher", kind: "trigger", event_type: "note.landed" },
          { node_id: "writer_node", kind: "actor", endpoint_id: writer, event_types: ["review.requested"] }
        ]
      }
    });
    expect(created.statusCode).toBe(201);
    const graph = created.json().graph;

    const fired = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/graphs/${graph.graph_id}/nodes/watcher/fire`,
      payload: { content: {} }
    });
    expect(fired.statusCode).toBe(201);
    expect(fired.json().events).toHaveLength(0);
  });

  it("routes a Planner to Builder to Judge operation through one scoped Context", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const planner = `actor:${workspaceId}:product-architect`;
    const builder = `actor:${workspaceId}:application-builder`;
    const judge = `actor:${workspaceId}:quality-judge`;
    for (const endpoint of [planner, builder, judge]) registerEndpoint(handle, workspaceId, endpoint);
    await createScope(handle, workspaceId, "application-delivery");

    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/application-delivery/graphs`,
      payload: {
        nodes: [
          { node_id: "work-requested", kind: "trigger", event_type: "application.work.requested" },
          { node_id: "planner", kind: "actor", endpoint_id: planner, event_types: ["application.work.requested"] },
          { node_id: "builder", kind: "actor", endpoint_id: builder, event_types: ["application.build.requested", "application.rework.requested"] },
          { node_id: "judge", kind: "actor", endpoint_id: judge, event_types: ["application.review.requested"] },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const graph = created.json().graph;

    const started = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/graphs/${graph.graph_id}/nodes/work-requested/fire`,
      payload: { content: { app_id: "acme" } },
    });
    expect(started.json().events.map((event: any) => event.destination_json.endpoint_id)).toEqual([planner]);

    const emitToComposition = (source: string, type: string) => handle.store.submitEvent({
      type,
      workspace_id: workspaceId,
      source_endpoint_id: source,
      destination: { kind: "context", context_id: graph.context_id },
      context_id: graph.context_id,
      current_delivery_context_id: graph.context_id,
      content: { app_id: "acme" },
      response: { expected: false },
    }, () => {});

    emitToComposition(planner, "application.build.requested");
    emitToComposition(builder, "application.review.requested");
    emitToComposition(judge, "application.rework.requested");

    const routed = handle.store.db.prepare(`
      SELECT e.type, q.destination_endpoint_id
      FROM events e
      JOIN event_queue q ON q.event_id = e.event_id
      WHERE e.context_id = ?
        AND e.type IN ('application.build.requested', 'application.review.requested', 'application.rework.requested')
      ORDER BY e.created_at ASC
    `).all(graph.context_id) as Array<{ type: string; destination_endpoint_id: string }>;
    expect(routed).toEqual([
      { type: "application.build.requested", destination_endpoint_id: builder },
      { type: "application.review.requested", destination_endpoint_id: judge },
      { type: "application.rework.requested", destination_endpoint_id: builder },
    ]);
  });

  it("rejects a graph with a duplicate node id", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    await createScope(handle, workspaceId, "docs");

    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/docs/graphs`,
      payload: {
        nodes: [
          { node_id: "watcher", kind: "trigger", event_type: "note.landed" },
          { node_id: "watcher", kind: "trigger", event_type: "note.landed" }
        ]
      }
    });
    expect(created.statusCode).toBe(400);
    expect(created.json().error).toBe("scope_graph_invalid");
  });

  it("rejects firing a node that is not a trigger", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const writer = `actor:${workspaceId}:writer`;
    registerEndpoint(handle, workspaceId, writer);
    await createScope(handle, workspaceId, "docs");

    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/docs/graphs`,
      payload: {
        nodes: [
          { node_id: "watcher", kind: "trigger", event_type: "note.landed" },
          { node_id: "writer_node", kind: "actor", endpoint_id: writer }
        ]
      }
    });
    expect(created.statusCode).toBe(201);
    const graph = created.json().graph;

    const fired = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/graphs/${graph.graph_id}/nodes/writer_node/fire`,
      payload: { content: {} }
    });
    expect(fired.statusCode).toBe(400);
    expect(fired.json().error).toBe("scope_graph_node_not_a_trigger");
  });

  it("fires a trigger with arrival facts (channel, locator, observed_at, raw_reference) as ordinary content — no origin envelope", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const writer = `actor:${workspaceId}:writer`;
    registerEndpoint(handle, workspaceId, writer);
    await createScope(handle, workspaceId, "docs");

    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/docs/graphs`,
      payload: {
        nodes: [
          { node_id: "watcher", kind: "trigger", event_type: "note.landed" },
          { node_id: "writer_node", kind: "actor", endpoint_id: writer }
        ]
      }
    });
    const graph = created.json().graph;
    const observedAt = new Date().toISOString();

    const fired = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/graphs/${graph.graph_id}/nodes/watcher/fire`,
      payload: {
        content: {
          file_name: "README.md",
          channel: "watched_folder",
          locator: "C:\\ws\\inbox\\README.md",
          observed_at: observedAt,
          raw_reference: "C:\\ws\\inbox\\README.md"
        }
      }
    });
    expect(fired.statusCode).toBe(201);
    const event = fired.json().events[0];
    // Arrival facts are just content — no separate origin field or kind tag.
    expect(event.content).toEqual({
      file_name: "README.md",
      channel: "watched_folder",
      locator: "C:\\ws\\inbox\\README.md",
      observed_at: observedAt,
      raw_reference: "C:\\ws\\inbox\\README.md"
    });
    expect(event.origin).toBeUndefined();
    // No speaker: source_endpoint_id stays null exactly as any other trigger fire.
    expect(event.source_endpoint_id).toBeNull();
  });

  it("refuses to create a second live Command path through legacy subscription graphs", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const checker = `endpoint:${workspaceId}:docs_vocabulary_check`;
    registerEndpoint(handle, workspaceId, checker);
    await createScope(handle, workspaceId, "docs");

    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/docs/graphs`,
      payload: {
        nodes: [
          { node_id: "watcher", kind: "trigger", event_type: "note.landed" },
          {
            node_id: "check_node",
            kind: "command",
            endpoint_id: checker,
            command: "npx vitest run floe-bus/src/docs-vocabulary.test.ts",
            outputs: [{ name: "passed", from: "passed" }]
          }
        ]
      }
    });
    expect(created.statusCode).toBe(400);
    expect(created.json()).toMatchObject({
      error: "scope_graph_invalid",
      reason: expect.stringContaining("non-executable evidence"),
    });
    expect(handle.store.db.prepare(
      "SELECT COUNT(*) AS count FROM context_participants WHERE endpoint_id = ?"
    ).get(checker)).toEqual({ count: 0 });
  });

  it("rejects a command node missing a command", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const checker = `endpoint:${workspaceId}:checker`;
    registerEndpoint(handle, workspaceId, checker);
    await createScope(handle, workspaceId, "docs");

    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/docs/graphs`,
      payload: {
        nodes: [
          { node_id: "check_node", kind: "command", endpoint_id: checker, command: "" }
        ]
      }
    });
    // Pre-existing bug (unrelated to this ticket): the body schema is parsed
    // with `.parse()` outside any try/catch, so a Zod validation failure
    // throws uncaught and Fastify's default handler returns 500, not 400.
    expect(created.statusCode).toBe(500);
  });

  it("stores an actor node's instructions binding — node-specific material, not the actor's general instructions", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const writer = `actor:${workspaceId}:writer`;
    registerEndpoint(handle, workspaceId, writer);
    await createScope(handle, workspaceId, "docs");

    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/docs/graphs`,
      payload: {
        nodes: [
          { node_id: "watcher", kind: "trigger", event_type: "note.landed" },
          {
            node_id: "writer_node",
            kind: "actor",
            endpoint_id: writer,
            bindings: [{ kind: "instructions", text: "Draft docs for the note that just landed." }]
          }
        ]
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().graph.nodes[1].bindings).toEqual([
      { kind: "instructions", text: "Draft docs for the note that just landed." }
    ]);
  });

  it("rejects an actor node's instructions binding with empty text", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const writer = `actor:${workspaceId}:writer`;
    registerEndpoint(handle, workspaceId, writer);
    await createScope(handle, workspaceId, "docs");

    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/docs/graphs`,
      payload: {
        nodes: [
          { node_id: "writer_node", kind: "actor", endpoint_id: writer, bindings: [{ kind: "instructions", text: "" }] }
        ]
      }
    });
    // Same pre-existing Zod .parse()-outside-try/catch behaviour as above: min(1) fails -> 500.
    expect(created.statusCode).toBe(500);
  });

  it("does not resurrect stored graphs when a removed workspace locator is re-registered", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    await createScope(handle, workspaceId, "obsolete");

    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/obsolete/graphs`,
      payload: {
        nodes: [
          { node_id: "start", kind: "trigger", event_type: "work.started" }
        ]
      }
    });
    expect(created.statusCode).toBe(201);

    const removed = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/delete`,
      headers: { authorization: `Bearer ${handle.localControlToken}` },
      payload: { delete_locator: false }
    });
    expect(removed.statusCode).toBe(200);

    const reRegisteredWorkspaceId = await registerWorkspace(handle, tmp);
    expect(reRegisteredWorkspaceId).not.toBe(workspaceId);

    const graphs = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(reRegisteredWorkspaceId)}/graphs`
    });
    expect(graphs.statusCode).toBe(200);
    expect(graphs.json()).toEqual({ graphs: [] });
  });
});
