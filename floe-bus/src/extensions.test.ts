import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExtensionNotFoundError,
  ExtensionPackageImmutableError,
  ExtensionPackageVersionNotFoundError,
  ExtensionStore,
  ExtensionValidationError,
  extensionInstallationRevision,
  extensionPermissionDigest,
  type ExtensionActivationAssessment,
  type ExtensionActivationAssuranceProvider,
  type ExtensionPackageDefinition,
  type ExtensionPermissionApprovalClaim,
} from "./extensions.js";

class Assurance implements ExtensionActivationAssuranceProvider {
  approvals: ExtensionPermissionApprovalClaim[] = [];
  hostAvailable = true;
  extra: ExtensionActivationAssessment["unresolved_bindings"] = [];
  assessmentCount = 0;

  assess(input: Parameters<ExtensionActivationAssuranceProvider["assess"]>[0]): ExtensionActivationAssessment {
    this.assessmentCount += 1;
    return {
      permission_approvals: this.approvals.filter((approval) =>
        input.approval_receipt_refs.includes(approval.receipt_ref)),
      isolation_hosts: this.hostAvailable ? [{
        host_id: "extension-host:isolated",
        workspace_id: input.workspace_id,
        supported_isolation_levels: ["process_sandbox", "container"],
        status: "available",
        receipt_ref: `activation:${input.package_version.extension_package_version_id}:${input.requested_lifecycle}`,
        subject_content_digest: input.package_version.content_digest,
        installation_locator: input.installation_locator,
        result_lifecycle: input.requested_lifecycle,
      }] : [],
      unresolved_bindings: this.extra,
    };
  }

  deactivate(input: Parameters<ExtensionActivationAssuranceProvider["deactivate"]>[0]) {
    return this.hostAvailable && input.installation.isolation_host_id
      ? {
          receipt_ref: `deactivation:${input.installation.extension_installation_id}`,
          workspace_id: input.workspace_id,
          extension_installation_id: input.installation.extension_installation_id,
          extension_package_version_id: input.package_version.extension_package_version_id,
          isolation_host_id: input.installation.isolation_host_id,
          result: "disabled" as const,
        }
      : null;
  }
}

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup(activationRequiresRevalidation: (workspaceId: string, installationId: string) => boolean = () => false) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  const assurance = new Assurance();
  const store = new ExtensionStore(db, assurance, (() => {
    let tick = 0;
    return () => `2026-09-04T00:00:${String(tick++).padStart(2, "0")}.000Z`;
  })(), activationRequiresRevalidation);
  return { store, assurance };
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(
    typeof value === "string" ? value : canonicalJson(value),
  ).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function packageDefinition(
  packageVersion: string,
  options: Readonly<{ network?: boolean; content?: string; testEvidence?: boolean }> = {},
): ExtensionPackageDefinition {
  const contentDigest = digest(options.content ?? `package-${packageVersion}`);
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: { title: { type: "string" } },
  };
  const network = options.network ? [{
    permission_id: "network:catalog",
    origin: "https://api.example.com",
    methods: ["GET" as const],
  }] : [];
  return {
    package_version: packageVersion,
    content_digest: contentDigest,
    source: {
      kind: "git",
      canonical_ref: "https://example.com/acme/catalog-extension.git",
      revision: `refs/tags/${packageVersion}`,
    },
    provenance: {
      built_from_refs: [{ kind: "source_tree", id: `source:${packageVersion}`, revision: digest("tree") }],
      build_invocation_ref: { kind: "operation_invocation", id: `build:${packageVersion}`, revision: null },
      trust_evidence: [{
        kind: "attestation",
        evidence_ref: { kind: "attestation", id: `attestation:${packageVersion}`, revision: digest("attestation") },
        subject_content_digest: contentDigest,
      }],
    },
    compatibility: {
      floe_version_range: ">=1.0.0 <2.0.0",
      operation_contract_versions: ["1"],
    },
    required_isolation_level: "process_sandbox",
    permissions: {
      network,
      filesystem: [{
        permission_id: "filesystem:data",
        scope: "extension_data",
        relative_pattern: "**/*",
        access: "read_write",
      }],
      secrets: [{
        permission_id: "secret:catalog",
        secret_ref_id: "secret-ref:catalog",
        purpose: "Authenticate the catalogue connector",
      }],
      data: [{ permission_id: "data:artefact", data_class: "artefact", access: "read" }],
      actions: [{ permission_id: "action:inspect", operation_id: "artefact.inspect" }],
    },
    contributions: {
      capabilities: [{
        capability_id: "catalog.lookup",
        operation_ids: ["catalog.lookup"],
        input_schema_ref: "schema:catalog-query@1",
        result_schema_ref: "schema:catalog-result@1",
      }],
      connectors: [{ connector_id: "catalog", definition_schema_ref: "schema:catalog-connector@1" }],
      schemas: [{
        schema_id: "catalog.item",
        schema_version: "1",
        schema_digest: digest(schema),
        schema,
      }],
      product_surfaces: [{
        surface_id: "catalog.preview",
        surface_version: "1",
        kind: "preview",
        title: "Catalogue item",
        projection_operation_id: "artefact.inspect",
        action_operation_ids: ["catalog.lookup"],
        presentation_schema_ref: "schema:catalog-item-view@1",
      }],
    },
    entry_points: [{
      entry_point_id: "catalog.lookup",
      kind: "capability",
      package_path: "dist/catalog.js",
    }],
    test_evidence: options.testEvidence === false ? [] : [
      {
        evidence_id: `test:${packageVersion}:deterministic`,
        kind: "deterministic",
        result: "passed",
        subject_content_digest: contentDigest,
        report_ref: { kind: "test_report", id: `test:${packageVersion}:deterministic`, revision: digest("report-a") },
      },
      {
        evidence_id: `test:${packageVersion}:adversarial`,
        kind: "adversarial",
        result: "passed",
        subject_content_digest: contentDigest,
        report_ref: { kind: "test_report", id: `test:${packageVersion}:adversarial`, revision: digest("report-b") },
      },
    ],
  };
}

