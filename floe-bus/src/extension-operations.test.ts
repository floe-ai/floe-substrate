import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ExtensionStore,
  extensionIdentityRevision,
  extensionInstallationRevision,
  extensionPermissionDigest,
  type ExtensionActivationAssessment,
  type ExtensionActivationAssuranceProvider,
  type ExtensionPackageDefinition,
  type ExtensionPermissionApprovalClaim,
} from "./extensions.js";
import {
  CREATE_EXTENSION_OPERATION_ID,
  DISABLE_EXTENSION_OPERATION_ID,
  ENABLE_EXTENSION_OPERATION_ID,
  DISCOVER_EXTENSION_SCHEMAS_OPERATION_ID,
  GET_EXTENSION_PACKAGE_OPERATION_ID,
  INSPECT_EXTENSION_OPERATION_ID,
  INSTALL_EXTENSION_OPERATION_ID,
  INVOKE_EXTENSION_ENTRY_POINT_OPERATION_ID,
  LIST_ACTIVE_EXTENSION_CONTRIBUTIONS_OPERATION_ID,
  LIST_EXTENSIONS_OPERATION_ID,
  REGISTER_EXTENSION_BUILD_EVIDENCE_OPERATION_ID,
  ROLLBACK_EXTENSION_OPERATION_ID,
  UPGRADE_EXTENSION_OPERATION_ID,
  extensionOperationDefinitions,
  registerExtensionOperations,
  type ExtensionEntryPointExecution,
} from "./extension-operations.js";
import { AjvOperationSchemaValidator } from "./operation-schema-validator-ajv.js";
import { createTestOperationRegistry } from "./operation-test-fixtures.js";
import {
  type OperationAuthorityContext,
  type OperationInvocationEnvironment,
  type OperationInvocationRequest,
  type OperationInvocationResponse,
  type OperationInteractionMode,
  type ResolvedOperationResource,
} from "./operations.js";

const OPERATION_IDS = [
  LIST_EXTENSIONS_OPERATION_ID,
  INSPECT_EXTENSION_OPERATION_ID,
  GET_EXTENSION_PACKAGE_OPERATION_ID,
  DISCOVER_EXTENSION_SCHEMAS_OPERATION_ID,
  LIST_ACTIVE_EXTENSION_CONTRIBUTIONS_OPERATION_ID,
  CREATE_EXTENSION_OPERATION_ID,
  REGISTER_EXTENSION_BUILD_EVIDENCE_OPERATION_ID,
  INSTALL_EXTENSION_OPERATION_ID,
  ENABLE_EXTENSION_OPERATION_ID,
  UPGRADE_EXTENSION_OPERATION_ID,
  DISABLE_EXTENSION_OPERATION_ID,
  ROLLBACK_EXTENSION_OPERATION_ID,
  INVOKE_EXTENSION_ENTRY_POINT_OPERATION_ID,
] as const;

class Assurance implements ExtensionActivationAssuranceProvider {
  approvals: ExtensionPermissionApprovalClaim[] = [];
  hostAvailable = true;

