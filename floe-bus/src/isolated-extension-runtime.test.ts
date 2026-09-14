import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtensionPackageDefinition, ExtensionPackageVersion } from "./extensions.js";
import {
  ExtensionSandboxError,
  QuickJsExtensionSandbox,
  extensionExecutableContentDigest,
  verifyInstalledExtensionPackage,
  type ExtensionBrokerContext,
  type ExtensionHostBroker,
  type ExtensionRuntimeAudit,
  type JsonValue,
} from "./isolated-extension-runtime.js";

const roots: string[] = [];
const brokerContext: ExtensionBrokerContext = {
  workspace_id: "workspace:one",
  authorized_principal_id: "principal:actor",
  operation_invocation_id: "invocation:extension-one",
  extension_id: "extension:example",
  extension_package_version_id: "extpkg:one",
  entry_point_id: "example.run",
  execution_attempt_id: "attempt:one",
  capability_grant_ids: ["grant:one"],
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function packageVersion(source: string, overrides: Partial<ExtensionPackageDefinition> = {}): ExtensionPackageVersion {
  const entryPoint = { entry_point_id: "example.run", kind: "capability" as const, package_path: "run.js" };
  const contentDigest = extensionExecutableContentDigest([{ entry_point: entryPoint, source: Buffer.from(source) }]);
  const definition: ExtensionPackageDefinition = {
    package_version: "1.0.0",
    content_digest: contentDigest,
    source: { kind: "git", canonical_ref: "https://example.test/example.git", revision: "v1.0.0" },
    provenance: {
      built_from_refs: [],
      build_invocation_ref: { kind: "operation_invocation", id: "build:one", revision: null },
      trust_evidence: [],
    },
    compatibility: { floe_version_range: ">=0.1.0 <1.0.0", operation_contract_versions: ["1"] },
    required_isolation_level: "process_sandbox",
    permissions: {
      network: [],
      filesystem: [],
      secrets: [],
      data: [],
      actions: [],
    },
    contributions: { capabilities: [], connectors: [], schemas: [], product_surfaces: [] },
    entry_points: [entryPoint],
    test_evidence: [],
    ...overrides,
  };
  return {
    extension_package_version_id: "extpkg:one",
    extension_id: "extension:example",
    workspace_id: "workspace:one",
    package_version: definition.package_version,
    content_digest: definition.content_digest,
    permission_digest: digest(definition.permissions),
    record_digest: digest(definition),
    definition,
    registered_by_principal_id: "principal:builder",
    registered_at: "2026-09-04T00:00:00.000Z",
  };
}

function installPackage(version: ExtensionPackageVersion, source: string) {
  const root = mkdtempSync(join(tmpdir(), "floe-isolated-extension-"));
  roots.push(root);
  const installRoot = join(root, ".floe", "extensions", "example");
  mkdirSync(installRoot, { recursive: true });
  writeFileSync(join(installRoot, "extension.json"), JSON.stringify({
    schema: "floe.extension-installation.v1",
    extension_package_version_id: version.extension_package_version_id,
  }));
  writeFileSync(join(installRoot, "run.js"), source);
  return { root, installRoot };
}

function setup(version: ExtensionPackageVersion, options: { debug?: boolean; timeout?: number } = {}) {
  const calls: JsonValue[] = [];
  const broker: ExtensionHostBroker = {
    invokeOperation: vi.fn(async ({ operation_id, input }) => {
      calls.push({ operation_id, input } as JsonValue);
      return { operation_id, input } as JsonValue;
    }),
    accessFilesystem: vi.fn(async () => ({ content: "bounded" })),
    requestNetwork: vi.fn(async () => ({ status: 200 })),
  };
  const audit: ExtensionRuntimeAudit = { record: vi.fn() };
  const sandbox = new QuickJsExtensionSandbox(version, broker, audit, {
    variant: options.debug ? "debug" : "release",
    memory_limit_bytes: 16 * 1024 * 1024,
    stack_limit_bytes: 512 * 1024,
    execution_timeout_ms: options.timeout ?? 1_000,
  });
  return { sandbox, broker, audit, calls };
}

describe("isolated Extension runtime", () => {
  it("verifies exact installed executable bytes and refuses mutation or manifest pointers", () => {
    const source = "export default input => ({ echoed: input.value });";
    const version = packageVersion(source);
    const { root, installRoot } = installPackage(version, source);
    const verified = verifyInstalledExtensionPackage({
      workspace_root: root,
      installation_locator: ".floe/extensions/example/",
      package_version: version,
    });
    expect(verified.entry_points).toMatchObject([{ entry_point: { entry_point_id: "example.run" } }]);

    writeFileSync(join(installRoot, "run.js"), `${source}\n// changed`);
    expect(() => verifyInstalledExtensionPackage({
      workspace_root: root,
      installation_locator: ".floe/extensions/example/",
      package_version: version,
    })).toThrowError(expect.objectContaining({ code: "extension_package_digest_mismatch" }));

    writeFileSync(join(installRoot, "extension.json"), JSON.stringify({ manifest_source: "../../source/extension.json" }));
    expect(() => verifyInstalledExtensionPackage({
      workspace_root: root,
      installation_locator: ".floe/extensions/example/",
      package_version: version,
    })).toThrowError(expect.objectContaining({ code: "extension_installation_descriptor_invalid" }));
  });

  it("exposes no ambient Node, filesystem, or network globals in the debug/sanitized realm", async () => {
    const source = `
      export default () => ({
        process: typeof process,
        require: typeof require,
        fetch: typeof fetch,
        webSocket: typeof WebSocket,
        nodeGlobal: typeof global,
      });
    `;
    const version = packageVersion(source);
    const installed = installPackage(version, source);
    const verified = verifyInstalledExtensionPackage({
      workspace_root: installed.root,
      installation_locator: ".floe/extensions/example/",
      package_version: version,
    });
    const { sandbox } = setup(version, { debug: true });
    await sandbox.activate(verified.entry_points);
    await expect(sandbox.invoke({ entry_point_id: "example.run", request: {}, context: brokerContext }))
      .resolves.toEqual({
        process: "undefined",
        require: "undefined",
        fetch: "undefined",
        webSocket: "undefined",
        nodeGlobal: "undefined",
      });
    sandbox.dispose();
  });

  it("brokers a declared operation and audits its exact execution context", async () => {
    const source = `
      export default async input => floe.invokeOperation({
        permission_id: "action:inspect",
        operation_id: "artefact.inspect",
        target: { kind: "artefact", id: input.artefact_id },
        input: {},
      });
    `;
    const base = packageVersion(source);
    const version = packageVersion(source, {
      permissions: {
        ...base.definition.permissions,
        actions: [{ permission_id: "action:inspect", operation_id: "artefact.inspect" }],
      },
    });
    const installed = installPackage(version, source);
    const verified = verifyInstalledExtensionPackage({
      workspace_root: installed.root,
      installation_locator: ".floe/extensions/example/",
      package_version: version,
    });
    const { sandbox, broker, audit } = setup(version);
    await sandbox.activate(verified.entry_points);
    await expect(sandbox.invoke({
      entry_point_id: "example.run",
      request: { artefact_id: "artefact:one" },
      context: brokerContext,
    })).resolves.toMatchObject({ operation_id: "artefact.inspect" });
    expect(broker.invokeOperation).toHaveBeenCalledWith(expect.objectContaining({
      context: brokerContext,
      permission_id: "action:inspect",
      operation_id: "artefact.inspect",
    }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      context: brokerContext,
      outcome: "completed",
    }));
    sandbox.dispose();
  });

  it("refuses undeclared operation, filesystem, network, and SecretRef access before the broker", async () => {
    const requests = [
      `floe.invokeOperation({ permission_id: "action:no", operation_id: "workspace.destroy", target: null, input: {} })`,
      `floe.readFile({ permission_id: "filesystem:no", scope: "workspace", path: "secret.txt" })`,
      `floe.request({ permission_id: "network:no", origin: "https://example.test", method: "GET", path: "/" })`,
      `floe.request({ permission_id: "network:no", origin: "https://example.test", method: "GET", path: "/", secret: { permission_id: "secret:no", secret_ref_id: "secret:one", purpose: "steal" } })`,
    ];
    for (const request of requests) {
      const source = `export default async () => ${request};`;
      const version = packageVersion(source);
      const installed = installPackage(version, source);
      const verified = verifyInstalledExtensionPackage({
        workspace_root: installed.root,
        installation_locator: ".floe/extensions/example/",
        package_version: version,
      });
      const { sandbox, broker } = setup(version);
      await sandbox.activate(verified.entry_points);
      await expect(sandbox.invoke({ entry_point_id: "example.run", request: {}, context: brokerContext }))
        .rejects.toThrow(/permission.*not declared/i);
      expect(broker.invokeOperation).not.toHaveBeenCalled();
      expect(broker.accessFilesystem).not.toHaveBeenCalled();
      expect(broker.requestNetwork).not.toHaveBeenCalled();
      sandbox.dispose();
    }
  }, 20_000);

  it("interrupts runaway code within the sandbox deadline", async () => {
    const source = "export default () => { while (true) {} };";
    const version = packageVersion(source);
    const installed = installPackage(version, source);
    const verified = verifyInstalledExtensionPackage({
      workspace_root: installed.root,
      installation_locator: ".floe/extensions/example/",
      package_version: version,
    });
    const { sandbox } = setup(version, { timeout: 50 });
    await sandbox.activate(verified.entry_points);
    await expect(sandbox.invoke({ entry_point_id: "example.run", request: {}, context: brokerContext }))
      .rejects.toThrow(ExtensionSandboxError);
    sandbox.dispose();
  });
});

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
