/**
 * WebSocket stream client for /v1/events/stream.
 *
 * Provides an automatic reconnect loop with exponential back-off so components
 * do not lose their live-update channel when the bus restarts or the connection
 * drops briefly.  The returned cleanup function cancels the loop immediately —
 * even if the socket is still in the CONNECTING state — without triggering the
 * "WebSocket closed before connection established" Chrome warning.
 */
import type { StreamMsg } from "./types.ts";
import { connectLocalBrowser, isLocalBrowserConnection } from "./browser.ts";

const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 16_000;

type NativeStreamRelay = {
  kind: "state" | "message";
  state?: "connecting" | "open" | "closed" | "unavailable";
  message?: StreamMsg;
  detail?: string;
};

export function subscribeEvents(
  handler: (msg: StreamMsg) => void,
  options: {
    workspaceId?: string;
    /** Start with new activity. Snapshot views must refresh authoritative state in onOpen. Reconnects still replay missed changes. */
    startAtCurrent?: boolean;
    onOpen?: () => void;
    onStateChange?: (state: "connecting" | "open" | "closed") => void;
    onUnavailable?: (detail: string) => void;
  } = {},
): () => void {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return subscribeNativeWorkspaceEvents(handler, options);
  }

  let cancelled = false;
  let ws: WebSocket | null = null;
  let backoffMs = INITIAL_BACKOFF_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let afterCursor: string | null = null;
  let freshConnection = true;
  let authenticated = false;
  let renewed = false;
  if (!options.workspaceId) {
    options.onStateChange?.("closed");
    options.onUnavailable?.("Select a workspace to receive live updates.");
    return () => {};
  }

  function connect(): void {
    if (cancelled) return;
    options.onStateChange?.("connecting");
    try {
      authenticated = false;
      const url = new URL("/v1/events/stream", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(url.toString());
    } catch {
      // WebSocket unavailable (test/SSR env without browser globals)
      options.onStateChange?.("closed");
      return;
    }

    ws.onmessage = (event) => {
      if (cancelled) return;
      try {
        const msg = JSON.parse(event.data) as StreamMsg;
        if (msg.type === "authenticated") {
          authenticated = true;
          freshConnection = false;
          const cursor = (msg.payload as { cursor?: string | null } | undefined)?.cursor;
          if (cursor !== undefined) afterCursor = cursor;
          renewed = false;
          backoffMs = INITIAL_BACKOFF_MS;
          options.onStateChange?.("open");
          options.onOpen?.();
          return;
        }
        if (!authenticated) return;
        const cursor = msg.cursor ?? (msg.type === "caught_up" ? (msg.payload as { cursor?: string }).cursor : undefined);
        if (cursor) afterCursor = cursor;
        if (msg.type === "caught_up") return;
        handler(msg);
      } catch {
        // ignore non-JSON frames
      }
    };

    ws.onopen = () => {
      if (cancelled) {
        ws?.close();
        return;
      }
      ws?.send(JSON.stringify({ type: "authenticate", browser_session: true, workspace_id: options.workspaceId,
        ...(options.startAtCurrent && freshConnection ? { start_at: "current" } : { after_cursor: afterCursor }) }));
    };

    ws.onclose = (event) => {
      if (cancelled) return;
      options.onStateChange?.("closed");
      if (event.code === 4401 || event.code === 4403) {
        if (!renewed && isLocalBrowserConnection()) {
          renewed = true;
          void connectLocalBrowser().then(connected => {
            if (cancelled) return;
            if (connected) connect();
            else options.onUnavailable?.("Floe could not restore this local connection. Reload to try again.");
          }).catch(() => {
            if (!cancelled) options.onUnavailable?.("Floe could not restore this local connection. Reload to try again.");
          });
          return;
        }
        options.onUnavailable?.("Your browser connection expired. Connect to Floe again.");
        return;
      }
      retryTimer = setTimeout(() => {
        if (!cancelled) connect();
      }, backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    };

    ws.onerror = () => {
      // `onclose` fires after `onerror`, so reconnect is handled there.
    };
  }

  connect();

  return () => {
    cancelled = true;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      // If CONNECTING: let the socket finish opening; onopen will close it.
      // If CLOSING/CLOSED: no action needed.
      ws = null;
    }
  };
}

function subscribeNativeWorkspaceEvents(
  handler: (msg: StreamMsg) => void,
  options: {
    workspaceId?: string;
    startAtCurrent?: boolean;
    onOpen?: () => void;
    onStateChange?: (state: "connecting" | "open" | "closed") => void;
    onUnavailable?: (detail: string) => void;
  },
): () => void {
  let cancelled = false;
  let streamId: string | null = null;
  if (!options.workspaceId) {
    options.onStateChange?.("closed");
    options.onUnavailable?.("Select a Workspace to receive live updates.");
    return () => {};
  }

  void import("@tauri-apps/api/core")
    .then(async ({ Channel, invoke }) => {
      if (cancelled) return;
      const channel = new Channel<NativeStreamRelay>();
      channel.onmessage = event => {
        if (cancelled) return;
        if (event.kind === "message" && event.message) {
          handler(event.message);
          return;
        }
        if (event.state === "open") {
          options.onStateChange?.("open");
          options.onOpen?.();
        } else if (event.state === "connecting" || event.state === "closed") {
          options.onStateChange?.(event.state);
        } else if (event.state === "unavailable") {
          options.onStateChange?.("closed");
          options.onUnavailable?.(event.detail ?? "Authenticated live updates are unavailable.");
        }
      };
      const opened = await invoke<string>("open_workspace_stream", {
        workspaceId: options.workspaceId,
        ...(options.startAtCurrent ? { startAtCurrent: true } : {}),
        onEvent: channel,
      });
      if (cancelled) {
        await invoke("close_workspace_stream", { streamId: opened });
      } else {
        streamId = opened;
      }
    })
    .catch(error => {
      if (cancelled) return;
      options.onStateChange?.("closed");
      options.onUnavailable?.(error instanceof Error ? error.message : String(error));
    });

  return () => {
    cancelled = true;
    if (streamId) {
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("close_workspace_stream", { streamId }))
        .catch(() => undefined);
    }
  };
}