function approve(
  assurance: Assurance,
  workspaceId: string,
  extensionId: string,
  definition: ExtensionPackageDefinition,
  receiptRef: string,
): void {
  assurance.approvals.push({
    receipt_ref: receiptRef,
    workspace_id: workspaceId,
    extension_id: extensionId,
    permission_digest: extensionPermissionDigest(definition.permissions),
    decision: "approved",
  });
}

let activationSequence = 0;
function activationContext() {
  return {
    invocation_id: `operation-invocation:${++activationSequence}`,
    capability_grant_ids: ["grant:extension-lifecycle"],
    approval_policy_ref: null,
  } as const;
}

describe("canonical Extension lifecycle", () => {
  it("keeps canonical source, immutable package content, installation projection, and schemas distinct", async () => {
    const { store, assurance } = setup();
    const definition = packageDefinition("1.0.0");
    const registered = store.registerPackage({
      workspace_id: "workspace:one",
      extension_id: "extension:catalog",
      label: "Catalogue",
      definition,
      registered_by_principal_id: "principal:builder",
    });

    expect(registered.package_version.definition.source.canonical_ref)
      .toBe("https://example.com/acme/catalog-extension.git");
    expect(store.listContributionSchemas(registered.extension.extension_id))
      .toMatchObject([{ schema_id: "catalog.item", schema_version: "1" }]);
    expect(() => store.registerPackage({
      workspace_id: "workspace:one",
      extension_id: "extension:catalog",
      label: "Catalogue",
      expected_extension_revision: "1",
      definition: {
        ...definition,
        source: { ...definition.source, revision: "refs/tags/rewritten" },
      },
      registered_by_principal_id: "principal:builder",
    })).toThrow(ExtensionPackageImmutableError);

    approve(assurance, "workspace:one", "extension:catalog", definition, "approval:catalog-v1");
    const installation = await store.install({
      ...activationContext(),
      workspace_id: "workspace:one",
      extension_package_version_id: registered.package_version.extension_package_version_id,
      installation_name: "catalog",
      activate: true,
      approval_receipt_refs: ["approval:catalog-v1"],
      changed_by_principal_id: "principal:operator",
    });
    expect(installation).toMatchObject({
      installation_locator: ".floe/extensions/catalog/",
      installed_package_version_id: registered.package_version.extension_package_version_id,
      lifecycle: "enabled",
      rollback_target: { kind: "disabled" },
    });
    expect(installation.installation_locator).not.toBe(definition.source.canonical_ref);
  });

  it("revalidates an enabled installation when a restored Workspace still requires activation proof", async () => {
    const { store, assurance } = setup(() => true);
    const definition = packageDefinition("1.0.0");
    const registered = store.registerPackage({
      workspace_id: "workspace:one",
      extension_id: "extension:catalog",
      label: "Catalogue",
      definition,
      registered_by_principal_id: "principal:builder",
    });
    approve(assurance, "workspace:one", "extension:catalog", definition, "approval:catalog-v1");
    const installed = await store.install({
      ...activationContext(),
      workspace_id: "workspace:one",
      extension_package_version_id: registered.package_version.extension_package_version_id,
      installation_name: "catalog",
      activate: true,
      approval_receipt_refs: ["approval:catalog-v1"],
      changed_by_principal_id: "principal:operator",
    });
    const revalidated = await store.enable({
      ...activationContext(),
      extension_installation_id: installed.extension_installation_id,
      workspace_id: "workspace:one",
      expected_revision: extensionInstallationRevision(installed),
      approval_receipt_refs: ["approval:catalog-v1"],
      changed_by_principal_id: "principal:operator",
    });

    expect(assurance.assessmentCount).toBe(2);
    expect(revalidated.lifecycle).toBe("enabled");
    expect(revalidated.revision_number).toBe(installed.revision_number + 1);
  });

  it("keeps untrusted code unresolved when approval, tests, or an isolated host are absent", async () => {
    const { store, assurance } = setup();
    assurance.hostAvailable = false;
    const registered = store.registerPackage({
      workspace_id: "workspace:one",
      extension_id: "extension:unsafe",
      label: "Unsafe",
      definition: packageDefinition("1.0.0", { testEvidence: false }),
      registered_by_principal_id: "principal:builder",
    });
    const installation = await store.install({
      ...activationContext(),
      workspace_id: "workspace:one",
      extension_package_version_id: registered.package_version.extension_package_version_id,
      installation_name: "unsafe",
      activate: true,
      approval_receipt_refs: [],
      changed_by_principal_id: "principal:operator",
    });
    expect(installation.lifecycle).toBe("unresolved");
    expect(installation.installed_package_version_id).toBeNull();
    expect(installation.pending_package_version_id).toBe(registered.package_version.extension_package_version_id);
    expect(installation.unresolved_bindings.map((item) => item.reason_code)).toEqual([
      "extension_test_evidence_required",
      "extension_isolation_host_required",
      "extension_permission_approval_required",
    ]);
  });

  it("requires a new permission approval for escalation while leaving the active version intact", async () => {
    const { store, assurance } = setup();
    const v1Definition = packageDefinition("1.0.0");
    const v1 = store.registerPackage({
      workspace_id: "workspace:one",
      extension_id: "extension:catalog",
      label: "Catalogue",
      definition: v1Definition,
      registered_by_principal_id: "principal:builder",
    });
    approve(assurance, "workspace:one", "extension:catalog", v1Definition, "approval:base");
    let installation = await store.install({
      ...activationContext(),
      workspace_id: "workspace:one",
      extension_package_version_id: v1.package_version.extension_package_version_id,
      installation_name: "catalog",
      activate: true,
      approval_receipt_refs: ["approval:base"],
      changed_by_principal_id: "principal:operator",
    });
    const v2Definition = packageDefinition("2.0.0", { network: true });
    const v2 = store.registerPackage({
      workspace_id: "workspace:one",
      extension_id: "extension:catalog",
      label: "Catalogue",
      expected_extension_revision: "1",
      definition: v2Definition,
      registered_by_principal_id: "principal:builder",
    });

    installation = await store.upgrade({
      ...activationContext(),
      extension_installation_id: installation.extension_installation_id,
      workspace_id: "workspace:one",
      to_extension_package_version_id: v2.package_version.extension_package_version_id,
      expected_revision: extensionInstallationRevision(installation),
      activate: true,
      approval_receipt_refs: ["approval:base"],
      changed_by_principal_id: "principal:operator",
    });
    expect(installation.lifecycle).toBe("enabled");
    expect(installation.installed_package_version_id).toBe(v1.package_version.extension_package_version_id);
    expect(installation.pending_package_version_id).toBe(v2.package_version.extension_package_version_id);
    expect(installation.unresolved_bindings).toMatchObject([{ kind: "permission_approval" }]);

    approve(assurance, "workspace:one", "extension:catalog", v2Definition, "approval:network");
    installation = await store.upgrade({
      ...activationContext(),
      extension_installation_id: installation.extension_installation_id,
      workspace_id: "workspace:one",
      to_extension_package_version_id: v2.package_version.extension_package_version_id,
      expected_revision: extensionInstallationRevision(installation),
      activate: true,
      approval_receipt_refs: ["approval:network"],
      changed_by_principal_id: "principal:operator",
    });
    expect(installation).toMatchObject({
      installed_package_version_id: v2.package_version.extension_package_version_id,
      pending_package_version_id: null,
      lifecycle: "enabled",
      rollback_target: {
        kind: "version",
        extension_package_version_id: v1.package_version.extension_package_version_id,
      },
    });
  });

  it("disables without deleting data and rolls back to the exact prior package", async () => {
    const { store, assurance } = setup();
    const v1Definition = packageDefinition("1.0.0");
    const v1 = store.registerPackage({
      workspace_id: "workspace:one",
      extension_id: "extension:catalog",
      label: "Catalogue",
      definition: v1Definition,
      registered_by_principal_id: "principal:builder",
    });
    approve(assurance, "workspace:one", "extension:catalog", v1Definition, "approval:base");
    let installation = await store.install({
      ...activationContext(),
      workspace_id: "workspace:one",
      extension_package_version_id: v1.package_version.extension_package_version_id,
      installation_name: "catalog",
      activate: true,
      approval_receipt_refs: ["approval:base"],
      data_ref: { kind: "extension_data", id: "extension-data:catalog", revision: "7" },
      changed_by_principal_id: "principal:operator",
    });
    const v2Definition = packageDefinition("1.1.0", { content: "v1.1" });
    const v2 = store.registerPackage({
      workspace_id: "workspace:one",
      extension_id: "extension:catalog",
      label: "Catalogue",
      expected_extension_revision: "1",
      definition: v2Definition,
      registered_by_principal_id: "principal:builder",
    });
    approve(assurance, "workspace:one", "extension:catalog", v2Definition, "approval:base");
    installation = await store.upgrade({
      ...activationContext(),
      extension_installation_id: installation.extension_installation_id,
      workspace_id: "workspace:one",
      to_extension_package_version_id: v2.package_version.extension_package_version_id,
      expected_revision: extensionInstallationRevision(installation),
      activate: true,
      approval_receipt_refs: ["approval:base"],
      changed_by_principal_id: "principal:operator",
    });
    installation = await store.rollback({
      ...activationContext(),
      extension_installation_id: installation.extension_installation_id,
      workspace_id: "workspace:one",
      expected_revision: extensionInstallationRevision(installation),
      approval_receipt_refs: ["approval:base"],
      changed_by_principal_id: "principal:operator",
    });
    expect(installation.installed_package_version_id).toBe(v1.package_version.extension_package_version_id);
    expect(installation.lifecycle).toBe("rolled_back");

    installation = await store.disable({
      extension_installation_id: installation.extension_installation_id,
      workspace_id: "workspace:one",
      expected_revision: extensionInstallationRevision(installation),
      changed_by_principal_id: "principal:operator",
    });
    expect(installation.lifecycle).toBe("disabled");
    expect(installation.deactivation_receipt_ref).toBe(`deactivation:${installation.extension_installation_id}`);
    expect(installation.data_ref).toEqual({ kind: "extension_data", id: "extension-data:catalog", revision: "7" });
    expect(store.listPackageVersions("extension:catalog")).toHaveLength(2);
    expect(store.listInstallationChanges(installation.extension_installation_id).map((item) => item.reason))
      .toEqual(["install", "upgrade", "rollback", "disable"]);
  });

  it("quarantines an active Extension when the isolated host cannot confirm it stopped", async () => {
    const { store, assurance } = setup();
    const definition = packageDefinition("1.0.0");
    const registered = store.registerPackage({
      workspace_id: "workspace:one",
      extension_id: "extension:catalog",
      label: "Catalogue",
      definition,
      registered_by_principal_id: "principal:builder",
    });
    approve(assurance, "workspace:one", "extension:catalog", definition, "approval:catalog");
    let installation = await store.install({
      ...activationContext(),
      workspace_id: "workspace:one",
      extension_package_version_id: registered.package_version.extension_package_version_id,
      installation_name: "catalog",
      activate: true,
      approval_receipt_refs: ["approval:catalog"],
      data_ref: { kind: "extension_data", id: "extension-data:catalog", revision: "1" },
      changed_by_principal_id: "principal:operator",
    });
    assurance.hostAvailable = false;
    installation = await store.disable({
      extension_installation_id: installation.extension_installation_id,
      workspace_id: "workspace:one",
      expected_revision: extensionInstallationRevision(installation),
      changed_by_principal_id: "principal:operator",
    });
    expect(installation).toMatchObject({
      lifecycle: "quarantined",
      disabled_at: null,
      deactivation_receipt_ref: null,
      data_ref: { id: "extension-data:catalog" },
      unresolved_bindings: [{ reason_code: "extension_deactivation_unconfirmed" }],
    });
  });

  it("quarantines the exact active package after an isolated host crash", async () => {
    const { store, assurance } = setup();
    const definition = packageDefinition("1.0.0");
    const registered = store.registerPackage({
      workspace_id: "workspace:one",
      extension_id: "extension:catalog",
      label: "Catalogue",
      definition,
      registered_by_principal_id: "principal:builder",
    });
    approve(assurance, "workspace:one", "extension:catalog", definition, "approval:catalog");
    const active = await store.install({
      ...activationContext(),
      workspace_id: "workspace:one",
      extension_package_version_id: registered.package_version.extension_package_version_id,
      installation_name: "catalog",
      activate: true,
      approval_receipt_refs: ["approval:catalog"],
      changed_by_principal_id: "principal:operator",
    });

    const quarantined = store.quarantineAfterHostCrash({
      workspace_id: "workspace:one",
      extension_installation_id: active.extension_installation_id,
      extension_package_version_id: active.installed_package_version_id!,
      isolation_host_id: active.isolation_host_id!,
      failure_code: "extension_host_crashed",
      failure_message: "The isolated Extension host exited unexpectedly.",
    });
    expect(quarantined).toMatchObject({
      lifecycle: "quarantined",
      installed_package_version_id: active.installed_package_version_id,
      unresolved_bindings: [{ reason_code: "extension_host_crashed" }],
    });
    expect(store.listInstallationChanges(active.extension_installation_id).at(-1)?.reason).toBe("quarantine");
  });

  it("denies cross-Workspace identities and raw secret fields", async () => {
    const { store } = setup();
    const registered = store.registerPackage({
      workspace_id: "workspace:one",
      extension_id: "extension:catalog",
      label: "Catalogue",
      definition: packageDefinition("1.0.0"),
      registered_by_principal_id: "principal:builder",
    });
    expect(() => store.requireExtensionInWorkspace("extension:catalog", "workspace:two"))
      .toThrow(ExtensionNotFoundError);
    expect(() => store.requirePackageInWorkspace(
      registered.package_version.extension_package_version_id,
      "workspace:two",
    )).toThrow(ExtensionPackageVersionNotFoundError);
    await expect(store.install({
      ...activationContext(),
      workspace_id: "workspace:two",
      extension_package_version_id: registered.package_version.extension_package_version_id,
      installation_name: "catalog",
      activate: true,
      approval_receipt_refs: [],
      changed_by_principal_id: "principal:other",
    })).rejects.toThrow(ExtensionPackageVersionNotFoundError);

    const unsafe = packageDefinition("2.0.0") as any;
    unsafe.permissions.secrets = [{
      permission_id: "secret:unsafe",
      secret_ref_id: "secret-ref:unsafe",
      purpose: "Test",
      value: "plaintext-secret",
    }];
    expect(() => store.registerPackage({
      workspace_id: "workspace:one",
      extension_id: "extension:unsafe",
      label: "Unsafe",
      definition: unsafe,
      registered_by_principal_id: "principal:builder",
    })).toThrow(ExtensionValidationError);
  });
});
