import type { BusStore } from "./store.js";
import {
  ScopeCompositionConflictError,
  ScopeCompositionInvalidError,
  compareScopeCompositionRevisions,
  simulateScopeComposition,
} from "./scope-compositions.js";
import {
  NO_PUBLISHED_SCOPE_REVISION,
  ScopeOperationRefusalError,
  nodeExecutionStateRevision,
  scopeExecutionStateRevision,
  type ScopeExecutionInspection,
  type ScopeOperationBackend,
  type ScopeOperationCall,
  type ScopePlanInspection,
} from "./scope-operations.js";
import { refusal, requiredAction, requireWorkspaceAuthorityId } from "./operations.js";

type Broadcast = (type: string, payload?: Record<string, unknown>) => void;

/**
 * Bus-owned implementation of the Scope semantic operation contract.
 *
 * This adapter receives authenticated authority and provenance through
 * ScopeOperationCall. It never accepts caller identity or causal identity from
 * an operation input.
 */
export class BusScopeOperationBackend implements ScopeOperationBackend {
  constructor(
    private readonly store: BusStore,
    private readonly broadcast: Broadcast,
  ) {}

  getScope(workspaceId: string, scopeId: string) {
    return this.store.scopeStore.getScope(workspaceId, scopeId);
  }

  createScope(input: Parameters<ScopeOperationBackend["createScope"]>[0]) {
    this.requireAuthorityWorkspace(input.workspace_id, input.call);
    return this.store.createScope(input, this.broadcast);
  }

  listScopes(workspaceId: string) {
    return this.store.listScopes(workspaceId);
  }

  getRevision(revisionId: string) {
    return this.store.getScopeCompositionRevision(revisionId);
  }

  getPublishedRevision(workspaceId: string, scopeId: string) {
    return this.store.getPublishedScopeComposition(workspaceId, scopeId);
  }

  listRevisions(workspaceId: string, scopeId: string) {
    return this.store.listScopeCompositionRevisions(workspaceId, scopeId);
  }

  listExecutions(workspaceId: string, scopeId: string) {
    return this.store.listScopeExecutions(workspaceId, scopeId);
  }

  getExecution(executionId: string) {
    return this.store.getScopeExecution(executionId);
  }

  getNodeExecution(nodeExecutionId: string) {
    return this.store.scopeExecutionStore.getNodeExecution(nodeExecutionId);
  }

  createDraft(input: Parameters<ScopeOperationBackend["createDraft"]>[0]) {
    this.requireAuthorityWorkspace(input.workspace_id, input.call);
    const scope = this.store.scopeStore.getScope(input.workspace_id, input.scope_id);
    if (!scope) {
      throw new ScopeCompositionInvalidError(`Scope '${input.scope_id}' does not exist`);
    }
    const current = this.store.getPublishedScopeComposition(input.workspace_id, input.scope_id)?.revision_id ?? null;
    const expected = input.call.expected_resource_revision === NO_PUBLISHED_SCOPE_REVISION
      ? null
      : input.call.expected_resource_revision;
    this.requireRevision(input.scope_id, expected, current);
    if (input.based_on_revision_id) {
      const base = this.store.getScopeCompositionRevision(input.based_on_revision_id);
      if (!base || base.workspace_id !== input.workspace_id || base.scope_id !== input.scope_id) {
        throw new ScopeCompositionInvalidError(
          `base revision '${input.based_on_revision_id}' is not retained by Scope '${input.scope_id}'`,
        );
      }
    }
    return this.store.createScopeCompositionDraft({
      workspace_id: input.workspace_id,
      scope_id: input.scope_id,
      based_on_revision_id: input.based_on_revision_id,
      created_by_endpoint_id: input.call.authority.principal_id,
      content: input.content,
    }, this.broadcast);
  }

  replaceDraft(input: Parameters<ScopeOperationBackend["replaceDraft"]>[0]) {
    const revision = this.store.getScopeCompositionRevision(input.revision_id);
    this.requireAuthorityWorkspace(revision?.workspace_id ?? "", input.call);
    return this.store.replaceScopeCompositionDraft(
      input.revision_id,
      input.content,
      this.broadcast,
      input.expected_digest,
    );
  }

