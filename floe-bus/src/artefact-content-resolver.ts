import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

import { ArtefactStore, type WorkspaceRelativeContentRef } from "./artefacts.js";
import { resolveWithinRoot } from "./fs/resolveWithinRoot.js";

export const MAX_ARTEFACT_CONTENT_BYTES = 20 * 1024 * 1024;

export type ResolvedArtefactVersionContent = {
  artefact_version_id: string;
  media_type: string;
  digest: { algorithm: "sha256"; value: string };
  size_bytes: number;
  bytes: Buffer;
};

export class ArtefactContentNotFoundError extends Error {
  readonly code = "artefact_content_not_found" as const;
  constructor() {
    super("The exact ArtefactVersion content is not available in this Workspace.");
    this.name = "ArtefactContentNotFoundError";
  }
}

export class ArtefactContentUnresolvedError extends Error {
  readonly code = "artefact_content_unresolved" as const;
  constructor(readonly resolver_id: string) {
    super("This exact ArtefactVersion requires a content resolver that is not available on this host.");
    this.name = "ArtefactContentUnresolvedError";
  }
}

export class ArtefactContentMismatchError extends Error {
  readonly code = "artefact_content_mismatch" as const;
  constructor(readonly reason: "digest" | "size") {
    super("The Workspace file does not match the required content identity. Floe will not substitute different bytes.");
    this.name = "ArtefactContentMismatchError";
  }
}

export class ArtefactContentTooLargeError extends Error {
  readonly code = "artefact_content_too_large" as const;
  constructor() {
    super("The exact ArtefactVersion content is too large to transfer through this preview surface.");
    this.name = "ArtefactContentTooLargeError";
  }
}

/**
 * Resolve the bytes named by one exact ArtefactVersion. A workspace-relative
 * path is only a hint: its bytes must still match the immutable digest before
 * they may be returned to any client.
 */
export function resolveArtefactVersionContent(input: {
  store: ArtefactStore;
  workspace_id: string;
  workspace_locator: string;
  artefact_version_id: string;
  maximum_bytes?: number;
}): ResolvedArtefactVersionContent {
  const version = input.store.getVersion(input.artefact_version_id);
  const artefact = version ? input.store.getArtefact(version.artefact_id) : null;
  if (!version || !artefact || artefact.workspace_id !== input.workspace_id) {
    throw new ArtefactContentNotFoundError();
  }
  if (version.content_ref.kind !== "workspace-relative") {
    throw new ArtefactContentUnresolvedError(version.content_ref.resolver_id);
  }

  return {
    artefact_version_id: version.artefact_version_id,
    ...resolveWorkspaceArtefactContent({
      workspace_locator: input.workspace_locator,
      content_ref: version.content_ref,
      maximum_bytes: input.maximum_bytes,
    }),
  };
}

/** Read and verify one local content reference before publication or transfer. */
export function resolveWorkspaceArtefactContent(input: {
  workspace_locator: string;
  content_ref: WorkspaceRelativeContentRef;
  maximum_bytes?: number;
}): Omit<ResolvedArtefactVersionContent, "artefact_version_id"> {
  const contentRef = input.content_ref;

  let resolved: string;
  try {
    resolved = resolveWithinRoot(input.workspace_locator, contentRef.path);
  } catch {
    throw new ArtefactContentNotFoundError();
  }

  const maximumBytes = input.maximum_bytes ?? MAX_ARTEFACT_CONTENT_BYTES;
  let fileSize: number;
  try {
    const stat = statSync(resolved);
    if (!stat.isFile()) throw new ArtefactContentNotFoundError();
    fileSize = stat.size;
  } catch (error) {
    if (error instanceof ArtefactContentNotFoundError) throw error;
    throw new ArtefactContentNotFoundError();
  }
  if (fileSize > maximumBytes) throw new ArtefactContentTooLargeError();
  if (contentRef.size_bytes != null && contentRef.size_bytes !== fileSize) {
    throw new ArtefactContentMismatchError("size");
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(resolved);
  } catch {
    throw new ArtefactContentNotFoundError();
  }
  if (bytes.length > maximumBytes) throw new ArtefactContentTooLargeError();
  if (contentRef.size_bytes != null && contentRef.size_bytes !== bytes.length) {
    throw new ArtefactContentMismatchError("size");
  }
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  if (actualDigest !== contentRef.digest.value) {
    throw new ArtefactContentMismatchError("digest");
  }

  return {
    media_type: safeMediaType(contentRef),
    digest: contentRef.digest,
    size_bytes: bytes.length,
    bytes,
  };
}

function safeMediaType(contentRef: WorkspaceRelativeContentRef): string {
  const declared = contentRef.media_type?.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (SAFE_MEDIA_TYPES.has(declared)) return declared;
  return MEDIA_TYPE_BY_EXTENSION.get(extname(contentRef.path).toLowerCase()) ?? "application/octet-stream";
}

const SAFE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
  "text/html",
  "text/markdown",
  "text/csv",
  "application/json",
  "model/gltf-binary",
]);

const MEDIA_TYPE_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".txt", "text/plain"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".md", "text/markdown"],
  [".csv", "text/csv"],
  [".json", "application/json"],
  [".glb", "model/gltf-binary"],
]);
