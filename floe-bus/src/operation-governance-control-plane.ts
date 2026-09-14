import { randomUUID } from "node:crypto";

import {
  ApprovalDeniedError,
  type ApprovalAction,
  type ApprovalRequestRecord,
} from "./approvals.js";
import { auditValueDigest } from "./audit.js";
import { BudgetExceededError, BudgetValidationError, type ResourceUsageFacts } from "./budgets.js";
import {
  DEFAULT_OPERATION_USAGE,
  refusal,
  requiredAction,
  type OperationGovernanceControlPlane,
  type OperationGovernanceEvidence,
  type OperationGovernanceInvocation,
  type OperationGovernancePreparation,
  type OperationRefusal,
  type OperationResourceRef,
  type ResolvedOperationResource,
} from "./operations.js";
import type { PolicyEvaluationFacts, PolicyEvaluationRecord } from "./policies.js";
import type { BusStore } from "./store.js";

const APPROVAL_LIFETIME_MS = 24 * 60 * 60 * 1000;

type CanonicalInvocation = Readonly<{
  facts: PolicyEvaluationFacts;
  context_id: string | null;
  scope_execution_id: string | null;
  node_execution_id: string | null;
  artefact_version_ids: readonly string[];
  connector_binding_revision_id: string | null;
  extension_package_version_id: string | null;
  prior_state_digest: string | null;
}>;

/**
 * One Bus-owned Policy, approval, Budget, and audit boundary around the shared
 * semantic-operation registry. No client or operation handler can supply the
 * facts evaluated here.
 */
export class BusOperationGovernanceControlPlane implements OperationGovernanceControlPlane {
  constructor(private readonly bus: BusStore) {}

  async prepare(input: OperationGovernanceInvocation): Promise<OperationGovernancePreparation> {
    let canonical: CanonicalInvocation;
    try {
      canonical = this.resolveCanonicalInvocation(input);
    } catch (error) {
      this.releasePriorReservation(input);
      return this.refusedBeforeEvaluation(input, governanceRefusal(
        "operation_governance_provenance_invalid",
        error,
        "Refresh the canonical resource and execution state before retrying.",
      ));
    }

    let evaluation: PolicyEvaluationRecord;
    try {
      evaluation = input.prior_evidence?.policy_evaluation_id
        ? this.requireRetainedEvaluation(input, canonical, input.prior_evidence.policy_evaluation_id)
        : this.bus.policyStore.evaluate(canonical.facts);
    } catch (error) {
      this.releasePriorReservation(input);
      return this.refusedBeforeEvaluation(input, governanceRefusal(
        "operation_policy_evaluation_failed",
        error,
        "Inspect the Policy bindings and canonical operation provenance.",
      ));
    }

    const emptyEvidence: OperationGovernanceEvidence = {
      policy_evaluation_id: evaluation.evaluation_id,
      approval_request_ids: [],
      approval_receipt_ids: [],
      budget_reservation_id: null,
    };

    if (evaluation.decision === "deny") {
      const denied = refusal(
        "operation_policy_denied",
        evaluation.denial_reasons.join(" ") || "A current Policy denies this operation.",
        false,
        requiredAction("inspect_policy", "Inspect the Policy", "Review the exact Policy decision before changing the request or Policy."),
        {
          policy_evaluation_id: evaluation.evaluation_id,
          policy_revision_ids: evaluation.evaluated_policy_revision_ids,
        },
      );
      const auditRef = this.beginAudit(input, canonical, emptyEvidence, evaluation, null);
      this.completeAudit(input, canonical, auditRef, "refused", null, denied, [], input.target);
      return { state: "refused", refusal: denied, evidence: emptyEvidence, audit_ref: auditRef, canonical_provenance: canonical.facts.provenance };
    }

    if (input.pre_effect_refusal) {
      const auditRef = this.beginAudit(input, canonical, emptyEvidence, evaluation, null);
      this.completeAudit(
        input,
        canonical,
        auditRef,
        "refused",
        null,
        input.pre_effect_refusal,
        [],
        input.target,
      );
      return {
        state: "refused",
        refusal: input.pre_effect_refusal,
        evidence: emptyEvidence,
        audit_ref: auditRef,
        canonical_provenance: canonical.facts.provenance,
      };
    }

    if (
      canonical.facts.workspace_id
      && (input.definition.effects.mode === "write" || input.definition.effects.external)
      && input.definition.effects.allowed_during_restore_hold !== true
      && this.bus.workspacePortabilityService.isRestoreHeld(canonical.facts.workspace_id)
    ) {
      const held = refusal(
        "workspace_restore_held",
        "This restored Workspace is held while its exact local bindings are reconnected.",
        true,
        requiredAction(
          "inspect_restore",
          "Finish Workspace restore",
          "Inspect unresolved local bindings and release the restore hold before starting other effects.",
        ),
        {
          workspace_id: canonical.facts.workspace_id,
          policy_evaluation_id: evaluation.evaluation_id,
        },
      );
      const auditRef = this.beginAudit(input, canonical, emptyEvidence, evaluation, null);
      this.completeAudit(input, canonical, auditRef, "refused", null, held, [], input.target);
      return {
        state: "refused",
        refusal: held,
        evidence: emptyEvidence,
        audit_ref: auditRef,
        canonical_provenance: canonical.facts.provenance,
      };
    }

    let reservationId: string | null = input.prior_evidence?.budget_reservation_id ?? null;
    try {
      if (!reservationId && evaluation.budget_limits.length > 0) {
        if (canonical.facts.workspace_id === null) {
          throw new BudgetValidationError("a host Policy evaluation cannot contain a Workspace Budget limit");
        }
        const estimates = await this.estimateUsage(input);
        reservationId = this.bus.budgetStore.reserve({
          source: { kind: "operation_invocation", id: input.invocation_id },
          evaluation,
          facts: this.resourceUsageFacts(canonical.facts, canonical.scope_execution_id),
          estimates,
        })?.reservation_id ?? null;
      }
    } catch (error) {
      const budgetRefusal = error instanceof BudgetExceededError
        ? refusal(
            "operation_budget_exceeded",
            error.message,
            false,
            requiredAction("inspect_budget", "Inspect the Budget", "Review current reservations and measured resource use before retrying."),
            {
              policy_evaluation_id: evaluation.evaluation_id,
              metric: error.metric,
              maximum: error.maximum,
              committed: error.committed,
              reserved: error.reserved,
              requested: error.requested,
            },
          )
        : governanceRefusal(
            "operation_budget_estimate_unavailable",
            error,
            "The operation must declare a Bus-owned estimate for every constrained metric before it can run.",
          );
      const evidence = { ...emptyEvidence, budget_reservation_id: reservationId };
      const auditRef = this.beginAudit(input, canonical, evidence, evaluation, reservationId);
      this.completeAudit(input, canonical, auditRef, "refused", null, budgetRefusal, [], input.target);
      return { state: "refused", refusal: budgetRefusal, evidence, audit_ref: auditRef, canonical_provenance: canonical.facts.provenance };
    }

    const baseEvidence: OperationGovernanceEvidence = {
      ...emptyEvidence,
      budget_reservation_id: reservationId,
    };

    if (evaluation.decision === "require_approval") {
      if (canonical.facts.workspace_id === null) {
        const denied = refusal(
          "operation_host_approval_unsupported",
          "This host operation requires approval, but ApprovalRequests belong to a Workspace authority boundary.",
          false,
          requiredAction("revise_policy", "Review the Policy", "Use an authority boundary with canonical approval support."),
        );
        this.releaseReservation(canonical.facts.workspace_id, reservationId);
        const auditRef = this.beginAudit(input, canonical, baseEvidence, evaluation, reservationId);
        this.completeAudit(input, canonical, auditRef, "refused", null, denied, [], input.target);
        return { state: "refused", refusal: denied, evidence: baseEvidence, audit_ref: auditRef, canonical_provenance: canonical.facts.provenance };
      }
      return this.prepareApprovals(input, canonical, evaluation, baseEvidence);
    }

    const auditRef = this.beginAudit(input, canonical, baseEvidence, evaluation, reservationId);
    return { state: "authorized", evidence: baseEvidence, audit_ref: auditRef, canonical_provenance: canonical.facts.provenance };
  }

