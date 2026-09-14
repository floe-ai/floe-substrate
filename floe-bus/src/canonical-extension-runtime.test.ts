import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  CurrentExtensionCompatibilityVerifier,
  SqliteExtensionRuntimeAudit,
} from "./canonical-extension-runtime.js";

describe("current Extension host compatibility", () => {
  const verifier = new CurrentExtensionCompatibilityVerifier("0.1.6", ["1"]);

  it("accepts only a compatible Floe range with a shared operation contract", () => {
    expect(verifier.verify({
      floe_version_range: ">=0.1.0 <0.2.0",
      operation_contract_versions: ["1"],
    })).toEqual({ compatible: true });
  });

  it("fails closed for an unsupported operation contract", () => {
    expect(verifier.verify({
      floe_version_range: ">=0.1.0 <0.2.0",
      operation_contract_versions: ["2"],
    })).toMatchObject({
      compatible: false,
      reason_code: "extension_operation_contract_incompatible",
    });
  });

  it("fails closed for an incompatible or unrecognised Floe range", () => {
    expect(verifier.verify({
      floe_version_range: ">=0.2.0",
      operation_contract_versions: ["1"],
    })).toMatchObject({ compatible: false, reason_code: "extension_floe_version_incompatible" });
    expect(verifier.verify({
      floe_version_range: "0.1 || 0.2",
      operation_contract_versions: ["1"],
    })).toMatchObject({ compatible: false, reason_code: "extension_floe_version_incompatible" });
    expect(new CurrentExtensionCompatibilityVerifier("0.2.0", ["1"]).verify({
      floe_version_range: "^0.1.0",
      operation_contract_versions: ["1"],
    })).toMatchObject({ compatible: false, reason_code: "extension_floe_version_incompatible" });
  });
});

describe("Extension runtime audit boundary", () => {
  let db: DatabaseSync;

  afterEach(() => db?.close());

  it("records exact authority and permission identity without request or secret material", async () => {
    db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE extension_package_versions (
        extension_package_version_id TEXT PRIMARY KEY
      );
      INSERT INTO extension_package_versions VALUES ('extpkg_test');
    `);
    const audit = new SqliteExtensionRuntimeAudit(db, () => "2026-09-04T10:00:00.000Z");
    await audit.record({
      context: {
        workspace_id: "workspace:test",
        authorized_principal_id: "principal:test",
        operation_invocation_id: "invocation:test",
        extension_id: "extension:test",
        extension_package_version_id: "extpkg_test",
        entry_point_id: "entry:test",
        execution_attempt_id: "attempt:test",
        capability_grant_ids: ["grant:test"],
      },
      call: {
        kind: "network",
        permission_id: "permission:network",
        origin: "https://example.test",
        method: "POST",
        path: "/private",
        headers: { authorization: "Bearer must-not-be-recorded" },
        body: "secret-body-must-not-be-recorded",
        secret: {
          permission_id: "permission:secret",
          secret_ref_id: "secret-ref:test",
          purpose: "extension-test",
        },
      },
      outcome: "refused",
      code: "extension_network_broker_unavailable",
    });

    const records = audit.listForInvocation("invocation:test");
    expect(records).toEqual([expect.objectContaining({
      workspace_id: "workspace:test",
      authorized_principal_id: "principal:test",
      extension_package_version_id: "extpkg_test",
      entry_point_id: "entry:test",
      call_kind: "network",
      permission_id: "permission:network",
      outcome: "refused",
      code: "extension_network_broker_unavailable",
    })]);
    const stored = JSON.stringify(db.prepare("SELECT * FROM extension_runtime_audit").all());
    expect(stored).not.toContain("must-not-be-recorded");
    expect(stored).not.toContain("secret-ref:test");
    expect(stored).not.toContain("grant:test");
  });
});