  assess(input: Parameters<ExtensionActivationAssuranceProvider["assess"]>[0]): ExtensionActivationAssessment {
    return {
      permission_approvals: this.approvals.filter((approval) => input.approval_receipt_refs.includes(approval.receipt_ref)),
      isolation_hosts: this.hostAvailable ? [{
        host_id: "extension-host:one",
        workspace_id: input.workspace_id,
        supported_isolation_levels: ["process_sandbox"],
        status: "available",
        receipt_ref: `activation:${input.package_version.extension_package_version_id}:${input.requested_lifecycle}`,
        subject_content_digest: input.package_version.content_digest,
        installation_locator: input.installation_locator,
        result_lifecycle: input.requested_lifecycle,
      }] : [],
      unresolved_bindings: [],
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

function definition(version = "1.0.0"): ExtensionPackageDefinition {
  const contentDigest = digest(`package:${version}`);
  const schema = { type: "object", properties: { value: { type: "string" } } };
  return {
    package_version: version,
    content_digest: contentDigest,
    source: {
      kind: "package",
      canonical_ref: "pkg:npm/@acme/catalog-extension",
      revision: version,
    },
    provenance: {
      built_from_refs: [{ kind: "source_tree", id: `tree:${version}`, revision: digest("tree") }],
      build_invocation_ref: { kind: "operation_invocation", id: `build:${version}`, revision: null },
      trust_evidence: [],
    },
    compatibility: { floe_version_range: ">=1", operation_contract_versions: ["1"] },
    required_isolation_level: "process_sandbox",
    permissions: {
      network: [],
      filesystem: [],
      secrets: [{
        permission_id: "secret:catalog",
        secret_ref_id: "secret-ref:catalog",
        purpose: "Authenticate catalogue requests",
      }],
      data: [],
      actions: [{ permission_id: "action:inspect", operation_id: "artefact.inspect" }],
    },
    contributions: {
      capabilities: [{
        capability_id: "catalog.lookup",
        operation_ids: ["catalog.lookup"],
        input_schema_ref: null,
        result_schema_ref: "schema:catalog.item@1",
      }],
      connectors: [],
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
        title: "Catalogue preview",
        projection_operation_id: "artefact.inspect",
        action_operation_ids: [],
        presentation_schema_ref: "schema:catalog.preview@1",
      }],
    },
    entry_points: [{ entry_point_id: "catalog.lookup", kind: "capability", package_path: "dist/index.js" }],
    test_evidence: ["deterministic", "adversarial"].map((kind) => ({
      evidence_id: `test:${version}:${kind}`,
      kind: kind as "deterministic" | "adversarial",
      result: "passed" as const,
      subject_content_digest: contentDigest,
      report_ref: { kind: "test_report", id: `test:${version}:${kind}`, revision: digest(kind) },
    })),
  };
}

function authority(input: Readonly<{
  workspace_id?: string;
  mode?: OperationInteractionMode;
  grants?: ReadonlySet<string>;
  confirmations?: ReadonlySet<string>;
  approvals?: ReadonlySet<string>;
}> = {}): OperationAuthorityContext & { boundary: { kind: "workspace"; workspace_id: string } } {
  const workspaceId = input.workspace_id ?? "workspace:one";
  return {
    principal_id: "principal:operator",
    boundary: { kind: "workspace", workspace_id: workspaceId },
    grants: input.grants ?? new Set(OPERATION_IDS),
    interaction: {
      mode: input.mode ?? "interactive",
      session_id: "session:test",
      confirmed_prompts: input.confirmations ?? new Set(),
      approval_refs: input.approvals ?? new Set(),
    },
  };
}

function environment(
  store: ExtensionStore,
  auth = authority(),
  executionAttemptId: string | null = null,
): OperationInvocationEnvironment {
  return {
    authority: auth,
    provenance: {
      cause_event_id: null,
      delivery_ids: [],
      execution_attempt_id: executionAttemptId,
      node_execution_id: null,
      scope_execution_id: null,
    },
    resolve_resource: async (target): Promise<ResolvedOperationResource | null> => {
      if (target.kind === "extension") {
        const extension = store.getExtension(target.id);
        return extension?.workspace_id === auth.boundary.workspace_id
          ? { ref: { ...target, revision: extensionIdentityRevision(extension) }, state: extension }
          : null;
      }
      if (target.kind === "extension_package_version") {
        const packageVersion = store.getPackageVersion(target.id);
        return packageVersion?.workspace_id === auth.boundary.workspace_id
          ? { ref: { ...target, revision: packageVersion.record_digest }, state: packageVersion }
          : null;
      }
      if (target.kind === "extension_installation") {
        const installation = store.getInstallation(target.id);
        return installation?.workspace_id === auth.boundary.workspace_id
          ? { ref: { ...target, revision: extensionInstallationRevision(installation) }, state: installation }
          : null;
      }
      return null;
    },
    now: () => "2026-09-04T05:00:00.000Z",
  };
}

function request(
  operationId: string,
  input: unknown,
  idempotencyKey: string,
  options: Readonly<{
    target?: { kind: string; id: string };
    expected_revision?: string;
  }> = {},
): OperationInvocationRequest {
  return {
    operation_id: operationId,
    operation_version: "1",
    input_schema_version: "1",
    input,
    idempotency_key: idempotencyKey,
    ...(options.target ? { target: options.target } : {}),
    ...(options.expected_revision !== undefined
      ? { expected_resource_revision: options.expected_revision }
      : {}),
  };
}

function receipt(response: OperationInvocationResponse) {
  expect(response.kind).toBe("receipt");
  if (response.kind !== "receipt") throw new Error("Expected operation receipt");
  return response.receipt;
}

describe("Extension semantic operations", () => {
  let db: DatabaseSync;
  let assurance: Assurance;
  let store: ExtensionStore;
  let registry: ReturnType<typeof createTestOperationRegistry>;
  let entryPointExecution: ExtensionEntryPointExecution;
  let entryPointCalls: Parameters<ExtensionEntryPointExecution["invoke"]>[0][];

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("CREATE TABLE execution_attempts (attempt_id TEXT PRIMARY KEY)");
    assurance = new Assurance();
    store = new ExtensionStore(db, assurance, () => "2026-09-04T04:00:00.000Z");
    entryPointCalls = [];
    entryPointExecution = {
      invoke: async (input) => {
        entryPointCalls.push(input);
        return { ok: true };
      },
    };
    registry = registerExtensionOperations(
      createTestOperationRegistry(new AjvOperationSchemaValidator()),
      store,
      entryPointExecution,
    );
  });