  validateRevision(input: Parameters<ScopeOperationBackend["validateRevision"]>[0]) {
    const revision = this.store.getScopeCompositionRevision(input.revision_id);
    this.requireAuthorityWorkspace(revision?.workspace_id ?? "", input.call);
    if (!revision) {
      throw new ScopeCompositionInvalidError(`revision '${input.revision_id}' does not exist`);
    }
    this.requireRevision(revision.scope_id, input.call.expected_resource_revision, revision.semantic_digest);
    return {
      revision,
      validation: this.store.inspectScopeCompositionValidation(revision),
    };
  }

  simulateRevision(input: Parameters<ScopeOperationBackend["simulateRevision"]>[0]) {
    const revision = this.store.getScopeCompositionRevision(input.revision_id);
    this.requireAuthorityWorkspace(revision?.workspace_id ?? "", input.call);
    if (!revision) {
      throw new ScopeCompositionInvalidError(`revision '${input.revision_id}' does not exist`);
    }
    this.requireRevision(revision.scope_id, input.call.expected_resource_revision, revision.semantic_digest);
    return simulateScopeComposition(revision, input.ingress_node_id, input.output_port_id);
  }

  compareRevisions(input: Parameters<ScopeOperationBackend["compareRevisions"]>[0]) {
    const from = this.store.getScopeCompositionRevision(input.from_revision_id);
    const to = this.store.getScopeCompositionRevision(input.to_revision_id);
    this.requireAuthorityWorkspace(to?.workspace_id ?? "", input.call);
    if (!from || !to || from.workspace_id !== to.workspace_id || from.scope_id !== to.scope_id) {
      throw new ScopeCompositionInvalidError("Scope revision comparison requires two retained revisions of the same Scope");
    }
    this.requireRevision(to.scope_id, input.call.expected_resource_revision, to.semantic_digest);
    return compareScopeCompositionRevisions(from, to);
  }

  inspectRevisionImpact(input: Parameters<ScopeOperationBackend["inspectRevisionImpact"]>[0]) {
    const revision = this.store.getScopeCompositionRevision(input.revision_id);
    this.requireAuthorityWorkspace(revision?.workspace_id ?? "", input.call);
    if (!revision) {
      throw new ScopeCompositionInvalidError(`revision '${input.revision_id}' does not exist`);
    }
    this.requireRevision(revision.scope_id, input.call.expected_resource_revision, revision.semantic_digest);
    return this.store.assessScopeCompositionImpact(revision.revision_id);
  }

  publishRevision(input: Parameters<ScopeOperationBackend["publishRevision"]>[0]) {
    const draft = this.store.getScopeCompositionRevision(input.revision_id);
    this.requireAuthorityWorkspace(draft?.workspace_id ?? "", input.call);
    if (draft) {
      this.requireRevision(draft.scope_id, input.expected_digest, draft.semantic_digest);
    }
    return this.store.publishScopeComposition({
      revision_id: input.revision_id,
      expected_published_revision_id: input.expected_current_published_revision_id,
      expected_impact_digest: input.expected_impact_digest,
    }, this.broadcast);
  }

  rollbackRevision(input: Parameters<ScopeOperationBackend["rollbackRevision"]>[0]) {
    const target = this.store.getScopeCompositionRevision(input.target_revision_id);
    this.requireAuthorityWorkspace(target?.workspace_id ?? "", input.call);
    if (target) this.requireRevision(target.scope_id, input.expected_digest, target.semantic_digest);
    return this.store.rollbackScopeComposition({
      target_revision_id: input.target_revision_id,
      expected_published_revision_id: input.expected_current_published_revision_id,
      expected_impact_digest: input.expected_impact_digest,
    }, this.broadcast);
  }

