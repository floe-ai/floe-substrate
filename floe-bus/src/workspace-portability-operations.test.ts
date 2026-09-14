import { describe, expect, it, vi } from "vitest";

import type { OperationExecutionContext } from "./operations.js";
import {
  SUPPLY_WORKSPACE_CONTENT_OPERATION_ID,
  WORKSPACE_BUNDLE_RESTORE_SEMANTICS,
  WorkspacePortabilityError,
  type WorkspacePortabilityService,
} from "./workspace-portability.js";
import {
  EXPORT_WORKSPACE_BUNDLE_OPERATION_ID,
  INSPECT_WORKSPACE_RESTORE_OPERATION_ID,
  LOCATE_WORKSPACE_BUNDLE_OPERATION_ID,
  PREFLIGHT_WORKSPACE_RESTORE_OPERATION_ID,
  RECONCILE_WORKSPACE_RESTORE_OPERATION_ID,
  RELEASE_WORKSPACE_RESTORE_HOLD_OPERATION_ID,
  RESTORE_WORKSPACE_BUNDLE_OPERATION_ID,
  workspacePortabilityOperationDefinitions,
} from "./workspace-portability-operations.js";

describe("Workspace portability semantic operations", () => {
  it("exposes one shared operation contract with host paths limited to host authority", () => {
    const definitions = workspacePortabilityOperationDefinitions({} as WorkspacePortabilityService);
    expect(definitions.map((item) => item.operation_id)).toEqual([
      EXPORT_WORKSPACE_BUNDLE_OPERATION_ID,
      LOCATE_WORKSPACE_BUNDLE_OPERATION_ID,
      PREFLIGHT_WORKSPACE_RESTORE_OPERATION_ID,
      RESTORE_WORKSPACE_BUNDLE_OPERATION_ID,
      INSPECT_WORKSPACE_RESTORE_OPERATION_ID,
      SUPPLY_WORKSPACE_CONTENT_OPERATION_ID,
      RECONCILE_WORKSPACE_RESTORE_OPERATION_ID,
      RELEASE_WORKSPACE_RESTORE_HOLD_OPERATION_ID,
    ]);
    expect(definitions.find((item) => item.operation_id === EXPORT_WORKSPACE_BUNDLE_OPERATION_ID)?.authority_boundary_kinds)
      .toEqual(["workspace"]);
    expect(definitions.find((item) => item.operation_id === LOCATE_WORKSPACE_BUNDLE_OPERATION_ID)?.authority_boundary_kinds)
      .toEqual(["host"]);
    expect(definitions.find((item) => item.operation_id === RESTORE_WORKSPACE_BUNDLE_OPERATION_ID)?.interaction_constraints.confirmation)
      .toEqual(expect.objectContaining({ required: true }));
    expect(definitions.find((item) => item.operation_id === RELEASE_WORKSPACE_RESTORE_HOLD_OPERATION_ID)?.interaction_constraints.confirmation)
      .toEqual(expect.objectContaining({ required: true }));
  });

  it("exports the authenticated Workspace and returns an opaque package reference rather than a host path", async () => {
    const exportWorkspace = vi.fn(() => ({
      bundle_id: "workspace_bundle_1",
      bundle_digest: "a".repeat(64),
      workspace_id: "workspace_1",
      bundle_directory: "C:\\private\\exports\\workspace_bundle_1",
      manifest: manifest(),
    }));
    const service = { exportWorkspace } as unknown as WorkspacePortabilityService;
    const definition = workspacePortabilityOperationDefinitions(service)
      .find((item) => item.operation_id === EXPORT_WORKSPACE_BUNDLE_OPERATION_ID)!;
    const outcome = await definition.handler(workspaceContext(), {});
    expect(exportWorkspace).toHaveBeenCalledWith("workspace_1");
    expect(outcome.state).toBe("completed");
    if (outcome.state !== "completed") return;
    expect(JSON.stringify(outcome.result)).not.toContain("C:\\private");
    expect(outcome.result).toEqual({
      bundle: expect.objectContaining({
        bundle_id: "workspace_bundle_1",
        workspace_id: "workspace_1",
        record_count: 1,
      }),
    });
  });

  it("keeps restore held and maps unresolved rebinding to one actionable refusal", async () => {
    const restoreWorkspace = vi.fn(() => ({
      workspace_id: "workspace_1",
      bundle_id: "workspace_bundle_1",
      bundle_digest: "a".repeat(64),
      state: "held" as const,
      inserted_record_count: 20,
      retained_record_count: 0,
      unresolved_dependencies: [dependency()],
      backup_path: null,
    }));
    const releaseRestoreHold = vi.fn(() => {
      throw new WorkspacePortabilityError(
        "restore_dependencies_unresolved",
        "This Workspace still has local bindings that must be resolved before work can resume.",
      );
    });
    const service = { restoreWorkspace, releaseRestoreHold } as unknown as WorkspacePortabilityService;
    const definitions = workspacePortabilityOperationDefinitions(service);
    const restore = definitions.find((item) => item.operation_id === RESTORE_WORKSPACE_BUNDLE_OPERATION_ID)!;
    const restored = await restore.handler(hostContext(), {
      bundle_directory: "C:\\packages\\workspace_bundle_1",
      workspace_locator: "D:\\Workspaces\\Alpha",
    });
    expect(restored).toEqual(expect.objectContaining({ state: "completed" }));
    if (restored.state === "completed") {
      expect(restored.result).toEqual(expect.objectContaining({ state: "held", backup_created: false }));
    }

    const release = definitions.find((item) => item.operation_id === RELEASE_WORKSPACE_RESTORE_HOLD_OPERATION_ID)!;
    const refused = await release.handler(workspaceContext(), { expected_bundle_digest: "a".repeat(64) });
    expect(refused).toEqual({
      state: "refused",
      refusal: expect.objectContaining({
        code: "restore_dependencies_unresolved",
        required_action: expect.objectContaining({ code: "resolve_bindings" }),
      }),
    });
  });
});

