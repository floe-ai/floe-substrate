import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { ApprovalStore, applyApprovalSchema } from "./approvals.js";
import {
  CanonicalExtensionActivationAuthority,
  ExtensionActivationAttemptConflictError,
  ExtensionActivationAttemptStateError,
  extensionActivationApprovalAction,
  type ExtensionActivationReservationInput,
} from "./extension-activation-authority.js";
import {
  ExtensionStore,
  UnavailableExtensionActivationAssuranceProvider,
  type ExtensionPackageDefinition,
  type ExtensionPackageVersion,
} from "./extensions.js";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("canonical Extension activation authority", () => {
  it("atomically consumes one exact ApprovalReceipt and reserves one durable activation attempt", () => {
    const fixture = setup();
    const input = reservationInput(fixture.packageVersion, fixture.receiptId, "invocation:one");
    const first = fixture.authority.reserve(input);

    expect(first).toMatchObject({ replay: false, attempt: { state: "reserved" } });
    expect(fixture.approvals.requireReceipt(fixture.receiptId).use_count).toBe(1);

    const replay = fixture.authority.reserve(input);
    expect(replay.replay).toBe(true);
    expect(replay.attempt.extension_activation_attempt_id).toBe(first.attempt.extension_activation_attempt_id);
    expect(fixture.approvals.requireReceipt(fixture.receiptId).use_count).toBe(1);
  });

  it("does not record an attempt when no exact ApprovalReceipt authorises it", () => {
    const fixture = setup();
    const changed = {
      ...reservationInput(fixture.packageVersion, fixture.receiptId, "invocation:changed"),
      capability_grant_ids: ["grant:different"],
    };

    expect(() => fixture.authority.reserve(changed)).toThrow(/approved action.*changed/i);
    expect(fixture.authority.getByInvocation("invocation:changed")).toBeNull();
    expect(fixture.approvals.requireReceipt(fixture.receiptId).use_count).toBe(0);
  });

  it("refuses to bind one invocation to another package action or re-run an uncertain attempt", () => {
    const fixture = setup();
    const input = reservationInput(fixture.packageVersion, fixture.receiptId, "invocation:one");
    const reserved = fixture.authority.reserve(input);
    fixture.authority.markRunning(reserved.attempt.extension_activation_attempt_id);

    expect(() => fixture.authority.reserve({ ...input, requested_lifecycle: "installed" }))
      .toThrow(ExtensionActivationAttemptConflictError);
    expect(() => fixture.authority.markRunning(reserved.attempt.extension_activation_attempt_id))
      .toThrow(ExtensionActivationAttemptStateError);
  });
});

function setup() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE contexts (context_id TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO contexts (context_id) VALUES (?)").run("context:approval");
  applyApprovalSchema(db);
  const extensionStore = new ExtensionStore(db, new UnavailableExtensionActivationAssuranceProvider());
  const registered = extensionStore.registerPackage({
    workspace_id: "workspace:one",
    extension_id: "extension:example",
    label: "Example",
    definition: packageDefinition(),
    registered_by_principal_id: "principal:builder",
  });
  const packageVersion = registered.package_version;
  const approvals = new ApprovalStore(db, { now: () => "2026-09-04T00:00:00.000Z" });
  const input = reservationInput(packageVersion, "placeholder", "invocation:one");
  const request = approvals.createRequest({
    workspace_id: input.workspace_id,
    action: extensionActivationApprovalAction(input),
    context_id: "context:approval",
    requested_by_principal_id: input.authorized_principal_id,
    reason: "Enable the reviewed Extension package.",
    expires_at: "2026-09-05T00:00:00.000Z",
    idempotency_key: "approval:example-v1",
  });
  const decision = approvals.decideRequest({
    workspace_id: input.workspace_id,
    approval_request_id: request.approval_request_id,
    expected_state_revision: request.state_revision,
    decision: "approved",
    decided_by_principal_id: "principal:approver",
    decision_event_id: "event:approval",
    decision_reason: "The exact package and permission set were reviewed.",
  });
  const receiptId = decision.receipt!.approval_receipt_id;
  const authority = new CanonicalExtensionActivationAuthority(
    db,
    approvals,
    () => "2026-09-04T00:00:01.000Z",
  );
  return { db, approvals, authority, packageVersion, receiptId };
}

function reservationInput(
  packageVersion: ExtensionPackageVersion,
  receiptId: string,
  invocationId: string,
): ExtensionActivationReservationInput {
  return {
    invocation_id: invocationId,
    workspace_id: "workspace:one",
    extension_installation_id: "extension-installation:example",
    package_version: packageVersion,
    operation_id: "extension.install",
    authorized_principal_id: "principal:operator",
    requested_lifecycle: "enabled",
    installation_locator: ".floe/extensions/example/",
    approval_receipt_refs: [receiptId],
    approval_policy_ref: { kind: "approval_policy", id: "policy:extension", revision: "1" },
    capability_grant_ids: ["grant:extension-install"],
  };
}

function packageDefinition(): ExtensionPackageDefinition {
  const contentDigest = digest("example-package");
  return {
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
    permissions: { network: [], filesystem: [], secrets: [], data: [], actions: [] },
    contributions: { capabilities: [], connectors: [], schemas: [], product_surfaces: [] },
    entry_points: [{ entry_point_id: "example.run", kind: "capability", package_path: "run.js" }],
    test_evidence: [
      {
        evidence_id: "test:deterministic",
        kind: "deterministic",
        result: "passed",
        subject_content_digest: contentDigest,
        report_ref: { kind: "test_report", id: "test:deterministic", revision: "1" },
      },
      {
        evidence_id: "test:adversarial",
        kind: "adversarial",
        result: "passed",
        subject_content_digest: contentDigest,
        report_ref: { kind: "test_report", id: "test:adversarial", revision: "1" },
      },
    ],
  };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
