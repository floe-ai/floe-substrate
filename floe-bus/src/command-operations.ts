import {
  CommandDefinitionConflictError,
  CommandDefinitionDraftConflictError,
  CommandDefinitionImmutableError,
  CommandDefinitionRevisionNotFoundError,
  CommandDefinitionStore,
  CommandDefinitionValidationError,
  CommandNotFoundError,
  type CommandDefinitionContent,
  type CommandDefinitionHeadChange,
  type CommandDefinitionRevision,
  type CommandOwner,
  type CommandRecord,
} from "./command-definitions.js";
import {
  operationAuthorityBoundaryId,
  refusal,
  requiredAction,
  type JsonSchema,
  type OperationAuthorityBoundary,
  type OperationEvaluationContext,
  type OperationExecutionContext,
  type OperationRefusal,
  type OperationResourceIdentity,
  type ResolvedOperationResource,
  type SemanticOperationDefinition,
  type SemanticOperationRegistry,
} from "./operations.js";

export const LIST_COMMANDS_OPERATION_ID = "command.list";
export const INSPECT_COMMAND_OPERATION_ID = "command.inspect";
export const GET_COMMAND_DEFINITION_OPERATION_ID = "command.definition.get";
export const CREATE_COMMAND_OPERATION_ID = "command.create";
export const CREATE_COMMAND_DEFINITION_DRAFT_OPERATION_ID = "command.definition.draft.create";
export const REPLACE_COMMAND_DEFINITION_DRAFT_OPERATION_ID = "command.definition.draft.replace";
export const PUBLISH_COMMAND_DEFINITION_OPERATION_ID = "command.definition.publish";
export const ROLLBACK_COMMAND_DEFINITION_OPERATION_ID = "command.definition.rollback";
export const RETIRE_COMMAND_OPERATION_ID = "command.retire";
export const REACTIVATE_COMMAND_OPERATION_ID = "command.reactivate";

export const NO_COMMAND_DEFINITION_REVISION = "none";

export type CommandInspection = Readonly<{
  command: CommandRecord;
  current_definition: CommandDefinitionRevision | null;
  history_complete: boolean;
  revisions: readonly CommandDefinitionRevision[];
  head_changes: readonly CommandDefinitionHeadChange[];
}>;

