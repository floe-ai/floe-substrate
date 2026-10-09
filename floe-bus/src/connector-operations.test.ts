import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BIND_CONNECTOR_OPERATION_ID,
  CONFIGURE_CONNECTOR_BINDING_OPERATION_ID,
  CONFIGURE_CONNECTOR_DEFINITION_OPERATION_ID,
  DISABLE_CONNECTOR_BINDING_OPERATION_ID,
  ENABLE_CONNECTOR_BINDING_OPERATION_ID,
  INGEST_CONNECTOR_OBSERVATION_OPERATION_ID,
  INSPECT_CONNECTOR_OPERATION_ID,
  RECORD_CONNECTOR_HEALTH_OPERATION_ID,
  ROTATE_CONNECTOR_BINDING_OPERATION_ID,
  connectorOperationDefinitions,
  registerConnectorOperations,
  resolveConnectorOperationResource,
} from "./connector-operations.js";
import {
  ConnectorStore,
  connectorBindingStateRevision,
  externalEffectStateRevision,
  type ConnectorBindingContent,
  type ConnectorDefinitionContent,
  type ConnectorOwner,
} from "./connectors.js";
import { AjvOperationSchemaValidator } from "./operation-schema-validator-ajv.js";
import { createTestOperationRegistry } from "./operation-test-fixtures.js";
import {
  createOperationAuthorityContext,
  type OperationAuthorityContext,
  type OperationInteractionMode,
  type OperationInvocationEnvironment,
  type OperationInvocationRequest,
  type OperationInvocationResponse,
} from "./operations.js";

const OPERATION_IDS = [
  INSPECT_CONNECTOR_OPERATION_ID,
  CONFIGURE_CONNECTOR_DEFINITION_OPERATION_ID,
  BIND_CONNECTOR_OPERATION_ID,
  CONFIGURE_CONNECTOR_BINDING_OPERATION_ID,
  ENABLE_CONNECTOR_BINDING_OPERATION_ID,
  DISABLE_CONNECTOR_BINDING_OPERATION_ID,
  ROTATE_CONNECTOR_BINDING_OPERATION_ID,
  RECORD_CONNECTOR_HEALTH_OPERATION_ID,
  INGEST_CONNECTOR_OBSERVATION_OPERATION_ID,
] as const;

const WORKSPACE_ONE: ConnectorOwner = { kind: "workspace", id: "workspace:one" };
const WORKSPACE_TWO: ConnectorOwner = { kind: "workspace", id: "workspace:two" };
const HOST_ONE: ConnectorOwner = { kind: "host", id: "host:one" };
const DIGEST_A = "a".repeat(64);
const EVIDENCE = { kind: "artefact_version", id: "artefact-version:evidence", revision: DIGEST_A } as const;
function definition(label = "External work"): ConnectorDefinitionContent {
  return {
    label,
    description: "Observe external work and publish approved results.",
    implementation_ref: { kind: "extension_package_version", id: "extension:example", revision: "1.0.0" },
    configuration_schema_ref: "schema:connector-config@1",
    configuration_ui_schema_ref: "schema:connector-config-ui@1",
    credential_slots: [{
      slot_id: "account",
      title: "Connected account",
      purpose: "Read observations and publish approved results.",
      required: true,
    }],
    source_interfaces: [{
      interface_id: "webhook",
      title: "Signed webhook",
      source_kind: "core:webhook",
      event_type: "external.item.received",
      payload_schema_ref: "schema:webhook@1",
      observation_mode: "push",
      polling_contract_ref: null,
      identity_scope: "occurrence",
      verification: { mode: "signature", verifier_ref: "capability:verify-signature" },
      credential_slot_ids: ["account"],
      required_capability_ids: ["external.observe"],
      checkpoint_schema_ref: null,
    }],
    health: {
      check_capability_id: "connector.health.inspect",
      evidence_schema_ref: "schema:connector-health@1",
    },
    rate_limit_policy_ref: "policy:external-rate-limit",
  };
}

function bindingContent(secretRef = "secretref:account:v1"): ConnectorBindingContent {
  return {
    external_resource: { kind: "account", id: "account:example", display_name: "Example account" },
    configuration: { project: "project-one" },
    enabled_source_interface_ids: ["webhook"],
    secret_bindings: [{ slot_id: "account", secret_ref_id: secretRef }],
    capability_grant_ids: ["capgrant:connector"],
  };
}