  async settle(input: Parameters<OperationGovernanceControlPlane["settle"]>[0]): Promise<void> {
    const canonical = this.resolveCanonicalInvocation(input);
    const reservationId = input.preparation.evidence.budget_reservation_id;
    const workspaceId = canonical.facts.workspace_id;
    if (reservationId && workspaceId === null) {
      throw new Error("A host operation cannot own a Workspace Budget reservation.");
    }

    inSavepoint(this.bus, "settle_operation_governance", () => {
      if (reservationId && workspaceId) {
        if (input.state === "completed" || input.state === "accepted") {
          if (!input.actual_usage) throw new Error("Completed operation resource usage is unavailable.");
          this.bus.budgetStore.commit({
            workspace_id: workspaceId,
            reservation_id: reservationId,
            actual_usage: input.actual_usage,
          });
        } else if (input.state === "refused") {
          this.bus.budgetStore.release({ workspace_id: workspaceId, reservation_id: reservationId });
        } else if (input.state === "outcome_unknown") {
          this.bus.budgetStore.markOutcomeUnknown({ workspace_id: workspaceId, reservation_id: reservationId });
        }
      }
      this.completeAudit(
        input,
        canonical,
        input.preparation.audit_ref,
        input.state,
        input.result,
        input.refusal,
        input.changed_refs,
        input.target_after,
      );
    });
  }

  recover(input: Parameters<OperationGovernanceControlPlane["recover"]>[0]): void {
    const workspaceId = input.authority.boundary.kind === "workspace"
      ? input.authority.boundary.workspace_id
      : null;
    const reservationId = input.receipt.governance.budget_reservation_id;
    if (reservationId && workspaceId) {
      const reservation = this.bus.budgetStore.getReservation(reservationId);
      if (reservation?.state === "reserved") {
        this.bus.budgetStore.markOutcomeUnknown({ workspace_id: workspaceId, reservation_id: reservationId });
      }
    }
    const auditId = input.receipt.audit_ref?.kind === "audit"
      ? input.receipt.audit_ref.id
      : this.bus.auditStore.getByInvocationId(input.invocation_id)?.request.audit_id ?? null;
    if (auditId && !this.bus.auditStore.get(auditId)?.outcome) {
      this.bus.auditStore.complete({
        audit_id: auditId,
        state: "outcome_unknown",
        result_schema_version: input.definition.result.version,
        result_digest: null,
        result_summary: { retained: false, reason: "runtime_ownership_lost" },
        refusal: refusal(
          "operation_outcome_unknown",
          "Runtime ownership ended before the operation outcome was proven.",
          false,
          null,
          { invocation_id: input.invocation_id },
        ),
        changed_refs: [],
        target_after: input.receipt.target,
        prior_state_digest: null,
        resulting_state_digest: null,
        affected_artefact_version_ids: [],
      });
    }
  }

