import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  ActorDefinitionStore,
  actorDefinitionDigest,
  validateActorDefinition,
  type ActorDefinitionContent,
  type ActorDefinitionRevision,
} from "./actor-definitions.js";
import {
  RuntimeProfileStore,
  runtimeProfileDigest,
  validateRuntimeProfile,
  type ActorRuntimeBindingRecord,
  type RuntimeProfileContent,
  type RuntimeProfileRevision,
} from "./runtime-profiles.js";
import {
  SqliteCapabilityGrantStore,
  type CapabilityGrantRecord,
} from "./capability-grants.js";
import {
  SqliteSecretRefStore,
  type SecretGrantConstraintRecord,
  type SecretRefRecord,
} from "./credential-broker.js";
import type { SemanticOperationRegistry } from "./operations.js";
import type { WorkspaceCreationKind } from "./workspace-identities.js";
import {
  providerAccountSecretRefId,
  REFRESH_CREDENTIAL_OPERATION_ID,
  RUNTIME_CREDENTIAL_PURPOSE,
  USE_CREDENTIAL_OPERATION_ID,
} from "./credential-operations.js";

/**
 * Versioned compatibility authority for legacy model Actors. This is an
 * explicit migration policy, not a projection of everything in the Registry.
 * New Registry operations never enter imported Actor grants automatically.
 */
export const LEGACY_WORKSPACE_MODEL_ACTOR_OPERATION_IDS_V1 = Object.freeze([
  "actor.create",
  "actor.definition.draft.create",
  "actor.definition.draft.replace",
  "actor.definition.get",
  "actor.definition.publish",
  "actor.definition.rollback",
  "actor.inspect",
  "actor.list",
  "actor.reactivate",
  "actor.retire",
  "actor.runtime-binding.create",
  "actor.runtime-binding.get",
  "actor.runtime-binding.inspect",
  "actor.runtime-binding.replace",
  "approval.inspect",
  "approval.list",
  "approval.request",
  "artefact.create",
  "artefact.inspect",
  "artefact.search",
  "artefact.version.publish",
  "connector.inspect",
  REFRESH_CREDENTIAL_OPERATION_ID,
  "context.archive",
  "context.communication.emit",
  "context.create",
  "context.get",
  "context.inspect",
  "context.list",
  "context.participant.remove",
  "context.participant.set_access",
  "context.restore",
  "extension.inspect",
  "extension.list",
  "extension.package.get",
  "extension.schema.discover",
  "runtime-profile.create",
  "runtime-profile.draft.create",
  "runtime-profile.draft.replace",
  "runtime-profile.inspect",
  "runtime-profile.list",
  "runtime-profile.publish",
  "runtime-profile.reactivate",
  "runtime-profile.retire",
  "runtime-profile.revision.get",
  "runtime-profile.rollback",
  "scope.create",
  "scope.list",
  "scope.composition.draft.create",
  "scope.composition.draft.replace",
  "scope.composition.clone",
  "scope.composition.compare",
  "scope.composition.export",
  "scope.composition.impact.inspect",
  "scope.composition.import",
  "scope.composition.publish",
  "scope.composition.rollback",
  "scope.composition.simulate",
  "scope.composition.validate",
  "scope.execution.inspect",
  "scope.execution.pause",
  "scope.execution.redo",
  "scope.execution.resume",
  "scope.execution.start",
  "scope.execution.stop",
  "scope.node-execution.retry",
  "scope.node-output.publish",
  "scope.plan.inspect",
  "workspace.inspect",
  USE_CREDENTIAL_OPERATION_ID,
] as const);

export type WorkspaceConfigurationImportPolicy = Readonly<{
  policy_revision: string;
  actor_operation_authority: readonly Readonly<{
    source_actor_id: string;
    operation_ids: readonly string[];
  }>[];
  expires_at: string;
  issuer_id: string;
  import_principal_id: string;
}>;

export type WorkspaceConfigurationInventoryV1 = Readonly<{
  schema: "floe.workspace-configuration-inventory.v1";
  importer_version: "1";
  binding_id: string;
  config_hash: string;
  source: Readonly<{
    kind: "workspace_files";
    manifest_ref: ".floe/floe.yaml";
  }>;
  validation: Readonly<{
    ok: boolean;
    issues: readonly WorkspaceConfigurationValidationIssue[];
  }>;
  actors: readonly WorkspaceConfigurationActorInput[];
}>;

export type WorkspaceConfigurationValidationIssue = Readonly<{
  severity: "warning" | "error";
  code: string;
  source_ref: string | null;
}>;

export type WorkspaceConfigurationActorInput = Readonly<{
  source_actor_id: string;
  source: Readonly<{
    kind: "workspace_actor_file";
    path: string;
    source_fingerprint: string;
  }>;
  definition: Omit<ActorDefinitionContent, "capability_grant_ids">;
  runtime: Readonly<{
    label: string;
    backing_kind: RuntimeProfileContent["backing_kind"];
    adapter_id: string;
    configuration: Readonly<Record<string, unknown>>;
    required_capability_ids: readonly string[];
    checkpoint_policy: RuntimeProfileContent["checkpoint_policy"];
    resource_policy: Readonly<Record<string, unknown>>;
    credential_requirement: "none" | "required";
    required_configuration_keys: readonly string[];
    credential_reference: Readonly<{
      source_kind: "provider_account";
      provider_id: string;
      secret_kind: "runtime_authentication";
    }> | null;
  }>;
}>;

export type WorkspaceConfigurationImportedActor = Readonly<{
  source_actor_id: string;
  actor_id: string;
  actor_definition_revision_id: string;
  capability_grant_id: string | null;
  capability_grant_ids: readonly string[];
  runtime_profile_id: string;
  runtime_profile_revision_id: string;
  actor_runtime_binding_id: string;
  runtime_status: ActorRuntimeBindingRecord["status"];
  unresolved_reasons: readonly string[];
  secret_ref_ids: readonly string[];
}>;

export type WorkspaceConfigurationImportRefusal = Readonly<{
  code:
    | "workspace_configuration_invalid"
    | "workspace_configuration_conflict"
    | "workspace_configuration_policy_invalid"
    | "workspace_binding_mismatch";
  message: string;
  retryable: boolean;
}>;

export type WorkspaceConfigurationImportReceipt = Readonly<{
  import_receipt_id: string;
  workspace_id: string;
  binding_id: string;
  config_hash: string;
  inventory_digest: string;
  importer_version: "1";
  policy_revision: string;
  policy_digest: string;
  outcome: "applied" | "refused";
  imported_actors: readonly WorkspaceConfigurationImportedActor[];
  preserved_actor_ids: readonly string[];
  validation: WorkspaceConfigurationInventoryV1["validation"];
  refusal: WorkspaceConfigurationImportRefusal | null;
  created_at: string;
}>;

export type WorkspaceConfigurationImportResult = Readonly<{
  replayed: boolean;
  receipt: WorkspaceConfigurationImportReceipt;
}>;

export class WorkspaceConfigurationImportBoundaryError extends Error {
  readonly code = "workspace_binding_mismatch" as const;
  readonly retryable = false;

  constructor() {
    super("The authenticated Bridge does not own the exact current Workspace binding.");
    this.name = "WorkspaceConfigurationImportBoundaryError";
  }
}

export class WorkspaceConfigurationInventoryValidationError extends Error {
  readonly code = "workspace_configuration_inventory_invalid" as const;
  readonly retryable = false;

  constructor(readonly reason: string) {
    super(`Workspace configuration inventory is invalid: ${reason}`);
    this.name = "WorkspaceConfigurationInventoryValidationError";
  }
}

