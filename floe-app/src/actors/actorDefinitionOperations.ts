import { invokeOperation, listOperations } from "../bus-client/client.ts";
import type {
  ActorDefinitionContent,
  ActorDefinitionRevision,
  ActorInspection,
  ActorRecord,
  EndpointRef,
  OperationInvocationReceipt,
  SemanticOperationDescriptor,
} from "../bus-client/types.ts";

export const ACTOR_LIST_OPERATION_ID = "actor.list";
export const ACTOR_INSPECT_OPERATION_ID = "actor.inspect";
export const ACTOR_DEFINITION_DRAFT_CREATE_OPERATION_ID = "actor.definition.draft.create";
export const ACTOR_DEFINITION_PUBLISH_OPERATION_ID = "actor.definition.publish";
export const ACTOR_RETIRE_OPERATION_ID = "actor.retire";

export class ActorOperationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActorOperationUnavailableError";
  }
}

function operation(
  operations: SemanticOperationDescriptor[],
  operationId: string,
): SemanticOperationDescriptor {
  const descriptor = operations.find(candidate => candidate.operation_id === operationId);
  if (!descriptor) {
    throw new ActorOperationUnavailableError(
      "This Floe installation cannot manage this Actor through the canonical contract yet.",
    );
  }
  if (!descriptor.availability.available) {
    throw new ActorOperationUnavailableError(descriptor.availability.refusal.message);
  }
  return descriptor;
}

function idempotencyKey(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${suffix}`;
}

function completedResult<T>(receipt: OperationInvocationReceipt, message: string): T {
  if (receipt.refusal) throw new ActorOperationUnavailableError(receipt.refusal.message);
  if (receipt.state !== "completed" || !receipt.result) {
    throw new ActorOperationUnavailableError(message);
  }
  return receipt.result as T;
}

export async function inspectActorDefinition(
  workspaceId: string,
  actorId: string,
): Promise<ActorInspection> {
  const target = { kind: "actor", id: actorId };
  const descriptor = operation(await listOperations(workspaceId, target), ACTOR_INSPECT_OPERATION_ID);
  const receipt = await invokeOperation(workspaceId, {
    operation_id: descriptor.operation_id,
    operation_version: descriptor.operation_version,
    input_schema_version: descriptor.input.version,
    target,
    idempotency_key: idempotencyKey("actor-inspect"),
    input: { include_history: false },
  });
  return completedResult<ActorInspection>(receipt, "Floe did not return the current Actor definition.");
}

export async function reviseActorDefinition(
  workspaceId: string,
  actorId: string,
  change: (current: ActorDefinitionContent) => ActorDefinitionContent,
): Promise<{ actor: ActorRecord; revision: ActorDefinitionRevision }> {
  const inspection = await inspectActorDefinition(workspaceId, actorId);
  const current = inspection.current_definition;
  if (!current || !inspection.actor.current_definition_revision_id) {
    throw new ActorOperationUnavailableError(
      "This Actor has no published definition to revise. Refresh the Workspace configuration first.",
    );
  }

  const actorTarget = { kind: "actor", id: actorId };
  const draftDescriptor = operation(
    await listOperations(workspaceId, actorTarget),
    ACTOR_DEFINITION_DRAFT_CREATE_OPERATION_ID,
  );
  const draftReceipt = await invokeOperation(workspaceId, {
    operation_id: draftDescriptor.operation_id,
    operation_version: draftDescriptor.operation_version,
    input_schema_version: draftDescriptor.input.version,
    target: actorTarget,
    expected_resource_revision: inspection.actor.current_definition_revision_id,
    idempotency_key: idempotencyKey("actor-definition-draft"),
    input: {
      based_on_revision_id: current.actor_definition_revision_id,
      definition: change(current.content),
    },
  });
  const drafted = completedResult<{ actor: ActorRecord; revision: ActorDefinitionRevision }>(
    draftReceipt,
    "Floe did not return the revised Actor draft.",
  );

  const revisionTarget = {
    kind: "actor_definition_revision",
    id: drafted.revision.actor_definition_revision_id,
  };
  const publishDescriptor = operation(
    await listOperations(workspaceId, revisionTarget),
    ACTOR_DEFINITION_PUBLISH_OPERATION_ID,
  );
  const publishReceipt = await invokeOperation(workspaceId, {
    operation_id: publishDescriptor.operation_id,
    operation_version: publishDescriptor.operation_version,
    input_schema_version: publishDescriptor.input.version,
    target: revisionTarget,
    expected_resource_revision: drafted.revision.semantic_digest,
    idempotency_key: idempotencyKey("actor-definition-publish"),
    input: {
      expected_current_definition_revision_id: current.actor_definition_revision_id,
    },
  });
  return completedResult<{ actor: ActorRecord; revision: ActorDefinitionRevision }>(
    publishReceipt,
    "Floe did not return the published Actor definition.",
  );
}

/** Overlay addressable Endpoints with their canonical Actor lifecycle and label. */
export async function canonicalActorEndpoints(
  workspaceId: string,
  endpoints: EndpointRef[],
): Promise<EndpointRef[]> {
  const descriptor = operation(await listOperations(workspaceId), ACTOR_LIST_OPERATION_ID);
  const receipt = await invokeOperation(workspaceId, {
    operation_id: descriptor.operation_id,
    operation_version: descriptor.operation_version,
    input_schema_version: descriptor.input.version,
    idempotency_key: idempotencyKey("actor-list"),
    input: { include_retired: true },
  });
  const result = completedResult<{
    actors: Array<{ actor: ActorRecord; current_definition: ActorDefinitionRevision | null }>;
  }>(receipt, "Floe did not return the Actor list.");
  const canonical = new Map(result.actors.map(item => [item.actor.actor_id, item]));
  return endpoints.map(endpoint => {
    const item = canonical.get(endpoint.endpoint_id);
    if (!item) return endpoint;
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(endpoint.metadata_json || "{}") as Record<string, unknown>; } catch { /* keep empty */ }
    return {
      ...endpoint,
      name: item.current_definition?.content.label ?? endpoint.name,
      status: item.actor.status,
      metadata_json: JSON.stringify({
        ...metadata,
        actor_definition_revision_id: item.actor.current_definition_revision_id,
      }),
      updated_at: item.actor.updated_at,
    };
  });
}

export async function retireActorDefinition(
  workspaceId: string,
  actorId: string,
): Promise<ActorRecord> {
  const inspection = await inspectActorDefinition(workspaceId, actorId);
  if (!inspection.actor.current_definition_revision_id) {
    throw new ActorOperationUnavailableError("This Actor has no current definition to retire safely.");
  }
  const target = { kind: "actor", id: actorId };
  const descriptor = operation(await listOperations(workspaceId, target), ACTOR_RETIRE_OPERATION_ID);
  const receipt = await invokeOperation(workspaceId, {
    operation_id: descriptor.operation_id,
    operation_version: descriptor.operation_version,
    input_schema_version: descriptor.input.version,
    target,
    expected_resource_revision: inspection.actor.current_definition_revision_id,
    idempotency_key: idempotencyKey("actor-retire"),
    input: {},
  });
  return completedResult<{ actor: ActorRecord }>(
    receipt,
    "Floe did not return the retired Actor.",
  ).actor;
}