  cloneRevision(input: Parameters<ScopeOperationBackend["cloneRevision"]>[0]) {
    const source = this.store.getScopeCompositionRevision(input.source_revision_id);
    this.requireAuthorityWorkspace(source?.workspace_id ?? "", input.call);
    if (!source) {
      throw new ScopeCompositionInvalidError(`revision '${input.source_revision_id}' does not exist`);
    }
    this.requireRevision(source.scope_id, input.call.expected_resource_revision, source.semantic_digest);
    const workspaceId = requireWorkspaceAuthorityId(input.call.authority);
    if (!this.store.scopeStore.getScope(workspaceId, input.target_scope_id)) {
      throw new ScopeCompositionInvalidError(`target Scope '${input.target_scope_id}' does not exist`);
    }
    return this.store.cloneScopeCompositionRevision({
      source_revision_id: source.revision_id,
      target_workspace_id: workspaceId,
      target_scope_id: input.target_scope_id,
      created_by_endpoint_id: input.call.authority.principal_id,
    }, this.broadcast);
  }

  exportRevision(input: Parameters<ScopeOperationBackend["exportRevision"]>[0]) {
    const revision = this.store.getScopeCompositionRevision(input.revision_id);
    this.requireAuthorityWorkspace(revision?.workspace_id ?? "", input.call);
    if (!revision) {
      throw new ScopeCompositionInvalidError(`revision '${input.revision_id}' does not exist`);
    }
    this.requireRevision(revision.scope_id, input.call.expected_resource_revision, revision.semantic_digest);
    return this.store.exportScopeCompositionRevision(revision.revision_id);
  }

  importRevision(input: Parameters<ScopeOperationBackend["importRevision"]>[0]) {
    this.requireAuthorityWorkspace(input.target_workspace_id, input.call);
    const current = this.store.getPublishedScopeComposition(
      input.target_workspace_id,
      input.target_scope_id,
    )?.revision_id ?? null;
    const expected = input.call.expected_resource_revision === NO_PUBLISHED_SCOPE_REVISION
      ? null
      : input.call.expected_resource_revision;
    this.requireRevision(input.target_scope_id, expected, current);
    return this.store.importScopeCompositionRevision({
      target_workspace_id: input.target_workspace_id,
      target_scope_id: input.target_scope_id,
      portable: input.portable,
      created_by_endpoint_id: input.call.authority.principal_id,
    }, this.broadcast);
  }

  inspectPlan(input: Parameters<ScopeOperationBackend["inspectPlan"]>[0]): ScopePlanInspection {
    this.requireAuthorityWorkspace(input.workspace_id, input.call);
    const current = this.store.getPublishedScopeComposition(input.workspace_id, input.scope_id);
    const revisions = this.store.listScopeCompositionRevisions(input.workspace_id, input.scope_id);
    const selected = input.selected_revision_id
      ? revisions.find((revision) => revision.revision_id === input.selected_revision_id)
      : current ?? revisions[0];
    if (!selected) {
      throw new ScopeOperationRefusalError(refusal(
        "scope_plan_empty",
        "This Scope has no plan revisions.",
        false,
        requiredAction("create_scope_draft", "Create a plan", "Create the first Scope composition draft."),
      ));
    }
    const executions = this.store.listScopeExecutions(input.workspace_id, input.scope_id);
    const role = (revision: typeof selected) => revision.withdrawn_at
      ? "withdrawn_draft" as const
      : revision.revision_id === current?.revision_id
        ? "current_published" as const
        : revision.published_at
          ? "historical_published" as const
          : "draft" as const;
    const visible = input.include_history
      ? revisions
      : revisions.filter((revision) =>
          revision.revision_id === current?.revision_id
          || revision.revision_id === selected.revision_id
        );
    return {
      scope_id: input.scope_id,
      current_published_revision_id: current?.revision_id ?? null,
      selected_revision_id: selected.revision_id,
      selected_role: role(selected),
      history_complete: input.include_history,
      revisions: visible.map((revision) => ({
        revision,
        role: role(revision),
        pinned_execution_ids: executions
          .filter((execution) => execution.revision_id === revision.revision_id)
          .map((execution) => execution.execution_id),
      })),
    };
  }