export class WorkspaceConfigurationApplyError extends Error {
  readonly code = "workspace_configuration_apply_failed" as const;
  readonly retryable = true;

  constructor() {
    super("The canonical Workspace configuration import was rolled back before it completed.");
    this.name = "WorkspaceConfigurationApplyError";
  }
}

export class WorkspaceConfigurationPolicyError extends Error {
  readonly code = "workspace_configuration_policy_invalid" as const;
  readonly retryable = false;

  constructor(readonly reason: string) {
    super(`Workspace configuration import policy is invalid: ${reason}`);
    this.name = "WorkspaceConfigurationPolicyError";
  }
}

export type WorkspaceConfigurationImportDependencies = Readonly<{
  db: DatabaseSync;
  actor_definitions: ActorDefinitionStore;
  runtime_profiles: RuntimeProfileStore;
  capability_grants: SqliteCapabilityGrantStore;
  secret_refs: SqliteSecretRefStore;
  local_host_id: string;
  /** Trusted installation/import policy. The authenticated request cannot supply it. */
  policy_for_inventory: (
    workspaceId: string,
    inventory: WorkspaceConfigurationInventoryV1,
  ) => WorkspaceConfigurationImportPolicy;
  /** Canonical Registry; this adapter owns the exact safe projection filter. */
  operation_registry: Pick<SemanticOperationRegistry, "listCurrentOperationIds">;
  /** Must verify authenticated Bridge identity and the exact current binding. */
  require_current_binding: (workspaceId: string, bindingId: string) => void;
  now?: () => string;
}>;

/** Product/deployment policy injection. Null retains the verified legacy import policy. */
export type WorkspaceConfigurationPolicyProvider = (input: Readonly<{
  workspace_id: string;
  creation_kind: WorkspaceCreationKind | null;
  init_authorized: boolean;
  inventory: WorkspaceConfigurationInventoryV1;
}>) => WorkspaceConfigurationImportPolicy | null;

type ImportResourceOwnership = Readonly<{
  actor_id: string;
  runtime_profile_id: string;
  last_actor_definition_revision_id: string;
  last_runtime_profile_revision_id: string;
  last_actor_runtime_binding_id: string;
}>;

/**
 * Installs import evidence only. Canonical configuration remains in the Actor,
 * Runtime Profile, Runtime Binding, CapabilityGrant, and SecretRef stores.
 */
export function applyWorkspaceConfigurationImportSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_configuration_import_policies (
      workspace_id TEXT NOT NULL,
      policy_revision TEXT NOT NULL,
      policy_digest TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, policy_revision)
    );

    CREATE TABLE IF NOT EXISTS workspace_configuration_import_receipts (
      import_receipt_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      inventory_digest TEXT NOT NULL,
      importer_version TEXT NOT NULL,
      policy_revision TEXT NOT NULL,
      policy_digest TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'refused')),
      imported_actors_json TEXT NOT NULL,
      preserved_actor_ids_json TEXT NOT NULL,
      validation_json TEXT NOT NULL,
      refusal_json TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(workspace_id, binding_id, inventory_digest, policy_digest)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_configuration_import_receipts
      ON workspace_configuration_import_receipts(workspace_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS workspace_configuration_import_resources (
      workspace_id TEXT NOT NULL,
      source_actor_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      runtime_profile_id TEXT NOT NULL,
      last_actor_definition_revision_id TEXT NOT NULL,
      last_runtime_profile_revision_id TEXT NOT NULL,
      last_actor_runtime_binding_id TEXT NOT NULL,
      first_import_receipt_id TEXT NOT NULL
        REFERENCES workspace_configuration_import_receipts(import_receipt_id),
      last_import_receipt_id TEXT NOT NULL
        REFERENCES workspace_configuration_import_receipts(import_receipt_id),
      PRIMARY KEY (workspace_id, source_actor_id),
      UNIQUE(actor_id),
      UNIQUE(runtime_profile_id)
    );
  `);
}

/**
 * Bounded compatibility adapter from existing Workspace files to canonical
 * records. It never retains the input snapshot and never reads secret values.
 */
export class WorkspaceConfigurationImportStore {
  private readonly now: () => string;

  constructor(private readonly dependencies: WorkspaceConfigurationImportDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    applyWorkspaceConfigurationImportSchema(dependencies.db);
  }

  import(
    workspaceIdValue: string,
    inventoryValue: WorkspaceConfigurationInventoryV1 | unknown,
  ): WorkspaceConfigurationImportResult {
    const workspaceId = requiredText(workspaceIdValue, "workspace_id");
    const inventory = normalizeInventory(inventoryValue);
    this.requireCurrentBinding(workspaceId, inventory.binding_id);

    const policy = normalizePolicy(this.dependencies.policy_for_inventory(workspaceId, inventory));
    const policyDigest = sha256(canonicalJson(policy));
    this.requireCompatiblePolicyRevision(workspaceId, policy.policy_revision, policyDigest);
    const inventoryDigest = sha256(canonicalJson(inventory));
    const receiptId = workspaceConfigurationImportReceiptId(
      workspaceId,
      inventory.binding_id,
      inventoryDigest,
      policyDigest,
    );
    const existing = this.getReceipt(workspaceId, receiptId);
    if (existing) return { replayed: true, receipt: existing };

    if (Date.parse(policy.expires_at) <= Date.parse(this.now())) {
      throw new WorkspaceConfigurationPolicyError("expiry must be in the future for a new import");
    }
    const currentOperationIds = new Set(this.dependencies.operation_registry.listCurrentOperationIds({
      interaction_mode: "unattended",
      boundary_kind: "workspace",
    }));
    const unknownOperationIds = policy.actor_operation_authority
      .flatMap((entry) => entry.operation_ids)
      .filter((operationId) => !currentOperationIds.has(operationId));
    if (unknownOperationIds.length > 0) {
      throw new WorkspaceConfigurationPolicyError(
        `import policy names unregistered Workspace operation '${unknownOperationIds[0]}'`,
      );
    }

    if (!inventory.validation.ok || inventory.validation.issues.some((issue) => issue.severity === "error")) {
      return {
        replayed: false,
        receipt: this.recordRefusal({
          receipt_id: receiptId,
          workspace_id: workspaceId,
          inventory,
          inventory_digest: inventoryDigest,
          policy_revision: policy.policy_revision,
          policy_digest: policyDigest,
          refusal: {
            code: "workspace_configuration_invalid",
            message: "The Workspace files did not pass validation, so no canonical records were changed.",
            retryable: false,
          },
        }),
      };
    }

    const preflight = this.preflight(workspaceId, inventory, policy);
    if (preflight) {
      return {
        replayed: false,
        receipt: this.recordRefusal({
          receipt_id: receiptId,
          workspace_id: workspaceId,
          inventory,
          inventory_digest: inventoryDigest,
          policy_revision: policy.policy_revision,
          policy_digest: policyDigest,
          refusal: preflight,
        }),
      };
    }

    let receipt!: WorkspaceConfigurationImportReceipt;
    try {
      inSavepoint(this.dependencies.db, () => {
        // Close the rebind race between transport authentication/preflight and
        // the canonical write transaction.
        this.requireCurrentBinding(workspaceId, inventory.binding_id);
        this.ensurePolicyRevision(workspaceId, policy.policy_revision, policyDigest);
        const importedActors: WorkspaceConfigurationImportedActor[] = [];
        const sourceActorIds = new Set(inventory.actors.map((actor) =>
          workspaceConfigurationActorId(workspaceId, actor.source_actor_id)));
        const preservedActorIds = this.dependencies.actor_definitions
          .listActors(workspaceId, { include_retired: true })
          .map((actor) => actor.actor_id)
          .filter((actorId) => !sourceActorIds.has(actorId))
          .sort((left, right) => left.localeCompare(right));

        for (const input of inventory.actors) {
          importedActors.push(this.applyActor(workspaceId, input, policy));
        }

        receipt = this.insertReceipt({
          import_receipt_id: receiptId,
          workspace_id: workspaceId,
          binding_id: inventory.binding_id,
          config_hash: inventory.config_hash,
          inventory_digest: inventoryDigest,
          importer_version: "1",
          policy_revision: policy.policy_revision,
          policy_digest: policyDigest,
          outcome: "applied",
          imported_actors: importedActors,
          preserved_actor_ids: preservedActorIds,
          validation: inventory.validation,
          refusal: null,
          created_at: this.now(),
        });

        for (const imported of importedActors) {
          this.dependencies.db.prepare(`
            INSERT INTO workspace_configuration_import_resources (
              workspace_id, source_actor_id, actor_id, runtime_profile_id,
              last_actor_definition_revision_id, last_runtime_profile_revision_id,
              last_actor_runtime_binding_id, first_import_receipt_id,
              last_import_receipt_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id, source_actor_id) DO UPDATE SET
              last_actor_definition_revision_id = excluded.last_actor_definition_revision_id,
              last_runtime_profile_revision_id = excluded.last_runtime_profile_revision_id,
              last_actor_runtime_binding_id = excluded.last_actor_runtime_binding_id,
              last_import_receipt_id = excluded.last_import_receipt_id
          `).run(
            workspaceId,
            imported.source_actor_id,
            imported.actor_id,
            imported.runtime_profile_id,
            imported.actor_definition_revision_id,
            imported.runtime_profile_revision_id,
            imported.actor_runtime_binding_id,
            receiptId,
            receiptId,
          );
        }
      });
    } catch (error) {
      if (error instanceof WorkspaceConfigurationImportBoundaryError) throw error;
      // A failed transaction has no stable semantic result to replay. Keep the
      // request retryable rather than persisting a refusal under its idempotency
      // identity and permanently blocking the same safe retry.
      throw new WorkspaceConfigurationApplyError();
    }
    return { replayed: false, receipt };
  }

  getReceipt(workspaceId: string, receiptId: string): WorkspaceConfigurationImportReceipt | null {
    const row = this.dependencies.db.prepare(`
      SELECT * FROM workspace_configuration_import_receipts
      WHERE workspace_id = ? AND import_receipt_id = ?
    `).get(requiredText(workspaceId, "workspace_id"), requiredText(receiptId, "import_receipt_id")) as any;
    return row ? receiptFromRow(row) : null;
  }

  listReceipts(workspaceId: string): WorkspaceConfigurationImportReceipt[] {
    return (this.dependencies.db.prepare(`
      SELECT * FROM workspace_configuration_import_receipts
      WHERE workspace_id = ? ORDER BY created_at DESC, import_receipt_id DESC
    `).all(requiredText(workspaceId, "workspace_id")) as any[]).map(receiptFromRow);
  }

  private requireCurrentBinding(workspaceId: string, bindingId: string): void {
    try {
      this.dependencies.require_current_binding(workspaceId, bindingId);
    } catch {
      // Boundary failures are not written under an unverified Workspace identity.
      throw new WorkspaceConfigurationImportBoundaryError();
    }
  }

  private requireCompatiblePolicyRevision(
    workspaceId: string,
    policyRevision: string,
    policyDigest: string,
  ): void {
    const row = this.dependencies.db.prepare(`
      SELECT policy_digest
      FROM workspace_configuration_import_policies
      WHERE workspace_id = ? AND policy_revision = ?
    `).get(workspaceId, policyRevision) as { policy_digest: string } | undefined;
    if (row && row.policy_digest !== policyDigest) {
      throw new WorkspaceConfigurationPolicyError(
        `revision '${policyRevision}' was already registered with different content`,
      );
    }
  }

  private ensurePolicyRevision(
    workspaceId: string,
    policyRevision: string,
    policyDigest: string,
  ): void {
    this.requireCompatiblePolicyRevision(workspaceId, policyRevision, policyDigest);
    this.dependencies.db.prepare(`
      INSERT INTO workspace_configuration_import_policies (
        workspace_id, policy_revision, policy_digest, registered_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id, policy_revision) DO NOTHING
    `).run(workspaceId, policyRevision, policyDigest, this.now());
  }

  private preflight(
    workspaceId: string,
    inventory: WorkspaceConfigurationInventoryV1,
    policy: WorkspaceConfigurationImportPolicy,
  ): WorkspaceConfigurationImportRefusal | null {
    for (const input of inventory.actors) {
      const actorId = workspaceConfigurationActorId(workspaceId, input.source_actor_id);
      const profileId = workspaceConfigurationRuntimeProfileId(actorId);
      const operationIds = actorOperationIds(policy, input.source_actor_id);
      const generalOperationIds = operationIds ? nonCredentialOperationIds(operationIds) : [];
      const credentialOperationIds = operationIds ? runtimeCredentialOperationIds(operationIds) : [];
      const grantId = generalOperationIds.length > 0
        ? workspaceConfigurationGrantId(workspaceId, actorId, policy, generalOperationIds)
        : null;
      const secretRefId = input.runtime.credential_reference
        ? providerAccountSecretRefId(this.dependencies.local_host_id, input.runtime.credential_reference.provider_id)
        : null;
      const secretRef = secretRefId ? this.dependencies.secret_refs.getSecretRef(secretRefId) : null;
      const secretRefIds = secretRefId ? [secretRefId] : [];
      const credentialGrantId = secretRef && credentialOperationIds.length > 0
        ? workspaceConfigurationCredentialGrantId(
            workspaceId,
            actorId,
            profileId,
            secretRefIds[0]!,
            policy,
            credentialOperationIds,
          )
        : null;
      try {
        validateActorDefinition(actorDefinition(input, [grantId, credentialGrantId].filter(isText)));
        validateRuntimeProfile(runtimeProfile(input, secretRefIds));
      } catch {
        return invalidConfiguration("The Workspace Actor or Runtime configuration is not valid canonical input.");
      }
      const ownership = this.getOwnership(workspaceId, input.source_actor_id);
      if (ownership && (
        ownership.actor_id !== actorId
        || ownership.runtime_profile_id !== profileId
      )) {
        return conflict("The existing Workspace import ownership record identifies different canonical resources.");
      }
      const actor = this.dependencies.actor_definitions.getActor(actorId);
      const currentBinding = this.dependencies.runtime_profiles.getCurrentActorBinding(actorId);
      const profile = this.dependencies.runtime_profiles.getProfile(profileId);
      if (ownership && (
        actor?.current_definition_revision_id !== ownership.last_actor_definition_revision_id
        || profile?.current_revision_id !== ownership.last_runtime_profile_revision_id
        || currentBinding?.actor_runtime_binding_id !== ownership.last_actor_runtime_binding_id
      )) {
        return conflict("Canonical Actor or Runtime state changed outside the Workspace import boundary.");
      }
      if (actor && actor.workspace_id !== workspaceId) {
        return conflict("A canonical Actor with the imported identity belongs to another Workspace.");
      }
      if (actor?.status === "retired") {
        return conflict("A retired canonical Actor cannot be silently reactivated by Workspace import.");
      }
      if (ownership && actor?.current_definition_revision_id) {
        const previous = this.dependencies.actor_definitions.requireRevision(actor.current_definition_revision_id);
        if (previous.content.capability_grant_ids.some(id => this.dependencies.capability_grants.getGrant(id)?.revoked_at)) {
          return conflict("Workspace import cannot replace explicitly revoked Actor authority with a renewed policy grant.");
        }
      }
      if (actor && !ownership) {
        const desired = actorDefinition(input, [grantId, credentialGrantId].filter(isText));
        const current = actor.current_definition_revision_id
          ? this.dependencies.actor_definitions.requireRevision(actor.current_definition_revision_id)
          : null;
        if (!current || current.semantic_digest !== actorDefinitionDigest(desired)) {
          return conflict("Workspace import would replace an independently managed canonical Actor.");
        }
      }

      if (profile && (profile.owner.kind !== "workspace" || profile.owner.id !== workspaceId)) {
        return conflict("A canonical Runtime Profile with the imported identity belongs to another owner.");
      }
      if (profile?.status === "retired") {
        return conflict("A retired canonical Runtime Profile cannot be silently reactivated by Workspace import.");
      }
      if (profile && !ownership) {
        const desired = runtimeProfile(input, secretRefIds);
        const current = profile.current_revision_id
          ? this.dependencies.runtime_profiles.requireRevision(profile.current_revision_id)
          : null;
        if (!current || current.semantic_digest !== runtimeProfileDigest(desired)) {
          return conflict("Workspace import would replace an independently managed canonical Runtime Profile.");
        }
      }

      if (grantId) {
        const grant = this.dependencies.capability_grants.getGrant(grantId);
        if (grant && !sameGrant(grant, workspaceId, actorId, policy, generalOperationIds)) {
          return conflict("The deterministic migration CapabilityGrant identifies different authority.");
        }
        if (grant?.revoked_at) {
          return conflict("A revoked migration CapabilityGrant cannot be silently revived.");
        }
      }

      if (input.runtime.credential_reference) {
        const secretRefId = providerAccountSecretRefId(
          this.dependencies.local_host_id,
          input.runtime.credential_reference.provider_id,
        );
        const secretRef = this.dependencies.secret_refs.getSecretRef(secretRefId);
        if (secretRef && (
          secretRef.owner.kind !== "host"
          || secretRef.owner.host_id !== this.dependencies.local_host_id
          || secretRef.resource.kind !== "provider_account"
          || secretRef.resource.id !== input.runtime.credential_reference.provider_id
          || secretRef.secret_kind !== input.runtime.credential_reference.secret_kind
        )) {
          return conflict("The deterministic SecretRef identifies different credential metadata.");
        }
        if (credentialGrantId) {
          const credentialGrant = this.dependencies.capability_grants.getGrant(credentialGrantId);
          if (credentialGrant && (!secretRef || !sameCredentialGrant(
            credentialGrant,
            workspaceId,
            actorId,
            secretRef,
            policy,
            credentialOperationIds,
          ))) {
            return conflict("The deterministic credential CapabilityGrant identifies different authority.");
          }
          if (credentialGrant?.revoked_at) {
            return conflict("A revoked credential CapabilityGrant cannot be silently revived.");
          }
          const constraint = this.dependencies.secret_refs.getGrantConstraint(credentialGrantId);
          if (constraint && !sameCredentialConstraint(constraint, workspaceId, secretRefId)) {
            return conflict("The deterministic credential CapabilityGrant identifies a different purpose constraint.");
          }
        }
      }

      if (currentBinding?.status === "disabled") {
        return conflict("A disabled Actor Runtime Binding cannot be silently re-enabled by Workspace import.");
      }
    }
    return null;
  }

  private applyActor(
    workspaceId: string,
    input: WorkspaceConfigurationActorInput,
    policy: WorkspaceConfigurationImportPolicy,
  ): WorkspaceConfigurationImportedActor {
    const actorId = workspaceConfigurationActorId(workspaceId, input.source_actor_id);
    const profileId = workspaceConfigurationRuntimeProfileId(actorId);
    const operationIds = actorOperationIds(policy, input.source_actor_id);
    const secretRefId = input.runtime.credential_reference
      ? providerAccountSecretRefId(this.dependencies.local_host_id, input.runtime.credential_reference.provider_id)
      : null;
    const secretRef = secretRefId ? this.dependencies.secret_refs.getSecretRef(secretRefId) : null;
    const secretRefs = secretRef ? [secretRef] : [];
    const secretRefIds = secretRefId ? [secretRefId] : [];
    const generalOperationIds = operationIds ? nonCredentialOperationIds(operationIds) : [];
    const credentialOperationIds = operationIds ? runtimeCredentialOperationIds(operationIds) : [];
    const grant = generalOperationIds.length > 0
      ? this.ensureGrant(workspaceId, actorId, policy, generalOperationIds)
      : null;
    const credentialGrant = secretRefs.length > 0 && credentialOperationIds.length > 0
      ? this.ensureCredentialGrant(
          workspaceId,
          actorId,
          profileId,
          secretRefs[0]!,
          policy,
          credentialOperationIds,
        )
      : null;
    const capabilityGrantIds = [grant?.grant_id, credentialGrant?.grant_id].filter(isText);
    const actorRevision = this.ensureActorDefinition(
      workspaceId,
      actorId,
      input,
      capabilityGrantIds,
      policy.import_principal_id,
    );
    const profileRevision = this.ensureRuntimeProfile(workspaceId, profileId, input, secretRefIds, policy.import_principal_id);
    const status = runtimeBindingStatus(
      input,
      secretRefs,
      operationIds !== null,
      input.runtime.credential_requirement !== "required" || credentialGrant !== null,
    );
    const currentBinding = this.dependencies.runtime_profiles.getCurrentActorBinding(actorId);
    const endpointId = actorId;
    const binding = currentBinding
      && currentBinding.runtime_profile_revision_id === profileRevision.runtime_profile_revision_id
      && currentBinding.endpoint_id === endpointId
      && currentBinding.status === status.status
      && sameStrings(currentBinding.unresolved_reasons, status.reasons)
      ? currentBinding
      : this.dependencies.runtime_profiles.bindActor({
          actor_id: actorId,
          runtime_profile_revision_id: profileRevision.runtime_profile_revision_id,
          endpoint_id: endpointId,
          status: status.status,
          unresolved_reasons: status.reasons,
          expected_current_binding_id: currentBinding?.actor_runtime_binding_id ?? null,
          created_by_principal_id: policy.import_principal_id,
        });

    return {
      source_actor_id: input.source_actor_id,
      actor_id: actorId,
      actor_definition_revision_id: actorRevision.actor_definition_revision_id,
      capability_grant_id: grant?.grant_id ?? null,
      capability_grant_ids: capabilityGrantIds,
      runtime_profile_id: profileId,
      runtime_profile_revision_id: profileRevision.runtime_profile_revision_id,
      actor_runtime_binding_id: binding.actor_runtime_binding_id,
      runtime_status: binding.status,
      unresolved_reasons: binding.unresolved_reasons,
      secret_ref_ids: secretRefIds,
    };
  }

  private ensureGrant(
    workspaceId: string,
    actorId: string,
    policy: WorkspaceConfigurationImportPolicy,
    operationIds: readonly string[],
  ): CapabilityGrantRecord {
    const grantId = workspaceConfigurationGrantId(workspaceId, actorId, policy, operationIds);
    const existing = this.dependencies.capability_grants.getGrant(grantId);
    if (existing) return existing;
    return this.dependencies.capability_grants.issueGrant({
      grant_id: grantId,
      principal_id: actorId,
      boundary: { kind: "workspace", workspace_id: workspaceId },
      operation_ids: operationIds,
      expires_at: policy.expires_at,
      issuer_id: policy.issuer_id,
      evidence: [{
        kind: "workspace_configuration_import_policy",
        ref: policy.policy_revision,
      }],
    });
  }

  private ensureCredentialGrant(
    workspaceId: string,
    actorId: string,
    profileId: string,
    secretRef: SecretRefRecord,
    policy: WorkspaceConfigurationImportPolicy,
    operationIds: readonly string[],
  ): CapabilityGrantRecord {
    const grantId = workspaceConfigurationCredentialGrantId(
      workspaceId,
      actorId,
      profileId,
      secretRef.secret_ref_id,
      policy,
      operationIds,
    );
    let grant = this.dependencies.capability_grants.getGrant(grantId);
    if (!grant) {
      grant = this.dependencies.capability_grants.issueGrant({
        grant_id: grantId,
        principal_id: actorId,
        boundary: { kind: "workspace", workspace_id: workspaceId },
        operation_ids: operationIds,
        targets: [
          { kind: "secret_ref", id: secretRef.secret_ref_id },
          { kind: secretRef.resource.kind, id: secretRef.resource.id },
        ],
        expires_at: policy.expires_at,
        issuer_id: policy.issuer_id,
        evidence: [{
          kind: "workspace_configuration_import_policy",
          ref: policy.policy_revision,
        }],
      });
    }
    const constraint = this.dependencies.secret_refs.getGrantConstraint(grantId);
    if (!constraint) {
      this.dependencies.secret_refs.attachGrantConstraint({
        grant_id: grantId,
        secret_ref_id: secretRef.secret_ref_id,
        authority_boundary: { kind: "workspace", workspace_id: workspaceId },
        purposes: [RUNTIME_CREDENTIAL_PURPOSE],
      }, this.dependencies.capability_grants);
    }
    return grant;
  }

  private ensureActorDefinition(
    workspaceId: string,
    actorId: string,
    input: WorkspaceConfigurationActorInput,
    grantIds: readonly string[],
    principalId: string,
  ): ActorDefinitionRevision {
    const definition = actorDefinition(input, grantIds);
    const actor = this.dependencies.actor_definitions.getActor(actorId);
    if (!actor) {
      const created = this.dependencies.actor_definitions.createActor({
        actor_id: actorId,
        workspace_id: workspaceId,
        created_by_principal_id: principalId,
        definition,
      });
      return this.dependencies.actor_definitions.publishDraft({
        actor_definition_revision_id: created.draft.actor_definition_revision_id,
        expected_current_revision_id: null,
        changed_by_principal_id: principalId,
      });
    }
    const current = actor.current_definition_revision_id
      ? this.dependencies.actor_definitions.requireRevision(actor.current_definition_revision_id)
      : null;
    if (current?.semantic_digest === actorDefinitionDigest(definition)) return current;
    const draft = this.dependencies.actor_definitions.createDraft({
      actor_id: actorId,
      based_on_revision_id: actor.current_definition_revision_id,
      created_by_principal_id: principalId,
      definition,
    });
    return this.dependencies.actor_definitions.publishDraft({
      actor_definition_revision_id: draft.actor_definition_revision_id,
      expected_current_revision_id: actor.current_definition_revision_id,
      changed_by_principal_id: principalId,
    });
  }

  private ensureRuntimeProfile(
    workspaceId: string,
    profileId: string,
    input: WorkspaceConfigurationActorInput,
    secretRefIds: readonly string[],
    principalId: string,
  ): RuntimeProfileRevision {
    const content = runtimeProfile(input, secretRefIds);
    const profile = this.dependencies.runtime_profiles.getProfile(profileId);
    if (!profile) {
      const created = this.dependencies.runtime_profiles.createProfile({
        runtime_profile_id: profileId,
        owner: { kind: "workspace", id: workspaceId },
        created_by_principal_id: principalId,
        content,
      });
      return this.dependencies.runtime_profiles.publishDraft({
        runtime_profile_revision_id: created.draft.runtime_profile_revision_id,
        expected_current_revision_id: null,
        changed_by_principal_id: principalId,
      });
    }
    const current = profile.current_revision_id
      ? this.dependencies.runtime_profiles.requireRevision(profile.current_revision_id)
      : null;
    if (current?.semantic_digest === runtimeProfileDigest(content)) return current;
    const draft = this.dependencies.runtime_profiles.createDraft({
      runtime_profile_id: profileId,
      based_on_revision_id: profile.current_revision_id,
      created_by_principal_id: principalId,
      content,
    });
    return this.dependencies.runtime_profiles.publishDraft({
      runtime_profile_revision_id: draft.runtime_profile_revision_id,
      expected_current_revision_id: profile.current_revision_id,
      changed_by_principal_id: principalId,
    });
  }

  private getOwnership(workspaceId: string, sourceActorId: string): ImportResourceOwnership | null {
    const row = this.dependencies.db.prepare(`
      SELECT actor_id, runtime_profile_id
           , last_actor_definition_revision_id, last_runtime_profile_revision_id,
             last_actor_runtime_binding_id
      FROM workspace_configuration_import_resources
      WHERE workspace_id = ? AND source_actor_id = ?
    `).get(workspaceId, sourceActorId) as ImportResourceOwnership | undefined;
    return row ?? null;
  }

  private recordRefusal(input: Readonly<{
    receipt_id: string;
    workspace_id: string;
    inventory: WorkspaceConfigurationInventoryV1;
    inventory_digest: string;
    policy_revision: string;
    policy_digest: string;
    refusal: WorkspaceConfigurationImportRefusal;
  }>): WorkspaceConfigurationImportReceipt {
    return inSavepoint(this.dependencies.db, () => {
      this.requireCurrentBinding(input.workspace_id, input.inventory.binding_id);
      this.ensurePolicyRevision(input.workspace_id, input.policy_revision, input.policy_digest);
      return this.insertReceipt({
        import_receipt_id: input.receipt_id,
        workspace_id: input.workspace_id,
        binding_id: input.inventory.binding_id,
        config_hash: input.inventory.config_hash,
        inventory_digest: input.inventory_digest,
        importer_version: "1",
        policy_revision: input.policy_revision,
        policy_digest: input.policy_digest,
        outcome: "refused",
        imported_actors: [],
        preserved_actor_ids: this.dependencies.actor_definitions
          .listActors(input.workspace_id, { include_retired: true })
          .map((actor) => actor.actor_id)
          .sort((left, right) => left.localeCompare(right)),
        validation: input.inventory.validation,
        refusal: input.refusal,
        created_at: this.now(),
      });
    });
  }

  private insertReceipt(receipt: WorkspaceConfigurationImportReceipt): WorkspaceConfigurationImportReceipt {
    this.dependencies.db.prepare(`
      INSERT INTO workspace_configuration_import_receipts (
        import_receipt_id, workspace_id, binding_id, config_hash,
        inventory_digest, importer_version, policy_revision, policy_digest, outcome,
        imported_actors_json, preserved_actor_ids_json, validation_json,
        refusal_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.import_receipt_id,
      receipt.workspace_id,
      receipt.binding_id,
      receipt.config_hash,
      receipt.inventory_digest,
      receipt.importer_version,
      receipt.policy_revision,
      receipt.policy_digest,
      receipt.outcome,
      JSON.stringify(receipt.imported_actors),
      JSON.stringify(receipt.preserved_actor_ids),
      JSON.stringify(receipt.validation),
      receipt.refusal ? JSON.stringify(receipt.refusal) : null,
      receipt.created_at,
    );
    return this.getReceipt(receipt.workspace_id, receipt.import_receipt_id)!;
  }
}

