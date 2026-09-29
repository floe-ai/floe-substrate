import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openChannel, serveChannel } from "floe-cli/local-channel";
import { EnginesClient, type EngineState, type SignInEvent } from "floe-cli/engines";
import { ENGINES_CHANNEL } from "floe-cli/engines/protocol";
import { defaultConfig } from "../config.js";
import { BridgeDaemon } from "../daemon.js";
import { EngineControl, type EngineAccount } from "./engine-control.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function engineState(phase: EngineState["phase"], revision: number, extra: Partial<EngineState> = {}): EngineState {
  return {
    engine: "copilot", phase, revision,
    authentication: phase === "ready" ? "signed_in" : phase === "action_required" ? "signed_out" : "unknown",
    access: phase === "ready" ? "entitled" : "unknown",
    reachability: phase === "checking" ? "unknown" : "reachable",
    ...(phase === "action_required" ? { action: "sign_in" as const } : {}),
    message: phase === "ready" ? "Ready." : phase === "checking" ? "Checking." : "Sign in to GitHub Copilot.",
    checked_at: new Date(0).toISOString(),
    ...extra,
  };
}

/** Stands in for floe-runtime's CopilotEngineAccountAdapter: same surface, scripted outcomes. */
class FakeAccount extends EventEmitter implements EngineAccount {
  state = engineState("checking", 0);
  nextCheck: EngineState = engineState("action_required", 1);
  checks = 0;
  cancelled: string[] = [];
  signInRefusal: Error | null = null;

  currentState(): EngineState { return this.state; }
  async check(): Promise<EngineState> {
    this.checks += 1;
    this.set(this.nextCheck);
    return this.state;
  }
  async signIn(): Promise<{ id: string }> {
    if (this.signInRefusal) throw this.signInRefusal;
    this.emit("sign_in", { operationId: "signin-1", engine: "copilot", status: "starting", message: "Opening sign-in." });
    return { id: "signin-1" };
  }
  async cancelSignIn(id: string): Promise<void> {
    this.cancelled.push(id);
    this.emit("sign_in", { operationId: id, engine: "copilot", status: "cancelled", message: "Sign-in cancelled." });
  }
  set(state: EngineState): void {
    this.state = state;
    this.emit("state", state);
  }
}