  afterEach(() => db.close());

  it("discovers one Workspace-only contract with explicit grants and interaction constraints", async () => {
    const projected = await registry.project({ authority: authority() });
    expect(projected.map((item) => item.operation_id)).toEqual(OPERATION_IDS);
    expect(projected.every((item) =>
      item.authority_boundary_kinds.length === 1
      && item.authority_boundary_kinds[0] === "workspace"
      && item.required_grants.length === 1
      && item.required_grants[0] === item.operation_id
    )).toBe(true);
    expect(extensionOperationDefinitions(store)).toHaveLength(OPERATION_IDS.length);

    const withoutGrants = await registry.project({ authority: authority({ grants: new Set() }) });
    expect(withoutGrants.every((item) =>
      !item.availability.available
      && item.availability.refusal.code === "operation_grant_required"
    )).toBe(true);
    const unattended = await registry.project({ authority: authority({ mode: "unattended" }) });
    for (const id of [INSTALL_EXTENSION_OPERATION_ID, UPGRADE_EXTENSION_OPERATION_ID, ROLLBACK_EXTENSION_OPERATION_ID]) {
      expect(unattended.find((item) => item.operation_id === id)?.availability).toMatchObject({
        available: false,
        refusal: { code: "operation_interaction_not_supported" },
      });
    }
  });

  it("creates identity, registers immutable build evidence, and discovers declared schemas idempotently", async () => {
    const created = receipt(await registry.invoke(
      environment(store),
      request(CREATE_EXTENSION_OPERATION_ID, { extension_id: "extension:catalog", label: "Catalogue" }, "create-catalog"),
    ));
    expect(created.state).toBe("completed");
    const extension = (created.result as any).extension;
    expect(extension.revision_number).toBe(0);

    const packageDefinition = definition();
    const registerRequest = request(
      REGISTER_EXTENSION_BUILD_EVIDENCE_OPERATION_ID,
      { label: "Catalogue", definition: packageDefinition },
      "register-v1",
      {
        target: { kind: "extension", id: extension.extension_id },
        expected_revision: "0",
      },
    );
    const registered = receipt(await registry.invoke(environment(store), registerRequest));
    expect(registered.state).toBe("completed");
    const packageVersion = (registered.result as any).package_version;
    expect(packageVersion.content_digest).toBe(packageDefinition.content_digest);
    expect((await registry.invoke(environment(store), registerRequest)).kind).toBe("receipt");
    expect(store.listPackageVersions(extension.extension_id)).toHaveLength(1);

    const schemas = receipt(await registry.invoke(
      environment(store),
      request(
        DISCOVER_EXTENSION_SCHEMAS_OPERATION_ID,
        {},
        "discover-schema",
        { target: { kind: "extension_package_version", id: packageVersion.extension_package_version_id } },
      ),
    ));
    expect((schemas.result as any).schemas).toMatchObject([{ schema_id: "catalog.item", schema_version: "1" }]);

    const inspected = receipt(await registry.invoke(
      environment(store),
      request(
        INSPECT_EXTENSION_OPERATION_ID,
        {},
        "inspect-catalog",
        { target: { kind: "extension", id: extension.extension_id } },
      ),
    ));
    expect((inspected.result as any)).toMatchObject({
      extension: { extension_id: "extension:catalog" },
      installation: null,
    });
  });

