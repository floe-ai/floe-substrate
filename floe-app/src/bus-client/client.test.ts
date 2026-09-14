import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
const nativeInvoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: nativeInvoke }));
import {
  listWorkspaces,
  registerWorkspace,
  listScopes,
  listScopeCompositions,
  listScopeCompositionRevisions,
  listScopeExecutions,
  getScopeExecutionProjection,
  listContextScopeExecutions,
  listOperations,
  invokeOperation,
  listContextEventHistoryPage,
  listContextEvents,
  listContextTree,
  listContextsByParticipantPage,
  createScope,
  updateScope,
  retireScope,
  deleteScope,
  getRuntimeBindings,
  resolveRuntimeBinding,
  listDeliveries,
  getRuntimeStatus,
  getContextDiagnosticEvidence,
  listConfigs,
  emit,
} from "./client.ts";

// ---------------------------------------------------------------------------
// Minimal fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", undefined);
});

afterEach(() => {
  nativeInvoke.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Existing capabilities
// ---------------------------------------------------------------------------

describe("bus-client — existing", () => {
  it.todo("advances watermark via PUT");
  it.todo("pages events with next_cursor");
});

// ---------------------------------------------------------------------------
// New — reads
// ---------------------------------------------------------------------------

describe("bus-client — reads", () => {
  it.each([true, false])("reads desktop runtime health without a Workspace request (online=%s)", async online => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const runtime = { bridge: { online, runtime_adapter: "pi" } };
    nativeInvoke.mockResolvedValue({ status: 200, contentType: "application/json", body: JSON.stringify(runtime) });
    expect(await getRuntimeStatus()).toEqual(runtime);
    expect(nativeInvoke).toHaveBeenCalledExactlyOnceWith("get_local_runtime_status");
  });

  it("keeps a failed native health read visible as a failure", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    nativeInvoke.mockResolvedValue({ status: 503, body: "{}" });
    await expect(getRuntimeStatus()).rejects.toMatchObject({ status: 503 });
  });
  it("listWorkspaces unwraps { workspaces }", async () => {
    const workspaces = [{ workspace_id: "ws1", name: "Test", locator: "/tmp/ws1", status: "active", selected_at: null, created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" }];
    vi.stubGlobal("fetch", mockFetch({ workspaces }));
    const result = await listWorkspaces();
    expect(result).toEqual(workspaces);
  });

  it("listWorkspaces forwards a bootstrap cancellation signal", async () => {
    const fetchMock = mockFetch({ workspaces: [] });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await listWorkspaces(controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/browser/session",
      { signal: controller.signal, credentials: "same-origin" },
    );
  });

  it("listScopes unwraps { scopes } and encodes workspace_id", async () => {
    const scopes = [{ scope_id: "s1", workspace_id: "ws:abc", title: "Scope 1", description: null, status: "active", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" }];
    const fetchMock = mockFetch({ scopes });
    vi.stubGlobal("fetch", fetchMock);
    const result = await listScopes("ws:abc");
    expect(result).toEqual(scopes);
    expect((fetchMock.mock.calls[0][0] as string)).toContain(encodeURIComponent("ws:abc"));
  });

  it("getRuntimeBindings unwraps { bindings }", async () => {
    const bindings = [{ binding_key: "runtime:global:default", scope: "global_default", workspace_id: null, endpoint_id: null, auth_profile: "default", model: null, thinking_level: null, created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" }];
    vi.stubGlobal("fetch", mockFetch({ bindings }));
    const result = await getRuntimeBindings();
    expect(result).toEqual(bindings);
  });

  it("resolveRuntimeBinding returns resolution shape directly", async () => {
    const resolution = {
      endpoint_auth_profile: null,
      workspace_auth_profile: "default",
      global_auth_profile: null,
      endpoint_model: null,
      workspace_model: "claude-3-opus",
      global_model: null,
      endpoint_thinking_level: null,
      workspace_thinking_level: null,
      global_thinking_level: null,
    };
    vi.stubGlobal("fetch", mockFetch(resolution));
    const result = await resolveRuntimeBinding("ws1", "ep1");
    expect(result).toEqual(resolution);
  });

  it("listDeliveries unwraps { deliveries }", async () => {
    const deliveries = [{ delivery_id: "d1", endpoint_id: "ep1", workspace_id: "ws1", trigger_event_id: "ev1", events_json: "[]", state: "reserved", lease_expires_at: null, attempt_count: 1, last_error: null, created_at: "2024-01-01T00:00:00Z", claimed_at: null }];
    vi.stubGlobal("fetch", mockFetch({ deliveries }));
    const result = await listDeliveries({ workspace_id: "ws1" });
    expect(result).toEqual(deliveries);
  });

  it("getRuntimeStatus returns bridge shape", async () => {
    const status = { bridge: { online: true, runtime_adapter: "claude" } };
    vi.stubGlobal("fetch", mockFetch({ runtime: status }));
    const result = await getRuntimeStatus();
    expect(result.bridge.online).toBe(true);
  });

  it("listConfigs unwraps { configs }", async () => {
    const configs = [{ config_id: "cfg_1", name: "prod", config_json: "{}", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" }];
    vi.stubGlobal("fetch", mockFetch({ configs }));
    const result = await listConfigs();
    expect(result).toEqual(configs);
  });
});

// ---------------------------------------------------------------------------
// New — writes
// ---------------------------------------------------------------------------

describe("bus-client — writes", () => {
  it("bounds a message submission when the local substrate stops responding", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));

    const pending = expect(emit({
      type: "message",
      workspace_id: "ws1",
      source_endpoint_id: "actor:ws1:operator",
      destination: { kind: "endpoint", endpoint_id: "actor:ws1:floe" },
      content: { text: "hello" },
      response: { expected: true },
      metadata: {},
    })).rejects.toThrow("Floe's local service stopped responding");

    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
  });

  it("loads bounded Context diagnostics from the Bus-owned projection", async () => {
    const evidence = { schema: "floe.context-diagnostic.v1", events: [] };
    const fetchMock = mockFetch(evidence);
    vi.stubGlobal("fetch", fetchMock);

    await expect(getContextDiagnosticEvidence("workspace:one", "ctx:one", {
      event_limit: 20,
      telemetry_limit: 40,
    })).resolves.toEqual(evidence);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/v1/workspaces/workspace%3Aone/diagnostics/contexts/ctx%3Aone");
    expect(url).toContain("event_limit=20");
    expect(url).toContain("telemetry_limit=40");
  });

  it("pages through an entire Context history without dropping newer messages", async () => {
    const first = Array.from({ length: 500 }, (_, index) => ({ event_id: `event-${index}` }));
    const last = { event_id: "event-500" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ events: first, next_cursor: "cursor-500" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ events: [last], next_cursor: "cursor-501" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await listContextEvents("ctx:long", { all: true });

    expect(result).toHaveLength(501);
    expect(result.at(-1)).toEqual(last);
    expect(fetchMock.mock.calls[0][0] as string).toContain("context_id=ctx%3Along");
    expect(fetchMock.mock.calls[1][0] as string).toContain("since=cursor-500");
  });

  it("requests bounded Context history backward from the newest page", async () => {
    const fetchMock = mockFetch({
      events: [{ event_id: "event-older" }],
      next_cursor: null,
      previous_cursor: "cursor-earlier",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listContextEventHistoryPage("ctx:long", {
      before: "cursor-newer",
      limit: 50,
      type: "message",
    })).resolves.toEqual({
      events: [{ event_id: "event-older" }],
      previous_cursor: "cursor-earlier",
    });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("context_id=ctx%3Along");
    expect(url).toContain("direction=backward");
    expect(url).toContain("before=cursor-newer");
    expect(url).toContain("type=message");
    expect(url).toContain("limit=50");
  });

  it("pages recent participant Contexts without one request per conversation", async () => {
    const page = {
      contexts: [{ context_id: "ctx:recent", latest_message_preview: "Done" }],
      next_cursor: "older-contexts",
    };
    const fetchMock = mockFetch(page);
    vi.stubGlobal("fetch", fetchMock);

    await expect(listContextsByParticipantPage({
      participant: "actor:workspace:operator",
      workspace_id: "workspace:test",
      limit: 20,
      before: "newer-contexts",
    })).resolves.toEqual(page);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("participant=actor%3Aworkspace%3Aoperator");
    expect(url).toContain("workspace_id=workspace%3Atest");
    expect(url).toContain("limit=20");
    expect(url).toContain("before=newer-contexts");
  });

  it("loads one bounded Context lineage for the Work projection", async () => {
    const result = { contexts: [{ context_id: "ctx:root" }], truncated: false };
    const fetchMock = mockFetch(result);
    vi.stubGlobal("fetch", fetchMock);

    await expect(listContextTree("ctx:root", 200)).resolves.toEqual(result);
    expect(fetchMock.mock.calls[0][0] as string).toContain("/v1/contexts/ctx%3Aroot/tree?limit=200");
  });

  it("listScopeCompositions unwraps the Scope's stored composition", async () => {
    const graphs = [{ graph_id: "graph-1", workspace_id: "ws:abc", scope_id: "delivery", context_id: "ctx-1", nodes: [], created_at: "2026-08-27T00:00:00Z", updated_at: "2026-08-27T00:00:00Z" }];
    const fetchMock = mockFetch({ graphs });
    vi.stubGlobal("fetch", fetchMock);
    await expect(listScopeCompositions("ws:abc", "delivery pipeline")).resolves.toEqual(graphs);
    expect(fetchMock.mock.calls[0][0] as string).toContain("/scopes/delivery%20pipeline/graphs");
  });

  it("loads the published plan and bounded canonical Scope executions", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ published_revision_id: "revision-2", revisions: [] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ executions: [], next_cursor: "older" }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listScopeCompositionRevisions("workspace:one", "scope one")).resolves.toEqual({ published_revision_id: "revision-2", revisions: [] });
    await expect(listScopeExecutions("workspace:one", "scope one", { limit: 25, before: "cursor" })).resolves.toEqual({ executions: [], next_cursor: "older" });

    expect(fetchMock.mock.calls[0][0] as string).toContain("/scopes/scope%20one/compositions");
    expect(fetchMock.mock.calls[1][0] as string).toContain("/scopes/scope%20one/executions?limit=25&before=cursor");
  });

  it("loads an exact execution projection and explicit conversation links", async () => {
    const projection = { execution: { execution_id: "execution-1" }, revision: { revision_id: "revision-1" }, node_executions: [], traversals: [] };
    const linked = [{ execution_id: "execution-1", cause_event_id: "event-message" }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ projection }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ executions: linked }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getScopeExecutionProjection("workspace:one", "execution one")).resolves.toEqual(projection);
    await expect(listContextScopeExecutions("workspace:one", "context one")).resolves.toEqual(linked);
    expect(fetchMock.mock.calls[0][0] as string).toContain("/scope-executions/execution%20one");
    expect(fetchMock.mock.calls[1][0] as string).toContain("/contexts/context%20one/scope-executions");
  });

  it("discovers and invokes Stop through one authenticated operation contract", async () => {
    const descriptor = { operation_id: "scope.execution.stop", operation_version: "1" };
    const receipt = { receipt_id: "receipt-1", state: "completed" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ operations: [descriptor] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ kind: "receipt", replayed: false, receipt }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listOperations("workspace:one", { kind: "scope_execution", id: "execution-1" })).resolves.toEqual([descriptor]);
    await expect(invokeOperation("workspace:one", {
      operation_id: "scope.execution.stop",
      operation_version: "1",
      input_schema_version: "1",
      target: { kind: "scope_execution", id: "execution-1" },
      expected_resource_revision: "revision-1:running::",
      idempotency_key: "stop-1",
      input: { reason: "Operator stopped it." },
    })).resolves.toEqual(receipt);

    const invokeInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(invokeInit.headers).toEqual({ "content-type": "application/json" });
  });

  it("adds a Workspace through the discovered host operation and returns its local binding", async () => {
    const descriptor = {
      operation_id: "workspace.register",
      operation_version: "1",
      input: { version: "1", schema: {} },
      availability: { available: true },
    };
    const localWorkspace = {
      workspace_id: "workspace:new",
      name: "New Workspace",
      locator: "C:\\Work\\New",
      status: "active",
      selected_at: null,
      created_at: "2026-09-04T00:00:00.000Z",
      updated_at: "2026-09-04T00:00:00.000Z",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ operations: [descriptor] }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          kind: "receipt",
          replayed: false,
          receipt: {
            receipt_id: "receipt-register",
            state: "completed",
            refusal: null,
            result: { workspace: { workspace_id: "workspace:new" } },
          },
        }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ workspaces: [localWorkspace] }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(registerWorkspace({
      locator: "C:\\Work\\New",
      name: "New Workspace",
      init_authorized: true,
    })).resolves.toEqual(localWorkspace);

    const discoveryUrl = String(fetchMock.mock.calls[0][0]);
    const invocationUrl = String(fetchMock.mock.calls[1][0]);
    expect(discoveryUrl).toContain("/v1/browser/host/operations?query=register+workspace");
    expect(invocationUrl).toContain("/v1/browser/host/operations/invoke");
    const invocation = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(invocation).toMatchObject({
      operation_id: "workspace.register",
      operation_version: "1",
      input_schema_version: "1",
      input: { locator: "C:\\Work\\New", name: "New Workspace", init_authorized: true },
    });
    expect(invocation.idempotency_key).toMatch(/^workspace-register:/);
  });

  it("creates a Scope through the discovered shared operation", async () => {
    const scope = { scope_id: "s-new", workspace_id: "ws1", title: "New Scope", description: null, created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ operations: [{ operation_id: "scope.create", operation_version: "1", input: { version: "1" }, availability: { available: true } }] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ kind: "receipt", receipt: { state: "completed", result: { scope } } }) });
    vi.stubGlobal("fetch", fetchMock);
    const result = await createScope("ws1", { title: "New Scope" });
    expect(result).toEqual(scope);
    expect(String(fetchMock.mock.calls[1][0])).toContain("/workspaces/ws1/operations/invoke");
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toMatchObject({ operation_id: "scope.create", input: { title: "New Scope" } });
  });

  it("updateScope unwraps { scope } and PATCHes", async () => {
    const scope = { scope_id: "s1", workspace_id: "ws1", title: "Updated", description: null, created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-02T00:00:00Z" };
    const fetchMock = mockFetch({ scope });
    vi.stubGlobal("fetch", fetchMock);
    const result = await updateScope("ws1", "s1", { title: "Updated" });
    expect(result).toEqual(scope);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PATCH");
  });

  it("retireScope stops active work while preserving the Scope", async () => {
    const result = {
      status: "retired" as const,
      cancelled_delivery_count: 2,
      cancelled_queue_count: 3,
      cancelled_pulse_count: 1,
    };
    const fetchMock = mockFetch(result);
    vi.stubGlobal("fetch", fetchMock);

    await expect(retireScope("ws:one", "pipeline one")).resolves.toEqual(result);
    expect(fetchMock.mock.calls[0][0] as string).toContain("/workspaces/ws%3Aone/scopes/pipeline%20one/retire");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });

  it("deleteScope sends DELETE and handles 204", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    await deleteScope("ws1", "s1");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
  });
});