export function workspaceConfigurationActorId(workspaceId: string, sourceActorId: string): string {
  return `actor:${requiredText(workspaceId, "workspace_id")}:${requiredText(sourceActorId, "source_actor_id")}`;
}

export function workspaceConfigurationRuntimeProfileId(actorId: string): string {
  return `runtime-profile:${requiredText(actorId, "actor_id")}`;
}

export function workspaceConfigurationGrantId(
  workspaceId: string,
  actorId: string,
  policy: WorkspaceConfigurationImportPolicy,
  operationIds: readonly string[],
): string {
  return `capgrant_workspace_import_${digest(canonicalJson({
    workspace_id: workspaceId,
    actor_id: actorId,
    policy_revision: policy.policy_revision,
    operation_ids: normalizeTextSet(operationIds, "operation_id", true),
    expires_at: policy.expires_at,
    issuer_id: policy.issuer_id,
  })).slice(0, 32)}`;
}

export function workspaceConfigurationCredentialGrantId(
  workspaceId: string,
  actorId: string,
  runtimeProfileId: string,
  secretRefId: string,
  policy: WorkspaceConfigurationImportPolicy,
  operationIds: readonly string[],
): string {
  return `capgrant_workspace_credential_${digest(canonicalJson({
    workspace_id: workspaceId,
    actor_id: actorId,
    runtime_profile_id: runtimeProfileId,
    secret_ref_id: secretRefId,
    policy_revision: policy.policy_revision,
    operation_ids: normalizeTextSet(operationIds, "operation_id", true),
    purpose: RUNTIME_CREDENTIAL_PURPOSE,
    expires_at: policy.expires_at,
    issuer_id: policy.issuer_id,
  })).slice(0, 32)}`;
}

