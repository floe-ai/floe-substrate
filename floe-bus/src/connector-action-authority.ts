import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  ApprovalDeniedError,
  type ApprovalAction,
  type ApprovalStore,
} from "./approvals.js";
import type { VersionedResourceRef } from "./actor-definitions.js";
import {
  ConnectorLifecycleConflictError,
  ConnectorRevisionConflictError,
  ConnectorValidationError,
  type ConnectorActionInterface,
  type ConnectorBindingRecord,
  type ConnectorBindingRevision,
  type ConnectorDefinitionRevision,
  type ConnectorOwner,
  type ConnectorStore,
  type ExternalActionAttempt,
  type ExternalEffectReceipt,
} from "./connectors.js";
import {
  CONNECTOR_WORKER_ACTION_OPERATION_ID,
  type ConnectorWorkerDependencies,
  type ConnectorWorkerPin,
} from "./connector-worker.js";
import type { OperationInvocationProvenance, OperationResourceRef } from "./operations.js";
import type { ScopeExecutionStore } from "./scope-executions.js";

type BeginConnectorActionAttempt = ConnectorWorkerDependencies["begin_action_attempt"];
type BeginConnectorActionAttemptInput = Parameters<BeginConnectorActionAttempt>[0];

export type ConnectorActionExecutionPins = Readonly<{
  composition_revision_id: string | null;
  node_placement_id: string | null;
  scope_execution_id: string | null;
  node_execution_id: string | null;
}>;

/**
 * Joins exact canonical approval use to the first durable external-action
 * attempt. Both stores must share this DatabaseSync connection.
 */
export class CanonicalConnectorActionAuthority {
  constructor(
    private readonly db: DatabaseSync,
    private readonly connectors: ConnectorStore,
    private readonly approvals: ApprovalStore,
    private readonly executions: Pick<ScopeExecutionStore, "getExecution" | "getNodeExecution" | "getAttempt">,
    private readonly workerPrincipalId: string,
  ) {}

  readonly beginActionAttempt: BeginConnectorActionAttempt = async (input) =>
    inSavepoint(this.db, "authorize_connector_action", () => this.authorizeAndBegin(input));

  approvalActionForReceipt(receipt: ExternalEffectReceipt): ApprovalAction {
    const canonical = this.reload(receipt.external_effect_receipt_id, receipt.owner);
    return connectorExternalActionApprovalAction({
      receipt: canonical.receipt,
      binding: canonical.binding,
      binding_revision: canonical.bindingRevision,
      definition_revision: canonical.definitionRevision,
      action: canonical.action,
      worker_principal_id: this.workerPrincipalId,
      execution_pins: this.resolveExecutionPins(canonical.receipt.owner, canonical.receipt.invocation_provenance),
    });
  }

  private authorizeAndBegin(input: BeginConnectorActionAttemptInput): ExternalActionAttempt {
    if (input.operation_id !== CONNECTOR_WORKER_ACTION_OPERATION_ID) {
      throw new ApprovalDeniedError("approval_operation_mismatch");
    }
    if (input.principal_id !== this.workerPrincipalId) {
      throw new ApprovalDeniedError("approval_principal_mismatch");
    }
    const canonical = this.reload(input.external_effect.external_effect_receipt_id, input.pin.owner);
    this.assertWorkerPin(input.pin, canonical.binding, canonical.bindingRevision, canonical.definitionRevision);
    if (input.action.interface_id !== canonical.action.interface_id) {
      throw new ConnectorValidationError("the worker action does not match the retained external effect");
    }
    if (!sameTexts(input.approval_receipt_ids, canonical.receipt.approval_receipt_ids)) {
      throw new ApprovalDeniedError("approval_receipt_not_found");
    }
    const approvalAction = connectorExternalActionApprovalAction({
      receipt: canonical.receipt,
      binding: canonical.binding,
      binding_revision: canonical.bindingRevision,
      definition_revision: canonical.definitionRevision,
      action: canonical.action,
      worker_principal_id: this.workerPrincipalId,
      execution_pins: this.resolveExecutionPins(canonical.receipt.owner, canonical.receipt.invocation_provenance),
    });
    const approvalReceiptIds = [...canonical.receipt.approval_receipt_ids].sort();
    if (canonical.action.approval.required) {
      if (canonical.receipt.owner.kind !== "workspace" || approvalReceiptIds.length === 0) {
        throw new ApprovalDeniedError("approval_receipt_not_found");
      }
      for (const approvalReceiptId of approvalReceiptIds) {
        this.approvals.consumeReceipt({
          approval_receipt_id: approvalReceiptId,
          use_id: canonical.receipt.external_effect_receipt_id,
          workspace_id: canonical.receipt.owner.id,
          principal_id: this.workerPrincipalId,
          action: approvalAction,
          at: input.checked_at,
        });
      }
    } else if (approvalReceiptIds.length > 0) {
      throw new ApprovalDeniedError("approval_action_changed");
    }
    return this.connectors.beginExternalActionAttempt({
      external_effect_receipt_id: canonical.receipt.external_effect_receipt_id,
      owner: canonical.receipt.owner,
      request_evidence_ref: input.request_evidence_ref,
    });
  }

