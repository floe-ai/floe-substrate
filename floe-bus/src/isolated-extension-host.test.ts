import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtensionPackageDefinition, ExtensionPackageVersion } from "./extensions.js";
import {
  IsolatedExtensionProcessHost,
  type ExtensionHostActivation,
} from "./isolated-extension-host.js";
import {
  ExtensionSandboxError,
  extensionExecutableContentDigest,
  type ExtensionBrokerContext,
  type ExtensionHostBroker,
  type ExtensionRuntimeAudit,
} from "./isolated-extension-runtime.js";

const roots: string[] = [];
const hosts: IsolatedExtensionProcessHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("separate-process Extension host", () => {
  it("activates and invokes only an exact content-verified package", async () => {
    const source = "export default input => ({ version: 'v1', value: input.value });";
    const version = packageVersion("one", "1.0.0", source);
    const installed = installPackage(version, source);
    const fixture = setupHost();

    await fixture.host.activate(activation(installed.root, version));
    await expect(fixture.host.invoke({
      extension_installation_id: "extension-installation:example",
      extension_package_version_id: version.extension_package_version_id,
      entry_point_id: "example.run",
      request: { value: 7 },
      context: brokerContext(version),
    })).resolves.toEqual({ version: "v1", value: 7 });
    expect(fixture.host.isActive({
      extension_installation_id: "extension-installation:example",
      extension_package_version_id: version.extension_package_version_id,
    })).toBe(true);
  });

  it("keeps the current package active when an upgrade candidate cannot activate", async () => {
    const v1Source = "export default () => ({ version: 'v1' });";
    const v1 = packageVersion("one", "1.0.0", v1Source);
    const installed = installPackage(v1, v1Source);
    const fixture = setupHost();
    await fixture.host.activate(activation(installed.root, v1));

    const badSource = "export default () => {";
    const bad = packageVersion("bad", "2.0.0", badSource);
    writeInstalledPackage(installed.installRoot, bad, badSource);
    await expect(fixture.host.activate(activation(installed.root, bad))).rejects.toThrow(ExtensionSandboxError);

    await expect(fixture.host.invoke({
      extension_installation_id: "extension-installation:example",
      extension_package_version_id: v1.extension_package_version_id,
      entry_point_id: "example.run",
      request: {},
      context: brokerContext(v1),
    })).resolves.toEqual({ version: "v1" });
  });

  it("upgrades and rolls back by swapping exact package versions", async () => {
    const v1Source = "export default () => ({ version: 'v1' });";
    const v2Source = "export default () => ({ version: 'v2' });";
    const v1 = packageVersion("one", "1.0.0", v1Source);
    const v2 = packageVersion("two", "2.0.0", v2Source);
    const installed = installPackage(v1, v1Source);
    const fixture = setupHost();
    await fixture.host.activate(activation(installed.root, v1));

    writeInstalledPackage(installed.installRoot, v2, v2Source);
    await fixture.host.activate(activation(installed.root, v2));
    await expect(invokeVersion(fixture.host, v2)).resolves.toEqual({ version: "v2" });

    writeInstalledPackage(installed.installRoot, v1, v1Source);
    await fixture.host.activate(activation(installed.root, v1));
    await expect(invokeVersion(fixture.host, v1)).resolves.toEqual({ version: "v1" });
  });

  it("kills a wedged child at the parent deadline and reports the exact package for quarantine", async () => {
    const source = "export default async () => await new Promise(() => {});";
    const version = packageVersion("wedged", "1.0.0", source);
    const installed = installPackage(version, source);
    let resolveExit!: (value: unknown) => void;
    const unexpectedExit = new Promise((resolvePromise) => { resolveExit = resolvePromise; });
    const fixture = setupHost({
      parent_invocation_timeout_ms: 100,
      onUnexpectedExit: (event) => resolveExit(event),
    });
    await fixture.host.activate(activation(installed.root, version));

    await expect(invokeVersion(fixture.host, version)).rejects.toMatchObject({ code: "extension_host_timeout" });
    await expect(unexpectedExit).resolves.toMatchObject({
      workspace_id: "workspace:one",
      extension_installation_id: "extension-installation:example",
      extension_package_version_id: version.extension_package_version_id,
    });
    expect(fixture.host.isActive({
      extension_installation_id: "extension-installation:example",
      extension_package_version_id: version.extension_package_version_id,
    })).toBe(false);
  });
});

