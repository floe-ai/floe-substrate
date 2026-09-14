import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type Sha256Digest = {
  algorithm: "sha256";
  value: string;
};

type ContentRefMetadata = {
  media_type?: string | null;
  size_bytes?: number | null;
};

/**
 * A path is only a resolver hint. The digest pins the exact content and prevents
 * a mutable or machine-specific path from becoming Artefact identity.
 */
export type WorkspaceRelativeContentRef = ContentRefMetadata & {
  kind: "workspace-relative";
  path: string;
  digest: Sha256Digest;
};

export type ContentAddressedContentRef = ContentRefMetadata & {
  kind: "content-addressed";
  resolver_id: string;
  digest: Sha256Digest;
};

export type ExternalRevisionContentRef = ContentRefMetadata & {
  kind: "external-revision";
  resolver_id: string;
  external_id: string;
  revision: string;
  digest?: Sha256Digest | null;
};

export type ContentRef =
  | WorkspaceRelativeContentRef
  | ContentAddressedContentRef
  | ExternalRevisionContentRef;

export type Artefact = {
  artefact_id: string;
  workspace_id: string;
  type_ref: string;
  created_at: string;
};

export type ArtefactVersion = {
  artefact_version_id: string;
  artefact_id: string;
  ordinal: number;
  schema_ref: string | null;
  content_ref: ContentRef;
  created_at: string;
};

export type CoreArtefactLineageType =
  | "core:derived-from"
  | "core:supersedes"
  | "core:test-of"
  | "core:decision-about"
  | "core:deployment-of";

export type ArtefactLineageType = CoreArtefactLineageType | `extension:${string}/${string}`;

export type ArtefactLineage = {
  lineage_id: string;
  workspace_id: string;
  /** The version making the typed statement. */
  subject_version_id: string;
  relation_type: ArtefactLineageType;
  /** The exact version that the statement concerns. */
  object_version_id: string;
  created_at: string;
};

export type ArtefactCollectionMember = {
  collection_version_id: string;
  member_key: string;
  member_version_id: string;
  position: number | null;
  created_at: string;
};

/**
 * These are references to canonical records owned elsewhere. Actor and Command
 * are deliberately absent: a NodeExecution already owns those producer facts.
 */
export type ArtefactAssociationTargetKind =
  | "event"
  | "context"
  | "scope_execution"
  | "node_execution"
  | "delivery"
  | "connector_receipt";

export type ArtefactAssociationRole = "input" | "output" | "evidence" | "attachment" | "observation";

export type ArtefactAssociation = {
  association_id: string;
  artefact_version_id: string;
  target_kind: ArtefactAssociationTargetKind;
  target_id: string;
  role: ArtefactAssociationRole;
  created_at: string;
};

export type ArtefactAnnotation = {
  annotation_id: string;
  artefact_version_id: string;
  namespace: `extension:${string}`;
  key: string;
  extension_package_version_ref: string;
  schema_ref: string | null;
  value: JsonValue;
  created_at: string;
};

export type LegacyArtefactImportEvidence = {
  legacy_import_id: string;
  import_key: string;
  workspace_id: string;
  source_document: string;
  legacy_external_id: string | null;
  source_revision: string | null;
  content_identity: string | null;
  status: "unresolved" | "imported";
  reason: string | null;
  artefact_id: string | null;
  artefact_version_id: string | null;
  evidence: JsonValue | null;
  created_at: string;
};

export type PublishArtefactVersionInput = {
  artefact_id: string;
  idempotency_key: string;
  artefact_version_id?: string;
  schema_ref?: string | null;
  content_ref: ContentRef;
  lineage?: Array<{
    relation_type: ArtefactLineageType;
    object_version_id: string;
  }>;
  members?: Array<{
    member_key: string;
    member_version_id: string;
    position?: number | null;
  }>;
  associations?: Array<{
    target_kind: ArtefactAssociationTargetKind;
    target_id: string;
    role: ArtefactAssociationRole;
  }>;
  annotations?: Array<{
    namespace: `extension:${string}`;
    key: string;
    extension_package_version_ref: string;
    schema_ref?: string | null;
    value: JsonValue;
  }>;
};

export type ArtefactCatalogueQuery = {
  workspace_id: string;
  /** Case-insensitive match against stable Artefact identity, type, or exact version identity. */
  query?: string;
  type_ref?: string;
  association?: {
    target_kind: ArtefactAssociationTargetKind;
    target_id: string;
    role?: ArtefactAssociationRole;
  };
  limit?: number;
  /** Opaque continuation cursor returned by the preceding page. */
  after?: string;
};

export type ArtefactCataloguePage = {
  artefacts: Artefact[];
  next_cursor: string | null;
};

