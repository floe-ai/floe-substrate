import { describe, expect, it } from "vitest";
import type { BusClient } from "../bus-client.js";
import { createCapabilityTools } from "./capability-tools.js";

function createMockBus(): BusClient & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    discoverOperations: async (...args: unknown[]) => {
      calls.push({ method: "discoverOperations", args });
      return {
        operations: [{
          operation_id: "scope.plan.create-draft",
          operation_version: "1",
          authority_boundary_kinds: ["workspace"],
          category: "scope",
          title: "Bus-owned title",
          description: "Bus-owned description that is not duplicated by the Bridge.",
          effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
          required_grants: ["scope.plan.write"],
          interaction_constraints: { allowed_modes: ["unattended"] },
          target: { resource_kinds: [], expected_revision: "not_applicable" },
          input: {
            version: "1",
            schema: {
              type: "object",
              required: ["scope_id"],
              properties: { scope_id: { type: "string", description: "Bus-owned field wording" } },
            },
          },
          result: { version: "1", schema: { type: "object" } },
          availability: { available: true },
        }],
      };
    },
    invokeOperation: async (...args: unknown[]) => {
      calls.push({ method: "invokeOperation", args });
      return {
        kind: "receipt" as const,
        replayed: false,
        receipt: {
          receipt_id: "receipt:1",
          invocation_id: "invocation:1",
          operation_id: "scope.plan.create-draft",
          operation_version: "1",
          state: "completed" as const,
          result: { revision_id: "scope-revision:1" },
          refusal: null,
          changed_refs: [],
          progress_ref: null,
          cancel_ref: null,
          audit_ref: null,
        },
      };
    },
  } as unknown as BusClient & { calls: Array<{ method: string; args: unknown[] }> };
}

function activeTurn(overrides: Record<string, unknown> = {}) {
  return {
    delivery_id: "delivery:1",
    processing_contract_id: "runtime-processing-contract:v1:delivery:1",
    operation_authority_session: {
      authority_session_id: "operation-authority-session:1",
      bearer_token: "operation-token",
      expires_at: "2099-01-01T00:00:00.000Z",
    },
    tool_activity: [],
    ...overrides,
  };
}

