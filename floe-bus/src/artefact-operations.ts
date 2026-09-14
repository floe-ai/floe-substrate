import {
  ArtefactIdempotencyConflictError,
  ArtefactNotFoundError,
  ArtefactStore,
  ArtefactValidationError,
  ArtefactVersionNotFoundError,
  ArtefactWorkspaceMismatchError,
  type Artefact,
  type ArtefactAnnotation,
  type ArtefactAssociation,
  type ArtefactAssociationRole,
  type ArtefactAssociationTargetKind,
  type ArtefactCollectionMember,
  type ArtefactLineage,
  type ArtefactVersion,
  type PublishArtefactVersionInput,
} from "./artefacts.js";
import {
  ArtefactContentMismatchError,
  ArtefactContentNotFoundError,
  ArtefactContentTooLargeError,
} from "./artefact-content-resolver.js";
import {
  refusal,
  requireWorkspaceAuthorityId,
  requiredAction,
  type JsonSchema,
  type OperationEvaluationContext,
  type OperationRefusal,
  type SemanticOperationDefinition,
  type SemanticOperationRegistry,
} from "./operations.js";

function authorityWorkspaceId(context: OperationEvaluationContext): string {
  return requireWorkspaceAuthorityId(context.authority);
}

export const CREATE_ARTEFACT_OPERATION_ID = "artefact.create";
export const PUBLISH_ARTEFACT_VERSION_OPERATION_ID = "artefact.version.publish";
export const INSPECT_ARTEFACT_OPERATION_ID = "artefact.inspect";
export const SEARCH_ARTEFACTS_OPERATION_ID = "artefact.search";

export type CreateArtefactOperationInput = {
  type_ref: string;
  artefact_id?: string;
};

export type CreateArtefactOperationResult = {
  artefact: Artefact;
};

export type PublishArtefactVersionOperationInput = Omit<
  PublishArtefactVersionInput,
  "artefact_id" | "idempotency_key"
>;

export type ArtefactVersionEvidence = {
  version: ArtefactVersion;
  lineage_from: ArtefactLineage[];
  lineage_to: ArtefactLineage[];
  members: ArtefactCollectionMember[];
  associations: ArtefactAssociation[];
  annotations: ArtefactAnnotation[];
};

export type PublishArtefactVersionOperationResult = ArtefactVersionEvidence;
export type ArtefactVersionPublisher = (input: PublishArtefactVersionInput) => ArtefactVersion;

export type InspectArtefactOperationInput = {
  artefact_version_id?: string;
  include_history?: boolean;
};

export type InspectArtefactOperationResult = {
  artefact: Artefact;
  /** Branch heads are facts. A client or extension may choose a preferred head. */
  heads: ArtefactVersion[];
  history_complete: boolean;
  versions: ArtefactVersion[];
  selected: ArtefactVersionEvidence | null;
};

export type SearchArtefactsOperationInput = {
  query?: string;
  type_ref?: string;
  association?: {
    target_kind: ArtefactAssociationTargetKind;
    target_id: string;
    role?: ArtefactAssociationRole;
  };
  limit?: number;
  after?: string;
};

export type ArtefactCatalogueItem = {
  artefact: Artefact;
  /** Exact unsuperseded branch tips. No item is labelled as universally current. */
  heads: ArtefactVersion[];
};

export type SearchArtefactsOperationResult = {
  items: ArtefactCatalogueItem[];
  next_cursor: string | null;
};

