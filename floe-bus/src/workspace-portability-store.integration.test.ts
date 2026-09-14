import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { defaultConfig } from "./config.js";
import { BusStore } from "./store.js";
import { BIND_CREDENTIAL_OPERATION_ID } from "./credential-operations.js";
import { RECORD_CONNECTOR_HEALTH_OPERATION_ID } from "./connector-operations.js";
import { ENABLE_EXTENSION_OPERATION_ID } from "./extension-operations.js";
import { REPLACE_ACTOR_RUNTIME_BINDING_OPERATION_ID } from "./runtime-profile-operations.js";
import {
  EXPORT_WORKSPACE_BUNDLE_OPERATION_ID,
  INSPECT_WORKSPACE_RESTORE_OPERATION_ID,
  LOCATE_WORKSPACE_BUNDLE_OPERATION_ID,
  PREFLIGHT_WORKSPACE_RESTORE_OPERATION_ID,
  RECONCILE_WORKSPACE_RESTORE_OPERATION_ID,
  RELEASE_WORKSPACE_RESTORE_HOLD_OPERATION_ID,
  RESTORE_WORKSPACE_BUNDLE_OPERATION_ID,
} from "./workspace-portability-operations.js";
import { WorkspacePortabilityError } from "./workspace-portability.js";

const WORKSPACE_ID = "workspace_portability_integration";
const ENDPOINT_ID = "actor:portability:worker";
const BRIDGE_ID = "bridge:portability:test";
const PULSE_ID = "pulse_portability_test";
const opened: Array<{ store: BusStore; root: string }> = [];

afterEach(() => {
  for (const item of opened.splice(0)) {
    try { item.store.close(); } catch {}
    rmSync(item.root, { recursive: true, force: true });
  }
});

describe("BusStore portable Workspace integration", () => {
  it("registers the shared operations and exports the complete live schema", () => {
    const { store, workspaceRoot } = makeStore();
    const workspaceOperations = operationIds(store, "workspace");
    const hostOperations = operationIds(store, "host");

    expect(workspaceOperations).toEqual(expect.arrayContaining([
      EXPORT_WORKSPACE_BUNDLE_OPERATION_ID,
      INSPECT_WORKSPACE_RESTORE_OPERATION_ID,
      RELEASE_WORKSPACE_RESTORE_HOLD_OPERATION_ID,
    ]));
    expect(hostOperations).toEqual(expect.arrayContaining([
      LOCATE_WORKSPACE_BUNDLE_OPERATION_ID,
      PREFLIGHT_WORKSPACE_RESTORE_OPERATION_ID,
      RESTORE_WORKSPACE_BUNDLE_OPERATION_ID,
    ]));
    const restoreHoldRecoveryOperations = store.operationRegistry.listCurrentOperationMetadata({
      interaction_mode: "interactive",
      boundary_kind: "workspace",
    }).filter((operation) => operation.effects.allowed_during_restore_hold === true)
      .map((operation) => operation.operation_id)
      .sort();
    expect(restoreHoldRecoveryOperations).toEqual([
      BIND_CREDENTIAL_OPERATION_ID,
      RECORD_CONNECTOR_HEALTH_OPERATION_ID,
      ENABLE_EXTENSION_OPERATION_ID,
      REPLACE_ACTOR_RUNTIME_BINDING_OPERATION_ID,
      RECONCILE_WORKSPACE_RESTORE_OPERATION_ID,
      RELEASE_WORKSPACE_RESTORE_HOLD_OPERATION_ID,
    ].sort());

    const exported = store.workspacePortabilityService.exportWorkspace(WORKSPACE_ID);
    expect(exported.manifest.workspace_id).toBe(WORKSPACE_ID);
    expect(exported.manifest.records.find((record) => record.table === "workspaces")?.record_count).toBe(1);
    expect(exported.bundle_directory).not.toContain(workspaceRoot);
  });

  it("fails closed when any application table has no portability classification", () => {
    const { store } = makeStore();
    store.db.exec(`
      CREATE TABLE unclassified_relation_only (
        left_id TEXT NOT NULL,
        right_id TEXT NOT NULL,
        PRIMARY KEY (left_id, right_id)
      )
    `);

    expect(() => store.workspacePortabilityService.exportWorkspace(WORKSPACE_ID)).toThrowError(
      expect.objectContaining<Partial<WorkspacePortabilityError>>({ code: "workspace_table_unclassified" }),
    );
  });

  it("holds Delivery claims and Pulse activation without rewriting retained states", () => {
    const { store } = makeStore();
    const broadcast = () => {};
    store.registerEndpoint({
      endpoint_id: ENDPOINT_ID,
      workspace_id: WORKSPACE_ID,
      name: "Portability worker",
      bridge_id: BRIDGE_ID,
      status: "idle",
    }, broadcast);
    store.submitEvent({
      type: "message",
      workspace_id: WORKSPACE_ID,
      source_endpoint_id: "actor:portability:operator",
      thread_id: "thread:portability",
      destination: { kind: "endpoint", endpoint_id: ENDPOINT_ID },
      content: { text: "Retain this queued work." },
      response: { expected: true },
    }, broadcast);

    const contextId = store.contextStore.createContext({
      workspace_id: WORKSPACE_ID,
      scope_id: null,
      created_by_endpoint_id: ENDPOINT_ID,
      participants: [ENDPOINT_ID],
    });
    store.createPulse({
      pulse_id: PULSE_ID,
      workspace_id: WORKSPACE_ID,
      trigger: { type: "once", at: "2099-01-01T00:00:00.000Z" },
      content: { text: "Retain this Pulse." },
      subscribers: [{ kind: "context", context_id: contextId }],
    }, broadcast);
    expect(store.getActivePulsesForScheduler().map((pulse) => pulse.pulse_id)).toContain(PULSE_ID);

    addRestoreHold(store);

    expect(store.claimDeliveries(BRIDGE_ID, 10, broadcast)).toEqual([]);
    expect((store.listDeliveries({ workspace_id: WORKSPACE_ID }) as Array<{ state: string }>)[0]?.state).toBe("reserved");
    expect(store.getActivePulsesForScheduler().map((pulse) => pulse.pulse_id)).not.toContain(PULSE_ID);
    expect((store.getPulse(PULSE_ID) as { status: string }).status).toBe("active");

    store.updatePulseStatus(PULSE_ID, "paused", broadcast);
    expect(() => store.updatePulseStatus(PULSE_ID, "active", broadcast)).toThrowError(
      expect.objectContaining<Partial<WorkspacePortabilityError>>({ code: "workspace_restore_held" }),
    );
    expect(() => store.createPulse({
      pulse_id: "pulse_new_while_held",
      workspace_id: WORKSPACE_ID,
      trigger: { type: "once", at: "2099-01-02T00:00:00.000Z" },
      content: {},
      subscribers: [{ kind: "context", context_id: contextId }],
    }, broadcast)).toThrowError(
      expect.objectContaining<Partial<WorkspacePortabilityError>>({ code: "workspace_restore_held" }),
    );
  });
});