  startExecution(input: Parameters<ScopeOperationBackend["startExecution"]>[0]) {
    this.requireAuthorityWorkspace(input.workspace_id, input.call);
    const current = this.store.getPublishedScopeComposition(input.workspace_id, input.scope_id)?.revision_id ?? null;
    this.requireRevision(input.scope_id, input.expected_published_revision_id, current);
    const result = this.store.startScopeExecution({
      workspace_id: input.workspace_id,
      scope_id: input.scope_id,
      ingress_node_id: input.ingress_node_id,
      output_port_id: input.output_port_id,
      content: input.content,
      artefact_version_ids: input.artefact_version_ids,
      correlation_id: input.correlation_id,
      cause_event_id: input.cause_event_id,
      initiator_endpoint_id: input.call.authority.principal_id,
      idempotency_key: input.call.idempotency_key,
    }, this.broadcast);
    return {
      execution: result.execution,
      root_event_id: result.root_event.event_id,
      publication_id: result.publication.publication_id,
      delivery_ids: result.delivery_ids,
    };
  }

  inspectExecution(input: Parameters<ScopeOperationBackend["inspectExecution"]>[0]): ScopeExecutionInspection {
    this.requireAuthorityWorkspace(input.workspace_id, input.call);
    const projection = this.store.getScopeExecutionProjection(input.execution_id);
    if (!projection || projection.execution.workspace_id !== input.workspace_id) {
      throw new ScopeOperationRefusalError(refusal(
        "scope_execution_not_found",
        "This Scope execution is not available in the current Workspace.",
        false,
        requiredAction("refresh_workspace", "Refresh the Workspace", "Select an available Scope execution."),
      ));
    }
    const current = this.store.getPublishedScopeComposition(input.workspace_id, projection.execution.scope_id);
    return {
      execution: projection.execution,
      pinned_revision: projection.revision,
      current_published_revision_id: current?.revision_id ?? null,
      pinned_revision_role: current?.revision_id === projection.execution.revision_id
        ? "current_published"
        : "historical_published",
      ...(input.include_outputs ? {
        output_publications: projection.node_executions.flatMap(node => node.publications.map(publication => {
          const event = this.store.getEvent(publication.event_id);
          return {
            publication_id: publication.publication_id,
            node_execution_id: node.node_execution_id,
            port_id: publication.port_id,
            event_id: publication.event_id,
            // A retained/malformed reference cannot widen this inspection's
            // Workspace or mix another Context's evidence into this output.
            event: event?.workspace_id === input.workspace_id && event.context_id === node.context_id
              ? event : null,
          };
        })),
      } : {}),
      node_executions: projection.node_executions.map(({ inputs, attempts, publications, ...node }) => ({
        ...node,
        resource_ref: { kind: "node_execution" as const, id: node.node_execution_id, revision: nodeExecutionStateRevision(node) },
        input_delivery_ids: inputs.map((entry) => entry.delivery_id),
        attempt_ids: (attempts as Array<{ attempt_id: string }>).map((attempt) => attempt.attempt_id),
        publication_ids: (publications as Array<{ publication_id: string }>).map((publication) => publication.publication_id),
      })),
      traversals: (projection.traversals as Array<{
        publication_id: string;
        edge_id: string;
        delivery_id: string;
        target_node_execution_id: string;
      }>).map((item) => ({
        publication_id: item.publication_id,
        edge_id: item.edge_id,
        delivery_id: item.delivery_id,
        target_node_execution_id: item.target_node_execution_id,
      })),
    };
  }

