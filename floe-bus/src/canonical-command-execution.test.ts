import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defaultConfig } from "./config.js";
import type { CommandDefinitionContent } from "./command-definitions.js";
import type {
  CommandHostInvocation,
  CommandHostResult,
  CommandRuntimeHost,
} from "./command-runtime.js";
import { CommandRuntimeHostError } from "./isolated-command-host.js";
import type { ScopeCompositionContent } from "./scope-compositions.js";
import { registerExecutableActorFixture } from "./executable-actor-test-fixture.js";
import { BusStore, ScopeOutputAuthorityError } from "./store.js";

const broadcast = () => {};

class PlannedCommandHost implements CommandRuntimeHost {
  readonly invocations: CommandHostInvocation[] = [];
  readonly cancelled: string[] = [];
  constructor(private readonly plans: Array<CommandHostResult | Error | "pending">) {}
  supports(): boolean { return true; }
  invoke(input: CommandHostInvocation): Promise<CommandHostResult> {
    this.invocations.push(input);
    const plan = this.plans.shift();
    if (plan === "pending") return new Promise(() => {});
    if (plan instanceof Error) return Promise.reject(plan);
    return Promise.resolve(plan ?? { outputs: {} });
  }
  cancel(attemptId: string): boolean {
    this.cancelled.push(attemptId);
    return true;
  }
  terminateAll(): void {}
}

type Fixture = {
  tmp: string;
  configPath: string;
  store: BusStore;
  workspaceId: string;
  commandId: string;
  definitionId: string;
  actorEndpoint: string;
};

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function definition(label = "Canonical echo", options: { external?: boolean } = {}): CommandDefinitionContent {
  return {
    label,
    description: "Returns one typed result through a named output Port.",
    input: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["work"],
        properties: { work: { type: "string" } },
      },
    },
    output: {
      version: "1",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["done"],
        properties: {
          done: {
            type: "object",
            additionalProperties: false,
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
        },
      },
    },
    side_effects: options.external ? [{
      effect_id: "external-send",
      title: "Send externally",
      external: true,
      reversibility: "irreversible",
      resource_kinds: ["connector_action"],
    }] : [],
    permissions: [],
    timeout_ms: 2_000,
    cancellation: "supported",
    idempotency: options.external
      ? { mode: "effect_receipt", key_schema_ref: "floe:idempotency-key:v1" }
      : { mode: "pure", key_schema_ref: null },
    implementation_ref: {
      kind: "core_command_implementation",
      id: "core.command.echo",
      revision: "1",
    },
    entry_point: "echo",
  };
}

function composition(contextId: string, commandId: string, actorEndpoint: string): ScopeCompositionContent {
  return {
    nodes: [
      {
        node_id: "ingress",
        kind: "event",
        context_policy: { mode: "fixed", context_id: contextId },
      },
      {
        node_id: "command",
        kind: "command",
        resource_id: commandId,
        activation: { mode: "per_delivery" },
        context_policy: { mode: "new_per_execution" },
      },
      {
        node_id: "reviewer",
        kind: "actor",
        resource_id: actorEndpoint,
        activation: { mode: "per_delivery" },
        context_policy: { mode: "new_per_execution" },
      },
    ],
    ports: [
      { port_id: "ingress:out", node_id: "ingress", name: "work", direction: "output", event_types: ["work.ready"] },
      { port_id: "command:in", node_id: "command", name: "work", direction: "input", event_types: ["work.ready"], min_count: 1, max_count: 1 },
      { port_id: "command:done", node_id: "command", name: "done", direction: "output", event_types: ["work.done"] },
      { port_id: "reviewer:in", node_id: "reviewer", name: "result", direction: "input", event_types: ["work.done"], min_count: 1 },
    ],
    edges: [
      { edge_id: "start-command", source_port_id: "ingress:out", target_port_id: "command:in" },
      { edge_id: "command-review", source_port_id: "command:done", target_port_id: "reviewer:in" },
    ],
  };
}