function makeStore(): { store: BusStore; workspaceRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "floe-portability-store-"));
  const configPath = join(root, "config.yaml");
  const config = defaultConfig(root);
  writeFileSync(configPath, YAML.stringify(config), "utf8");
  const store = new BusStore(configPath, config);
  const workspaceRoot = join(root, "workspace-on-host-a");
  mkdirSync(workspaceRoot, { recursive: true });
  const timestamp = "2026-09-04T00:00:00.000Z";
  store.workspaceIdentityStore.restoreWorkspace({
    snapshot: {
      workspace_id: WORKSPACE_ID,
      name: "Portable integration",
      creation_kind: "created",
      source_workspace_id: null,
      created_at: timestamp,
      updated_at: timestamp,
    },
    binding: {
      host_id: store.localHostId,
      platform: store.localWorkspacePlatform,
      locator: workspaceRoot,
      init_authorized: true,
    },
  });
  opened.push({ store, root });
  return { store, workspaceRoot };
}

function operationIds(store: BusStore, boundary: "workspace" | "host"): string[] {
  return store.operationRegistry.listCurrentOperationMetadata({
    interaction_mode: "interactive",
    boundary_kind: boundary,
  }).map((operation) => operation.operation_id);
}

function addRestoreHold(store: BusStore): void {
  const digest = "a".repeat(64);
  store.db.prepare(`
    INSERT INTO workspace_restore_holds (
      workspace_id, bundle_id, bundle_digest, state, reason, restored_at,
      released_at, released_by_principal_id
    ) VALUES (?, ?, ?, 'held', ?, ?, NULL, NULL)
  `).run(
    WORKSPACE_ID,
    "workspace_bundle_test",
    digest,
    "Restored work is held until local bindings are reconnected.",
    "2026-09-04T01:00:00.000Z",
  );
}