const SHA256_RE = /^[a-fA-F0-9]{64}$/;
const EXTENSION_NAMESPACE_RE = /^extension:[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const EXTENSION_LINEAGE_RE = /^extension:[A-Za-z0-9][A-Za-z0-9._/-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;
const UNC_RE = /^(?:\\\\|\/\/)/;
const CORE_LINEAGE_TYPES = new Set<CoreArtefactLineageType>([
  "core:derived-from",
  "core:supersedes",
  "core:test-of",
  "core:decision-about",
  "core:deployment-of",
]);
const ASSOCIATION_TARGET_KINDS = new Set<ArtefactAssociationTargetKind>([
  "event",
  "context",
  "scope_execution",
  "node_execution",
  "delivery",
  "connector_receipt",
]);
const ASSOCIATION_ROLES = new Set<ArtefactAssociationRole>([
  "input",
  "output",
  "evidence",
  "attachment",
  "observation",
]);

export class ArtefactValidationError extends Error {
  readonly code = "E_ARTEFACT_INVALID" as const;
  constructor(readonly reason: string) {
    super(`Invalid Artefact data: ${reason}`);
    this.name = "ArtefactValidationError";
  }
}

export class ArtefactNotFoundError extends Error {
  readonly code = "E_ARTEFACT_NOT_FOUND" as const;
  constructor(readonly artefact_id: string) {
    super(`Artefact not found: ${artefact_id}`);
    this.name = "ArtefactNotFoundError";
  }
}

export class ArtefactVersionNotFoundError extends Error {
  readonly code = "E_ARTEFACT_VERSION_NOT_FOUND" as const;
  constructor(readonly artefact_version_id: string) {
    super(`ArtefactVersion not found: ${artefact_version_id}`);
    this.name = "ArtefactVersionNotFoundError";
  }
}

export class ArtefactWorkspaceMismatchError extends Error {
  readonly code = "E_ARTEFACT_WORKSPACE_MISMATCH" as const;
  constructor(readonly reason: string) {
    super(`Artefact workspace mismatch: ${reason}`);
    this.name = "ArtefactWorkspaceMismatchError";
  }
}

export class ArtefactIdempotencyConflictError extends Error {
  readonly code = "E_ARTEFACT_IDEMPOTENCY_CONFLICT" as const;
  constructor(readonly idempotency_key: string) {
    super(`Idempotency key '${idempotency_key}' was already used for different Artefact data.`);
    this.name = "ArtefactIdempotencyConflictError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function requireText(value: unknown, label: string, maximum = 1024): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ArtefactValidationError(`${label} must be non-empty text without control characters`);
  }
  return value;
}

function requireIdempotencyKey(value: unknown): string {
  return requireText(value, "idempotency_key", 256);
}

function normalizeJsonValue(value: unknown, label = "JSON value"): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ArtefactValidationError(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalizeJsonValue(item, `${label}[${index}]`));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ArtefactValidationError(`${label} must contain only plain JSON objects`);
    }
    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      requireText(key, `${label} key`, 512);
      if (item === undefined) throw new ArtefactValidationError(`${label}.${key} is undefined`);
      output[key] = normalizeJsonValue(item, `${label}.${key}`);
    }
    return output;
  }
  throw new ArtefactValidationError(`${label} is not JSON serializable`);
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(normalizeJsonValue(value))).digest("hex");
}

function normalizeDigest(value: Sha256Digest, label = "digest"): Sha256Digest {
  if (!value || value.algorithm !== "sha256" || typeof value.value !== "string" || !SHA256_RE.test(value.value)) {
    throw new ArtefactValidationError(`${label} must be a SHA-256 digest`);
  }
  return { algorithm: "sha256", value: value.value.toLowerCase() };
}

function normalizeContentMetadata(value: ContentRefMetadata): ContentRefMetadata {
  const normalized: ContentRefMetadata = {};
  if (value.media_type !== undefined && value.media_type !== null) {
    normalized.media_type = requireText(value.media_type, "content_ref.media_type", 256);
  }
  if (value.size_bytes !== undefined && value.size_bytes !== null) {
    if (!Number.isSafeInteger(value.size_bytes) || value.size_bytes < 0) {
      throw new ArtefactValidationError("content_ref.size_bytes must be a non-negative safe integer");
    }
    normalized.size_bytes = value.size_bytes;
  }
  return normalized;
}

export function normalizeWorkspaceRelativePath(value: string): string {
  const path = requireText(value, "workspace-relative path", 4096);
  if (WINDOWS_DRIVE_RE.test(path) || UNC_RE.test(path) || path.startsWith("/") || /^file:/i.test(path)) {
    throw new ArtefactValidationError("workspace-relative path cannot be absolute");
  }
  const segments = path.replace(/\\/g, "/").split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new ArtefactValidationError("workspace-relative path cannot leave the workspace");
  }
  const normalized = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
  if (!normalized) throw new ArtefactValidationError("workspace-relative path cannot be empty");
  return normalized;
}

export function normalizeContentRef(value: ContentRef): ContentRef {
  if (!value || typeof value !== "object") throw new ArtefactValidationError("content_ref is required");
  const metadata = normalizeContentMetadata(value);
  switch (value.kind) {
    case "workspace-relative":
      return {
        kind: value.kind,
        path: normalizeWorkspaceRelativePath(value.path),
        digest: normalizeDigest(value.digest, "content_ref.digest"),
        ...metadata,
      };
    case "content-addressed":
      return {
        kind: value.kind,
        resolver_id: requireText(value.resolver_id, "content_ref.resolver_id", 256),
        digest: normalizeDigest(value.digest, "content_ref.digest"),
        ...metadata,
      };
    case "external-revision": {
      const externalId = requireText(value.external_id, "content_ref.external_id", 4096);
      if (WINDOWS_DRIVE_RE.test(externalId) || UNC_RE.test(externalId) || externalId.startsWith("/") || /^file:/i.test(externalId)) {
        throw new ArtefactValidationError("external content cannot use an absolute file path as identity");
      }
      return {
        kind: value.kind,
        resolver_id: requireText(value.resolver_id, "content_ref.resolver_id", 256),
        external_id: externalId,
        revision: requireText(value.revision, "content_ref.revision", 1024),
        ...(value.digest ? { digest: normalizeDigest(value.digest, "content_ref.digest") } : {}),
        ...metadata,
      };
    }
    default:
      throw new ArtefactValidationError(`unsupported content_ref kind '${String((value as { kind?: unknown }).kind)}'`);
  }
}

function normalizeLineageType(value: string): ArtefactLineageType {
  if (CORE_LINEAGE_TYPES.has(value as CoreArtefactLineageType) || EXTENSION_LINEAGE_RE.test(value)) {
    return value as ArtefactLineageType;
  }
  throw new ArtefactValidationError(`lineage relation_type '${value}' is not a core or extension-namespaced type`);
}

function normalizeAssociationTargetKind(value: string): ArtefactAssociationTargetKind {
  if (!ASSOCIATION_TARGET_KINDS.has(value as ArtefactAssociationTargetKind)) {
    throw new ArtefactValidationError(`association target_kind '${value}' is not supported`);
  }
  return value as ArtefactAssociationTargetKind;
}

function normalizeAssociationRole(value: string): ArtefactAssociationRole {
  if (!ASSOCIATION_ROLES.has(value as ArtefactAssociationRole)) {
    throw new ArtefactValidationError(`association role '${value}' is not supported`);
  }
  return value as ArtefactAssociationRole;
}

