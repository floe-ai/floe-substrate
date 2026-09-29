/**
 * Serve a Floe local channel (protocol.ts): listen, run the mutual proof, then
 * relay requests to the service and let it push messages to each connected
 * surface. Nothing is accepted before the proof completes.
 */
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { rmSync, unlinkSync } from "node:fs";
import {
  PROTOCOL_VERSION,
  channelAddress,
  channelProof,
  channelRunFilePath,
  ensureRunDir,
  frame,
  lineReader,
  newChannelSecret,
  newNonce,
  proofMatches,
  readChannelRunFile,
  writeChannelRunFile,
  type ChannelSpec,
} from "./protocol.js";

const HANDSHAKE_TIMEOUT_MS = 5_000;

/** One connected surface, as the service sees it. */
export interface ChannelPeer {
  readonly surface: string;
  send(message: Record<string, unknown>): void;
}

/** What a service provides to be served on a channel. */
export interface ChannelService<P extends ChannelPeer = ChannelPeer> {
  readonly version: string | null;
  /** Carried by the welcome message. */
  state(): unknown;
  attach(peer: P): void;
  detach(peer: P): void;
  handle(peer: P, op: string, args: Record<string, unknown>): Promise<unknown>;
}

export type ChannelServer = {
  address: string;
  close(): Promise<void>;
};

export class ChannelAddressInUseError extends Error {
  constructor(readonly address: string, label = "A Floe service") {
    super(`${label} is already serving this Floe home at ${address}.`);
    this.name = "ChannelAddressInUseError";
  }
}

export async function serveChannel(
  spec: ChannelSpec,
  service: ChannelService,
  options: { home: string; log?: (line: string) => void; secret?: string },
): Promise<ChannelServer> {
  const log = options.log ?? (() => {});
  const address = channelAddress(spec, options.home);
  const secret = options.secret ?? newChannelSecret();
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    handleConnection(spec, service, socket, secret, log);
  });

  ensureRunDir(options.home);
  await listen(server, address, spec.label);
  writeChannelRunFile(spec, options.home, {
    protocol: PROTOCOL_VERSION,
    pid: process.pid,
    version: service.version,
    address,
    secret,
    started_at: new Date().toISOString(),
  });
  log(`listening at ${address}`);

  return {
    address,
    close: () => new Promise<void>((resolve) => {
      const run = readChannelRunFile(spec, options.home);
      if (run && run.pid === process.pid) rmSync(channelRunFilePath(spec, options.home), { force: true });
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

async function listen(server: Server, address: string, label: string): Promise<void> {
  try {
    await listenOnce(server, address);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    // A Unix socket file outlives a crashed service; a live one answers.
    if (process.platform !== "win32" && !(await answers(address))) {
      unlinkSync(address);
      await listenOnce(server, address);
      return;
    }
    throw new ChannelAddressInUseError(address, label);
  }
}

function listenOnce(server: Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(address);
  });
}

function answers(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(address);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
  });
}

/** A refusal a service raises on purpose: a stable code, a safe message, optional details. */
export class ChannelError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ChannelError";
  }
}

function refusalOf(error: unknown): ChannelError {
  if (error instanceof ChannelError) return error;
  return new ChannelError("failed", error instanceof Error ? error.message : String(error));
}

function handleConnection(spec: ChannelSpec, service: ChannelService, socket: Socket, secret: string, log: (line: string) => void): void {
  let stage: "hello" | "prove" | "ready" = "hello";
  let serverNonce = "";
  let probe = false;
  let peer: ChannelPeer | null = null;
  const send = (message: unknown) => {
    if (!socket.destroyed) socket.write(frame(message));
  };
  const refuse = (reason: string) => {
    log(`refused a connection: ${reason}`);
    send({ type: "error", error: { code: "handshake_failed", message: reason } });
    socket.end();
    socket.destroySoon?.();
  };
  const timer = setTimeout(() => refuse("handshake timed out"), HANDSHAKE_TIMEOUT_MS);

  socket.on("data", lineReader((message) => {
    if (stage === "hello") {
      if (message.type !== "hello" || message.protocol !== PROTOCOL_VERSION || typeof message.client_nonce !== "string") {
        refuse(`expected hello for protocol ${PROTOCOL_VERSION}`);
        return;
      }
      serverNonce = newNonce();
      const surface = typeof message.surface === "string" && message.surface.trim() ? message.surface.trim().slice(0, 100) : "unnamed surface";
      peer = { surface, send };
      probe = message.probe === true;
      stage = "prove";
      send({
        type: "challenge",
        protocol: PROTOCOL_VERSION,
        server_nonce: serverNonce,
        server_proof: channelProof(spec, secret, "agent", message.client_nonce),
        agent_version: service.version,
      });
      return;
    }
    if (stage === "prove") {
      if (message.type !== "prove" || !proofMatches(channelProof(spec, secret, "client", serverNonce), message.client_proof)) {
        refuse("the client could not prove it runs as this user");
        return;
      }
      clearTimeout(timer);
      if (probe) {
        send({ type: "welcome", state: service.state(), agent_version: service.version });
        socket.end();
        return;
      }
      stage = "ready";
      service.attach(peer!);
      send({ type: "welcome", state: service.state(), agent_version: service.version });
      return;
    }
    if (message.type !== "request" || typeof message.op !== "string") {
      send({ type: "error", error: { code: "invalid_request", message: "Expected {type:'request', id, op, args}." } });
      return;
    }
    const id = message.id;
    const args = message.args && typeof message.args === "object" && !Array.isArray(message.args) ? message.args as Record<string, unknown> : {};
    service.handle(peer!, message.op, args).then(
      (result) => send({ type: "response", id, ok: true, result }),
      (error: unknown) => {
        const refusal = refusalOf(error);
        send({ type: "response", id, ok: false, error: { code: refusal.code, message: refusal.message, ...refusal.details } });
      },
    );
  }, (reason) => refuse(reason)));

  socket.on("error", () => {});
  socket.on("close", () => {
    clearTimeout(timer);
    if (stage === "ready" && peer) service.detach(peer);
  });
}