const nonEmptyString: JsonSchema = { type: "string", minLength: 1 };
const nullableString: JsonSchema = { oneOf: [nonEmptyString, { type: "null" }] };
const emptyInput: JsonSchema = { type: "object", additionalProperties: false };
const ownerSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id"],
  properties: {
    kind: { enum: ["workspace", "host", "extension_package_version"] },
    id: nonEmptyString,
  },
};
const versionedSchemaSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "schema"],
  properties: {
    version: nonEmptyString,
    schema: { type: "object" },
  },
};
const resourceRefSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id", "revision"],
  properties: { kind: nonEmptyString, id: nonEmptyString, revision: nonEmptyString },
};
const sideEffectSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["effect_id", "title", "external", "reversibility", "resource_kinds"],
  properties: {
    effect_id: nonEmptyString,
    title: nonEmptyString,
    external: { type: "boolean" },
    reversibility: { enum: ["none", "reversible", "irreversible"] },
    resource_kinds: { type: "array", items: nonEmptyString, uniqueItems: true },
  },
};
const permissionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["permission_id", "operation_id", "purpose"],
  properties: {
    permission_id: nonEmptyString,
    operation_id: nonEmptyString,
    purpose: nonEmptyString,
  },
};
export const COMMAND_DEFINITION_CONTENT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "label", "description", "input", "output", "side_effects", "permissions",
    "timeout_ms", "cancellation", "idempotency", "implementation_ref", "entry_point",
  ],
  properties: {
    label: nonEmptyString,
    description: nonEmptyString,
    input: versionedSchemaSchema,
    output: versionedSchemaSchema,
    side_effects: { type: "array", items: sideEffectSchema },
    permissions: { type: "array", items: permissionSchema },
    timeout_ms: { type: "integer", minimum: 1, maximum: 86_400_000 },
    cancellation: { enum: ["supported", "best_effort", "not_supported"] },
    idempotency: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "key_schema_ref"],
      properties: {
        mode: { enum: ["pure", "content_addressed", "caller_key", "effect_receipt"] },
        key_schema_ref: nullableString,
      },
    },
    implementation_ref: resourceRefSchema,
    entry_point: nonEmptyString,
  },
};
const commandSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "command_id", "owner", "status", "current_revision_id",
    "created_at", "updated_at", "retired_at",
  ],
  properties: {
    command_id: nonEmptyString,
    owner: ownerSchema,
    status: { enum: ["active", "retired"] },
    current_revision_id: nullableString,
    created_at: nonEmptyString,
    updated_at: nonEmptyString,
    retired_at: nullableString,
  },
};
const revisionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "command_definition_revision_id", "command_id", "owner", "revision_number",
    "based_on_revision_id", "semantic_digest", "content", "created_by_principal_id",
    "created_at", "published_at", "withdrawn_at",
  ],
  properties: {
    command_definition_revision_id: nonEmptyString,
    command_id: nonEmptyString,
    owner: ownerSchema,
    revision_number: { type: "integer", minimum: 1 },
    based_on_revision_id: nullableString,
    semantic_digest: nonEmptyString,
    content: COMMAND_DEFINITION_CONTENT_SCHEMA,
    created_by_principal_id: nonEmptyString,
    created_at: nonEmptyString,
    published_at: nullableString,
    withdrawn_at: nullableString,
  },
};
const headChangeSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "head_change_id", "command_id", "owner", "from_revision_id", "to_revision_id",
    "reason", "changed_by_principal_id", "changed_at",
  ],
  properties: {
    head_change_id: nonEmptyString,
    command_id: nonEmptyString,
    owner: ownerSchema,
    from_revision_id: nullableString,
    to_revision_id: nonEmptyString,
    reason: { enum: ["publish", "rollback"] },
    changed_by_principal_id: nonEmptyString,
    changed_at: nonEmptyString,
  },
};
const commandAndRevisionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["command", "revision"],
  properties: { command: commandSchema, revision: revisionSchema },
};
const commandAndDraftSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["command", "draft"],
  properties: { command: commandSchema, draft: revisionSchema },
};
const commandOnlySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["command"],
  properties: { command: commandSchema },
};
const listResultSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["commands"],
  properties: {
    commands: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "current_definition"],
        properties: {
          command: commandSchema,
          current_definition: { oneOf: [revisionSchema, { type: "null" }] },
        },
      },
    },
  },
};
const inspectionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["command", "current_definition", "history_complete", "revisions", "head_changes"],
  properties: {
    command: commandSchema,
    current_definition: { oneOf: [revisionSchema, { type: "null" }] },
    history_complete: { type: "boolean" },
    revisions: { type: "array", items: revisionSchema },
    head_changes: { type: "array", items: headChangeSchema },
  },
};

const listInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { include_retired: { type: "boolean" } },
};
const inspectInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { include_history: { type: "boolean" } },
};
const createInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["definition"],
  properties: { command_id: nonEmptyString, definition: COMMAND_DEFINITION_CONTENT_SCHEMA },
};
const createDraftInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["definition"],
  properties: { based_on_revision_id: nullableString, definition: COMMAND_DEFINITION_CONTENT_SCHEMA },
};
const replaceDraftInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["definition"],
  properties: { definition: COMMAND_DEFINITION_CONTENT_SCHEMA },
};
const publishInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expected_current_revision_id"],
  properties: { expected_current_revision_id: nullableString },
};
const rollbackInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["to_published_revision_id"],
  properties: { to_published_revision_id: nonEmptyString },
};

function ownerForBoundary(boundary: OperationAuthorityBoundary): CommandOwner {
  return { kind: boundary.kind, id: operationAuthorityBoundaryId(boundary) };
}

