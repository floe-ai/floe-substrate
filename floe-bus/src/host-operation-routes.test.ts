import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { defaultConfig, type LocalConfig } from "./config.js";
import { createBusServer } from "./server.js";
import {
  COPY_WORKSPACE_OPERATION_ID,
  FORK_WORKSPACE_OPERATION_ID,
  REBIND_WORKSPACE_OPERATION_ID,
  REGISTER_WORKSPACE_OPERATION_ID,
  RESTORE_WORKSPACE_OPERATION_ID,
} from "./workspace-operations.js";
import { INSPECT_CONNECTOR_OPERATION_ID } from "./connector-operations.js";
import { CREATE_ACTOR_OPERATION_ID, LIST_ACTORS_OPERATION_ID } from "./actor-definition-operations.js";
import { CREATE_RUNTIME_PROFILE_OPERATION_ID, LIST_RUNTIME_PROFILES_OPERATION_ID } from "./runtime-profile-operations.js";
import { INSPECT_SCOPE_PLAN_OPERATION_ID } from "./scope-operations.js";
import {
  ACCOUNT_CONNECTION_PURPOSE,
  BIND_CREDENTIAL_OPERATION_ID,
  LIST_PROVIDER_ACCOUNTS_OPERATION_ID,
  PREPARE_PROVIDER_ACCOUNT_OPERATION_ID,
} from "./credential-operations.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