  private reload(externalEffectReceiptId: string, owner: ConnectorOwner) {
    const receipt = this.connectors.requireExternalEffectReceiptForOwner(externalEffectReceiptId, owner);
    const binding = this.connectors.requireBindingForOwner(receipt.connector_binding_id, owner);
    if (binding.status !== "enabled") {
      throw new ConnectorLifecycleConflictError(binding.connector_binding_id, "it is not enabled");
    }
    const bindingRevision = this.connectors.requireBindingRevisionForOwner(
      receipt.connector_binding_revision_id,
      owner,
    );
    if (bindingRevision.connector_binding_id !== binding.connector_binding_id) {
      throw new ConnectorRevisionConflictError(
        binding.connector_binding_id,
        receipt.connector_binding_revision_id,
        binding.current_revision_id,
      );
    }
    const definitionRevision = this.connectors.requireDefinitionRevisionForOwner(
      bindingRevision.connector_definition_revision_id,
      owner,
    );
    const action = definitionRevision.content.action_interfaces.find((candidate) =>
      candidate.interface_id === receipt.action_interface_id
    );
    if (!action || !bindingRevision.content.enabled_action_interface_ids.includes(action.interface_id)) {
      throw new ConnectorValidationError("the retained external action is not enabled by its pinned binding revision");
    }
    return { receipt, binding, bindingRevision, definitionRevision, action };
  }

  private assertWorkerPin(
    pin: ConnectorWorkerPin,
    binding: ConnectorBindingRecord,
    bindingRevision: ConnectorBindingRevision,
    definitionRevision: ConnectorDefinitionRevision,
  ): void {
    if (
      pin.binding.connector_binding_id !== binding.connector_binding_id
      || pin.binding_revision.connector_binding_revision_id !== bindingRevision.connector_binding_revision_id
      || pin.definition_revision.connector_definition_revision_id !== definitionRevision.connector_definition_revision_id
      || pin.owner.kind !== binding.owner.kind
      || pin.owner.id !== binding.owner.id
    ) {
      throw new ConnectorValidationError("the worker pin does not match the retained external effect");
    }
  }

  private resolveExecutionPins(
    owner: ConnectorOwner,
    provenance: OperationInvocationProvenance,
  ): ConnectorActionExecutionPins {
    let node = provenance.node_execution_id
      ? this.executions.getNodeExecution(provenance.node_execution_id)
      : null;
    if (provenance.node_execution_id && !node) {
      throw new ConnectorValidationError("the authenticated NodeExecution provenance no longer exists");
    }
    if (provenance.execution_attempt_id) {
      const attempt = this.executions.getAttempt(provenance.execution_attempt_id);
      if (!attempt) throw new ConnectorValidationError("the authenticated ExecutionAttempt provenance no longer exists");
      if (node && attempt.node_execution_id !== node.node_execution_id) {
        throw new ConnectorValidationError("the authenticated ExecutionAttempt and NodeExecution provenance disagree");
      }
      node ??= this.executions.getNodeExecution(attempt.node_execution_id);
      if (!node) throw new ConnectorValidationError("the authenticated ExecutionAttempt has no retained NodeExecution");
      if (provenance.delivery_ids.length > 0 && !sameTexts(provenance.delivery_ids, attempt.delivery_ids)) {
        throw new ConnectorValidationError("the authenticated Delivery and ExecutionAttempt provenance disagree");
      }
    }
    let scope = provenance.scope_execution_id
      ? this.executions.getExecution(provenance.scope_execution_id)
      : null;
    if (provenance.scope_execution_id && !scope) {
      throw new ConnectorValidationError("the authenticated ScopeExecution provenance no longer exists");
    }
    if (node) {
      if (scope && node.execution_id !== scope.execution_id) {
        throw new ConnectorValidationError("the authenticated NodeExecution and ScopeExecution provenance disagree");
      }
      scope ??= this.executions.getExecution(node.execution_id);
      if (!scope) throw new ConnectorValidationError("the authenticated NodeExecution has no retained ScopeExecution");
      if (node.revision_id !== scope.revision_id) {
        throw new ConnectorValidationError("the retained execution pins disagree on the composition revision");
      }
    }
    if (scope && (owner.kind !== "workspace" || scope.workspace_id !== owner.id)) {
      throw new ConnectorValidationError("the authenticated execution provenance belongs to another Workspace");
    }
    return {
      composition_revision_id: scope?.revision_id ?? node?.revision_id ?? null,
      node_placement_id: node?.node_id ?? null,
      scope_execution_id: scope?.execution_id ?? null,
      node_execution_id: node?.node_execution_id ?? null,
    };
  }
}