function sameOwner(left: CommandOwner, right: CommandOwner): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function commandInBoundary(
  store: CommandDefinitionStore,
  boundary: OperationAuthorityBoundary,
  commandId: string,
): CommandRecord | null {
  const command = store.getCommand(commandId);
  return command && sameOwner(command.owner, ownerForBoundary(boundary)) ? command : null;
}

function revisionInBoundary(
  store: CommandDefinitionStore,
  boundary: OperationAuthorityBoundary,
  revisionId: string,
): CommandDefinitionRevision | null {
  const revision = store.getRevision(revisionId);
  return revision && sameOwner(revision.owner, ownerForBoundary(boundary)) ? revision : null;
}

export function resolveCommandOperationResource(
  store: CommandDefinitionStore,
  target: OperationResourceIdentity,
  boundary: OperationAuthorityBoundary,
): ResolvedOperationResource | null {
  if (target.kind === "command") {
    const command = commandInBoundary(store, boundary, target.id);
    return command ? { ref: commandRef(command), state: command } : null;
  }
  if (target.kind === "command_definition_revision") {
    const revision = revisionInBoundary(store, boundary, target.id);
    return revision ? { ref: revisionRef(revision), state: revision } : null;
  }
  return null;
}

function commandRef(command: CommandRecord) {
  return {
    kind: "command",
    id: command.command_id,
    revision: command.current_revision_id ?? NO_COMMAND_DEFINITION_REVISION,
  };
}

function revisionRef(revision: CommandDefinitionRevision) {
  return {
    kind: "command_definition_revision",
    id: revision.command_definition_revision_id,
    revision: revision.semantic_digest,
  };
}

function auditRef(context: OperationExecutionContext) {
  return { kind: "operation_invocation", id: context.invocation_id, revision: null };
}

function expectedHead(value: string | null): string | null {
  return value === NO_COMMAND_DEFINITION_REVISION ? null : value;
}

function commandAvailability(
  store: CommandDefinitionStore,
  context: OperationEvaluationContext,
  requiredStatus?: CommandRecord["status"],
) {
  const target = context.target?.ref;
  const command = target?.kind === "command"
    ? commandInBoundary(store, context.authority.boundary, target.id)
    : null;
  if (!command) return unavailable("command_not_found", "This Command is not available at the current authority boundary.");
  if (requiredStatus && command.status !== requiredStatus) {
    return unavailable(
      requiredStatus === "active" ? "command_already_retired" : "command_already_active",
      requiredStatus === "active" ? "This Command is already retired." : "This Command is already active.",
    );
  }
  return { available: true as const };
}

function revisionAvailability(store: CommandDefinitionStore, context: OperationEvaluationContext) {
  const target = context.target?.ref;
  return target?.kind === "command_definition_revision"
    && revisionInBoundary(store, context.authority.boundary, target.id)
    ? { available: true as const }
    : unavailable("command_definition_not_found", "This Command definition revision is not available at the current authority boundary.");
}

function unavailable(code: string, message: string) {
  return {
    available: false as const,
    refusal: refusal(
      code,
      message,
      false,
      requiredAction("refresh_commands", "Refresh Commands", "Refresh available Commands and select an exact retained resource."),
    ),
  };
}