  private async prepareApprovals(
    input: OperationGovernanceInvocation,
    canonical: CanonicalInvocation,
    evaluation: PolicyEvaluationRecord,
    baseEvidence: OperationGovernanceEvidence,
  ): Promise<OperationGovernancePreparation> {
    const workspaceId = canonical.facts.workspace_id!;
    let requests: ApprovalRequestRecord[];
    try {
      requests = input.prior_evidence?.approval_request_ids.length
        ? input.prior_evidence.approval_request_ids.map((id) =>
            this.bus.approvalStore.requireRequestForWorkspace(id, workspaceId))
        : evaluation.approval_requirements.map((requirement) => this.bus.createApprovalRequest({
            workspace_id: workspaceId,
            action: this.approvalAction(input, canonical, evaluation),
            context_id: canonical.context_id,
            decision_binding: null,
            decision_policy_ref: {
              policy_evaluation_id: evaluation.evaluation_id,
              policy_revision_id: requirement.policy_revision_id,
              rule_id: requirement.rule_id,
            },
            requested_by_principal_id: input.authority.principal_id,
            reason: requirement.reason,
            expires_at: new Date(Date.now() + APPROVAL_LIFETIME_MS).toISOString(),
            maximum_uses: 1,
            idempotency_key: `operation:${input.invocation_id}:${requirement.policy_revision_id}:${requirement.rule_id}`,
          }));
    } catch (error) {
      this.releaseReservation(workspaceId, baseEvidence.budget_reservation_id);
      const denied = governanceRefusal(
        "operation_approval_request_failed",
        error,
        "Inspect the exact Policy requirement and approval attention item.",
      );
      const auditRef = this.beginAudit(input, canonical, baseEvidence, evaluation, baseEvidence.budget_reservation_id);
      this.completeAudit(input, canonical, auditRef, "refused", null, denied, [], input.target);
      return { state: "refused", refusal: denied, evidence: baseEvidence, audit_ref: auditRef, canonical_provenance: canonical.facts.provenance };
    }

    const requestIds = requests.map((request) => request.approval_request_id).sort();
    const evidence: OperationGovernanceEvidence = {
      ...baseEvidence,
      approval_request_ids: requestIds,
    };
    const auditRef = this.beginAudit(input, canonical, evidence, evaluation, evidence.budget_reservation_id);
    const refreshedRequests = requests.map((request) =>
      this.bus.approvalStore.refreshRequestValidity({
        workspace_id: workspaceId,
        approval_request_id: request.approval_request_id,
        invalidated_by_principal_id: "system:operation-governance",
      }).request
    );
    if (refreshedRequests.some((request) => request.status === "pending")) {
      return {
        state: "awaiting_approval",
        refusal: refusal(
          "operation_approval_required",
          "This exact operation is waiting for its required approval decision.",
          true,
          requiredAction("approve", "Review approval", "Review the exact action, evidence, expected effect, and Policy requirement."),
          {
            policy_evaluation_id: evaluation.evaluation_id,
            approval_request_ids: requestIds,
          },
        ),
        evidence,
        audit_ref: auditRef,
        canonical_provenance: canonical.facts.provenance,
      };
    }
    const notApproved = refreshedRequests.find((request) =>
      request.status !== "approved" || request.decision !== "approved"
    );
    if (notApproved) {
      this.releaseReservation(workspaceId, evidence.budget_reservation_id);
      const denied = refusal(
        "operation_approval_not_granted",
        `ApprovalRequest '${notApproved.approval_request_id}' is '${notApproved.status}'.`,
        false,
        requiredAction("inspect_approval", "Inspect approval", "Inspect the retained decision before creating a new operation intent."),
        { approval_request_id: notApproved.approval_request_id, status: notApproved.status },
      );
      this.completeAudit(input, canonical, auditRef, "refused", null, denied, [], input.target);
      return { state: "refused", refusal: denied, evidence, audit_ref: auditRef, canonical_provenance: canonical.facts.provenance };
    }

    try {
      const action = this.approvalAction(input, canonical, evaluation);
      const receiptsToConsume = refreshedRequests.map((request) => {
        const receipt = this.bus.approvalStore.getReceiptForRequest(request.approval_request_id);
        if (!receipt) {
          throw new ApprovalDeniedError("approval_receipt_not_found");
        }
        // Verify outside the consumption savepoint. Verification may
        // canonically revoke a stale receipt; rolling that revocation back
        // together with a failed multi-receipt consumption would leave a
        // known-invalid receipt looking current.
        this.bus.approvalStore.verifyReceipt({
          approval_receipt_id: receipt.approval_receipt_id,
          workspace_id: workspaceId,
          principal_id: input.authority.principal_id,
          action,
        });
        return receipt;
      });
      const receipts = inSavepoint(this.bus, "consume_operation_approvals", () => receiptsToConsume.map((receipt) => {
        this.bus.approvalStore.consumeReceipt({
          approval_receipt_id: receipt.approval_receipt_id,
          use_id: `operation:${input.invocation_id}:${receipt.approval_request_id}`,
          workspace_id: workspaceId,
          principal_id: input.authority.principal_id,
          action,
        });
        return receipt.approval_receipt_id;
      }));
      return {
        state: "authorized",
        evidence: { ...evidence, approval_receipt_ids: receipts.sort() },
        audit_ref: auditRef,
        canonical_provenance: canonical.facts.provenance,
      };
    } catch (error) {
      this.releaseReservation(workspaceId, evidence.budget_reservation_id);
      const denied = refusal(
        "operation_approval_receipt_invalid",
        error instanceof Error ? error.message : "The canonical approval receipt is invalid.",
        false,
        requiredAction("inspect_approval", "Inspect approval", "The approved action is no longer exact or current."),
        {
          denial_code: error instanceof ApprovalDeniedError ? error.denial_code : "approval_receipt_invalid",
        },
      );
      this.completeAudit(input, canonical, auditRef, "refused", null, denied, [], input.target);
      return { state: "refused", refusal: denied, evidence, audit_ref: auditRef, canonical_provenance: canonical.facts.provenance };
    }
  }

