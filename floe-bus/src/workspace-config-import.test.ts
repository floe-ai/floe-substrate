import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActorDefinitionStore } from "./actor-definitions.js";
import { RuntimeProfileStore } from "./runtime-profiles.js";
import {
  SqliteCapabilityGrantStore,
  applyCapabilityGrantSchema,
} from "./capability-grants.js";
import {
  SqliteSecretRefStore,
  applyCredentialBrokerSchema,
} from "./credential-broker.js";
import { providerAccountSecretRefId } from "./credential-operations.js";
import {
  WorkspaceConfigurationImportBoundaryError,
  WorkspaceConfigurationApplyError,
  WorkspaceConfigurationPolicyError,
  WorkspaceConfigurationImportStore,
  WorkspaceConfigurationInventoryValidationError,
  workspaceConfigurationActorId,
  workspaceConfigurationRuntimeProfileId,
  type WorkspaceConfigurationImportPolicy,
  type WorkspaceConfigurationInventoryV1,
} from "./workspace-config-import.js";

const NOW = "2026-09-04T00:00:00.000Z";
const WORKSPACE_ID = "workspace:one";
const BINDING_ID = "binding:one";
const HOST_ID = "host:test";
const PROVIDER_ID = "openai-codex";

function policy(overrides: Partial<WorkspaceConfigurationImportPolicy> = {}): WorkspaceConfigurationImportPolicy {
  return {
    policy_revision: "legacy-workspace-operations.v1",
    actor_operation_authority: [
      {
        source_actor_id: "builder",
        operation_ids: ["context.inspect", "scope.plan.inspect", "scope.execution.start"],
      },
      {
        source_actor_id: "floe",
        operation_ids: ["context.inspect", "scope.plan.inspect", "scope.execution.start"],
      },
    ],
    expires_at: "2099-01-01T00:00:00.000Z",
    issuer_id: "principal:host-policy",
    import_principal_id: "principal:workspace-import",
    ...overrides,
  };
}

function actor(
  sourceActorId: string,
  overrides: Partial<WorkspaceConfigurationInventoryV1["actors"][number]> = {},
): WorkspaceConfigurationInventoryV1["actors"][number] {
  const candidate: WorkspaceConfigurationInventoryV1["actors"][number] = {
    source_actor_id: sourceActorId,
    source: {
      kind: "workspace_actor_file",
      path: `agents/${sourceActorId}.md`,
      source_fingerprint: `sha256:${"b".repeat(64)}`,
    },
    definition: {
      label: sourceActorId === "floe" ? "Floe" : "Builder",
      charter: "Pursue the outcome assigned to this Actor.",
      responsibilities: [],
      instructions: `Instructions for ${sourceActorId}.`,
      knowledge_refs: [],
      policy_refs: { budget: null, trust: null, approval: null },
      escalation_rules: [],
    },
    runtime: {
      label: `${sourceActorId} runtime`,
      backing_kind: "model",
      adapter_id: "pi-agent-core",
      configuration: { provider: "openai-codex", model: "gpt-5.6", thinking_level: "high" },
      required_capability_ids: [],
      checkpoint_policy: { mode: "provider_neutral", schema_ref: null },
      resource_policy: {},
      credential_requirement: "required",
      required_configuration_keys: ["model"],
      credential_reference: {
        source_kind: "provider_account",
        provider_id: PROVIDER_ID,
        secret_kind: "runtime_authentication",
      },
    },
    ...overrides,
  };
  return candidate;
}

function inventory(
  actors: WorkspaceConfigurationInventoryV1["actors"] = [actor("floe")],
  overrides: Partial<WorkspaceConfigurationInventoryV1> = {},
): WorkspaceConfigurationInventoryV1 {
  return {
    schema: "floe.workspace-configuration-inventory.v1",
    importer_version: "1",
    binding_id: BINDING_ID,
    config_hash: `sha256:${"a".repeat(64)}`,
    source: { kind: "workspace_files", manifest_ref: ".floe/floe.yaml" },
    validation: { ok: true, issues: [] },
    actors,
    ...overrides,
  };
}

