/**
 * start-lock — one Floe start at a time per Floe home.
 *
 * Starting Floe (stage the runtime copy, start the bus, the identity agent and
 * the Bridge) is one sequence per home. Two starts at once — a person launching
 * twice, a surface and the terminal together — would each launch a bus, and the
 * slower one would find the other's bus "foreign" and fail.
 *
 * So a start holds its home's start address (the local-channel address scheme:
 * a named pipe on Windows, a socket in the home elsewhere) while it runs. Any
 * other start connects to that address and continues when the connection
 * closes, which happens when the holder finishes or the OS ends a holder that
 * died. The waiting start then finds the services the first one started and
 * uses them. Nothing polls.
 */
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { unlinkSync } from "node:fs";
import { channelAddress, ensureRunDir, type ChannelSpec } from "./local-channel/protocol.js";

const START_CHANNEL: ChannelSpec = {
  name: "start",
  label: "Floe start",
  runFile: "start.json",
  socketFile: "start.sock",
};

/** How long a start waits for another start of the same home before saying so. */
const WAIT_LIMIT_MS = 180_000;

export class StartInProgressError extends Error {
  readonly code = "E_START_IN_PROGRESS" as const;
  constructor(readonly home: string) {
    super(
      `Another start of Floe for ${home} has not finished after ${WAIT_LIMIT_MS / 60_000} minutes. `
      + `If nothing else is starting Floe, run \`floe stop\` and start it again.`,
    );
    this.name = "StartInProgressError";
  }
}

/** Run `start` while holding this home's start lock, waiting for any other start first. */
export async function withStartLock<T>(home: string, start: () => Promise<T>, waitLimitMs = WAIT_LIMIT_MS): Promise<T> {
  const release = await acquire(home, waitLimitMs);
  try {
    return await start();
  } finally {
    await release();
  }
}

async function acquire(home: string, waitLimitMs: number): Promise<() => Promise<void>> {
  ensureRunDir(home);
  const address = channelAddress(START_CHANNEL, home);
  const deadline = Date.now() + waitLimitMs;
  for (;;) {
    const release = await hold(address);
    if (release) return release;
    const outcome = await waitForRelease(address, deadline - Date.now());
    if (outcome === "timeout") throw new StartInProgressError(home);
    // A Unix socket file outlives a start that crashed; nothing answers on it.
    if (outcome === "stale") {
      try { unlinkSync(address); } catch { /* another start already removed it */ }
    }
  }
}

/** Take the address, or return null if another start holds it. */
function hold(address: string): Promise<(() => Promise<void>) | null> {
  const waiting = new Set<Socket>();
  const server: Server = createServer((socket) => {
    waiting.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => waiting.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(null);
      else reject(error);
    });
    server.listen(address, () => {
      resolve(() => new Promise<void>((done) => {
        server.close(() => done());
        for (const socket of waiting) socket.destroy();
      }));
    });
  });
}

/** Wait until the holder of the address lets go. */
function waitForRelease(address: string, remainingMs: number): Promise<"released" | "stale" | "timeout"> {
  if (remainingMs <= 0) return Promise.resolve("timeout");
  return new Promise((resolve) => {
    let connected = false;
    const socket = createConnection(address);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("timeout");
    }, remainingMs);
    const finish = (outcome: "released" | "stale") => {
      clearTimeout(timer);
      resolve(outcome);
    };
    socket.once("connect", () => { connected = true; });
    socket.on("data", () => {});
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (connected) return;
      finish(process.platform !== "win32" && error.code === "ECONNREFUSED" ? "stale" : "released");
    });
    socket.once("close", () => finish("released"));
  });
}
