import { createHmac, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CredentialBrokerService } from "./credential-broker.js";
import {
  connectorBindingStateRevision,
  ConnectorStore,
  type ConnectorBindingContent,
  type ConnectorDefinitionContent,
  type ConnectorEvidenceRef,
  type ConnectorOwner,
} from "./connectors.js";
import {
  normalizePolledResource,
  normalizeSignedWebhook,
  normalizeWatchedFolderArrival,
} from "./connector-source-adapters.js";
import {
  CONNECTOR_WORKER_HEALTH_OPERATION_ID,
  CONNECTOR_WORKER_SOURCE_OPERATION_ID,
  ConnectorWorkerCheckpointStore,
  ConnectorWorkerError,
  ConnectorWorkerHost,
  planDurableSchedule,
  type ConnectorWorkerDependencies,
  type ConnectorWorkerRunner,
} from "./connector-worker.js";

const OWNER: ConnectorOwner = { kind: "workspace", id: "workspace:connector-worker" };
const IMPLEMENTATION = { kind: "extension_package_version", id: "extension:connector-test", revision: "1.0.0" } as const;
const RAW_SECRET = "subscription-secret-value-5299";
const SECRET_REF = "secretref:connector-account";
const GRANT_ID = "capgrant:connector-account";
const EVIDENCE: ConnectorEvidenceRef = { kind: "external_observation", id: "evidence:one", revision: "sha256:one" };
const DIGEST_ONE = createHash("sha256").update("one").digest("hex");
const DIGEST_TWO = createHash("sha256").update("two").digest("hex");

function definition(): ConnectorDefinitionContent {
  return {
    label: "Connector worker fixture",
    description: "Exercises canonical source patterns.",
    implementation_ref: IMPLEMENTATION,
    configuration_schema_ref: "schema:connector-worker@1",
    configuration_ui_schema_ref: null,
    credential_slots: [{
      slot_id: "account",
      title: "Connected account",
      purpose: "Use this connected account for the selected Connector operation.",
      required: true,
    }],
    source_interfaces: [
      {
        interface_id: "folder",
        title: "Watched folder",
        source_kind: "core:watched-folder",
        event_type: "file.observed",
        payload_schema_ref: "schema:file-observation@1",
        observation_mode: "push",
        polling_contract_ref: null,
        identity_scope: "resource_revision",
        verification: { mode: "origin", verifier_ref: "capability:workspace-root-check" },
        credential_slot_ids: [],
        required_capability_ids: [],
        checkpoint_schema_ref: null,
      },
      {
        interface_id: "webhook",
        title: "Signed webhook",
        source_kind: "core:signed-webhook",
        event_type: "webhook.observed",
        payload_schema_ref: "schema:webhook-observation@1",
        observation_mode: "push",
        polling_contract_ref: null,
        identity_scope: "occurrence",
        verification: { mode: "signature", verifier_ref: "capability:hmac-sha256" },
        credential_slot_ids: ["account"],
        required_capability_ids: [CONNECTOR_WORKER_SOURCE_OPERATION_ID],
        checkpoint_schema_ref: null,
      },
      {
        interface_id: "poll",
        title: "Provider cursor",
        source_kind: "extension:provider-poll",
        event_type: "provider.item.observed",
        payload_schema_ref: "schema:provider-observation@1",
        observation_mode: "connector_poll",
        polling_contract_ref: "contract:provider-cursor@1",
        identity_scope: "resource_revision",
        verification: { mode: "origin", verifier_ref: "capability:provider-origin" },
        credential_slot_ids: ["account"],
        required_capability_ids: [CONNECTOR_WORKER_SOURCE_OPERATION_ID],
        checkpoint_schema_ref: "schema:provider-cursor@1",
      },
      {
        interface_id: "schedule",
        title: "Schedule",
        source_kind: "core:schedule",
        event_type: "schedule.fired",
        payload_schema_ref: "schema:schedule-fire@1",
        observation_mode: "push",
        polling_contract_ref: null,
        identity_scope: "resource_revision",
        verification: { mode: "none", verifier_ref: null },
        credential_slot_ids: [],
        required_capability_ids: [],
        checkpoint_schema_ref: "schema:schedule-state@1",
      },
    ],
    health: {
      check_capability_id: CONNECTOR_WORKER_HEALTH_OPERATION_ID,
      evidence_schema_ref: "schema:connector-health@1",
    },
    rate_limit_policy_ref: "policy:bounded-provider-rate",
  };
}