function commandOperationRefusal(error: unknown): OperationRefusal {
  if (error instanceof CommandDefinitionConflictError || error instanceof CommandDefinitionDraftConflictError) {
    return refusal(
      "command_definition_revision_conflict",
      "The Command definition changed before this operation completed.",
      true,
      requiredAction("refresh_command", "Review the latest Command", "Refresh the Command and retry against its exact current revision."),
    );
  }
  if (error instanceof CommandDefinitionImmutableError) {
    return refusal(
      "command_definition_immutable",
      "Published or withdrawn Command definitions cannot be replaced.",
      false,
      requiredAction("create_command_definition_draft", "Create a new draft", "Create a new Command definition draft from a retained revision."),
    );
  }
  if (error instanceof CommandNotFoundError || error instanceof CommandDefinitionRevisionNotFoundError) {
    return refusal(
      "command_not_found",
      "The requested Command or definition revision was not found at this authority boundary.",
      false,
      requiredAction("refresh_commands", "Refresh Commands", "Refresh retained Commands and select an available exact revision."),
    );
  }
  if (error instanceof CommandDefinitionValidationError) {
    return refusal(
      "command_definition_invalid",
      error.message,
      false,
      requiredAction("correct_command_definition", "Correct the Command definition", "Use the exact discovered Command definition contract."),
    );
  }
  return refusal(
    "command_operation_failed",
    "Floe could not prove that the Command operation completed.",
    false,
    requiredAction("inspect_command", "Inspect Command", "Inspect retained Command state before deciding whether a retry is safe."),
  );
}

async function handle<TResult>(work: () => TResult | Promise<TResult>) {
  try {
    return await work();
  } catch (error) {
    return { state: "refused" as const, refusal: commandOperationRefusal(error) };
  }
}