function normalizeExtensionNamespace(value: string): `extension:${string}` {
  if (!EXTENSION_NAMESPACE_RE.test(value)) {
    throw new ArtefactValidationError(`annotation namespace '${value}' must identify an extension`);
  }
  return value as `extension:${string}`;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  return value ? JSON.parse(value) as T : fallback;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

type ArtefactCatalogueCursor = {
  created_at: string;
  artefact_id: string;
};

function encodeArtefactCatalogueCursor(artefact: Artefact): string {
  return Buffer.from(JSON.stringify({
    created_at: artefact.created_at,
    artefact_id: artefact.artefact_id,
  } satisfies ArtefactCatalogueCursor), "utf8").toString("base64url");
}

function decodeArtefactCatalogueCursor(value: string): ArtefactCatalogueCursor {
  try {
    const decoded = JSON.parse(Buffer.from(requireText(value, "catalogue cursor", 2048), "base64url").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("not an object");
    const record = decoded as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "created_at" && key !== "artefact_id")) {
      throw new Error("unexpected cursor field");
    }
    return {
      created_at: requireText(record.created_at, "catalogue cursor created_at", 128),
      artefact_id: requireText(record.artefact_id, "catalogue cursor artefact_id", 512),
    };
  } catch (error) {
    if (error instanceof ArtefactValidationError) throw error;
    throw new ArtefactValidationError("catalogue cursor is invalid");
  }
}

