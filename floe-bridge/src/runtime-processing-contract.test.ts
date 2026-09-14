import { describe, expect, it } from "vitest";

import type { RuntimeProcessingContract } from "./bus-client.js";
import { PinnedRuntimeContractError, selectPinnedRuntime } from "./runtime-processing-contract.js";

function contract(): RuntimeProcessingContract {
  return {
    contract_kind: "scope_node",
    contract_version: 1,
    processing_contract_id: "runtime-processing-contract:v1:attempt:1",
    workspace_id: "workspace:one",
    scope_execution: {
      execution_id: "execution:1",
      scope_id: "scope:one",
      revision_id: "scope-revision:1",
    },
    node_execution: {
      node_execution_id: "node-execution:1",
      node_id: "builder",
      context_id: "context:builder",
      actor_definition_revision_id: "actor-definition:1",
      runtime_profile_revision_id: "runtime-profile-revision:1",
      actor_runtime_binding_id: "runtime-binding:1",
    },
    execution_attempt: {
      attempt_id: "attempt:1",
      node_execution_id: "node-execution:1",
      actor_definition_revision_id: "actor-definition:1",
      runtime_profile_revision_id: "runtime-profile-revision:1",
      actor_runtime_binding_id: "runtime-binding:1",
      status: "pending",
    },
    placement: {
      node_id: "builder",
      kind: "actor",
      resource_id: "actor:builder",
      bindings: [{ kind: "instructions", text: "Publish only through the named output Port." }],
    },
    context: { context_id: "context:builder", inspect_operation_id: "context.inspect" },
    actor: {
      actor_id: "actor:builder",
      definition: {
        actor_definition_revision_id: "actor-definition:1",
        actor_id: "actor:builder",
        workspace_id: "workspace:one",
        content: {
          instructions: "Build the requested result.",
          capability_grant_ids: ["grant:build"],
        },
      },
    },
    runtime: {
      binding: {
        actor_runtime_binding_id: "runtime-binding:1",
        actor_id: "actor:builder",
        workspace_id: "workspace:one",
        runtime_profile_revision_id: "runtime-profile-revision:1",
        endpoint_id: "endpoint:builder",
      },
      profile: {
        runtime_profile_revision_id: "runtime-profile-revision:1",
        runtime_profile_id: "runtime-profile:builder",
        content: {
          adapter_id: "pi-agent-core",
          configuration: {
            provider: "openai-codex",
            model: "gpt-5.6",
            auth_profile: "chatgpt-business",
            thinking_level: "high",
          },
          secret_ref_ids: ["secret-ref:chatgpt-business"],
          resource_policy: { max_turns: 30 },
        },
      },
    },
    operation_authority: {
      principal_id: "actor:builder",
      capability_grant_ids: ["grant:build"],
      authority_session_required: true,
    },
    inputs: [],
    outputs: {
      publish_operation_id: "scope.node-output.publish",
      ports: [{
        port_id: "builder:result",
        node_id: "builder",
        name: "result",
        direction: "output",
      }],
    },
  };
}

describe("selectPinnedRuntime", () => {
  it("uses only the exact RuntimeProfileRevision and ActorDefinitionRevision in the contract", () => {
    const pinned = contract();
    pinned.placement.config = { instructions: "Configuration metadata is not an instruction binding." };
    const selected = selectPinnedRuntime(pinned);
    expect(selected).toEqual({
      adapter_id: "pi-agent-core",
      config: {
        provider: "openai-codex",
        model: "gpt-5.6",
        model_source: "runtime_profile_revision",
        auth_profile: "chatgpt-business",
        auth_profile_source: "runtime_profile_revision",
        thinking_level: "high",
        instructions: "Build the requested result.\n\nPublish only through the named output Port.",
      },
      secret_ref_ids: ["secret-ref:chatgpt-business"],
      resource_policy: { max_turns: 30 },
    });
  });

  it("refuses mismatched pins before selecting a provider or model", () => {
    const invalid = contract();
    invalid.execution_attempt.runtime_profile_revision_id = "runtime-profile-revision:current";
    expect(() => selectPinnedRuntime(invalid)).toThrow(PinnedRuntimeContractError);
    expect(() => selectPinnedRuntime(invalid)).toThrow(/runtime profile pins do not match/);
  });

  it("refuses unsupported reasoning effort instead of silently changing it", () => {
    const invalid = contract();
    invalid.runtime.profile.content.configuration.thinking_level = "ultra";
    expect(() => selectPinnedRuntime(invalid)).toThrow(/thinking_level is unsupported/);
  });

  it("selects a direct Context Delivery from the same immutable Actor and runtime pins", () => {
    const scoped = contract();
    const direct = {
      contract_kind: "direct_context" as const,
      contract_version: 1 as const,
      processing_contract_id: "runtime-processing-contract:v1:delivery:1",
      workspace_id: scoped.workspace_id,
      delivery: {
        delivery_id: "delivery:1",
        stable_delivery_ids: ["stable-delivery:1"],
        endpoint_id: "endpoint:builder",
        context_id: "context:direct",
      },
      context: { context_id: "context:direct", inspect_operation_id: "context.inspect" as const },
      actor: scoped.actor,
      runtime: scoped.runtime,
      operation_authority: scoped.operation_authority,
      events: [],
      outputs: { publish_operation_id: null, ports: [] as [] },
    };

    expect(selectPinnedRuntime(direct)).toMatchObject({
      adapter_id: "pi-agent-core",
      config: {
        model: "gpt-5.6",
        instructions: "Build the requested result.",
      },
    });
  });
});
