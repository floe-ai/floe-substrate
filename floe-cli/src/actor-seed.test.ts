import { describe, expect, it, vi, type MockedFunction } from "vitest";
import {
  seedDefaultActor,
  actorEndpointId,
  DEFAULT_ACTOR_SLUG,
  DEFAULT_ACTOR_NAME,
} from "./actor-seed.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUS_BASE = "http://127.0.0.1:5174";
const WORKSPACE_ID = "ws_test_abc";
const HOST_TOKEN = "host-control-token-xyz";
const EXPECTED_ENDPOINT_ID = `actor:${WORKSPACE_ID}:${DEFAULT_ACTOR_SLUG}`;

/**
 * Build a fetch mock that answers POST /v1/endpoints/register with a 201.
 * Registration is an authenticated upsert; there is no idempotency pre-list.
 */
function mockFetch(): MockedFunction<typeof fetch> {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input.toString();
    if (init?.method === "POST" && url.includes("/v1/endpoints/register")) {
      const body = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          endpoint: {
            endpoint_id: body.endpoint_id,
            workspace_id: body.workspace_id,
            name: body.name,
            agent_id: body.agent_id,
            bridge_id: body.bridge_id,
            status: body.status,
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  });
}

// ---------------------------------------------------------------------------
// actorEndpointId
// ---------------------------------------------------------------------------

describe("actorEndpointId", () => {
  it("builds the actor:<workspace_id>:<slug> format", () => {
    expect(actorEndpointId("ws_123", "operator")).toBe("actor:ws_123:operator");
  });

  it("preserves the slug verbatim", () => {
    expect(actorEndpointId("ws_abc", "release-notes-drafter")).toBe(
      "actor:ws_abc:release-notes-drafter"
    );
  });
});

// ---------------------------------------------------------------------------
// seedDefaultActor — registers the operator actor
// ---------------------------------------------------------------------------

describe("seedDefaultActor — registers the operator actor", () => {
  it("returns seeded: true and the correct endpoint_id", async () => {
    const fetch = mockFetch();
    const result = await seedDefaultActor(BUS_BASE, WORKSPACE_ID, HOST_TOKEN, fetch as typeof globalThis.fetch);

    expect(result).toEqual({ seeded: true, endpoint_id: EXPECTED_ENDPOINT_ID });
  });

  it("does not pre-list endpoints — it upserts directly", async () => {
    const fetch = mockFetch();
    await seedDefaultActor(BUS_BASE, WORKSPACE_ID, HOST_TOKEN, fetch as typeof globalThis.fetch);

    // A single POST; no GET list call. Registration is an idempotent upsert.
    expect(fetch.mock.calls).toHaveLength(1);
    expect(fetch.mock.calls[0][1]?.method).toBe("POST");
  });

  it("authorizes the registration with the host-control credential", async () => {
    const fetch = mockFetch();
    await seedDefaultActor(BUS_BASE, WORKSPACE_ID, HOST_TOKEN, fetch as typeof globalThis.fetch);

    const postCall = fetch.mock.calls.find(([, opts]) => opts?.method === "POST");
    const headers = postCall![1]!.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${HOST_TOKEN}`);
  });

  it("calls POST /v1/endpoints/register with the correct actor payload", async () => {
    const fetch = mockFetch();
    await seedDefaultActor(BUS_BASE, WORKSPACE_ID, HOST_TOKEN, fetch as typeof globalThis.fetch);

    const postCall = fetch.mock.calls.find(([, opts]) => opts?.method === "POST");
    expect(postCall).toBeDefined();
    expect(postCall![0].toString()).toContain("/v1/endpoints/register");

    const payload = JSON.parse(postCall![1]!.body as string);
    expect(payload).toMatchObject({
      endpoint_id: EXPECTED_ENDPOINT_ID,
      workspace_id: WORKSPACE_ID,
      name: DEFAULT_ACTOR_NAME,
      agent_id: DEFAULT_ACTOR_SLUG,
      bridge_id: null,
      status: "idle",
    });
  });
});

// ---------------------------------------------------------------------------
// seedDefaultActor — error paths
// ---------------------------------------------------------------------------

describe("seedDefaultActor — error handling", () => {
  it("returns register_failed when the bus is unreachable", async () => {
    const fetch = vi.fn(async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    });
    const result = await seedDefaultActor(BUS_BASE, WORKSPACE_ID, HOST_TOKEN, fetch as typeof globalThis.fetch);

    expect(result).toEqual({ seeded: false, reason: "register_failed" });
  });

  it("returns register_failed when POST /v1/endpoints/register returns non-OK", async () => {
    const fetch = vi.fn(async (): Promise<Response> => {
      return new Response("forbidden", { status: 403 });
    });
    const result = await seedDefaultActor(BUS_BASE, WORKSPACE_ID, HOST_TOKEN, fetch as typeof globalThis.fetch);

    expect(result).toEqual({ seeded: false, reason: "register_failed" });
  });
});

// ---------------------------------------------------------------------------
// actor shape invariants
// ---------------------------------------------------------------------------

describe("actor shape invariants", () => {
  it("endpoint_id follows actor:<workspace_id>:<slug> convention", async () => {
    const fetch = mockFetch();
    const result = await seedDefaultActor(BUS_BASE, WORKSPACE_ID, HOST_TOKEN, fetch as typeof globalThis.fetch);

    if (!result.seeded) throw new Error("expected seeded");
    expect(result.endpoint_id).toMatch(/^actor:[^:]+:[^:]+$/);
    expect(result.endpoint_id).toBe(`actor:${WORKSPACE_ID}:${DEFAULT_ACTOR_SLUG}`);
  });

  it("registers with bridge_id null (human actor — belongs to no bridge)", async () => {
    const fetch = mockFetch();
    await seedDefaultActor(BUS_BASE, WORKSPACE_ID, HOST_TOKEN, fetch as typeof globalThis.fetch);

    const postCall = fetch.mock.calls.find(([, opts]) => opts?.method === "POST");
    const payload = JSON.parse(postCall![1]!.body as string);
    expect(payload.bridge_id).toBeNull();
  });

  it("registers with status idle", async () => {
    const fetch = mockFetch();
    await seedDefaultActor(BUS_BASE, WORKSPACE_ID, HOST_TOKEN, fetch as typeof globalThis.fetch);

    const postCall = fetch.mock.calls.find(([, opts]) => opts?.method === "POST");
    const payload = JSON.parse(postCall![1]!.body as string);
    expect(payload.status).toBe("idle");
  });
});
