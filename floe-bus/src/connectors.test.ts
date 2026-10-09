import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  ConnectorIngressIdempotencyConflictError,
  ConnectorLifecycleConflictError,
  ConnectorOwnerMismatchError,
  ConnectorRevisionConflictError,
  ConnectorStore,
  ConnectorValidationError,
  connectorBindingStateRevision,
  type ConnectorBindingContent,
  type ConnectorDefinitionContent,
  type ConnectorIngressVerification,
  type ConnectorOwner,
} from "./connectors.js";

const WORKSPACE_ONE: ConnectorOwner = { kind: "workspace", id: "workspace:one" };
const WORKSPACE_TWO: ConnectorOwner = { kind: "workspace", id: "workspace:two" };
const PRINCIPAL = "principal:operator";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const VERIFIED: ConnectorIngressVerification = {
  origin: "verified",
  signature: "verified",
  schema: "valid",
  issues: [],
};
const EVIDENCE = { kind: "artefact_version", id: "artefact-version:evidence", revision: DIGEST_A } as const;
function definition(label = "External work"): ConnectorDefinitionContent {
  return {
    label,
    description: "Observe external work.",
    implementation_ref: { kind: "extension_package_version", id: "extension:example", revision: "1.0.0" },
    configuration_schema_ref: "schema:connector-config@1",
    configuration_ui_schema_ref: "schema:connector-config-ui@1",
    credential_slots: [{
      slot_id: "account",
      title: "Connected account",
      purpose: "Read observations and publish approved results.",
      required: true,
    }],
    source_interfaces: [
      {
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
      },
      {
        interface_id: "folder",
        title: "Watched folder",
        source_kind: "core:folder",
        event_type: "external.file.observed",
        payload_schema_ref: "schema:file-observation@1",
        observation_mode: "push",
        polling_contract_ref: null,
        identity_scope: "resource_revision",
        verification: { mode: "origin", verifier_ref: "capability:verify-folder-origin" },
        credential_slot_ids: [],
        required_capability_ids: ["workspace.files.observe"],
        checkpoint_schema_ref: "schema:file-checkpoint@1",
      },
      {
        interface_id: "schedule",
        title: "Scheduled fire",
        source_kind: "core:schedule",
        event_type: "external.schedule.fired",
        payload_schema_ref: "schema:schedule-fire@1",
        observation_mode: "push",
        polling_contract_ref: null,
        identity_scope: "occurrence",
        verification: { mode: "none", verifier_ref: null },
        credential_slot_ids: [],
        required_capability_ids: [],
        checkpoint_schema_ref: "schema:schedule-checkpoint@1",
      },
      {
        interface_id: "api-poll",
        title: "Connector-owned API observation",
        source_kind: "core:api",
        event_type: "external.api.item.observed",
        payload_schema_ref: "schema:api-item@1",
        observation_mode: "connector_poll",
        polling_contract_ref: "extension:example/polling@1",
        identity_scope: "resource_revision",
        verification: { mode: "origin", verifier_ref: "capability:verify-api-origin" },
        credential_slot_ids: ["account"],
        required_capability_ids: ["external.observe"],
        checkpoint_schema_ref: "schema:api-cursor@1",
      },
    ],
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
    configuration: { project: "project-one", filters: ["active"] },
    enabled_source_interface_ids: ["webhook", "folder", "schedule", "api-poll"],
    secret_bindings: [{ slot_id: "account", secret_ref_id: secretRef }],
    capability_grant_ids: ["capgrant:connector"],
  };
}

function makeStore(db: DatabaseSync): ConnectorStore {
  let tick = 0;
  return new ConnectorStore(db, () => `2026-09-04T02:00:${String(tick++).padStart(2, "0")}.000Z`);
}

function seed(store: ConnectorStore, owner = WORKSPACE_ONE) {
  const created = store.createDefinition({
    connector_definition_id: `connector-definition:${owner.id}`,
    owner,
    content: definition(),
    created_by_principal_id: PRINCIPAL,
  });
  const bound = store.createBinding({
    connector_binding_id: `connector-binding:${owner.id}`,
    connector_definition_revision_id: created.revision.connector_definition_revision_id,
    owner,
    content: bindingContent(),
    created_by_principal_id: PRINCIPAL,
  });
  const binding = store.setBindingStatus({
    connector_binding_id: bound.binding.connector_binding_id,
    owner,
    status: "enabled",
    expected_state_revision: connectorBindingStateRevision(bound.binding),
  });
  return { definition: created.definition, definitionRevision: created.revision, binding, bindingRevision: bound.revision };
}

