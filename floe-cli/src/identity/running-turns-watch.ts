/**
 * Watches which turns are executing across every workspace on this host, by
 * push: one host-control Bus stream, the Bus's `running_turns_changed` push on
 * every change, and one snapshot read after the stream is live so nothing that
 * changed while it opened is missed. No polling and no hidden reconnect: when
 * the stream ends, the watcher reports it and stops.
 */
import type { RunningTurn } from "../version-switch.js";

export type RunningTurnsWatch = { close(): void };

export type RunningTurnsListener = {
  running(turns: RunningTurn[]): void;
  /** The stream ended or could not start; the watch is over. */
  ended(reason: string): void;
};

export type WatchRunningTurns = (listener: RunningTurnsListener) => RunningTurnsWatch;

type SocketLike = {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, fn: (event: any) => void): void;
};

export function busRunningTurnsWatcher(options: {
  busUrl: string;
  hostToken: () => Promise<string>;
  fetch?: typeof fetch;
  socket?: (url: string) => SocketLike;
}): WatchRunningTurns {
  const base = options.busUrl.replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  const open = options.socket ?? ((url: string) => {
    const Ctor = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
    if (!Ctor) throw new Error("This Node.js has no WebSocket, so Floe cannot follow running work.");
    return new Ctor(url);
  });

  return (listener) => {
    let over = false;
    let socket: SocketLike | null = null;
    let pushedSinceSnapshot = false;
    const end = (reason: string) => {
      if (over) return;
      over = true;
      try { socket?.close(); } catch { /* already closed */ }
      listener.ended(reason);
    };

    void (async () => {
      let token: string;
      try {
        token = await options.hostToken();
        socket = open(`${base.replace(/^http/, "ws")}/v1/events/stream`);
      } catch (error) {
        end(error instanceof Error ? error.message : String(error));
        return;
      }
      if (over) { socket.close(); return; }
      socket.addEventListener("open", () => {
        socket!.send(JSON.stringify({ type: "authenticate", bearer_token: token, start_at: "current" }));
      });
      socket.addEventListener("message", (event) => {
        if (over) return;
        let message: { type?: string; payload?: { running?: RunningTurn[] } };
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.type === "caught_up") void snapshot(token);
        if (message.type === "running_turns_changed") {
          pushedSinceSnapshot = true;
          listener.running(message.payload?.running ?? []);
        }
      });
      socket.addEventListener("close", () => end("Floe's connection closed, so running work can no longer be followed."));
      socket.addEventListener("error", () => end("Floe's connection failed, so running work can no longer be followed."));
    })();

    async function snapshot(token: string): Promise<void> {
      pushedSinceSnapshot = false;
      try {
        const response = await doFetch(`${base}/v1/local/running-turns`, { headers: { authorization: ["Bearer", token].join(" ") } });
        if (!response.ok) throw new Error(`Floe could not list the work in progress (HTTP ${response.status}).`);
        const body = (await response.json()) as { running?: RunningTurn[] };
        // A push that arrived while this read was in flight is at least as new.
        if (!over && !pushedSinceSnapshot) listener.running(body.running ?? []);
      } catch (error) {
        end(error instanceof Error ? error.message : String(error));
      }
    }

    return { close: () => { over = true; try { socket?.close(); } catch { /* already closed */ } } };
  };
}