function workspaceContext(): OperationExecutionContext {
  return {
    authority: {
      principal_id: "principal_1",
      boundary: { kind: "workspace", workspace_id: "workspace_1" },
      grants: new Set(),
      interaction: {
        mode: "interactive",
        session_id: "session_1",
        confirmed_prompts: new Set(),
        approval_refs: new Set(),
      },
    },
    target: {
      ref: { kind: "workspace", id: "workspace_1", revision: null },
    },
    invocation_id: "invocation_1",
    idempotency_key: "idempotency_1",
    expected_resource_revision: null,
    provenance: {
      cause_event_id: null,
      delivery_ids: [],
      execution_attempt_id: null,
      node_execution_id: null,
      scope_execution_id: null,
    },
    governance: {
      policy_evaluation_id: null,
      approval_request_ids: [],
      approval_receipt_ids: [],
      budget_reservation_id: null,
    },
  };
}

function hostContext(): OperationExecutionContext {
  return {
    ...workspaceContext(),
    authority: {
      ...workspaceContext().authority,
      boundary: { kind: "host", host_id: "host_1" },
    },
    target: null,
  };
}

function dependency() {
  return {
    dependency_id: "dependency_1",
    kind: "secret_ref" as const,
    resource_id: "secret_1",
    reason: "Reconnect it.",
  };
}

function manifest() {
  return {
    format: "floe.workspace.directory-bundle" as const,
    format_version: 1 as const,
    record_version: 1 as const,
    source_database_schema_version: 11,
    minimum_target_database_schema_version: 11,
    workspace_id: "workspace_1",
    workspace_identity_digest: "b".repeat(64),
    records: [{
      table: "workspaces",
      columns: ["workspace_id"],
      primary_key: ["workspace_id"],
      schema_digest: "c".repeat(64),
      record_count: 1,
      records_digest: "d".repeat(64),
      path: "records/workspaces.jsonl",
    }],
    content: [],
    restore_semantics: WORKSPACE_BUNDLE_RESTORE_SEMANTICS,
    unresolved_dependencies: [dependency()],
    redaction_count: 0,
    bundle_digest: "a".repeat(64),
    bundle_id: "workspace_bundle_1",
  };
}
