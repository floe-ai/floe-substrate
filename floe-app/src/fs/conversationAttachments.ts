import { isTauri } from "./workspaceFs.ts";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

export type ConversationAttachment = {
  artefact_version_id: string | null;
  /** Legacy staged attachment reference retained only to render existing history. */
  path: string | null;
  name: string;
  media_type: string;
  bytes: number;
};

export type ConversationAttachmentIngress = {
  ingress_session_id: string;
  workspace_id: string;
  context_id: string;
  name: string;
  media_type: string;
  size_bytes: number;
  digest: { algorithm: "sha256"; value: string };
};

export function conversationAttachments(
  content: Record<string, unknown> | null | undefined,
  versionIds?: readonly string[],
  labels?: ReadonlyMap<string, string>,
): ConversationAttachment[] {
  const value = content?.["attachments"];
  const display: ConversationAttachment[] = (Array.isArray(value) ? value : []).flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Record<string, unknown>;
    const artefactVersionId = typeof candidate["artefact_version_id"] === "string"
      ? candidate["artefact_version_id"]
      : null;
    const path = typeof candidate["path"] === "string" ? candidate["path"] : null;
    if ((!artefactVersionId && !path) || typeof candidate["name"] !== "string") return [];
    return [{
      artefact_version_id: artefactVersionId,
      path,
      name: candidate["name"],
      media_type: typeof candidate["media_type"] === "string"
        ? candidate["media_type"]
        : "application/octet-stream",
      bytes: typeof candidate["bytes"] === "number" ? candidate["bytes"] : 0,
    }];
  });
  if (versionIds === undefined) return display;
  const canonicalIds = [...new Set(versionIds)];
  return [
    ...canonicalIds.map((id, index) => display.find(item => item.artefact_version_id === id) ?? {
      artefact_version_id: id, path: null,
      name: labels?.get(id) ?? (canonicalIds.length === 1 ? "Saved result" : `Saved result ${index + 1}`),
      media_type: "application/octet-stream", bytes: 0,
    }),
    ...display.filter(item => item.artefact_version_id === null),
  ];
}

export async function uploadConversationAttachments(
  workspaceId: string,
  contextId: string,
  files: File[],
): Promise<ConversationAttachmentIngress[]> {
  if (files.length === 0) return [];
  if (!isTauri()) {
    throw new Error("File attachments are available in the Floe desktop app.");
  }
  if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error(`Attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files at a time.`);
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return Promise.all(files.map(async file => {
    if (file.size === 0) throw new Error(`${file.name} is empty.`);
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} exceeds the 20MB attachment limit.`);
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    return invoke<ConversationAttachmentIngress>("upload_context_attachment", {
      workspaceId,
      contextId,
      fileName: file.name,
      mediaType: file.type || "application/octet-stream",
      bytes,
    });
  }));
}

export function formatAttachmentBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