export function workspaceConfigurationImportReceiptId(
  workspaceId: string,
  bindingId: string,
  inventoryDigest: string,
  policyDigest: string,
): string {
  return `workspace_config_import_${digest(`${workspaceId}\0${bindingId}\0${inventoryDigest}\0${policyDigest}`).slice(0, 32)}`;
}

function actorDefinition(input: WorkspaceConfigurationActorInput, grantIds: readonly string[]): ActorDefinitionContent {
  return {
    ...input.definition,
    capability_grant_ids: [...grantIds].sort((left, right) => left.localeCompare(right)),
  };
}

function runtimeProfile(
  input: WorkspaceConfigurationActorInput,
  secretRefIds: readonly string[],
): RuntimeProfileContent {
  return {
    label: input.runtime.label,
    backing_kind: input.runtime.backing_kind,
    adapter_id: input.runtime.adapter_id,
    configuration: input.runtime.configuration,
    secret_ref_ids: [...secretRefIds].sort((left, right) => left.localeCompare(right)),
    required_capability_ids: input.runtime.required_capability_ids,
    checkpoint_policy: input.runtime.checkpoint_policy,
    resource_policy: input.runtime.resource_policy,
  };
}

function runtimeBindingStatus(
  input: WorkspaceConfigurationActorInput,
  secretRefs: readonly SecretRefRecord[],
  hasExplicitOperationAuthority: boolean,
  hasCredentialAuthority: boolean,
): Readonly<{ status: "resolved" | "unresolved"; reasons: readonly string[] }> {
  const reasons: string[] = [];
  if (!hasExplicitOperationAuthority) reasons.push("operation_authority_unmapped");
  if (input.runtime.credential_requirement === "required") {
    if (!input.runtime.credential_reference) reasons.push("runtime_credential_reference_missing");
    else if (secretRefs.every((ref) => ref.resolution !== "resolved")) reasons.push("runtime_credential_unresolved");
    else if (!hasCredentialAuthority) reasons.push("runtime_credential_authority_unresolved");
  }
  for (const key of input.runtime.required_configuration_keys) {
    const value = input.runtime.configuration[key];
    if (value === undefined || value === null || value === "") {
      reasons.push(`runtime_configuration_missing:${key}`);
    }
  }
  const normalized = [...new Set(reasons)].sort((left, right) => left.localeCompare(right));
  return normalized.length > 0
    ? { status: "unresolved", reasons: normalized }
    : { status: "resolved", reasons: [] };
}

