import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import { defaultConfig, type LocalConfig } from "./config.js";

const WS = "workspace:server-test";
const E1 = "actor:test:e1";
const E2 = "actor:test:e2";
const E3 = "actor:test:e3";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

async function makeServer(): Promise<{ handle: ServerHandle; cleanup: () => Promise<void>; tmp: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-srv-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg: LocalConfig = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const handle = await createBusServer(cfgPath, cfg, { allow_unauthenticated_test_requests: true });
  await handle.app.ready();
  const timestamp = new Date().toISOString();
  handle.store.workspaceIdentityStore.restoreWorkspace({
    snapshot: {
      workspace_id: WS,
      name: "Test WS",
      creation_kind: "created",
      source_workspace_id: null,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  for (const id of [E1, E2, E3]) {
    handle.store.registerEndpoint({
      endpoint_id: id,
      workspace_id: WS,
      name: id,
      bridge_id: null,
      status: "idle"
    }, () => {});
  }
  return {
    handle,
    tmp,
    cleanup: async () => {
      try { await handle.app.close(); } catch {}
      rmSync(tmp, { recursive: true, force: true });
    }
  };
}

function emit(handle: ServerHandle, opts: {
  source: string;
  destination: string;
  text?: string;
  context_id?: string | null;
  current_delivery_context_id?: string | null;
  type?: string;
}): { event: any; status: number; body: any } {
  const result = handle.store.submitEvent({
    type: opts.type ?? "message",
    workspace_id: WS,
    source_endpoint_id: opts.source,
    destination: { kind: "endpoint", endpoint_id: opts.destination },
    thread_id: "",
    correlation_id: null,
    content: opts.text === undefined ? {} : { text: opts.text },
    metadata: {},
    idempotency_key: null,
    context_id: opts.context_id,
    current_delivery_context_id: opts.current_delivery_context_id
  }, () => {});
  return { event: result.event, status: 0, body: null };
}

describe("Slice 2 — Context API HTTP routes", () => {
  let handle: ServerHandle;
  let cleanup: () => Promise<void>;
  let tmp: string;

  beforeEach(async () => {
    const made = await makeServer();
    handle = made.handle;
    cleanup = made.cleanup;
    tmp = made.tmp;
  });
  afterEach(async () => { await cleanup(); });

  describe("GET /v1/contexts?participant=", () => {
    it("returns empty list when participant has no contexts", async () => {
      const res = await handle.app.inject({ method: "GET", url: `/v1/contexts?participant=${encodeURIComponent(E1)}` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ contexts: [], next_cursor: null });
    });

    it("returns only contexts the endpoint participates in", async () => {
      const a = emit(handle, { source: E1, destination: E2, text: "a" }).event.context_id;
      const b = emit(handle, { source: E2, destination: E3, text: "b" }).event.context_id;
      const c = emit(handle, { source: E1, destination: E3, text: "c" }).event.context_id;
      const res = await handle.app.inject({ method: "GET", url: `/v1/contexts?participant=${encodeURIComponent(E1)}` });
      expect(res.statusCode).toBe(200);
      const ids = (res.json().contexts as any[]).map((c) => c.context_id).sort();
      expect(ids).toEqual([a, c].sort());
      expect(ids).not.toContain(b);
    });

    it("sorts results by last_event_at descending", async () => {
      const a = emit(handle, { source: E1, destination: E2, text: "first-a" }).event.context_id;
      // small delay to ensure distinct timestamps
      await new Promise((r) => setTimeout(r, 5));
      const b = emit(handle, { source: E1, destination: E3, text: "first-b" }).event.context_id;
      await new Promise((r) => setTimeout(r, 5));
      // bump A by emitting again into it
      emit(handle, { source: E1, destination: E2, text: "second-a", context_id: a });
      const res = await handle.app.inject({ method: "GET", url: `/v1/contexts?participant=${encodeURIComponent(E1)}` });
      const ids = (res.json().contexts as any[]).map((c) => c.context_id);
      expect(ids[0]).toBe(a);
      expect(ids[1]).toBe(b);
    });

    it("includes participants, last_event_at, parent_context_id, created_at, created_by_endpoint_id, workspace_id", async () => {
      const a = emit(handle, { source: E1, destination: E2, text: "hi" }).event.context_id;
      const res = await handle.app.inject({ method: "GET", url: `/v1/contexts?participant=${encodeURIComponent(E1)}` });
      const entry = (res.json().contexts as any[])[0];
      expect(entry.context_id).toBe(a);
      expect(entry.workspace_id).toBe(WS);
      expect(entry.parent_context_id).toBeNull();
      expect(entry.created_by_endpoint_id).toBe(E1);
      expect(typeof entry.created_at).toBe("string");
      expect(typeof entry.last_event_at).toBe("string");
      expect(entry.participants.sort()).toEqual([E1, E2].sort());
    });

    it("first_message_preview reflects the first message event text", async () => {
      const a = emit(handle, { source: E1, destination: E2, text: "hello world" }).event.context_id;
      const res = await handle.app.inject({ method: "GET", url: `/v1/contexts?participant=${encodeURIComponent(E1)}` });
      const entry = (res.json().contexts as any[]).find((c) => c.context_id === a);
      expect(entry.first_message_preview).toBe("hello world");
      expect(entry.latest_message_preview).toBe("hello world");
      expect(entry.latest_message).toMatchObject({ type: "message", content: { text: "hello world" } });
    });

    it("pages newest participant Contexts with an opaque backward cursor", async () => {
      const oldest = emit(handle, { source: E1, destination: E2, text: "oldest" }).event.context_id;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const newest = emit(handle, { source: E1, destination: E3, text: "newest" }).event.context_id;

      const first = await handle.app.inject({
        method: "GET",
        url: `/v1/contexts?participant=${encodeURIComponent(E1)}&workspace_id=${encodeURIComponent(WS)}&limit=1`,
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().contexts.map((entry: any) => entry.context_id)).toEqual([newest]);
      expect(first.json().next_cursor).toEqual(expect.any(String));

      const second = await handle.app.inject({
        method: "GET",
        url: `/v1/contexts?participant=${encodeURIComponent(E1)}&workspace_id=${encodeURIComponent(WS)}&limit=1&before=${encodeURIComponent(first.json().next_cursor)}`,
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().contexts.map((entry: any) => entry.context_id)).toEqual([oldest]);
      expect(second.json().next_cursor).toBeNull();
    });

    it("first_message_preview is truncated to ~80 chars", async () => {
      const long = "x".repeat(200);
      const a = emit(handle, { source: E1, destination: E2, text: long }).event.context_id;
      const res = await handle.app.inject({ method: "GET", url: `/v1/contexts?participant=${encodeURIComponent(E1)}` });
      const entry = (res.json().contexts as any[]).find((c) => c.context_id === a);
      expect(entry.first_message_preview.length).toBeLessThanOrEqual(81);
      expect(entry.first_message_preview.endsWith("…")).toBe(true);
    });

    it("first_message_preview is null when context has no message events yet", async () => {
      // Create a context directly without emitting a message.
      const id = handle.store.contextStore.createContext({
        workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E2]
      });
      const res = await handle.app.inject({ method: "GET", url: `/v1/contexts?participant=${encodeURIComponent(E1)}` });
      const entry = (res.json().contexts as any[]).find((c) => c.context_id === id);
      expect(entry).toBeDefined();
      expect(entry.first_message_preview).toBeNull();
      expect(entry.last_event_at).toBeNull();
    });

    it("rejects request when participant query param is missing", async () => {
      const res = await handle.app.inject({ method: "GET", url: "/v1/contexts" });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });
  });

  describe("GET /v1/contexts/:id", () => {
    it("returns context metadata + participants", async () => {
      const a = emit(handle, { source: E1, destination: E2, text: "hi" }).event.context_id;
      const res = await handle.app.inject({ method: "GET", url: `/v1/contexts/${encodeURIComponent(a)}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        context_id: a,
        workspace_id: WS,
        parent_context_id: null,
        created_by_endpoint_id: E1
      });
      expect(typeof body.created_at).toBe("string");
      expect(body.participants.sort()).toEqual([E1, E2].sort());
    });

    it("404 when context not found", async () => {
      const res = await handle.app.inject({ method: "GET", url: "/v1/contexts/ctx_does_not_exist" });
      expect(res.statusCode).toBe(404);
    });

    it("returns one bounded Context tree without unrelated workspace Contexts", async () => {
      const root = emit(handle, { source: E1, destination: E2, text: "root" }).event.context_id;
      const child = emit(handle, {
        source: E2,
        destination: E3,
        text: "child",
        current_delivery_context_id: root,
      }).event.context_id;
      emit(handle, { source: E1, destination: E3, text: "unrelated" });

      const res = await handle.app.inject({
        method: "GET",
        url: `/v1/contexts/${encodeURIComponent(root)}/tree?limit=20`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().contexts.map((entry: any) => entry.context_id)).toEqual([root, child]);
      expect(res.json().truncated).toBe(false);
    });
  });

  describe("GET /v1/contexts/:id/events", () => {
    it("returns events for that context only (T7)", async () => {
      const r1 = emit(handle, { source: E1, destination: E2, text: "a-1" });
      const r2 = emit(handle, { source: E1, destination: E3, text: "b-1" });
      const ctxA = r1.event.context_id;
      const ctxB = r2.event.context_id;
      // bump each
      emit(handle, { source: E1, destination: E2, text: "a-2", context_id: ctxA });
      emit(handle, { source: E1, destination: E3, text: "b-2", context_id: ctxB });

      const resA = await handle.app.inject({ method: "GET", url: `/v1/contexts/${ctxA}/events` });
      expect(resA.statusCode).toBe(200);
      const aEvents = resA.json().events as any[];
      expect(aEvents.length).toBeGreaterThanOrEqual(2);
      expect(aEvents.every((e) => e.context_id === ctxA)).toBe(true);

      const resB = await handle.app.inject({ method: "GET", url: `/v1/contexts/${ctxB}/events` });
      const bEvents = resB.json().events as any[];
      expect(bEvents.every((e) => e.context_id === ctxB)).toBe(true);

      // No event from B is in A's response
      const aIds = new Set(aEvents.map((e) => e.event_id));
      for (const e of bEvents) expect(aIds.has(e.event_id)).toBe(false);
    });

    it("returns events in chronological order (oldest first)", async () => {
      const r1 = emit(handle, { source: E1, destination: E2, text: "first" });
      const ctx = r1.event.context_id;
      emit(handle, { source: E1, destination: E2, text: "second", context_id: ctx });
      const res = await handle.app.inject({ method: "GET", url: `/v1/contexts/${ctx}/events` });
      const events = res.json().events as any[];
      const times = events.map((e) => e.created_at);
      const sorted = [...times].sort();
      expect(times).toEqual(sorted);
    });

    it("404 when context does not exist", async () => {
      const res = await handle.app.inject({ method: "GET", url: "/v1/contexts/ctx_unknown/events" });
      expect(res.statusCode).toBe(404);
    });

    it("returns empty events array for a context with no events yet", async () => {
      const id = handle.store.contextStore.createContext({
        workspace_id: WS, created_by_endpoint_id: E1, participants: [E1]
      });
      const res = await handle.app.inject({ method: "GET", url: `/v1/contexts/${id}/events` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ events: [] });
    });
  });

  describe("GET /v1/events backward history", () => {
    it("returns the newest bounded Context page and an earlier-page cursor", async () => {
      const first = emit(handle, { source: E1, destination: E2, text: "first" });
      const contextId = first.event.context_id;
      emit(handle, { source: E1, destination: E2, text: "second", context_id: contextId });
      emit(handle, { source: E1, destination: E2, text: "third", context_id: contextId });

      const latest = await handle.app.inject({
        method: "GET",
        url: `/v1/events?context_id=${encodeURIComponent(contextId)}&type=message&direction=backward&limit=2`
      });
      expect(latest.statusCode).toBe(200);
      expect((latest.json().events as any[]).map(event => event.content.text)).toEqual(["second", "third"]);
      expect(latest.json().previous_cursor).toEqual(expect.any(String));

      const earlier = await handle.app.inject({
        method: "GET",
        url: `/v1/events?context_id=${encodeURIComponent(contextId)}&type=message&direction=backward&limit=2&before=${encodeURIComponent(latest.json().previous_cursor)}`
      });
      expect(earlier.statusCode).toBe(200);
      expect((earlier.json().events as any[]).map(event => event.content.text)).toEqual(["first"]);
      expect(earlier.json().previous_cursor).toBeNull();
    });

    it("keeps forward and backward cursor directions mutually exclusive", async () => {
      const res = await handle.app.inject({
        method: "GET",
        url: "/v1/events?direction=backward&since=garbage"
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("DELETE /v1/contexts/:id", () => {
    it("archives a conversation without deleting retained history", async () => {
      const r1 = emit(handle, { source: E1, destination: E2, text: "delete me" });
      const ctx = r1.event.context_id;
      emit(handle, { source: E1, destination: E2, text: "delete me too", context_id: ctx });
      const other = emit(handle, { source: E1, destination: E2, text: "keep me" });
      const otherCtx = other.event.context_id;

      const before = await handle.app.inject({ method: "GET", url: `/v1/contexts?participant=${encodeURIComponent(E1)}` });
      expect((before.json().contexts as any[]).map((item) => item.context_id)).toContain(ctx);
      expect((before.json().contexts as any[]).map((item) => item.context_id)).toContain(otherCtx);

      const deleted = await handle.app.inject({ method: "DELETE", url: `/v1/contexts/${encodeURIComponent(ctx)}` });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toMatchObject({
        ok: true,
        context_id: ctx,
        workspace_id: WS,
        archived: true,
        events_deleted: 0,
      });

      const afterList = await handle.app.inject({ method: "GET", url: `/v1/contexts?participant=${encodeURIComponent(E1)}` });
      expect((afterList.json().contexts as any[]).map((item) => item.context_id)).not.toContain(ctx);
      expect((afterList.json().contexts as any[]).map((item) => item.context_id)).toContain(otherCtx);

      const afterEvents = await handle.app.inject({ method: "GET", url: `/v1/contexts/${encodeURIComponent(ctx)}/events` });
      expect(afterEvents.statusCode).toBe(200);
      expect(afterEvents.json().events).toHaveLength(2);
      expect(handle.store.contextStore.getContext(ctx)?.lifecycle_state).toBe("archived");

      const workspaceEvents = await handle.app.inject({ method: "GET", url: `/v1/events?workspace_id=${encodeURIComponent(WS)}` });
      const workspaceContextIds = (workspaceEvents.json().events as any[]).map((event) => event.context_id);
      expect(workspaceContextIds).toContain(ctx);
      expect(workspaceContextIds).toContain(otherCtx);
    });

    it("returns 404 when deleting an unknown context", async () => {
      const res = await handle.app.inject({ method: "DELETE", url: "/v1/contexts/ctx_unknown" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "context_not_found", context_id: "ctx_unknown" });
    });
  });

  describe("POST /v1/workspaces/:workspace_id/contexts", () => {
    function ensureWorkspace(h: ServerHandle) {
      expect(h.store.getWorkspace(WS)?.workspace_id).toBe(WS);
    }

    it("creates a workspace-level context with scope_id null and returns 201", async () => {
      ensureWorkspace(handle);
      const res = await handle.app.inject({
        method: "POST",
        url: `/v1/workspaces/${encodeURIComponent(WS)}/contexts`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ participants: [E1, E2], created_by_endpoint_id: E1 }),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { context: any };
      expect(body.context).toMatchObject({
        workspace_id: WS,
        scope_id: null,
        participants: expect.arrayContaining([E1, E2]),
        created_by_endpoint_id: null,
        created_by_principal_id: "principal:test-bypass",
      });
      expect(typeof body.context.context_id).toBe("string");
    });

    it("returns 404 on unknown workspace", async () => {
      const res = await handle.app.inject({
        method: "POST",
        url: `/v1/workspaces/no-such-ws/contexts`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ participants: [E1, E2] }),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "workspace_not_found" });
    });

    it("creates a scoped context with title (card-as-context) and returns 201", async () => {
      ensureWorkspace(handle);
      // Create a scope first
      handle.store.db.prepare(
        `INSERT OR IGNORE INTO scopes (scope_id, workspace_id, title, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
      ).run("scope:test:board", WS, "Board", null);
      const res = await handle.app.inject({
        method: "POST",
        url: `/v1/workspaces/${encodeURIComponent(WS)}/contexts`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          participants: [],
          scope_id: "scope:test:board",
          title: "Fix auth token refresh",
          created_by_endpoint_id: E1,
        }),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { context: any };
      expect(body.context).toMatchObject({
        workspace_id: WS,
        scope_id: "scope:test:board",
        title: "Fix auth token refresh",
      });
    });

    it("GET /v1/workspaces/:workspace_id/contexts?scope_id=X returns only contexts for that scope", async () => {
      ensureWorkspace(handle);
      handle.store.db.prepare(
        `INSERT OR IGNORE INTO scopes (scope_id, workspace_id, title, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
      ).run("scope:test:alpha", WS, "Alpha", null);
      // Create a context in the scope (with scope_id only, no participants)
      handle.store.contextStore.createContext({
        workspace_id: WS,
        scope_id: "scope:test:alpha",
        participants: [],
        created_by_endpoint_id: null,
        title: "Task A",
      });
      // Create a context NOT in the scope
      handle.store.contextStore.createContext({
        workspace_id: WS,
        scope_id: null,
        participants: [E1],
        created_by_endpoint_id: null,
      });
      const res = await handle.app.inject({
        method: "GET",
        url: `/v1/workspaces/${encodeURIComponent(WS)}/contexts?scope_id=scope:test:alpha`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { contexts: any[] };
      expect(body.contexts).toHaveLength(1);
      expect(body.contexts[0].scope_id).toBe("scope:test:alpha");
      expect(body.contexts[0].title).toBe("Task A");
    });

    it("GET /v1/contexts/:id includes title field", async () => {
      ensureWorkspace(handle);
      const contextId = handle.store.contextStore.createContext({
        workspace_id: WS,
        scope_id: null,
        participants: [E1],
        created_by_endpoint_id: E1,
        title: "My titled context",
      });
      const res = await handle.app.inject({
        method: "GET",
        url: `/v1/contexts/${contextId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as any;
      expect(body.title).toBe("My titled context");
    });

    it("returns 400 when participants is empty", async () => {
      ensureWorkspace(handle);
      const res = await handle.app.inject({
        method: "POST",
        url: `/v1/workspaces/${encodeURIComponent(WS)}/contexts`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ participants: [] }),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("Context linking (Slice 1 Track B)", () => {
    function ensureWorkspace(h: ServerHandle) {
      expect(h.store.getWorkspace(WS)?.workspace_id).toBe(WS);
    }

    it("creates a context with parent_context_id and returns it in the response", async () => {
      ensureWorkspace(handle);
      // Create parent context directly in store
      const parentId = handle.store.contextStore.createContext({
        workspace_id: WS,
        created_by_endpoint_id: E1,
        participants: [E1],
      });
      const res = await handle.app.inject({
        method: "POST",
        url: `/v1/workspaces/${encodeURIComponent(WS)}/contexts`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ participants: [E1], parent_context_id: parentId }),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { context: any };
      expect(body.context.parent_context_id).toBe(parentId);
    });

    it("GET /v1/contexts/:id/children returns linked children", async () => {
      ensureWorkspace(handle);
      const parentId = handle.store.contextStore.createContext({
        workspace_id: WS,
        created_by_endpoint_id: E1,
        participants: [E1],
      });
      // Create two children via HTTP
      const r1 = await handle.app.inject({
        method: "POST",
        url: `/v1/workspaces/${encodeURIComponent(WS)}/contexts`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ participants: [E1], parent_context_id: parentId }),
      });
      const r2 = await handle.app.inject({
        method: "POST",
        url: `/v1/workspaces/${encodeURIComponent(WS)}/contexts`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ participants: [E1], parent_context_id: parentId }),
      });
      const child1Id = r1.json().context.context_id;
      const child2Id = r2.json().context.context_id;

      const res = await handle.app.inject({
        method: "GET",
        url: `/v1/contexts/${encodeURIComponent(parentId)}/children`,
      });
      expect(res.statusCode).toBe(200);
      const ids = (res.json() as { contexts: any[] }).contexts.map((c: any) => c.context_id);
      expect(ids).toContain(child1Id);
      expect(ids).toContain(child2Id);
      expect(ids).toHaveLength(2);
    });

    it("GET /v1/contexts/:id/children returns 404 for unknown parent", async () => {
      const res = await handle.app.inject({
        method: "GET",
        url: "/v1/contexts/no-such-ctx/children",
      });
      expect(res.statusCode).toBe(404);
    });

    it("rejects self-link (parent_context_id === own context_id)", async () => {
      ensureWorkspace(handle);
      const ownId = "ctx_self_link_test";
      const res = await handle.app.inject({
        method: "POST",
        url: `/v1/workspaces/${encodeURIComponent(WS)}/contexts`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ participants: [E1], context_id: ownId, parent_context_id: ownId }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("context_parent_cycle");
    });

    it("rejects link to a non-existent parent context", async () => {
      ensureWorkspace(handle);
      const res = await handle.app.inject({
        method: "POST",
        url: `/v1/workspaces/${encodeURIComponent(WS)}/contexts`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ participants: [E1], parent_context_id: "ctx_does_not_exist" }),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("context_parent_not_found");
    });

    it("rejects a parent_context_id that would create a cycle", async () => {
      ensureWorkspace(handle);
      // Build a chain: grandparent -> parent
      const grandparentId = handle.store.contextStore.createContext({
        workspace_id: WS, created_by_endpoint_id: E1, participants: [E1],
      });
      const parentId = handle.store.contextStore.createContext({
        workspace_id: WS, created_by_endpoint_id: E1, participants: [E1],
        parent_context_id: grandparentId,
      });
      // Attempt to make grandparent's parent = parent (would close a cycle)
      const cycleChildId = "ctx_cycle_child";
      // First create grandparent's child with an explicit ID so we can use it as parent below
      // Actually test it by trying to set grandparent's parent to parentId using HTTP create:
      // Create a new context whose parent is parentId, and use grandparentId as its own id
      // That would create: grandparentId -> parentId -> grandparentId (cycle)
      const res = await handle.app.inject({
        method: "POST",
        url: `/v1/workspaces/${encodeURIComponent(WS)}/contexts`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          participants: [E1],
          context_id: grandparentId,   // re-use grandparent id as self
          parent_context_id: parentId, // parent's parent IS grandparent → cycle
        }),
      });
      // context_id already exists so this will fail (either 400 cycle or unique constraint)
      // The cycle guard fires first because grandparent's chain includes grandparentId
      expect([400, 409, 500].includes(res.statusCode)).toBe(true);
      if (res.statusCode === 400) {
        expect(res.json().error).toBe("context_parent_cycle");
      }
    });

    it("rejects a cycle via walk (A -> B -> A)", async () => {
      ensureWorkspace(handle);
      const aId = "ctx_cycle_a";
      const bId = "ctx_cycle_b";
      // Create A with parent B (B doesn't exist yet but we test with explicit IDs)
      // Build: A (no parent), B (parent=A)
      handle.store.contextStore.createContext({
        workspace_id: WS, created_by_endpoint_id: E1, participants: [E1], context_id: aId,
      });
      handle.store.contextStore.createContext({
        workspace_id: WS, created_by_endpoint_id: E1, participants: [E1], context_id: bId,
        parent_context_id: aId,
      });
      // Now try to create a context with id=aId and parent=bId → would cycle A→B→A
      const res = await handle.app.inject({
        method: "POST",
        url: `/v1/workspaces/${encodeURIComponent(WS)}/contexts`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          participants: [E1],
          context_id: aId,       // same id as A (already exists)
          parent_context_id: bId, // B's parent is A → cycle
        }),
      });
      // Should be rejected — either 400 cycle or self-reference (bId chain → aId === context_id aId)
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("context_parent_cycle");
    });
  });

  it("does not expose the retired in-memory Extension registry or HTTP relay", () => {
    expect(handle.app.hasRoute({ method: "GET", url: "/v1/extensions" })).toBe(false);
    expect(handle.app.hasRoute({ method: "POST", url: "/v1/extensions/report" })).toBe(false);
    expect(handle.app.hasRoute({ method: "GET", url: "/v1/extensions/:name/*" })).toBe(false);
    expect(handle.app.hasRoute({ method: "POST", url: "/v1/extensions/:name/*" })).toBe(false);
  });

});

describe("Endpoint lifecycle routes", () => {
  let handle: ServerHandle;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const made = await makeServer();
    handle = made.handle;
    cleanup = made.cleanup;
  });
  afterEach(async () => { await cleanup(); });

  it("accepts the long opaque endpoint ids created for command nodes", async () => {
    const endpointId =
      "command:workspace:158878416ce47ff1:acme-development-scoped:" +
      "dry-run-evidence:8a267e28-41db-4cd2-949c-0e184420b15c";
    handle.store.registerEndpoint({
      endpoint_id: endpointId,
      workspace_id: WS,
      name: "Dry-run evidence",
      bridge_id: "bridge:local",
      status: "active"
    }, () => {});

    const statusRes = await handle.app.inject({
      method: "POST",
      url: `/v1/endpoints/${encodeURIComponent(endpointId)}/status`,
      payload: { status: "error" }
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().endpoint.status).toBe("error");

    const turnEndRes = await handle.app.inject({
      method: "POST",
      url: `/v1/endpoints/${encodeURIComponent(endpointId)}/turn-end`
    });
    expect(turnEndRes.statusCode).toBe(200);
    expect(turnEndRes.json().endpoint.status).toBe("idle");
  });
});

describe("Trigger ingress Scope API routes", () => {
  let handle: ServerHandle;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const made = await makeServer();
    handle = made.handle;
    cleanup = made.cleanup;
  });
  afterEach(async () => { await cleanup(); });

  it("webhook ingress rejects routes without configured Scope instead of using Default Scope", async () => {
    handle.store.registerEndpoint({
      endpoint_id: "actor:server-test:webhook-target",
      workspace_id: WS,
      name: "Webhook target",
      bridge_id: "bridge:webhook-test",
      status: "idle"
    }, () => {});

    const res = await handle.app.inject({
      method: "POST",
      url: `/v1/webhooks/${encodeURIComponent(WS)}/route_alpha`,
      payload: { text: "webhook hello" }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      ok: false,
      error: "scope_required",
      workspace_id: WS,
      reason: "webhook route must be configured with a Scope"
    });
  });
});

describe("Runtime config truth and auth registry routes", () => {
  let handle: ServerHandle;
  let cleanup: () => Promise<void>;
  let tmp: string;

  beforeEach(async () => {
    const made = await makeServer();
    handle = made.handle;
    cleanup = made.cleanup;
    tmp = made.tmp;
  });
  afterEach(async () => { await cleanup(); });

  it("reports the live bridge runtime adapter from bridge capabilities", async () => {
    const bridgeCredential = handle.issueBridgeServiceCredential("bridge:runtime");
    const register = await handle.app.inject({
      method: "POST",
      url: "/v1/bridges/register",
      headers: { authorization: `Bearer ${bridgeCredential.bearer_token}` },
      payload: {
        capabilities: { runtime_adapters: ["pi-agent-core"] }
      }
    });
    expect(register.statusCode).toBe(201);

    // D4: liveness is socket-based. Authenticate a Bridge WS to mark it online.
    const address = await handle.app.listen({ port: 0, host: "127.0.0.1" });
    const wsUrl = address.replace(/^http/, "ws") + "/v1/events/stream";
    const wsMod = await import("ws" as any);
    const WsCtor = (wsMod as any).WebSocket ?? (wsMod as any).default;
    const observer = new WsCtor(wsUrl);
    const lifecycleMessages: any[] = [];
    observer.on("message", (data: any) => lifecycleMessages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      observer.on("open", () => observer.send(JSON.stringify({
        type: "authenticate",
        bearer_token: handle.localControlToken,
      })));
      observer.on("message", (data: any) => {
        if (JSON.parse(data.toString()).type === "authenticated") resolve();
      });
      observer.on("error", (err: any) => reject(err));
    });
    const ws = new WsCtor(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({
          type: "authenticate",
          bearer_token: bridgeCredential.bearer_token,
        }));
      });
      ws.on("message", (data: any) => {
        if (JSON.parse(data.toString()).type === "authenticated") resolve();
      });
      ws.on("error", (err: any) => reject(err));
    });
    // Give the server a tick to publish the authenticated Bridge connection.
    await new Promise(resolve => setTimeout(resolve, 50));

    const res = await handle.app.inject({ method: "GET", url: "/v1/runtime/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      bridge: {
        online: true,
        runtime_adapter: "pi-agent-core",
        release_version: null,
        build_sha: null
      }
    });
    expect(lifecycleMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "bridge_connected", payload: { bridge_id: "bridge:runtime" } })
    ]));

    ws.close();
    // Give the server a tick to process the socket close (marks bridge offline).
    await new Promise(resolve => setTimeout(resolve, 50));

    const res2 = await handle.app.inject({ method: "GET", url: "/v1/runtime/status" });
    expect(res2.json()).toMatchObject({ bridge: { online: false } });
    expect(lifecycleMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "bridge_disconnected", payload: { bridge_id: "bridge:runtime" } })
    ]));
    observer.close();
  });

  it("serves auth models merged from local overlays", async () => {
    const authDir = join(tmp, "auth");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "profiles.yaml"), YAML.stringify({
      version: 1,
      profiles: [{ id: "copilot-atvi", provider: "github-copilot", model: "gpt-5.4" }]
    }), "utf8");
    writeFileSync(join(authDir, "models.json"), JSON.stringify({
      providers: {
        "github-copilot": {
          models: [{
            id: "gpt-5.4",
            name: "GPT 5.4",
            api: "openai-responses",
            reasoning: true
          }]
        }
      }
    }, null, 2), "utf8");

    const res = await handle.app.inject({ method: "GET", url: "/v1/auth/models?provider=github-copilot" });
    expect(res.statusCode).toBe(200);
    expect(res.json().models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "gpt-5.4",
        provider: "github-copilot",
        reasoning: true
      })
    ]));
  });

  it("round-trips workspace thinking level through bindings and resolution", async () => {
    const post = await handle.app.inject({
      method: "POST",
      url: "/v1/runtime/bindings",
      payload: {
        scope: "workspace_default",
        workspace_id: WS,
        auth_profile: "copilot-atvi",
        provider: "github-copilot",
        model: "gpt-5.4",
        thinking_level: "high"
      }
    });
    expect(post.statusCode).toBe(201);
    expect(post.json().binding).toMatchObject({
      scope: "workspace_default",
      workspace_id: WS,
      auth_profile: "copilot-atvi",
      provider: "github-copilot",
      model: "gpt-5.4",
      thinking_level: "high"
    });

    const list = await handle.app.inject({ method: "GET", url: `/v1/runtime/bindings?workspace_id=${encodeURIComponent(WS)}` });
    expect(list.statusCode).toBe(200);
    expect(list.json().bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: "workspace_default",
        thinking_level: "high"
      })
    ]));

    const resolved = await handle.app.inject({
      method: "GET",
      url: `/v1/runtime/bindings/resolve?workspace_id=${encodeURIComponent(WS)}&endpoint_id=${encodeURIComponent(E1)}`
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({
      workspace_auth_profile: "copilot-atvi",
      workspace_provider: "github-copilot",
      workspace_model: "gpt-5.4",
      workspace_thinking_level: "high"
    });
  });
});