export function connectorExternalActionApprovalAction(input: Readonly<{
  receipt: ExternalEffectReceipt;
  binding: ConnectorBindingRecord;
  binding_revision: ConnectorBindingRevision;
  definition_revision: ConnectorDefinitionRevision;
  action: ConnectorActionInterface;
  worker_principal_id: string;
  execution_pins: ConnectorActionExecutionPins;
}>): ApprovalAction {
  const implementation = input.definition_revision.content.implementation_ref;
  if (implementation.kind !== "extension_package_version") {
    throw new ConnectorValidationError("external Connector actions require an exact ExtensionPackageVersion implementation");
  }
  const inputRefs = normalizeRefs(input.receipt.input_refs);
  const externalResource: OperationResourceRef = {
    kind: input.binding_revision.content.external_resource.kind,
    id: input.binding_revision.content.external_resource.id,
    revision: null,
  };
  return {
    operation_id: CONNECTOR_WORKER_ACTION_OPERATION_ID,
    authorized_principal_id: requireText(input.worker_principal_id, "worker_principal_id"),
    target: {
      kind: "connector_action",
      id: `${input.binding.connector_binding_id}/actions/${encodeURIComponent(input.action.interface_id)}`,
      revision: input.binding_revision.connector_binding_revision_id,
    },
    input_digest: input.receipt.input_digest,
    artefact_version_ids: [...new Set(inputRefs
      .filter((ref) => ref.kind === "artefact_version")
      .map((ref) => ref.id))].sort(),
    composition_revision_id: input.execution_pins.composition_revision_id,
    node_placement_id: input.execution_pins.node_placement_id,
    scope_execution_id: input.execution_pins.scope_execution_id,
    node_execution_id: input.execution_pins.node_execution_id,
    connector_binding_revision_id: input.binding_revision.connector_binding_revision_id,
    extension_package_version_id: implementation.id,
    approval_policy_ref: input.action.approval.policy_ref === null
      ? null
      : {
          kind: "approval_policy",
          id: input.action.approval.policy_ref,
          revision: input.definition_revision.connector_definition_revision_id,
        },
    capability_grant_ids: [...input.binding_revision.content.capability_grant_ids].sort(),
    expected_effect: {
      summary: `${input.action.title} through ${externalResource.kind}:${externalResource.id}.`,
      external: true,
      reversibility: input.action.effect,
      resource_refs: [...inputRefs, externalResource, implementation],
    },
  };
}

function normalizeRefs(refs: readonly VersionedResourceRef[]): OperationResourceRef[] {
  return refs.map((ref) => ({
    kind: requireText(ref.kind, "input reference kind"),
    id: requireText(ref.id, "input reference id"),
    revision: ref.revision == null ? null : requireText(ref.revision, "input reference revision"),
  }));
}

function sameTexts(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ConnectorValidationError(`${label} must be non-empty text without control characters`);
  }
  return value;
}

function inSavepoint<T>(db: DatabaseSync, label: string, action: () => T): T {
  const savepoint = `${label}_${createHash("sha256").update(label).digest("hex").slice(0, 8)}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = action();
    db.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO ${savepoint}`);
    db.exec(`RELEASE ${savepoint}`);
    throw error;
  }
}