describe("canonical Workspace configuration import", () => {
  let db: DatabaseSync;
  let actorDefinitions: ActorDefinitionStore;
  let runtimeProfiles: RuntimeProfileStore;
  let capabilityGrants: SqliteCapabilityGrantStore;
  let secretRefs: SqliteSecretRefStore;
  let currentBinding: string;
  let rebindAfterNextSuccessfulCheck: boolean;
  let projectedOperationRequest: unknown;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    actorDefinitions = new ActorDefinitionStore(db, () => NOW);
    runtimeProfiles = new RuntimeProfileStore(db, () => NOW);
    applyCapabilityGrantSchema(db);
    capabilityGrants = new SqliteCapabilityGrantStore(db, { now: () => NOW });
    applyCredentialBrokerSchema(db);
    secretRefs = new SqliteSecretRefStore(db, { now: () => NOW });
    currentBinding = BINDING_ID;
    rebindAfterNextSuccessfulCheck = false;
    projectedOperationRequest = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  function importer(
    selectedPolicy = policy(),
    operationIds: readonly string[] = [
      "context.destroy.permanent",
      "context.inspect",
      "scope.plan.inspect",
      "scope.execution.start",
    ],
    clock: () => string = () => NOW,
  ): WorkspaceConfigurationImportStore {
    return new WorkspaceConfigurationImportStore({
      db,
      actor_definitions: actorDefinitions,
      runtime_profiles: runtimeProfiles,
      capability_grants: capabilityGrants,
      secret_refs: secretRefs,
      local_host_id: HOST_ID,
      policy_for_inventory: () => selectedPolicy,
      operation_registry: {
        listCurrentOperationIds: (request) => {
          projectedOperationRequest = request;
          return [...operationIds];
        },
      },
      now: clock,
      require_current_binding: (workspaceId, bindingId) => {
        if (workspaceId !== WORKSPACE_ID || bindingId !== currentBinding) throw new Error("not current");
        if (rebindAfterNextSuccessfulCheck) {
          rebindAfterNextSuccessfulCheck = false;
          currentBinding = "binding:replaced";
        }
      },
    });
  }

  it("creates exact canonical records before runtime use and replays the same inventory without duplicates", () => {
    const imports = importer();
    const first = imports.import(WORKSPACE_ID, inventory());
    const second = imports.import(WORKSPACE_ID, inventory());

    expect(first.replayed).toBe(false);
    expect(projectedOperationRequest).toEqual({
      interaction_mode: "unattended",
      boundary_kind: "workspace",
    });
    expect(second).toEqual({ replayed: true, receipt: first.receipt });
    expect(first.receipt).toMatchObject({
      outcome: "applied",
      workspace_id: WORKSPACE_ID,
      binding_id: BINDING_ID,
      policy_revision: "legacy-workspace-operations.v1",
      policy_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      refusal: null,
      imported_actors: [{
        source_actor_id: "floe",
        actor_id: "actor:workspace:one:floe",
        runtime_profile_id: "runtime-profile:actor:workspace:one:floe",
        runtime_status: "unresolved",
        unresolved_reasons: ["runtime_credential_unresolved"],
        secret_ref_ids: [providerAccountSecretRefId(HOST_ID, PROVIDER_ID)],
      }],
    });

    const imported = first.receipt.imported_actors[0]!;
    expect(actorDefinitions.requireActor(imported.actor_id).current_definition_revision_id)
      .toBe(imported.actor_definition_revision_id);
    expect(actorDefinitions.requireRevision(imported.actor_definition_revision_id).content.capability_grant_ids)
      .toEqual([imported.capability_grant_id]);
    expect(capabilityGrants.getGrant(imported.capability_grant_id!)).toMatchObject({
      principal_id: imported.actor_id,
      boundary: { kind: "workspace", workspace_id: WORKSPACE_ID },
      operation_ids: ["context.inspect", "scope.execution.start", "scope.plan.inspect"],
    });
    expect(capabilityGrants.getGrant(imported.capability_grant_id!)?.operation_ids)
      .not.toContain("context.destroy.permanent");
    expect(runtimeProfiles.requireRevision(imported.runtime_profile_revision_id).content)
      .toMatchObject({
        adapter_id: "pi-agent-core",
        configuration: { provider: "openai-codex", model: "gpt-5.6", thinking_level: "high" },
        secret_ref_ids: imported.secret_ref_ids,
      });
    expect(runtimeProfiles.requireActorBinding(imported.actor_runtime_binding_id).status).toBe("unresolved");
    expect(actorDefinitions.listRevisions(imported.actor_id)).toHaveLength(1);
    expect(runtimeProfiles.listRevisions(imported.runtime_profile_id)).toHaveLength(1);
    expect(runtimeProfiles.listActorBindings(imported.actor_id)).toHaveLength(1);
    expect(imports.listReceipts(WORKSPACE_ID)).toHaveLength(1);
  });

  it("creates a separate exact credential grant and keeps unresolved work blocked", () => {
    const providerRefId = providerAccountSecretRefId(HOST_ID, PROVIDER_ID);
    secretRefs.createSecretRef({
      secret_ref_id: providerRefId,
      owner: { kind: "host", host_id: HOST_ID },
      resource: { kind: "provider_account", id: PROVIDER_ID },
      secret_kind: "runtime_authentication",
      label: "ChatGPT",
    });
    const selectedPolicy = policy({
      actor_operation_authority: [{
        source_actor_id: "floe",
        operation_ids: [
          "context.inspect",
          "credential.use",
          "credential.refresh",
        ],
      }],
    });
    const imports = importer(selectedPolicy, [
      "context.inspect",
      "credential.use",
      "credential.refresh",
    ]);

    const imported = imports.import(WORKSPACE_ID, inventory()).receipt.imported_actors[0]!;

    expect(imported.runtime_status).toBe("unresolved");
    expect(imported.unresolved_reasons).toContain("runtime_credential_unresolved");
    expect(imported.unresolved_reasons).not.toContain("runtime_credential_authority_unresolved");
    expect(imported.capability_grant_ids).toHaveLength(2);
    const credentialGrant = imported.capability_grant_ids
      .map((grantId) => capabilityGrants.getGrant(grantId))
      .find((grant) => grant?.operation_ids.includes("credential.use"));
    expect(credentialGrant).toMatchObject({
      principal_id: imported.actor_id,
      boundary: { kind: "workspace", workspace_id: WORKSPACE_ID },
      operation_ids: ["credential.refresh", "credential.use"],
      targets: expect.arrayContaining([
        { kind: "secret_ref", id: imported.secret_ref_ids[0] },
        { kind: "provider_account", id: PROVIDER_ID },
      ]),
    });
    expect(secretRefs.getGrantConstraint(credentialGrant!.grant_id)).toEqual({
      grant_id: credentialGrant!.grant_id,
      secret_ref_id: imported.secret_ref_ids[0],
      authority_boundary: { kind: "workspace", workspace_id: WORKSPACE_ID },
      purposes: ["runtime-provider-authentication"],
    });
    expect(new Set(actorDefinitions.requireRevision(imported.actor_definition_revision_id).content.capability_grant_ids))
      .toEqual(new Set(imported.capability_grant_ids));
  });

  it("creates immutable Actor, Runtime Profile, and Runtime Binding revisions when Workspace files change", () => {
    const imports = importer();
    const first = imports.import(WORKSPACE_ID, inventory());
    const changedActor = actor("floe", {
      source: {
        kind: "workspace_actor_file",
        path: "agents/floe.md",
        source_fingerprint: `sha256:${"d".repeat(64)}`,
      },
      definition: {
        ...actor("floe").definition,
        instructions: "Revised instructions for Floe.",
      },
      runtime: {
        ...actor("floe").runtime,
        configuration: { provider: "openai-codex", model: "gpt-5.7", thinking_level: "medium" },
      },
    });
    const second = imports.import(WORKSPACE_ID, inventory([changedActor], {
      config_hash: `sha256:${"e".repeat(64)}`,
    }));

    expect(second.receipt.outcome).toBe("applied");
    const before = first.receipt.imported_actors[0]!;
    const after = second.receipt.imported_actors[0]!;
    expect(after.capability_grant_id).toBe(before.capability_grant_id);
    expect(after.actor_definition_revision_id).not.toBe(before.actor_definition_revision_id);
    expect(after.runtime_profile_revision_id).not.toBe(before.runtime_profile_revision_id);
    expect(after.actor_runtime_binding_id).not.toBe(before.actor_runtime_binding_id);
    expect(actorDefinitions.listRevisions(after.actor_id)).toHaveLength(2);
    expect(runtimeProfiles.listRevisions(after.runtime_profile_id)).toHaveLength(2);
    expect(runtimeProfiles.listActorBindings(after.actor_id)).toHaveLength(2);
    expect(runtimeProfiles.requireActorBinding(before.actor_runtime_binding_id).superseded_at).toBe(NOW);
  });

  it("refuses to overwrite an imported Actor after a canonical edit", () => {
    const imports = importer();
    const first = imports.import(WORKSPACE_ID, inventory());
    const imported = first.receipt.imported_actors[0]!;
    const current = actorDefinitions.requireRevision(imported.actor_definition_revision_id);
    const draft = actorDefinitions.createDraft({
      actor_id: imported.actor_id,
      based_on_revision_id: current.actor_definition_revision_id,
      created_by_principal_id: "principal:operator",
      definition: {
        ...current.content,
        instructions: "A canonical operator edit that the file importer must preserve.",
      },
    });
    const published = actorDefinitions.publishDraft({
      actor_definition_revision_id: draft.actor_definition_revision_id,
      expected_current_revision_id: current.actor_definition_revision_id,
      changed_by_principal_id: "principal:operator",
    });

    const changedFile = actor("floe", {
      definition: { ...actor("floe").definition, instructions: "A later legacy file edit." },
    });
    const result = imports.import(WORKSPACE_ID, inventory([changedFile], {
      config_hash: `sha256:${"1".repeat(64)}`,
    }));

    expect(result.receipt).toMatchObject({
      outcome: "refused",
      refusal: { code: "workspace_configuration_conflict", retryable: false },
    });
    expect(actorDefinitions.requireActor(imported.actor_id).current_definition_revision_id)
      .toBe(published.actor_definition_revision_id);
  });

  it("refuses to overwrite an imported Runtime Profile after a canonical edit", () => {
    const imports = importer();
    const first = imports.import(WORKSPACE_ID, inventory());
    const imported = first.receipt.imported_actors[0]!;
    const current = runtimeProfiles.requireRevision(imported.runtime_profile_revision_id);
    const draft = runtimeProfiles.createDraft({
      runtime_profile_id: imported.runtime_profile_id,
      based_on_revision_id: current.runtime_profile_revision_id,
      created_by_principal_id: "principal:operator",
      content: {
        ...current.content,
        configuration: { ...current.content.configuration, model: "operator-selected-model" },
      },
    });
    const published = runtimeProfiles.publishDraft({
      runtime_profile_revision_id: draft.runtime_profile_revision_id,
      expected_current_revision_id: current.runtime_profile_revision_id,
      changed_by_principal_id: "principal:operator",
    });

    const result = imports.import(WORKSPACE_ID, inventory([actor("floe", {
      runtime: {
        ...actor("floe").runtime,
        configuration: { provider: "openai-codex", model: "legacy-file-model" },
      },
    })], { config_hash: `sha256:${"2".repeat(64)}` }));

    expect(result.receipt).toMatchObject({
      outcome: "refused",
      refusal: { code: "workspace_configuration_conflict", retryable: false },
    });
    expect(runtimeProfiles.requireProfile(imported.runtime_profile_id).current_revision_id)
      .toBe(published.runtime_profile_revision_id);
  });

  it("preserves omitted canonical Actors instead of treating absence as deletion", () => {
    const imports = importer();
    imports.import(WORKSPACE_ID, inventory([actor("floe"), actor("builder")]));
    const next = imports.import(WORKSPACE_ID, inventory([actor("floe")], {
      config_hash: `sha256:${"f".repeat(64)}`,
    }));

    expect(next.receipt.outcome).toBe("applied");
    expect(next.receipt.preserved_actor_ids).toEqual(["actor:workspace:one:builder"]);
    expect(actorDefinitions.requireActor("actor:workspace:one:builder").status).toBe("active");
  });

  it("refuses to reclaim an omitted Actor that was canonically edited before reappearing", () => {
    const imports = importer();
    const first = imports.import(WORKSPACE_ID, inventory([actor("floe"), actor("builder")]));
    const builder = first.receipt.imported_actors.find((item) => item.source_actor_id === "builder")!;
    imports.import(WORKSPACE_ID, inventory([actor("floe")], {
      config_hash: `sha256:${"3".repeat(64)}`,
    }));
    const current = actorDefinitions.requireRevision(builder.actor_definition_revision_id);
    const draft = actorDefinitions.createDraft({
      actor_id: builder.actor_id,
      based_on_revision_id: current.actor_definition_revision_id,
      created_by_principal_id: "principal:operator",
      definition: { ...current.content, instructions: "Canonical work continued while this Actor was omitted." },
    });
    const published = actorDefinitions.publishDraft({
      actor_definition_revision_id: draft.actor_definition_revision_id,
      expected_current_revision_id: current.actor_definition_revision_id,
      changed_by_principal_id: "principal:operator",
    });

    const result = imports.import(WORKSPACE_ID, inventory([actor("floe"), actor("builder")], {
      config_hash: `sha256:${"4".repeat(64)}`,
    }));

    expect(result.receipt).toMatchObject({
      outcome: "refused",
      refusal: { code: "workspace_configuration_conflict" },
    });
    expect(actorDefinitions.requireActor(builder.actor_id).current_definition_revision_id)
      .toBe(published.actor_definition_revision_id);
  });

  it("keeps an Actor without explicit migration authority unavailable instead of expanding its grant", () => {
    const reviewer = actor("reviewer", {
      runtime: {
        ...actor("reviewer").runtime,
        backing_kind: "human",
        configuration: {},
        credential_requirement: "none",
        required_configuration_keys: [],
        credential_reference: null,
      },
    });

    const result = importer().import(WORKSPACE_ID, inventory([reviewer]));
    const imported = result.receipt.imported_actors[0]!;

    expect(imported).toMatchObject({
      capability_grant_id: null,
      runtime_status: "unresolved",
      unresolved_reasons: ["operation_authority_unmapped"],
    });
    expect(actorDefinitions.requireRevision(imported.actor_definition_revision_id).content.capability_grant_ids)
      .toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS count FROM capability_grants").get() as { count: number }).count)
      .toBe(0);
  });

  it("does not claim a broker-resolved SecretRef is usable without exact secret-use authority", () => {
    const secretRefId = providerAccountSecretRefId(HOST_ID, PROVIDER_ID);
    secretRefs.createSecretRef({
      secret_ref_id: secretRefId,
      owner: { kind: "host", host_id: HOST_ID },
      resource: { kind: "provider_account", id: PROVIDER_ID },
      secret_kind: "runtime_authentication",
      label: "ChatGPT",
    });
    db.prepare(`
      UPDATE secret_refs
      SET resolution = 'resolved', broker_id = 'broker:test', broker_locator = 'opaque:test', generation = 1
      WHERE owner_kind = 'host' AND owner_id = ? AND secret_ref_id = ?
    `).run(HOST_ID, secretRefId);

    const result = importer().import(WORKSPACE_ID, inventory());

    expect(result.receipt.imported_actors[0]).toMatchObject({
      runtime_status: "unresolved",
      unresolved_reasons: ["runtime_credential_authority_unresolved"],
      secret_ref_ids: [secretRefId],
    });
    expect(secretRefs.getSecretRef(secretRefId)?.binding)
      .toEqual({ broker_id: "broker:test", locator: "opaque:test" });
  });

  it("records file-validation refusal and changes no canonical resources", () => {
    const imports = importer();
    const invalid = inventory([actor("floe")], {
      validation: {
        ok: false,
        issues: [{ severity: "error", code: "workspace_manifest_invalid", source_ref: ".floe/floe.yaml" }],
      },
    });

    const first = imports.import(WORKSPACE_ID, invalid);
    const replay = imports.import(WORKSPACE_ID, invalid);

    expect(first.receipt).toMatchObject({
      outcome: "refused",
      refusal: { code: "workspace_configuration_invalid", retryable: false },
      imported_actors: [],
    });
    expect(replay.replayed).toBe(true);
    expect(actorDefinitions.listActors(WORKSPACE_ID, { include_retired: true })).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS count FROM runtime_profiles").get() as { count: number }).count).toBe(0);
  });

  it("refuses stale or cross-Workspace bindings before writing even refusal state", () => {
    currentBinding = "binding:new";
    const imports = importer();

    expect(() => imports.import(WORKSPACE_ID, inventory())).toThrow(WorkspaceConfigurationImportBoundaryError);
    expect(imports.listReceipts(WORKSPACE_ID)).toEqual([]);
    expect(actorDefinitions.listActors(WORKSPACE_ID, { include_retired: true })).toEqual([]);
  });

  it("rechecks the exact binding inside the write transaction", () => {
    rebindAfterNextSuccessfulCheck = true;
    const imports = importer();

    expect(() => imports.import(WORKSPACE_ID, inventory()))
      .toThrow(WorkspaceConfigurationImportBoundaryError);
    expect(imports.listReceipts(WORKSPACE_ID)).toEqual([]);
    expect(actorDefinitions.listActors(WORKSPACE_ID, { include_retired: true })).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS count FROM workspace_configuration_import_policies").get() as { count: number }).count)
      .toBe(0);
  });

  it("refuses a canonical Actor identity owned by another Workspace", () => {
    const actorId = workspaceConfigurationActorId(WORKSPACE_ID, "floe");
    actorDefinitions.createActor({
      actor_id: actorId,
      workspace_id: "workspace:other",
      created_by_principal_id: "principal:other",
      definition: {
        ...actor("floe").definition,
        capability_grant_ids: [],
      },
    });

    const result = importer().import(WORKSPACE_ID, inventory());

    expect(result.receipt).toMatchObject({
      outcome: "refused",
      refusal: { code: "workspace_configuration_conflict", retryable: false },
    });
    expect(actorDefinitions.requireActor(actorId).workspace_id).toBe("workspace:other");
  });

  it("refuses to overwrite an independently managed or retired canonical Actor", () => {
    const actorId = workspaceConfigurationActorId(WORKSPACE_ID, "floe");
    const independent = actorDefinitions.createActor({
      actor_id: actorId,
      workspace_id: WORKSPACE_ID,
      created_by_principal_id: "principal:operator",
      definition: {
        label: "Independent Floe",
        charter: "Remain independently managed.",
        responsibilities: [],
        instructions: "Do not replace this definition from legacy files.",
        knowledge_refs: [],
        capability_grant_ids: [],
        policy_refs: { budget: null, trust: null, approval: null },
        escalation_rules: [],
      },
    });
    actorDefinitions.publishDraft({
      actor_definition_revision_id: independent.draft.actor_definition_revision_id,
      expected_current_revision_id: null,
      changed_by_principal_id: "principal:operator",
    });
    const imports = importer();

    const refused = imports.import(WORKSPACE_ID, inventory());
    expect(refused.receipt).toMatchObject({
      outcome: "refused",
      refusal: { code: "workspace_configuration_conflict", retryable: false },
    });
    expect(actorDefinitions.listRevisions(actorId)).toHaveLength(1);
  });

  it("rejects raw secret fields and unsupported snapshot fields before any write", () => {
    const imports = importer();
    const unsafe = structuredClone(inventory()) as any;
    unsafe.actors[0].runtime.configuration.api_key = "must-not-enter-the-bus";

    expect(() => imports.import(WORKSPACE_ID, unsafe))
      .toThrow(WorkspaceConfigurationInventoryValidationError);
    expect(imports.listReceipts(WORKSPACE_ID)).toEqual([]);
    expect(JSON.stringify(db.prepare("SELECT * FROM sqlite_schema").all())).not.toContain("must-not-enter-the-bus");

    const copiedContract = structuredClone(inventory()) as any;
    copiedContract.actors[0].frontmatter = { auth_profile: "secret" };
    expect(() => imports.import(WORKSPACE_ID, copiedContract)).toThrow(/unsupported field 'frontmatter'/);
  });

  it.each([
    { nested: { access_token: "must-not-enter-the-bus" } },
    { openai_api_key: "must-not-enter-the-bus" },
    { provider: { client_secret: "must-not-enter-the-bus" } },
    { transport: { bearer_token: "must-not-enter-the-bus" } },
    { authorization: "must-not-enter-the-bus" },
    { signing: { private_key: "must-not-enter-the-bus" } },
  ])("rejects nested secret-shaped runtime configuration before any write: $configuration", (configuration) => {
    const imports = importer();
    const unsafe = structuredClone(inventory()) as any;
    unsafe.actors[0].runtime.configuration = configuration;

    expect(() => imports.import(WORKSPACE_ID, unsafe))
      .toThrow(WorkspaceConfigurationInventoryValidationError);
    expect(imports.listReceipts(WORKSPACE_ID)).toEqual([]);
    expect(actorDefinitions.listActors(WORKSPACE_ID, { include_retired: true })).toEqual([]);
  });

  it("refuses a migration policy that is not drawn from the current Workspace operation registry", () => {
    expect(() => importer(policy(), ["context.inspect"]).import(WORKSPACE_ID, inventory()))
      .toThrow(/unregistered Workspace operation 'scope.execution.start'/);
    expect(actorDefinitions.listActors(WORKSPACE_ID, { include_retired: true })).toEqual([]);
  });

  it("enforces immutable policy revisions instead of replaying changed authority", () => {
    importer().import(WORKSPACE_ID, inventory());
    const changedPolicy = policy({
      actor_operation_authority: [{
        source_actor_id: "floe",
        operation_ids: ["context.inspect"],
      }],
    });

    expect(() => importer(changedPolicy).import(WORKSPACE_ID, inventory()))
      .toThrow(WorkspaceConfigurationPolicyError);
    expect(capabilityGrants.listActiveGrantsForPrincipalBoundary(
      workspaceConfigurationActorId(WORKSPACE_ID, "floe"),
      { kind: "workspace", workspace_id: WORKSPACE_ID },
    )[0]?.operation_ids).toEqual(["context.inspect", "scope.execution.start", "scope.plan.inspect"]);
  });

  it("replays a committed receipt after policy expiry but refuses new work", () => {
    const first = importer().import(WORKSPACE_ID, inventory());
    const expiredClock = () => "2100-01-01T00:00:00.000Z";
    const expiredImporter = importer(policy(), undefined, expiredClock);

    expect(expiredImporter.import(WORKSPACE_ID, inventory())).toEqual({
      replayed: true,
      receipt: first.receipt,
    });
    expect(() => expiredImporter.import(WORKSPACE_ID, inventory([actor("floe", {
      definition: { ...actor("floe").definition, instructions: "New work after expiry." },
    })], { config_hash: `sha256:${"5".repeat(64)}` })))
      .toThrow(WorkspaceConfigurationPolicyError);
  });

  it("records canonical validation as a stable refusal before writing resources", () => {
    const invalidActor = actor("floe", {
      definition: {
        ...actor("floe").definition,
        escalation_rules: [{
          rule_id: "invalid-target",
          when: "Always",
          action: "escalate",
          target_actor_id: "actor:workspace:one:builder",
        }],
      },
    });

    const imports = importer();
    const result = imports.import(WORKSPACE_ID, inventory([invalidActor]));
    expect(result.receipt).toMatchObject({
      outcome: "refused",
      refusal: { code: "workspace_configuration_invalid", retryable: false },
    });
    expect(actorDefinitions.listActors(WORKSPACE_ID, { include_retired: true })).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS count FROM capability_grants").get() as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM secret_refs").get() as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM runtime_profiles").get() as { count: number }).count).toBe(0);
    expect(imports.listReceipts(WORKSPACE_ID)).toHaveLength(1);
  });

  it("rolls back every canonical write after an unexpected apply failure and allows a safe retry", () => {
    const imports = importer();
    vi.spyOn(actorDefinitions, "createActor").mockImplementationOnce(() => {
      throw new Error("simulated storage failure");
    });

    expect(() => imports.import(WORKSPACE_ID, inventory()))
      .toThrow(WorkspaceConfigurationApplyError);
    expect(actorDefinitions.listActors(WORKSPACE_ID, { include_retired: true })).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS count FROM capability_grants").get() as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM secret_refs").get() as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM runtime_profiles").get() as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM workspace_configuration_import_policies").get() as { count: number }).count)
      .toBe(0);
    expect(imports.listReceipts(WORKSPACE_ID)).toEqual([]);

    expect(imports.import(WORKSPACE_ID, inventory()).receipt.outcome).toBe("applied");
  });

  it("preserves a retired imported Actor as an explicit conflict", () => {
    const imports = importer();
    const first = imports.import(WORKSPACE_ID, inventory());
    const imported = first.receipt.imported_actors[0]!;
    actorDefinitions.setActorStatus({
      actor_id: imported.actor_id,
      status: "retired",
      expected_current_definition_revision_id: imported.actor_definition_revision_id,
    });

    const changed = actor("floe", {
      definition: {
        ...actor("floe").definition,
        instructions: "A changed file must not silently reactivate this Actor.",
      },
    });
    const result = imports.import(WORKSPACE_ID, inventory([changed], {
      config_hash: `sha256:${"7".repeat(64)}`,
    }));

    expect(result.receipt).toMatchObject({
      outcome: "refused",
      refusal: { code: "workspace_configuration_conflict", retryable: false },
    });
    expect(actorDefinitions.requireActor(imported.actor_id).status).toBe("retired");
  });

  it("keeps a disabled Runtime Binding disabled and records an explicit conflict", () => {
    const imports = importer();
    const first = imports.import(WORKSPACE_ID, inventory());
    const imported = first.receipt.imported_actors[0]!;
    runtimeProfiles.bindActor({
      actor_id: imported.actor_id,
      runtime_profile_revision_id: imported.runtime_profile_revision_id,
      endpoint_id: imported.actor_id,
      status: "disabled",
      expected_current_binding_id: imported.actor_runtime_binding_id,
      created_by_principal_id: "principal:operator",
    });

    const result = imports.import(WORKSPACE_ID, inventory([actor("floe", {
      definition: {
        ...actor("floe").definition,
        instructions: "A Workspace change that must not reactivate a disabled Runtime Binding.",
      },
    })], { config_hash: `sha256:${"8".repeat(64)}` }));

    expect(result.receipt).toMatchObject({
      outcome: "refused",
      refusal: { code: "workspace_configuration_conflict" },
    });
    expect(runtimeProfiles.getCurrentActorBinding(imported.actor_id)?.status).toBe("disabled");
  });
});
