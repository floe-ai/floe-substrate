import { describe, expect, it, vi } from "vitest";
import {
  InMemoryOperationInvocationLedger,
  SemanticOperationRegistry,
  refusal,
  requiredAction,
  type JsonSchema,
  type OperationAuthorityContext,
  type OperationGovernanceControlPlane,
  type OperationInvocationEnvironment,
  type OperationInvocationRequest,
  type OperationSchemaIssue,
  type OperationSchemaValidation,
  type OperationSchemaValidator,
  type ResolvedOperationResource,
  type SemanticOperationDefinition,
} from "./operations.js";
import { createTestOperationRegistry } from "./operation-test-fixtures.js";

type RetireInput = { reason?: string };
type RetireResult = { status: "retired"; cancelled: number };

const inputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reason: { type: "string", minLength: 1 },
  },
};

const resultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "cancelled"],
  properties: {
    status: { const: "retired" },
    cancelled: { type: "number" },
  },
};

class TestSchemaValidator implements OperationSchemaValidator {
  readonly calls: Array<{ schema: JsonSchema; value: unknown }> = [];

  validate(schema: JsonSchema, value: unknown): OperationSchemaValidation {
    this.calls.push({ schema, value });
    const issues: OperationSchemaIssue[] = [];
    validateValue(schema, value, "", "#", issues);
    return issues.length === 0 ? { valid: true } : { valid: false, issues };
  }
}

function validateValue(
  schema: JsonSchema,
  value: unknown,
  instancePath: string,
  schemaPath: string,
  issues: OperationSchemaIssue[],
): void {
  if ("const" in schema && value !== schema.const) {
    issues.push({ instance_path: instancePath, schema_path: `${schemaPath}/const`, keyword: "const", message: "must equal constant" });
    return;
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push({ instance_path: instancePath, schema_path: `${schemaPath}/type`, keyword: "type", message: "must be object" });
      return;
    }
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const required of (schema.required ?? []) as string[]) {
      if (!(required in object)) {
        issues.push({ instance_path: instancePath, schema_path: `${schemaPath}/required`, keyword: "required", message: `must have property '${required}'` });
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(object)) {
        if (!(key in properties)) {
          issues.push({ instance_path: `${instancePath}/${key}`, schema_path: `${schemaPath}/additionalProperties`, keyword: "additionalProperties", message: "must not have additional properties" });
        }
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in object) validateValue(child, object[key], `${instancePath}/${key}`, `${schemaPath}/properties/${key}`, issues);
    }
    return;
  }
  if (schema.type === "string" && typeof value !== "string") {
    issues.push({ instance_path: instancePath, schema_path: `${schemaPath}/type`, keyword: "type", message: "must be string" });
  }
  if (schema.type === "number" && typeof value !== "number") {
    issues.push({ instance_path: instancePath, schema_path: `${schemaPath}/type`, keyword: "type", message: "must be number" });
  }
}

function authority(
  principalId: string,
  mode: "interactive" | "unattended" | "brokered",
  grants: string[] = ["scope.retire"],
  brokerId: string | null = null,
  confirmedPrompts: string[] = ["scope-retire-v1"],
  approvalRefs: string[] = [],
): OperationAuthorityContext {
  return {
    principal_id: principalId,
    boundary: { kind: "workspace", workspace_id: "workspace:test" },
    grants: new Set(grants),
    interaction: {
      mode,
      session_id: `session:${principalId}`,
      broker_id: brokerId,
      confirmed_prompts: new Set(confirmedPrompts),
      approval_refs: new Set(approvalRefs),
    },
  };
}

const scope: ResolvedOperationResource = {
  ref: { kind: "scope", id: "delivery", revision: "7" },
  state: { status: "active" },
};

function environment(
  principal: OperationAuthorityContext,
  resolved: ResolvedOperationResource | null = scope,
  now = "2026-09-03T00:00:00.000Z",
): OperationInvocationEnvironment {
  return {
    authority: principal,
    resolve_resource: async () => resolved,
    now: () => now,
  };
}

type RetireHandler = SemanticOperationDefinition<RetireInput, RetireResult>["handler"];

