/**
 * The identity agent's local channel. The mechanism (address, run file, mutual
 * proof, framing) is the shared Floe local channel (../local-channel/protocol.ts);
 * this names the identity agent's instance of it.
 */
import {
  channelAddress,
  channelProof,
  channelRunFilePath,
  readChannelRunFile,
  writeChannelRunFile,
  type ChannelSpec,
  type RunFile,
} from "../local-channel/protocol.js";

export {
  MAX_LINE_BYTES,
  PROTOCOL_VERSION,
  canonicalHome,
  ensureRunDir,
  frame,
  lineReader,
  newChannelSecret as newAgentSecret,
  newNonce,
  proofMatches,
  runDir,
  type RunFile,
} from "../local-channel/protocol.js";

export const IDENTITY_CHANNEL: ChannelSpec = {
  name: "identity",
  label: "Floe's identity agent",
  runFile: "identity-agent.json",
  socketFile: "identity.sock",
};

export function agentAddress(home: string): string {
  return channelAddress(IDENTITY_CHANNEL, home);
}

export function runFilePath(home: string): string {
  return channelRunFilePath(IDENTITY_CHANNEL, home);
}

export function writeRunFile(home: string, run: RunFile): void {
  writeChannelRunFile(IDENTITY_CHANNEL, home, run);
}

export function readRunFile(home: string): RunFile | null {
  return readChannelRunFile(IDENTITY_CHANNEL, home);
}

export function proof(secret: string, role: "agent" | "client", nonce: string): string {
  return channelProof(IDENTITY_CHANNEL, secret, role, nonce);
}