const nonEmptyStringSchema: JsonSchema = { type: "string", minLength: 1 };
const nullableStringSchema: JsonSchema = { oneOf: [nonEmptyStringSchema, { type: "null" }] };
const digestSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["algorithm", "value"],
  properties: {
    algorithm: { const: "sha256" },
    value: { type: "string", pattern: "^[A-Fa-f0-9]{64}$" },
  },
};
const optionalContentMetadata = {
  media_type: nullableStringSchema,
  size_bytes: { oneOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
};
const workspaceRelativeContentRefSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "path", "digest"],
  properties: {
    kind: { const: "workspace-relative" },
    path: {
      type: "string",
      minLength: 1,
      description: "Workspace-relative resolver hint. The digest, not this mutable path, pins content identity.",
      pattern: "^(?![A-Za-z]:)(?![/\\\\])(?![Ff][Ii][Ll][Ee]:)(?!.*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$)).+",
    },
    digest: digestSchema,
    ...optionalContentMetadata,
  },
};
const contentAddressedContentRefSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "resolver_id", "digest"],
  properties: {
    kind: { const: "content-addressed" },
    resolver_id: nonEmptyStringSchema,
    digest: digestSchema,
    ...optionalContentMetadata,
  },
};
const externalRevisionContentRefSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "resolver_id", "external_id", "revision"],
  properties: {
    kind: { const: "external-revision" },
    resolver_id: nonEmptyStringSchema,
    external_id: {
      type: "string",
      minLength: 1,
      description: "Opaque external identity resolved by the named resolver; absolute file paths are not accepted.",
      pattern: "^(?![A-Za-z]:)(?![/\\\\])(?![Ff][Ii][Ll][Ee]:).+",
    },
    revision: nonEmptyStringSchema,
    digest: { oneOf: [digestSchema, { type: "null" }] },
    ...optionalContentMetadata,
  },
};

export const CONTENT_REF_SCHEMA: JsonSchema = {
  oneOf: [
    workspaceRelativeContentRefSchema,
    contentAddressedContentRefSchema,
    externalRevisionContentRefSchema,
  ],
};

const artefactSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["artefact_id", "workspace_id", "type_ref", "created_at"],
  properties: {
    artefact_id: nonEmptyStringSchema,
    workspace_id: nonEmptyStringSchema,
    type_ref: nonEmptyStringSchema,
    created_at: nonEmptyStringSchema,
  },
};
const artefactVersionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["artefact_version_id", "artefact_id", "ordinal", "schema_ref", "content_ref", "created_at"],
  properties: {
    artefact_version_id: nonEmptyStringSchema,
    artefact_id: nonEmptyStringSchema,
    ordinal: { type: "integer", minimum: 1 },
    schema_ref: nullableStringSchema,
    content_ref: CONTENT_REF_SCHEMA,
    created_at: nonEmptyStringSchema,
  },
};
const lineageTypeSchema: JsonSchema = {
  oneOf: [
    {
      enum: [
        "core:derived-from",
        "core:supersedes",
        "core:test-of",
        "core:decision-about",
        "core:deployment-of",
      ],
    },
    {
      type: "string",
      pattern: "^extension:[A-Za-z0-9][A-Za-z0-9._/-]*/[A-Za-z0-9][A-Za-z0-9._-]*$",
    },
  ],
};
const lineageSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["lineage_id", "workspace_id", "subject_version_id", "relation_type", "object_version_id", "created_at"],
  properties: {
    lineage_id: nonEmptyStringSchema,
    workspace_id: nonEmptyStringSchema,
    subject_version_id: nonEmptyStringSchema,
    relation_type: lineageTypeSchema,
    object_version_id: nonEmptyStringSchema,
    created_at: nonEmptyStringSchema,
  },
};
const collectionMemberSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["collection_version_id", "member_key", "member_version_id", "position", "created_at"],
  properties: {
    collection_version_id: nonEmptyStringSchema,
    member_key: nonEmptyStringSchema,
    member_version_id: nonEmptyStringSchema,
    position: { oneOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
    created_at: nonEmptyStringSchema,
  },
};
const associationTargetKindSchema: JsonSchema = {
  enum: ["event", "context", "scope_execution", "node_execution", "delivery", "connector_receipt"],
};
const associationRoleSchema: JsonSchema = {
  enum: ["input", "output", "evidence", "attachment", "observation"],
};
const associationSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["association_id", "artefact_version_id", "target_kind", "target_id", "role", "created_at"],
  properties: {
    association_id: nonEmptyStringSchema,
    artefact_version_id: nonEmptyStringSchema,
    target_kind: associationTargetKindSchema,
    target_id: nonEmptyStringSchema,
    role: associationRoleSchema,
    created_at: nonEmptyStringSchema,
  },
};
const extensionNamespaceSchema: JsonSchema = {
  type: "string",
  pattern: "^extension:[A-Za-z0-9][A-Za-z0-9._/-]*$",
};
const annotationSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "annotation_id",
    "artefact_version_id",
    "namespace",
    "key",
    "extension_package_version_ref",
    "schema_ref",
    "value",
    "created_at",
  ],
  properties: {
    annotation_id: nonEmptyStringSchema,
    artefact_version_id: nonEmptyStringSchema,
    namespace: extensionNamespaceSchema,
    key: nonEmptyStringSchema,
    extension_package_version_ref: nonEmptyStringSchema,
    schema_ref: nullableStringSchema,
    value: {},
    created_at: nonEmptyStringSchema,
  },
};
const versionEvidenceSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "lineage_from", "lineage_to", "members", "associations", "annotations"],
  properties: {
    version: artefactVersionSchema,
    lineage_from: { type: "array", items: lineageSchema },
    lineage_to: { type: "array", items: lineageSchema },
    members: { type: "array", items: collectionMemberSchema },
    associations: { type: "array", items: associationSchema },
    annotations: { type: "array", items: annotationSchema },
  },
};