function normalizePolicy(value: WorkspaceConfigurationImportPolicy): WorkspaceConfigurationImportPolicy {
  const expiresAt = requiredText(value.expires_at, "policy expires_at");
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new WorkspaceConfigurationPolicyError("expiry must be a valid timestamp");
  }
  return {
    policy_revision: requiredText(value.policy_revision, "policy_revision"),
    actor_operation_authority: normalizeActorOperationAuthority(value.actor_operation_authority),
    expires_at: expiresAt,
    issuer_id: requiredText(value.issuer_id, "issuer_id"),
    import_principal_id: requiredText(value.import_principal_id, "import_principal_id"),
  };
}

function normalizeActorOperationAuthority(
  value: unknown,
): WorkspaceConfigurationImportPolicy["actor_operation_authority"] {
  if (!Array.isArray(value)) {
    throw new WorkspaceConfigurationInventoryValidationError(
      "actor_operation_authority must be an explicit per-Actor list",
    );
  }
  const entries = value.map((item, index) => {
    const entry = exactObject(
      item,
      ["source_actor_id", "operation_ids"],
      `actor_operation_authority[${index}]`,
    );
    if (!Array.isArray(entry.operation_ids)) {
      throw new WorkspaceConfigurationInventoryValidationError(
        `actor_operation_authority[${index}].operation_ids must be an array`,
      );
    }
    return {
      source_actor_id: requiredText(
        entry.source_actor_id,
        `actor_operation_authority[${index}].source_actor_id`,
      ),
      operation_ids: normalizeUnknownTextSet(
        entry.operation_ids,
        `actor_operation_authority[${index}].operation_id`,
      ),
    };
  }).sort((left, right) => left.source_actor_id.localeCompare(right.source_actor_id));
  unique(entries.map((entry) => entry.source_actor_id), "actor operation-authority source_actor_id");
  return entries;
}

function actorOperationIds(
  policy: WorkspaceConfigurationImportPolicy,
  sourceActorId: string,
): readonly string[] | null {
  return policy.actor_operation_authority
    .find((entry) => entry.source_actor_id === sourceActorId)
    ?.operation_ids ?? null;
}

function runtimeCredentialOperationIds(operationIds: readonly string[]): readonly string[] {
  return operationIds.filter((operationId) =>
    operationId === USE_CREDENTIAL_OPERATION_ID || operationId === REFRESH_CREDENTIAL_OPERATION_ID);
}

function nonCredentialOperationIds(operationIds: readonly string[]): readonly string[] {
  return operationIds.filter((operationId) =>
    operationId !== USE_CREDENTIAL_OPERATION_ID && operationId !== REFRESH_CREDENTIAL_OPERATION_ID);
}