function retireDefinition(handler: RetireHandler = vi.fn(async () => ({
  state: "completed" as const,
  result: { status: "retired" as const, cancelled: 2 },
  changed_refs: [{ kind: "scope", id: "delivery", revision: "8" }],
  audit_ref: { kind: "operation_audit", id: "audit:retire:delivery", revision: "1" },
}))): SemanticOperationDefinition<RetireInput, RetireResult> {
  return {
    operation_id: "scope.retire",
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "organisation",
    title: "Stop connected work",
    description: "Stop a Scope without deleting its retained history.",
    effects: {
      mode: "write",
      reversibility: "irreversible",
      external: false,
      secret_access: "none",
    },
    required_grants: ["scope.retire"],
    interaction_constraints: {
      allowed_modes: ["interactive", "unattended"],
      confirmation: {
        required: true,
        prompt_id: "scope-retire-v1",
        title: "Stop this work?",
        description: "Queued and active work will stop. Retained history will remain inspectable.",
      },
    },
    target: {
      resource_kinds: ["scope"],
      expected_revision: "required",
    },
    input: { version: "1", schema: inputSchema },
    result: { version: "1", schema: resultSchema },
    availability: ({ target }) => target?.state && (target.state as { status?: string }).status === "active"
      ? { available: true }
      : {
          available: false,
          refusal: refusal(
            "scope_already_retired",
            "This Scope is already stopped.",
            false,
            requiredAction("inspect_scope", "Inspect history", "Open the retained Scope history."),
          ),
        },
    handler,
  };
}

function request(input: unknown, idempotencyKey: string, expectedRevision = "7") {
  return {
    operation_id: "scope.retire",
    operation_version: "1",
    input_schema_version: "1",
    target: { kind: "scope", id: "delivery" },
    expected_resource_revision: expectedRevision,
    idempotency_key: idempotencyKey,
    input,
  };
}

