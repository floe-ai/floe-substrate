import { describe, expect, it, vi } from "vitest";

import {
  CliAuthorityBrokerUnavailableError,
  CliOperationClient,
  NativeCliOperationAuthorityBroker,
  UnavailableCliOperationAuthorityBroker,
  selectLocalWorkspace,
  type CliOperationAuthorityBroker,
  type CliOperationDescriptor,
} from "./operation-client.js";

const WORKSPACE_ID = "workspace:one";

function descriptor(overrides: Partial<CliOperationDescriptor> = {}): CliOperationDescriptor {
  return {
    operation_id: "scope.inspect",
    operation_version: "7",
    authority_boundary_kinds: ["workspace"],
    category: "scope",
    title: "Inspect Scope",
    description: "Inspect one Scope.",
    effects: {
      mode: "read",
      reversibility: "none",
      external: false,
      secret_access: "none",
    },
    required_grants: ["scope.inspect"],
    interaction_constraints: { allowed_modes: ["interactive"] },
    target: { resource_kinds: ["scope"], expected_revision: "optional" },
    input: { version: "3", schema: { type: "object" } },
    result: { version: "4", schema: { type: "object" } },
    availability: { available: true },
    ...overrides,
  };
}

function mockBroker(operation = descriptor(), invocationResult: unknown = { kind: "receipt" }) {
  return {
    listLocalWorkspaces: vi.fn<CliOperationAuthorityBroker["listLocalWorkspaces"]>(
      async () => ({ workspaces: [] }),
    ),
    discoverOperations: vi.fn<CliOperationAuthorityBroker["discoverOperations"]>(
      async () => ({ operations: [operation] }),
    ),
    invokeOperation: vi.fn<CliOperationAuthorityBroker["invokeOperation"]>(
      async () => invocationResult,
    ),
    confirmAndInvokeHostOperation: vi.fn<CliOperationAuthorityBroker["confirmAndInvokeHostOperation"]>(
      async () => invocationResult,
    ),
    confirmAndInvokeWorkspaceOperation: vi.fn<CliOperationAuthorityBroker["confirmAndInvokeWorkspaceOperation"]>(
      async () => invocationResult,
    ),
  } satisfies CliOperationAuthorityBroker;
}