export function commandOperationDefinitions(
  store: CommandDefinitionStore,
): SemanticOperationDefinition<any, any>[] {
  const list: SemanticOperationDefinition<{ include_retired?: boolean }, unknown> = {
    operation_id: LIST_COMMANDS_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace", "host"],
    category: "commands",
    title: "List Commands",
    description: "List Commands owned at this authority boundary with their current published definitions.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [LIST_COMMANDS_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    input: { version: "1", schema: listInputSchema },
    result: { version: "1", schema: listResultSchema },
    handler: (context, input) => handle(() => ({
      state: "completed" as const,
      result: {
        commands: store.listCommands(ownerForBoundary(context.authority.boundary), {
          include_retired: input.include_retired === true,
        }).map((command) => ({ command, current_definition: store.getCurrentDefinition(command.command_id) })),
      },
      audit_ref: auditRef(context),
    })),
  };
  const inspect: SemanticOperationDefinition<{ include_history?: boolean }, CommandInspection> = {
    operation_id: INSPECT_COMMAND_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace", "host"],
    category: "commands",
    title: "Inspect Command",
    description: "Inspect a Command's stable identity, current definition, drafts, and retained definition history.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [INSPECT_COMMAND_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["command"], expected_revision: "not_applicable" },
    input: { version: "1", schema: inspectInputSchema },
    result: { version: "1", schema: inspectionSchema },
    availability: (context) => commandAvailability(store, context),
    handler: (context, input) => handle(() => {
      const command = commandInBoundary(store, context.authority.boundary, context.target!.ref.id);
      if (!command) throw new CommandNotFoundError(context.target!.ref.id);
      const all = store.listRevisions(command.command_id);
      const includeHistory = input.include_history === true;
      return {
        state: "completed" as const,
        result: {
          command,
          current_definition: store.getCurrentDefinition(command.command_id),
          history_complete: includeHistory,
          revisions: includeHistory
            ? all
            : all.filter((revision) => revision.command_definition_revision_id === command.current_revision_id
                || (!revision.published_at && !revision.withdrawn_at)),
          head_changes: includeHistory ? store.listHeadChanges(command.command_id) : [],
        },
        audit_ref: auditRef(context),
      };
    }),
  };
  const get: SemanticOperationDefinition<Record<string, never>, unknown> = {
    operation_id: GET_COMMAND_DEFINITION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace", "host"],
    category: "commands",
    title: "Get Command definition",
    description: "Get one exact retained CommandDefinitionRevision and its stable Command identity.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [GET_COMMAND_DEFINITION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["command_definition_revision"], expected_revision: "not_applicable" },
    input: { version: "1", schema: emptyInput },
    result: { version: "1", schema: commandAndRevisionSchema },
    availability: (context) => revisionAvailability(store, context),
    handler: (context) => handle(() => {
      const revision = revisionInBoundary(store, context.authority.boundary, context.target!.ref.id);
      if (!revision) throw new CommandDefinitionRevisionNotFoundError(context.target!.ref.id);
      return {
        state: "completed" as const,
        result: { command: store.requireCommand(revision.command_id), revision },
        audit_ref: auditRef(context),
      };
    }),
  };
  const create: SemanticOperationDefinition<{ command_id?: string; definition: CommandDefinitionContent }, unknown> = {
    operation_id: CREATE_COMMAND_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace", "host"],
    category: "commands",
    title: "Create Command",
    description: "Create a stable Command identity and its first unpublished definition draft at this authority boundary.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [CREATE_COMMAND_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    input: { version: "1", schema: createInputSchema },
    result: { version: "1", schema: commandAndDraftSchema },
    handler: (context, input) => handle(() => {
      const created = store.createCommand({
        owner: ownerForBoundary(context.authority.boundary),
        created_by_principal_id: context.authority.principal_id,
        definition: input.definition,
        ...(input.command_id ? { command_id: input.command_id } : {}),
      });
      return {
        state: "completed" as const,
        result: created,
        changed_refs: [commandRef(created.command), revisionRef(created.draft)],
        audit_ref: auditRef(context),
      };
    }),
  };
  const draft: SemanticOperationDefinition<{ based_on_revision_id?: string | null; definition: CommandDefinitionContent }, unknown> = {
    operation_id: CREATE_COMMAND_DEFINITION_DRAFT_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace", "host"],
    category: "commands",
    title: "Create Command definition draft",
    description: "Create a new Command definition draft from the current or an exact retained revision.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [CREATE_COMMAND_DEFINITION_DRAFT_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["command"], expected_revision: "required" },
    input: { version: "1", schema: createDraftInputSchema },
    result: { version: "1", schema: commandAndRevisionSchema },
    availability: (context) => commandAvailability(store, context, "active"),
    handler: (context, input) => handle(() => {
      const command = store.requireCommand(context.target!.ref.id);
      const expected = expectedHead(context.expected_resource_revision);
      if (command.current_revision_id !== expected) {
        throw new CommandDefinitionConflictError(command.command_id, expected, command.current_revision_id);
      }
      const revision = store.createDraft({
        command_id: command.command_id,
        created_by_principal_id: context.authority.principal_id,
        definition: input.definition,
        ...(input.based_on_revision_id !== undefined ? { based_on_revision_id: input.based_on_revision_id } : {}),
      });
      return {
        state: "completed" as const,
        result: { command: store.requireCommand(command.command_id), revision },
        changed_refs: [commandRef(command), revisionRef(revision)],
        audit_ref: auditRef(context),
      };
    }),
  };
  const replace: SemanticOperationDefinition<{ definition: CommandDefinitionContent }, unknown> = {
    operation_id: REPLACE_COMMAND_DEFINITION_DRAFT_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace", "host"],
    category: "commands",
    title: "Replace Command definition draft",
    description: "Replace only an unpublished Command definition draft using its exact semantic digest.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [REPLACE_COMMAND_DEFINITION_DRAFT_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["command_definition_revision"], expected_revision: "required" },
    input: { version: "1", schema: replaceDraftInputSchema },
    result: { version: "1", schema: commandAndRevisionSchema },
    availability: (context) => revisionAvailability(store, context),
    handler: (context, input) => handle(() => {
      const revision = store.replaceDraft({
        command_definition_revision_id: context.target!.ref.id,
        expected_digest: context.expected_resource_revision!,
        definition: input.definition,
      });
      return {
        state: "completed" as const,
        result: { command: store.requireCommand(revision.command_id), revision },
        changed_refs: [revisionRef(revision)],
        audit_ref: auditRef(context),
      };
    }),
  };
  const publish: SemanticOperationDefinition<{ expected_current_revision_id: string | null }, unknown> = {
    operation_id: PUBLISH_COMMAND_DEFINITION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace", "host"],
    category: "commands",
    title: "Publish Command definition",
    description: "Make one draft the Command's current definition while retaining every published revision.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [PUBLISH_COMMAND_DEFINITION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["command_definition_revision"], expected_revision: "required" },
    input: { version: "1", schema: publishInputSchema },
    result: { version: "1", schema: commandAndRevisionSchema },
    availability: (context) => revisionAvailability(store, context),
    handler: (context, input) => handle(() => {
      const current = store.requireRevision(context.target!.ref.id);
      if (current.semantic_digest !== context.expected_resource_revision) {
        throw new CommandDefinitionDraftConflictError(
          current.command_definition_revision_id,
          context.expected_resource_revision!,
          current.semantic_digest,
        );
      }
      const revision = store.publishDraft({
        command_definition_revision_id: current.command_definition_revision_id,
        expected_current_revision_id: input.expected_current_revision_id,
        changed_by_principal_id: context.authority.principal_id,
      });
      const command = store.requireCommand(revision.command_id);
      return {
        state: "completed" as const,
        result: { command, revision },
        changed_refs: [commandRef(command), revisionRef(revision)],
        audit_ref: auditRef(context),
      };
    }),
  };
  const rollback: SemanticOperationDefinition<{ to_published_revision_id: string }, unknown> = {
    operation_id: ROLLBACK_COMMAND_DEFINITION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace", "host"],
    category: "commands",
    title: "Roll back Command definition",
    description: "Move the current Command definition to an exact retained published revision without rewriting history.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [ROLLBACK_COMMAND_DEFINITION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["command"], expected_revision: "required" },
    input: { version: "1", schema: rollbackInputSchema },
    result: { version: "1", schema: commandAndRevisionSchema },
    availability: (context) => commandAvailability(store, context, "active"),
    handler: (context, input) => handle(() => {
      const command = store.requireCommand(context.target!.ref.id);
      const revision = store.rollback({
        command_id: command.command_id,
        to_published_revision_id: input.to_published_revision_id,
        expected_current_revision_id: context.expected_resource_revision!,
        changed_by_principal_id: context.authority.principal_id,
      });
      const changed = store.requireCommand(command.command_id);
      return {
        state: "completed" as const,
        result: { command: changed, revision },
        changed_refs: [commandRef(changed), revisionRef(revision)],
        audit_ref: auditRef(context),
      };
    }),
  };
  return [
    list,
    inspect,
    get,
    create,
    draft,
    replace,
    publish,
    rollback,
    commandStatusOperation(store, "retired"),
    commandStatusOperation(store, "active"),
  ];
}