  private resolveCanonicalInvocation(input: OperationGovernanceInvocation): CanonicalInvocation {
    const boundary = input.authority.boundary;
    const workspaceId = boundary.kind === "workspace" ? boundary.workspace_id : null;
    let execution = input.provenance.scope_execution_id
      ? this.bus.scopeExecutionStore.getExecution(input.provenance.scope_execution_id)
      : null;
    if (input.provenance.scope_execution_id && !execution) {
      throw new Error("ScopeExecution provenance is unavailable.");
    }
    let nodeExecution = input.provenance.node_execution_id
      ? this.bus.scopeExecutionStore.getNodeExecution(input.provenance.node_execution_id)
      : null;
    if (input.provenance.node_execution_id && !nodeExecution) {
      throw new Error("NodeExecution provenance is unavailable.");
    }
    const attempt = input.provenance.execution_attempt_id
      ? this.bus.scopeExecutionStore.getAttempt(input.provenance.execution_attempt_id)
      : null;
    if (input.provenance.execution_attempt_id && !attempt) {
      throw new Error("ExecutionAttempt provenance is unavailable.");
    }
    if (attempt) {
      const attemptNode = this.bus.scopeExecutionStore.getNodeExecution(attempt.node_execution_id);
      if (!attemptNode) throw new Error("ExecutionAttempt provenance has no retained NodeExecution.");
      if (nodeExecution && nodeExecution.node_execution_id !== attemptNode.node_execution_id) {
        throw new Error("ExecutionAttempt and NodeExecution provenance conflict.");
      }
      nodeExecution = attemptNode;
    }
    if (nodeExecution) {
      const owner = this.bus.scopeExecutionStore.getExecution(nodeExecution.execution_id);
      if (!owner) throw new Error("The NodeExecution has no retained ScopeExecution.");
      if (execution && execution.execution_id !== owner.execution_id) {
        throw new Error("NodeExecution and ScopeExecution provenance conflict.");
      }
      execution = owner;
      if (nodeExecution.revision_id !== owner.revision_id) {
        throw new Error("NodeExecution and ScopeExecution composition revisions conflict.");
      }
    }
    if (execution && (!workspaceId || execution.workspace_id !== workspaceId)) {
      throw new Error("Execution provenance is outside the authenticated Workspace.");
    }
    const causeEvent = input.provenance.cause_event_id
      ? this.bus.getEvent(input.provenance.cause_event_id)
      : null;
    if (input.provenance.cause_event_id && (!causeEvent || !workspaceId || causeEvent.workspace_id !== workspaceId)) {
      throw new Error("Causal Event provenance is outside the authenticated Workspace.");
    }

    // Causal provenance describes the invocation's origin. A selected resource
    // supplies governance facts without becoming that origin.
    const originExecution = execution;
    const originNodeExecution = nodeExecution;
    if (originNodeExecution) {
      const originRevision = this.bus.scopeCompositionStore.getRevision(originNodeExecution.revision_id);
      if (!originRevision || originRevision.workspace_id !== workspaceId
        || !originRevision.nodes.some((node) => node.node_id === originNodeExecution.node_id)) {
        throw new Error("Revision-local NodePlacement provenance is unavailable.");
      }
    }
    let scopeId = execution?.scope_id ?? null;
    let revisionId = execution?.revision_id ?? null;
    let nodeId = nodeExecution?.node_id ?? null;
    let actorId: string | null = null;
    let connectorBindingId: string | null = null;
    let connectorBindingRevisionId: string | null = null;
    let extensionInstallationId: string | null = null;
    let extensionPackageVersionId: string | null = null;

    const target = input.target;
    if (target) {
      if (target.ref.kind === "scope") {
        scopeId = target.ref.id;
        execution = null;
        nodeExecution = null;
        revisionId = null;
        nodeId = null;
      }
      if (target.ref.kind === "scope_execution") {
        const targetExecution = this.bus.scopeExecutionStore.getExecution(target.ref.id);
        if (!targetExecution || !workspaceId || targetExecution.workspace_id !== workspaceId) throw new Error("ScopeExecution target is unavailable.");
        execution = targetExecution;
        nodeExecution = null;
        nodeId = null;
        scopeId = targetExecution.scope_id;
        revisionId = targetExecution.revision_id;
      }
      if (target.ref.kind === "node_execution") {
        const targetNode = this.bus.scopeExecutionStore.getNodeExecution(target.ref.id);
        const targetExecution = targetNode ? this.bus.scopeExecutionStore.getExecution(targetNode.execution_id) : null;
        if (!targetNode || !targetExecution || !workspaceId || targetExecution.workspace_id !== workspaceId) throw new Error("NodeExecution target is unavailable.");
        nodeExecution = targetNode;
        execution = targetExecution;
        scopeId = targetExecution.scope_id;
        revisionId = targetNode.revision_id;
        nodeId = targetNode.node_id;
      }
      if (target.ref.kind === "scope_composition_revision") {
        const revision = this.bus.scopeCompositionStore.getRevision(target.ref.id);
        if (!revision || !workspaceId || revision.workspace_id !== workspaceId) throw new Error("Scope composition target is unavailable.");
        scopeId = revision.scope_id;
        revisionId = revision.revision_id;
        execution = null;
        nodeExecution = null;
        nodeId = null;
      }
      if (["actor", "actor_definition", "actor_definition_revision"].includes(target.ref.kind)) {
        actorId = target.ref.kind === "actor_definition_revision"
          ? ((target.state as { actor_id?: string } | undefined)?.actor_id ?? null)
          : target.ref.id;
      }
      if (target.ref.kind === "connector_binding") {
        connectorBindingId = target.ref.id;
        connectorBindingRevisionId = (target.state as { current_revision_id?: string } | undefined)
          ?.current_revision_id ?? null;
      }
      if (target.ref.kind === "connector_binding_revision") {
        const revision = this.bus.connectorStore.getBindingRevision(target.ref.id);
        if (!revision) throw new Error("ConnectorBinding revision target is unavailable.");
        connectorBindingId = revision.connector_binding_id;
        connectorBindingRevisionId = revision.connector_binding_revision_id;
      }
      if (target.ref.kind === "extension_installation") {
        extensionInstallationId = target.ref.id;
        extensionPackageVersionId = (target.state as { package_version_id?: string } | undefined)
          ?.package_version_id ?? null;
      }
      if (target.ref.kind === "extension_package_version") extensionPackageVersionId = target.ref.id;
    }

    if (revisionId && nodeId) {
      const revision = this.bus.scopeCompositionStore.getRevision(revisionId);
      const placement = revision?.nodes.find((candidate) => candidate.node_id === nodeId) ?? null;
      if (!revision || !placement || revision.workspace_id !== workspaceId) {
        throw new Error("Revision-local NodePlacement provenance is unavailable.");
      }
      if (placement.kind === "actor") actorId = placement.resource_id ?? null;
      if (placement.kind === "connector") connectorBindingId = placement.resource_id ?? null;
    } else if (nodeId) {
      throw new Error("NodePlacement provenance requires both composition_revision_id and node_id.");
    }

    if (originNodeExecution && causeEvent && originNodeExecution.context_id !== causeEvent.context_id) {
      const isExactReceivedInput = this.bus.scopeExecutionStore
        .listReceivedInputs(originNodeExecution.node_execution_id)
        .some((received) => received.event_id === causeEvent.event_id);
      if (!isExactReceivedInput) {
        throw new Error(
          "Causal Event and NodeExecution provenance belong to different Contexts without an exact received-input relationship.",
        );
      }
    }
    const contextId = originNodeExecution?.context_id ?? causeEvent?.context_id ?? null;
    const deliveryIds = new Set<string>(input.provenance.delivery_ids);
    for (const deliveryId of attempt?.delivery_ids ?? []) deliveryIds.add(deliveryId);
    for (const deliveryId of deliveryIds) {
      const delivery = this.bus.db.prepare(`
        SELECT workspace_id, scope_execution_id FROM event_queue WHERE queue_id = ?
      `).get(deliveryId) as { workspace_id: string; scope_execution_id: string | null } | undefined;
      if (!delivery || !workspaceId || delivery.workspace_id !== workspaceId) {
        throw new Error(`Delivery '${deliveryId}' provenance is outside the authenticated Workspace.`);
      }
      if (originExecution && delivery.scope_execution_id !== originExecution.execution_id) {
        throw new Error(`Delivery '${deliveryId}' is outside the exact ScopeExecution provenance.`);
      }
    }
    const canonicalProvenance = {
      cause_event_id: causeEvent?.event_id ?? null,
      delivery_ids: [...deliveryIds].sort(),
      execution_attempt_id: attempt?.attempt_id ?? null,
      node_execution_id: originNodeExecution?.node_execution_id ?? null,
      scope_execution_id: originExecution?.execution_id ?? null,
    };
    const targetsScopeState = target && ["scope", "scope_execution", "node_execution", "scope_composition_revision"].includes(target.ref.kind);
    const roleResolution = workspaceId
      ? this.bus.actorRoleAuthorityStore.resolveCurrent({
          workspace_id: workspaceId,
          principal_id: input.authority.principal_id,
          target: {
            scope_id: scopeId,
            scope_composition_revision_id: nodeId ? revisionId : null,
            node_placement_id: nodeId ? nodeId : null,
            node_execution_id: nodeExecution?.node_execution_id ?? null,
            context_id: nodeExecution?.context_id ?? (targetsScopeState ? null : contextId),
          },
        })
      : null;
    if (roleResolution) {
      const validation = this.bus.actorRoleAuthorityStore.validateResolutionEvidence(roleResolution, { require_current: true });
      if (!validation.valid) throw new Error("Canonical Actor-role evidence is no longer current.");
    }

    const originVersions = this.resolveArtefactVersions(input, workspaceId, causeEvent?.artefact_version_ids ?? [], originNodeExecution?.node_execution_id ?? null);
    const artefactVersionIds = this.resolveArtefactVersions(input, workspaceId, originVersions, nodeExecution?.node_execution_id ?? null);
    const dataClasses = new Set<string>();
    if (input.definition.effects.secret_access !== "none" || target?.ref.kind === "secret_ref") dataClasses.add("credential");
    if (input.definition.effects.external) dataClasses.add("external_action");
    for (const versionId of artefactVersionIds) {
      const version = this.bus.artefactStore.getVersion(versionId);
      if (version?.content_ref.media_type) dataClasses.add(`media:${version.content_ref.media_type}`);
    }

    const facts: PolicyEvaluationFacts = {
      authority_boundary: boundary,
      workspace_id: workspaceId,
      principal_id: input.authority.principal_id,
      principal_roles: roleResolution?.roles ?? [],
      actor_role_evidence: roleResolution?.evidence ?? [],
      interaction_mode: input.authority.interaction.mode,
      provenance: canonicalProvenance,
      operation_id: input.definition.operation_id,
      target: target?.ref ?? null,
      effects: input.definition.effects,
      scope_id: scopeId,
      actor_id: actorId,
      scope_composition_revision_id: revisionId,
      node_placement_id: nodeId,
      connector_binding_id: connectorBindingId,
      extension_installation_id: extensionInstallationId,
      extension_package_version_id: extensionPackageVersionId,
      data_classes: [...dataClasses].sort(),
      worker_trust_level: null,
    };

    return {
      facts,
      context_id: contextId,
      scope_execution_id: execution?.execution_id ?? null,
      node_execution_id: nodeExecution?.node_execution_id ?? null,
      artefact_version_ids: artefactVersionIds,
      connector_binding_revision_id: connectorBindingRevisionId,
      extension_package_version_id: extensionPackageVersionId,
      prior_state_digest: input.target?.state === undefined ? null : auditValueDigest(input.target.state),
    };
  }

