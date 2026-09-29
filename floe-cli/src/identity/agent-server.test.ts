import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IdentityAgent } from "./agent.js";
import { serveAgent, type AgentServer } from "./agent-server.js";
import { AgentUnavailableError, openAgentChannel, probeAgent } from "./connection.js";
import { IdentityClient } from "./client.js";
import { agentAddress, ensureRunDir, frame, lineReader, newAgentSecret, proof, readRunFile, writeRunFile } from "./protocol.js";
import { FAST_SCRYPT, FakeBus } from "./test-support.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function startAgent() {
  const home = mkdtempSync(join(tmpdir(), "floe-agent-server-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const bus = new FakeBus();
  const agent = new IdentityAgent({
    home, busUrl: "http://fake-bus", version: "0.3.0", lockAfterIdleMs: 60_000,
    deviceKey: async () => null, forgetDeviceKey: async () => false, hostToken: async () => bus.hostToken, fetch: bus.fetch, scrypt: FAST_SCRYPT,
  });
  const server: AgentServer = await serveAgent(agent, { home });
  cleanup.push(() => server.close());
  return { home, server, agent };
}

describe("identity agent channel", () => {
  it("serves a client that proves itself, and pushes state", async () => {
    const { home } = await startAgent();
    const client = new IdentityClient(await openAgentChannel(home, "test-surface"));
    cleanup.push(() => client.close());
    expect(client.state).toEqual({ kind: "none" });
    expect(client.agentVersion).toBe("0.3.0");
    const states: string[] = [];
    client.onState((state) => states.push(state.kind));
    await client.create({ display_name: "Ada", passphrase: "p" });
    await client.lock();
    await expect(client.unlock("wrong")).rejects.toMatchObject({ code: "wrong_passphrase" });
    expect(states).toEqual(["unlocked", "locked"]);
  });

  it("refuses a client that does not know this user's run-file secret", async () => {
    const { home } = await startAgent();
    const { createConnection } = await import("node:net");
    const socket = createConnection(readRunFile(home)!.address);
    const replies: Array<Record<string, any>> = [];
    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    socket.on("data", lineReader((message) => {
      replies.push(message);
      if (message.type === "challenge") {
        socket.write(frame({ type: "prove", client_proof: proof(newAgentSecret(), "client", String(message.server_nonce)) }));
      } else if (message.type === "welcome") {
        socket.write(frame({ type: "request", id: 1, op: "state", args: {} }));
      }
    }, () => {}));
    socket.write(frame({ type: "hello", protocol: 1, client_nonce: "abc", surface: "intruder" }));
    await closed;
    expect(replies.map((message) => message.type)).toEqual(["challenge", "error"]);
    expect(replies[1]!.error.code).toBe("handshake_failed");
  });
  it("does not talk to something squatting the agent's address that cannot prove itself", async () => {
    const home = mkdtempSync(join(tmpdir(), "floe-agent-squat-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const address = agentAddress(home);
    ensureRunDir(home);
    const received: Array<Record<string, unknown>> = [];
    const squatter = createServer((socket) => {
      socket.on("data", lineReader((message) => {
        received.push(message);
        if (message.type === "hello") {
          socket.write(frame({ type: "challenge", server_nonce: "n", server_proof: proof(newAgentSecret(), "agent", String(message.client_nonce)) }));
        }
      }, () => {}));
    });
    await new Promise<void>((resolve) => squatter.listen(address, resolve));
    cleanup.push(() => new Promise<void>((resolve) => squatter.close(() => resolve())));
    writeRunFile(home, { protocol: 1, pid: process.pid, version: "0.3.0", address, secret: newAgentSecret(), started_at: new Date().toISOString() });

    await expect(openAgentChannel(home, "surface")).rejects.toMatchObject({ reason: "impostor" });
    expect(received.map((message) => message.type)).toEqual(["hello"]);
  });

  it("reports not running when there is no agent, and a probe does not count as a surface", async () => {
    const empty = mkdtempSync(join(tmpdir(), "floe-agent-none-"));
    cleanup.push(() => rmSync(empty, { recursive: true, force: true }));
    await expect(openAgentChannel(empty, "surface")).rejects.toMatchObject({ reason: "not_running" });
    expect(await probeAgent(empty)).toBeNull();

    const { home, agent } = await startAgent();
    const attached: string[] = [];
    const original = agent.attach.bind(agent);
    agent.attach = (conn) => { attached.push(conn.surface); original(conn); };
    expect(await probeAgent(home)).toMatchObject({ version: "0.3.0", state: { kind: "none" } });
    expect(attached).toEqual([]);
  });
});
