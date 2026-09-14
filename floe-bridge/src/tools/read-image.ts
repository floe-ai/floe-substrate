/** Workspace-scoped image input for vision-capable model actors. */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { readFile, stat } from "node:fs/promises";
import { extname, relative } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { safeWorkspacePath } from "./path-scoping.js";
import type { ToolContext } from "./types.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 64 * 1024 * 1024;
const PREVIEW_EDGE = 1536;
const MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

export function createReadImageTool(ctx: ToolContext): AgentTool {
  return {
    name: "read_image",
    label: "Inspect Image",
    description:
      "Inspect a workspace image through a preview of at most 1536 pixels per side; the source file is unchanged. " +
      "Supports PNG, JPEG, GIF and WebP up to 20MB and 64 megapixels. Animated images show their first frame. " +
      "Returns original dimensions and SHA-256 with preview dimensions. Paths must stay inside the workspace.",
    parameters: Type.Object({
      path: Type.String({ description: "Image path relative to the workspace root" }),
    }),
    execute: async (toolCallId, params: any) => {
      const startedAt = Date.now();
      const requestedPath = String(params?.path ?? "");
      const resolved = safeWorkspacePath(ctx.workspaceRoot, requestedPath);
      if (!resolved.ok) {
        enrichToolActivity(ctx, toolCallId, `read_image ${requestedPath} — path rejected`, true, [], startedAt);
        return { content: [{ type: "text", text: resolved.error }], details: { ok: false } };
      }

      const mimeType = MIME_BY_EXTENSION.get(extname(resolved.path).toLowerCase());
      if (!mimeType) {
        enrichToolActivity(ctx, toolCallId, `read_image ${requestedPath} — unsupported type`, true, [], startedAt);
        return {
          content: [{ type: "text", text: "Unsupported image type. Use PNG, JPEG, GIF or WebP." }],
          details: { ok: false, error: "unsupported_image_type" },
        };
      }

      try {
        const fileStat = await stat(resolved.path);
        if (!fileStat.isFile()) {
          enrichToolActivity(ctx, toolCallId, `read_image ${requestedPath} — not a file`, true, [], startedAt);
          return { content: [{ type: "text", text: `'${requestedPath}' is not a file.` }], details: { ok: false } };
        }
        if (fileStat.size > MAX_IMAGE_BYTES) {
          enrichToolActivity(ctx, toolCallId, `read_image ${requestedPath} — too large`, true, [], startedAt);
          return {
            content: [{ type: "text", text: "Image exceeds the 20MB inspection source limit. Prepare a smaller copy for inspection; preserve the original." }],
            details: { ok: false, error: "image_too_large", bytes: fileStat.size },
          };
        }

        const image = await readFile(resolved.path);
        const decoder = sharp(image, { limitInputPixels: MAX_SOURCE_PIXELS, pages: 1 });
        const metadata = await decoder.metadata();
        if (!["png", "jpeg", "gif", "webp"].includes(metadata.format ?? "")) {
          throw new Error("The file content is not a supported PNG, JPEG, GIF or WebP image.");
        }
        const preview = await decoder.rotate()
          .resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: "inside", withoutEnlargement: true })
          .png().timeout({ seconds: 15 }).toBuffer({ resolveWithObject: true });
        const relPath = relative(ctx.workspaceRoot, resolved.path);
        const identity = {
          original_width: metadata.width, original_height: metadata.height,
          original_sha256: createHash("sha256").update(image).digest("hex"),
          preview_width: preview.info.width, preview_height: preview.info.height,
          preview_bytes: preview.data.length, first_frame_only: (metadata.pages ?? 1) > 1,
        };
        enrichToolActivity(ctx, toolCallId, `read_image ${relPath} (${preview.info.width}×${preview.info.height} preview)`, false, [relPath], startedAt);
        return {
          content: [
            { type: "text", text: `Workspace image preview: ${relPath}. Original file unchanged. ${JSON.stringify(identity)}` },
            { type: "image", data: preview.data.toString("base64"), mimeType: "image/png" },
          ],
          details: { ok: true, path: relPath, bytes: image.length, mime_type: "image/png", ...identity },
        };
      } catch (error: any) {
        const message = error?.code === "ENOENT"
          ? `Image not found: '${requestedPath}'`
          : `Error reading image '${requestedPath}': ${error?.message ?? String(error)}`;
        enrichToolActivity(ctx, toolCallId, `read_image ${requestedPath} — ${error?.code ?? "error"}`, true, [], startedAt);
        return { content: [{ type: "text", text: message }], details: { ok: false } };
      }
    },
  } as AgentTool;
}

function enrichToolActivity(
  ctx: ToolContext,
  toolCallId: string,
  summary: string,
  isError: boolean,
  filesTouched: string[],
  startedAt: number,
): void {
  const turn = ctx.getActiveTurn?.();
  if (!turn) return;
  const entry = turn.tool_activity.find(activity => activity.call_id === toolCallId);
  if (!entry) return;
  entry.summary = summary;
  entry.is_error = isError;
  entry.files_touched = filesTouched;
  entry.duration_ms = Date.now() - startedAt;
}
