import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SqliteCapabilityGrantStore,
  applyCapabilityGrantSchema,
  type IssueCapabilityGrant,
} from "./capability-grants.js";
import {
  BrokerSecretNotFoundError,
  CredentialBrokerOperationError,
  CredentialBrokerService,
  InMemoryCredentialBroker,
  SecretAccessDeniedError,
  SecretRefExportValidationError,
  SecretRefImportConflictError,
  SqliteSecretRefStore,
  WindowsCredentialBroker,
  applyCredentialBrokerSchema,
  assessLegacyAuthMigrationVerification,
  exportSecretRefs,
  importSecretRefs,
  parseSecretRefExport,
  planLegacyAuthJsonMigration,
  type SecretAccessRequest,
  type SecretResourceIdentity,
  type StoreSecretMaterialRequest,
  type WindowsCredentialProtector,
} from "./credential-broker.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const workspaceId = "workspace:alpine";
const resource: SecretResourceIdentity = { kind: "connector", id: "connector:harbor" };

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

describe("SecretRef credential broker foundation", () => {
  let db: DatabaseSync;
  let now: string;
  let store: SqliteSecretRefStore;
  let capabilityGrants: SqliteCapabilityGrantStore;
  let broker: InMemoryCredentialBroker;
  let service: CredentialBrokerService;
  let idSequence: number;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    applyCapabilityGrantSchema(db);
    applyCredentialBrokerSchema(db);
    now = "2026-09-03T12:00:00.000Z";
    idSequence = 0;
    store = new SqliteSecretRefStore(db, {
      now: () => now,
      secret_ref_id_factory: () => "secretref:harbor",
      audit_id_factory: () => `secretaudit:${++idSequence}`,
    });
    capabilityGrants = new SqliteCapabilityGrantStore(db, {
      now: () => now,
      grant_id_factory: () => `capgrant:${++idSequence}`,
    });
    broker = new InMemoryCredentialBroker("broker:memory-test");
    service = new CredentialBrokerService(store, capabilityGrants, [broker]);
  });

  afterEach(() => db.close());

  function createRef() {
    return store.createSecretRef({
      owner: { kind: "workspace", workspace_id: workspaceId },
      resource,
      secret_kind: "service-session",
      label: "Harbor connection",
    });
  }

  function issueGrant(
    overrides: Partial<IssueCapabilityGrant> = {},
    purposes: readonly string[] = ["account-connection", "outcome-delivery", "session-maintenance"],
  ) {
    const grant = capabilityGrants.issueGrant({
      principal_id: "principal:slate",
      boundary: { kind: "workspace", workspace_id: workspaceId },
      operation_ids: [
        "credential.bind", "credential.health", "credential.refresh",
        "credential.revoke", "credential.rotate", "connector.fetch",
      ],
      targets: [
        { kind: "secret_ref", id: "secretref:harbor" },
        resource,
      ],
      expires_at: "2026-09-03T13:00:00.000Z",
      issuer_id: "principal:operator",
      evidence: [{ kind: "approval", ref: "approval:harbor" }],
      ...overrides,
    });
    store.attachGrantConstraint({
      grant_id: grant.grant_id,
      secret_ref_id: "secretref:harbor",
      authority_boundary: { kind: "workspace", workspace_id: workspaceId },
      purposes,
    }, capabilityGrants);
    return grant;
  }

  function request(
    grantId: string,
    operationId = "connector.fetch",
    purpose = "outcome-delivery",
  ): SecretAccessRequest {
    return {
      secret_ref_id: "secretref:harbor",
      grant_id: grantId,
      principal_id: "principal:slate",
      authority_boundary: { kind: "workspace", workspace_id: workspaceId },
      resource,
      purpose,
      operation_id: operationId,
    };
  }

  async function bind(grantId: string, material = "harbor-session-alpha") {
    return service.bindSecretRef({
      request: request(grantId, "credential.bind", "account-connection"),
      broker_id: broker.broker_id,
      material: bytes(material),
    });
  }

  it("stores only SecretRef and grant metadata while brokered use keeps bytes out of records and audit", async () => {
    const unresolved = createRef();
    const grant = issueGrant();
    expect(unresolved).toMatchObject({
      secret_ref_id: "secretref:harbor",
      resolution: "unresolved",
      binding: null,
      generation: 0,
    });

    const resolved = await bind(grant.grant_id);
    expect(resolved).toMatchObject({
      resolution: "resolved",
      generation: 1,
      binding: { broker_id: "broker:memory-test", locator: "memory:1" },
    });

    const result = await service.useSecret(request(grant.grant_id), async (material) => {
      expect(decoder.decode(material)).toBe("harbor-session-alpha");
      return { accepted: true };
    });
    expect(result).toEqual({ accepted: true });

    const durableMetadata = JSON.stringify({
      refs: db.prepare("SELECT * FROM secret_refs").all(),
      grants: db.prepare("SELECT * FROM capability_grants").all(),
      grant_operations: db.prepare("SELECT * FROM capability_grant_operations").all(),
      constraints: db.prepare("SELECT * FROM secret_grant_constraints").all(),
      purposes: db.prepare("SELECT * FROM secret_grant_constraint_purposes").all(),
      audit: db.prepare("SELECT * FROM secret_access_audit").all(),
    });
    expect(durableMetadata).not.toContain("harbor-session-alpha");
    expect(store.listAudit({ kind: "workspace", workspace_id: workspaceId }).map((item) => ({
      action: item.action,
      outcome: item.outcome,
      purpose: item.purpose,
      operation_id: item.operation_id,
    }))).toEqual([
      {
        action: "bind",
        outcome: "succeeded",
        purpose: "account-connection",
        operation_id: "credential.bind",
      },
      {
        action: "use",
        outcome: "succeeded",
        purpose: "outcome-delivery",
        operation_id: "connector.fetch",
      },
    ]);
  });

  it("enforces principal, Workspace, resource, purpose, operation, expiry, and revocation at access time", async () => {
    createRef();
    const grant = issueGrant();
    await bind(grant.grant_id);

    const denials: Array<[Partial<SecretAccessRequest>, string]> = [
      [{ principal_id: "principal:ember" }, "grant_principal_mismatch"],
      [{ authority_boundary: { kind: "workspace", workspace_id: "workspace:cedar" } }, "grant_boundary_mismatch"],
      [{ resource: { kind: "connector", id: "connector:quay" } }, "grant_resource_target_mismatch"],
      [{ purpose: "unrelated-purpose" }, "grant_purpose_mismatch"],
      [{ operation_id: "connector.publish" }, "grant_operation_mismatch"],
    ];
    for (const [override, reason] of denials) {
      await expect(service.useSecret({ ...request(grant.grant_id), ...override }, async () => "unused"))
        .rejects.toMatchObject({ reason_code: reason });
    }

    db.prepare(`
      DELETE FROM capability_grant_targets
      WHERE grant_id = ? AND target_kind = 'secret_ref'
    `).run(grant.grant_id);
    await expect(service.useSecret(request(grant.grant_id), async () => "unused"))
      .rejects.toMatchObject({ reason_code: "grant_secret_ref_target_mismatch" });
    db.prepare(`
      INSERT INTO capability_grant_targets (grant_id, target_kind, target_id)
      VALUES (?, 'secret_ref', 'secretref:harbor')
    `).run(grant.grant_id);

    now = "2026-09-03T13:00:00.000Z";
    await expect(service.useSecret(request(grant.grant_id), async () => "unused"))
      .rejects.toMatchObject({ reason_code: "grant_expired" });

    now = "2026-09-03T12:30:00.000Z";
    const active = issueGrant({ expires_at: "2026-09-03T14:00:00.000Z" });
    expect(capabilityGrants.revokeGrant(active.grant_id)).toBe(true);
    await expect(service.useSecret(request(active.grant_id), async () => "unused"))
      .rejects.toMatchObject({ reason_code: "grant_revoked" });

    expect(store.listAudit({ kind: "workspace", workspace_id: workspaceId }).filter((item) => item.outcome === "denied")).toHaveLength(7);
  });

  it("refuses capability grants without exact SecretRef/resource targets, purpose, or operation", async () => {
    createRef();
    const wrongResourceGrant = issueGrant({
      targets: [
        { kind: "secret_ref", id: "secretref:harbor" },
        { kind: "connector", id: "connector:quay" },
      ],
    });
    await expect(bind(wrongResourceGrant.grant_id))
      .rejects.toMatchObject({ reason_code: "grant_resource_target_mismatch" });
    expect(() => issueGrant({}, [])).toThrow(/purpose list/);
    expect(() => issueGrant({ operation_ids: [] })).toThrow(/operation_id list/);
  });

  it("rotates and refreshes one broker binding atomically and retains the prior value after a failed replacement", async () => {
    class ControlledBroker extends InMemoryCredentialBroker {
      failReplacement = false;

      override async replaceAtomic(locator: string, material: Uint8Array): Promise<void> {
        if (this.failReplacement) throw new Error("safe injected failure");
        await super.replaceAtomic(locator, material);
      }
    }

    const controlled = new ControlledBroker("broker:controlled");
    service = new CredentialBrokerService(store, capabilityGrants, [controlled]);
    broker = controlled;
    createRef();
    const grant = issueGrant();
    await bind(grant.grant_id, "session-one");

    const rotated = await service.rotateSecretRef({
      request: request(grant.grant_id, "credential.rotate", "session-maintenance"),
      material: bytes("session-two"),
    });
    expect(rotated.generation).toBe(2);
    expect(await service.useSecret(request(grant.grant_id), (material) => decoder.decode(material)))
      .toBe("session-two");

    controlled.failReplacement = true;
    await expect(service.rotateSecretRef({
      request: request(grant.grant_id, "credential.rotate", "session-maintenance"),
      material: bytes("session-should-not-commit"),
    })).rejects.toBeInstanceOf(CredentialBrokerOperationError);
    controlled.failReplacement = false;
    expect(await service.useSecret(request(grant.grant_id), (material) => decoder.decode(material)))
      .toBe("session-two");
    expect(store.getSecretRef("secretref:harbor")?.generation).toBe(2);

    const refreshed = await service.refreshSecretRef(
      request(grant.grant_id, "credential.refresh", "session-maintenance"),
      (current) => {
        expect(decoder.decode(current)).toBe("session-two");
        return bytes("session-three");
      },
    );
    expect(refreshed.generation).toBe(3);
    expect(await service.useSecret(request(grant.grant_id), (material) => decoder.decode(material)))
      .toBe("session-three");

    const auditJson = JSON.stringify(store.listAudit({ kind: "workspace", workspace_id: workspaceId }));
    for (const secret of ["session-one", "session-two", "session-three", "session-should-not-commit"]) {
      expect(auditJson).not.toContain(secret);
    }
    expect(store.listAudit({ kind: "workspace", workspace_id: workspaceId }).some((item) =>
      item.action === "rotate" && item.outcome === "failed" && item.reason_code === "broker_operation_failed"))
      .toBe(true);
  });

  it("reports broker health without revealing material and revokes to a visible unresolved binding", async () => {
    createRef();
    const grant = issueGrant();
    expect(await service.inspectHealth(request(
      grant.grant_id,
      "credential.health",
      "session-maintenance",
    ))).toMatchObject({ resolution: "unresolved", material: "unavailable", generation: 0 });

    await bind(grant.grant_id, "health-and-revoke-secret");
    expect(await service.inspectHealth(request(
      grant.grant_id,
      "credential.health",
      "session-maintenance",
    ))).toMatchObject({ resolution: "resolved", material: "available", generation: 1 });

    const revoked = await service.revokeSecretRef(request(
      grant.grant_id,
      "credential.revoke",
      "session-maintenance",
    ));
    expect(revoked).toMatchObject({ resolution: "unresolved", binding: null, generation: 2 });
    expect(JSON.stringify(store.listAudit({ kind: "workspace", workspace_id: workspaceId }))).not.toContain("health-and-revoke-secret");
    expect(store.listAudit({ kind: "workspace", workspace_id: workspaceId }).map((record) => [record.action, record.outcome])).toEqual([
      ["health", "succeeded"],
      ["bind", "succeeded"],
      ["health", "succeeded"],
      ["revoke", "succeeded"],
    ]);
  });

  it("exports only unresolved metadata and imports no broker binding, grant, audit, or secret", async () => {
    createRef();
    const grant = issueGrant();
    await bind(grant.grant_id, "portable-source-secret");

    const exported = exportSecretRefs(store, workspaceId);
    const serialized = JSON.stringify(exported);
    expect(exported.secret_refs).toEqual([{
      secret_ref_id: "secretref:harbor",
      resource,
      secret_kind: "service-session",
      label: "Harbor connection",
      resolution: "unresolved",
    }]);
    for (const forbidden of ["portable-source-secret", "broker:memory-test", "memory:1", "capgrant:", "secretaudit:"]) {
      expect(serialized).not.toContain(forbidden);
    }

    const targetDb = new DatabaseSync(":memory:");
    try {
      targetDb.exec("PRAGMA foreign_keys = ON");
      applyCapabilityGrantSchema(targetDb);
      applyCredentialBrokerSchema(targetDb);
      const targetStore = new SqliteSecretRefStore(targetDb, { now: () => now });
      const imported = importSecretRefs(targetStore, "workspace:birch", serialized);
      expect(imported).toHaveLength(1);
      expect(imported[0]).toMatchObject({
        owner: { kind: "workspace", workspace_id: "workspace:birch" },
        resolution: "unresolved",
        binding: null,
        generation: 0,
      });
      expect(targetDb.prepare("SELECT COUNT(*) AS count FROM capability_grants").get())
        .toEqual({ count: 0 });
      expect(targetDb.prepare("SELECT COUNT(*) AS count FROM secret_grant_constraints").get())
        .toEqual({ count: 0 });
      expect(targetDb.prepare("SELECT COUNT(*) AS count FROM secret_access_audit").get())
        .toEqual({ count: 0 });
    } finally {
      targetDb.close();
    }
  });

  it("rejects imported fields that could carry a secret and never overwrites a resolved binding", async () => {
    const malicious = {
      schema: "floe.secret-refs.v1",
      source_workspace_id: workspaceId,
      secret_refs: [{
        secret_ref_id: "secretref:harbor",
        resource,
        secret_kind: "service-session",
        label: "Harbor connection",
        resolution: "unresolved",
        secret: "must-not-cross",
      }],
    };
    expect(() => parseSecretRefExport(malicious)).toThrow(SecretRefExportValidationError);

    createRef();
    const grant = issueGrant();
    await bind(grant.grant_id);
    const safeDocument = {
      ...malicious,
      secret_refs: [Object.fromEntries(
        Object.entries(malicious.secret_refs[0]).filter(([key]) => key !== "secret"),
      )],
    };
    expect(() => importSecretRefs(store, workspaceId, safeDocument)).toThrow(SecretRefImportConflictError);
    expect(store.getSecretRef("secretref:harbor")?.resolution).toBe("resolved");
  });

  it("uses a Windows operating-system protector for storage and atomic replacement", async () => {
    class FakeWindowsProtector implements WindowsCredentialProtector {
      readonly protection_kind = "windows-os-credential-protection" as const;
      readonly values = new Map<string, Uint8Array>();
      readonly calls: string[] = [];

      async writeAtomic(locator: string, material: Uint8Array): Promise<void> {
        this.calls.push("writeAtomic");
        this.values.set(locator, new Uint8Array(material));
      }

      async read(locator: string): Promise<Uint8Array | null> {
        this.calls.push("read");
        const value = this.values.get(locator);
        return value ? new Uint8Array(value) : null;
      }

      async remove(locator: string): Promise<void> {
        this.calls.push("remove");
        this.values.delete(locator);
      }
    }

    const protector = new FakeWindowsProtector();
    const windows = new WindowsCredentialBroker("broker:windows", protector, {
      locator_factory: () => "floe/test/credential-one",
    });
    const locator = await windows.store({
      secret_ref_id: "secretref:one",
      owner: { kind: "workspace", workspace_id: workspaceId },
      generation: 1,
      material: bytes("windows-material-one"),
    });
    expect(locator).toBe("floe/test/credential-one");
    expect(await windows.withSecret(locator, (material) => decoder.decode(material)))
      .toBe("windows-material-one");
    await windows.replaceAtomic(locator, bytes("windows-material-two"));
    expect(await windows.withSecret(locator, (material) => decoder.decode(material)))
      .toBe("windows-material-two");
    await windows.remove(locator);
    await expect(windows.withSecret(locator, async () => "unused"))
      .rejects.toBeInstanceOf(BrokerSecretNotFoundError);
    expect(protector.calls).toEqual(["writeAtomic", "read", "writeAtomic", "read", "remove", "read"]);
  });

  it("plans legacy auth.json as a dry run, emits no values, and preserves the source until verification", () => {
    const plan = planLegacyAuthJsonMigration({
      source_path: "C:\\FloeState\\auth\\auth.json",
      source_fingerprint: "source-snapshot-42",
      target_workspace_id: workspaceId,
      resource,
      legacy_auth_json: {
        service_one: { type: "api_key", key: "legacy-key-material" },
        service_two: {
          type: "oauth",
          access: "legacy-access-material",
          refresh: "legacy-refresh-material",
          expires: 1_800_000_000_000,
        },
      },
    }, {
      plan_id_factory: () => "authmigration:one",
      secret_ref_id_factory: (_sourceEntry, index) => `secretref:legacy:${index + 1}`,
    });

    expect(plan).toMatchObject({
      schema: "floe.legacy-auth-migration-plan.v1",
      phase: "dry_run",
      automatic_secret_copy: false,
      source: { disposition: "preserve_until_verified" },
    });
    expect(plan.actions.map((action) => ({
      source_entry: action.source_entry,
      credential_kind: action.credential_kind,
      resolution: action.planned_secret_ref.resolution,
      transfer: action.transfer,
    }))).toEqual([
      {
        source_entry: "service_one",
        credential_kind: "api_key",
        resolution: "unresolved",
        transfer: "explicit_trusted_broker_action_required",
      },
      {
        source_entry: "service_two",
        credential_kind: "oauth",
        resolution: "unresolved",
        transfer: "explicit_trusted_broker_action_required",
      },
    ]);
    const serializedPlan = JSON.stringify(plan);
    for (const secret of ["legacy-key-material", "legacy-access-material", "legacy-refresh-material"]) {
      expect(serializedPlan).not.toContain(secret);
    }

    expect(assessLegacyAuthMigrationVerification(plan, ["secretref:legacy:1"])).toEqual({
      plan_id: "authmigration:one",
      verified: false,
      unresolved_secret_ref_ids: ["secretref:legacy:2"],
      source_disposition: "preserve",
      cleanup_requires_explicit_confirmation: true,
    });
    expect(assessLegacyAuthMigrationVerification(plan, ["secretref:legacy:1", "secretref:legacy:2"]))
      .toMatchObject({
        verified: true,
        source_disposition: "eligible_for_explicit_cleanup",
        cleanup_requires_explicit_confirmation: true,
      });
  });

  it("fails closed when a resolved SecretRef points to an unavailable or missing broker binding", async () => {
    createRef();
    const grant = issueGrant();
    const resolved = await bind(grant.grant_id);
    const isolatedService = new CredentialBrokerService(store, capabilityGrants, []);
    await expect(isolatedService.useSecret(request(grant.grant_id), async () => "unused"))
      .rejects.toMatchObject({ reason_code: "broker_unavailable" });

    await broker.remove(resolved.binding?.locator as string);
    await expect(service.useSecret(request(grant.grant_id), async () => "unused"))
      .rejects.toBeInstanceOf(SecretAccessDeniedError);
    expect(store.listAudit({ kind: "workspace", workspace_id: workspaceId }).slice(-2).map((item) => item.reason_code))
      .toEqual(["broker_unavailable", "broker_secret_missing"]);
  });

  it("connects one host provider account before any Workspace and requires an exact grant per Workspace", async () => {
    const hostBoundary = { kind: "host" as const, host_id: "host:local" };
    const hostResource = { kind: "provider_account", id: "openai" };
    store.createSecretRef({
      secret_ref_id: "secretref:provider:openai",
      owner: hostBoundary,
      resource: hostResource,
      secret_kind: "runtime_authentication",
      label: "ChatGPT",
    });
    const hostGrant = capabilityGrants.issueGrant({
      principal_id: "principal:operator",
      boundary: hostBoundary,
      operation_ids: ["credential.bind", "credential.revoke"],
      targets: [
        { kind: "secret_ref", id: "secretref:provider:openai" },
        hostResource,
      ],
      expires_at: "2026-09-03T13:00:00.000Z",
      issuer_id: "transport:local-host",
      evidence: [{ kind: "authenticated_host_control", ref: "host-control" }],
    });
    store.attachGrantConstraint({
      grant_id: hostGrant.grant_id,
      secret_ref_id: "secretref:provider:openai",
      authority_boundary: hostBoundary,
      purposes: ["account-connection", "credential-maintenance"],
    }, capabilityGrants);
    const hostRequest: SecretAccessRequest = {
      secret_ref_id: "secretref:provider:openai",
      grant_id: hostGrant.grant_id,
      principal_id: "principal:operator",
      authority_boundary: hostBoundary,
      resource: hostResource,
      purpose: "account-connection",
      operation_id: "credential.bind",
    };
    await service.bindSecretRef({
      request: hostRequest,
      broker_id: broker.broker_id,
      material: bytes("provider-account-secret"),
    });

    const runtimeResource = { kind: "runtime_profile", id: "runtime-profile:workspace-a" };
    const workspaceGrant = capabilityGrants.issueGrant({
      principal_id: "actor:workspace-a:floe",
      boundary: { kind: "workspace", workspace_id: "workspace:a" },
      operation_ids: ["credential.use"],
      targets: [
        { kind: "secret_ref", id: "secretref:provider:openai" },
        runtimeResource,
      ],
      expires_at: "2026-09-03T13:00:00.000Z",
      issuer_id: "principal:operator",
      evidence: [{ kind: "workspace_provider_selection", ref: "selection:a" }],
    });
    store.attachGrantConstraint({
      grant_id: workspaceGrant.grant_id,
      secret_ref_id: "secretref:provider:openai",
      authority_boundary: { kind: "workspace", workspace_id: "workspace:a" },
      purposes: ["runtime-provider-authentication"],
    }, capabilityGrants);
    const workspaceRequest: SecretAccessRequest = {
      secret_ref_id: "secretref:provider:openai",
      grant_id: workspaceGrant.grant_id,
      principal_id: "actor:workspace-a:floe",
      authority_boundary: { kind: "workspace", workspace_id: "workspace:a" },
      resource: runtimeResource,
      purpose: "runtime-provider-authentication",
      operation_id: "credential.use",
    };
    expect(await service.useSecret(workspaceRequest, (value) => decoder.decode(value)))
      .toBe("provider-account-secret");
    await expect(service.useSecret({
      ...workspaceRequest,
      authority_boundary: { kind: "workspace", workspace_id: "workspace:b" },
    }, async () => "unused")).rejects.toMatchObject({ reason_code: "grant_boundary_mismatch" });

    await service.revokeSecretRef({
      ...hostRequest,
      purpose: "credential-maintenance",
      operation_id: "credential.revoke",
    });
    await expect(service.useSecret(workspaceRequest, async () => "unused"))
      .rejects.toMatchObject({ reason_code: "secret_ref_unresolved" });
    const durable = JSON.stringify({
      ref: store.getSecretRef("secretref:provider:openai"),
      audit: [
        ...store.listAudit(hostBoundary),
        ...store.listAudit({ kind: "workspace", workspace_id: "workspace:a" }),
      ],
    });
    expect(durable).not.toContain("provider-account-secret");
  });
});