function authority(
  owner: ConnectorOwner = WORKSPACE_ONE,
  mode: OperationInteractionMode = "interactive",
  options: Readonly<{
    grants?: ReadonlySet<string>;
    broker_id?: string | null;
    confirmed_prompts?: ReadonlySet<string>;
    approval_refs?: ReadonlySet<string>;
  }> = {},
): OperationAuthorityContext {
  if (owner.kind === "deployment") throw new Error("Deployment authority is not in the current operation contract.");
  return createOperationAuthorityContext({
    principal_id: "principal:operator",
    boundary: owner.kind === "workspace"
      ? { kind: "workspace", workspace_id: owner.id }
      : { kind: "host", host_id: owner.id },
    grants: options.grants ?? new Set(OPERATION_IDS),
    interaction: {
      mode,
      session_id: `session:${owner.id}:${mode}`,
      broker_id: options.broker_id ?? null,
      confirmed_prompts: options.confirmed_prompts ?? new Set(),
      approval_refs: options.approval_refs ?? new Set(),
    },
  });
}

function environment(store: ConnectorStore, auth = authority()): OperationInvocationEnvironment {
  return {
    authority: auth,
    resolve_resource: async (target) => resolveConnectorOperationResource(store, auth, target),
    now: () => "2026-09-04T05:00:00.000Z",
  };
}