  publishNodeOutput(input: Parameters<ScopeOperationBackend["publishNodeOutput"]>[0]) {
    this.requireAuthorityWorkspace(input.workspace_id, input.call);
    const before = this.store.scopeExecutionStore.getNodeExecution(input.node_execution_id);
    if ((input.call.origin_node_execution_id && input.call.origin_node_execution_id !== input.node_execution_id)
      || (input.call.origin_scope_execution_id && before && input.call.origin_scope_execution_id !== before.execution_id)) {
      throw new ScopeOperationRefusalError(refusal(
        "scope_output_provenance_conflict",
        "A runtime can publish output only for its originating Node execution.",
        false,
        requiredAction("inspect_origin", "Inspect the assigned work", "Publish the result for the Node execution that supplied this runtime's work."),
      ));
    }
    if (!before || nodeExecutionStateRevision(before) !== input.call.expected_resource_revision) {
      throw new ScopeOperationRefusalError(refusal(
        "node_execution_revision_conflict",
        "The Node execution changed before its output was published.",
        true,
        requiredAction(
          "refresh_scope_execution",
          "Refresh the execution",
          "Inspect the Node execution and retry against its current state.",
        ),
      ));
    }
    let publisherId = input.call.authority.principal_id;
    const execution = this.store.scopeExecutionStore.getExecution(before.execution_id);
    const placement = execution && this.store.scopeCompositionStore.getRevision(execution.revision_id)
      ?.nodes.find(node => node.node_id === before.node_id);
    if (placement?.kind === "actor") {
      const authority = this.store.actorRoleAuthorityStore.resolveCurrent({
        workspace_id: input.workspace_id,
        principal_id: input.call.authority.principal_id,
        target: { node_execution_id: before.node_execution_id },
      });
      const executor = authority.evidence.find(evidence =>
        evidence.role === "executor"
        && evidence.actor_id === placement.resource_id
        && evidence.source_boundary.kind === "node_execution"
        && evidence.source_boundary.id === before.node_execution_id);
      if (!executor) {
        throw new ScopeOperationRefusalError(refusal(
          "scope_output_authority",
          "Your current actor is not authorised to publish this work's output.",
          false,
          requiredAction("inspect_assignment", "Inspect the assigned actor", "Use an active principal binding to the actor assigned to this work."),
        ));
      }
      // A principal authenticates the caller; the retained assignment identifies
      // the Actor publishing the output. Equal identifier strings grant nothing.
      publisherId = executor.actor_id;
    }
    const result = this.store.publishScopeNodeOutput({
      workspace_id: input.workspace_id,
      node_execution_id: input.node_execution_id,
      port_id: input.port_id,
      publisher_endpoint_id: publisherId,
      publisher_principal_id: input.call.authority.principal_id,
      ...(input.event_type ? { event_type: input.event_type } : {}),
      content: input.content,
      lifecycle_outcome: input.lifecycle_outcome,
      artefact_version_ids: input.artefact_version_ids,
      idempotency_key: input.call.idempotency_key,
    }, this.broadcast);
    return {
      execution: result.execution,
      node_execution: result.node_execution,
      event_id: result.event.event_id,
      publication_id: result.publication.publication_id,
      delivery_ids: result.delivery_ids,
    };
  }

  stopExecution(input: Parameters<ScopeOperationBackend["stopExecution"]>[0]) {
    this.requireAuthorityWorkspace(input.workspace_id, input.call);
    const execution = this.store.getScopeExecution(input.execution_id);
    if (!execution || scopeExecutionStateRevision(execution) !== input.call.expected_resource_revision) {
      throw new ScopeOperationRefusalError(refusal(
        "scope_execution_revision_conflict",
        "The Scope execution changed before it could be stopped.",
        true,
        requiredAction(
          "refresh_scope_execution",
          "Refresh the execution",
          "Inspect the current execution state and retry.",
        ),
      ));
    }
    return this.store.stopScopeExecution({
      workspace_id: input.workspace_id,
      execution_id: input.execution_id,
      reason: input.reason,
      operation_invocation_id: input.call.invocation_id,
    }, this.broadcast);
  }

  pauseExecution(input: Parameters<ScopeOperationBackend["pauseExecution"]>[0]) {
    this.requireExecutionRevision(input.execution_id, input.workspace_id, input.call);
    return this.store.pauseScopeExecution({
      workspace_id: input.workspace_id,
      execution_id: input.execution_id,
      reason: input.reason,
    }, this.broadcast);
  }

  resumeExecution(input: Parameters<ScopeOperationBackend["resumeExecution"]>[0]) {
    this.requireExecutionRevision(input.execution_id, input.workspace_id, input.call);
    return this.store.resumeScopeExecution({
      workspace_id: input.workspace_id,
      execution_id: input.execution_id,
      reason: input.reason,
    }, this.broadcast);
  }