  private resolveArtefactVersions(
    input: OperationGovernanceInvocation,
    workspaceId: string | null,
    causeVersions: readonly string[],
    nodeExecutionId: string | null,
  ): string[] {
    const candidates = new Set<string>(causeVersions);
    if (nodeExecutionId) {
      for (const item of this.bus.scopeExecutionStore.listInputs(nodeExecutionId)) {
        if (item.state === "received" && item.artefact_version_id) candidates.add(item.artefact_version_id);
      }
    }
    collectArtefactVersionIds(input.input, candidates);
    if (input.target?.ref.kind === "artefact_version") candidates.add(input.target.ref.id);
    const result: string[] = [];
    for (const versionId of [...candidates].sort()) {
      const version = this.bus.artefactStore.getVersion(versionId);
      const artefact = version ? this.bus.artefactStore.getArtefact(version.artefact_id) : null;
      if (!workspaceId || !version || !artefact || artefact.workspace_id !== workspaceId) {
        throw new Error(`ArtefactVersion '${versionId}' is unavailable in the authenticated Workspace.`);
      }
      result.push(versionId);
    }
    return result;
  }

  private requireRetainedEvaluation(
    input: OperationGovernanceInvocation,
    canonical: CanonicalInvocation,
    evaluationId: string,
  ): PolicyEvaluationRecord {
    const evaluation = this.bus.policyStore.getEvaluation(evaluationId);
    if (!evaluation || !evaluation.facts) throw new Error("The retained Policy evaluation is unavailable.");
    if (canonicalJson(evaluation.facts) !== canonicalJson(canonical.facts)) {
      throw new Error("The authenticated authority, target, provenance, or Actor-role evidence changed while approval was pending.");
    }
    if (evaluation.decision !== "require_approval") {
      throw new Error("The retained operation is not awaiting a Policy approval decision.");
    }
    if (input.prior_evidence?.approval_request_ids.length !== evaluation.approval_requirements.length) {
      throw new Error("The retained approval request set is incomplete.");
    }
    const current = this.bus.policyStore.evaluate(canonical.facts);
    const decisionEvidence = (record: PolicyEvaluationRecord) => ({
      decision: record.decision,
      evaluated_policy_revision_ids: record.evaluated_policy_revision_ids,
      denial_reasons: record.denial_reasons,
      approval_requirements: record.approval_requirements,
      budget_limits: record.budget_limits,
    });
    if (canonicalJson(decisionEvidence(current)) !== canonicalJson(decisionEvidence(evaluation))) {
      throw new Error("The Policy decision changed while approval was pending.");
    }
    return evaluation;
  }