describe("CLI semantic operation client", () => {
  it("uses the native helper's typed command contract without bearer or raw-route fields", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const native = new NativeCliOperationAuthorityBroker(async (command) => {
      calls.push({ ...command });
      if (command.command === "list_local_workspaces") return { workspaces: [] };
      return { operations: [descriptor()] };
    });
    await native.listLocalWorkspaces();
    await native.discoverOperations({
      boundary: { kind: "workspace", workspace_id: WORKSPACE_ID },
      query: "scope.inspect",
      target: { kind: "scope", id: "scope:one" },
    });
    expect(calls).toEqual([
      { command: "list_local_workspaces" },
      {
        command: "discover_operations",
        boundary: { kind: "workspace", workspace_id: WORKSPACE_ID },
        query: "scope.inspect",
        target: { kind: "scope", id: "scope:one" },
      },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/bearer|token|\/v1\//);
  });

  it("invokes the exact versions from the discovered Bus descriptor", async () => {
    const operation = descriptor();
    const canonicalResponse = {
      kind: "receipt",
      replayed: false,
      receipt: { receipt_id: "receipt:one", state: "completed", result: { found: true } },
    };
    const broker = mockBroker(operation, canonicalResponse);
    const client = new CliOperationClient(broker, "cli:test");

    const result = await client.invokeSelected({
      boundary: { kind: "workspace", workspace_id: WORKSPACE_ID },
      operation_id: operation.operation_id,
      target: { kind: "scope", id: "scope:one" },
      expected_resource_revision: "revision:expected",
      idempotency_key: "inspect:one",
      input: { include_history: false },
    });

    expect(result).toEqual(canonicalResponse);
    expect(broker.discoverOperations).toHaveBeenCalledWith({
      boundary: { kind: "workspace", workspace_id: WORKSPACE_ID },
      query: "scope.inspect",
      target: { kind: "scope", id: "scope:one" },
    });
    expect(broker.invokeOperation).toHaveBeenCalledWith({
      boundary: { kind: "workspace", workspace_id: WORKSPACE_ID },
      invocation: {
        operation_id: "scope.inspect",
        operation_version: "7",
        input_schema_version: "3",
        target: { kind: "scope", id: "scope:one" },
        expected_resource_revision: "revision:expected",
        idempotency_key: "inspect:one",
        input: { include_history: false },
      },
    });
    const invocation = broker.invokeOperation.mock.calls[0]![0].invocation as unknown as Record<string, unknown>;
    expect(invocation).not.toHaveProperty("principal_id");
    expect(invocation).not.toHaveProperty("grants");
    expect(invocation).not.toHaveProperty("authority");
    expect(invocation).not.toHaveProperty("bearer_token");
  });

  it("returns the canonical receipt or refusal unchanged", async () => {
    const refusal = {
      kind: "receipt",
      replayed: false,
      receipt: {
        receipt_id: "receipt:refused",
        state: "refused",
        refusal: {
          code: "expected_revision_mismatch",
          message: "The target changed.",
          retryable: true,
          required_action: null,
          details: {},
        },
      },
    };
    const broker = mockBroker(descriptor(), refusal);
    const client = new CliOperationClient(broker, "cli:test");
    await expect(client.invokeSelected({
      boundary: { kind: "workspace", workspace_id: WORKSPACE_ID },
      operation_id: "scope.inspect",
      input: {},
      idempotency_key: "refusal:one",
    })).resolves.toBe(refusal);
  });

  it("uses trusted broker confirmation without adding confirmation or identity to intent", async () => {
    const operation = descriptor({
      operation_id: "context.destroy_permanently",
      interaction_constraints: {
        allowed_modes: ["interactive"],
        confirmation: {
          required: true,
          prompt_id: "destroy-context",
          title: "Permanently destroy Context?",
          description: "Required retained evidence will block this operation.",
        },
      },
    });
    const result = { kind: "receipt", replayed: false, receipt: { state: "completed" } };
    const broker = mockBroker(operation, result);
    const client = new CliOperationClient(broker, "cli:test");
    const confirm = vi.fn(async () => true);

    await expect(client.invokeSelected({
      boundary: { kind: "workspace", workspace_id: WORKSPACE_ID },
      operation_id: operation.operation_id,
      target: { kind: "context", id: "context:one" },
      expected_resource_revision: "context-revision:one",
      idempotency_key: "destroy:one",
      input: { reason: "No longer needed" },
      confirm,
    })).resolves.toBe(result);

    expect(confirm).toHaveBeenCalledWith(operation.interaction_constraints.confirmation);
    expect(broker.confirmAndInvokeWorkspaceOperation).toHaveBeenCalledWith({
      workspace_id: WORKSPACE_ID,
      interaction_session_id: "cli:test",
      invocation: {
        operation_id: "context.destroy_permanently",
        operation_version: "7",
        input_schema_version: "3",
        target: { kind: "context", id: "context:one" },
        expected_resource_revision: "context-revision:one",
        idempotency_key: "destroy:one",
        input: { reason: "No longer needed" },
      },
    });
    const invocation = broker.confirmAndInvokeWorkspaceOperation.mock.calls[0]![0]
      .invocation as unknown as Record<string, unknown>;
    expect(invocation).not.toHaveProperty("confirmed_prompts");
    expect(invocation).not.toHaveProperty("principal_id");
    expect(broker.invokeOperation).not.toHaveBeenCalled();
  });

  it("does not call the broker after the operator declines confirmation", async () => {
    const operation = descriptor({
      interaction_constraints: {
        allowed_modes: ["interactive"],
        confirmation: {
          required: true,
          prompt_id: "confirm",
          title: "Confirm",
          description: "Confirm this operation.",
        },
      },
    });
    const broker = mockBroker(operation);
    const client = new CliOperationClient(broker, "cli:test");
    await expect(client.invokeSelected({
      boundary: { kind: "workspace", workspace_id: WORKSPACE_ID },
      operation_id: operation.operation_id,
      idempotency_key: "cancel:one",
      input: {},
      confirm: async () => false,
    })).resolves.toEqual({
      kind: "cancelled",
      operation_id: operation.operation_id,
      prompt_id: "confirm",
    });
    expect(broker.invokeOperation).not.toHaveBeenCalled();
    expect(broker.confirmAndInvokeHostOperation).not.toHaveBeenCalled();
    expect(broker.confirmAndInvokeWorkspaceOperation).not.toHaveBeenCalled();
  });

  it("uses trusted host confirmation for host-scoped operations", async () => {
    const operation = descriptor({
      operation_id: "credential.revoke",
      authority_boundary_kinds: ["host"],
      category: "credentials",
      target: { resource_kinds: ["secret_ref"], expected_revision: "required" },
      interaction_constraints: {
        allowed_modes: ["interactive"],
        confirmation: {
          required: true,
          prompt_id: "credential.revoke.confirm",
          title: "Disconnect this credential?",
          description: "Work using this credential will remain blocked until it is connected again.",
        },
      },
    });
    const result = { kind: "receipt", replayed: false, receipt: { state: "completed" } };
    const broker = mockBroker(operation, result);
    const client = new CliOperationClient(broker, "cli:test");

    await expect(client.invokeSelected({
      boundary: { kind: "host" },
      operation_id: operation.operation_id,
      target: { kind: "secret_ref", id: "secret-ref:one" },
      expected_resource_revision: "generation:2:resolved",
      idempotency_key: "disconnect:one",
      input: {},
      confirm: async () => true,
    })).resolves.toBe(result);

    expect(broker.confirmAndInvokeHostOperation).toHaveBeenCalledWith({
      interaction_session_id: "cli:test",
      invocation: {
        operation_id: "credential.revoke",
        operation_version: "7",
        input_schema_version: "3",
        target: { kind: "secret_ref", id: "secret-ref:one" },
        expected_resource_revision: "generation:2:resolved",
        idempotency_key: "disconnect:one",
        input: {},
      },
    });
    expect(broker.invokeOperation).not.toHaveBeenCalled();
    expect(broker.confirmAndInvokeWorkspaceOperation).not.toHaveBeenCalled();
  });

  it("passes host selection to the trusted broker without inventing a Workspace", async () => {
    const operation = descriptor({
      operation_id: "workspace.register",
      authority_boundary_kinds: ["host"],
      category: "workspace",
      target: { resource_kinds: [], expected_revision: "not_applicable" },
    });
    const broker = mockBroker(operation);
    const client = new CliOperationClient(broker, "cli:test");
    await client.invokeSelected({
      boundary: { kind: "host" },
      operation_id: operation.operation_id,
      input: { locator: "C:\\work" },
      idempotency_key: "workspace:register:one",
    });
    expect(broker.discoverOperations).toHaveBeenCalledWith({
      boundary: { kind: "host" },
      query: "workspace.register",
    });
    expect(broker.invokeOperation.mock.calls[0]![0].boundary).toEqual({ kind: "host" });
  });

  it("fails closed when no shared native authority broker is installed", async () => {
    const client = new CliOperationClient(new UnavailableCliOperationAuthorityBroker());
    await expect(client.listLocalWorkspaces()).rejects.toBeInstanceOf(CliAuthorityBrokerUnavailableError);
    await expect(client.discover({ boundary: { kind: "host" } }))
      .rejects.toThrow("shared native CLI broker is unavailable");
  });

  it("reads the installed broker's flat local Workspace records and preserves an unbound Workspace", async () => {
    const broker = mockBroker();
    broker.listLocalWorkspaces.mockResolvedValue({ workspaces: [
      { workspace_id: "workspace:one", name: "One", binding_id: "binding:one", locator: "C:\\work\\one", status: "attached" },
      { workspace_id: "workspace:unbound", name: "Unbound", binding_id: null, locator: null },
    ] });
    const workspaces = await new CliOperationClient(broker).listLocalWorkspaces();
    expect(workspaces).toEqual([
      { workspace_id: "workspace:one", name: "One", binding: { locator: "C:\\work\\one" } },
      { workspace_id: "workspace:unbound", name: "Unbound", binding: null },
    ]);
    expect(selectLocalWorkspace(workspaces, undefined, "C:\\work\\one\\images").workspace_id).toBe("workspace:one");
    broker.listLocalWorkspaces.mockResolvedValue({ workspaces: [
      { workspace_id: "workspace:invalid", name: "Invalid", binding_id: null, locator: "C:\\untrusted" },
    ] });
    await expect(new CliOperationClient(broker).listLocalWorkspaces()).rejects.toThrow("without a current");
  });
});

describe("CLI Workspace selection", () => {
  const workspaces = [
    {
      workspace_id: "workspace:root",
      name: "Root",
      binding: { locator: "C:\\Development", state: "current" },
    },
    {
      workspace_id: "workspace:floe",
      name: "Floe",
      binding: { locator: "C:\\Development\\ai-powered\\floe", state: "current" },
    },
  ];

  it("prefers the deepest attached Workspace containing the current directory", () => {
    expect(selectLocalWorkspace(workspaces, undefined, "C:\\Development\\ai-powered\\floe\\floe-cli"))
      .toMatchObject({ workspace_id: "workspace:floe" });
  });

  it("selects only an exact explicit Workspace identity", () => {
    expect(selectLocalWorkspace(workspaces, "workspace:root"))
      .toMatchObject({ workspace_id: "workspace:root" });
    expect(() => selectLocalWorkspace(workspaces, "Root"))
      .toThrow("Workspace 'Root' is not attached");
  });
});