function ingressInput(bindingId: string, bindingRevisionId: string, source: string, identity: string) {
  return {
    connector_binding_id: bindingId,
    connector_binding_revision_id: bindingRevisionId,
    owner: WORKSPACE_ONE,
    source_interface_id: source,
    idempotency_key: `ingress:${source}:${identity}`,
    external_identity: identity,
    external_revision: ["folder", "api-poll"].includes(source) ? "revision:1" : null,
    payload_digest: DIGEST_A,
    verification: source === "schedule"
      ? { origin: "not_applicable", signature: "not_applicable", schema: "valid", issues: [] } as const
      : VERIFIED,
    evidence_refs: [EVIDENCE],
    checkpoint_ref: { kind: "external_checkpoint", id: `checkpoint:${source}`, revision: "1" },
    observed_at: "2026-09-04T03:00:00.000Z",
  };
}

describe("ConnectorStore", () => {
  const databases: DatabaseSync[] = [];
  const roots: string[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) {
      try { db.close(); } catch {}
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function memoryStore(): ConnectorStore {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    databases.push(db);
    return makeStore(db);
  }

  it("keeps immutable Definition and Binding revisions under exact owners", () => {
    const store = memoryStore();
    const first = store.createDefinition({
      connector_definition_id: "connector-definition:example",
      owner: WORKSPACE_ONE,
      content: definition("Example v1"),
      created_by_principal_id: PRINCIPAL,
    });
    const second = store.reviseDefinition({
      connector_definition_id: first.definition.connector_definition_id,
      owner: WORKSPACE_ONE,
      expected_current_revision_id: first.revision.connector_definition_revision_id,
      content: definition("Example v2"),
      changed_by_principal_id: PRINCIPAL,
    });
    expect(second.revision.based_on_revision_id).toBe(first.revision.connector_definition_revision_id);
    expect(store.listDefinitionRevisions(first.definition.connector_definition_id, WORKSPACE_ONE))
      .toMatchObject([{ revision_number: 2 }, { revision_number: 1 }]);

    const createdBinding = store.createBinding({
      connector_binding_id: "connector-binding:example",
      connector_definition_revision_id: second.revision.connector_definition_revision_id,
      owner: WORKSPACE_ONE,
      content: bindingContent(),
      created_by_principal_id: PRINCIPAL,
    });
    expect(createdBinding.binding).toMatchObject({ owner: WORKSPACE_ONE, status: "disabled", state_version: 1 });
    const enabled = store.setBindingStatus({
      connector_binding_id: createdBinding.binding.connector_binding_id,
      owner: WORKSPACE_ONE,
      status: "enabled",
      expected_state_revision: connectorBindingStateRevision(createdBinding.binding),
    });
    expect(enabled.status).toBe("enabled");
    expect(store.listHeadChanges("connector_definition", first.definition.connector_definition_id)).toHaveLength(2);
    expect(store.listHeadChanges("connector_binding", createdBinding.binding.connector_binding_id)).toHaveLength(1);
    expect(() => store.requireBindingForOwner(enabled.connector_binding_id, WORKSPACE_TWO))
      .toThrow(ConnectorOwnerMismatchError);
    expect(() => store.reviseDefinition({
      connector_definition_id: first.definition.connector_definition_id,
      owner: WORKSPACE_ONE,
      expected_current_revision_id: first.revision.connector_definition_revision_id,
      content: definition("Stale"),
      changed_by_principal_id: PRINCIPAL,
    })).toThrow(ConnectorRevisionConflictError);
  });

  it("rejects raw credentials and persists only SecretRef and CapabilityGrant references", () => {
    const store = memoryStore();
    const created = store.createDefinition({
      owner: WORKSPACE_ONE,
      content: definition(),
      created_by_principal_id: PRINCIPAL,
    });
    expect(() => store.createBinding({
      connector_definition_revision_id: created.revision.connector_definition_revision_id,
      owner: WORKSPACE_ONE,
      content: { ...bindingContent(), configuration: { nested: { api_key: "raw-secret" } } },
      created_by_principal_id: PRINCIPAL,
    })).toThrow(ConnectorValidationError);

    const binding = store.createBinding({
      connector_definition_revision_id: created.revision.connector_definition_revision_id,
      owner: WORKSPACE_ONE,
      content: bindingContent(),
      created_by_principal_id: PRINCIPAL,
    });
    expect(binding.revision.content).toMatchObject({
      secret_bindings: [{ secret_ref_id: "secretref:account:v1" }],
      capability_grant_ids: ["capgrant:connector"],
    });
    expect(JSON.stringify(binding.revision.content)).not.toContain("raw-secret");
  });

  it("stores Connector-owned polling declarations without creating a core polling schedule", () => {
    const store = memoryStore();
    const invalid = definition();
    expect(() => store.createDefinition({
      owner: WORKSPACE_ONE,
      content: {
        ...invalid,
        source_interfaces: invalid.source_interfaces.map((source) => source.interface_id === "api-poll"
          ? { ...source, polling_contract_ref: null }
          : source),
      },
      created_by_principal_id: PRINCIPAL,
    })).toThrow(/Connector-worker polling contract/);

    const seeded = seed(store);
    const source = store.getSourceInterfaceForBinding(seeded.binding.connector_binding_id, WORKSPACE_ONE, "api-poll");
    expect(source).toMatchObject({ observation_mode: "connector_poll", polling_contract_ref: "extension:example/polling@1" });
    const coreTimerTables = (store.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
      .map((row) => row.name)
      .filter((name) => /connector.*(?:timer|schedule|poll)/i.test(name));
    expect(coreTimerTables).toEqual([]);
  });

  it("deduplicates webhook, folder, schedule, and API observations while retaining physical evidence", () => {
    const store = memoryStore();
    const seeded = seed(store);
    for (const source of ["webhook", "folder", "schedule", "api-poll"]) {
      const first = store.recordIngress(ingressInput(
        seeded.binding.connector_binding_id,
        seeded.binding.current_revision_id,
        source,
        `external:${source}:1`,
      ));
      const second = store.recordIngress({
        ...ingressInput(
          seeded.binding.connector_binding_id,
          seeded.binding.current_revision_id,
          source,
          `external:${source}:1`,
        ),
        idempotency_key: `transport-retry:${source}`,
      });
      expect(second.replayed).toBe(true);
      expect(second.receipt.connector_ingress_receipt_id).toBe(first.receipt.connector_ingress_receipt_id);
      expect(second.receipt.physical_observation_count).toBe(2);
      expect(store.listIngressObservations(first.receipt.connector_ingress_receipt_id, WORKSPACE_ONE)
        .map((item) => item.classification)).toEqual(["accepted", "duplicate"]);
    }
  });

  it("quarantines invalid observations and conflicting reuse without replacing accepted truth", () => {
    const store = memoryStore();
    const seeded = seed(store);
    const invalid = store.recordIngress({
      ...ingressInput(seeded.binding.connector_binding_id, seeded.binding.current_revision_id, "webhook", "external:bad"),
      verification: { origin: "verified", signature: "failed", schema: "valid", issues: ["signature mismatch"] },
    });
    expect(invalid.receipt.status).toBe("quarantined");
    expect(store.listQuarantinedIngress(WORKSPACE_ONE)).toHaveLength(1);

    const accepted = store.recordIngress(ingressInput(
      seeded.binding.connector_binding_id,
      seeded.binding.current_revision_id,
      "webhook",
      "external:accepted",
    ));
    expect(() => store.recordIngress({
      ...ingressInput(seeded.binding.connector_binding_id, seeded.binding.current_revision_id, "webhook", "external:accepted"),
      payload_digest: DIGEST_B,
    })).toThrow(ConnectorIngressIdempotencyConflictError);
    expect(store.requireIngressReceipt(accepted.receipt.connector_ingress_receipt_id).status).toBe("accepted");
    expect(store.listIngressObservations(accepted.receipt.connector_ingress_receipt_id, WORKSPACE_ONE)
      .at(-1)?.classification).toBe("quarantined_conflict");
  });

  it("deduplicates after process restart and attaches one immutable Event outcome", () => {
    const root = mkdtempSync(join(tmpdir(), "floe-connectors-"));
    roots.push(root);
    const path = join(root, "connectors.sqlite");
    const firstDb = new DatabaseSync(path);
    firstDb.exec("PRAGMA foreign_keys = ON");
    const firstStore = makeStore(firstDb);
    const seeded = seed(firstStore);
    const observed = firstStore.recordIngress(ingressInput(
      seeded.binding.connector_binding_id,
      seeded.binding.current_revision_id,
      "schedule",
      "schedule-fire:1",
    ));
    firstDb.close();

    const secondDb = new DatabaseSync(path);
    secondDb.exec("PRAGMA foreign_keys = ON");
    databases.push(secondDb);
    const secondStore = makeStore(secondDb);
    const replay = secondStore.recordIngress({
      ...ingressInput(
        seeded.binding.connector_binding_id,
        seeded.binding.current_revision_id,
        "schedule",
        "schedule-fire:1",
      ),
      idempotency_key: "after-restart",
    });
    expect(replay).toMatchObject({ replayed: true, receipt: { physical_observation_count: 2 } });
    const materialized = secondStore.attachIngressOutcome({
      connector_ingress_receipt_id: observed.receipt.connector_ingress_receipt_id,
      owner: WORKSPACE_ONE,
      normalized_event_id: "event:one",
      artefact_version_ids: ["artefact-version:one"],
    });
    expect(materialized).toMatchObject({ status: "materialized", normalized_event_id: "event:one" });
    expect(secondStore.attachIngressOutcome({
      connector_ingress_receipt_id: observed.receipt.connector_ingress_receipt_id,
      owner: WORKSPACE_ONE,
      normalized_event_id: "event:one",
      artefact_version_ids: ["artefact-version:one"],
    })).toEqual(materialized);
  });

  it("disables immediately, rotates by immutable revision, and refuses stale work", () => {
    const store = memoryStore();
    const seeded = seed(store);
    const disabled = store.setBindingStatus({
      connector_binding_id: seeded.binding.connector_binding_id,
      owner: WORKSPACE_ONE,
      status: "disabled",
      expected_state_revision: connectorBindingStateRevision(seeded.binding),
    });
    expect(() => store.recordIngress(ingressInput(
      disabled.connector_binding_id,
      disabled.current_revision_id,
      "webhook",
      "external:disabled",
    ))).toThrow(ConnectorLifecycleConflictError);

    const rotated = store.rotateBindingSecrets({
      connector_binding_id: disabled.connector_binding_id,
      owner: WORKSPACE_ONE,
      expected_current_revision_id: disabled.current_revision_id,
      secret_bindings: [{ slot_id: "account", secret_ref_id: "secretref:account:v2" }],
      changed_by_principal_id: PRINCIPAL,
    });
    expect(rotated.revision).toMatchObject({
      based_on_revision_id: disabled.current_revision_id,
      content: { secret_bindings: [{ secret_ref_id: "secretref:account:v2" }] },
    });
    const enabled = store.setBindingStatus({
      connector_binding_id: rotated.binding.connector_binding_id,
      owner: WORKSPACE_ONE,
      status: "enabled",
      expected_state_revision: connectorBindingStateRevision(rotated.binding),
    });
    expect(() => store.recordIngress(ingressInput(
      enabled.connector_binding_id,
      disabled.current_revision_id,
      "webhook",
      "external:stale",
    ))).toThrow(ConnectorRevisionConflictError);
    expect(store.recordIngress(ingressInput(
      enabled.connector_binding_id,
      enabled.current_revision_id,
      "webhook",
      "external:current",
    )).receipt.status).toBe("accepted");
  });

  it("records health evidence and isolates it by owner", () => {
    const store = memoryStore();
    const seeded = seed(store);
    const health = store.recordHealth({
      connector_binding_id: seeded.binding.connector_binding_id,
      connector_binding_revision_id: seeded.binding.current_revision_id,
      owner: WORKSPACE_ONE,
      status: "degraded",
      code: "rate_limited",
      message: "The external service asked this Connector to slow down.",
      evidence_refs: [EVIDENCE],
      observed_at: "2026-09-04T04:00:00.000Z",
    });
    expect(store.currentHealth(seeded.binding.connector_binding_id, WORKSPACE_ONE)).toEqual(health);
    expect(() => store.currentHealth(seeded.binding.connector_binding_id, WORKSPACE_TWO))
      .toThrow(ConnectorOwnerMismatchError);
  });
});
