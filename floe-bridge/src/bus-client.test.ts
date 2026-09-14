/**
 * Unit tests for BusClient — the new participant/subscription/children HTTP
 * methods added for the card=context rework.
 *
 * fetch is mocked via vi.stubGlobal so no real network or bus is needed.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { BridgeTransportUnavailableError, BusClient, normalizeEventEnvelopeAtTransport } from "./bus-client.js";

const BASE = "http://127.0.0.1:5377";
const BRIDGE_TOKEN = `bridge-service-${"x".repeat(48)}`;
const client = new BusClient(BASE, {
  audience: "bridge_service",
  bearer_token: BRIDGE_TOKEN,
});

function mockFetch(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Event transport migration", () => {
  const event = {
    event_id: "event:one",
    type: "message",
    workspace_id: "workspace:one",
    source_endpoint_id: "actor:operator",
    thread_id: "context:one",
    correlation_id: null,
    destination_json: { kind: "endpoint", endpoint_id: "actor:floe" },
    content: {},
    response: { expected: false },
    metadata: {},
    created_at: "2026-09-04T00:00:00.000Z",
  } as any;

  it("preserves exact canonical ArtefactVersion ids", () => {
    const ids = ["artefact-version:one", "artefact-version:two"];
    expect(normalizeEventEnvelopeAtTransport({ ...event, artefact_version_ids: ids }).artefact_version_ids)
      .toEqual(ids);
  });

  it("returns the retained Event confirmation to the emitting caller", async () => {
    const receipt = { event_id: "event:retained", accepted_at: "2026-09-05T00:00:00Z",
      event: { ...event, event_id: "event:retained", artefact_version_ids: ["artefact-version:retained"] } };
    mockFetch(receipt, 202);
    await expect(client.emit({ ...event, artefact_version_ids: ["artefact-version:requested"],
      destination: event.destination_json })).resolves.toEqual(receipt);
  });

  it("adds an empty list only for a legacy Event with an absent field and rejects malformed identity", () => {
    expect(normalizeEventEnvelopeAtTransport(event).artefact_version_ids).toEqual([]);
    expect(() => normalizeEventEnvelopeAtTransport({ ...event, artefact_version_ids: [""] }))
      .toThrow(/invalid Event artefact_version_ids/);
  });
});

describe("BusClient Bridge transport authority", () => {
  it("keeps health readable but refuses protected calls when the credential is missing", async () => {
    mockFetch({ ok: true });
    const unavailable = new BusClient(BASE);

    await expect(unavailable.health()).resolves.toEqual({ ok: true });
    await expect(unavailable.listWorkspaces()).rejects.toMatchObject({
      code: "bridge_transport_unavailable",
      reason: "credential_missing",
    });
    expect(unavailable.authorityState).toEqual({
      status: "unavailable",
      reason: "credential_missing",
    });
  });

  it("sends the Bridge credential only in the Authorization header", async () => {
    mockFetch({ workspaces: [] });

    await client.listWorkspaces();

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe(`${BASE}/v1/bridge/workspace-bindings`);
    expect(String(url)).not.toContain(BRIDGE_TOKEN);
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${BRIDGE_TOKEN}` });
  });

  it("reads credential bytes only through the private Delivery route", async () => {
    const bytes = Buffer.from("opaque-runtime-material", "utf8");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(bytes.byteLength) }),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }));

    const result = await client.readRuntimeCredential("delivery:1", "secret:1");

    expect(Buffer.from(result).toString("utf8")).toBe("opaque-runtime-material");
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe(`${BASE}/v1/delivery/delivery%3A1/runtime-credentials/secret%3A1`);
    expect(init?.headers).toMatchObject({
      accept: "application/octet-stream",
      authorization: `Bearer ${BRIDGE_TOKEN}`,
    });
  });

  it("writes refreshed bytes without putting them in the URL or headers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 204 }));
    const material = Buffer.from("rotated-runtime-material", "utf8");

    await client.replaceRuntimeCredential("delivery:2", "secret:2", material);

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe(`${BASE}/v1/delivery/delivery%3A2/runtime-credentials/secret%3A2`);
    expect(String(url)).not.toContain("rotated-runtime-material");
    expect(JSON.stringify(init?.headers)).not.toContain("rotated-runtime-material");
    expect(Buffer.from(init?.body as ArrayBuffer).toString("utf8")).toBe("rotated-runtime-material");
  });

  it("keeps Workspace identity separate from its host-local binding", async () => {
    mockFetch({
      workspaces: [{
        workspace_id: "workspace:1",
        name: "One",
        creation_kind: "created",
        source_workspace_id: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        binding: {
          binding_id: "wbind:1",
          workspace_id: "workspace:1",
          host_id: "host:1",
          platform: "windows",
          locator: "C:\\Workspaces\\One",
          normalized_locator: "c:\\workspaces\\one",
          state: "current",
          status: "attached",
          init_authorized: true,
          active_config_hash: null,
          selected_at: null,
          bound_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          superseded_at: null,
          superseded_by_binding_id: null,
        },
      }],
    });

    const [workspace] = await client.listWorkspaces();

    expect(workspace.workspace_id).toBe("workspace:1");
    expect(workspace.binding?.binding_id).toBe("wbind:1");
    expect(workspace).not.toHaveProperty("locator");
  });

  it("marks authority unavailable after a rejected credential without exposing it", async () => {
    mockFetch({ error: "transport_credential_denied" }, 401);
    const rejected = new BusClient(BASE, {
      audience: "bridge_service",
      bearer_token: BRIDGE_TOKEN,
    });

    const failure = await rejected.listWorkspaces().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BridgeTransportUnavailableError);
    expect(String(failure)).not.toContain(BRIDGE_TOKEN);
    expect(rejected.authorityState).toEqual({
      status: "unavailable",
      reason: "credential_not_accepted",
    });
  });

  it("keeps a valid credential available when one addressed resource is forbidden", async () => {
    mockFetch({ error: "transport_forbidden" }, 403);
    const forbidden = new BusClient(BASE, {
      audience: "bridge_service",
      bearer_token: BRIDGE_TOKEN,
    });

    await expect(forbidden.reportDeliveryStatus("delivery:other", "acknowledged"))
      .rejects.toThrow(/403/);
    expect(forbidden.authorityState).toEqual({
      status: "available",
      audience: "bridge_service",
    });
  });

  it("keeps Bridge work available after a legacy watcher route rejects its audience", async () => {
    const rejectedRoute = `${BASE}/v1/workspaces/workspace/graphs/graph/nodes/folder/fire`;
    const fetch = vi.fn(async (url: string) => {
      if (url === rejectedRoute) return new Response('{"error":"transport_auth_required"}', { status: 401 });
      if (url === `${BASE}/v1/bridge/workspace-bindings`) return new Response('{"workspaces":[]}');
      if (url === `${BASE}/v1/bridges/register`) return new Response('{}');
      throw new Error(`Unexpected test route ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    const bridge = new BusClient(BASE, { audience: "bridge_service", bearer_token: BRIDGE_TOKEN });
    await expect(bridge.fireScopeGraphTriggerNode("workspace", "graph", "folder"))
      .rejects.toThrow(/401.*transport_auth_required/);
    expect(bridge.authorityState).toEqual({ status: "available", audience: "bridge_service" });
    await expect(bridge.registerBridge({})).resolves.toBeUndefined();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      rejectedRoute, `${BASE}/v1/bridge/workspace-bindings`, `${BASE}/v1/bridges/register`,
    ]);
  });

  it("disables a rejected Bridge credential after one probe, without recursive retries", async () => {
    const fetch = vi.fn(async () => new Response('{"error":"transport_auth_required"}', { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    const bridge = new BusClient(BASE, { audience: "bridge_service", bearer_token: BRIDGE_TOKEN });
    await expect(bridge.fireScopeGraphTriggerNode("workspace", "graph", "folder"))
      .rejects.toBeInstanceOf(BridgeTransportUnavailableError);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(bridge.registerBridge({})).rejects.toBeInstanceOf(BridgeTransportUnavailableError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not mistake a failed credential probe for credential invalidity", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"transport_auth_required"}', { status: 401 }))
      .mockRejectedValueOnce(new Error("Connection interrupted"));
    vi.stubGlobal("fetch", fetch);
    const bridge = new BusClient(BASE, { audience: "bridge_service", bearer_token: BRIDGE_TOKEN });
    await expect(bridge.fireScopeGraphTriggerNode("workspace", "graph", "folder"))
      .rejects.toThrow(/401.*transport_auth_required/);
    expect(bridge.authorityState).toEqual({ status: "available", audience: "bridge_service" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses to send the credential over non-loopback cleartext transport", async () => {
    const insecure = new BusClient("http://192.168.1.20:5377", {
      audience: "bridge_service",
      bearer_token: BRIDGE_TOKEN,
    });

    expect(insecure.authorityState).toEqual({
      status: "unavailable",
      reason: "insecure_transport",
    });
    await expect(insecure.listWorkspaces()).rejects.toMatchObject({
      reason: "insecure_transport",
    });
  });

  it("derives Bridge identity server-side for registration, claims, and status", async () => {
    const responses = [
      { ok: true },
      { deliveries: [] },
      { delivery: { state: "acknowledged" } },
    ];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      const body = responses.shift();
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }));

    await client.registerBridge({ runtime_adapters: ["fake"] });
    await client.claimDeliveries();
    await client.reportDeliveryStatus("delivery:1", "acknowledged");

    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(calls[0][0]).toBe(`${BASE}/v1/bridges/register`);
    expect(JSON.parse(calls[0][1]?.body as string)).toEqual({
      capabilities: { runtime_adapters: ["fake"] },
    });
    expect(calls[1][0]).toBe(`${BASE}/v1/delivery/claim?limit=10`);
    expect(JSON.parse(calls[2][1]?.body as string)).toEqual({
      state: "acknowledged",
      error: null,
    });
    expect(calls.flatMap(([url, init]) => [String(url), String(init?.body ?? "")]).join(" "))
      .not.toContain("bridge_id");
  });

  it("pins attachment and config callbacks to the exact Workspace binding", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => "{}",
    }));

    await client.reportAttachment("workspace:1", {
      binding_id: "wbind:original",
      status: "attached",
    });
    await client.importWorkspaceConfiguration("workspace:1", {
      schema: "floe.workspace-configuration-inventory.v1",
      importer_version: "1",
      binding_id: "wbind:original",
      config_hash: `sha256:${"a".repeat(64)}`,
      source: { kind: "workspace_files", manifest_ref: ".floe/floe.yaml" },
      validation: { ok: true, issues: [] },
      actors: [],
    });

    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(JSON.parse(calls[0][1]?.body as string)).toMatchObject({ binding_id: "wbind:original" });
    expect(JSON.parse(calls[1][1]?.body as string)).toMatchObject({ binding_id: "wbind:original" });
  });
});

describe("BusClient Context history direction", () => {
  it.each(["forward", "backward"] as const)("preserves the Bus continuation and saved references for %s history", async direction => {
    const saved = { event_id: "event:retained", artefact_version_ids: ["version:exact"],
      content: { references: [{ name: "Saved approval", resource_ref: { kind: "approval_request", id: "approval:exact", revision: "3" } }] } };
    mockFetch({ events: [saved], next_cursor: "opaque:newer/+", previous_cursor: "opaque:older/+" });
    const page = await client.listContextEvents("context:current", "opaque:boundary/+", 7, direction);
    expect(page).toEqual({ events: [saved], next_cursor: direction === "backward" ? "opaque:older/+" : "opaque:newer/+" });
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const query = new URL(String(url)).searchParams;
    expect(new URL(String(url)).pathname).toBe("/v1/events");
    expect(Object.fromEntries(query)).toEqual({ context_id: "context:current", direction,
      [direction === "backward" ? "before" : "since"]: "opaque:boundary/+", limit: "7" });
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${BRIDGE_TOKEN}` });
  });

  it("retains forward as the transport default and starts recent reads without a boundary", async () => {
    mockFetch({ events: [], next_cursor: null, previous_cursor: null });
    await expect(client.listContextEvents("context:current")).resolves.toEqual({ events: [], next_cursor: null });
    await expect(client.listContextEvents("context:current", null, 10, "backward")).resolves.toEqual({ events: [], next_cursor: null });
    const queries = vi.mocked(globalThis.fetch).mock.calls.map(([url]) => Object.fromEntries(new URL(String(url)).searchParams));
    expect(queries).toEqual([{ context_id: "context:current", direction: "forward" },
      { context_id: "context:current", direction: "backward", limit: "10" }]);
  });
});

// ---------------------------------------------------------------------------
// addParticipant
// ---------------------------------------------------------------------------

describe("BusClient.addParticipant", () => {
  it("POSTs to /v1/contexts/:id/participants with endpoint_id body", async () => {
    mockFetch({ ok: true, context_id: "ctx:1", endpoint_id: "actor:ws:agent-a", added: true });

    const result = await client.addParticipant("ctx:1", "actor:ws:agent-a");

    expect(result).toEqual({ added: true });
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/contexts/ctx%3A1/participants`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ endpoint_id: "actor:ws:agent-a" });
  });

  it("returns added=false when bus says not newly added", async () => {
    mockFetch({ ok: true, context_id: "ctx:1", endpoint_id: "actor:ws:agent-a", added: false });
    const result = await client.addParticipant("ctx:1", "actor:ws:agent-a");
    expect(result).toEqual({ added: false });
  });
});

// ---------------------------------------------------------------------------
// removeParticipant
// ---------------------------------------------------------------------------

describe("BusClient.removeParticipant", () => {
  it("DELETEs /v1/contexts/:id/participants/:endpoint_id", async () => {
    mockFetch({ ok: true, context_id: "ctx:1", endpoint_id: "actor:ws:agent-a", removed: true });

    const result = await client.removeParticipant("ctx:1", "actor:ws:agent-a");

    expect(result).toEqual({ removed: true });
    const fetchMock = vi.mocked(globalThis.fetch);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/contexts/ctx%3A1/participants/actor%3Aws%3Aagent-a`);
    expect(init?.method).toBe("DELETE");
  });
});

// ---------------------------------------------------------------------------
// subscribeToContext
// ---------------------------------------------------------------------------

describe("BusClient.subscribeToContext", () => {
  it("POSTs to /v1/contexts/:id/subscriptions with endpoint_id and event_types", async () => {
    mockFetch({ ok: true, context_id: "ctx:1", endpoint_id: "actor:ws:agent-a", event_types: ["*"] });

    await client.subscribeToContext("ctx:1", "actor:ws:agent-a", ["*"]);

    const fetchMock = vi.mocked(globalThis.fetch);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/contexts/ctx%3A1/subscriptions`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      endpoint_id: "actor:ws:agent-a",
      event_types: ["*"],
    });
  });

  it("sends non-empty event type list as-is", async () => {
    mockFetch({ ok: true, context_id: "ctx:1", endpoint_id: "actor:ws:agent-a", event_types: ["message", "acme.card.entered_column"] });

    await client.subscribeToContext("ctx:1", "actor:ws:agent-a", ["message", "acme.card.entered_column"]);

    const fetchMock = vi.mocked(globalThis.fetch);
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.event_types).toEqual(["message", "acme.card.entered_column"]);
  });

  it("sends [] for a silent watcher subscription", async () => {
    mockFetch({ ok: true, context_id: "ctx:1", endpoint_id: "actor:ws:agent-a", event_types: [] });

    await client.subscribeToContext("ctx:1", "actor:ws:agent-a", []);

    const fetchMock = vi.mocked(globalThis.fetch);
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.event_types).toEqual([]);
  });

  it("defaults event_types to ['*'] when omitted", async () => {
    mockFetch({ ok: true, context_id: "ctx:1", endpoint_id: "actor:ws:agent-a", event_types: ["*"] });

    await client.subscribeToContext("ctx:1", "actor:ws:agent-a");

    const fetchMock = vi.mocked(globalThis.fetch);
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.event_types).toEqual(["*"]);
  });
});

// ---------------------------------------------------------------------------
// unsubscribeFromContext
// ---------------------------------------------------------------------------

describe("BusClient.unsubscribeFromContext", () => {
  it("DELETEs /v1/contexts/:id/subscriptions/:endpoint_id", async () => {
    mockFetch({ ok: true, context_id: "ctx:1", endpoint_id: "actor:ws:agent-a" });

    await client.unsubscribeFromContext("ctx:1", "actor:ws:agent-a");

    const fetchMock = vi.mocked(globalThis.fetch);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/contexts/ctx%3A1/subscriptions/actor%3Aws%3Aagent-a`);
    expect(init?.method).toBe("DELETE");
  });
});

// ---------------------------------------------------------------------------
// listContextSubscriptions
// ---------------------------------------------------------------------------

describe("BusClient.listContextSubscriptions", () => {
  it("GETs /v1/contexts/:id/subscriptions and returns the subscriptions array", async () => {
    const payload = {
      subscriptions: [
        { endpoint_id: "actor:ws:agent-a", event_types: ["*"], subscribed_at: "2026-01-01T00:00:00.000Z" },
        { endpoint_id: "actor:ws:agent-b", event_types: [], subscribed_at: "2026-01-02T00:00:00.000Z" },
      ],
    };
    mockFetch(payload);

    const result = await client.listContextSubscriptions("ctx:1");

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(payload.subscriptions[0]);
    expect(result[1]).toEqual(payload.subscriptions[1]);

    const fetchMock = vi.mocked(globalThis.fetch);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/contexts/ctx%3A1/subscriptions`);
  });
});

// ---------------------------------------------------------------------------
// listChildContexts
// ---------------------------------------------------------------------------

describe("BusClient.listChildContexts", () => {
  it("GETs /v1/contexts/:id/children and returns the contexts array", async () => {
    const payload = {
      contexts: [
        { context_id: "ctx:child:1", workspace_id: "ws:1", scope_id: "scope:1", created_at: "2026-01-01T00:00:00.000Z", title: "Child card", participants: [] },
      ],
    };
    mockFetch(payload);

    const result = await client.listChildContexts("ctx:parent");

    expect(result).toHaveLength(1);
    expect(result[0].context_id).toBe("ctx:child:1");

    const fetchMock = vi.mocked(globalThis.fetch);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/contexts/ctx%3Aparent/children`);
  });

  it("returns empty array when there are no children", async () => {
    mockFetch({ contexts: [] });
    const result = await client.listChildContexts("ctx:parent");
    expect(result).toEqual([]);
  });
});
