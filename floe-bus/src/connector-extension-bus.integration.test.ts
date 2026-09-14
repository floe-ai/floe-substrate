import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { defaultConfig } from "./config.js";
import { INSPECT_CONNECTOR_OPERATION_ID } from "./connector-operations.js";
import type { ConnectorDefinitionContent, ConnectorOwner } from "./connectors.js";
import {
  CREATE_EXTENSION_OPERATION_ID,
  INSPECT_EXTENSION_OPERATION_ID,
  LIST_EXTENSIONS_OPERATION_ID,
} from "./extension-operations.js";
import {
  createOperationAuthorityContext,
  type OperationAuthorityContext,
  type OperationInvocationEnvironment,
  type OperationInvocationRequest,
  type OperationInvocationResponse,
} from "./operations.js";
import { BusStore } from "./store.js";

const WORKSPACE_ONE = "workspace:connector-extension-one";
const WORKSPACE_TWO = "workspace:connector-extension-two";
const GRANTS = new Set([
  INSPECT_CONNECTOR_OPERATION_ID,
  CREATE_EXTENSION_OPERATION_ID,
  INSPECT_EXTENSION_OPERATION_ID,
  LIST_EXTENSIONS_OPERATION_ID,
]);

function connectorDefinition(label: string): ConnectorDefinitionContent {
  return {
    label,
    description: "Observe a typed external source without exposing credential values.",
    implementation_ref: {
      kind: "extension_package_version",
      id: "extension-package:connector-runtime",
      revision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    configuration_schema_ref: "schema:connector-config@1",
    configuration_ui_schema_ref: null,
    credential_slots: [],
    source_interfaces: [{
      interface_id: "webhook",
      title: "Webhook",
      source_kind: "core:webhook",
      event_type: "external.item.received",
      payload_schema_ref: "schema:webhook@1",
      observation_mode: "push",
      polling_contract_ref: null,
      identity_scope: "occurrence",
      verification: { mode: "origin", verifier_ref: "capability:origin.verify" },
      credential_slot_ids: [],
      required_capability_ids: ["external.observe"],
      checkpoint_schema_ref: null,
    }],
    action_interfaces: [],
    health: { check_capability_id: "connector.health.inspect", evidence_schema_ref: null },
    rate_limit_policy_ref: null,
  };
}

function authority(boundary: { kind: "workspace"; workspace_id: string } | { kind: "host"; host_id: string }) {
  return createOperationAuthorityContext({
    principal_id: "principal:integration-test",
    boundary,
    grants: GRANTS,
    interaction: {
      mode: "interactive",
      session_id: `session:${boundary.kind}`,
      confirmed_prompts: new Set(),
      approval_refs: new Set(),
    },
  });
}

function environment(store: BusStore, auth: OperationAuthorityContext): OperationInvocationEnvironment {
  return {
    authority: auth,
    resolve_resource: (target) => store.resolveOperationResource(target, auth.boundary),
    now: () => "2026-09-04T08:00:00.000Z",
  };
}

function request(
  operationId: string,
  idempotencyKey: string,
  target?: { kind: string; id: string },
): OperationInvocationRequest {
  return {
    operation_id: operationId,
    operation_version: "1",
    input_schema_version: "1",
    input: operationId === CREATE_EXTENSION_OPERATION_ID
      ? { extension_id: "extension:workspace-one", label: "Workspace Extension" }
      : {},
    idempotency_key: idempotencyKey,
    ...(target ? { target } : {}),
  };
}

function receipt(response: OperationInvocationResponse) {
  expect(response.kind).toBe("receipt");
  if (response.kind !== "receipt") throw new Error("Expected operation receipt");
  return response.receipt;
}

describe("Connector and Extension canonical Bus integration", () => {
  let temp: string;
  let store: BusStore;

  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), "floe-connector-extension-integration-"));
    const configPath = join(temp, "config.yaml");
    const config = defaultConfig(temp);
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    store = new BusStore(configPath, config);
  });

  afterEach(() => {
    try { store.close(); } catch {}
    rmSync(temp, { recursive: true, force: true });
  });

  it("uses one schema, operation registry, and authority-bound resource resolver", async () => {
    const schemaNames = (store.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND (
        name LIKE 'connector_%'
        OR name IN ('canonical_extensions', 'extension_package_versions', 'extension_installations', 'extension_installation_changes')
      )
      ORDER BY name
    `).all() as Array<{ name: string }>).map((row) => row.name);
    expect(schemaNames).toEqual(expect.arrayContaining([
      "connector_definitions",
      "connector_definition_revisions",
      "connector_bindings",
      "canonical_extensions",
      "extension_package_versions",
      "extension_installations",
      "extension_installation_changes",
    ]));

    const workspaceAuthority = authority({ kind: "workspace", workspace_id: WORKSPACE_ONE });
    const hostAuthority = authority({ kind: "host", host_id: store.localHostId });
    const [workspaceOperations, hostOperations] = await Promise.all([
      store.operationRegistry.project({ authority: workspaceAuthority }),
      store.operationRegistry.project({ authority: hostAuthority }),
    ]);
    expect(workspaceOperations.map((item) => item.operation_id)).toEqual(expect.arrayContaining([
      INSPECT_CONNECTOR_OPERATION_ID,
      CREATE_EXTENSION_OPERATION_ID,
      INSPECT_EXTENSION_OPERATION_ID,
      LIST_EXTENSIONS_OPERATION_ID,
    ]));
    expect(hostOperations.map((item) => item.operation_id)).toContain(INSPECT_CONNECTOR_OPERATION_ID);
    expect(hostOperations.map((item) => item.operation_id)).not.toEqual(expect.arrayContaining([
      CREATE_EXTENSION_OPERATION_ID,
      INSPECT_EXTENSION_OPERATION_ID,
      LIST_EXTENSIONS_OPERATION_ID,
    ]));

    const createdExtension = receipt(await store.operationRegistry.invoke(
      environment(store, workspaceAuthority),
      request(CREATE_EXTENSION_OPERATION_ID, "create-extension"),
    ));
    expect(createdExtension.state).toBe("completed");

    const workspaceConnectorOwner: ConnectorOwner = { kind: "workspace", id: WORKSPACE_ONE };
    const workspaceConnector = store.connectorStore.createDefinition({
      connector_definition_id: "connector-definition:workspace-one",
      owner: workspaceConnectorOwner,
      content: connectorDefinition("Workspace Connector"),
      created_by_principal_id: "principal:integration-test",
    });
    const hostConnector = store.connectorStore.createDefinition({
      connector_definition_id: "connector-definition:host",
      owner: { kind: "host", id: store.localHostId },
      content: connectorDefinition("Host Connector"),
      created_by_principal_id: "principal:integration-test",
    });

    const extensionTarget = { kind: "extension", id: "extension:workspace-one" } as const;
    const workspaceConnectorTarget = {
      kind: "connector_definition",
      id: workspaceConnector.definition.connector_definition_id,
    } as const;
    const hostConnectorTarget = {
      kind: "connector_definition",
      id: hostConnector.definition.connector_definition_id,
    } as const;

    expect(store.resolveOperationResource(extensionTarget, workspaceAuthority.boundary)?.ref.revision).toBe("0");
    expect(store.resolveOperationResource(workspaceConnectorTarget, workspaceAuthority.boundary)?.ref.revision)
      .toBe(workspaceConnector.definition.current_revision_id);
    expect(store.resolveOperationResource(hostConnectorTarget, hostAuthority.boundary)?.ref.revision)
      .toBe(hostConnector.definition.current_revision_id);

    const extensionInspection = receipt(await store.operationRegistry.invoke(
      environment(store, workspaceAuthority),
      request(INSPECT_EXTENSION_OPERATION_ID, "inspect-extension", extensionTarget),
    ));
    expect(extensionInspection.result).toMatchObject({
      extension: { extension_id: "extension:workspace-one", workspace_id: WORKSPACE_ONE },
      package_versions: [],
      installation: null,
    });
    const connectorInspection = receipt(await store.operationRegistry.invoke(
      environment(store, hostAuthority),
      request(INSPECT_CONNECTOR_OPERATION_ID, "inspect-host-connector", hostConnectorTarget),
    ));
    expect(connectorInspection.result).toMatchObject({
      resource_kind: "connector_definition",
      definition: { connector_definition_id: "connector-definition:host", owner: { kind: "host", id: store.localHostId } },
    });

    const otherWorkspaceAuthority = authority({ kind: "workspace", workspace_id: WORKSPACE_TWO });
    expect(store.resolveOperationResource(extensionTarget, otherWorkspaceAuthority.boundary)).toBeNull();
    expect(store.resolveOperationResource(workspaceConnectorTarget, otherWorkspaceAuthority.boundary)).toBeNull();
    expect(store.resolveOperationResource(extensionTarget, hostAuthority.boundary)).toBeNull();
    expect(store.resolveOperationResource(hostConnectorTarget, workspaceAuthority.boundary)).toBeNull();

    const denied = receipt(await store.operationRegistry.invoke(
      environment(store, otherWorkspaceAuthority),
      request(INSPECT_EXTENSION_OPERATION_ID, "inspect-cross-workspace", extensionTarget),
    ));
    expect(denied).toMatchObject({
      state: "refused",
      refusal: { code: "operation_target_not_found" },
    });
  });
});
