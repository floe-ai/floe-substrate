/**
 * Open an authenticated connection to a Floe local channel: connect to its
 * fixed address and run the mutual proof (protocol.ts).
 */
import { createConnection, type Socket } from "node:net";
import {
  PROTOCOL_VERSION,
  channelProof,
  frame,
  lineReader,
  newNonce,
  proofMatches,
  readChannelRunFile,
  type ChannelSpec,
} from "./protocol.js";

export type Channel = {
  socket: Socket;
  /** The Floe version of the process serving the channel. */
  agentVersion: string | null;
  /** The state carried by the welcome message. */
  welcomeState: Record<string, unknown>;
  /** The config the surface connected with, when it named one. */
  configPath?: string;
  /** Replace the message handler once the handshake is complete. */
  onMessage(handler: (message: Record<string, unknown>) => void): void;
  send(message: unknown): void;
};

export class ChannelUnavailableError extends Error {
  constructor(readonly reason: "not_running" | "refused" | "impostor", message: string) {
    super(message);
    this.name = "ChannelUnavailableError";
  }
}

const HANDSHAKE_TIMEOUT_MS = 5_000;

export function openChannel(spec: ChannelSpec, home: string, surface: string, options: { probe?: boolean } = {}): Promise<Channel> {
  const label = spec.label;
  const run = readChannelRunFile(spec, home);
  if (!run) return Promise.reject(new ChannelUnavailableError("not_running", `${label} is not running.`));
  return new Promise((resolve, reject) => {
    const socket = createConnection(run.address);
    const clientNonce = newNonce();
    let stage: "challenge" | "welcome" | "open" = "challenge";
    let agentVersion: string | null = null;
    let handler: (message: Record<string, unknown>) => void = () => {};
    let settled = false;
    const fail = (error: ChannelUnavailableError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new ChannelUnavailableError("refused", `${label} did not complete the handshake.`)), HANDSHAKE_TIMEOUT_MS);

    socket.once("connect", () => {
      socket.write(frame({ type: "hello", protocol: PROTOCOL_VERSION, client_nonce: clientNonce, surface, ...(options.probe ? { probe: true } : {}) }));
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      const missing = error.code === "ENOENT" || error.code === "ECONNREFUSED";
      fail(new ChannelUnavailableError(missing ? "not_running" : "refused", missing
        ? `${label} is not running.`
        : `${label} could not be reached (${error.message}).`));
    });
    socket.on("data", lineReader((message) => {
      if (stage === "open") {
        handler(message);
        return;
      }
      if (message.type === "error") {
        const detail = (message.error as { message?: string } | undefined)?.message ?? "refused";
        fail(new ChannelUnavailableError("refused", `${label} refused this connection (${detail}).`));
        return;
      }
      if (stage === "challenge") {
        // The service must prove it knows this user's run-file secret before we
        // send anything it could misuse.
        if (message.type !== "challenge" || !proofMatches(channelProof(spec, run.secret, "agent", clientNonce), message.server_proof)) {
          fail(new ChannelUnavailableError("impostor", `Something answered at the address of ${label} but could not prove it is Floe. Nothing was sent to it.`));
          return;
        }
        agentVersion = typeof message.agent_version === "string" ? message.agent_version : null;
        stage = "welcome";
        socket.write(frame({ type: "prove", client_proof: channelProof(spec, run.secret, "client", String(message.server_nonce)) }));
        return;
      }
      if (message.type !== "welcome") {
        fail(new ChannelUnavailableError("refused", `${label} answered unexpectedly.`));
        return;
      }
      stage = "open";
      settled = true;
      clearTimeout(timer);
      resolve({
        socket,
        agentVersion,
        welcomeState: (message.state ?? {}) as Record<string, unknown>,
        onMessage: (next) => { handler = next; },
        send: (outgoing) => { if (!socket.destroyed) socket.write(frame(outgoing)); },
      });
    }, (reason) => fail(new ChannelUnavailableError("refused", `${label} sent an invalid message (${reason}).`))));
  });
}

/**
 * Is the service answering for this home? Returns its version and state, or
 * null. A probe proves itself like any client but is not attached as a surface.
 */
export async function probeChannel(spec: ChannelSpec, home: string): Promise<{ version: string | null; state: Record<string, unknown> } | null> {
  try {
    const channel = await openChannel(spec, home, "floe-probe", { probe: true });
    channel.socket.end();
    return { version: channel.agentVersion, state: channel.welcomeState };
  } catch {
    return null;
  }
}