  it("requires confirmation and records missing approval or isolation as unresolved instead of activating code", async () => {
    assurance.hostAvailable = false;
    const packageDefinition = definition();
    const created = store.createExtension({
      workspace_id: "workspace:one",
      extension_id: "extension:catalog",
      label: "Catalogue",
    });
    const registered = store.registerPackage({
      workspace_id: "workspace:one",
      extension_id: created.extension_id,
      label: "Catalogue",
      expected_extension_revision: "0",
      definition: packageDefinition,
      registered_by_principal_id: "principal:builder",
    });
    const installRequest = request(
      INSTALL_EXTENSION_OPERATION_ID,
      { installation_name: "catalog", activate: true },
      "install-catalog",
      {
        target: { kind: "extension_package_version", id: registered.package_version.extension_package_version_id },
        expected_revision: registered.package_version.record_digest,
      },
    );
    const unconfirmed = receipt(await registry.invoke(environment(store), installRequest));
    expect(unconfirmed).toMatchObject({
      state: "refused",
      refusal: { code: "operation_confirmation_required" },
    });

    const confirmedAuthority = authority({ confirmations: new Set(["extension.install.confirm"]) });
    const confirmed = receipt(await registry.invoke(
      environment(store, confirmedAuthority),
      { ...installRequest, idempotency_key: "install-catalog-confirmed" },
    ));
    expect((confirmed.result as any).installation).toMatchObject({
      lifecycle: "unresolved",
      installed_package_version_id: null,
      pending_package_version_id: registered.package_version.extension_package_version_id,
    });
    expect((confirmed.result as any).installation.unresolved_bindings.map((item: any) => item.kind))
      .toEqual(["isolation_host", "permission_approval"]);
  });

