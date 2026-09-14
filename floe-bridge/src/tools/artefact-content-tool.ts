import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { BusClient } from "../bus-client.js";
import { requireOperationAuthority } from "./capability-tools.js";
import type { ToolContext } from "./types.js";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Present exact shared content without exposing credentials or storage paths. */
export function createArtefactContentTool(
  bus: BusClient,
  workspaceId: string,
  context: Pick<ToolContext, "getActiveTurn">,
): AgentTool {
  return {
    name: "read_artefact",
    label: "Read Shared Content",
    description: "Read one exact ArtefactVersion shared into your work. Images enter your model context for visual inspection. Text returns a bounded page; use next_offset to read the remainder without rereading a mutable workspace file. Uses your active Delivery authority and verifies the saved content, up to 20MB.",
    parameters: Type.Object({
      artefact_version_id: Type.String({ description: "Exact immutable ArtefactVersion identity" }),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Text offset (UTF-16 units), starting at 0. Use the previous page's next_offset to continue." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_000, description: "Maximum text units to return (default 16,000). Use a smaller value for a focused inspection." })),
    }),
    execute: async (_toolCallId, params: any) => {
      const versionId = String(params?.artefact_version_id ?? "").trim();
      try {
        if (!versionId) throw new Error("An exact artefact_version_id is required.");
        const offset = params?.offset ?? 0, limit = params?.limit ?? 16_000;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16_000) {
          throw new Error("Text offset must be a nonnegative integer and limit must be between 1 and 16,000.");
        }
        const authority = await requireOperationAuthority(bus, context);
        const { bytes, media_type } = await bus.readArtefactVersionContent(workspaceId, versionId, authority.bearer_token);
        const details = { artefact_version_id: versionId, media_type, bytes: bytes.byteLength };
        if (IMAGE_TYPES.has(media_type)) {
          if (offset !== 0 || params?.limit !== undefined) throw new Error("Text paging does not apply to images. Omit offset and limit to inspect the image.");
          return {
            content: [
              { type: "text", text: `Image from exact ArtefactVersion ${versionId}` },
              { type: "image", data: bytes.toString("base64"), mimeType: media_type },
            ],
            details: { ok: true, ...details },
          };
        }
        if (media_type.startsWith("text/") || /(?:json|xml|yaml)$/.test(media_type)) {
          const text = bytes.toString("utf8");
          if (offset > text.length) throw new Error(`Text offset exceeds the saved text length (${text.length}).`);
          const splitsCharacter = (at: number) => at > 0 && at < text.length
            && /[\uD800-\uDBFF]/.test(text[at - 1]!) && /[\uDC00-\uDFFF]/.test(text[at]!);
          if (splitsCharacter(offset)) throw new Error("Text offset splits a Unicode character. Use the preceding page's next_offset.");
          let end = Math.min(text.length, offset + limit);
          if (splitsCharacter(end)) end = end - 1 === offset ? end + 1 : end - 1;
          const nextOffset = end < text.length ? end : null;
          let firstLine = 1;
          for (let at = text.indexOf("\n"); at >= 0 && at < offset; at = text.indexOf("\n", at + 1)) firstLine++;
          const page = { offset, returned_units: end - offset, total_units: text.length,
            first_line: firstLine, next_offset: nextOffset };
          const digest = { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") };
          return {
            content: [
              { type: "text", text: `Exact saved text: ${JSON.stringify({ ...details, digest, ...page })}${nextOffset === null ? "\nEnd of saved text." : `\nContinue this version with offset: ${nextOffset}.`}` },
              { type: "text", text: text.slice(offset, end) },
            ],
            details: { ok: true, ...details, digest, ...page, truncated: nextOffset !== null },
          };
        }
        return {
          content: [{ type: "text", text: `Cannot present ${media_type} directly to the model. Discover a capability that can inspect this exact ArtefactVersion: ${versionId}.` }],
          details: { ok: false, error: "unsupported_model_content", ...details },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Could not read shared content: ${error instanceof Error ? error.message : String(error)}` }],
          details: { ok: false, error: "artefact_content_read_failed", artefact_version_id: versionId },
        };
      }
    },
  } as AgentTool;
}