describe("capability-tools", () => {
  it("exposes an awaiting approval and its exact retry identity in model-visible content", async () => {
    const bus = createMockBus(); const invoke = bus.invokeOperation.bind(bus);
    bus.invokeOperation = async (...args) => {
      const response = await invoke(...args); if(response.kind !== "receipt") throw new Error("Expected fixture");
      return {...response,receipt:{...response.receipt,state:"awaiting_approval",result:null,
        idempotency_key:"retained:export",expected_resource_revision:null,
        governance:{policy_evaluation_id:"policy:1",approval_request_ids:["approval:exact"],approval_receipt_ids:[],budget_reservation_id:null},
        refusal:{code:"operation_approval_required",message:"Review the saved request",retryable:true,required_action:null,details:{approval_request_ids:["approval:exact"]}},
      }};
    };
    const use = createCapabilityTools(bus,"workspace:1",{getActiveTurn:()=>activeTurn()})[1];
    const result = await use.execute("export",{operation_id:"artefact.version.export",operation_version:"1",input_schema_version:"1",input:{destination_path:"review.html"}});
    const text = (result.content[0] as {text:string}).text;
    const visible = JSON.parse(text.slice(text.indexOf("{")));
    expect(visible.approval_request_ids).toEqual(["approval:exact"]);
    expect(visible.retry.idempotency_key).toBe("retained:export");
    expect(visible.refusal.code).toBe("operation_approval_required");
    expect(visible).not.toHaveProperty("input");
  });
  it("gives the model exact changed references for a follow-up operation", async () => {
    const bus = createMockBus();
    const originalInvoke = bus.invokeOperation.bind(bus);
    const currentRevision = "revision:opaque:4:paused::";
    bus.invokeOperation = async (...args) => {
      const response = await originalInvoke(...args);
      if (response.kind !== "receipt") throw new Error("Expected receipt fixture");
      return { ...response, receipt: { ...response.receipt,
        target: { kind: "scope_execution", id: "execution:1", revision: "revision:opaque:3:active::" },
        result: { execution: { state_revision: 4, status: "paused" } },
        changed_refs: [{ kind: "scope_execution", id: "execution:1", revision: currentRevision }],
        progress_ref: { kind: "scope_execution", id: "execution:1", revision: currentRevision },
      } };
    };
    const use = createCapabilityTools(bus, "workspace:1", { getActiveTurn: () => activeTurn() })[1];
    const paused = await use.execute("pause", {
      operation_id: "scope.execution.pause", operation_version: "1", input_schema_version: "1", input: {},
    });
    const modelContent = (paused.content[0] as { text: string }).text;
    expect(modelContent).toContain(currentRevision);
    const envelope = JSON.parse(modelContent.slice(modelContent.indexOf("{")));
    const changed = envelope.changed_refs.find((ref: { id: string }) => ref.id === "execution:1");
    await use.execute("resume", {
      operation_id: "scope.execution.resume", operation_version: "1", input_schema_version: "1", input: {},
      target: { kind: changed.kind, id: changed.id }, expected_resource_revision: changed.revision,
    });
    expect(bus.calls.at(-1)?.args[2]).toMatchObject({ expected_resource_revision: currentRevision });
  });
  it("keeps only the fixed discovery and invocation seam", () => {
    const turn = activeTurn();
    const names = createCapabilityTools(createMockBus(), "workspace:1", { getActiveTurn: () => turn })
      .map((tool) => tool.name);
    expect(names).toEqual(["discover_capabilities", "use_capability"]);
    expect(names).not.toContain("compose_scope");
    expect(names).not.toContain("connect_folder_to_actor");
  });

  it("renders the exact semantic operation description, versions, and schemas returned by the Bus", async () => {
    const bus = createMockBus();
    const turn = activeTurn();
    const discover = createCapabilityTools(bus, "workspace:1", { getActiveTurn: () => turn })[0];
    const result = await discover.execute("discover", { operation_id: "scope.plan.create-draft", include_result_schema: true });

    const output = (result.content[0] as { type: "text"; text: string }).text;
    expect(output).toContain("Bus-owned description that is not duplicated by the Bridge.");
    expect(output).toContain("Bus-owned field wording");
    expect(output).toContain("operation_id: scope.plan.create-draft\noperation_version: 1");
    expect(output).not.toContain("scope.plan.create-draft@1");
    expect(result.details?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation_id: "scope.plan.create-draft" }),
    ]));
    expect(bus.calls[0]).toEqual({
      method: "discoverOperations",
      args: ["workspace:1", "operation-token", {
        query: "scope.plan.create-draft",
        category: undefined,
        target: null,
      }],
    });
  });

  it("keeps schema bodies out of search and loads only the exact selected input contract", async () => {
    const bus = createMockBus();
    const originalDiscover = bus.discoverOperations.bind(bus);
    bus.discoverOperations = async (...args) => {
      const result = await originalDiscover(...args);
      const first = result.operations[0];
      return { operations: [{ ...first, target: { resource_kinds: ["scope"], expected_revision: "required" } }, {
        ...first, operation_id: "scope.plan.inspect", title: "Inspect a plan",
        input: { version: "9", schema: { description: "Unrelated large input contract" } },
        result: { version: "2", schema: { description: "Large result contract" } },
        availability: { available: false, refusal: { code: "grant_required", message: "Request a current grant." } } as any,
      }] };
    };
    const discover = createCapabilityTools(bus, "workspace:1", { getActiveTurn: () => activeTurn() })[0];
    const search = await discover.execute("search", { query: "scope", limit: 1 });
    expect(search.content).toEqual([{ type: "text", text: expect.stringContaining("Showing 1 of 2 matches") }]);
    expect(JSON.stringify(search.content)).not.toContain("Bus-owned field wording");
    expect((search.content[0] as { text: string }).text).toContain('Target: {"resource_kinds":["scope"],"expected_revision":"required"}');
    const selected = await discover.execute("contract", { operation_id: "scope.plan.create-draft" });
    expect(JSON.stringify(selected.content)).toContain("Bus-owned field wording");
    expect(JSON.stringify(selected.content)).not.toContain("Unrelated large input contract");
    expect(JSON.stringify(selected.content)).not.toContain("Result schema");
    expect((selected.content[0] as { text: string }).text.match(/Target:/g)).toHaveLength(1);
    const unavailable = await discover.execute("unavailable", { operation_id: "scope.plan.inspect", include_result_schema: true });
    expect(JSON.stringify(unavailable.content)).toContain("grant_required");
    expect(JSON.stringify(unavailable.content)).toContain("Large result contract");
    const missing = await discover.execute("missing", { operation_id: "scope.plan.removed" });
    expect(JSON.stringify(missing.content)).toContain("not exposed");
    expect((missing.details as any).operations).toEqual([]);
  });

  it("invokes the exact discovered contract with Delivery authority and no caller identity", async () => {
    const bus = createMockBus();
    const turn = activeTurn();
    const use = createCapabilityTools(bus, "workspace:1", { getActiveTurn: () => turn })[1];
    const result = await use.execute("tool-call-1", {
      operation_id: "scope.plan.create-draft",
      operation_version: "1",
      input_schema_version: "1",
      input: { scope_id: "delivery" },
    });

    expect((result.content[0] as { type: "text"; text: string }).text).toContain(
      "Operation 'scope.plan.create-draft' completed. Receipt: receipt:1",
    );
    expect(result.details).toMatchObject({
      ok: true,
      operation_id: "scope.plan.create-draft",
      receipt: { result: { revision_id: "scope-revision:1" } },
    });
    expect(bus.calls[0]).toEqual({
      method: "invokeOperation",
      args: ["workspace:1", "operation-token", {
        operation_id: "scope.plan.create-draft",
        operation_version: "1",
        input_schema_version: "1",
        target: null,
        expected_resource_revision: null,
        idempotency_key: "runtime:delivery:1:tool:tool-call-1",
        input: { scope_id: "delivery" },
      }],
    });
    expect(JSON.stringify(bus.calls[0])).not.toContain("caller_endpoint_id");
  });

  it("renews an expiring Delivery authority session through authenticated runtime preparation", async () => {
    const bus = createMockBus();
    const turn = activeTurn({
      operation_authority_session: {
        authority_session_id: "operation-authority-session:old",
        bearer_token: "old-token",
        expires_at: "2000-01-01T00:00:00.000Z",
      },
    });
    (bus as any).prepareRuntimeDelivery = async (...args: unknown[]) => {
      bus.calls.push({ method: "prepareRuntimeDelivery", args });
      return {
        delivery: { state: "claimed", execution_attempt_id: null },
        processing_contract: {
          contract_kind: "direct_context",
          processing_contract_id: "runtime-processing-contract:v1:delivery:1",
        },
        operation_authority_session: {
          authority_session_id: "operation-authority-session:new",
          bearer_token: "new-token",
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      };
    };
    const discover = createCapabilityTools(bus, "workspace:1", { getActiveTurn: () => turn })[0];

    await discover.execute("discover", { query: "scope" });

    expect(bus.calls.map((call) => call.method)).toEqual(["prepareRuntimeDelivery", "discoverOperations"]);
    expect(bus.calls[1].args[1]).toBe("new-token");
    expect(turn.operation_authority_session.authority_session_id).toBe("operation-authority-session:new");
  });

  it.each(["receipt", "rejected", "conflict"] as const)("keeps canonical recovery evidence visible to the model for a %s refusal", async kind => {
    const bus = createMockBus();
    const turn = activeTurn();
    const refusal = { code: "operation_resource_revision_conflict", message: "The target changed after this operation was prepared.",
      retryable: true, required_action: { code: "refresh_resource", title: "Review the latest version", description: "Use the exact current revision." },
      details: { expected_revision: "1", current_revision: "none" } };
    const receipt = { receipt_id: "receipt:refused", state: "refused", refusal, result: null };
    (bus as any).invokeOperation = async (...args: unknown[]) => {
      bus.calls.push({ method: "invokeOperation", args });
      return kind === "receipt" ? { kind, receipt, replayed: false }
        : kind === "conflict" ? { kind, refusal, existing_receipt: receipt } : { kind, refusal };
    };
    const result = await createCapabilityTools(bus, "workspace:1", { getActiveTurn: () => turn })[1].execute("revision-retry", {
      operation_id: "scope.composition.draft.create", operation_version: "1", input_schema_version: "1", input: {},
    });
    // Tool details are for logs/UI; only content reaches the model.
    const text = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
    expect(text).toContain(refusal.message);
    expect(text).toContain('"current_revision":"none"');
    expect(text).toContain('"retryable":true');
    expect(text).toContain("refresh_resource");
    expect(text).toContain("operation_resource_revision_conflict");
    if (kind !== "rejected") expect(text).toContain("receipt:refused");
    expect(result.details).toMatchObject({ ok: false, error: refusal.code });
    expect(text).not.toContain("operation-token");
    expect(bus.calls).toHaveLength(1);
  });
});