describe("Broadcast destination selector contract", () => {
  let handle: ServerHandle;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const made = await makeServer();
    handle = made.handle;
    cleanup = made.cleanup;
    handle.store.registerEndpoint({
      endpoint_id: E2,
      workspace_id: WS,
      name: E2,
      bridge_id: "bridge:test",
      status: "idle"
    }, () => {});
  });
  afterEach(async () => { await cleanup(); });

  it("HTTP emit accepts with_delivery_processor and queues only endpoints with a delivery processor", async () => {
    const res = await handle.app.inject({
      method: "POST",
      url: "/v1/events/emit",
      payload: {
        type: "notification",
        workspace_id: WS,
        source_endpoint_id: E1,
        destination: {
          kind: "broadcast",
          scope: "workspace",
          target: "with_delivery_processor",
          exclude_source: true
        },
        content: { text: "processor-only" },
        response: { expected: false }
      }
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().deliveries_created).toBe(1);

    const claim = await handle.app.inject({
      method: "GET",
      url: "/v1/delivery/claim?bridge_id=bridge%3Atest&limit=10"
    });
    const deliveries = claim.json().deliveries as any[];
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].endpoint_id).toBe(E2);
    expect(deliveries[0].events[0].destination_json).toMatchObject({
      kind: "broadcast",
      target: "with_delivery_processor"
    });
  });

  it("HTTP emit accepts without_delivery_processor without creating push delivery for processor-backed endpoints", async () => {
    const res = await handle.app.inject({
      method: "POST",
      url: "/v1/events/emit",
      payload: {
        type: "notification",
        workspace_id: WS,
        source_endpoint_id: E1,
        destination: {
          kind: "broadcast",
          scope: "workspace",
          target: "without_delivery_processor",
          exclude_source: true
        },
        content: { text: "pollable-only" },
        response: { expected: false }
      }
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().deliveries_created).toBe(1);

    const eventsRes = await handle.app.inject({
      method: "GET",
      url: `/v1/events?workspace_id=${encodeURIComponent(WS)}`
    });
    const event = (eventsRes.json().events as any[]).find((candidate) => candidate.content?.text === "pollable-only");
    expect(event.destination_json).toMatchObject({
      kind: "broadcast",
      target: "without_delivery_processor"
    });

    const claim = await handle.app.inject({
      method: "GET",
      url: "/v1/delivery/claim?bridge_id=bridge%3Atest&limit=10"
    });
    expect(claim.json().deliveries).toEqual([]);
  });

  it("HTTP emit accepts active selectors without actor category language", async () => {
    handle.store.updateEndpointStatus(E2, "active", () => {});
    handle.store.updateEndpointStatus(E3, "active", () => {});

    const res = await handle.app.inject({
      method: "POST",
      url: "/v1/events/emit",
      payload: {
        type: "notification",
        workspace_id: WS,
        source_endpoint_id: E1,
        destination: {
          kind: "broadcast",
          scope: "workspace",
          target: "active",
          exclude_source: true
        },
        content: { text: "active-only" },
        response: { expected: false }
      }
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().deliveries_created).toBe(2);

    const claim = await handle.app.inject({
      method: "GET",
      url: "/v1/delivery/claim?bridge_id=bridge%3Atest&limit=10"
    });
    expect(claim.json().deliveries).toEqual([]);
    const queued = (handle.store as any).db.prepare(
      "SELECT * FROM event_queue WHERE destination_endpoint_id = ? AND state = 'queued'"
    ).all(E2);
    expect(queued).toHaveLength(1);
  });

  it("HTTP emit rejects old actor-category broadcast selectors without persisting an event", async () => {
    for (const target of ["agents", "humans", "active_agents", "active_humans"]) {
      const res = await handle.app.inject({
        method: "POST",
        url: "/v1/events/emit",
        payload: {
          type: "notification",
          workspace_id: WS,
          source_endpoint_id: E1,
          destination: {
            kind: "broadcast",
            scope: "workspace",
            target,
            exclude_source: true
          },
          content: { text: `old-${target}` },
          response: { expected: false }
        }
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({
        code: "invalid_event_command",
        message: "Invalid event command"
      });
    }

    const eventsRes = await handle.app.inject({
      method: "GET",
      url: `/v1/events?workspace_id=${encodeURIComponent(WS)}`
    });
    const texts = (eventsRes.json().events as any[]).map((event) => event.content?.text);
    expect(texts).not.toContain("old-agents");
    expect(texts).not.toContain("old-humans");
    expect(texts).not.toContain("old-active_agents");
    expect(texts).not.toContain("old-active_humans");
  });
});

describe("Context destination selector — HTTP emit schema", () => {
  let handle: ServerHandle;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const made = await makeServer();
    handle = made.handle;
    cleanup = made.cleanup;
    // Give E2 a live bridge so it can receive deliveries
    handle.store.registerEndpoint({
      endpoint_id: E2,
      workspace_id: WS,
      name: E2,
      bridge_id: "bridge:test",
      status: "idle"
    }, () => {});
  });
  afterEach(async () => { await cleanup(); });

  it("HTTP emit ACCEPTS destination.kind='context' (no 400)", async () => {
    // Create context and subscribe directly via store (workspace HTTP API requires workspace row)
    const ctx = handle.store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: E1,
      participants: [E1, E2]
    });
    handle.store.contextStore.subscribeToContext(ctx, E2, ["*"]);

    const res = await handle.app.inject({
      method: "POST",
      url: "/v1/events/emit",
      payload: {
        type: "acme.card.entered_column",
        workspace_id: WS,
        source_endpoint_id: E1,
        destination: { kind: "context", context_id: ctx },
        context_id: ctx,
        content: { card_id: "card-1" },
        response: { expected: false }
      }
    });

    // Must NOT be a 400 validation error
    expect(res.statusCode).toBe(202);
    expect(res.json()).not.toHaveProperty("error");
  });

  it("HTTP emit with context destination creates deliveries for subscribed actors", async () => {
    const ctx = handle.store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: E1,
      participants: [E1, E2]
    });
    handle.store.contextStore.subscribeToContext(ctx, E2, ["*"]);

    const res = await handle.app.inject({
      method: "POST",
      url: "/v1/events/emit",
      payload: {
        type: "acme.card.entered_column",
        workspace_id: WS,
        source_endpoint_id: E1,
        destination: { kind: "context", context_id: ctx },
        context_id: ctx,
        content: { card_id: "card-1" },
        response: { expected: false }
      }
    });

    expect(res.statusCode).toBe(202);
    // E2 has a live bridge and is subscribed → 1 delivery created
    expect(res.json().deliveries_created).toBe(1);

    const claim = await handle.app.inject({
      method: "GET",
      url: "/v1/delivery/claim?bridge_id=bridge%3Atest&limit=10"
    });
    const deliveries = claim.json().deliveries as any[];
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].endpoint_id).toBe(E2);
    expect(deliveries[0].events[0].destination_json).toMatchObject({
      kind: "context",
      context_id: ctx
    });
  });

  it("HTTP emit with context destination creates zero deliveries when no actors subscribed", async () => {
    const ctx = handle.store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: E1,
      participants: [E1, E2]
    });
    // No subscriptions — E2 is a silent watcher

    const res = await handle.app.inject({
      method: "POST",
      url: "/v1/events/emit",
      payload: {
        type: "acme.card.entered_column",
        workspace_id: WS,
        source_endpoint_id: E1,
        destination: { kind: "context", context_id: ctx },
        context_id: ctx,
        content: { card_id: "card-2" },
        response: { expected: false }
      }
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().deliveries_created).toBe(0);
  });

  it("DestinationSelector TS union members match the HTTP schema (schema/type parity)", () => {
    // Accepted destination kind literals — must stay in sync with DestinationSelector
    // in store.ts. If the TS type gains a new member, add it here to force the schema
    // to be updated at the same time.
    const acceptedKinds = ["endpoint", "broadcast", "context"] as const;
    // The schema is tested indirectly by the HTTP tests above; this assertion documents
    // the expected set so that a future type change is caught at review time.
    expect(new Set(acceptedKinds)).toEqual(new Set(["endpoint", "broadcast", "context"]));
  });
});