function isText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function normalizeInventory(value: unknown): WorkspaceConfigurationInventoryV1 {
  const document = exactObject(value, [
    "schema", "importer_version", "binding_id", "config_hash", "source", "validation", "actors",
  ], "document");
  if (document.schema !== "floe.workspace-configuration-inventory.v1") {
    throw new WorkspaceConfigurationInventoryValidationError("schema is unsupported");
  }
  if (document.importer_version !== "1") {
    throw new WorkspaceConfigurationInventoryValidationError("importer_version is unsupported");
  }
  const configHash = digestText(document.config_hash, "config_hash");
  const source = exactObject(document.source, ["kind", "manifest_ref"], "source");
  if (source.kind !== "workspace_files" || source.manifest_ref !== ".floe/floe.yaml") {
    throw new WorkspaceConfigurationInventoryValidationError("source must identify .floe/floe.yaml");
  }
  const validationValue = exactObject(document.validation, ["ok", "issues"], "validation");
  if (typeof validationValue.ok !== "boolean" || !Array.isArray(validationValue.issues)) {
    throw new WorkspaceConfigurationInventoryValidationError("validation is malformed");
  }
  const issues = validationValue.issues.map((issue, index) => normalizeIssue(issue, index));
  if (!Array.isArray(document.actors)) {
    throw new WorkspaceConfigurationInventoryValidationError("actors must be an array");
  }
  const actors = document.actors
    .map((actor, index) => normalizeActor(actor, index))
    .sort((left, right) => left.source_actor_id.localeCompare(right.source_actor_id));
  unique(actors.map((actor) => actor.source_actor_id), "source_actor_id");
  return {
    schema: "floe.workspace-configuration-inventory.v1",
    importer_version: "1",
    binding_id: requiredText(document.binding_id, "binding_id"),
    config_hash: configHash,
    source: { kind: "workspace_files", manifest_ref: ".floe/floe.yaml" },
    validation: {
      ok: validationValue.ok,
      issues: issues.sort((left, right) =>
        left.severity.localeCompare(right.severity)
        || left.code.localeCompare(right.code)
        || (left.source_ref ?? "").localeCompare(right.source_ref ?? "")),
    },
    actors,
  };
}

function normalizeIssue(value: unknown, index: number): WorkspaceConfigurationValidationIssue {
  const issue = exactObject(value, ["severity", "code", "source_ref"], `validation.issues[${index}]`);
  if (issue.severity !== "warning" && issue.severity !== "error") {
    throw new WorkspaceConfigurationInventoryValidationError(`validation.issues[${index}].severity is invalid`);
  }
  return {
    severity: issue.severity,
    code: requiredText(issue.code, `validation.issues[${index}].code`),
    source_ref: issue.source_ref == null ? null : safeRelativePath(issue.source_ref, `validation.issues[${index}].source_ref`),
  };
}

function normalizeActor(value: unknown, index: number): WorkspaceConfigurationActorInput {
  const path = `actors[${index}]`;
  const actor = exactObject(value, ["source_actor_id", "source", "definition", "runtime"], path);
  const source = exactObject(actor.source, ["kind", "path", "source_fingerprint"], `${path}.source`);
  if (source.kind !== "workspace_actor_file") {
    throw new WorkspaceConfigurationInventoryValidationError(`${path}.source.kind is invalid`);
  }
  const definition = exactObject(actor.definition, [
    "label", "charter", "responsibilities", "instructions", "knowledge_refs", "policy_refs", "escalation_rules",
  ], `${path}.definition`);
  const runtime = exactObject(actor.runtime, [
    "label", "backing_kind", "adapter_id", "configuration", "required_capability_ids",
    "checkpoint_policy", "resource_policy", "credential_requirement",
    "required_configuration_keys", "credential_reference",
  ], `${path}.runtime`);
  const policyRefs = exactObject(definition.policy_refs, ["budget", "trust", "approval"], `${path}.definition.policy_refs`);
  if (!Array.isArray(definition.responsibilities)
    || !Array.isArray(definition.knowledge_refs)
    || !Array.isArray(definition.escalation_rules)) {
    throw new WorkspaceConfigurationInventoryValidationError(`${path}.definition lists are malformed`);
  }
  if (!Array.isArray(runtime.required_capability_ids) || !Array.isArray(runtime.required_configuration_keys)) {
    throw new WorkspaceConfigurationInventoryValidationError(`${path}.runtime requirement lists are malformed`);
  }
  const checkpoint = exactObject(runtime.checkpoint_policy, ["mode", "schema_ref"], `${path}.runtime.checkpoint_policy`);
  if (!(["none", "provider_neutral", "required"] as unknown[]).includes(checkpoint.mode)) {
    throw new WorkspaceConfigurationInventoryValidationError(`${path}.runtime.checkpoint_policy.mode is invalid`);
  }
  if (!(["human", "model", "service", "team"] as unknown[]).includes(runtime.backing_kind)) {
    throw new WorkspaceConfigurationInventoryValidationError(`${path}.runtime.backing_kind is invalid`);
  }
  if (runtime.credential_requirement !== "none" && runtime.credential_requirement !== "required") {
    throw new WorkspaceConfigurationInventoryValidationError(`${path}.runtime.credential_requirement is invalid`);
  }
  const configuration = safeJsonObject(runtime.configuration, `${path}.runtime.configuration`);
  const resourcePolicy = safeJsonObject(runtime.resource_policy, `${path}.runtime.resource_policy`);
  const credentialReference = runtime.credential_reference == null
    ? null
    : normalizeCredentialReference(runtime.credential_reference, `${path}.runtime.credential_reference`);
  const normalized: WorkspaceConfigurationActorInput = {
    source_actor_id: requiredText(actor.source_actor_id, `${path}.source_actor_id`),
    source: {
      kind: "workspace_actor_file",
      path: safeRelativePath(source.path, `${path}.source.path`),
      source_fingerprint: digestText(source.source_fingerprint, `${path}.source.source_fingerprint`),
    },
    definition: {
      label: requiredText(definition.label, `${path}.definition.label`),
      charter: requiredText(definition.charter, `${path}.definition.charter`),
      responsibilities: definition.responsibilities.map((item, itemIndex) => {
        const responsibility = exactObject(item, ["responsibility_id", "title", "description"], `${path}.definition.responsibilities[${itemIndex}]`);
        return {
          responsibility_id: requiredText(responsibility.responsibility_id, "responsibility_id"),
          title: requiredText(responsibility.title, "responsibility title"),
          description: requiredText(responsibility.description, "responsibility description"),
        };
      }),
      instructions: requiredText(definition.instructions, `${path}.definition.instructions`),
      knowledge_refs: definition.knowledge_refs.map((item, itemIndex) => normalizeRef(item, `${path}.definition.knowledge_refs[${itemIndex}]`)),
      policy_refs: {
        budget: policyRefs.budget == null ? null : normalizeRef(policyRefs.budget, `${path}.definition.policy_refs.budget`),
        trust: policyRefs.trust == null ? null : normalizeRef(policyRefs.trust, `${path}.definition.policy_refs.trust`),
        approval: policyRefs.approval == null ? null : normalizeRef(policyRefs.approval, `${path}.definition.policy_refs.approval`),
      },
      escalation_rules: definition.escalation_rules.map((item, itemIndex) => {
        const rule = exactObject(item, ["rule_id", "when", "action", "target_actor_id"], `${path}.definition.escalation_rules[${itemIndex}]`);
        if (!(["decline", "delegate", "escalate", "signal_unowned"] as unknown[]).includes(rule.action)) {
          throw new WorkspaceConfigurationInventoryValidationError(`${path}.definition.escalation_rules[${itemIndex}].action is invalid`);
        }
        return {
          rule_id: requiredText(rule.rule_id, "escalation rule_id"),
          when: requiredText(rule.when, "escalation condition"),
          action: rule.action as "decline" | "delegate" | "escalate" | "signal_unowned",
          ...(rule.target_actor_id == null ? {} : { target_actor_id: requiredText(rule.target_actor_id, "target_actor_id") }),
        };
      }),
    },
    runtime: {
      label: requiredText(runtime.label, `${path}.runtime.label`),
      backing_kind: runtime.backing_kind as RuntimeProfileContent["backing_kind"],
      adapter_id: requiredText(runtime.adapter_id, `${path}.runtime.adapter_id`),
      configuration,
      required_capability_ids: normalizeUnknownTextSet(runtime.required_capability_ids, "required capability id"),
      checkpoint_policy: {
        mode: checkpoint.mode as RuntimeProfileContent["checkpoint_policy"]["mode"],
        schema_ref: checkpoint.schema_ref == null ? null : requiredText(checkpoint.schema_ref, "checkpoint schema_ref"),
      },
      resource_policy: resourcePolicy,
      credential_requirement: runtime.credential_requirement as "none" | "required",
      required_configuration_keys: normalizeUnknownTextSet(runtime.required_configuration_keys, "required configuration key"),
      credential_reference: credentialReference,
    },
  };
  return normalized;
}