  private approvalAction(
    input: OperationGovernanceInvocation,
    canonical: CanonicalInvocation,
    evaluation: PolicyEvaluationRecord,
  ): ApprovalAction {
    const target = input.target?.ref ?? null;
    return {
      operation_id: input.definition.operation_id,
      authorized_principal_id: input.authority.principal_id,
      target,
      input_digest: auditValueDigest(input.input),
      artefact_version_ids: canonical.artefact_version_ids,
      composition_revision_id: canonical.facts.scope_composition_revision_id,
      node_placement_id: canonical.facts.node_placement_id,
      scope_execution_id: canonical.scope_execution_id,
      node_execution_id: canonical.node_execution_id,
      connector_binding_revision_id: canonical.connector_binding_revision_id,
      extension_package_version_id: canonical.extension_package_version_id,
      approval_policy_ref: {
        kind: "policy_evaluation",
        id: evaluation.evaluation_id,
        revision: evaluation.facts_digest,
      },
      capability_grant_ids: [...(input.authority.capability_grant_ids ?? [])].sort(),
      expected_effect: {
        summary: input.definition.describe_effect?.({ authority: input.authority, target: input.target }, input.input)
          ?? `${input.definition.title}: ${input.definition.description}`,
        external: input.definition.effects.external,
        reversibility: input.definition.effects.reversibility,
        resource_refs: [
          ...(target ? [target] : []),
          ...canonical.artefact_version_ids.map((id) => ({ kind: "artefact_version", id, revision: id })),
        ],
      },
    };
  }