function bindingContent(): ConnectorBindingContent {
  return {
    external_resource: { kind: "account", id: "account:fixture", display_name: "Fixture account" },
    configuration: {
      folder: "incoming",
      source_settings: {
        schedule: {
          cron: "0 * * * *",
          timezone: "UTC",
          missed_fire_policy: "latest",
          catch_up_limit: 1,
          overlap_policy: "allow",
        },
      },
    },
    enabled_source_interface_ids: ["folder", "webhook", "poll", "schedule"],
    secret_bindings: [{ slot_id: "account", secret_ref_id: SECRET_REF }],
    capability_grant_ids: [GRANT_ID],
  };
}

type Harness = ReturnType<typeof makeHarness>;

function makeHarness() {
  let tick = 0;
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const connectorStore = new ConnectorStore(
    db,
    () => `2026-09-04T01:00:${String(tick++).padStart(2, "0")}.000Z`,
  );
  const checkpointStore = new ConnectorWorkerCheckpointStore(
    db,
    () => `2026-09-04T02:00:${String(tick++).padStart(2, "0")}.000Z`,
  );
  const created = connectorStore.createDefinition({
    connector_definition_id: "connector-definition:fixture",
    owner: OWNER,
    content: definition(),
    created_by_principal_id: "principal:installer",
  });
  const bound = connectorStore.createBinding({
    connector_binding_id: "connector-binding:fixture",
    connector_definition_revision_id: created.revision.connector_definition_revision_id,
    owner: OWNER,
    content: bindingContent(),
    created_by_principal_id: "principal:installer",
  });
  const enabled = connectorStore.setBindingStatus({
    connector_binding_id: bound.binding.connector_binding_id,
    owner: OWNER,
    status: "enabled",
    expected_state_revision: connectorBindingStateRevision(
      connectorStore.requireBinding(bound.binding.connector_binding_id),
    ),
  });

  const secretRequests: unknown[] = [];
  const credentialBroker: Pick<CredentialBrokerService, "useSecret"> = {
    useSecret: async (request, use) => {
      secretRequests.push(request);
      const material = new TextEncoder().encode(RAW_SECRET);
      try {
        return await use(material);
      } finally {
        material.fill(0);
      }
    },
  };
  const materialized: string[] = [];
  let materializeFailures = 0;
  const evidenceFacts: unknown[] = [];
  let evidenceSequence = 0;
  let workspaceEffectsAllowed = true;
  const scheduleWakes: unknown[] = [];
  let pollNumber = 0;
  const pollCheckpoints: Array<ConnectorEvidenceRef | null> = [];

  const runner: ConnectorWorkerRunner = {
    inspectHealth: async () => ({
      status: "healthy",
      evidence_refs: [{ kind: "health_observation", id: "health:one", revision: "1" }],
      observed_at: "2026-09-04T03:00:00.000Z",
    }),
    normalizePush: async ({ source, envelope, credentials }) => {
      if (source.interface_id === "folder") {
        return normalizeWatchedFolderArrival(envelope as any);
      }
      if (source.interface_id === "webhook") {
        return normalizeSignedWebhook(envelope as any, credentials, "account");
      }
      throw new Error("unexpected push source");
    },
    poll: async ({ checkpoint_ref, credentials }) => {
      pollCheckpoints.push(checkpoint_ref);
      await credentials.withSecret("account", CONNECTOR_WORKER_SOURCE_OPERATION_ID, async (material) => {
        expect(new TextDecoder().decode(material)).toBe(RAW_SECRET);
      });
      pollNumber += 1;
      return {
        observations: pollNumber === 1
          ? [normalizePolledResource({
              external_identity: "provider:item:one",
              external_revision: "revision:one",
              payload_sha256: DIGEST_ONE,
              observed_at: "2026-09-04T03:10:00.000Z",
              evidence_ref: { kind: "external_observation", id: "provider:item:one", revision: "revision:one" },
            })]
          : [],
        checkpoint_ref: {
          kind: "connector_checkpoint",
          id: `provider-cursor:${pollNumber}`,
          revision: `revision:${pollNumber}`,
        },
        observed_at: `2026-09-04T03:${String(10 + pollNumber).padStart(2, "0")}:00.000Z`,
      };
    },
  };

  const dependencies: ConnectorWorkerDependencies = {
    connector_store: connectorStore,
    checkpoint_store: checkpointStore,
    credential_broker: credentialBroker,
    principal_id: "principal:connector-worker",
    workspace_effects_allowed: () => workspaceEffectsAllowed,
    resolve_runner: (implementation) => JSON.stringify(implementation) === JSON.stringify(IMPLEMENTATION) ? runner : null,
    resolve_secret_grant: (input) => input.candidate_grant_ids.includes(GRANT_ID) ? GRANT_ID : null,
    materialize_ingress: async ({ ingress }) => {
      if (materializeFailures > 0) {
        materializeFailures -= 1;
        throw new Error(`${RAW_SECRET}: simulated materializer loss`);
      }
      const id = `event:${ingress.receipt.connector_ingress_receipt_id}`;
      materialized.push(id);
      return { normalized_event_id: id, artefact_version_ids: [] };
    },
    write_evidence: async (input) => {
      evidenceFacts.push(input);
      evidenceSequence += 1;
      return { kind: "worker_evidence", id: `evidence:${evidenceSequence}`, revision: "1" };
    },
    inspect_schedule_activity: async () => ({ active_fire_count: 0 }),
    arm_schedule_wake: async (input) => {
      scheduleWakes.push(input);
    },
    now: () => "2026-09-04T04:00:00.000Z",
  };
  const host = new ConnectorWorkerHost(dependencies);

  return {
    db,
    connectorStore,
    checkpointStore,
    enabled,
    runner,
    host,
    dependencies,
    secretRequests,
    materialized,
    evidenceFacts,
    scheduleWakes,
    pollCheckpoints,
    setWorkspaceEffectsAllowed: (value: boolean) => { workspaceEffectsAllowed = value; },
    failNextMaterializations: (count: number) => { materializeFailures = count; },
  };
}