  it("uses authority-bound approvals, exact revisions, disable, and rollback without exposing raw secrets", async () => {
    const v1Definition = definition("1.0.0");
    const extension = store.createExtension({
      workspace_id: "workspace:one",
      extension_id: "extension:catalog",
      label: "Catalogue",
    });
    const v1 = store.registerPackage({
      workspace_id: "workspace:one",
      extension_id: extension.extension_id,
      label: "Catalogue",
      expected_extension_revision: "0",
      definition: v1Definition,
      registered_by_principal_id: "principal:builder",
    });
    assurance.approvals.push({
      receipt_ref: "approval:permissions",
      workspace_id: "workspace:one",
      extension_id: extension.extension_id,
      permission_digest: extensionPermissionDigest(v1Definition.permissions),
      decision: "approved",
    });
    const installAuthority = authority({
      confirmations: new Set(["extension.install.confirm"]),
      approvals: new Set(["approval:permissions"]),
    });
    let installation = (receipt(await registry.invoke(
      environment(store, installAuthority),
      request(
        INSTALL_EXTENSION_OPERATION_ID,
        { installation_name: "catalog", activate: true },
        "install-approved",
        {
          target: { kind: "extension_package_version", id: v1.package_version.extension_package_version_id },
          expected_revision: v1.package_version.record_digest,
        },
      ),
    )).result as any).installation;
    expect(installation).toMatchObject({ lifecycle: "enabled", permission_approval_receipt_refs: ["approval:permissions"] });

    const activeContributions = receipt(await registry.invoke(
      environment(store),
      request(LIST_ACTIVE_EXTENSION_CONTRIBUTIONS_OPERATION_ID, {}, "list-active-before-disable"),
    ));
    expect(activeContributions.result).toMatchObject({
      active_extensions: [{
        extension_installation_id: installation.extension_installation_id,
        extension_package_version_id: v1.package_version.extension_package_version_id,
        contributions: {
          capabilities: [{ capability_id: "catalog.lookup" }],
          product_surfaces: [{ surface_id: "catalog.preview", projection_operation_id: "artefact.inspect" }],
        },
      }],
    });

    db.prepare("INSERT INTO execution_attempts (attempt_id) VALUES (?)").run("attempt:catalog");
    const invoked = receipt(await registry.invoke(
      environment(store, authority(), "attempt:catalog"),
      request(
        INVOKE_EXTENSION_ENTRY_POINT_OPERATION_ID,
        { entry_point_id: "catalog.lookup", request: { query: "crate" } },
        "invoke-catalog",
        {
          target: { kind: "extension_installation", id: installation.extension_installation_id },
          expected_revision: String(installation.revision_number),
        },
      ),
    ));
    expect(invoked.result).toMatchObject({
      extension_package_version_id: v1.package_version.extension_package_version_id,
      entry_point_id: "catalog.lookup",
      result: { ok: true },
    });
    expect(entryPointCalls).toContainEqual(expect.objectContaining({
      context: expect.objectContaining({
        execution_attempt_id: "attempt:catalog",
        authorized_principal_id: "principal:operator",
      }),
    }));
    expect(store.getExecutionPackagePin("attempt:catalog", installation.extension_installation_id))
      .toMatchObject({ extension_package_version_id: v1.package_version.extension_package_version_id });

    const v2Definition = definition("1.1.0");
    const v2 = store.registerPackage({
      workspace_id: "workspace:one",
      extension_id: extension.extension_id,
      label: "Catalogue",
      expected_extension_revision: "1",
      definition: v2Definition,
      registered_by_principal_id: "principal:builder",
    });
    const upgradeAuthority = authority({
      confirmations: new Set(["extension.upgrade.confirm"]),
      approvals: new Set(["approval:permissions"]),
    });
    installation = (receipt(await registry.invoke(
      environment(store, upgradeAuthority),
      request(
        UPGRADE_EXTENSION_OPERATION_ID,
        { to_extension_package_version_id: v2.package_version.extension_package_version_id, activate: true },
        "upgrade-v2",
        {
          target: { kind: "extension_installation", id: installation.extension_installation_id },
          expected_revision: String(installation.revision_number),
        },
      ),
    )).result as any).installation;
    expect(installation.installed_package_version_id).toBe(v2.package_version.extension_package_version_id);

    installation = (receipt(await registry.invoke(
      environment(store),
      request(
        DISABLE_EXTENSION_OPERATION_ID,
        {},
        "disable",
        {
          target: { kind: "extension_installation", id: installation.extension_installation_id },
          expected_revision: String(installation.revision_number),
        },
      ),
    )).result as any).installation;
    expect(installation.lifecycle).toBe("disabled");
    const removedContributions = receipt(await registry.invoke(
      environment(store),
      request(LIST_ACTIVE_EXTENSION_CONTRIBUTIONS_OPERATION_ID, {}, "list-active-after-disable"),
    ));
    expect(removedContributions.result).toEqual({ active_extensions: [] });

    installation = (receipt(await registry.invoke(
      environment(store, authority({
        confirmations: new Set(["extension.enable.confirm"]),
        approvals: new Set(["approval:permissions"]),
      })),
      request(
        ENABLE_EXTENSION_OPERATION_ID,
        {},
        "enable-again",
        {
          target: { kind: "extension_installation", id: installation.extension_installation_id },
          expected_revision: String(installation.revision_number),
        },
      ),
    )).result as any).installation;
    expect(installation.lifecycle).toBe("enabled");
    expect(store.listActiveContributions("workspace:one")).toHaveLength(1);

    const stale = receipt(await registry.invoke(
      environment(store),
      request(
        DISABLE_EXTENSION_OPERATION_ID,
        {},
        "stale-disable",
        {
          target: { kind: "extension_installation", id: installation.extension_installation_id },
          expected_revision: "1",
        },
      ),
    ));
    expect(stale).toMatchObject({ state: "refused", refusal: { code: "operation_resource_revision_conflict" } });

    expect(JSON.stringify(installation)).not.toContain("plaintext");
    expect(installation.permission_approval_receipt_refs).toEqual(["approval:permissions"]);
  });

  it("refuses cross-Workspace resource access and caller-supplied secret material", async () => {
    const extension = store.createExtension({
      workspace_id: "workspace:one",
      extension_id: "extension:catalog",
      label: "Catalogue",
    });
    const crossWorkspace = receipt(await registry.invoke(
      environment(store, authority({ workspace_id: "workspace:two" })),
      request(
        INSPECT_EXTENSION_OPERATION_ID,
        {},
        "inspect-other",
        { target: { kind: "extension", id: extension.extension_id } },
      ),
    ));
    expect(crossWorkspace).toMatchObject({
      state: "refused",
      refusal: { code: "operation_target_not_found" },
    });

    const unsafe = definition() as any;
    unsafe.permissions.secrets[0].value = "plaintext-secret";
    const invalid = receipt(await registry.invoke(
      environment(store),
      request(
        REGISTER_EXTENSION_BUILD_EVIDENCE_OPERATION_ID,
        { label: "Catalogue", definition: unsafe },
        "unsafe-secret",
        {
          target: { kind: "extension", id: extension.extension_id },
          expected_revision: "0",
        },
      ),
    ));
    expect(invalid).toMatchObject({
      state: "refused",
      refusal: { code: "operation_input_invalid" },
    });
    expect(store.listPackageVersions(extension.extension_id)).toHaveLength(0);
  });
});