describe("Bus-owned semantic operation registry", () => {
  it("lists current operation identities for an explicit interaction policy without copying definitions", () => {
    const validator = new TestSchemaValidator();
    const interactive = retireDefinition();
    const brokered = {
      ...retireDefinition(),
      operation_id: "provider.connect",
      interaction_constraints: { allowed_modes: ["brokered" as const] },
    };
    const registry = createTestOperationRegistry(validator)
      .register(interactive)
      .register(brokered);

    expect(registry.listCurrentOperationIds({ interaction_mode: "interactive" }))
      .toEqual(["scope.retire"]);
    expect(registry.listCurrentOperationIds({ interaction_mode: "brokered" }))
      .toEqual(["provider.connect"]);
  });

  it("projects one definition to two clients and validates both with the exact published schema", async () => {
    const validator = new TestSchemaValidator();
    const handler = vi.fn(async () => ({
      state: "completed" as const,
      result: { status: "retired" as const, cancelled: 0 },
    }));
    const registry = createTestOperationRegistry(validator).register(retireDefinition(handler));

    // These are client sessions, not human/Actor authority types. Their grants
    // and interaction modes are the only semantic differences.
    const desktop = authority("principal:desktop-session", "interactive");
    const runtime = authority("principal:runtime-turn", "unattended");
    const [desktopProjection, runtimeProjection] = await Promise.all([
      registry.project({ authority: desktop, target: scope }),
      registry.project({ authority: runtime, target: scope }),
    ]);

    expect(desktopProjection).toEqual(runtimeProjection);
    expect(desktopProjection[0]).toMatchObject({
      operation_id: "scope.retire",
      operation_version: "1",
      required_grants: ["scope.retire"],
      input: { version: "1", schema: inputSchema },
      result: { version: "1", schema: resultSchema },
      availability: { available: true },
    });

    const [desktopResult, runtimeResult] = await Promise.all([
      registry.invoke(environment(desktop), request({ reason: 42 }, "desktop-invalid")),
      registry.invoke(environment(runtime), request({ reason: 42 }, "runtime-invalid")),
    ]);

    expect(desktopResult.kind).toBe("receipt");
    expect(runtimeResult.kind).toBe("receipt");
    if (desktopResult.kind !== "receipt" || runtimeResult.kind !== "receipt") return;
    expect(desktopResult.receipt.refusal).toEqual(runtimeResult.receipt.refusal);
    expect(desktopResult.receipt.refusal).toMatchObject({
      code: "operation_input_invalid",
      retryable: false,
      required_action: { code: "correct_input" },
    });
    expect(validator.calls).toHaveLength(2);
    expect(validator.calls[0]?.schema).toBe(inputSchema);
    expect(validator.calls[1]?.schema).toBe(inputSchema);
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns one stable receipt and executes an idempotent write only once", async () => {
    const validator = new TestSchemaValidator();
    const handler = vi.fn(async () => ({
      state: "completed" as const,
      result: { status: "retired" as const, cancelled: 2 },
      changed_refs: [{ kind: "scope", id: "delivery", revision: "8" }],
      audit_ref: { kind: "operation_audit", id: "audit:retire:delivery", revision: "1" },
    }));
    const registry = createTestOperationRegistry(
      validator,
      new InMemoryOperationInvocationLedger(),
    ).register(retireDefinition(handler));
    const principal = authority("principal:desktop-session", "interactive");
    const invocation = request({ reason: "Operator requested stop" }, "stop-delivery-once");

    const first = await registry.invoke(environment(principal), invocation);
    const replay = await registry.invoke(
      environment(principal, scope, "2026-09-03T00:05:00.000Z"),
      invocation,
    );

    expect(first.kind).toBe("receipt");
    expect(replay.kind).toBe("receipt");
    if (first.kind !== "receipt" || replay.kind !== "receipt") return;
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(first.receipt);
    expect(first.receipt).toMatchObject({
      receipt_id: expect.stringMatching(/^opinv_/),
      invocation_id: expect.stringMatching(/^opinv_/),
      principal_id: "principal:desktop-session",
      state: "completed",
      result_schema_version: "1",
      result: { status: "retired", cancelled: 2 },
      changed_refs: [{ kind: "scope", id: "delivery", revision: "8" }],
      progress_ref: null,
      cancel_ref: null,
      audit_ref: { kind: "operation_audit", id: "audit:retire:delivery", revision: "1" },
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(validator.calls[0]?.schema).toBe(inputSchema);
    expect(validator.calls[1]?.schema).toBe(resultSchema);
  });

  it("refuses stale revisions with a retryable action before calling the handler", async () => {
    const validator = new TestSchemaValidator();
    const handler = vi.fn(async () => ({
      state: "completed" as const,
      result: { status: "retired" as const, cancelled: 0 },
    }));
    const registry = createTestOperationRegistry(validator).register(retireDefinition(handler));

    const response = await registry.invoke(
      environment(authority("principal:runtime-turn", "unattended")),
      request({}, "stale-stop", "6"),
    );

    expect(response.kind).toBe("receipt");
    if (response.kind !== "receipt") return;
    expect(response.receipt).toMatchObject({
      state: "refused",
      target: { kind: "scope", id: "delivery", revision: "7" },
      refusal: {
        code: "operation_resource_revision_conflict",
        retryable: true,
        required_action: { code: "refresh_resource" },
        details: { expected_revision: "6", current_revision: "7" },
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("requires externally attested confirmation rather than trusting caller content", async () => {
    const validator = new TestSchemaValidator();
    const handler = vi.fn(async () => ({
      state: "completed" as const,
      result: { status: "retired" as const, cancelled: 0 },
    }));
    const registry = createTestOperationRegistry(validator).register(retireDefinition(handler));
    const principalWithoutConfirmation = authority(
      "principal:runtime-turn",
      "unattended",
      ["scope.retire"],
      null,
      [],
    );
    const forgedRequest = {
      ...request({}, "confirmation-cannot-be-forged"),
      confirmation: { prompt_id: "scope-retire-v1", acknowledged: true },
    } as unknown as OperationInvocationRequest;

    const response = await registry.invoke(environment(principalWithoutConfirmation), forgedRequest);

    expect(response.kind).toBe("receipt");
    if (response.kind !== "receipt") return;
    expect(response.receipt.refusal).toMatchObject({
      code: "operation_confirmation_required",
      retryable: true,
      required_action: { code: "confirm" },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("derives grants and broker identity from external authority context", async () => {
    const validator = new TestSchemaValidator();
    const brokeredDefinition: SemanticOperationDefinition<Record<string, never>, { connected: true }> = {
      operation_id: "provider.connect",
      operation_version: "1",
      authority_boundary_kinds: ["workspace"],
      category: "credentials",
      title: "Connect provider",
      description: "Request a provider connection without exposing reusable credentials.",
      effects: { mode: "write", reversibility: "reversible", external: true, secret_access: "brokered" },
      required_grants: ["provider.connect"],
      interaction_constraints: {
        allowed_modes: ["brokered"],
        broker: { broker_id: "os-credential-broker", purpose: "Open the trusted provider sign-in flow." },
      },
      target: { resource_kinds: [], expected_revision: "not_applicable" },
      input: { version: "1", schema: { type: "object", additionalProperties: false, properties: {} } },
      result: {
        version: "1",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["connected"],
          properties: { connected: { const: true } },
        },
      },
      handler: async () => ({ state: "completed", result: { connected: true } }),
    };
    const registry = createTestOperationRegistry(validator).register(brokeredDefinition);

    const noGrant = await registry.project({
      authority: authority("principal:session", "brokered", [], "os-credential-broker"),
    });
    expect(noGrant[0]?.availability).toMatchObject({
      available: false,
      refusal: { code: "operation_grant_required", required_action: { code: "request_grant" } },
    });

    const wrongBroker = await registry.project({
      authority: authority("principal:session", "brokered", ["provider.connect"], "untrusted-broker"),
    });
    expect(wrongBroker[0]?.availability).toMatchObject({
      available: false,
      refusal: { code: "operation_broker_required", required_action: { code: "use_broker" } },
    });

    // There is no caller identity field in the invocation envelope. A value in
    // input is ordinary schema-validated input and cannot alter authority.
    const spoof = await registry.invoke(
      environment(authority("principal:session", "brokered", ["provider.connect"], "os-credential-broker"), null),
      {
        operation_id: "provider.connect",
        operation_version: "1",
        input_schema_version: "1",
        idempotency_key: "connect-once",
        input: { caller_endpoint_id: "actor:someone-else" },
      },
    );
    expect(spoof.kind).toBe("receipt");
    if (spoof.kind !== "receipt") return;
    expect(spoof.receipt.principal_id).toBe("principal:session");
    expect(spoof.receipt.refusal).toMatchObject({ code: "operation_input_invalid" });
  });

  it("requires progress and exposes cancel references for accepted asynchronous work", async () => {
    const validator = new TestSchemaValidator();
    const definition: SemanticOperationDefinition<Record<string, never>, { queued: true }> = {
      operation_id: "workspace.export",
      operation_version: "1",
      authority_boundary_kinds: ["workspace"],
      category: "workspace",
      title: "Export Workspace",
      description: "Prepare a portable Workspace export.",
      effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
      required_grants: ["workspace.export"],
      interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
      target: { resource_kinds: [], expected_revision: "not_applicable" },
      input: { version: "1", schema: { type: "object", additionalProperties: false, properties: {} } },
      result: {
        version: "1",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["queued"],
          properties: { queued: { const: true } },
        },
      },
      handler: async ({ invocation_id }) => ({
        state: "accepted",
        result: { queued: true },
        progress_ref: { kind: "operation_progress", id: invocation_id, revision: "1" },
        cancel_ref: { operation_id: "operation.cancel", target: { kind: "operation_invocation", id: invocation_id } },
      }),
    };
    const registry = createTestOperationRegistry(validator).register(definition);

    const response = await registry.invoke(
      environment(authority("principal:runtime-turn", "unattended", ["workspace.export"]), null),
      {
        operation_id: "workspace.export",
        operation_version: "1",
        input_schema_version: "1",
        idempotency_key: "export-once",
        input: {},
      },
    );

    expect(response.kind).toBe("receipt");
    if (response.kind !== "receipt") return;
    expect(response.receipt).toMatchObject({
      state: "accepted",
      completed_at: null,
      progress_ref: { kind: "operation_progress" },
      cancel_ref: { operation_id: "operation.cancel" },
    });
  });

  it("reconciles incomplete governance evidence when an outcome_unknown receipt is replayed", async () => {
    const validator = new TestSchemaValidator();
    const recover = vi.fn();
    const governance: OperationGovernanceControlPlane = {
      prepare: (input) => ({
        state: "authorized",
        evidence: {
          policy_evaluation_id: "policy-evaluation:one",
          approval_request_ids: [],
          approval_receipt_ids: [],
          budget_reservation_id: "budget-reservation:one",
        },
        audit_ref: { kind: "audit", id: "audit:one", revision: "request-digest:one" },
        canonical_provenance: input.provenance,
      }),
      settle: () => { throw new Error("governance storage unavailable"); },
      recover,
    };
    const handler = vi.fn(async () => ({
      state: "completed" as const,
      result: { status: "retired" as const, cancelled: 0 },
    }));
    const registry = new SemanticOperationRegistry(
      validator,
      new InMemoryOperationInvocationLedger(),
      governance,
    ).register(retireDefinition(handler));
    const exactRequest: OperationInvocationRequest = {
      operation_id: "scope.retire",
      operation_version: "1",
      input_schema_version: "1",
      target: { kind: "scope", id: "delivery" },
      expected_resource_revision: "7",
      idempotency_key: "governance-recovery-once",
      input: {},
    };
    const exactEnvironment = environment(
      authority("principal:operator", "interactive"),
      scope,
    );

    const first = await registry.invoke(exactEnvironment, exactRequest);
    expect(first.kind).toBe("receipt");
    if (first.kind !== "receipt") return;
    expect(first.receipt.state).toBe("outcome_unknown");
    expect(handler).toHaveBeenCalledTimes(1);

    const replay = await registry.invoke(exactEnvironment, exactRequest);
    expect(replay).toEqual({ kind: "receipt", replayed: true, receipt: first.receipt });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