function setupHost(options: {
  parent_invocation_timeout_ms?: number;
  onUnexpectedExit?: (event: unknown) => void;
} = {}) {
  const broker: ExtensionHostBroker = {
    invokeOperation: vi.fn(async () => null),
    accessFilesystem: vi.fn(async () => null),
    requestNetwork: vi.fn(async () => null),
  };
  const audit: ExtensionRuntimeAudit = { record: vi.fn() };
  const host = new IsolatedExtensionProcessHost({
    executable_path: process.execPath,
    script_path: fileURLToPath(new URL("../dist/isolated-extension-host-process.js", import.meta.url)),
    allow_fs_read: [
      fileURLToPath(new URL("../dist/", import.meta.url)),
      fileURLToPath(new URL("../package.json", import.meta.url)),
      fileURLToPath(new URL("../../package.json", import.meta.url)),
      fileURLToPath(new URL("../../node_modules/", import.meta.url)),
    ],
  }, broker, audit, {
    onUnexpectedExit: options.onUnexpectedExit ?? (() => undefined),
  }, {
    parent_invocation_timeout_ms: options.parent_invocation_timeout_ms ?? 2_000,
    start_timeout_ms: 10_000,
    stop_timeout_ms: 2_000,
    execution_timeout_ms: 1_000,
    memory_limit_bytes: 16 * 1024 * 1024,
    stack_limit_bytes: 512 * 1024,
  });
  hosts.push(host);
  return { host, broker, audit };
}

function activation(root: string, version: ExtensionPackageVersion): ExtensionHostActivation {
  return {
    workspace_root: root,
    installation: {
      extension_installation_id: "extension-installation:example",
      workspace_id: "workspace:one",
      installation_locator: ".floe/extensions/example/",
    },
    package_version: version,
  };
}

function invokeVersion(host: IsolatedExtensionProcessHost, version: ExtensionPackageVersion) {
  return host.invoke({
    extension_installation_id: "extension-installation:example",
    extension_package_version_id: version.extension_package_version_id,
    entry_point_id: "example.run",
    request: {},
    context: brokerContext(version),
  });
}

function brokerContext(version: ExtensionPackageVersion): ExtensionBrokerContext {
  return {
    workspace_id: "workspace:one",
    authorized_principal_id: "principal:actor",
    operation_invocation_id: "invocation:extension-one",
    extension_id: "extension:example",
    extension_package_version_id: version.extension_package_version_id,
    entry_point_id: "example.run",
    execution_attempt_id: "execution-attempt:one",
    capability_grant_ids: ["grant:one"],
  };
}

function packageVersion(id: string, semanticVersion: string, source: string): ExtensionPackageVersion {
  const entryPoint = { entry_point_id: "example.run", kind: "capability" as const, package_path: "run.js" };
  const contentDigest = extensionExecutableContentDigest([{ entry_point: entryPoint, source: Buffer.from(source) }]);
  const definition: ExtensionPackageDefinition = {
    package_version: semanticVersion,
    content_digest: contentDigest,
    source: { kind: "git", canonical_ref: "https://example.test/example.git", revision: `v${semanticVersion}` },
    provenance: {
      built_from_refs: [],
      build_invocation_ref: { kind: "operation_invocation", id: `build:${id}`, revision: null },
      trust_evidence: [],
    },
    compatibility: { floe_version_range: ">=0.1.0 <1.0.0", operation_contract_versions: ["1"] },
    required_isolation_level: "process_sandbox",
    permissions: { network: [], filesystem: [], secrets: [], data: [], actions: [] },
    contributions: { capabilities: [], connectors: [], schemas: [], product_surfaces: [] },
    entry_points: [entryPoint],
    test_evidence: [],
  };
  return {
    extension_package_version_id: `extpkg:${id}`,
    extension_id: "extension:example",
    workspace_id: "workspace:one",
    package_version: semanticVersion,
    content_digest: contentDigest,
    permission_digest: digest(definition.permissions),
    record_digest: digest(definition),
    definition,
    registered_by_principal_id: "principal:builder",
    registered_at: "2026-09-04T00:00:00.000Z",
  };
}

function installPackage(version: ExtensionPackageVersion, source: string) {
  const root = mkdtempSync(join(tmpdir(), "floe-extension-host-"));
  roots.push(root);
  const installRoot = join(root, ".floe", "extensions", "example");
  mkdirSync(installRoot, { recursive: true });
  writeInstalledPackage(installRoot, version, source);
  return { root, installRoot };
}

function writeInstalledPackage(installRoot: string, version: ExtensionPackageVersion, source: string): void {
  writeFileSync(join(installRoot, "extension.json"), JSON.stringify({
    schema: "floe.extension-installation.v1",
    extension_package_version_id: version.extension_package_version_id,
  }));
  writeFileSync(join(installRoot, "run.js"), source);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