function request(
  operationId: string,
  input: unknown,
  idempotencyKey: string,
  options: Readonly<{
    target?: { kind: string; id: string };
    expected_revision?: string;
  }> = {},
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

function seed(store: ConnectorStore, owner: ConnectorOwner = WORKSPACE_ONE, enabled = true) {
  const created = store.createDefinition({
    connector_definition_id: `connector-definition:${owner.id}`,
    owner,
    content: definition(),
    created_by_principal_id: "principal:installer",
  });
  const bound = store.createBinding({
    connector_binding_id: `connector-binding:${owner.id}`,
    connector_definition_revision_id: created.revision.connector_definition_revision_id,
    owner,
    content: bindingContent(),
    created_by_principal_id: "principal:installer",
  });
  const binding = enabled
    ? store.setBindingStatus({
        connector_binding_id: bound.binding.connector_binding_id,
        owner,
        status: "enabled",
        expected_state_revision: connectorBindingStateRevision(bound.binding),
      })
    : bound.binding;
  return { ...created, binding, bindingRevision: bound.revision };
}

describe("Connector semantic operations", () => {
  let db: DatabaseSync;
  let store: ConnectorStore;
  let registry: ReturnType<typeof createTestOperationRegistry>;
  let tick: number;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    tick = 0;
    store = new ConnectorStore(db, () => `2026-09-04T04:00:${String(tick++).padStart(2, "0")}.000Z`);
    registry = registerConnectorOperations(
      createTestOperationRegistry(new AjvOperationSchemaValidator()),
      store,
    );
  });

  afterEach(() => db.close());

  it("publishes one provider-neutral contract for Workspace and host authority", async () => {
    const definitions = connectorOperationDefinitions(store);
    expect(definitions.map((item) => item.operation_id)).toEqual(OPERATION_IDS);
    expect(definitions.every((item) =>
      item.authority_boundary_kinds.join(",") === "workspace,host"
      && item.required_grants.length === 1
      && item.required_grants[0] === item.operation_id
    )).toBe(true);
    expect(registry.listCurrentOperationIds({ interaction_mode: "unattended", boundary_kind: "workspace" }))
      .toEqual(OPERATION_IDS.filter((id) => id !== ROTATE_CONNECTOR_BINDING_OPERATION_ID).toSorted());
    expect(registry.listCurrentOperationIds({ interaction_mode: "interactive", boundary_kind: "host" }))
      .toEqual(OPERATION_IDS.filter((id) => id !== INGEST_CONNECTOR_OBSERVATION_OPERATION_ID).toSorted());

    const hostSeed = seed(store, HOST_ONE);
    const projected = await registry.project({
      authority: authority(HOST_ONE),
      target: (await environment(store, authority(HOST_ONE)).resolve_resource({
        kind: "connector_binding",
        id: hostSeed.binding.connector_binding_id,
      }))!,
    });
    expect(projected.find((item) => item.operation_id === INSPECT_CONNECTOR_OPERATION_ID))
      .toMatchObject({ availability: { available: true } });
    expect(JSON.stringify(definitions.map((item) => item.input.schema))).not.toContain('"owner"');
  });

  it("binds and changes lifecycle through exact revisions, then rotates only through the credential broker", async () => {
    const created = store.createDefinition({
      owner: WORKSPACE_ONE,
      content: definition(),
      created_by_principal_id: "principal:installer",
    });
    const boundReceipt = receipt(await registry.invoke(
      environment(store),
      request(BIND_CONNECTOR_OPERATION_ID, {
        connector_binding_id: "connector-binding:operation",
        content: bindingContent(),
      }, "bind", {
        target: {
          kind: "connector_definition_revision",
          id: created.revision.connector_definition_revision_id,
        },
      }),
    ));
    expect(boundReceipt.state).toBe("completed");
    const binding = (boundReceipt.result as any).binding;
    expect(binding).toMatchObject({ status: "disabled", owner: WORKSPACE_ONE });

    const enabled = receipt(await registry.invoke(
      environment(store),
      request(ENABLE_CONNECTOR_BINDING_OPERATION_ID, {}, "enable", {
        target: { kind: "connector_binding", id: binding.connector_binding_id },
        expected_revision: connectorBindingStateRevision(binding),
      }),
    ));
    expect((enabled.result as any).binding.status).toBe("enabled");

    const current = (enabled.result as any).binding;
    const stale = receipt(await registry.invoke(
      environment(store),
      request(DISABLE_CONNECTOR_BINDING_OPERATION_ID, {}, "disable-stale", {
        target: { kind: "connector_binding", id: current.connector_binding_id },
        expected_revision: connectorBindingStateRevision(binding),
      }),
    ));
    expect(stale).toMatchObject({ state: "refused", refusal: { code: "operation_resource_revision_conflict" } });

    const missingBroker = receipt(await registry.invoke(
      environment(store),
      request(ROTATE_CONNECTOR_BINDING_OPERATION_ID, {
        secret_bindings: [{ slot_id: "account", secret_ref_id: "secretref:account:v2" }],
      }, "rotate-without-broker", {
        target: { kind: "connector_binding", id: current.connector_binding_id },
        expected_revision: connectorBindingStateRevision(current),
      }),
    ));
    expect(missingBroker).toMatchObject({ state: "refused", refusal: { code: "operation_broker_required" } });

    const rotated = receipt(await registry.invoke(
      environment(store, authority(WORKSPACE_ONE, "interactive", { broker_id: "credential-broker" })),
      request(ROTATE_CONNECTOR_BINDING_OPERATION_ID, {
        secret_bindings: [{ slot_id: "account", secret_ref_id: "secretref:account:v2" }],
      }, "rotate", {
        target: { kind: "connector_binding", id: current.connector_binding_id },
        expected_revision: connectorBindingStateRevision(current),
      }),
    ));
    expect((rotated.result as any).revision.content.secret_bindings)
      .toEqual([{ slot_id: "account", secret_ref_id: "secretref:account:v2" }]);
  });

  it("revises definitions and bindings, records evidence-backed health, and inspects the same records", async () => {
    const seeded = seed(store, WORKSPACE_ONE, false);
    const revisedDefinition = receipt(await registry.invoke(
      environment(store),
      request(CONFIGURE_CONNECTOR_DEFINITION_OPERATION_ID, {
        content: definition("External work v2"),
      }, "revise-definition", {
        target: { kind: "connector_definition", id: seeded.definition.connector_definition_id },
        expected_revision: seeded.definition.current_revision_id,
      }),
    ));
    expect(revisedDefinition).toMatchObject({
      state: "completed",
      result: { revision: { revision_number: 2, content: { label: "External work v2" } } },
    });

    const configured = receipt(await registry.invoke(
      environment(store),
      request(CONFIGURE_CONNECTOR_BINDING_OPERATION_ID, {
        connector_definition_revision_id: (revisedDefinition.result as any).revision.connector_definition_revision_id,
        content: { ...bindingContent(), configuration: { project: "project-two" } },
      }, "revise-binding", {
        target: { kind: "connector_binding", id: seeded.binding.connector_binding_id },
        expected_revision: connectorBindingStateRevision(seeded.binding),
      }),
    ));
    const binding = (configured.result as any).binding;
    expect((configured.result as any).revision).toMatchObject({
      revision_number: 2,
      content: { configuration: { project: "project-two" } },
    });

    const health = receipt(await registry.invoke(
      environment(store),
      request(RECORD_CONNECTOR_HEALTH_OPERATION_ID, {
        status: "healthy",
        message: "The Connector worker completed its declared check.",
        evidence_refs: [EVIDENCE],
        observed_at: "2026-09-04T05:10:00.000Z",
      }, "record-health", {
        target: { kind: "connector_binding", id: binding.connector_binding_id },
        expected_revision: connectorBindingStateRevision(binding),
      }),
    ));
    expect(health).toMatchObject({
      state: "completed",
      result: { health: { status: "healthy", evidence_refs: [EVIDENCE] } },
    });

    const inspected = receipt(await registry.invoke(
      environment(store),
      request(INSPECT_CONNECTOR_OPERATION_ID, {}, "inspect-binding", {
        target: { kind: "connector_binding", id: binding.connector_binding_id },
      }),
    ));
    expect(inspected).toMatchObject({
      state: "completed",
      result: {
        resource_kind: "connector_binding",
        binding: { connector_binding_id: binding.connector_binding_id },
        binding_revision: { connector_binding_revision_id: binding.current_revision_id },
        health: { status: "healthy" },
      },
    });
  });

  it("refuses raw secrets and cross-Workspace targets through the shared operation boundary", async () => {
    const seeded = seed(store, WORKSPACE_ONE, false);
    const rawSecret = receipt(await registry.invoke(
      environment(store),
      request(CONFIGURE_CONNECTOR_BINDING_OPERATION_ID, {
        content: { ...bindingContent(), configuration: { nested: { api_key: "raw-secret" } } },
      }, "reject-raw-input", {
        target: { kind: "connector_binding", id: seeded.binding.connector_binding_id },
        expected_revision: connectorBindingStateRevision(seeded.binding),
      }),
    ));
    expect(rawSecret).toMatchObject({ state: "refused", refusal: { code: "connector_input_invalid" } });
    expect(JSON.stringify(rawSecret)).not.toContain("raw-secret");

    const crossWorkspace = receipt(await registry.invoke(
      environment(store, authority(WORKSPACE_TWO)),
      request(INSPECT_CONNECTOR_OPERATION_ID, {}, "cross-workspace", {
        target: { kind: "connector_binding", id: seeded.binding.connector_binding_id },
      }),
    ));
    expect(crossWorkspace).toMatchObject({
      state: "refused",
      refusal: { code: "operation_target_not_found" },
    });
  });

  it("deduplicates repeated ingress operations while retaining each physical observation", async () => {
    const seeded = seed(store);
    const auth = authority(WORKSPACE_ONE, "unattended");
    const input = {
      source_interface_id: "webhook",
      external_identity: "webhook-delivery:one",
      payload_digest: DIGEST_A,
      verification: { origin: "verified", signature: "verified", schema: "valid", issues: [] },
      evidence_refs: [EVIDENCE],
      observed_at: "2026-09-04T05:00:00.000Z",
    };
    const first = receipt(await registry.invoke(
      environment(store, auth),
      request(INGEST_CONNECTOR_OBSERVATION_OPERATION_ID, input, "transport-delivery:one", {
        target: { kind: "connector_binding", id: seeded.binding.connector_binding_id },
        expected_revision: connectorBindingStateRevision(seeded.binding),
      }),
    ));
    const second = receipt(await registry.invoke(
      environment(store, auth),
      request(INGEST_CONNECTOR_OBSERVATION_OPERATION_ID, input, "transport-delivery:retry", {
        target: { kind: "connector_binding", id: seeded.binding.connector_binding_id },
        expected_revision: connectorBindingStateRevision(seeded.binding),
      }),
    ));
    expect(first.state).toBe("completed");
    expect((second.result as any)).toMatchObject({
      replayed: true,
      receipt: {
        connector_ingress_receipt_id: (first.result as any).receipt.connector_ingress_receipt_id,
        physical_observation_count: 2,
      },
      observation: { classification: "duplicate" },
    });
  });
});