  private async estimateUsage(input: OperationGovernanceInvocation): Promise<Readonly<Record<string, number>>> {
    const declared = input.definition.resource_accounting?.estimate
      ? await input.definition.resource_accounting.estimate(
          { authority: input.authority, target: input.target },
          input.input,
        )
      : {};
    return normalizeUsage({ ...DEFAULT_OPERATION_USAGE, ...declared });
  }

  private resourceUsageFacts(facts: PolicyEvaluationFacts, scopeExecutionId: string | null): ResourceUsageFacts {
    if (facts.workspace_id === null) throw new BudgetValidationError("Workspace resource facts are required");
    return {
      workspace_id: facts.workspace_id,
      principal_id: facts.principal_id,
      operation_id: facts.operation_id,
      scope_id: facts.scope_id,
      scope_execution_id: scopeExecutionId,
      actor_id: facts.actor_id,
      scope_composition_revision_id: facts.scope_composition_revision_id,
      node_placement_id: facts.node_placement_id,
      connector_binding_id: facts.connector_binding_id,
      extension_installation_id: facts.extension_installation_id,
    };
  }

  private beginAudit(
    input: OperationGovernanceInvocation,
    canonical: CanonicalInvocation,
    evidence: OperationGovernanceEvidence,
    evaluation: PolicyEvaluationRecord,
    reservationId: string | null,
  ): OperationResourceRef | null {
    if (!shouldAudit(input, canonical)) return null;
    const existing = this.bus.auditStore.getByInvocationId(input.invocation_id);
    if (existing) return { kind: "audit", id: existing.request.audit_id, revision: existing.request.request_digest };
    const record = this.bus.auditStore.begin({
      workspace_id: canonical.facts.workspace_id,
      invocation_id: input.invocation_id,
      principal_id: input.authority.principal_id,
      authority_boundary: input.authority.boundary,
      capability_grant_ids: [...(input.authority.capability_grant_ids ?? [])].sort(),
      interaction_mode: input.authority.interaction.mode,
      operation_id: input.definition.operation_id,
      operation_version: input.definition.operation_version,
      target_before: input.target?.ref ?? null,
      expected_resource_revision: input.request.expected_resource_revision ?? null,
      idempotency_key: input.request.idempotency_key,
      input_schema_version: input.request.input_schema_version,
      input_digest: auditValueDigest(input.input),
      request_summary: redactedSummary(input.input),
      reason: null,
      artefact_version_ids: canonical.artefact_version_ids,
      provenance: canonical.facts.provenance,
      policy_evaluation_id: evaluation.evaluation_id,
      budget_reservation_id: reservationId,
    });
    return { kind: "audit", id: record.audit_id, revision: record.request_digest };
  }

  private completeAudit(
    input: OperationGovernanceInvocation,
    canonical: CanonicalInvocation,
    auditRef: OperationResourceRef | null,
    state: "accepted" | "completed" | "refused" | "outcome_unknown",
    result: unknown | null,
    operationRefusal: OperationRefusal | null,
    changedRefs: readonly OperationResourceRef[],
    targetAfter: ResolvedOperationResource | null,
  ): void {
    if (!auditRef) return;
    const existing = this.bus.auditStore.get(auditRef.id);
    if (existing?.outcome) return;
    const changedArtefacts = changedRefs
      .filter((ref) => ref.kind === "artefact_version")
      .map((ref) => ref.id);
    this.bus.auditStore.complete({
      audit_id: auditRef.id,
      state,
      result_schema_version: input.definition.result.version,
      result_digest: result === null ? null : auditValueDigest(result),
      result_summary: result === null ? {} : redactedSummary(result),
      refusal: operationRefusal,
      changed_refs: changedRefs,
      target_after: targetAfter?.ref ?? null,
      prior_state_digest: canonical.prior_state_digest,
      resulting_state_digest: targetAfter?.state === undefined ? null : auditValueDigest(targetAfter.state),
      affected_artefact_version_ids: [...new Set([...canonical.artefact_version_ids, ...changedArtefacts])].sort(),
    });
  }