export const CREATE_ARTEFACT_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type_ref"],
  properties: {
    type_ref: nonEmptyStringSchema,
    artefact_id: nonEmptyStringSchema,
  },
};

export const CREATE_ARTEFACT_RESULT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["artefact"],
  properties: { artefact: artefactSchema },
};

const lineageInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["relation_type", "object_version_id"],
  properties: {
    relation_type: lineageTypeSchema,
    object_version_id: nonEmptyStringSchema,
  },
};
const memberInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["member_key", "member_version_id"],
  properties: {
    member_key: nonEmptyStringSchema,
    member_version_id: nonEmptyStringSchema,
    position: { oneOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
  },
};
const associationInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["target_kind", "target_id", "role"],
  properties: {
    target_kind: associationTargetKindSchema,
    target_id: nonEmptyStringSchema,
    role: associationRoleSchema,
  },
};
const annotationInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["namespace", "key", "extension_package_version_ref", "value"],
  properties: {
    namespace: extensionNamespaceSchema,
    key: nonEmptyStringSchema,
    extension_package_version_ref: nonEmptyStringSchema,
    schema_ref: nullableStringSchema,
    value: {},
  },
};

export const PUBLISH_ARTEFACT_VERSION_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["content_ref"],
  properties: {
    artefact_version_id: nonEmptyStringSchema,
    schema_ref: nullableStringSchema,
    content_ref: CONTENT_REF_SCHEMA,
    lineage: { type: "array", items: lineageInputSchema },
    members: { type: "array", items: memberInputSchema },
    associations: { type: "array", items: associationInputSchema },
    annotations: { type: "array", items: annotationInputSchema },
  },
};

export const PUBLISH_ARTEFACT_VERSION_RESULT_SCHEMA = versionEvidenceSchema;

export const INSPECT_ARTEFACT_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    artefact_version_id: nonEmptyStringSchema,
    include_history: { type: "boolean" },
  },
};

export const INSPECT_ARTEFACT_RESULT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["artefact", "heads", "history_complete", "versions", "selected"],
  properties: {
    artefact: artefactSchema,
    heads: { type: "array", items: artefactVersionSchema },
    history_complete: { type: "boolean" },
    versions: { type: "array", items: artefactVersionSchema },
    selected: { oneOf: [versionEvidenceSchema, { type: "null" }] },
  },
};

export const SEARCH_ARTEFACTS_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", minLength: 1, maxLength: 512 },
    type_ref: nonEmptyStringSchema,
    association: {
      type: "object",
      additionalProperties: false,
      required: ["target_kind", "target_id"],
      properties: {
        target_kind: associationTargetKindSchema,
        target_id: nonEmptyStringSchema,
        role: associationRoleSchema,
      },
    },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    after: nonEmptyStringSchema,
  },
};

