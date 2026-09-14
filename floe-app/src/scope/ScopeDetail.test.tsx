/**
 * Tests for ScopeDetail.tsx push subscriptions (P9 — zero-poll UI).
 *
 * Verifies that the contexts list subscribes to the bus WS stream and reloads
 * when `context_created` or `event_submitted` arrives for this scope.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { ScopeDetail } from "./ScopeDetail.tsx";
import * as client from "../bus-client/client.ts";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../bus-client/client.ts", () => ({
  listContextsForScope: vi.fn(),
}));

// Mock Ops to avoid rendering its full subtree
vi.mock("./Ops.tsx", () => ({
  Ops: () => <div data-testid="ops-stub" />,
}));

// We need fetch for the extension views call — return empty list
(globalThis as any).fetch = vi.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({ extensions: [] }) })
);

// Capture subscribeEvents handlers
type StreamHandler = (msg: { type: string; payload: Record<string, unknown> }) => void;
let capturedHandlers: StreamHandler[] = [];

vi.mock("../bus-client/stream.ts", () => ({
  subscribeEvents: vi.fn((handler: StreamHandler) => {
    capturedHandlers.push(handler);
    return () => {
      capturedHandlers = capturedHandlers.filter(h => h !== handler);
    };
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emit(type: string, payload: Record<string, unknown> = {}): void {
  for (const h of [...capturedHandlers]) {
    h({ type, payload });
  }
}

const WS_ID = "ws-1";
const SCOPE_ID = "scope-1";

const SCOPE = {
  scope_id: SCOPE_ID,
  workspace_id: WS_ID,
  title: "My Scope",
  description: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    context_id: "ctx-1",
    workspace_id: WS_ID,
    scope_id: SCOPE_ID,
    parent_context_id: null,
    created_by_endpoint_id: null,
    created_at: new Date().toISOString(),
    last_event_at: null,
    participants: [],
    title: null,
    first_message_preview: "Hello",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  capturedHandlers = [];
  vi.clearAllMocks();
  vi.mocked(client.listContextsForScope).mockResolvedValue([]);
});

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// context_created push subscription
// ---------------------------------------------------------------------------

describe("ScopeDetail — contexts list push subscription", () => {
  it("does not expose raw Scope deletion from the developer observatory", async () => {
    render(
      <ScopeDetail
        scope={SCOPE as any}
        workspaceId={WS_ID}
        selectedContextId={null}
        onSelectContext={vi.fn()}
      />
    );

    await screen.findByText("No contexts in this scope yet.");
    expect(screen.queryByRole("button", { name: /delete scope/i })).toBeNull();
  });

  it("reloads contexts when context_created arrives for this scope", async () => {
    const ctx1 = makeContext({ context_id: "ctx-1", first_message_preview: "Hello world" });
    vi.mocked(client.listContextsForScope).mockResolvedValueOnce([]);

    render(
      <ScopeDetail
        scope={SCOPE as any}
        workspaceId={WS_ID}
        selectedContextId={null}
        onSelectContext={vi.fn()}
      />
    );

    await screen.findByText("No contexts in this scope yet.");
    expect(vi.mocked(client.listContextsForScope)).toHaveBeenCalledTimes(1);

    vi.mocked(client.listContextsForScope).mockResolvedValueOnce([ctx1 as any]);

    await act(async () => {
      emit("context_created", {
        context: { workspace_id: WS_ID, scope_id: SCOPE_ID, context_id: "ctx-1" },
      });
    });

    expect(vi.mocked(client.listContextsForScope)).toHaveBeenCalledTimes(2);
    await screen.findByText("Hello world");
  });

  it("reloads contexts when event_submitted arrives for this scope", async () => {
    vi.mocked(client.listContextsForScope).mockResolvedValue([]);
    render(
      <ScopeDetail
        scope={SCOPE as any}
        workspaceId={WS_ID}
        selectedContextId={null}
        onSelectContext={vi.fn()}
      />
    );

    await screen.findByText("No contexts in this scope yet.");
    const callsBefore = vi.mocked(client.listContextsForScope).mock.calls.length;

    await act(async () => {
      emit("event_submitted", {
        event: { workspace_id: WS_ID, scope_id: SCOPE_ID },
      });
    });

    expect(vi.mocked(client.listContextsForScope).mock.calls.length).toBe(callsBefore + 1);
  });

  it("does NOT reload when context_created is for a different scope", async () => {
    vi.mocked(client.listContextsForScope).mockResolvedValue([]);
    render(
      <ScopeDetail
        scope={SCOPE as any}
        workspaceId={WS_ID}
        selectedContextId={null}
        onSelectContext={vi.fn()}
      />
    );

    await screen.findByText("No contexts in this scope yet.");
    const callsBefore = vi.mocked(client.listContextsForScope).mock.calls.length;

    await act(async () => {
      emit("context_created", {
        context: { workspace_id: WS_ID, scope_id: "other-scope" },
      });
    });

    expect(vi.mocked(client.listContextsForScope).mock.calls.length).toBe(callsBefore);
  });

  it("cleans up subscriptions on unmount (no leaks)", async () => {
    vi.mocked(client.listContextsForScope).mockResolvedValue([]);
    const { unmount } = render(
      <ScopeDetail
        scope={SCOPE as any}
        workspaceId={WS_ID}
        selectedContextId={null}
        onSelectContext={vi.fn()}
      />
    );

    await screen.findByText("No contexts in this scope yet.");
    const handlersBeforeUnmount = capturedHandlers.length;

    unmount();

    expect(capturedHandlers.length).toBeLessThan(handlersBeforeUnmount);
  });
});