function normalizeCredentialReference(value: unknown, path: string): NonNullable<WorkspaceConfigurationActorInput["runtime"]["credential_reference"]> {
  const reference = exactObject(value, ["source_kind", "provider_id", "secret_kind"], path);
  if (reference.source_kind !== "provider_account" || reference.secret_kind !== "runtime_authentication") {
    throw new WorkspaceConfigurationInventoryValidationError(`${path} kind is invalid`);
  }
  return {
    source_kind: "provider_account",
    provider_id: requiredText(reference.provider_id, `${path}.provider_id`),
    secret_kind: "runtime_authentication",
  };
}

function normalizeRef(value: unknown, path: string): { kind: string; id: string; revision: string | null } {
  const ref = exactObject(value, ["kind", "id", "revision"], path);
  return {
    kind: requiredText(ref.kind, `${path}.kind`),
    id: requiredText(ref.id, `${path}.id`),
    revision: ref.revision == null ? null : requiredText(ref.revision, `${path}.revision`),
  };
}

function exactObject(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceConfigurationInventoryValidationError(`${path} must be an object`);
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set(keys);
  const unexpected = Object.keys(object).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new WorkspaceConfigurationInventoryValidationError(`${path} contains unsupported field '${unexpected[0]}'`);
  }
  return object;
}

function safeJsonObject(value: unknown, path: string): Record<string, unknown> {
  const object = exactJsonObject(value, path);
  rejectSecretMaterial(object, path);
  return object;
}

function exactJsonObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceConfigurationInventoryValidationError(`${path} must be a JSON object`);
  }
  assertJson(value, path);
  return value as Record<string, unknown>;
}

function assertJson(value: unknown, path: string): void {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJson(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) throw new WorkspaceConfigurationInventoryValidationError(`${path}.${key} is undefined`);
      assertJson(item, `${path}.${key}`);
    }
    return;
  }
  throw new WorkspaceConfigurationInventoryValidationError(`${path} must contain JSON data only`);
}

function rejectSecretMaterial(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretMaterial(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token|authorization|client[_-]?secret|private[_-]?key|password|secret|credential)/i.test(key)) {
      throw new WorkspaceConfigurationInventoryValidationError(`${path}.${key} must be represented by a SecretRef`);
    }
    rejectSecretMaterial(item, `${path}.${key}`);
  }
}

function normalizeUnknownTextSet(values: unknown[], label: string): string[] {
  return normalizeTextSet(values.map((value) => requiredText(value, label)), label, false);
}

function normalizeTextSet(values: readonly string[], label: string, required: boolean): string[] {
  if (required && values.length === 0) {
    throw new WorkspaceConfigurationInventoryValidationError(`${label} list must not be empty`);
  }
  return [...new Set(values.map((value) => requiredText(value, label)))]
    .sort((left, right) => left.localeCompare(right));
}

function unique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new WorkspaceConfigurationInventoryValidationError(`duplicate ${label} '${value}'`);
    }
    seen.add(value);
  }
}

function safeRelativePath(value: unknown, label: string): string {
  const path = requiredText(value, label).replace(/\\/g, "/").replace(/^\.\//, "");
  if (path.startsWith("/") || /^[a-z]:\//i.test(path) || path.split("/").includes("..")) {
    throw new WorkspaceConfigurationInventoryValidationError(`${label} must stay within the Workspace`);
  }
  return path;
}

function digestText(value: unknown, label: string): string {
  const text = requiredText(value, label).toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(text)) {
    throw new WorkspaceConfigurationInventoryValidationError(`${label} must be a SHA-256 digest`);
  }
  return text;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkspaceConfigurationInventoryValidationError(`${label} must be non-empty text`);
  }
  return value.trim();
}

function sameGrant(
  grant: CapabilityGrantRecord,
  workspaceId: string,
  actorId: string,
  policy: WorkspaceConfigurationImportPolicy,
  operationIds: readonly string[],
): boolean {
  return grant.principal_id === actorId
    && grant.boundary.kind === "workspace"
    && grant.boundary.workspace_id === workspaceId
    && grant.expires_at === policy.expires_at
    && grant.issuer_id === policy.issuer_id
    && sameStrings(grant.operation_ids, operationIds)
    && grant.targets.length === 0
    && grant.evidence.length === 1
    && grant.evidence[0]?.kind === "workspace_configuration_import_policy"
    && grant.evidence[0]?.ref === policy.policy_revision;
}

function sameCredentialGrant(
  grant: CapabilityGrantRecord,
  workspaceId: string,
  actorId: string,
  secretRef: SecretRefRecord,
  policy: WorkspaceConfigurationImportPolicy,
  operationIds: readonly string[],
): boolean {
  return grant.principal_id === actorId
    && grant.boundary.kind === "workspace"
    && grant.boundary.workspace_id === workspaceId
    && grant.expires_at === policy.expires_at
    && grant.issuer_id === policy.issuer_id
    && sameStrings(grant.operation_ids, operationIds)
    && grant.targets.length === 2
    && grant.targets.some((target) => target.kind === "secret_ref" && target.id === secretRef.secret_ref_id)
    && grant.targets.some((target) => target.kind === secretRef.resource.kind && target.id === secretRef.resource.id)
    && grant.evidence.length === 1
    && grant.evidence[0]?.kind === "workspace_configuration_import_policy"
    && grant.evidence[0]?.ref === policy.policy_revision;
}

function sameCredentialConstraint(
  constraint: SecretGrantConstraintRecord,
  workspaceId: string,
  secretRefId: string,
): boolean {
  return constraint.authority_boundary.kind === "workspace"
    && constraint.authority_boundary.workspace_id === workspaceId
    && constraint.secret_ref_id === secretRefId
    && sameStrings(constraint.purposes, [RUNTIME_CREDENTIAL_PURPOSE]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...left].sort((a, b) => a.localeCompare(b));
  const normalizedRight = [...right].sort((a, b) => a.localeCompare(b));
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

function conflict(message: string): WorkspaceConfigurationImportRefusal {
  return { code: "workspace_configuration_conflict", message, retryable: false };
}

function invalidConfiguration(message: string): WorkspaceConfigurationImportRefusal {
  return { code: "workspace_configuration_invalid", message, retryable: false };
}

function receiptFromRow(row: any): WorkspaceConfigurationImportReceipt {
  return {
    import_receipt_id: String(row.import_receipt_id),
    workspace_id: String(row.workspace_id),
    binding_id: String(row.binding_id),
    config_hash: String(row.config_hash),
    inventory_digest: String(row.inventory_digest),
    importer_version: "1",
    policy_revision: String(row.policy_revision),
    policy_digest: String(row.policy_digest),
    outcome: String(row.outcome) as "applied" | "refused",
    imported_actors: JSON.parse(String(row.imported_actors_json)),
    preserved_actor_ids: JSON.parse(String(row.preserved_actor_ids_json)),
    validation: JSON.parse(String(row.validation_json)),
    refusal: row.refusal_json == null ? null : JSON.parse(String(row.refusal_json)),
    created_at: String(row.created_at),
  };
}

function sha256(value: string): string {
  return `sha256:${digest(value)}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

let savepointSequence = 0;

function inSavepoint<T>(db: DatabaseSync, action: () => T): T {
  savepointSequence += 1;
  const name = `workspace_config_import_${savepointSequence}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = action();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}
