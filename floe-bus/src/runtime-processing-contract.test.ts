import { describe, expect, it, vi } from "vitest";

import {
  RuntimeProcessingContractError,
  RuntimeProcessingContractResolver,
  type RuntimeProcessingContractSources,
} from "./runtime-processing-contract.js";

const attempt = {
  attempt_id: "attempt:1",
  node_execution_id: "node-execution:1",
  ordinal: 2,
  delivery_ids: ["delivery:input"],
  delivery_id: "delivery:input",
  delivery_bundle_id: "bundle:retry",
  actor_definition_revision_id: "actor-definition:old",
  runtime_profile_revision_id: "runtime-profile-revision:old",
  actor_runtime_binding_id: "runtime-binding:old",
  status: "running",
  runtime: {},
  resource_use: {},
  result: {},
  error: {},
  created_at: "2026-09-04T00:00:00.000Z",
  started_at: "2026-09-04T00:00:00.000Z",
  completed_at: null,
} as const;

const nodeExecution = {
  node_execution_id: "node-execution:1",
  execution_id: "scope-execution:1",
  revision_id: "scope-revision:1",
  node_id: "analyst",
  activation_key: "concept:1",
  join_key: null,
  context_id: "context:analyst:1",
  actor_definition_revision_id: "actor-definition:old",
  runtime_profile_revision_id: "runtime-profile-revision:old",
  actor_runtime_binding_id: "runtime-binding:old",
  status: "active",
  assigned_actor_ids: ["actor:analyst"],
  failure: {},
  created_at: "2026-09-04T00:00:00.000Z",
  activated_at: "2026-09-04T00:00:00.000Z",
  completed_at: null,
  cancelled_at: null,
} as const;

const scopeExecution = {
  execution_id: "scope-execution:1",
  workspace_id: "workspace:one",
  scope_id: "scope:pipeline",
  revision_id: "scope-revision:1",
  cause_event_id: "event:input",
  root_event_id: "event:input",
  ingress_node_id: "concept-found",
  ingress_port_id: "concept-found:out",
  initiator_endpoint_id: null,
  idempotency_key: "execution:one",
  parent_execution_id: null,
  redo_of_node_execution_id: null,
  status: "active",
  environment: {},
  budget: {},
  terminal: {},
  created_at: "2026-09-04T00:00:00.000Z",
  started_at: "2026-09-04T00:00:00.000Z",
  completed_at: null,
  cancelled_at: null,
} as const;

const composition = {
  revision_id: "scope-revision:1",
  workspace_id: "workspace:one",
  scope_id: "scope:pipeline",
  revision_number: 1,
  routing_mode: "edge",
  based_on_revision_id: null,
  semantic_digest: "digest",
  created_by_endpoint_id: null,
  created_at: "2026-09-04T00:00:00.000Z",
  published_at: "2026-09-04T00:00:00.000Z",
  withdrawn_at: null,
  nodes: [{ node_id: "analyst", kind: "actor", resource_id: "actor:analyst" }],
  ports: [
    {
      port_id: "analyst:concept",
      node_id: "analyst",
      name: "concept",
      direction: "input",
      event_types: ["concept.found"],
      artefact_types: ["image/concept"],
    },
    {
      port_id: "analyst:registry",
      node_id: "analyst",
      name: "registry",
      direction: "output",
      event_types: ["registry.created"],
      artefact_types: ["application/registry+json"],
    },
  ],
  edges: [{
    edge_id: "must-not-reach-runtime",
    source_port_id: "analyst:registry",
    target_port_id: "generator:registry",
  }],
} as const;

const actorDefinition = {
  actor_definition_revision_id: "actor-definition:old",
  actor_id: "actor:analyst",
  workspace_id: "workspace:one",
  revision_number: 1,
  based_on_revision_id: null,
  semantic_digest: "actor-digest",
  content: {
    label: "Concept Registry Analyst",
    charter: "Describe the concept precisely.",
    responsibilities: [],
    instructions: "Use the concept input and publish a registry output.",
    knowledge_refs: [],
    capability_grant_ids: ["grant:workspace-read"],
    policy_refs: { budget: null, trust: null, approval: null },
    escalation_rules: [],
  },
  created_by_principal_id: "principal:operator",
  created_at: "2026-09-04T00:00:00.000Z",
  published_at: "2026-09-04T00:00:00.000Z",
  withdrawn_at: null,
} as const;

const runtimeProfile = {
  runtime_profile_revision_id: "runtime-profile-revision:old",
  runtime_profile_id: "runtime-profile:analyst",
  revision_number: 1,
  based_on_revision_id: null,
  semantic_digest: "runtime-digest",
  content: {
    label: "Analyst model",
    backing_kind: "model",
    adapter_id: "adapter:pi",
    configuration: { model: "gpt-5.6", reasoning_effort: "high" },
    secret_ref_ids: ["secret-ref:subscription"],
    required_capability_ids: [],
    checkpoint_policy: { mode: "provider_neutral", schema_ref: null },
    resource_policy: { max_turns: 20 },
  },
  created_by_principal_id: "principal:operator",
  created_at: "2026-09-04T00:00:00.000Z",
  published_at: "2026-09-04T00:00:00.000Z",
  withdrawn_at: null,
} as const;

const runtimeBinding = {
  actor_runtime_binding_id: "runtime-binding:old",
  actor_id: "actor:analyst",
  workspace_id: "workspace:one",
  runtime_profile_id: "runtime-profile:analyst",
  runtime_profile_revision_id: "runtime-profile-revision:old",
  endpoint_id: "endpoint:analyst",
  status: "resolved",
  unresolved_reasons: [],
  created_by_principal_id: "principal:operator",
  created_at: "2026-09-04T00:00:00.000Z",
  superseded_at: "2026-09-04T01:00:00.000Z",
} as const;

