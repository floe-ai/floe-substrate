import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyCapabilityGrantSchema, SqliteCapabilityGrantStore } from "./capability-grants.js";
import {
  applyCredentialBrokerSchema,
  CredentialBrokerService,
  InMemoryCredentialBroker,
  SqliteSecretRefStore,
} from "./credential-broker.js";
import {
  ACCOUNT_CONNECTION_PURPOSE,
  BIND_CREDENTIAL_OPERATION_ID,
  CREDENTIAL_MAINTENANCE_PURPOSE,
  credentialOperationDefinitions,
  HEALTH_CREDENTIAL_OPERATION_ID,
  REFRESH_CREDENTIAL_OPERATION_ID,
  REVOKE_CREDENTIAL_OPERATION_ID,
  ROTATE_CREDENTIAL_OPERATION_ID,
  RUNTIME_CREDENTIAL_PURPOSE,
  USE_CREDENTIAL_OPERATION_ID,
} from "./credential-operations.js";
import type { OperationExecutionContext } from "./operations.js";

describe("credential semantic operations", () => {
  let db: DatabaseSync;
  let refs: SqliteSecretRefStore;
  let grants: SqliteCapabilityGrantStore;
  let service: CredentialBrokerService;
  let grantId: string;
  const workspaceId = "workspace:credential-operations";
  const secretRefId = "secretref:runtime-provider";
  const runtimeProfileId = "runtime-profile:floe";
  const principalId = "actor:workspace:credential-operations:floe";
  const operationIds = [
    BIND_CREDENTIAL_OPERATION_ID,
    HEALTH_CREDENTIAL_OPERATION_ID,
    ROTATE_CREDENTIAL_OPERATION_ID,
    REVOKE_CREDENTIAL_OPERATION_ID,
    USE_CREDENTIAL_OPERATION_ID,
    REFRESH_CREDENTIAL_OPERATION_ID,
  ];

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    applyCapabilityGrantSchema(db);
    applyCredentialBrokerSchema(db);
    refs = new SqliteSecretRefStore(db, {
      now: () => "2026-09-04T00:00:00.000Z",
      secret_ref_id_factory: () => secretRefId,
      audit_id_factory: (() => {
        let sequence = 0;
        return () => `secret-audit:${++sequence}`;
      })(),
    });
    grants = new SqliteCapabilityGrantStore(db, {
      now: () => "2026-09-04T00:00:00.000Z",
      grant_id_factory: () => "capability-grant:runtime-provider",
    });
    const broker = new InMemoryCredentialBroker("broker:test");
    service = new CredentialBrokerService(refs, grants, [broker]);
    refs.createSecretRef({
      owner: { kind: "workspace", workspace_id: workspaceId },
      secret_ref_id: secretRefId,
      resource: { kind: "runtime_profile", id: runtimeProfileId },
      secret_kind: "provider-credential",
      label: "Connected provider",
    });
    const grant = grants.issueGrant({
      principal_id: principalId,
      boundary: { kind: "workspace", workspace_id: workspaceId },
      operation_ids: operationIds,
      targets: [
        { kind: "secret_ref", id: secretRefId },
        { kind: "runtime_profile", id: runtimeProfileId },
      ],
      expires_at: "2026-09-05T00:00:00.000Z",
      issuer_id: "principal:operator",
      evidence: [{ kind: "test", ref: "credential-operations" }],
    });
    grantId = grant.grant_id;
    refs.attachGrantConstraint({
      grant_id: grantId,
      secret_ref_id: secretRefId,
      authority_boundary: { kind: "workspace", workspace_id: workspaceId },
      purposes: [
        ACCOUNT_CONNECTION_PURPOSE,
        CREDENTIAL_MAINTENANCE_PURPOSE,
        RUNTIME_CREDENTIAL_PURPOSE,
      ],
    }, grants);
  });

  afterEach(() => db.close());

  function context(operationId: string, expectedRevision: string | null, principal = principalId): OperationExecutionContext {
    return {
      authority: {
        principal_id: principal,
        capability_grant_ids: [grantId],
        grants: new Set([operationId]),
        boundary: { kind: "workspace", workspace_id: workspaceId },
        interaction: {
          mode: "interactive",
          session_id: "session:credential-operations",
          broker_id: "broker:test",
          confirmed_prompts: new Set(["credential.rotate.confirm", "credential.revoke.confirm"]),
          approval_refs: new Set(),
        },
      },
      target: {
        ref: { kind: "secret_ref", id: secretRefId, revision: expectedRevision },
      },
      invocation_id: `invocation:${operationId}`,
      idempotency_key: `idempotency:${operationId}`,
      expected_resource_revision: expectedRevision,
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

  it("binds, checks and revokes through safe public results", async () => {
    const providerCredential = JSON.stringify({ type: "api_key", key: "never-in-a-receipt" });
    const operations = credentialOperationDefinitions({
      secret_refs: refs,
      capability_grants: grants,
      broker: service,
      legacy_source: {
        async read(input) {
          expect(input).toEqual({
            kind: "legacy_auth_profile",
            profile_id: "provider-personal",
            source_fingerprint: `sha256:${"a".repeat(64)}`,
          });
          return {
            provider_id: "openai",
            material: Uint8Array.from(Buffer.from(providerCredential, "utf8")),
          };
        },
      },
      ingress: { consume() { throw new Error("not used"); } },
      broker_id: "broker:test",
      expected_provider: () => "openai",
    });
    const byId = new Map(operations.map((operation) => [operation.operation_id, operation]));

    const bound = await (byId.get(BIND_CREDENTIAL_OPERATION_ID)!.handler as any)(
      context(BIND_CREDENTIAL_OPERATION_ID, "generation:0:unresolved"),
      {
        source: {
          kind: "legacy_auth_profile",
          profile_id: "provider-personal",
          source_fingerprint: `sha256:${"a".repeat(64)}`,
        },
      },
    );
    expect(bound).toMatchObject({
      state: "completed",
      result: { credential: { resolution: "resolved", generation: 1 } },
    });
    expect(JSON.stringify(bound)).not.toContain("never-in-a-receipt");
    expect(JSON.stringify(bound)).not.toContain("memory:");

    const health = await (byId.get(HEALTH_CREDENTIAL_OPERATION_ID)!.handler as any)(
      context(HEALTH_CREDENTIAL_OPERATION_ID, null),
      {},
    );
    expect(health).toMatchObject({
      state: "completed",
      result: { health: { resolution: "resolved", material: "available", generation: 1 } },
    });
    expect(JSON.stringify(health)).not.toContain("never-in-a-receipt");

    const revoked = await (byId.get(REVOKE_CREDENTIAL_OPERATION_ID)!.handler as any)(
      context(REVOKE_CREDENTIAL_OPERATION_ID, "generation:1:resolved"),
      {},
    );
    expect(revoked).toMatchObject({
      state: "completed",
      result: { credential: { resolution: "unresolved", generation: 2 } },
    });
    expect(JSON.stringify(refs.listAudit({ kind: "workspace", workspace_id: workspaceId }))).not.toContain("never-in-a-receipt");
  });

  it("refuses a grant owned by another principal at the runtime boundary", async () => {
    const operation = credentialOperationDefinitions({
      secret_refs: refs,
      capability_grants: grants,
      broker: service,
      legacy_source: { async read() { throw new Error("not used"); } },
      ingress: { consume() { throw new Error("not used"); } },
      broker_id: "broker:test",
      expected_provider: () => "openai",
    }).find((candidate) => candidate.operation_id === USE_CREDENTIAL_OPERATION_ID)!;

    const result = await (operation.handler as any)(
      context(USE_CREDENTIAL_OPERATION_ID, null, "actor:someone-else"),
      {},
    );

    expect(result).toMatchObject({
      state: "refused",
      refusal: { code: "credential_access_denied" },
    });
  });
});
