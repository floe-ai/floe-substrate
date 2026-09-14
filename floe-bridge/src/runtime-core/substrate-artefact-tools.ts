/**
 * Runtime-neutral artefact-content tool (read_artefact).
 *
 * Reads one exact immutable ArtefactVersion into the actor's model context:
 * images enter directly for visual inspection, text returns a bounded, resumable
 * page keyed by UTF-16 offset. This is a pure (bus, turn, params) → result body
 * carrying no MCP types.
 *
 * Unlike pulses, artefact content IS operation-authority gated: the Bus content
 * route requires the ephemeral per-Delivery bearer, so this uses
 * requireOperationAuthority. INSPECT_ARTEFACT returns metadata only — this tool
 * is the only path to the exact saved bytes.
 */
import { createHash } from "node:crypto";
import type { BusClient } from "../bus-client.js";
import { requireOperationAuthority, type OperationAuthorityTurn } from "./substrate-authority.js";

/** A content block returned to the model: text, or an inline image. */
export type ArtefactContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ArtefactToolResult = {
  content: ArtefactContentBlock[];
  details: Record<string, unknown>;
};

/** The active-turn subset read_artefact needs: workspace plus operation authority. */
export type ArtefactTurn = OperationAuthorityTurn & { workspace_id: string };

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_TEXT_UNITS = 16_000;

function failure(message: string, versionId: string): ArtefactToolResult {
  return {
    content: [{ type: "text", text: `Could not read shared content: ${message}` }],
    details: { ok: false, error: "artefact_content_read_failed", artefact_version_id: versionId },
  };
}

/**
 * Read one exact ArtefactVersion under the active Delivery's authority. Images
 * are returned inline; text is paged with next_offset so the actor can read the
 * remainder without rereading a mutable workspace file.
 */
export async function executeReadArtefact(bus: BusClient, turn: ArtefactTurn, params: any): Promise<ArtefactToolResult> {
  const versionId = typeof params?.artefact_version_id === "string" ? params.artefact_version_id.trim() : "";
  try {
    if (!versionId) throw new Error("An exact artefact_version_id is required.");
    const offset = params?.offset ?? 0;
    const limit = params?.limit ?? MAX_TEXT_UNITS;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TEXT_UNITS) {
      throw new Error(`Text offset must be a nonnegative integer and limit must be between 1 and ${MAX_TEXT_UNITS}.`);
    }
    const authority = await requireOperationAuthority(bus, turn);
    const { bytes, media_type } = await bus.readArtefactVersionContent(turn.workspace_id, versionId, authority.bearer_token);
    const details = { artefact_version_id: versionId, media_type, bytes: bytes.byteLength };

    if (IMAGE_TYPES.has(media_type)) {
      if (offset !== 0 || params?.limit !== undefined) {
        throw new Error("Text paging does not apply to images. Omit offset and limit to inspect the image.");
      }
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
      const splitsCharacter = (at: number) =>
        at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]!) && /[\uDC00-\uDFFF]/.test(text[at]!);
      if (splitsCharacter(offset)) throw new Error("Text offset splits a Unicode character. Use the preceding page's next_offset.");
      let end = Math.min(text.length, offset + limit);
      if (splitsCharacter(end)) end = end - 1 === offset ? end + 1 : end - 1;
      const nextOffset = end < text.length ? end : null;
      let firstLine = 1;
      for (let at = text.indexOf("\n"); at >= 0 && at < offset; at = text.indexOf("\n", at + 1)) firstLine++;
      const page = { offset, returned_units: end - offset, total_units: text.length, first_line: firstLine, next_offset: nextOffset };
      const digest = { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") };
      return {
        content: [
          {
            type: "text",
            text: `Exact saved text: ${JSON.stringify({ ...details, digest, ...page })}${nextOffset === null ? "\nEnd of saved text." : `\nContinue this version with offset: ${nextOffset}.`}`,
          },
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
    return failure(error instanceof Error ? error.message : String(error), versionId);
  }
}
