import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CommandDefinitionStore, type CommandDefinitionContent } from "./command-definitions.js";
import {
  CREATE_COMMAND_DEFINITION_DRAFT_OPERATION_ID,
  CREATE_COMMAND_OPERATION_ID,
  GET_COMMAND_DEFINITION_OPERATION_ID,
  INSPECT_COMMAND_OPERATION_ID,
  LIST_COMMANDS_OPERATION_ID,
  NO_COMMAND_DEFINITION_REVISION,
  PUBLISH_COMMAND_DEFINITION_OPERATION_ID,
  REACTIVATE_COMMAND_OPERATION_ID,
  REPLACE_COMMAND_DEFINITION_DRAFT_OPERATION_ID,
  RETIRE_COMMAND_OPERATION_ID,
  ROLLBACK_COMMAND_DEFINITION_OPERATION_ID,
  commandOperationDefinitions,
  registerCommandOperations,
  resolveCommandOperationResource,
} from "./command-operations.js";
import { AjvOperationSchemaValidator } from "./operation-schema-validator-ajv.js";
import { createTestOperationRegistry } from "./operation-test-fixtures.js";
import type {
  OperationAuthorityBoundary,
  OperationAuthorityContext,
  OperationInvocationEnvironment,
  OperationInvocationRequest,
  OperationInvocationResponse,
} from "./operations.js";

const OPERATION_IDS = [
  LIST_COMMANDS_OPERATION_ID,
  INSPECT_COMMAND_OPERATION_ID,
  GET_COMMAND_DEFINITION_OPERATION_ID,
  CREATE_COMMAND_OPERATION_ID,
  CREATE_COMMAND_DEFINITION_DRAFT_OPERATION_ID,
  REPLACE_COMMAND_DEFINITION_DRAFT_OPERATION_ID,
  PUBLISH_COMMAND_DEFINITION_OPERATION_ID,
  ROLLBACK_COMMAND_DEFINITION_OPERATION_ID,
  RETIRE_COMMAND_OPERATION_ID,
  REACTIVATE_COMMAND_OPERATION_ID,
] as const;

function definition(label = "Workspace write"): CommandDefinitionContent {
  return {
    label,
    description: "Write exact content inside the bound Workspace root.",
    input: { version: "1", schema: { type: "object" } },
    output: { version: "1", schema: { type: "object" } },
    side_effects: [{
      effect_id: "write",
      title: "Write Workspace content",
      external: false,
      reversibility: "reversible",
      resource_kinds: ["workspace_content"],
    }],
    permissions: [{
      permission_id: "write-output",
      operation_id: "workspace.content.write",
      purpose: "Write declared output.",
    }],
    timeout_ms: 30_000,
    cancellation: "supported",
    idempotency: { mode: "caller_key", key_schema_ref: "floe:idempotency:v1" },
    implementation_ref: {
      kind: "core_command_implementation",
      id: "workspace-write",
      revision: "sha256:v1",
    },
    entry_point: "workspace.write",
  };
}

function authority(
  boundary: OperationAuthorityBoundary = { kind: "workspace", workspace_id: "workspace:one" },
  grants: ReadonlySet<string> = new Set(OPERATION_IDS),
): OperationAuthorityContext {
  return {
    principal_id: "principal:operator",
    boundary,
    grants,
    interaction: {
      mode: "interactive",
      session_id: "session:test",
      confirmed_prompts: new Set(),
      approval_refs: new Set(),
    },
  };
}

function environment(
  store: CommandDefinitionStore,
  auth = authority(),
): OperationInvocationEnvironment {
  return {
    authority: auth,
    resolve_resource: async (target) => resolveCommandOperationResource(store, target, auth.boundary),
    now: () => "2026-09-04T04:00:00.000Z",
  };
}

function request(
  operationId: string,
  input: unknown,
  idempotencyKey: string,
  options: Readonly<{ target?: { kind: string; id: string }; expected_revision?: string }> = {},
): OperationInvocationRequest {
  return {
    operation_id: operationId,
    operation_version: "1",
    input_schema_version: "1",
    input,
    idempotency_key: idempotencyKey,
    ...(options.target ? { target: options.target } : {}),
    ...(options.expected_revision !== undefined
      ? { expected_resource_revision: options.expected_revision }
      : {}),
  };
}

function receipt(response: OperationInvocationResponse) {
  expect(response.kind).toBe("receipt");
  if (response.kind !== "receipt") throw new Error("Expected operation receipt");
  return response.receipt;
}

