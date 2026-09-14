import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeEvents } from "./stream.ts";
const browser = vi.hoisted(() => ({ connectLocalBrowser: vi.fn(), isLocalBrowserConnection: vi.fn(() => false) }));
vi.mock("./browser.ts", () => browser);

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  channel: null as { onmessage?: (event: unknown) => void } | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: native.invoke,
  Channel: class {
    onmessage?: (event: unknown) => void;
    constructor() { native.channel = this; }
  },
}));

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {}
  send = vi.fn();
}

describe("event stream readiness", () => {
  afterEach(() => {
    FakeWebSocket.instances = [];
    vi.useRealTimers();
    vi.unstubAllGlobals();
    native.invoke.mockReset();
    native.channel = null;
    browser.connectLocalBrowser.mockReset();
    browser.isLocalBrowserConnection.mockReturnValue(false);
  });

  it("announces when the live stream is ready for a fresh snapshot", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onOpen = vi.fn();
    const unsubscribe = subscribeEvents(() => {}, { workspaceId: "workspace:one", onOpen });

    FakeWebSocket.instances[0]?.onopen?.();
    expect(onOpen).not.toHaveBeenCalled();
    expect(JSON.parse(FakeWebSocket.instances[0]!.send.mock.calls[0]![0])).toEqual({ type: "authenticate", browser_session: true, workspace_id: "workspace:one", after_cursor: null });
    FakeWebSocket.instances[0]?.onmessage?.({ data: JSON.stringify({ type: "authenticated", payload: { workspace_id: "workspace:one" } }) } as MessageEvent);
    expect(onOpen).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("reports connection loss and reconnect attempts", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onStateChange = vi.fn();
    const unsubscribe = subscribeEvents(() => {}, { workspaceId: "workspace:one", onStateChange });

    expect(onStateChange).toHaveBeenLastCalledWith("connecting");
    FakeWebSocket.instances[0]?.onopen?.();
    FakeWebSocket.instances[0]?.onmessage?.({ data: JSON.stringify({ type: "authenticated" }) } as MessageEvent);
    expect(onStateChange).toHaveBeenLastCalledWith("open");

    FakeWebSocket.instances[0]?.onclose?.({ code: 1006 });
    expect(onStateChange).toHaveBeenLastCalledWith("closed");
    vi.advanceTimersByTime(250);
    expect(onStateChange).toHaveBeenLastCalledWith("connecting");

    unsubscribe();
  });

  it("takes a fresh snapshot without historical replay, then resumes from the accepted cursor", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onOpen = vi.fn();
    const stop = subscribeEvents(() => {}, { workspaceId: "workspace:one", startAtCurrent: true, onOpen });
    const first = FakeWebSocket.instances[0]!;
    first.onopen?.();
    expect(JSON.parse(first.send.mock.calls[0]![0])).toEqual({ type: "authenticate", browser_session: true,
      workspace_id: "workspace:one", start_at: "current" });
    first.onmessage?.({ data: JSON.stringify({ type: "authenticated", payload: { cursor: "snapshot-cursor" } }) } as MessageEvent);
    expect(onOpen).toHaveBeenCalledOnce();
    first.onclose?.({ code: 1006 });
    vi.advanceTimersByTime(250);
    const second = FakeWebSocket.instances[1]!;
    second.onopen?.();
    expect(JSON.parse(second.send.mock.calls[0]![0])).toEqual({ type: "authenticate", browser_session: true,
      workspace_id: "workspace:one", after_cursor: "snapshot-cursor" });
    stop();
  });

  it("replays from the accepted cursor and stops reconnecting when authorization expires", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onUnavailable = vi.fn();
    const handler = vi.fn();
    const stop = subscribeEvents(handler, { workspaceId: "workspace:one", onUnavailable });
    const first = FakeWebSocket.instances[0]!;
    first.onopen?.();
    first.onmessage?.({ data: JSON.stringify({ type: "event_submitted", cursor: "private-before-auth" }) } as MessageEvent);
    expect(handler).not.toHaveBeenCalled();
    first.onmessage?.({ data: JSON.stringify({ type: "authenticated" }) } as MessageEvent);
    first.onmessage?.({ data: JSON.stringify({ type: "event_submitted", cursor: "cursor-1" }) } as MessageEvent);
    first.onclose?.({ code: 1006 });
    vi.advanceTimersByTime(250);
    const second = FakeWebSocket.instances[1]!;
    second.onopen?.();
    expect(JSON.parse(second.send.mock.calls[0]![0]).after_cursor).toBe("cursor-1");
    second.onclose?.({ code: 4401 });
    vi.runAllTimers();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(onUnavailable).toHaveBeenCalledWith(expect.stringContaining("expired"));
    stop();
  });

  it("restores an expired local connection once without asking for pairing", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    browser.isLocalBrowserConnection.mockReturnValue(true);
    browser.connectLocalBrowser.mockResolvedValue(true);
    const stop = subscribeEvents(() => {}, { workspaceId: "workspace:one" });
    FakeWebSocket.instances[0]!.onclose?.({ code: 4401 });
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    FakeWebSocket.instances[1]!.onclose?.({ code: 4401 });
    expect(browser.connectLocalBrowser).toHaveBeenCalledOnce();
    stop();
  });

  it("uses the native authenticated relay without exposing its bearer", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    native.invoke.mockResolvedValue("stream-one");
    const handler = vi.fn();
    const onOpen = vi.fn();
    const unsubscribe = subscribeEvents(handler, { workspaceId: "workspace:one", onOpen, startAtCurrent: true });

    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("open_workspace_stream", {
      workspaceId: "workspace:one",
      onEvent: expect.anything(),
      startAtCurrent: true,
    }));
    native.channel?.onmessage?.({ kind: "state", state: "open" });
    native.channel?.onmessage?.({ kind: "message", message: { type: "event_submitted", payload: {}, at: "now", cursor: "cursor-1" } });

    expect(onOpen).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: "event_submitted", cursor: "cursor-1" }));
    expect(JSON.stringify(native.invoke.mock.calls)).not.toMatch(/bearer|token/i);
    unsubscribe();
  });
});