function makeFixture(host: CommandRuntimeHost, commandDefinition = definition()): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), "floe-command-native-"));
  const configPath = join(tmp, "config.yaml");
  const store = new BusStore(configPath, defaultConfig(tmp), { command_runtime_host: host });
  const locator = join(tmp, "workspace");
  mkdirSync(locator, { recursive: true });
  const workspace = store.registerWorkspace({ locator, name: "Command tests", init_authorized: true }, broadcast);
  store.createScope({ workspace_id: workspace.workspace_id, scope_id: "command-flow", title: "Command flow" }, broadcast);
  const actorEndpoint = `actor:${workspace.workspace_id}:reviewer`;
  store.registerEndpoint({
    endpoint_id: actorEndpoint,
    workspace_id: workspace.workspace_id,
    name: "Reviewer",
    bridge_id: null,
    status: "idle",
  }, broadcast);
  registerExecutableActorFixture(store, workspace.workspace_id, actorEndpoint);
  const created = store.commandDefinitionStore.createCommand({
    owner: { kind: "workspace", id: workspace.workspace_id },
    command_id: `command:${workspace.workspace_id}:echo`,
    created_by_principal_id: "principal:test",
    definition: commandDefinition,
  });
  const published = store.commandDefinitionStore.publishDraft({
    command_definition_revision_id: created.draft.command_definition_revision_id,
    expected_current_revision_id: null,
    changed_by_principal_id: "principal:test",
  });
  const contextId = store.contextStore.createContext({
    workspace_id: workspace.workspace_id,
    scope_id: "command-flow",
    created_by_endpoint_id: null,
    participants: [],
  });
  const draft = store.createScopeCompositionDraft({
    workspace_id: workspace.workspace_id,
    scope_id: "command-flow",
    content: composition(contextId, created.command.command_id, actorEndpoint),
  }, broadcast);
  store.publishScopeComposition({
    revision_id: draft.revision_id,
    expected_published_revision_id: null,
  }, broadcast);
  store.setBroadcast(broadcast);
  cleanups.push(() => {
    try { store.close(); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  });
  return {
    tmp,
    configPath,
    store,
    workspaceId: workspace.workspace_id,
    commandId: created.command.command_id,
    definitionId: published.command_definition_revision_id,
    actorEndpoint,
  };
}

async function eventually(assertion: () => void, timeout = 3_000): Promise<void> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeout) {
    try { assertion(); return; } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw last;
}

function start(fixture: Fixture, idempotencyKey: string) {
  return fixture.store.startScopeExecution({
    workspace_id: fixture.workspaceId,
    scope_id: "command-flow",
    ingress_node_id: "ingress",
    output_port_id: "ingress:out",
    content: { work: idempotencyKey },
    idempotency_key: idempotencyKey,
  }, broadcast);
}