export const SEARCH_ARTEFACTS_RESULT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "next_cursor"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["artefact", "heads"],
        properties: {
          artefact: artefactSchema,
          heads: { type: "array", items: artefactVersionSchema },
        },
      },
    },
    next_cursor: { oneOf: [nonEmptyStringSchema, { type: "null" }] },
  },
};

function targetUnavailable(store: ArtefactStore, context: OperationEvaluationContext): OperationRefusal | null {
  const target = context.target?.ref;
  if (!target) return null;
  let artefact: Artefact | null = null;
  if (target.kind === "artefact") {
    artefact = store.getArtefact(target.id);
  } else if (target.kind === "artefact_version") {
    const version = store.getVersion(target.id);
    artefact = version ? store.getArtefact(version.artefact_id) : null;
  }
  if (!artefact || artefact.workspace_id !== authorityWorkspaceId(context)) {
    return refusal(
      "artefact_not_found",
      "This Artefact is not available in the current Workspace.",
      false,
      requiredAction("refresh_artefacts", "Refresh Artefacts", "Refresh this Workspace and select an available Artefact."),
    );
  }
  return null;
}

function availability(store: ArtefactStore, context: OperationEvaluationContext) {
  const unavailable = targetUnavailable(store, context);
  return unavailable ? { available: false as const, refusal: unavailable } : { available: true as const };
}

function operationRefusal(error: unknown): OperationRefusal {
  if (error instanceof ArtefactContentMismatchError || error instanceof ArtefactContentNotFoundError
      || error instanceof ArtefactContentTooLargeError) {
    return refusal(error.code, error.message, false,
      requiredAction("verify_content", "Verify the file", "Read the existing file and provide its exact digest and size before publishing."));
  }
  if (error instanceof ArtefactIdempotencyConflictError) {
    return refusal(
      "artefact_idempotency_conflict",
      "This idempotency key already identifies different Artefact data.",
      false,
      requiredAction("new_idempotency_key", "Use a new idempotency key", "Keep the existing key for its original intent and use a new key for this different change."),
    );
  }
  if (error instanceof ArtefactValidationError || error instanceof ArtefactWorkspaceMismatchError) {
    return refusal(
      "artefact_input_invalid",
      error.message,
      false,
      requiredAction("correct_input", "Correct the Artefact data", "Use the exact discovered contract and references from this Workspace."),
    );
  }
  if (error instanceof ArtefactNotFoundError || error instanceof ArtefactVersionNotFoundError) {
    return refusal(
      "artefact_not_found",
      "The requested Artefact or exact ArtefactVersion was not found in this Workspace.",
      false,
      requiredAction("refresh_artefacts", "Refresh Artefacts", "Refresh retained Artefacts and choose an available exact version."),
    );
  }
  return refusal(
    "artefact_operation_failed",
    "Floe could not prove that the Artefact operation completed.",
    false,
    requiredAction("inspect_artefacts", "Inspect Artefacts", "Inspect retained Artefact state before deciding whether a retry is safe."),
  );
}

function exactEvidence(store: ArtefactStore, version: ArtefactVersion): ArtefactVersionEvidence {
  return {
    version,
    lineage_from: store.listLineageFrom(version.artefact_version_id),
    lineage_to: store.listLineageTo(version.artefact_version_id),
    members: store.listCollectionMembers(version.artefact_version_id),
    associations: store.listAssociations(version.artefact_version_id),
    annotations: store.listAnnotations(version.artefact_version_id),
  };
}