describe("Command semantic operations", () => {
  let db: DatabaseSync;
  let store: CommandDefinitionStore;
  let registry: ReturnType<typeof createTestOperationRegistry>;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    store = new CommandDefinitionStore(db, () => "2026-09-04T03:00:00.000Z");
    registry = registerCommandOperations(
      createTestOperationRegistry(new AjvOperationSchemaValidator()),
      store,
    );
  });

  afterEach(() => db.close());

  it("discovers one complete contract for Workspace and host Commands", async () => {
    const [workspace, host] = await Promise.all([
      registry.project({ authority: authority() }),
      registry.project({ authority: authority({ kind: "host", host_id: "host:one" }) }),
    ]);
    expect(workspace.map((item) => item.operation_id)).toEqual(OPERATION_IDS);
    expect(host.map((item) => item.operation_id)).toEqual(OPERATION_IDS);
    expect(commandOperationDefinitions(store)).toHaveLength(OPERATION_IDS.length);
    expect(workspace.every((item) => item.required_grants[0] === item.operation_id)).toBe(true);
  });

  it("creates and publishes a Workspace Command through the shared registry", async () => {
    const env = environment(store);
    const created = receipt(await registry.invoke(
      env,
      request(CREATE_COMMAND_OPERATION_ID, {
        command_id: "command:write",
        definition: definition(),
      }, "create"),
    ));
    expect(created.state).toBe("completed");
    const result = created.result as any;
    expect(result.command.owner).toEqual({ kind: "workspace", id: "workspace:one" });
    expect(result.command.current_revision_id).toBeNull();

    const published = receipt(await registry.invoke(
      env,
      request(PUBLISH_COMMAND_DEFINITION_OPERATION_ID, {
        expected_current_revision_id: null,
      }, "publish", {
        target: {
          kind: "command_definition_revision",
          id: result.draft.command_definition_revision_id,
        },
        expected_revision: result.draft.semantic_digest,
      }),
    ));
    expect(published.state).toBe("completed");
    expect((published.result as any).command.current_revision_id)
      .toBe(result.draft.command_definition_revision_id);

    const inspected = receipt(await registry.invoke(
      env,
      request(INSPECT_COMMAND_OPERATION_ID, { include_history: true }, "inspect", {
        target: { kind: "command", id: "command:write" },
      }),
    ));
    expect((inspected.result as any).revisions).toHaveLength(1);
    expect((inspected.result as any).history_complete).toBe(true);
  });

  it("derives ownership from authenticated authority and refuses cross-boundary targets", async () => {
    const workspaceEnv = environment(store);
    const hostAuth = authority({ kind: "host", host_id: "host:one" });
    const hostEnv = environment(store, hostAuth);
    const workspace = receipt(await registry.invoke(
      workspaceEnv,
      request(CREATE_COMMAND_OPERATION_ID, { command_id: "command:workspace", definition: definition() }, "workspace-create"),
    ));
    const host = receipt(await registry.invoke(
      hostEnv,
      request(CREATE_COMMAND_OPERATION_ID, { command_id: "command:host", definition: definition() }, "host-create"),
    ));
    expect((workspace.result as any).command.owner).toEqual({ kind: "workspace", id: "workspace:one" });
    expect((host.result as any).command.owner).toEqual({ kind: "host", id: "host:one" });

    const cross = receipt(await registry.invoke(
      workspaceEnv,
      request(INSPECT_COMMAND_OPERATION_ID, {}, "cross", {
        target: { kind: "command", id: "command:host" },
      }),
    ));
    expect(cross.state).toBe("refused");
    expect(cross.refusal?.code).toBe("operation_target_not_found");

    const noGrant = await registry.project({ authority: authority(undefined, new Set()) });
    expect(noGrant.every((item) => !item.availability.available)).toBe(true);
  });

  it("requires an exact current revision for lifecycle changes", async () => {
    const env = environment(store);
    const created = receipt(await registry.invoke(
      env,
      request(CREATE_COMMAND_OPERATION_ID, { command_id: "command:write", definition: definition() }, "create"),
    ));
    const result = created.result as any;
    const refused = receipt(await registry.invoke(
      env,
      request(RETIRE_COMMAND_OPERATION_ID, {}, "retire-wrong", {
        target: { kind: "command", id: "command:write" },
        expected_revision: "wrong",
      }),
    ));
    expect(refused.state).toBe("refused");
    expect(refused.refusal?.code).toBe("operation_resource_revision_conflict");

    const retired = receipt(await registry.invoke(
      env,
      request(RETIRE_COMMAND_OPERATION_ID, {}, "retire", {
        target: { kind: "command", id: "command:write" },
        expected_revision: NO_COMMAND_DEFINITION_REVISION,
      }),
    ));
    expect(retired.state).toBe("completed");
    expect((retired.result as any).command.status).toBe("retired");
    expect(result.draft).toBeDefined();
  });
});
