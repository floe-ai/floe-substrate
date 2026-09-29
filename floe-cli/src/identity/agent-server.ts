/**
 * Carries the identity agent over its local channel. The listening, mutual
 * proof and relay are the shared Floe local channel (../local-channel/server.ts).
 */
import type { IdentityAgent } from "./agent.js";
import { ChannelAddressInUseError, serveChannel, type ChannelServer } from "../local-channel/server.js";
import { IDENTITY_CHANNEL } from "./protocol.js";

export type AgentServer = ChannelServer;

export { ChannelAddressInUseError as AgentAddressInUseError };

export function serveAgent(
  agent: IdentityAgent,
  options: { home: string; log?: (line: string) => void; secret?: string },
): Promise<AgentServer> {
  return serveChannel(IDENTITY_CHANNEL, agent, options);
}
