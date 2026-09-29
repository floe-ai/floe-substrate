/**
 * Carries the identity agent over its local channel (see protocol.ts): listens,
 * runs the mutual proof, then relays requests to the agent and pushes its
 * events. Nothing is accepted before the proof completes.
 */
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { rmSync, unlinkSync } from "node:fs";
import { AgentError, type AgentConnection, type IdentityAgent } from "./agent.js";
import {
  PROTOCOL_VERSION,
  agentAddress,
  frame,
  lineReader,
  newAgentSecret,
  newNonce,
  proof,
  proofMatches,
  readRunFile,
  ensureRunDir,
  runFilePath,
  writeRunFile,
} from "./protocol.js";

const HANDSHAKE_TIMEOUT_MS = 5_000;

export type AgentServer = {
  address: string;
  close(): Promise<void>;
};

export class AgentAddressInUseError extends Error {
  constructor(readonly address: string) {
    super(`Another identity agent is already serving this Floe home at ${address}.`);
    this.name = "AgentAddressInUseError";
  }
}

export async function serveAgent(
  agent: IdentityAgent,
  options: { home: string; log?: (line: string) => void; secret?: string },
): Promise<AgentServer> {
  const log = options.log ?? (() => {});
  const address = agentAddress(options.home);
  const secret = options.secret ?? newAgentSecret();
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    handleConnection(agent, socket, secret, log);
  });

  ensureRunDir(options.home);
  await listen(server, address);
  writeRunFile(options.home, {
    protocol: PROTOCOL_VERSION,
    pid: process.pid,
    version: agent.version,
    address,
    secret,
    started_at: new Date().toISOString(),
  });
  log(`listening at ${address}`);

  return {
    address,
    close: () => new Promise<void>((resolve) => {
      const run = readRunFile(options.home);
      if (run && run.pid === process.pid) rmSync(runFilePath(options.home), { force: true });
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

async function listen(server: Server, address: string): Promise<void> {
  try {
    await listenOnce(server, address);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    // A Unix socket file outlives a crashed agent; a live one answers.
    if (process.platform !== "win32" && !(await answers(address))) {
      unlinkSync(address);
      await listenOnce(server, address);
      return;
    }
    throw new AgentAddressInUseError(address);
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

function handleConnection(agent: IdentityAgent, socket: Socket, secret: string, log: (line: string) => void): void {
  let stage: "hello" | "prove" | "ready" = "hello";
  let serverNonce = "";
  let probe = false;
  let connection: (AgentConnection & { surface: string }) | null = null;
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
      connection = { surface, send };
      probe = message.probe === true;
      stage = "prove";
      send({
        type: "challenge",
        protocol: PROTOCOL_VERSION,
        server_nonce: serverNonce,
        server_proof: proof(secret, "agent", message.client_nonce),
        agent_version: agent.version,
      });
      return;
    }
    if (stage === "prove") {
      if (message.type !== "prove" || !proofMatches(proof(secret, "client", serverNonce), message.client_proof)) {
        refuse("the client could not prove it runs as this user");
        return;
      }
      clearTimeout(timer);
      if (probe) {
        send({ type: "welcome", state: agent.state(), agent_version: agent.version });
        socket.end();
        return;
      }
      stage = "ready";
      agent.attach(connection!);
      send({ type: "welcome", state: agent.state(), agent_version: agent.version });
      return;
    }
    if (message.type !== "request" || typeof message.op !== "string") {
      send({ type: "error", error: { code: "invalid_request", message: "Expected {type:'request', id, op, args}." } });
      return;
    }
    const id = message.id;
    const args = message.args && typeof message.args === "object" && !Array.isArray(message.args) ? message.args as Record<string, unknown> : {};
    agent.handle(connection!, message.op, args).then(
      (result) => send({ type: "response", id, ok: true, result }),
      (error: unknown) => {
        const agentError = error instanceof AgentError ? error : new AgentError("failed", error instanceof Error ? error.message : String(error));
        send({ type: "response", id, ok: false, error: { code: agentError.code, message: agentError.message, ...agentError.details } });
      },
    );
  }, (reason) => refuse(reason)));

  socket.on("error", () => {});
  socket.on("close", () => {
    clearTimeout(timer);
    if (stage === "ready" && connection) agent.detach(connection);
  });
}
