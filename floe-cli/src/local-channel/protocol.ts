/**
 * A Floe local channel: how a same-user service (the identity agent, the
 * Bridge's engine control) listens, how each side proves it runs as the same
 * OS user, and how messages are framed. Each service names its channel with a
 * ChannelSpec; everything else is shared.
 *
 * Address: fixed by the Floe home, so nothing has to be looked up. Windows uses
 * a named pipe; macOS and Linux use a Unix socket inside the Floe home.
 *
 * Proof: on every start the service writes a fresh secret to a run file in the
 * Floe home that only this OS user can read. Each side proves knowledge of it
 * with an HMAC over the other side's nonce; the secret itself never crosses the
 * channel. The client proves itself so another OS user cannot use the service.
 * The service proves itself so a process squatting the pipe name (a Windows
 * pipe name is machine-wide) cannot pose as it.
 *
 * Framing: one JSON object per line, capped in size.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PROTOCOL_VERSION = 1;
export const MAX_LINE_BYTES = 1024 * 1024;

export type ChannelSpec = {
  /** Short name. The pipe name and the proof label derive from it. */
  name: string;
  /** How a message to a person names the service, e.g. "Floe's identity agent". */
  label: string;
  /** Run file name inside <home>/run. */
  runFile: string;
  /** Unix socket name inside <home>/run (not used on Windows). */
  socketFile: string;
};

/** The home as the run file and the pipe name see it: absolute, case-folded on Windows. */
export function canonicalHome(home: string): string {
  const absolute = resolve(home);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export function channelAddress(spec: ChannelSpec, home: string): string {
  if (process.platform === "win32") {
    const digest = createHash("sha256").update(canonicalHome(home)).digest("hex").slice(0, 24);
    return `\\\\.\\pipe\\floe-${spec.name}-${digest}`;
  }
  return join(home, "run", spec.socketFile);
}

export function runDir(home: string): string {
  return join(home, "run");
}

export function channelRunFilePath(spec: ChannelSpec, home: string): string {
  return join(runDir(home), spec.runFile);
}

export type RunFile = {
  protocol: number;
  pid: number;
  version: string | null;
  address: string;
  secret: string;
  started_at: string;
};

export function newChannelSecret(): string {
  return randomBytes(32).toString("hex");
}

/** The run directory holds the run files and, off Windows, the sockets. */
export function ensureRunDir(home: string): void {
  const dir = runDir(home);
  mkdirSync(dir, { recursive: true });
  try { chmodSync(dir, 0o700); } catch { /* Windows: profile ACL */ }
}

export function writeChannelRunFile(spec: ChannelSpec, home: string, run: RunFile): void {
  ensureRunDir(home);
  const path = channelRunFilePath(spec, home);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(run, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

export function readChannelRunFile(spec: ChannelSpec, home: string): RunFile | null {
  const path = channelRunFilePath(spec, home);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<RunFile>;
    if (typeof value.secret !== "string" || typeof value.address !== "string" || typeof value.pid !== "number") return null;
    return value as RunFile;
  } catch {
    return null;
  }
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

export function channelProof(spec: ChannelSpec, secret: string, role: "agent" | "client", nonce: string): string {
  return createHmac("sha256", Buffer.from(secret, "hex")).update(`floe-${spec.name}:${role}:${nonce}`).digest("hex");
}

export function proofMatches(expected: string, received: unknown): boolean {
  if (typeof received !== "string" || received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

/** Split a byte stream into JSON messages. Calls onError for oversize or bad JSON. */
export function lineReader(onMessage: (message: Record<string, unknown>) => void, onError: (reason: string) => void) {
  let buffer = "";
  return (chunk: Buffer | string) => {
    buffer += chunk.toString();
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES && !buffer.includes("\n")) {
      buffer = "";
      onError("message too large");
      return;
    }
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        onError("invalid JSON");
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        onError("message is not an object");
        return;
      }
      onMessage(parsed as Record<string, unknown>);
    }
  };
}

export function frame(message: unknown): string {
  return JSON.stringify(message) + "\n";
}