function commandStatusOperation(
  store: CommandDefinitionStore,
  status: "active" | "retired",
): SemanticOperationDefinition<Record<string, never>, { command: CommandRecord }> {
  const reactivating = status === "active";
  const operationId = reactivating ? REACTIVATE_COMMAND_OPERATION_ID : RETIRE_COMMAND_OPERATION_ID;
  return {
    operation_id: operationId,
    operation_version: "1",
    authority_boundary_kinds: ["workspace", "host"],
    category: "commands",
    title: reactivating ? "Reactivate Command" : "Retire Command",
    description: reactivating
      ? "Return a retired Command to active use while retaining every definition and execution reference."
      : "Remove a Command from new use while retaining every definition and execution reference.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    required_grants: [operationId],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["command"], expected_revision: "required" },
    input: { version: "1", schema: emptyInput },
    result: { version: "1", schema: commandOnlySchema },
    availability: (context) => commandAvailability(store, context, reactivating ? "retired" : "active"),
    handler: (context) => handle(() => {
      const command = store.setCommandStatus({
        command_id: context.target!.ref.id,
        status,
        expected_current_revision_id: expectedHead(context.expected_resource_revision),
      });
      return {
        state: "completed" as const,
        result: { command },
        changed_refs: [commandRef(command)],
        audit_ref: auditRef(context),
      };
    }),
  };
}

export function registerCommandOperations<T extends SemanticOperationRegistry>(
  registry: T,
  store: CommandDefinitionStore,
): T {
  for (const definition of commandOperationDefinitions(store)) registry.register(definition);
  return registry;
}