async function serve(account: FakeAccount) {
  const home = mkdtempSync(join(tmpdir(), "floe-engines-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const control = new EngineControl(new Map([["copilot", account]]), "0.4.0");
  const server = await serveChannel(ENGINES_CHANNEL, control, { home });
  cleanup.push(() => server.close());
  const client = new EnginesClient(await openChannel(ENGINES_CHANNEL, home, "test-surface"));
  cleanup.push(() => client.close());
  return { control, client };
}

describe("engine control channel", () => {
  it("welcomes a surface with every engine's state and pushes each change", async () => {
    const account = new FakeAccount();
    const { control, client } = await serve(account);
    expect(client.state.copilot).toMatchObject({ phase: "checking", revision: 0 });
    expect(client.agentVersion).toBe("0.4.0");

    const changes: EngineState[] = [];
    client.onState((_all, changed) => changes.push(changed));
    control.start();
    await vi.waitFor(() => expect(changes.map((state) => state.phase)).toEqual(["action_required"]));
    expect(client.state.copilot).toMatchObject({ phase: "action_required", action: "sign_in" });

    account.nextCheck = engineState("ready", 2, { account: { label: "octocat", host: "github.com" } });
    await expect(client.refresh("copilot")).resolves.toMatchObject({ phase: "ready", account: { label: "octocat" } });
    await vi.waitFor(() => expect(client.state.copilot?.phase).toBe("ready"));
  });

  it("runs a sign-in by operation id, streams its progress, and cancels it", async () => {
    const account = new FakeAccount();
    const { client } = await serve(account);
    const progress: SignInEvent[] = [];
    client.onSignIn((event) => progress.push(event));

    await expect(client.signIn("copilot", { mode: "browser" })).resolves.toEqual({ operation_id: "signin-1" });
    account.emit("sign_in", { operationId: "signin-1", engine: "copilot", status: "waiting_for_person", message: "Finish in your browser." });
    await expect(client.cancelSignIn("signin-1")).resolves.toEqual({ cancelled: true });
    await vi.waitFor(() => expect(progress.map((event) => event.status)).toEqual(["starting", "waiting_for_person", "cancelled"]));
    expect(progress[0]).toEqual({ operation_id: "signin-1", engine: "copilot", status: "starting", message: "Opening sign-in." });
    expect(account.cancelled).toEqual(["signin-1"]);

    // Finished operations are forgotten.
    await expect(client.cancelSignIn("signin-1")).rejects.toMatchObject({ code: "sign_in_not_found" });
  });

  it("refuses clearly, keeping the vendor adapter's own codes", async () => {
    const account = new FakeAccount();
    const { client } = await serve(account);
    await expect(client.signIn("codex")).rejects.toMatchObject({ code: "unknown_engine" });
    await expect(client.signIn("copilot", { mode: "carrier-pigeon" as never })).rejects.toMatchObject({ code: "invalid_sign_in_mode" });
    await expect(client.signIn("copilot", { mode: "device" as never })).rejects.toMatchObject({ code: "invalid_sign_in_mode" });
    account.signInRefusal = Object.assign(new Error("A Copilot sign-in is already in progress."), { code: "sign_in_in_progress" });
    await expect(client.signIn("copilot")).rejects.toMatchObject({ code: "sign_in_in_progress", message: "A Copilot sign-in is already in progress." });
    await expect((client as any).request("launch_missiles", {})).rejects.toMatchObject({ code: "unknown_op" });
  });
});

describe("engine readiness gates work", () => {
  it("never skips a check in progress, and announces readiness once per transition", async () => {
    const account = new FakeAccount();
    const control = new EngineControl(new Map([["copilot", account]]), null);
    const ready: string[] = [];
    control.onReady((engine) => ready.push(engine));

    await expect(control.gate("copilot")).resolves.toMatchObject({ phase: "action_required" });
    expect(account.checks).toBe(1);
    await control.gate("copilot");
    expect(account.checks).toBe(1);

    account.set(engineState("ready", 2));
    account.set(engineState("ready", 3));
    expect(ready).toEqual(["copilot"]);
  });

  function daemonWith(account: FakeAccount) {
    const home = mkdtempSync(join(tmpdir(), "floe-engine-gate-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const config = defaultConfig(home);
    config.bridge.runtime_adapter = "fake";
    const configPath = join(home, "config.yaml");
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    const engines = new EngineControl(new Map([["copilot", account]]), null);
    const daemon = new BridgeDaemon(configPath, config, { engines, transport_authority: null });
    const handleBundle = vi.fn(async () => {});
    const bus = {
      reportDeliveryStatus: vi.fn(async () => ({})),
      appendRuntimeTelemetry: vi.fn(async () => ({})),
      updateEndpointStatus: vi.fn(async () => ({})),
      reportTurnEnd: vi.fn(async () => ({})),
    };
    (daemon as any).adapter = { name: "floe-runtime", engine: "copilot", handleBundle };
    (daemon as any).bus = bus;
    (daemon as any).resolveAuthProfile = async () => ({
      auth_profile: null, provider: null, model: null, source: null, model_source: null, thinking_level: null,
    });
    return { daemon, bus, handleBundle };
  }

  const delivery = () => ({
    delivery_id: `delivery:${Math.random()}`, endpoint_id: "actor:w:worker", workspace_id: "workspace:w", events: [],
  });

  it("holds work while the engine needs sign-in, then releases it the moment the engine is ready", async () => {
    const account = new FakeAccount();
    const { daemon, bus, handleBundle } = daemonWith(account);

    const held = delivery();
    await (daemon as any).handleDelivery(held);
    expect(handleBundle).not.toHaveBeenCalled();
    expect(bus.reportDeliveryStatus).toHaveBeenCalledWith(held.delivery_id, "deferred", "engine_not_ready: Sign in to GitHub Copilot.");
    expect(bus.appendRuntimeTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      kind: "engine_not_ready",
      payload: expect.objectContaining({ engine: "copilot", phase: "action_required", action: "sign_in" }),
    }));
    expect(bus.updateEndpointStatus).not.toHaveBeenCalled();

    account.set(engineState("ready", 2));
    await vi.waitFor(() => expect(bus.updateEndpointStatus).toHaveBeenCalledWith("actor:w:worker", "idle"));

    await (daemon as any).handleDelivery(delivery());
    expect(handleBundle).toHaveBeenCalledOnce();
  });

  it("checks the engine again after a turn fails", async () => {
    const account = new FakeAccount();
    account.set(engineState("ready", 1));
    account.nextCheck = engineState("action_required", 2);
    const { daemon, handleBundle } = daemonWith(account);
    const { TurnFailedError } = await import("../adapters/turn-failed-error.js");
    handleBundle.mockRejectedValueOnce(new TurnFailedError(
      "d", "actor:w:worker", "workspace:w", null, "thread", "m", "copilot", 401, "unauthorized",
    ));
    (daemon as any).bus.recordRuntimeTurnResult = vi.fn(async () => ({}));

    await (daemon as any).handleDelivery(delivery());
    await vi.waitFor(() => expect(account.checks).toBe(1));
    expect(account.state.phase).toBe("action_required");
  });
});