  retryNodeExecution(input: Parameters<ScopeOperationBackend["retryNodeExecution"]>[0]) {
    this.requireNodeExecutionRevision(input.node_execution_id, input.workspace_id, input.call);
    return this.store.retryScopeNodeExecution({
      workspace_id: input.workspace_id,
      node_execution_id: input.node_execution_id,
    }, this.broadcast);
  }

  redoExecution(input: Parameters<ScopeOperationBackend["redoExecution"]>[0]) {
    const sourceNode = this.requireNodeExecutionRevision(
      input.redo_of_node_execution_id,
      input.workspace_id,
      input.call,
    );
    const sourceExecution = this.store.getScopeExecution(sourceNode.execution_id);
    if (!sourceExecution) {
      throw new ScopeCompositionInvalidError(`source execution '${sourceNode.execution_id}' does not exist`);
    }
    const revision = input.revision_selection === "pinned"
      ? this.store.getScopeCompositionRevision(sourceExecution.revision_id)
      : this.store.getPublishedScopeComposition(input.workspace_id, sourceExecution.scope_id);
    if (!revision) {
      throw new ScopeCompositionInvalidError(
        input.revision_selection === "pinned"
          ? "the source execution's pinned plan is no longer retained"
          : "the Scope has no current published plan",
      );
    }
    const result = this.store.startScopeExecution({
      workspace_id: input.workspace_id,
      scope_id: sourceExecution.scope_id,
      revision_id: revision.revision_id,
      redo_of_node_execution_id: sourceNode.node_execution_id,
      ingress_node_id: input.ingress_node_id,
      output_port_id: input.output_port_id,
      content: input.content,
      artefact_version_ids: input.artefact_version_ids,
      correlation_id: input.correlation_id,
      cause_event_id: input.cause_event_id,
      initiator_endpoint_id: input.call.authority.principal_id,
      idempotency_key: input.call.idempotency_key,
    }, this.broadcast);
    return {
      execution: result.execution,
      root_event_id: result.root_event.event_id,
      publication_id: result.publication.publication_id,
      delivery_ids: result.delivery_ids,
    };
  }

  private requireAuthorityWorkspace(workspaceId: string, call: ScopeOperationCall): void {
    if (workspaceId === requireWorkspaceAuthorityId(call.authority)) return;
    throw new ScopeOperationRefusalError(refusal(
      "scope_workspace_authority_mismatch",
      "This Scope resource is not available in the authorised Workspace.",
      false,
      requiredAction("select_workspace", "Select the Workspace", "Use authority issued for the Workspace that owns this resource."),
    ));
  }

  private requireRevision(scopeId: string, expected: string | null, actual: string | null): void {
    if (expected === actual) return;
    throw new ScopeCompositionConflictError(scopeId, expected, actual);
  }

  private requireExecutionRevision(
    executionId: string,
    workspaceId: string,
    call: ScopeOperationCall,
  ) {
    this.requireAuthorityWorkspace(workspaceId, call);
    const execution = this.store.getScopeExecution(executionId);
    if (!execution || execution.workspace_id !== workspaceId
      || scopeExecutionStateRevision(execution) !== call.expected_resource_revision) {
      throw new ScopeOperationRefusalError(refusal(
        "scope_execution_revision_conflict",
        "The Scope execution changed before this operation could run.",
        true,
        requiredAction("refresh_scope_execution", "Refresh the execution", "Inspect its current state and retry."),
      ));
    }
    return execution;
  }

  private requireNodeExecutionRevision(
    nodeExecutionId: string,
    workspaceId: string,
    call: ScopeOperationCall,
  ) {
    this.requireAuthorityWorkspace(workspaceId, call);
    const node = this.store.scopeExecutionStore.getNodeExecution(nodeExecutionId);
    const execution = node ? this.store.getScopeExecution(node.execution_id) : null;
    if (!node || execution?.workspace_id !== workspaceId
      || nodeExecutionStateRevision(node) !== call.expected_resource_revision) {
      throw new ScopeOperationRefusalError(refusal(
        "node_execution_revision_conflict",
        "The Node execution changed before this operation could run.",
        true,
        requiredAction("refresh_scope_execution", "Refresh the execution", "Inspect its current state and retry."),
      ));
    }
    return node;
  }
}