function sources(): RuntimeProcessingContractSources {
  return {
    executions: {
      getAttempt: vi.fn(() => attempt as any),
      getNodeExecution: vi.fn(() => nodeExecution as any),
      getExecution: vi.fn(() => scopeExecution as any),
      listReceivedInputs: vi.fn(() => [{
        input_id: "input:1",
        node_execution_id: "node-execution:1",
        port_id: "analyst:concept",
        delivery_id: "delivery:input",
        event_id: "event:input",
        artefact_version_id: "artefact-version:concept:1",
        member_key: "concept",
        input_identity: "artefact:artefact-version:concept:1:member:concept",
        state: "received",
        supersedes_input_id: null,
        reason: {},
        accepted_at: "2026-09-04T00:00:00.000Z",
      }]),
    },
    compositions: { getRevision: vi.fn(() => composition as any) },
    actors: { getRevision: vi.fn(() => actorDefinition as any) },
    runtimes: {
      getRevision: vi.fn(() => runtimeProfile as any),
      requireActorBinding: vi.fn(() => runtimeBinding as any),
    },
    artefacts: {
      getVersion: vi.fn(() => ({
        artefact_version_id: "artefact-version:concept:1",
        artefact_id: "artefact:concept",
        ordinal: 1,
        schema_ref: null,
        content_ref: {
          kind: "workspace-relative",
          path: "concepts/courtyard.png",
          digest: { algorithm: "sha256", value: "a".repeat(64) },
          media_type: "image/png",
        },
        created_at: "2026-09-04T00:00:00.000Z",
      })),
      getArtefact: vi.fn(() => ({
        artefact_id: "artefact:concept",
        workspace_id: "workspace:one",
        type_ref: "image/concept",
        created_at: "2026-09-04T00:00:00.000Z",
      })),
    },
    get_event: vi.fn(() => ({
      event_id: "event:input",
      type: "concept.found",
      workspace_id: "workspace:one",
      context_id: "context:source",
      scope_id: "scope:pipeline",
      source_endpoint_id: null,
      correlation_id: null,
      content: { instruction: "Build a registry." },
      metadata: { artefact_version_id: "artefact-version:concept:1" },
      artefact_version_ids: ["artefact-version:concept:1"],
      created_at: "2026-09-04T00:00:00.000Z",
    })),
  } as RuntimeProcessingContractSources;
}

describe("RuntimeProcessingContractResolver", () => {
  it("projects the exact pinned Actor, runtime, Context, inputs, and named outputs without topology", () => {
    const contract = new RuntimeProcessingContractResolver(sources()).resolve("attempt:1");

    expect(contract).toMatchObject({
      contract_version: 1,
      processing_contract_id: "runtime-processing-contract:v1:attempt:1",
      workspace_id: "workspace:one",
      context: { context_id: "context:analyst:1", inspect_operation_id: "context.inspect" },
      actor: {
        actor_id: "actor:analyst",
        definition: { actor_definition_revision_id: "actor-definition:old" },
      },
      runtime: {
        binding: { actor_runtime_binding_id: "runtime-binding:old", superseded_at: expect.any(String) },
        profile: { runtime_profile_revision_id: "runtime-profile-revision:old" },
      },
      operation_authority: {
        principal_id: "actor:analyst",
        capability_grant_ids: ["grant:workspace-read"],
        authority_session_required: true,
      },
      outputs: {
        publish_operation_id: "scope.node-output.publish",
        ports: [expect.objectContaining({ port_id: "analyst:registry", name: "registry" })],
      },
    });
    expect(contract.inputs).toEqual([
      expect.objectContaining({
        port: expect.objectContaining({ port_id: "analyst:concept" }),
        event: expect.objectContaining({ event_id: "event:input", type: "concept.found" }),
        artefact: expect.objectContaining({
          version: expect.objectContaining({ artefact_version_id: "artefact-version:concept:1" }),
        }),
      }),
    ]);
    expect(JSON.stringify(contract)).not.toContain("must-not-reach-runtime");
    expect(JSON.stringify(contract)).not.toContain("generator:registry");
    expect(JSON.stringify(contract)).not.toContain("api_key");
  });

  it("refuses an attempt whose Actor pin differs from its NodeExecution", () => {
    const mismatched = sources();
    mismatched.executions.getAttempt = vi.fn(() => ({
      ...attempt,
      actor_definition_revision_id: "actor-definition:current",
    } as any));

    expect(() => new RuntimeProcessingContractResolver(mismatched).resolve("attempt:1"))
      .toThrow(RuntimeProcessingContractError);
    expect(() => new RuntimeProcessingContractResolver(mismatched).resolve("attempt:1"))
      .toThrow(/pin different Actor definitions/);
  });

  it("refuses cross-Workspace Artefact input instead of leaking its ContentRef", () => {
    const mismatched = sources();
    mismatched.artefacts.getArtefact = vi.fn(() => ({
      artefact_id: "artefact:concept",
      workspace_id: "workspace:other",
      type_ref: "image/concept",
      created_at: "2026-09-04T00:00:00.000Z",
    }));

    expect(() => new RuntimeProcessingContractResolver(mismatched).resolve("attempt:1"))
      .toThrow(/unavailable in the execution Workspace/);
  });

  it("refuses a completed attempt because a historical record is not an executable instruction", () => {
    const completed = sources();
    completed.executions.getAttempt = vi.fn(() => ({ ...attempt, status: "completed" } as any));

    expect(() => new RuntimeProcessingContractResolver(completed).resolve("attempt:1"))
      .toThrow(/not executable/);
  });
});