export function createArtefactOperation(
  store: ArtefactStore,
): SemanticOperationDefinition<CreateArtefactOperationInput, CreateArtefactOperationResult> {
  return {
    operation_id: CREATE_ARTEFACT_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "artefacts",
    title: "Create Artefact",
    description: "Create stable identity for a Workspace output without treating its mutable location as identity.",
    effects: { mode: "write", reversibility: "irreversible", external: false, secret_access: "none" },
    required_grants: [CREATE_ARTEFACT_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    input: { version: "1", schema: CREATE_ARTEFACT_INPUT_SCHEMA },
    result: { version: "1", schema: CREATE_ARTEFACT_RESULT_SCHEMA },
    handler: async (context, input) => {
      try {
        const artefact = store.createArtefact({
          workspace_id: authorityWorkspaceId(context),
          type_ref: input.type_ref,
          idempotency_key: context.idempotency_key,
          ...(input.artefact_id ? { artefact_id: input.artefact_id } : {}),
        });
        return {
          state: "completed",
          result: { artefact },
          changed_refs: [{ kind: "artefact", id: artefact.artefact_id, revision: null }],
        };
      } catch (error) {
        return { state: "refused", refusal: operationRefusal(error) };
      }
    },
  };
}

export function publishArtefactVersionOperation(
  store: ArtefactStore,
  publishVersion: ArtefactVersionPublisher,
): SemanticOperationDefinition<PublishArtefactVersionOperationInput, PublishArtefactVersionOperationResult> {
  return {
    operation_id: PUBLISH_ARTEFACT_VERSION_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "artefacts",
    title: "Publish exact Artefact version",
    description: "Publish immutable content, exact lineage, collection membership, execution references, and extension-owned annotations. Workspace files are verified against the supplied digest and retained before publication; later source edits do not change the published version.",
    effects: { mode: "write", reversibility: "irreversible", external: false, secret_access: "none" },
    required_grants: [PUBLISH_ARTEFACT_VERSION_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["artefact"], expected_revision: "not_applicable" },
    input: { version: "1", schema: PUBLISH_ARTEFACT_VERSION_INPUT_SCHEMA },
    result: { version: "1", schema: PUBLISH_ARTEFACT_VERSION_RESULT_SCHEMA },
    availability: (context) => availability(store, context),
    handler: async (context, input) => {
      try {
        const unavailable = targetUnavailable(store, context);
        if (unavailable) return { state: "refused", refusal: unavailable };
        const artefactId = context.target?.ref.id;
        if (!artefactId) throw new ArtefactNotFoundError("missing-target");
        const version = publishVersion({
          ...input,
          artefact_id: artefactId,
          idempotency_key: context.idempotency_key,
        });
        return {
          state: "completed",
          result: exactEvidence(store, version),
          changed_refs: [
            { kind: "artefact", id: artefactId, revision: version.artefact_version_id },
            { kind: "artefact_version", id: version.artefact_version_id, revision: version.artefact_version_id },
          ],
        };
      } catch (error) {
        return { state: "refused", refusal: operationRefusal(error) };
      }
    },
  };
}

export function inspectArtefactOperation(
  store: ArtefactStore,
): SemanticOperationDefinition<InspectArtefactOperationInput, InspectArtefactOperationResult> {
  return {
    operation_id: INSPECT_ARTEFACT_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "artefacts",
    title: "Inspect Artefact versions",
    description: "Inspect branch heads, retained history, or one exact ArtefactVersion without inventing a universal current version.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [INSPECT_ARTEFACT_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: ["artefact", "artefact_version"], expected_revision: "not_applicable" },
    input: { version: "1", schema: INSPECT_ARTEFACT_INPUT_SCHEMA },
    result: { version: "1", schema: INSPECT_ARTEFACT_RESULT_SCHEMA },
    availability: (context) => availability(store, context),
    handler: async (context, input) => {
      try {
        const unavailable = targetUnavailable(store, context);
        if (unavailable) return { state: "refused", refusal: unavailable };
        const target = context.target?.ref;
        if (!target) throw new ArtefactNotFoundError("missing-target");

        let selectedVersionId = input.artefact_version_id ?? null;
        let artefact: Artefact | null;
        if (target.kind === "artefact_version") {
          if (selectedVersionId && selectedVersionId !== target.id) {
            return {
              state: "refused",
              refusal: refusal(
                "artefact_version_target_conflict",
                "The requested exact version does not match the selected ArtefactVersion.",
                false,
                requiredAction("select_exact_version", "Select one exact version", "Use either the selected ArtefactVersion or a matching exact version reference."),
              ),
            };
          }
          selectedVersionId = target.id;
          const targetVersion = store.getVersion(target.id);
          artefact = targetVersion ? store.getArtefact(targetVersion.artefact_id) : null;
        } else {
          artefact = store.getArtefact(target.id);
        }
        if (!artefact || artefact.workspace_id !== authorityWorkspaceId(context)) {
          throw new ArtefactNotFoundError(target.id);
        }

        let selected: ArtefactVersionEvidence | null = null;
        if (selectedVersionId) {
          const version = store.getVersion(selectedVersionId);
          if (!version || version.artefact_id !== artefact.artefact_id) {
            throw new ArtefactVersionNotFoundError(selectedVersionId);
          }
          selected = exactEvidence(store, version);
        }
        const includeHistory = input.include_history === true;
        return {
          state: "completed",
          result: {
            artefact,
            heads: store.listHeads(artefact.artefact_id),
            history_complete: includeHistory,
            versions: includeHistory ? store.listVersions(artefact.artefact_id) : [],
            selected,
          },
        };
      } catch (error) {
        return { state: "refused", refusal: operationRefusal(error) };
      }
    },
  };
}

export function searchArtefactsOperation(
  store: ArtefactStore,
): SemanticOperationDefinition<SearchArtefactsOperationInput, SearchArtefactsOperationResult> {
  return {
    operation_id: SEARCH_ARTEFACTS_OPERATION_ID,
    operation_version: "1",
    authority_boundary_kinds: ["workspace"],
    category: "artefacts",
    title: "Find Artefacts",
    description: "Find a bounded page of canonical Workspace Artefacts and their exact branch heads.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    required_grants: [SEARCH_ARTEFACTS_OPERATION_ID],
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] },
    target: { resource_kinds: [], expected_revision: "not_applicable" },
    input: { version: "1", schema: SEARCH_ARTEFACTS_INPUT_SCHEMA },
    result: { version: "1", schema: SEARCH_ARTEFACTS_RESULT_SCHEMA },
    handler: async (context, input) => {
      try {
        const page = store.searchArtefacts({
          workspace_id: authorityWorkspaceId(context),
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.type_ref === undefined ? {} : { type_ref: input.type_ref }),
          ...(input.association === undefined ? {} : { association: input.association }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.after === undefined ? {} : { after: input.after }),
        });
        return {
          state: "completed",
          result: {
            items: page.artefacts.map((artefact) => ({
              artefact,
              heads: store.listHeads(artefact.artefact_id),
            })),
            next_cursor: page.next_cursor,
          },
        };
      } catch (error) {
        return { state: "refused", refusal: operationRefusal(error) };
      }
    },
  };
}

export function artefactOperationDefinitions(
  store: ArtefactStore,
  publishVersion: ArtefactVersionPublisher,
): readonly [
  SemanticOperationDefinition<CreateArtefactOperationInput, CreateArtefactOperationResult>,
  SemanticOperationDefinition<PublishArtefactVersionOperationInput, PublishArtefactVersionOperationResult>,
  SemanticOperationDefinition<InspectArtefactOperationInput, InspectArtefactOperationResult>,
  SemanticOperationDefinition<SearchArtefactsOperationInput, SearchArtefactsOperationResult>,
] {
  return [
    createArtefactOperation(store),
    publishArtefactVersionOperation(store, publishVersion),
    inspectArtefactOperation(store),
    searchArtefactsOperation(store),
  ];
}

export function registerArtefactOperations<T extends SemanticOperationRegistry>(registry: T, store: ArtefactStore, publishVersion: ArtefactVersionPublisher): T {
  const [create, publish, inspect, search] = artefactOperationDefinitions(store, publishVersion);
  registry.register(create);
  registry.register(publish);
  registry.register(inspect);
  registry.register(search);
  return registry;
}
