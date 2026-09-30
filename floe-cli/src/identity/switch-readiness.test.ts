import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IdentityAgent, type AgentConnection } from "./agent.js";
import { busRunningTurnsWatcher, type RunningTurnsListener } from "./running-turns-watch.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const TURN = { workspace_id: "workspace:a", endpoint_id: "actor:a:writer", name: "Writer" };

function setup() {
  const home = mkdtempSync(join(tmpdir(), "floe-readiness-"));
  homes.push(home);
  const watches: Array<{ listener: RunningTurnsListener; closed: boolean }> = [];
  const agent = new IdentityAgent({
    home,
    busUrl: "http://fake-bus",
    version: "0.4.9",
    lockAfterIdleMs: 60_000,
    deviceKey: async () => null,
    forgetDeviceKey: async () => false,
    hostToken: async () => "host-token",
    watchRunningTurns: (listener) => {
      const watch = { listener, closed: false };
      watches.push(watch);
      return { close: () => { watch.closed = true; } };
    },
  });
  const connection = (surface: string) => {
    const messages: Array<Record<string, any>> = [];
    const conn: AgentConnection = { surface, send: (message) => messages.push(message) };
    agent.attach(conn);
    const readiness = () => messages.filter((m) => m.type === "switch_readiness").map((m) => m.readiness);
    return { conn, readiness };
  };
  return { agent, watches, connection };
}

describe("switch readiness on the identity channel", () => {
  it("pushes readiness to each following surface on every change, from one shared watch", async () => {
    const { agent, watches, connection } = setup();
    const a = connection("console");
    const b = connection("star-map");
    const idle = connection("other");

    expect(await agent.handle(a.conn, "watch_switch_readiness", {})).toEqual({ following: true });
    watches[0]!.listener.running([TURN]);
    await agent.handle(b.conn, "watch_switch_readiness", {});
    expect(watches).toHaveLength(1);
    // A late follower gets the current readiness at once.
    expect(b.readiness()).toEqual([{ following: true, ready: false, running: [TURN] }]);

    watches[0]!.listener.running([]);
    expect(a.readiness()).toEqual([
      { following: true, ready: false, running: [TURN] },
      { following: true, ready: true, running: [] },
    ]);
    expect(b.readiness().at(-1)).toEqual({ following: true, ready: true, running: [] });
    expect(idle.readiness()).toEqual([]);

    await agent.handle(a.conn, "unwatch_switch_readiness", {});
    expect(watches[0]!.closed).toBe(false);
    agent.detach(b.conn);
    expect(watches[0]!.closed).toBe(true);
  });

  it("says when following ended, and following again starts a new watch", async () => {
    const { agent, watches, connection } = setup();
    const a = connection("console");
    await agent.handle(a.conn, "watch_switch_readiness", {});
    watches[0]!.listener.ended("Floe's connection closed, so running work can no longer be followed.");
    expect(a.readiness().at(-1)).toEqual({ following: false, reason: "Floe's connection closed, so running work can no longer be followed." });
    watches[0]!.listener.running([TURN]);
    expect(a.readiness()).toHaveLength(1);

    await agent.handle(a.conn, "watch_switch_readiness", {});
    expect(watches).toHaveLength(2);
  });
});

class FakeSocket {
  sent: any[] = [];
  closed = false;
  private handlers = new Map<string, Array<(event: any) => void>>();
  addEventListener(type: string, fn: (event: any) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; }
  emit(type: string, event: any = {}) { for (const fn of this.handlers.get(type) ?? []) fn(event); }
  push(message: object) { this.emit("message", { data: JSON.stringify(message) }); }
}

const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

describe("the Bus running-turns watcher", () => {
  function start(snapshot: () => Promise<Response>) {
    const socket = new FakeSocket();
    const urls: string[] = [];
    const seen: unknown[] = [];
    const watch = busRunningTurnsWatcher({
      busUrl: "http://127.0.0.1:5399",
      hostToken: async () => "host-token",
      fetch: (async (url: string) => { urls.push(url); return snapshot(); }) as unknown as typeof fetch,
      socket: (url) => { urls.push(url); return socket; },
    })({ running: (turns) => seen.push(turns), ended: (reason) => seen.push({ ended: reason }) });
    return { socket, urls, seen, watch };
  }
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

  it("authenticates as the host, reads a snapshot once live, then relays each change", async () => {
    const { socket, urls, seen, watch } = start(async () => json({ running: [TURN] }));
    await settle();
    socket.emit("open");
    expect(socket.sent).toEqual([{ type: "authenticate", bearer_token: "host-token", start_at: "current" }]);
    socket.push({ type: "caught_up" });
    await settle();
    expect(urls).toEqual(["ws://127.0.0.1:5399/v1/events/stream", "http://127.0.0.1:5399/v1/local/running-turns"]);
    socket.push({ type: "running_turns_changed", payload: { running: [] } });
    socket.push({ type: "event_created", payload: {} });
    expect(seen).toEqual([[TURN], []]);
    watch.close();
    expect(socket.closed).toBe(true);
  });

  it("drops a snapshot overtaken by a push, and reports the stream ending once", async () => {
    let answer!: (response: Response) => void;
    const { socket, seen } = start(() => new Promise((resolve) => { answer = resolve; }));
    await settle();
    socket.emit("open");
    socket.push({ type: "caught_up" });
    await settle();
    socket.push({ type: "running_turns_changed", payload: { running: [] } });
    answer(json({ running: [TURN] }));
    await settle();
    expect(seen).toEqual([[]]);
    socket.emit("close");
    socket.emit("error");
    expect(seen).toEqual([[], { ended: "Floe's connection closed, so running work can no longer be followed." }]);
  });
});