describe("host semantic operation boundary", () => {
  let root: string;
  let handle: ServerHandle;
  let hostToken: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "floe-host-operations-"));
    const configPath = join(root, "config.yaml");
    const config: LocalConfig = defaultConfig(root);
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    hostToken = `floe_host_${"host-operation-test-material".repeat(2)}`;
    const previousLocalAppData = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = root;
    try {
      handle = await createBusServer(configPath, config, { host_control_token: hostToken });
    } finally {
      if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previousLocalAppData;
    }
    await handle.app.ready();
  });

  afterEach(async () => {
    try { await handle.app.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  const hostHeaders = () => ({ authorization: `Bearer ${hostToken}` });

  it("discovers host-authorised operations and records host-bound receipts", async () => {
    const discovery = await handle.app.inject({
      method: "GET",
      url: "/v1/local/operations",
      headers: hostHeaders(),
    });
    expect(discovery.statusCode).toBe(200);
    const operations = discovery.json().operations as Array<{
      operation_id: string;
      authority_boundary_kinds: string[];
    }>;
    expect(operations.map((operation) => operation.operation_id)).toEqual(expect.arrayContaining([
      COPY_WORKSPACE_OPERATION_ID,
      FORK_WORKSPACE_OPERATION_ID,
      REBIND_WORKSPACE_OPERATION_ID,
      REGISTER_WORKSPACE_OPERATION_ID,
      RESTORE_WORKSPACE_OPERATION_ID,
      INSPECT_CONNECTOR_OPERATION_ID,
    ]));
    expect(operations.every((operation) => operation.authority_boundary_kinds.includes("host"))).toBe(true);

    const locator = join(root, "semantic-workspace");
    const request = {
      operation_id: REGISTER_WORKSPACE_OPERATION_ID,
      operation_version: "1",
      input_schema_version: "1",
      idempotency_key: "register-semantic-workspace",
      input: { locator, name: "Semantic Workspace", create_directory: true },
    };
    const created = await handle.app.inject({
      method: "POST",
      url: "/v1/local/operations/invoke",
      headers: hostHeaders(),
      payload: request,
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      kind: "receipt",
      replayed: false,
      receipt: {
        operation_id: REGISTER_WORKSPACE_OPERATION_ID,
        principal_id: handle.store.localOperatorPrincipalId,
        authority_boundary: { kind: "host", host_id: handle.store.localHostId },
        state: "completed",
      },
    });
    const receiptId = created.json().receipt.receipt_id as string;

    const replay = await handle.app.inject({
      method: "POST",
      url: "/v1/local/operations/invoke",
      headers: hostHeaders(),
      payload: request,
    });
    expect(replay.json()).toMatchObject({
      kind: "receipt",
      replayed: true,
      receipt: { receipt_id: receiptId },
    });
    expect(handle.store.listWorkspaces()).toHaveLength(1);

    const receipt = await handle.app.inject({
      method: "GET",
      url: `/v1/local/operation-receipts/${encodeURIComponent(receiptId)}`,
      headers: hostHeaders(),
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json()).toMatchObject({
      receipt: { receipt_id: receiptId, authority_boundary: { kind: "host" } },
    });

    const persistedGrant = handle.store.capabilityGrantStore
      .listActiveGrantsForPrincipalBoundary(
        handle.store.localOperatorPrincipalId,
        { kind: "host", host_id: handle.store.localHostId },
      );
    expect(persistedGrant).toHaveLength(1);
    expect(persistedGrant[0]).toMatchObject({
      boundary: { kind: "host", host_id: handle.store.localHostId },
    });
  });

  it("keeps host and Workspace operation authority non-interchangeable", async () => {
    const locator = join(root, "workspace-boundary");
    const registered = await handle.app.inject({
      method: "POST",
      url: "/v1/workspaces/register",
      headers: hostHeaders(),
      payload: { locator, name: "Boundary", create_directory: true },
    });
    expect(registered.statusCode).toBe(201);
    const workspaceId = registered.json().workspace.workspace_id as string;

    const session = await handle.app.inject({
      method: "POST",
      url: `/v1/local/workspaces/${encodeURIComponent(workspaceId)}/operation-sessions`,
      headers: hostHeaders(),
      payload: { interaction_session_id: "window:boundary" },
    });
    expect(session.statusCode).toBe(201);
    const workspaceToken = session.json().bearer_token as string;

    const workspaceOnHost = await handle.app.inject({
      method: "GET",
      url: "/v1/local/operations",
      headers: { authorization: `Bearer ${workspaceToken}` },
    });
    expect(workspaceOnHost.statusCode).toBe(401);

    const hostOnWorkspace = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations`,
      headers: hostHeaders(),
    });
    expect(hostOnWorkspace.statusCode).toBe(401);

    const attemptedScopeRead = await handle.app.inject({
      method: "POST",
      url: "/v1/local/operations/invoke",
      headers: hostHeaders(),
      payload: {
        operation_id: INSPECT_SCOPE_PLAN_OPERATION_ID,
        operation_version: "1",
        input_schema_version: "1",
        target: { kind: "scope", id: "pipeline" },
        idempotency_key: "host-must-not-read-workspace-scope",
        input: {},
      },
    });
    expect(attemptedScopeRead.statusCode).toBe(200);
    expect(attemptedScopeRead.json()).toMatchObject({
      kind: "receipt",
      receipt: { refusal: { code: "operation_authority_boundary_not_supported" } },
    });
  });

  it.runIf(process.platform === "win32")(
    "connects a provider through one exact ingress without leaking credential material",
    async () => {
      const providerId = "openai-codex";
      const secretMaterial = "provider-material-that-must-never-leave-the-broker";
      const prepare = await handle.app.inject({
        method: "POST",
        url: "/v1/local/operations/invoke",
        headers: hostHeaders(),
        payload: {
          operation_id: PREPARE_PROVIDER_ACCOUNT_OPERATION_ID,
          operation_version: "1",
          input_schema_version: "1",
          idempotency_key: "prepare-provider-account",
          input: { provider_id: providerId, label: "ChatGPT" },
        },
      });
      expect(prepare.statusCode).toBe(200);
      const credential = prepare.json().receipt.result.credential as {
        secret_ref_id: string;
        generation: number;
        resolution: string;
      };
      expect(credential).toMatchObject({ generation: 0, resolution: "unresolved" });

      const issued = await handle.app.inject({
        method: "POST",
        url: "/v1/local/credential-ingress-sessions",
        headers: hostHeaders(),
        payload: {
          secret_ref_id: credential.secret_ref_id,
          purpose: ACCOUNT_CONNECTION_PURPOSE,
          expires_in_seconds: 60,
        },
      });
      expect(issued.statusCode).toBe(201);
      const ingress = issued.json() as {
        bearer_token: string;
        session: { ingress_session_id: string; audience: string; purpose: string };
      };

      const wrongAudience = await handle.app.inject({
        method: "PUT",
        url: `/v1/credential-ingress-sessions/${encodeURIComponent(ingress.session.ingress_session_id)}/material`,
        headers: {
          authorization: `Bearer ${ingress.bearer_token}`,
          "content-type": "application/octet-stream",
          "x-floe-credential-ingress-audience": "provider-auth:anthropic",
          "x-floe-credential-ingress-purpose": ACCOUNT_CONNECTION_PURPOSE,
        },
        payload: Buffer.from(secretMaterial, "utf8"),
      });
      expect(wrongAudience.statusCode).toBe(409);

      const uploaded = await handle.app.inject({
        method: "PUT",
        url: `/v1/credential-ingress-sessions/${encodeURIComponent(ingress.session.ingress_session_id)}/material`,
        headers: {
          authorization: `Bearer ${ingress.bearer_token}`,
          "content-type": "application/octet-stream",
          "x-floe-credential-ingress-audience": ingress.session.audience,
          "x-floe-credential-ingress-purpose": ingress.session.purpose,
        },
        payload: Buffer.from(secretMaterial, "utf8"),
      });
      expect(uploaded.statusCode).toBe(200);
      expect(uploaded.json()).toMatchObject({ session: { state: "ready" } });

      const bound = await handle.app.inject({
        method: "POST",
        url: "/v1/local/operations/invoke",
        headers: hostHeaders(),
        payload: {
          operation_id: BIND_CREDENTIAL_OPERATION_ID,
          operation_version: "1",
          input_schema_version: "1",
          target: { kind: "secret_ref", id: credential.secret_ref_id },
          expected_resource_revision: "generation:0:unresolved",
          idempotency_key: "bind-provider-account",
          input: {
            source: {
              kind: "credential_ingress",
              ingress_session_id: ingress.session.ingress_session_id,
            },
          },
        },
      });
      expect(bound.statusCode).toBe(200);
      expect(bound.json()).toMatchObject({
        receipt: {
          state: "completed",
          result: { credential: { generation: 1, resolution: "resolved" } },
        },
      });

      const replayUpload = await handle.app.inject({
        method: "PUT",
        url: `/v1/credential-ingress-sessions/${encodeURIComponent(ingress.session.ingress_session_id)}/material`,
        headers: {
          authorization: `Bearer ${ingress.bearer_token}`,
          "content-type": "application/octet-stream",
          "x-floe-credential-ingress-audience": ingress.session.audience,
          "x-floe-credential-ingress-purpose": ingress.session.purpose,
        },
        payload: Buffer.from(secretMaterial, "utf8"),
      });
      expect(replayUpload.statusCode).toBe(409);

      const accounts = await handle.app.inject({
        method: "POST",
        url: "/v1/local/operations/invoke",
        headers: hostHeaders(),
        payload: {
          operation_id: LIST_PROVIDER_ACCOUNTS_OPERATION_ID,
          operation_version: "1",
          input_schema_version: "1",
          idempotency_key: "list-provider-accounts",
          input: {},
        },
      });
      expect(accounts.statusCode).toBe(200);
      expect(accounts.json()).toMatchObject({
        receipt: {
          state: "completed",
          result: {
            accounts: [{
              secret_ref_id: credential.secret_ref_id,
              owner: { kind: "host", host_id: handle.store.localHostId },
              resource: { kind: "provider_account", id: providerId },
              generation: 1,
              resolution: "resolved",
            }],
          },
        },
      });

      const publicEvidence = JSON.stringify({
        prepare: prepare.json(),
        uploaded: uploaded.json(),
        bound: bound.json(),
        accounts: accounts.json(),
        durable_prepare: handle.store.operationInvocationLedger.getByReceiptId(
          prepare.json().receipt.receipt_id as string,
        ),
        durable_bind: handle.store.operationInvocationLedger.getByReceiptId(
          bound.json().receipt.receipt_id as string,
        ),
      });
      expect(publicEvidence).not.toContain(secretMaterial);
      expect(publicEvidence).not.toContain(ingress.bearer_token);
    },
    15_000,
  );

  it("delegates the raw registration adapter and exposes Actor and Runtime operations to Workspace clients", async () => {
    const locator = join(root, "compatibility-workspace");
    const registered = await handle.app.inject({
      method: "POST",
      url: "/v1/workspaces/register",
      headers: { ...hostHeaders(), "idempotency-key": "raw-register-once" },
      payload: { locator, name: "Compatibility", create_directory: true },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json()).toMatchObject({
      workspace: { workspace_id: expect.any(String) },
      receipt_id: expect.any(String),
    });
    const rawReceipt = handle.store.operationInvocationLedger
      .getByReceiptId(registered.json().receipt_id as string);
    expect(rawReceipt).toMatchObject({
      operation_id: REGISTER_WORKSPACE_OPERATION_ID,
      authority_boundary: { kind: "host", host_id: handle.store.localHostId },
    });

    const workspaceId = registered.json().workspace.workspace_id as string;
    const issued = await handle.app.inject({
      method: "POST",
      url: `/v1/local/workspaces/${encodeURIComponent(workspaceId)}/operation-sessions`,
      headers: hostHeaders(),
      payload: { interaction_session_id: "window:catalog" },
    });
    const workspaceToken = issued.json().bearer_token as string;
    const catalog = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/operations`,
      headers: { authorization: `Bearer ${workspaceToken}` },
    });
    expect(catalog.statusCode).toBe(200);
    const operationIds = catalog.json().operations.map((item: { operation_id: string }) => item.operation_id);
    expect(operationIds).toEqual(expect.arrayContaining([
      LIST_ACTORS_OPERATION_ID,
      CREATE_ACTOR_OPERATION_ID,
      LIST_RUNTIME_PROFILES_OPERATION_ID,
      CREATE_RUNTIME_PROFILE_OPERATION_ID,
    ]));
    expect(operationIds).not.toContain(REGISTER_WORKSPACE_OPERATION_ID);
  });
});