export function applyArtefactSchema(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS artefacts (
      artefact_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      type_ref TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (workspace_id, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_artefacts_workspace
      ON artefacts(workspace_id, created_at, artefact_id);

    CREATE TABLE IF NOT EXISTS artefact_versions (
      artefact_version_id TEXT PRIMARY KEY,
      artefact_id TEXT NOT NULL REFERENCES artefacts(artefact_id),
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      schema_ref TEXT,
      content_ref_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (artefact_id, ordinal),
      UNIQUE (artefact_id, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_artefact_versions_artefact
      ON artefact_versions(artefact_id, ordinal);

    CREATE TABLE IF NOT EXISTS artefact_lineage (
      lineage_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_version_id TEXT NOT NULL REFERENCES artefact_versions(artefact_version_id),
      relation_type TEXT NOT NULL,
      object_version_id TEXT NOT NULL REFERENCES artefact_versions(artefact_version_id),
      created_at TEXT NOT NULL,
      UNIQUE (subject_version_id, relation_type, object_version_id),
      CHECK (subject_version_id <> object_version_id)
    );

    CREATE INDEX IF NOT EXISTS idx_artefact_lineage_object
      ON artefact_lineage(object_version_id, relation_type);

    CREATE TABLE IF NOT EXISTS artefact_collection_members (
      collection_version_id TEXT NOT NULL REFERENCES artefact_versions(artefact_version_id),
      member_key TEXT NOT NULL,
      member_version_id TEXT NOT NULL REFERENCES artefact_versions(artefact_version_id),
      position INTEGER CHECK (position IS NULL OR position >= 0),
      created_at TEXT NOT NULL,
      PRIMARY KEY (collection_version_id, member_key),
      CHECK (collection_version_id <> member_version_id)
    );

    CREATE INDEX IF NOT EXISTS idx_artefact_collection_member
      ON artefact_collection_members(member_version_id);

    CREATE TABLE IF NOT EXISTS artefact_associations (
      association_id TEXT PRIMARY KEY,
      artefact_version_id TEXT NOT NULL REFERENCES artefact_versions(artefact_version_id),
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      role TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (artefact_version_id, target_kind, target_id, role),
      UNIQUE (artefact_version_id, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_artefact_associations_target
      ON artefact_associations(target_kind, target_id, role);

    CREATE TABLE IF NOT EXISTS artefact_annotations (
      annotation_id TEXT PRIMARY KEY,
      artefact_version_id TEXT NOT NULL REFERENCES artefact_versions(artefact_version_id),
      namespace TEXT NOT NULL,
      annotation_key TEXT NOT NULL,
      extension_package_version_ref TEXT NOT NULL,
      schema_ref TEXT,
      value_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (artefact_version_id, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_artefact_annotations_namespace
      ON artefact_annotations(artefact_version_id, namespace, annotation_key, created_at);

    CREATE TABLE IF NOT EXISTS legacy_artefact_import_evidence (
      legacy_import_id TEXT PRIMARY KEY,
      import_key TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      source_document TEXT NOT NULL,
      legacy_external_id TEXT,
      source_revision TEXT,
      content_identity TEXT,
      status TEXT NOT NULL CHECK (status IN ('unresolved', 'imported')),
      reason TEXT,
      artefact_id TEXT REFERENCES artefacts(artefact_id),
      artefact_version_id TEXT REFERENCES artefact_versions(artefact_version_id),
      evidence_json TEXT,
      request_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (workspace_id, import_key)
    );

    CREATE TRIGGER IF NOT EXISTS artefact_versions_immutable_update
    BEFORE UPDATE ON artefact_versions BEGIN
      SELECT RAISE(ABORT, 'ArtefactVersion is immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS artefact_versions_immutable_delete
    BEFORE DELETE ON artefact_versions BEGIN
      SELECT RAISE(ABORT, 'ArtefactVersion is immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS artefact_lineage_immutable_update
    BEFORE UPDATE ON artefact_lineage BEGIN
      SELECT RAISE(ABORT, 'Artefact lineage is immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS artefact_lineage_immutable_delete
    BEFORE DELETE ON artefact_lineage BEGIN
      SELECT RAISE(ABORT, 'Artefact lineage is immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS artefact_collection_members_immutable_update
    BEFORE UPDATE ON artefact_collection_members BEGIN
      SELECT RAISE(ABORT, 'Artefact collection membership is immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS artefact_collection_members_immutable_delete
    BEFORE DELETE ON artefact_collection_members BEGIN
      SELECT RAISE(ABORT, 'Artefact collection membership is immutable');
    END;
  `);
}

export class ArtefactStore {
  constructor(readonly db: DatabaseSync) {}

  createArtefact(input: {
    workspace_id: string;
    type_ref: string;
    idempotency_key: string;
    artefact_id?: string;
  }): Artefact {
    const workspaceId = requireText(input.workspace_id, "workspace_id", 512);
    const typeRef = requireText(input.type_ref, "type_ref", 1024);
    const idempotencyKey = requireIdempotencyKey(input.idempotency_key);
    const requestedId = input.artefact_id === undefined
      ? null
      : requireText(input.artefact_id, "artefact_id", 512);
    const requestFingerprint = fingerprint({
      workspace_id: workspaceId,
      type_ref: typeRef,
      artefact_id: requestedId,
    });

    return this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT * FROM artefacts WHERE workspace_id = ? AND idempotency_key = ?
      `).get(workspaceId, idempotencyKey) as any;
      if (existing) {
        if (String(existing.request_fingerprint) !== requestFingerprint) {
          throw new ArtefactIdempotencyConflictError(idempotencyKey);
        }
        return this.rowToArtefact(existing);
      }

      const artefactId = requestedId ?? `artefact_${randomUUID()}`;
      const conflictingId = this.getArtefact(artefactId);
      if (conflictingId) throw new ArtefactValidationError(`artefact_id '${artefactId}' already exists`);
      const timestamp = nowIso();
      this.db.prepare(`
        INSERT INTO artefacts (
          artefact_id, workspace_id, type_ref, idempotency_key, request_fingerprint, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(artefactId, workspaceId, typeRef, idempotencyKey, requestFingerprint, timestamp);
      return {
        artefact_id: artefactId,
        workspace_id: workspaceId,
        type_ref: typeRef,
        created_at: timestamp,
      };
    });
  }

  publishVersion(input: PublishArtefactVersionInput): ArtefactVersion {
    const artefactId = requireText(input.artefact_id, "artefact_id", 512);
    const idempotencyKey = requireIdempotencyKey(input.idempotency_key);
    const requestedVersionId = input.artefact_version_id === undefined
      ? null
      : requireText(input.artefact_version_id, "artefact_version_id", 512);
    const schemaRef = input.schema_ref === undefined || input.schema_ref === null
      ? null
      : requireText(input.schema_ref, "schema_ref", 2048);
    const contentRef = normalizeContentRef(input.content_ref);
    const lineage = this.normalizeLineageInputs(input.lineage ?? []);
    const members = this.normalizeMemberInputs(input.members ?? []);
    const associations = this.normalizeAssociationInputs(input.associations ?? []);
    const annotations = this.normalizeAnnotationInputs(input.annotations ?? []);
    const requestFingerprint = fingerprint({
      artefact_id: artefactId,
      artefact_version_id: requestedVersionId,
      schema_ref: schemaRef,
      content_ref: contentRef,
      lineage,
      members,
      associations,
      annotations,
    });

    return this.transaction(() => {
      const artefact = this.getArtefact(artefactId);
      if (!artefact) throw new ArtefactNotFoundError(artefactId);
      const existing = this.db.prepare(`
        SELECT * FROM artefact_versions WHERE artefact_id = ? AND idempotency_key = ?
      `).get(artefactId, idempotencyKey) as any;
      if (existing) {
        if (String(existing.request_fingerprint) !== requestFingerprint) {
          throw new ArtefactIdempotencyConflictError(idempotencyKey);
        }
        return this.rowToVersion(existing);
      }

      for (const relation of lineage) {
        const object = this.requireVersion(relation.object_version_id);
        this.requireSameWorkspace(artefact.workspace_id, object, `lineage object '${object.artefact_version_id}'`);
        if (relation.relation_type === "core:supersedes" && object.artefact_id !== artefactId) {
          throw new ArtefactValidationError("core:supersedes must relate versions of the same Artefact");
        }
      }
      for (const member of members) {
        const version = this.requireVersion(member.member_version_id);
        this.requireSameWorkspace(artefact.workspace_id, version, `collection member '${version.artefact_version_id}'`);
      }

      const versionId = requestedVersionId ?? `artefact_version_${randomUUID()}`;
      if (this.getVersion(versionId)) throw new ArtefactValidationError(`artefact_version_id '${versionId}' already exists`);
      if (lineage.some((relation) => relation.object_version_id === versionId)) {
        throw new ArtefactValidationError("ArtefactVersion cannot have lineage to itself");
      }
      if (members.some((member) => member.member_version_id === versionId)) {
        throw new ArtefactValidationError("ArtefactVersion cannot contain itself");
      }
      const ordinal = Number((this.db.prepare(`
        SELECT COALESCE(MAX(ordinal), 0) + 1 AS next
        FROM artefact_versions WHERE artefact_id = ?
      `).get(artefactId) as { next: number }).next);
      const timestamp = nowIso();
      this.db.prepare(`
        INSERT INTO artefact_versions (
          artefact_version_id, artefact_id, ordinal, schema_ref, content_ref_json,
          idempotency_key, request_fingerprint, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        versionId,
        artefactId,
        ordinal,
        schemaRef,
        canonicalJson(normalizeJsonValue(contentRef)),
        idempotencyKey,
        requestFingerprint,
        timestamp,
      );

      const insertLineage = this.db.prepare(`
        INSERT INTO artefact_lineage (
          lineage_id, workspace_id, subject_version_id, relation_type, object_version_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const relation of lineage) {
        insertLineage.run(
          `lineage_${randomUUID()}`,
          artefact.workspace_id,
          versionId,
          relation.relation_type,
          relation.object_version_id,
          timestamp,
        );
      }

      const insertMember = this.db.prepare(`
        INSERT INTO artefact_collection_members (
          collection_version_id, member_key, member_version_id, position, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const member of members) {
        insertMember.run(versionId, member.member_key, member.member_version_id, member.position, timestamp);
      }

      for (const [index, association] of associations.entries()) {
        this.insertAssociation({
          artefact_version_id: versionId,
          idempotency_key: `publish:${versionId}:association:${index}`,
          ...association,
        }, timestamp);
      }
      for (const [index, annotation] of annotations.entries()) {
        this.insertAnnotation({
          artefact_version_id: versionId,
          idempotency_key: `publish:${versionId}:annotation:${index}`,
          ...annotation,
        }, timestamp);
      }

      return this.requireVersion(versionId);
    });
  }

  associateVersion(input: {
    artefact_version_id: string;
    target_kind: ArtefactAssociationTargetKind;
    target_id: string;
    role: ArtefactAssociationRole;
    idempotency_key: string;
  }): ArtefactAssociation {
    this.requireVersion(requireText(input.artefact_version_id, "artefact_version_id", 512));
    return this.transaction(() => this.insertAssociation({
      artefact_version_id: input.artefact_version_id,
      target_kind: normalizeAssociationTargetKind(input.target_kind),
      target_id: requireText(input.target_id, "association target_id", 1024),
      role: normalizeAssociationRole(input.role),
      idempotency_key: requireIdempotencyKey(input.idempotency_key),
    }, nowIso()));
  }

  annotateVersion(input: {
    artefact_version_id: string;
    namespace: `extension:${string}`;
    key: string;
    extension_package_version_ref: string;
    schema_ref?: string | null;
    value: JsonValue;
    idempotency_key: string;
  }): ArtefactAnnotation {
    this.requireVersion(requireText(input.artefact_version_id, "artefact_version_id", 512));
    return this.transaction(() => this.insertAnnotation({
      artefact_version_id: input.artefact_version_id,
      namespace: normalizeExtensionNamespace(input.namespace),
      key: requireText(input.key, "annotation key", 512),
      extension_package_version_ref: requireText(
        input.extension_package_version_ref,
        "annotation extension_package_version_ref",
        1024,
      ),
      schema_ref: input.schema_ref === undefined || input.schema_ref === null
        ? null
        : requireText(input.schema_ref, "annotation schema_ref", 2048),
      value: normalizeJsonValue(input.value, "annotation value"),
      idempotency_key: requireIdempotencyKey(input.idempotency_key),
    }, nowIso()));
  }

  recordLegacyImportEvidence(input: {
    workspace_id: string;
    source_document: string;
    legacy_external_id?: string | null;
    source_revision?: string | null;
    content_identity?: string | null;
    evidence?: JsonValue | null;
    outcome:
      | { status: "unresolved"; reason: string }
      | { status: "imported"; artefact_id: string; artefact_version_id: string };
  }): LegacyArtefactImportEvidence {
    const workspaceId = requireText(input.workspace_id, "workspace_id", 512);
    const sourceDocument = normalizeWorkspaceRelativePath(input.source_document);
    const legacyExternalId = input.legacy_external_id === undefined || input.legacy_external_id === null
      ? null
      : requireText(input.legacy_external_id, "legacy_external_id", 2048);
    const sourceRevision = input.source_revision === undefined || input.source_revision === null
      ? null
      : requireText(input.source_revision, "source_revision", 1024);
    const contentIdentity = input.content_identity === undefined || input.content_identity === null
      ? null
      : requireText(input.content_identity, "content_identity", 2048);
    const evidence = input.evidence === undefined || input.evidence === null
      ? null
      : normalizeJsonValue(input.evidence, "legacy import evidence");
    const outcome = input.outcome.status === "unresolved"
      ? {
          status: "unresolved" as const,
          reason: requireText(input.outcome.reason, "legacy import reason", 4096),
          artefact_id: null,
          artefact_version_id: null,
        }
      : {
          status: "imported" as const,
          reason: null,
          artefact_id: requireText(input.outcome.artefact_id, "legacy imported artefact_id", 512),
          artefact_version_id: requireText(input.outcome.artefact_version_id, "legacy imported artefact_version_id", 512),
        };
    const importKey = fingerprint({
      workspace_id: workspaceId,
      source_document: sourceDocument,
      legacy_external_id: legacyExternalId,
      source_revision: sourceRevision,
      content_identity: contentIdentity,
    });
    const requestFingerprint = fingerprint({
      workspace_id: workspaceId,
      source_document: sourceDocument,
      legacy_external_id: legacyExternalId,
      source_revision: sourceRevision,
      content_identity: contentIdentity,
      evidence,
      outcome,
    });

    return this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT * FROM legacy_artefact_import_evidence WHERE workspace_id = ? AND import_key = ?
      `).get(workspaceId, importKey) as any;
      if (existing) {
        if (String(existing.request_fingerprint) !== requestFingerprint) {
          throw new ArtefactIdempotencyConflictError(importKey);
        }
        return this.rowToLegacyImport(existing);
      }

      if (outcome.status === "imported") {
        const artefact = this.getArtefact(outcome.artefact_id);
        if (!artefact) throw new ArtefactNotFoundError(outcome.artefact_id);
        const version = this.requireVersion(outcome.artefact_version_id);
        if (artefact.workspace_id !== workspaceId || version.artefact_id !== artefact.artefact_id) {
          throw new ArtefactWorkspaceMismatchError("legacy import target is not the requested workspace and Artefact");
        }
      }

      const id = `legacy_import_${randomUUID()}`;
      const timestamp = nowIso();
      this.db.prepare(`
        INSERT INTO legacy_artefact_import_evidence (
          legacy_import_id, import_key, workspace_id, source_document, legacy_external_id,
          source_revision, content_identity, status, reason, artefact_id,
          artefact_version_id, evidence_json, request_fingerprint, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        importKey,
        workspaceId,
        sourceDocument,
        legacyExternalId,
        sourceRevision,
        contentIdentity,
        outcome.status,
        outcome.reason,
        outcome.artefact_id,
        outcome.artefact_version_id,
        evidence === null ? null : canonicalJson(evidence),
        requestFingerprint,
        timestamp,
      );
      return this.getLegacyImport(id) as LegacyArtefactImportEvidence;
    });
  }

  getArtefact(artefactId: string): Artefact | null {
    const row = this.db.prepare(`SELECT * FROM artefacts WHERE artefact_id = ?`).get(artefactId) as any;
    return row ? this.rowToArtefact(row) : null;
  }

  listArtefacts(workspaceId: string): Artefact[] {
    const rows = this.db.prepare(`
      SELECT * FROM artefacts WHERE workspace_id = ? ORDER BY created_at, artefact_id
    `).all(workspaceId) as any[];
    return rows.map((row) => this.rowToArtefact(row));
  }

  /**
   * Stable, bounded Workspace catalogue. It returns logical Artefacts only;
   * callers select exact branch heads or retained versions separately.
   */
  searchArtefacts(input: ArtefactCatalogueQuery): ArtefactCataloguePage {
    const workspaceId = requireText(input.workspace_id, "workspace_id", 512);
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ArtefactValidationError("catalogue limit must be an integer from 1 to 100");
    }

    const conditions = ["artefact.workspace_id = ?"];
    const values: Array<string | number> = [workspaceId];
    if (input.query !== undefined) {
      const query = requireText(input.query.trim(), "catalogue query", 512).toLowerCase();
      const like = `%${escapeLike(query)}%`;
      conditions.push(`(
        LOWER(artefact.artefact_id) LIKE ? ESCAPE '\\'
        OR LOWER(artefact.type_ref) LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM artefact_versions matching_version
          WHERE matching_version.artefact_id = artefact.artefact_id
            AND LOWER(matching_version.artefact_version_id) LIKE ? ESCAPE '\\'
        )
      )`);
      values.push(like, like, like);
    }
    if (input.type_ref !== undefined) {
      conditions.push("artefact.type_ref = ?");
      values.push(requireText(input.type_ref, "catalogue type_ref", 1024));
    }
    if (input.association !== undefined) {
      const targetKind = normalizeAssociationTargetKind(input.association.target_kind);
      const targetId = requireText(input.association.target_id, "catalogue association target_id", 1024);
      const role = input.association.role === undefined
        ? null
        : normalizeAssociationRole(input.association.role);
      conditions.push(`EXISTS (
        SELECT 1
        FROM artefact_versions associated_version
        JOIN artefact_associations association
          ON association.artefact_version_id = associated_version.artefact_version_id
        WHERE associated_version.artefact_id = artefact.artefact_id
          AND association.target_kind = ?
          AND association.target_id = ?
          ${role === null ? "" : "AND association.role = ?"}
      )`);
      values.push(targetKind, targetId);
      if (role !== null) values.push(role);
    }
    if (input.after !== undefined) {
      const cursor = decodeArtefactCatalogueCursor(input.after);
      conditions.push("(artefact.created_at < ? OR (artefact.created_at = ? AND artefact.artefact_id < ?))");
      values.push(cursor.created_at, cursor.created_at, cursor.artefact_id);
    }

    const rows = this.db.prepare(`
      SELECT artefact.*
      FROM artefacts artefact
      WHERE ${conditions.join(" AND ")}
      ORDER BY artefact.created_at DESC, artefact.artefact_id DESC
      LIMIT ?
    `).all(...values, limit + 1) as any[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const artefacts = pageRows.map((row) => this.rowToArtefact(row));
    const finalArtefact = artefacts.at(-1);
    return {
      artefacts,
      next_cursor: hasMore && finalArtefact
        ? encodeArtefactCatalogueCursor(finalArtefact)
        : null,
    };
  }

  getVersion(versionId: string): ArtefactVersion | null {
    const row = this.db.prepare(`SELECT * FROM artefact_versions WHERE artefact_version_id = ?`).get(versionId) as any;
    return row ? this.rowToVersion(row) : null;
  }

  listVersions(artefactId: string): ArtefactVersion[] {
    const rows = this.db.prepare(`
      SELECT * FROM artefact_versions WHERE artefact_id = ? ORDER BY ordinal
    `).all(artefactId) as any[];
    return rows.map((row) => this.rowToVersion(row));
  }

  /** There is deliberately no universal mutable "current version" pointer. */
  listHeads(artefactId: string): ArtefactVersion[] {
    const rows = this.db.prepare(`
      SELECT candidate.*
      FROM artefact_versions candidate
      WHERE candidate.artefact_id = ?
        AND NOT EXISTS (
          SELECT 1
          FROM artefact_lineage lineage
          JOIN artefact_versions successor
            ON successor.artefact_version_id = lineage.subject_version_id
          WHERE lineage.relation_type = 'core:supersedes'
            AND lineage.object_version_id = candidate.artefact_version_id
            AND successor.artefact_id = candidate.artefact_id
        )
      ORDER BY candidate.ordinal
    `).all(artefactId) as any[];
    return rows.map((row) => this.rowToVersion(row));
  }

  listLineageFrom(subjectVersionId: string): ArtefactLineage[] {
    const rows = this.db.prepare(`
      SELECT * FROM artefact_lineage
      WHERE subject_version_id = ? ORDER BY created_at, lineage_id
    `).all(subjectVersionId) as any[];
    return rows.map((row) => this.rowToLineage(row));
  }

  listLineageTo(objectVersionId: string): ArtefactLineage[] {
    const rows = this.db.prepare(`
      SELECT * FROM artefact_lineage
      WHERE object_version_id = ? ORDER BY created_at, lineage_id
    `).all(objectVersionId) as any[];
    return rows.map((row) => this.rowToLineage(row));
  }

  listCollectionMembers(collectionVersionId: string): ArtefactCollectionMember[] {
    const rows = this.db.prepare(`
      SELECT * FROM artefact_collection_members
      WHERE collection_version_id = ?
      ORDER BY CASE WHEN position IS NULL THEN 1 ELSE 0 END, position, member_key
    `).all(collectionVersionId) as any[];
    return rows.map((row) => ({
      collection_version_id: String(row.collection_version_id),
      member_key: String(row.member_key),
      member_version_id: String(row.member_version_id),
      position: row.position === null ? null : Number(row.position),
      created_at: String(row.created_at),
    }));
  }

  listAssociations(versionId: string): ArtefactAssociation[] {
    const rows = this.db.prepare(`
      SELECT * FROM artefact_associations
      WHERE artefact_version_id = ? ORDER BY created_at, association_id
    `).all(versionId) as any[];
    return rows.map((row) => this.rowToAssociation(row));
  }

  listAnnotations(versionId: string): ArtefactAnnotation[] {
    const rows = this.db.prepare(`
      SELECT * FROM artefact_annotations
      WHERE artefact_version_id = ? ORDER BY created_at, annotation_id
    `).all(versionId) as any[];
    return rows.map((row) => this.rowToAnnotation(row));
  }

  getLegacyImport(id: string): LegacyArtefactImportEvidence | null {
    const row = this.db.prepare(`
      SELECT * FROM legacy_artefact_import_evidence WHERE legacy_import_id = ?
    `).get(id) as any;
    return row ? this.rowToLegacyImport(row) : null;
  }

  listLegacyImports(workspaceId: string): LegacyArtefactImportEvidence[] {
    const rows = this.db.prepare(`
      SELECT * FROM legacy_artefact_import_evidence
      WHERE workspace_id = ? ORDER BY created_at, legacy_import_id
    `).all(workspaceId) as any[];
    return rows.map((row) => this.rowToLegacyImport(row));
  }

  private normalizeLineageInputs(
    values: NonNullable<PublishArtefactVersionInput["lineage"]>,
  ): NonNullable<PublishArtefactVersionInput["lineage"]> {
    const normalized = values.map((value) => ({
      relation_type: normalizeLineageType(value.relation_type),
      object_version_id: requireText(value.object_version_id, "lineage object_version_id", 512),
    }));
    this.requireUnique(
      normalized.map((value) => `${value.relation_type}\u0000${value.object_version_id}`),
      "lineage relation",
    );
    return normalized.sort((left, right) =>
      `${left.relation_type}\u0000${left.object_version_id}`.localeCompare(`${right.relation_type}\u0000${right.object_version_id}`));
  }

  private normalizeMemberInputs(
    values: NonNullable<PublishArtefactVersionInput["members"]>,
  ): Array<{ member_key: string; member_version_id: string; position: number | null }> {
    const normalized = values.map((value) => {
      const position = value.position === undefined || value.position === null ? null : value.position;
      if (position !== null && (!Number.isSafeInteger(position) || position < 0)) {
        throw new ArtefactValidationError("collection member position must be a non-negative safe integer");
      }
      return {
        member_key: requireText(value.member_key, "collection member_key", 1024),
        member_version_id: requireText(value.member_version_id, "collection member_version_id", 512),
        position,
      };
    });
    this.requireUnique(normalized.map((value) => value.member_key), "collection member_key");
    this.requireUnique(
      normalized.filter((value) => value.position !== null).map((value) => String(value.position)),
      "collection member position",
    );
    return normalized.sort((left, right) => {
      if (left.position !== null && right.position !== null) return left.position - right.position;
      if (left.position !== null) return -1;
      if (right.position !== null) return 1;
      return left.member_key.localeCompare(right.member_key);
    });
  }

  private normalizeAssociationInputs(
    values: NonNullable<PublishArtefactVersionInput["associations"]>,
  ): NonNullable<PublishArtefactVersionInput["associations"]> {
    const normalized = values.map((value) => ({
      target_kind: normalizeAssociationTargetKind(value.target_kind),
      target_id: requireText(value.target_id, "association target_id", 1024),
      role: normalizeAssociationRole(value.role),
    }));
    this.requireUnique(
      normalized.map((value) => `${value.target_kind}\u0000${value.target_id}\u0000${value.role}`),
      "association",
    );
    return normalized.sort((left, right) =>
      `${left.target_kind}\u0000${left.target_id}\u0000${left.role}`
        .localeCompare(`${right.target_kind}\u0000${right.target_id}\u0000${right.role}`));
  }

  private normalizeAnnotationInputs(
    values: NonNullable<PublishArtefactVersionInput["annotations"]>,
  ): Array<{
    namespace: `extension:${string}`;
    key: string;
    extension_package_version_ref: string;
    schema_ref: string | null;
    value: JsonValue;
  }> {
    const normalized = values.map((value) => ({
      namespace: normalizeExtensionNamespace(value.namespace),
      key: requireText(value.key, "annotation key", 512),
      extension_package_version_ref: requireText(
        value.extension_package_version_ref,
        "annotation extension_package_version_ref",
        1024,
      ),
      schema_ref: value.schema_ref === undefined || value.schema_ref === null
        ? null
        : requireText(value.schema_ref, "annotation schema_ref", 2048),
      value: normalizeJsonValue(value.value, "annotation value"),
    }));
    this.requireUnique(
      normalized.map((value) => `${value.namespace}\u0000${value.key}`),
      "annotation namespace/key",
    );
    return normalized.sort((left, right) =>
      `${left.namespace}\u0000${left.key}`.localeCompare(`${right.namespace}\u0000${right.key}`));
  }

  private insertAssociation(
    input: {
      artefact_version_id: string;
      target_kind: ArtefactAssociationTargetKind;
      target_id: string;
      role: ArtefactAssociationRole;
      idempotency_key: string;
    },
    timestamp: string,
  ): ArtefactAssociation {
    const requestFingerprint = fingerprint({
      artefact_version_id: input.artefact_version_id,
      target_kind: input.target_kind,
      target_id: input.target_id,
      role: input.role,
    });
    const existingByKey = this.db.prepare(`
      SELECT * FROM artefact_associations
      WHERE artefact_version_id = ? AND idempotency_key = ?
    `).get(input.artefact_version_id, input.idempotency_key) as any;
    if (existingByKey) {
      if (String(existingByKey.request_fingerprint) !== requestFingerprint) {
        throw new ArtefactIdempotencyConflictError(input.idempotency_key);
      }
      return this.rowToAssociation(existingByKey);
    }
    const existingFact = this.db.prepare(`
      SELECT * FROM artefact_associations
      WHERE artefact_version_id = ? AND target_kind = ? AND target_id = ? AND role = ?
    `).get(input.artefact_version_id, input.target_kind, input.target_id, input.role) as any;
    if (existingFact) return this.rowToAssociation(existingFact);

    const id = `artefact_association_${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO artefact_associations (
        association_id, artefact_version_id, target_kind, target_id, role,
        idempotency_key, request_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.artefact_version_id,
      input.target_kind,
      input.target_id,
      input.role,
      input.idempotency_key,
      requestFingerprint,
      timestamp,
    );
    return this.listAssociations(input.artefact_version_id).find((value) => value.association_id === id) as ArtefactAssociation;
  }

  private insertAnnotation(
    input: {
      artefact_version_id: string;
      namespace: `extension:${string}`;
      key: string;
      extension_package_version_ref: string;
      schema_ref: string | null;
      value: JsonValue;
      idempotency_key: string;
    },
    timestamp: string,
  ): ArtefactAnnotation {
    const requestFingerprint = fingerprint({
      artefact_version_id: input.artefact_version_id,
      namespace: input.namespace,
      key: input.key,
      extension_package_version_ref: input.extension_package_version_ref,
      schema_ref: input.schema_ref,
      value: input.value,
    });
    const existing = this.db.prepare(`
      SELECT * FROM artefact_annotations
      WHERE artefact_version_id = ? AND idempotency_key = ?
    `).get(input.artefact_version_id, input.idempotency_key) as any;
    if (existing) {
      if (String(existing.request_fingerprint) !== requestFingerprint) {
        throw new ArtefactIdempotencyConflictError(input.idempotency_key);
      }
      return this.rowToAnnotation(existing);
    }

    const id = `artefact_annotation_${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO artefact_annotations (
        annotation_id, artefact_version_id, namespace, annotation_key,
        extension_package_version_ref, schema_ref, value_json,
        idempotency_key, request_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.artefact_version_id,
      input.namespace,
      input.key,
      input.extension_package_version_ref,
      input.schema_ref,
      canonicalJson(input.value),
      input.idempotency_key,
      requestFingerprint,
      timestamp,
    );
    return this.listAnnotations(input.artefact_version_id).find((value) => value.annotation_id === id) as ArtefactAnnotation;
  }

  private requireVersion(versionId: string): ArtefactVersion {
    const version = this.getVersion(versionId);
    if (!version) throw new ArtefactVersionNotFoundError(versionId);
    return version;
  }

  private requireSameWorkspace(workspaceId: string, version: ArtefactVersion, label: string): void {
    const artefact = this.getArtefact(version.artefact_id);
    if (!artefact || artefact.workspace_id !== workspaceId) {
      throw new ArtefactWorkspaceMismatchError(`${label} is outside workspace '${workspaceId}'`);
    }
  }

  private requireUnique(values: string[], label: string): void {
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value)) throw new ArtefactValidationError(`duplicate ${label} '${value.replace(/\u0000/g, "/")}'`);
      seen.add(value);
    }
  }

  private rowToArtefact(row: any): Artefact {
    return {
      artefact_id: String(row.artefact_id),
      workspace_id: String(row.workspace_id),
      type_ref: String(row.type_ref),
      created_at: String(row.created_at),
    };
  }

  private rowToVersion(row: any): ArtefactVersion {
    return {
      artefact_version_id: String(row.artefact_version_id),
      artefact_id: String(row.artefact_id),
      ordinal: Number(row.ordinal),
      schema_ref: row.schema_ref === null ? null : String(row.schema_ref),
      content_ref: parseJson<ContentRef>(String(row.content_ref_json), {} as ContentRef),
      created_at: String(row.created_at),
    };
  }

  private rowToLineage(row: any): ArtefactLineage {
    return {
      lineage_id: String(row.lineage_id),
      workspace_id: String(row.workspace_id),
      subject_version_id: String(row.subject_version_id),
      relation_type: row.relation_type as ArtefactLineageType,
      object_version_id: String(row.object_version_id),
      created_at: String(row.created_at),
    };
  }

  private rowToAssociation(row: any): ArtefactAssociation {
    return {
      association_id: String(row.association_id),
      artefact_version_id: String(row.artefact_version_id),
      target_kind: row.target_kind as ArtefactAssociationTargetKind,
      target_id: String(row.target_id),
      role: row.role as ArtefactAssociationRole,
      created_at: String(row.created_at),
    };
  }

  private rowToAnnotation(row: any): ArtefactAnnotation {
    return {
      annotation_id: String(row.annotation_id),
      artefact_version_id: String(row.artefact_version_id),
      namespace: row.namespace as `extension:${string}`,
      key: String(row.annotation_key),
      extension_package_version_ref: String(row.extension_package_version_ref),
      schema_ref: row.schema_ref === null ? null : String(row.schema_ref),
      value: parseJson<JsonValue>(String(row.value_json), null),
      created_at: String(row.created_at),
    };
  }

  private rowToLegacyImport(row: any): LegacyArtefactImportEvidence {
    return {
      legacy_import_id: String(row.legacy_import_id),
      import_key: String(row.import_key),
      workspace_id: String(row.workspace_id),
      source_document: String(row.source_document),
      legacy_external_id: row.legacy_external_id === null ? null : String(row.legacy_external_id),
      source_revision: row.source_revision === null ? null : String(row.source_revision),
      content_identity: row.content_identity === null ? null : String(row.content_identity),
      status: row.status === "imported" ? "imported" : "unresolved",
      reason: row.reason === null ? null : String(row.reason),
      artefact_id: row.artefact_id === null ? null : String(row.artefact_id),
      artefact_version_id: row.artefact_version_id === null ? null : String(row.artefact_version_id),
      evidence: row.evidence_json === null ? null : parseJson<JsonValue>(String(row.evidence_json), null),
      created_at: String(row.created_at),
    };
  }

  private transaction<T>(fn: () => T): T {
    const savepoint = `artefact_${randomUUID().replace(/-/g, "")}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = fn();
      this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }
}