  private releaseReservation(workspaceId: string | null, reservationId: string | null): void {
    if (!workspaceId || !reservationId) return;
    const reservation = this.bus.budgetStore.getReservation(reservationId);
    if (reservation?.state === "reserved") {
      this.bus.budgetStore.release({ workspace_id: workspaceId, reservation_id: reservationId });
    }
  }

  private releasePriorReservation(input: OperationGovernanceInvocation): void {
    const workspaceId = input.authority.boundary.kind === "workspace"
      ? input.authority.boundary.workspace_id
      : null;
    this.releaseReservation(workspaceId, input.prior_evidence?.budget_reservation_id ?? null);
  }

  private refusedBeforeEvaluation(
    input: OperationGovernanceInvocation,
    operationRefusal: OperationRefusal,
  ): OperationGovernancePreparation {
    const evidence: OperationGovernanceEvidence = input.prior_evidence ?? {
      policy_evaluation_id: null,
      approval_request_ids: [],
      approval_receipt_ids: [],
      budget_reservation_id: null,
    };
    // Invalid canonical provenance cannot safely be represented as a Policy
    // evaluation, but the validated invocation and its authenticated boundary
    // still require a redacted refusal audit before any handler effect.
    const existing = this.bus.auditStore.getByInvocationId(input.invocation_id);
    const audit = existing?.request ?? this.bus.auditStore.begin({
      workspace_id: input.authority.boundary.kind === "workspace"
        ? input.authority.boundary.workspace_id
        : null,
      invocation_id: input.invocation_id,
      principal_id: input.authority.principal_id,
      authority_boundary: input.authority.boundary,
      capability_grant_ids: [...(input.authority.capability_grant_ids ?? [])].sort(),
      interaction_mode: input.authority.interaction.mode,
      operation_id: input.definition.operation_id,
      operation_version: input.definition.operation_version,
      target_before: input.target?.ref ?? null,
      expected_resource_revision: input.request.expected_resource_revision ?? null,
      idempotency_key: input.request.idempotency_key,
      input_schema_version: input.request.input_schema_version,
      input_digest: auditValueDigest(input.input),
      request_summary: redactedSummary(input.input),
      reason: null,
      artefact_version_ids: [],
      provenance: input.provenance,
      policy_evaluation_id: null,
      budget_reservation_id: null,
    });
    if (!existing?.outcome) {
      this.bus.auditStore.complete({
        audit_id: audit.audit_id,
        state: "refused",
        result_schema_version: input.definition.result.version,
        result_digest: null,
        result_summary: {},
        refusal: operationRefusal,
        changed_refs: [],
        target_after: input.target?.ref ?? null,
        prior_state_digest: input.target?.state === undefined ? null : auditValueDigest(input.target.state),
        resulting_state_digest: input.target?.state === undefined ? null : auditValueDigest(input.target.state),
        affected_artefact_version_ids: [],
      });
    }
    return {
      state: "refused",
      refusal: operationRefusal,
      evidence,
      audit_ref: { kind: "audit", id: audit.audit_id, revision: audit.request_digest },
      canonical_provenance: input.provenance,
    };
  }
}

function shouldAudit(_input: OperationGovernanceInvocation, _canonical: CanonicalInvocation): boolean {
  // Until every extension data class has a common sensitivity vocabulary, all
  // reads are retained. This is conservative and avoids an unaudited sensitive
  // read while keeping request/result values redacted.
  return true;
}

function governanceRefusal(code: string, error: unknown, recovery: string): OperationRefusal {
  return refusal(
    code,
    error instanceof Error ? error.message : "The canonical governance check failed.",
    false,
    requiredAction("inspect_governance", "Inspect governance", recovery),
  );
}

function collectArtefactVersionIds(value: unknown, output: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectArtefactVersionIds(item, output);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "artefact_version_id" && typeof item === "string") output.add(item);
    else if (key === "artefact_version_ids" && Array.isArray(item)) {
      for (const id of item) if (typeof id === "string") output.add(id);
    } else collectArtefactVersionIds(item, output);
  }
}

function normalizeUsage(input: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  const output: Record<string, number> = {};
  for (const [metric, amount] of Object.entries(input)) {
    if (!metric.trim() || !Number.isFinite(amount) || amount < 0) {
      throw new BudgetValidationError("declared resource accounting must use non-negative finite amounts");
    }
    output[metric.trim()] = amount;
  }
  return Object.fromEntries(Object.entries(output).sort(([left], [right]) => left.localeCompare(right)));
}

function redactedSummary(value: unknown): Readonly<Record<string, unknown>> {
  if (Array.isArray(value)) return { kind: "array", item_count: value.length, values_redacted: true };
  if (value && typeof value === "object") {
    return {
      kind: "object",
      fields: Object.keys(value as Record<string, unknown>).sort(),
      values_redacted: true,
    };
  }
  return { kind: value === null ? "null" : typeof value, value_redacted: true };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function inSavepoint<T>(bus: BusStore, label: string, work: () => T): T {
  const name = `${label}_${randomUUID().replaceAll("-", "")}`;
  bus.db.exec(`SAVEPOINT ${name}`);
  try {
    const result = work();
    bus.db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    bus.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    bus.db.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}