describe("native canonical Command execution", () => {
  it("pins exact meaning, uses a distinct worker Endpoint, validates output, and traverses the stored Edge", async () => {
    const host = new PlannedCommandHost([{
      outputs: { done: [{ value: { ok: true }, content: { ok: true } }] },
      resource_use: { invocations: 1 },
    }]);
    const fixture = makeFixture(host);
    const started = start(fixture, "work-1");

    await eventually(() => expect(host.invocations).toHaveLength(1));
    const commandNode = fixture.store.getScopeExecutionProjection(started.execution.execution_id)!
      .node_executions.find((node) => node.node_id === "command")!;
    await eventually(() => {
      const observed = fixture.store.scopeExecutionStore.listAttempts(commandNode.node_execution_id)[0];
      if (observed?.status !== "completed") throw new Error(JSON.stringify(observed));
    });
    const attempt = fixture.store.scopeExecutionStore.listAttempts(commandNode.node_execution_id)[0]!;
    const worker = fixture.store.commandWorkerBindingStore.require(commandNode.command_worker_binding_id!);

    expect(commandNode.command_definition_revision_id).toBe(fixture.definitionId);
    expect(attempt.command_definition_revision_id).toBe(fixture.definitionId);
    expect(attempt.command_worker_binding_id).toBe(worker.command_worker_binding_id);
    expect(attempt.resource_use).toEqual({ invocations: 1 });
    expect(attempt.result).toMatchObject({
      output_port_ids: ["done"],
      external_effect_receipt_ids: [],
    });
    expect(worker.worker_endpoint_id).not.toBe(fixture.commandId);
    expect(worker.worker_principal_id).not.toBe(fixture.commandId);
    expect(host.invocations[0]!.contract.arguments).toEqual({ work: "work-1" });
    expect(fixture.store.commandProcessingContracts.get(attempt.attempt_id)?.semantic_digest)
      .toMatch(/^sha256:[a-f0-9]{64}$/);
    const downstream = fixture.store.db.prepare(`
      SELECT destination_endpoint_id, edge_id FROM event_queue
      WHERE node_execution_id <> ? ORDER BY created_at DESC LIMIT 1
    `).get(commandNode.node_execution_id) as { destination_endpoint_id: string; edge_id: string };
    expect(downstream).toEqual({ destination_endpoint_id: fixture.actorEndpoint, edge_id: "command-review" });
    const output = fixture.store.scopeExecutionStore.listPublications(commandNode.node_execution_id)[0]!;
    expect(output.published_by_endpoint_id).toBe(worker.worker_endpoint_id);
  });

  it("retries with the original Command revision and idempotency key after the head changes and the Command retires", async () => {
    const host = new PlannedCommandHost([
      new CommandRuntimeHostError("command_worker_lost", "lost"),
      { outputs: { done: [{ value: { ok: true }, content: { ok: true } }] } },
    ]);
    const fixture = makeFixture(host);
    const started = start(fixture, "retry-work");
    await eventually(() => expect(host.invocations).toHaveLength(1));
    const commandNode = fixture.store.getScopeExecutionProjection(started.execution.execution_id)!
      .node_executions.find((node) => node.node_id === "command")!;
    await eventually(() => expect(fixture.store.scopeExecutionStore.getNodeExecution(commandNode.node_execution_id)?.status)
      .toBe("failed"));

    const draftV2 = fixture.store.commandDefinitionStore.createDraft({
      command_id: fixture.commandId,
      based_on_revision_id: fixture.definitionId,
      created_by_principal_id: "principal:test",
      definition: definition("Canonical echo v2"),
    });
    const publishedV2 = fixture.store.commandDefinitionStore.publishDraft({
      command_definition_revision_id: draftV2.command_definition_revision_id,
      expected_current_revision_id: fixture.definitionId,
      changed_by_principal_id: "principal:test",
    });
    fixture.store.commandDefinitionStore.setCommandStatus({
      command_id: fixture.commandId,
      expected_current_revision_id: publishedV2.command_definition_revision_id,
      status: "retired",
    });
    fixture.store.retryScopeNodeExecution({
      workspace_id: fixture.workspaceId,
      node_execution_id: commandNode.node_execution_id,
    }, broadcast);

    await eventually(() => expect(host.invocations).toHaveLength(2));
    await eventually(() => expect(fixture.store.scopeExecutionStore.listAttempts(commandNode.node_execution_id)[1])
      .toMatchObject({ status: "completed", error: {} }));
    const attempts = fixture.store.scopeExecutionStore.listAttempts(commandNode.node_execution_id);
    expect(attempts.map((attempt) => attempt.command_definition_revision_id))
      .toEqual([fixture.definitionId, fixture.definitionId]);
    expect(host.invocations.map((invocation) => invocation.definition.command_definition_revision_id))
      .toEqual([fixture.definitionId, fixture.definitionId]);
    expect(host.invocations[1]!.contract.idempotency_key).toBe(host.invocations[0]!.contract.idempotency_key);
  });

  it("refuses Command identity and worker Endpoint impersonation at the output operation boundary", async () => {
    const host = new PlannedCommandHost(["pending"]);
    const fixture = makeFixture(host);
    const started = start(fixture, "authority-work");
    await eventually(() => expect(host.invocations).toHaveLength(1));
    const commandNode = fixture.store.getScopeExecutionProjection(started.execution.execution_id)!
      .node_executions.find((node) => node.node_id === "command")!;
    const worker = fixture.store.commandWorkerBindingStore.require(commandNode.command_worker_binding_id!);
    for (const falsePrincipal of [fixture.commandId, worker.worker_endpoint_id]) {
      expect(() => fixture.store.publishScopeNodeOutput({
        workspace_id: fixture.workspaceId,
        node_execution_id: commandNode.node_execution_id,
        port_id: "command:done",
        publisher_endpoint_id: falsePrincipal,
        content: { ok: true },
        idempotency_key: `false-publisher:${falsePrincipal}`,
        lifecycle_outcome: "completed",
      }, broadcast)).toThrow(ScopeOutputAuthorityError);
    }
    const stopped = fixture.store.stopScopeExecution({
      workspace_id: fixture.workspaceId,
      execution_id: started.execution.execution_id,
    }, broadcast);
    expect(stopped.uncertain_external_effects).toEqual([]);
    expect(host.cancelled).toEqual([host.invocations[0]!.contract.execution_attempt.attempt_id]);
    expect(fixture.store.scopeExecutionStore.listAttempts(commandNode.node_execution_id)[0]?.status).toBe("cancelled");
  });

  it("fails publication when the Command Ports do not match its typed contract", () => {
    const host = new PlannedCommandHost([]);
    const fixture = makeFixture(host);
    fixture.store.createScope({ workspace_id: fixture.workspaceId, scope_id: "invalid-command", title: "Invalid" }, broadcast);
    const contextId = fixture.store.contextStore.createContext({
      workspace_id: fixture.workspaceId,
      scope_id: "invalid-command",
      created_by_endpoint_id: null,
      participants: [],
    });
    const bad = composition(contextId, fixture.commandId, fixture.actorEndpoint);
    bad.nodes = bad.nodes.map((node) => node.node_id === "ingress"
      ? { ...node, context_policy: { mode: "fixed", context_id: contextId } }
      : node);
    bad.ports = bad.ports.map((port) => port.port_id === "command:in" ? { ...port, name: "wrong" } : port);
    const draft = fixture.store.createScopeCompositionDraft({
      workspace_id: fixture.workspaceId,
      scope_id: "invalid-command",
      content: bad,
    }, broadcast);
    expect(() => fixture.store.publishScopeComposition({
      revision_id: draft.revision_id,
      expected_published_revision_id: null,
    }, broadcast)).toThrow(/Ports must exactly match/);
  });

  it("records timeout as a failed attempt for a Command with no external effects", async () => {
    const host = new PlannedCommandHost([
      new CommandRuntimeHostError("command_timeout", "declared timeout"),
    ]);
    const fixture = makeFixture(host);
    const started = start(fixture, "timeout-work");
    const commandNode = fixture.store.getScopeExecutionProjection(started.execution.execution_id)!
      .node_executions.find((node) => node.node_id === "command")!;
    await eventually(() => expect(fixture.store.scopeExecutionStore.listAttempts(commandNode.node_execution_id)[0]?.status)
      .toBe("failed"));
    expect(fixture.store.scopeExecutionStore.listAttempts(commandNode.node_execution_id)[0]?.error)
      .toMatchObject({ code: "command_timeout", safe_to_retry_automatically: true });
  });

  it("recovers one interrupted non-external attempt on startup with the same exact pins and idempotency key", async () => {
    const interruptedHost = new PlannedCommandHost(["pending"]);
    const fixture = makeFixture(interruptedHost);
    const started = start(fixture, "restart-work");
    await eventually(() => expect(interruptedHost.invocations).toHaveLength(1));
    const commandNode = fixture.store.getScopeExecutionProjection(started.execution.execution_id)!
      .node_executions.find((node) => node.node_id === "command")!;
    const interrupted = fixture.store.scopeExecutionStore.listAttempts(commandNode.node_execution_id)[0]!;
    expect(interrupted.status).toBe("running");
    fixture.store.close();

    const recoveredHost = new PlannedCommandHost([{
      outputs: { done: [{ value: { ok: true }, content: { ok: true } }] },
    }]);
    const reopened = new BusStore(fixture.configPath, defaultConfig(fixture.tmp), {
      command_runtime_host: recoveredHost,
    });
    cleanups.push(() => reopened.close());
    reopened.setBroadcast(broadcast);

    await eventually(() => expect(recoveredHost.invocations).toHaveLength(1));
    await eventually(() => expect(reopened.scopeExecutionStore.listAttempts(commandNode.node_execution_id)[1]?.status)
      .toBe("completed"));
    const attempts = reopened.scopeExecutionStore.listAttempts(commandNode.node_execution_id);
    expect(attempts.map((attempt) => attempt.status)).toEqual(["failed", "completed"]);
    expect(attempts.map((attempt) => attempt.command_definition_revision_id))
      .toEqual([fixture.definitionId, fixture.definitionId]);
    expect(recoveredHost.invocations[0]!.contract.idempotency_key)
      .toBe(interruptedHost.invocations[0]!.contract.idempotency_key);
  });

  it("records an interrupted external attempt as outcome unknown and never replays it on startup", async () => {
    const interruptedHost = new PlannedCommandHost(["pending"]);
    const fixture = makeFixture(interruptedHost, definition("External send", { external: true }));
    const started = start(fixture, "external-restart-work");
    await eventually(() => expect(interruptedHost.invocations).toHaveLength(1));
    const commandNode = fixture.store.getScopeExecutionProjection(started.execution.execution_id)!
      .node_executions.find((node) => node.node_id === "command")!;
    fixture.store.close();

    const recoveredHost = new PlannedCommandHost([]);
    const reopened = new BusStore(fixture.configPath, defaultConfig(fixture.tmp), {
      command_runtime_host: recoveredHost,
    });
    cleanups.push(() => reopened.close());
    reopened.setBroadcast(broadcast);

    await eventually(() => expect(reopened.scopeExecutionStore.listAttempts(commandNode.node_execution_id)[0]?.status)
      .toBe("outcome_unknown"));
    expect(recoveredHost.invocations).toEqual([]);
    expect(reopened.scopeExecutionStore.listAttempts(commandNode.node_execution_id)).toHaveLength(1);
  });
});
