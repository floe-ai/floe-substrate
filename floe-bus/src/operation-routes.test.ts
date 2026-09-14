import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { defaultConfig, type LocalConfig } from "./config.js";
import { createBusServer } from "./server.js";
import { INSPECT_SCOPE_PLAN_OPERATION_ID } from "./scope-operations.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;
const noProvenance = {
  cause_event_id: null,
  delivery_ids: [],
  execution_attempt_id: null,
  node_execution_id: null,
  scope_execution_id: null,
} as const;

describe("authenticated semantic operation routes", () => {
  let handle: ServerHandle;
  let directory: string;
  let workspaceId: string;
  let interactiveToken: string;
  let unattendedToken: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "floe-operation-routes-"));
    const configPath = join(directory, "config.yaml");
    const config: LocalConfig = defaultConfig(directory);
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    handle = await createBusServer(configPath, config, { unsafe_in_process_test_auth_bypass: true });
    await handle.app.ready();

    const locator = join(directory, "workspace");
    mkdirSync(locator, { recursive: true });
    const workspace = handle.store.registerWorkspace(
      { locator, name: "Acme" },
      handle.broadcast,
    ) as { workspace_id: string };
    workspaceId = workspace.workspace_id;
    handle.store.createScope({
      workspace_id: workspaceId,
      scope_id: "delivery",
      title: "Delivery",
    }, handle.broadcast);
    const draft = handle.store.createScopeCompositionDraft({
      workspace_id: workspaceId,
      scope_id: "delivery",
      content: {
        nodes: [
          {
            node_id: "arrived",
            kind: "event",
            config: { event_type: "work.arrived" },
            context_policy: { mode: "new_per_execution" },
          },
          {
            node_id: "builder",
            kind: "actor",
            resource_id: `actor:${workspaceId}:builder`,
            activation: { mode: "per_delivery" },
            context_policy: { mode: "new_per_execution" },
          },
        ],
        ports: [
          {
            port_id: "arrived:out",
            node_id: "arrived",
            name: "work",
            direction: "output",
            event_types: ["work.arrived"],
          },
          {
            port_id: "builder:in",
            node_id: "builder",
            name: "work",
            direction: "input",
            event_types: ["work.arrived"],
            min_count: 1,
          },
        ],
        edges: [{
          edge_id: "arrived-to-builder",
          source_port_id: "arrived:out",
          target_port_id: "builder:in",
        }],
      },
    }, handle.broadcast);
    handle.store.publishScopeComposition({
      revision_id: draft.revision_id,
      expected_published_revision_id: null,
    }, handle.broadcast);

    const interactiveGrant = handle.store.capabilityGrantStore.issueGrant({
      principal_id: "principal:desktop",
      boundary: { kind: "workspace", workspace_id: workspaceId },
      operation_ids: [INSPECT_SCOPE_PLAN_OPERATION_ID],
      targets: [{ kind: "scope", id: "delivery" }],
      expires_at: "2099-01-01T00:00:00.000Z",
      issuer_id: "principal:test-host",
      evidence: [{ kind: "test_fixture", ref: "interactive-plan-inspection" }],
    });
    interactiveToken = handle.store.operationAuthoritySessions.issueSession({
      principal_id: "principal:desktop",
      workspace_id: workspaceId,
      grant_ids: [interactiveGrant.grant_id],
      interaction: { mode: "interactive", session_id: "window:1" },
      provenance: noProvenance,
      expires_at: "2099-01-01T00:00:00.000Z",
    }).bearer_token;
    const unattendedGrant = handle.store.capabilityGrantStore.issueGrant({
      principal_id: "actor:acme:maintainer",
      boundary: { kind: "workspace", workspace_id: workspaceId },
      operation_ids: [INSPECT_SCOPE_PLAN_OPERATION_ID],
      targets: [{ kind: "scope", id: "delivery" }],
      expires_at: "2099-01-01T00:00:00.000Z",
      issuer_id: "principal:test-host",
      evidence: [{ kind: "test_fixture", ref: "unattended-plan-inspection" }],
    });
    unattendedToken = handle.store.operationAuthoritySessions.issueSession({
      principal_id: "actor:acme:maintainer",
      workspace_id: workspaceId,
      grant_ids: [unattendedGrant.grant_id],
      interaction: { mode: "unattended", session_id: "delivery:1" },
      provenance: {
        cause_event_id: "event:work-arrived",
        delivery_ids: ["delivery:1"],
        execution_attempt_id: "attempt:1",
        node_execution_id: "node-execution:1",
        scope_execution_id: "scope-execution:1",
      },
      expires_at: "2099-01-01T00:00:00.000Z",
    }).bearer_token;
  });

  afterEach(async () => {
    try { await handle.app.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  });

  it("refuses discovery and invocation without transport authority", async () => {
    const discovery = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations`,
    });
    expect(discovery.statusCode).toBe(401);
    expect(discovery.json()).toMatchObject({ error: "authority_token_invalid" });

    const invocation = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations/invoke`,
      payload: inspectRequest("unauthorised"),
    });
    expect(invocation.statusCode).toBe(401);
  });

  it("projects one exact contract for interactive and unattended clients", async () => {
    const url = `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations?target_kind=scope&target_id=delivery`;
    const interactive = await handle.app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${interactiveToken}` },
    });
    const unattended = await handle.app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${unattendedToken}` },
    });
    expect(interactive.statusCode).toBe(200);
    expect(unattended.statusCode).toBe(200);
    const fromInteractive = interactive.json().operations.find(
      (operation: { operation_id: string }) => operation.operation_id === INSPECT_SCOPE_PLAN_OPERATION_ID,
    );
    const fromUnattended = unattended.json().operations.find(
      (operation: { operation_id: string }) => operation.operation_id === INSPECT_SCOPE_PLAN_OPERATION_ID,
    );
    expect(fromInteractive).toEqual(fromUnattended);
    expect(fromInteractive).toMatchObject({
      operation_version: "1",
      input: { version: "1" },
      result: { version: "1" },
      availability: { available: true },
    });
  });

  it("derives identity from the bearer session and replays an idempotent receipt", async () => {
    const invoke = (key: string) => handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations/invoke`,
      headers: { authorization: `Bearer ${interactiveToken}` },
      payload: {
        ...inspectRequest(key),
        principal_id: "principal:spoofed",
        provenance: { cause_event_id: "event:spoofed" },
      },
    });
    const first = await invoke("inspect-once");
    const second = await invoke("inspect-once");
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().replayed).toBe(false);
    expect(second.json().replayed).toBe(true);
    expect(second.json().receipt).toEqual(first.json().receipt);
    expect(first.json()).toMatchObject({
      kind: "receipt",
      receipt: {
        principal_id: "principal:desktop",
        operation_id: INSPECT_SCOPE_PLAN_OPERATION_ID,
        provenance: { cause_event_id: null },
        state: "completed",
      },
    });

    const receiptId = first.json().receipt.receipt_id as string;
    const stored = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operation-receipts/${encodeURIComponent(receiptId)}`,
      headers: { authorization: `Bearer ${interactiveToken}` },
    });
    expect(stored.statusCode).toBe(200);
    expect(stored.json().receipt.receipt_id).toBe(receiptId);
  });

  it("refuses a valid session at a different Workspace boundary", async () => {
    const response = await handle.app.inject({
      method: "GET",
      url: "/v1/workspaces/workspace%3Aother/operations",
      headers: { authorization: `Bearer ${interactiveToken}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "transport_auth_required" });
  });

  function inspectRequest(idempotencyKey: string) {
    return {
      operation_id: INSPECT_SCOPE_PLAN_OPERATION_ID,
      operation_version: "1",
      input_schema_version: "1",
      target: { kind: "scope", id: "delivery" },
      idempotency_key: idempotencyKey,
      input: {},
    };
  }
});