describe("canonical Connector worker", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(() => {
    harness.db.close();
  });

  it("materializes one logical Event for duplicate watched-folder pushes", async () => {
    const arrival = {
      relative_path: "concepts/overgrown-courtyard.png",
      content_sha256: DIGEST_ONE,
      size_bytes: 128,
      observed_at: "2026-09-04T05:00:00.000Z",
      evidence_ref: { kind: "artefact_version", id: "artefactversion:concept", revision: DIGEST_ONE },
    };
    const first = await harness.host.receivePush(
      harness.enabled.connector_binding_id,
      OWNER,
      "folder",
      arrival,
    );
    const replay = await harness.host.receivePush(
      harness.enabled.connector_binding_id,
      OWNER,
      "folder",
      arrival,
    );

    expect(first.receipt).toMatchObject({ status: "materialized", external_revision: DIGEST_ONE });
    expect(replay).toMatchObject({
      replayed: true,
      receipt: {
        connector_ingress_receipt_id: first.receipt.connector_ingress_receipt_id,
        normalized_event_id: first.receipt.normalized_event_id,
        physical_observation_count: 2,
      },
      observation: { classification: "duplicate" },
    });
    expect(harness.materialized).toHaveLength(1);
    expect(() => normalizeWatchedFolderArrival({ ...arrival, relative_path: "../outside.png" }))
      .toThrow(/inside the configured workspace folder/);
    expect(() => normalizeWatchedFolderArrival({ ...arrival, relative_path: "C:outside.png" }))
      .toThrow(/relative workspace path/);
  });

  it("fails closed before Connector ingress while its Workspace is held", async () => {
    const arrival = {
      relative_path: "concepts/held.png",
      content_sha256: DIGEST_ONE,
      size_bytes: 128,
      observed_at: "2026-09-04T05:00:00.000Z",
      evidence_ref: { kind: "artefact_version", id: "artefactversion:held", revision: DIGEST_ONE },
    };
    harness.setWorkspaceEffectsAllowed(false);

    await expect(harness.host.receivePush(
      harness.enabled.connector_binding_id,
      OWNER,
      "folder",
      arrival,
    )).rejects.toThrow(/restored Workspace is held/);

    expect(harness.materialized).toEqual([]);
    expect(harness.secretRequests).toEqual([]);
    expect(harness.evidenceFacts).toEqual([]);
  });

  it("coalesces concurrent replay while canonical Event materialization is in flight", async () => {
    const arrival = {
      relative_path: "concepts/concurrent.png",
      content_sha256: DIGEST_TWO,
      size_bytes: 256,
      observed_at: "2026-09-04T05:05:00.000Z",
      evidence_ref: EVIDENCE,
    };
    const [first, replay] = await Promise.all([
      harness.host.receivePush(harness.enabled.connector_binding_id, OWNER, "folder", arrival),
      harness.host.receivePush(harness.enabled.connector_binding_id, OWNER, "folder", arrival),
    ]);

    expect(first.receipt.normalized_event_id).toBe(replay.receipt.normalized_event_id);
    expect(harness.materialized).toHaveLength(1);
  });

  it("verifies signed webhooks through the credential boundary and quarantines invalid replay", async () => {
    const body = new TextEncoder().encode('{"event":"created"}');
    const signature = `sha256=${createHmac("sha256", RAW_SECRET).update(body).digest("hex")}`;
    const valid = await harness.host.receivePush(
      harness.enabled.connector_binding_id,
      OWNER,
      "webhook",
      {
        external_event_id: "delivery:one",
        body,
        signature,
        observed_at: "2026-09-04T05:10:00.000Z",
        evidence_ref: EVIDENCE,
      },
    );
    const replay = await harness.host.receivePush(
      harness.enabled.connector_binding_id,
      OWNER,
      "webhook",
      {
        external_event_id: "delivery:one",
        body,
        signature,
        observed_at: "2026-09-04T05:11:00.000Z",
        evidence_ref: EVIDENCE,
      },
    );
    const invalid = await harness.host.receivePush(
      harness.enabled.connector_binding_id,
      OWNER,
      "webhook",
      {
        external_event_id: "delivery:two",
        body,
        signature: `sha256=${"0".repeat(64)}`,
        observed_at: "2026-09-04T05:12:00.000Z",
        evidence_ref: EVIDENCE,
      },
    );

    expect(valid.receipt.status).toBe("materialized");
    expect(replay).toMatchObject({ replayed: true, observation: { classification: "duplicate" } });
    expect(invalid).toMatchObject({
      receipt: { status: "quarantined" },
      observation: {
        classification: "quarantined",
        verification: { signature: "failed", issues: ["signature_verification_failed"] },
      },
    });
    expect(harness.secretRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        secret_ref_id: SECRET_REF,
        grant_id: GRANT_ID,
        principal_id: "principal:connector-worker",
        authority_boundary: { kind: "workspace", workspace_id: OWNER.id },
        resource: { kind: "connector_binding", id: harness.enabled.connector_binding_id },
        operation_id: CONNECTOR_WORKER_SOURCE_OPERATION_ID,
      }),
    ]));
    expect(JSON.stringify(harness.db.prepare("SELECT * FROM connector_ingress_receipts").all()))
      .not.toContain(RAW_SECRET);
  });

  it("recovers an accepted observation after materialization loss without advancing or duplicating work", async () => {
    const arrival = {
      relative_path: "concepts/recover.png",
      content_sha256: DIGEST_TWO,
      size_bytes: 96,
      observed_at: "2026-09-04T05:15:00.000Z",
      evidence_ref: EVIDENCE,
    };
    harness.failNextMaterializations(1);
    await expect(harness.host.receivePush(
      harness.enabled.connector_binding_id,
      OWNER,
      "folder",
      arrival,
    )).rejects.toThrow(/accepted observation is safe/);
    const accepted = harness.db.prepare("SELECT status, normalized_event_id FROM connector_ingress_receipts").get();
    expect(accepted).toEqual({ status: "accepted", normalized_event_id: null });

    const recovered = await harness.host.receivePush(
      harness.enabled.connector_binding_id,
      OWNER,
      "folder",
      arrival,
    );
    expect(recovered).toMatchObject({
      replayed: true,
      receipt: { status: "materialized", physical_observation_count: 2 },
    });
    expect(harness.materialized).toHaveLength(1);
    expect(JSON.stringify(harness.db.prepare("SELECT * FROM connector_ingress_receipts").all()))
      .not.toContain(RAW_SECRET);
  });

  it("resumes Connector-owned polling from a durable exact checkpoint without a core poll loop", async () => {
    const first = await harness.host.pollOnce(harness.enabled.connector_binding_id, OWNER, "poll");
    expect(first).toMatchObject({
      ingress: [{ receipt: { status: "materialized", external_identity: "provider:item:one" } }],
      checkpoint: {
        state_version: 1,
        checkpoint_ref: { id: "provider-cursor:1", revision: "revision:1" },
      },
    });

    const restartedHost = new ConnectorWorkerHost(harness.dependencies);
    const second = await restartedHost.pollOnce(harness.enabled.connector_binding_id, OWNER, "poll");
    expect(second).toMatchObject({
      ingress: [],
      checkpoint: {
        state_version: 2,
        checkpoint_ref: { id: "provider-cursor:2", revision: "revision:2" },
      },
    });
    expect(harness.pollCheckpoints).toEqual([
      null,
      { kind: "connector_checkpoint", id: "provider-cursor:1", revision: "revision:1" },
    ]);
    expect(harness.db.prepare("SELECT COUNT(*) AS count FROM connector_ingress_receipts").get())
      .toEqual({ count: 1 });
  });

  it("refuses a source callback after its pinned binding is disabled", async () => {
    harness.runner.normalizePush = async ({ envelope }) => {
      const current = harness.connectorStore.requireBinding(harness.enabled.connector_binding_id);
      harness.connectorStore.setBindingStatus({
        connector_binding_id: current.connector_binding_id,
        owner: OWNER,
        status: "disabled",
        expected_state_revision: connectorBindingStateRevision(current),
      });
      return normalizeWatchedFolderArrival(envelope as any);
    };
    await expect(harness.host.receivePush(
      harness.enabled.connector_binding_id,
      OWNER,
      "folder",
      {
        relative_path: "concepts/late.png",
        content_sha256: DIGEST_TWO,
        size_bytes: 64,
        observed_at: "2026-09-04T05:20:00.000Z",
        evidence_ref: EVIDENCE,
      },
    )).rejects.toThrow(/no longer enabled/);
    expect(harness.db.prepare("SELECT COUNT(*) AS count FROM connector_ingress_receipts").get())
      .toEqual({ count: 0 });
  });

  it("plans timezone and DST-aware fires with explicit missed-fire and overlap policies", () => {
    const contract = {
      cron: "30 2 * * *",
      timezone: "Australia/Sydney",
      missed_fire_policy: "catch_up" as const,
      catch_up_limit: 2,
      overlap_policy: "allow" as const,
    };
    const acrossDstStart = planDurableSchedule({
      contract,
      cursor_at: "2026-10-02T17:00:00.000Z",
      now: "2026-10-04T16:00:00.000Z",
      active_fire_count: 0,
      identity_seed: "schedule:one",
    });
    expect(acrossDstStart.fires.map((fire) => fire.scheduled_for)).toEqual([
      "2026-10-03T16:30:00.000Z",
      "2026-10-04T15:30:00.000Z",
    ]);
    expect(planDurableSchedule({
      contract: { ...contract, missed_fire_policy: "latest" },
      cursor_at: "2026-10-01T16:00:00.000Z",
      now: "2026-10-04T16:00:00.000Z",
      active_fire_count: 0,
      identity_seed: "schedule:one",
    }).fires.map((fire) => fire.scheduled_for)).toEqual(["2026-10-04T15:30:00.000Z"]);
    expect(planDurableSchedule({
      contract: { ...contract, overlap_policy: "wait" },
      cursor_at: "2026-10-03T16:30:00.000Z",
      now: "2026-10-04T16:00:00.000Z",
      active_fire_count: 1,
      identity_seed: "schedule:one",
    })).toMatchObject({
      fires: [],
      waiting_for_active_fire: true,
      advance_through: "2026-10-03T16:30:00.000Z",
      next_due_at: null,
    });
    expect(planDurableSchedule({
      contract: { ...contract, overlap_policy: "skip" },
      cursor_at: "2026-10-03T16:30:00.000Z",
      now: "2026-10-04T16:00:00.000Z",
      active_fire_count: 1,
      identity_seed: "schedule:one",
    })).toMatchObject({
      fires: [],
      skipped_scheduled_for: ["2026-10-04T15:30:00.000Z"],
      waiting_for_active_fire: false,
      advance_through: "2026-10-04T15:30:00.000Z",
    });
  });

  it("materializes schedule occurrences once and persists its next one-shot wake", async () => {
    const input = {
      connector_binding_id: harness.enabled.connector_binding_id,
      owner: OWNER,
      source_interface_id: "schedule",
      now: "2026-09-04T05:30:00.000Z",
    };
    const first = await harness.host.runScheduleWake(input);
    const replay = await harness.host.runScheduleWake(input);
    expect(first.plan.fires).toHaveLength(1);
    expect(first.ingress[0].receipt.status).toBe("materialized");
    expect(first.checkpoint).toMatchObject({
      schedule_cursor_at: "2026-09-04T05:00:00.000Z",
      next_due_at: "2026-09-04T06:00:00.000Z",
    });
    expect(replay.plan.fires).toHaveLength(0);
    expect(replay.checkpoint.state_version).toBe(2);
    expect(harness.materialized).toHaveLength(1);
    expect(harness.scheduleWakes).toEqual([
      expect.objectContaining({ next_due_at: "2026-09-04T06:00:00.000Z" }),
      expect.objectContaining({ next_due_at: "2026-09-04T06:00:00.000Z" }),
    ]);
  });

  it("never persists a worker response that echoes brokered credential material", async () => {
    harness.runner.inspectHealth = async ({ credentials }) => {
      const echo = await credentials.withSecret("account", CONNECTOR_WORKER_HEALTH_OPERATION_ID, (material) =>
        new TextDecoder().decode(material)
      );
      return {
        status: "unhealthy",
        code: echo,
        evidence_refs: [],
        observed_at: "2026-09-04T06:00:00.000Z",
      };
    };
    const health = await harness.host.inspectHealth(harness.enabled.connector_binding_id, OWNER);
    expect(health).toMatchObject({
      status: "unhealthy",
      code: "connector_worker_unavailable",
      message: "The Connector worker did not complete its declared health check.",
    });
    expect(JSON.stringify(harness.db.prepare("SELECT * FROM connector_health_observations").all()))
      .not.toContain(RAW_SECRET);
  });

  it("keeps checkpoint compare-and-swap conflicts explicit", () => {
    const pin = harness.host.pinEnabledBinding(harness.enabled.connector_binding_id, OWNER);
    const first = harness.checkpointStore.advance({
      pin,
      source_interface_id: "poll",
      expected_state_version: 0,
      checkpoint_ref: { kind: "connector_checkpoint", id: "cursor:one", revision: "1" },
      last_observed_at: "2026-09-04T07:00:00.000Z",
      schedule_cursor_at: null,
      next_due_at: null,
    });
    expect(first.state_version).toBe(1);
    expect(() => harness.checkpointStore.advance({
      pin,
      source_interface_id: "poll",
      expected_state_version: 0,
      checkpoint_ref: { kind: "connector_checkpoint", id: "cursor:stale", revision: "2" },
      last_observed_at: "2026-09-04T07:01:00.000Z",
      schedule_cursor_at: null,
      next_due_at: null,
    })).toThrow(/checkpoint changed/);
  });
});
