/**
 * Open an authenticated channel to the identity agent serving a Floe home:
 * connect to its fixed address, and run the mutual proof (protocol.ts). Used by
 * the surface client and by `floe start`/`floe status` to see whether an agent
 * is answering.
 */
import { createConnection, type Socket } from "node:net";
import { PROTOCOL_VERSION, frame, lineReader, newNonce, proof, proofMatches, readRunFile } from "./protocol.js";

export type AgentChannel = {
  socket: Socket;
  agentVersion: string | null;
  /** The state carried by the welcome message. */
  welcomeState: Record<string, unknown>;
  /** Replace the message handler once the handshake is complete. */
  onMessage(handler: (message: Record<string, unknown>) => void): void;
  send(message: unknown): void;
};

export class AgentUnavailableError extends Error {
  constructor(readonly reason: "not_running" | "refused" | "impostor", message: string) {
    super(message);
    this.name = "AgentUnavailableError";
  }
}

const HANDSHAKE_TIMEOUT_MS = 5_000;

export function openAgentChannel(home: string, surface: string, options: { probe?: boolean } = {}): Promise<AgentChannel> {
  const run = readRunFile(home);
  if (!run) return Promise.reject(new AgentUnavailableError("not_running", "Floe's identity agent is not running."));
  return new Promise((resolve, reject) => {
    const socket = createConnection(run.address);
    const clientNonce = newNonce();
    let stage: "challenge" | "welcome" | "open" = "challenge";
    let agentVersion: string | null = null;
    let handler: (message: Record<string, unknown>) => void = () => {};
    let settled = false;
    const fail = (error: AgentUnavailableError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new AgentUnavailableError("refused", "Floe's identity agent did not complete the handshake.")), HANDSHAKE_TIMEOUT_MS);

    socket.once("connect", () => {
      socket.write(frame({ type: "hello", protocol: PROTOCOL_VERSION, client_nonce: clientNonce, surface, ...(options.probe ? { probe: true } : {}) }));
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      const missing = error.code === "ENOENT" || error.code === "ECONNREFUSED";
      fail(new AgentUnavailableError(missing ? "not_running" : "refused", missing
        ? "Floe's identity agent is not running."
        : `Floe's identity agent could not be reached (${error.message}).`));
    });
    socket.on("data", lineReader((message) => {
      if (stage === "open") {
        handler(message);
        return;
      }
      if (message.type === "error") {
        const detail = (message.error as { message?: string } | undefined)?.message ?? "refused";
        fail(new AgentUnavailableError("refused", `Floe's identity agent refused this connection (${detail}).`));
        return;
      }
      if (stage === "challenge") {
        // The agent must prove it knows this user's run-file secret before we
        // send anything it could misuse.
        if (message.type !== "challenge" || !proofMatches(proof(run.secret, "agent", clientNonce), message.server_proof)) {
          fail(new AgentUnavailableError("impostor", "Something answered at Floe's identity agent address but could not prove it is Floe's agent. Nothing was sent to it."));
          return;
        }
        agentVersion = typeof message.agent_version === "string" ? message.agent_version : null;
        stage = "welcome";
        socket.write(frame({ type: "prove", client_proof: proof(run.secret, "client", String(message.server_nonce)) }));
        return;
      }
      if (message.type !== "welcome") {
        fail(new AgentUnavailableError("refused", "Floe's identity agent answered unexpectedly."));
        return;
      }
      stage = "open";
      settled = true;
      clearTimeout(timer);
      resolve({
        socket,
        agentVersion,
        welcomeState: (message.state ?? { kind: "none" }) as Record<string, unknown>,
        onMessage: (next) => { handler = next; },
        send: (outgoing) => { if (!socket.destroyed) socket.write(frame(outgoing)); },
      });
    }, (reason) => fail(new AgentUnavailableError("refused", `Floe's identity agent sent an invalid message (${reason}).`))));
  });
}

/**
 * Is an agent answering for this home? Returns its version and state, or null.
 * A probe proves itself like any client but is not counted as a connected
 * surface, so checking status never extends how long the key stays unlocked.
 */
export async function probeAgent(home: string): Promise<{ version: string | null; state: Record<string, unknown> } | null> {
  try {
    const channel = await openAgentChannel(home, "floe-probe", { probe: true });
    channel.socket.end();
    return { version: channel.agentVersion, state: channel.welcomeState };
  } catch {
    return null;
  }
}
